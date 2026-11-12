/**
 * stickers.js —— 收藏别人发的表情包。
 *
 * 网关把每轮转进会话的图片（字节 + 是不是表情）记在这里；模型在回复里写一行 [收藏表情:名字]，
 * 就把这轮（或最近 10 分钟内）对方发的那张表情存到工作区 _stickers/名字.扩展名，以后能用 ![名字](_stickers/…) 发。
 * 同一张图（sha1）只存一次；每天最多存 perDay 张；_stickers 里最多 300 张。
 * _stickers 目录里的文件本身就是本体：主人自己放进去的图也在面板清单里（不写 kv），能改名、能删。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { getKv, setKv } from './db.js';
import { blobToF32, normalizeToBlob } from './retrieval.js';

/**
 * `[收藏表情:得意猫|得意,猫]` —— 竖线后面是标签（可选，逗号 / 顿号分隔）。
 * 只写名字（`[收藏表情:得意猫]`）也照旧能用，标签留空。
 */
export const COLLECT_RE = /\[(?:收藏表情|存表情)\s*[:：]\s*([^\]\n|｜]{1,30})(?:[|｜]([^\]\n]{1,60}))?\]/g;
/** 标签个数 / 每个标签的字数上限。 */
const TAG_MAX = 6;
const TAG_LEN = 8;
/** 没标签的老记录共用这一个空数组（不每个都 new 一个）。 */
const EMPTY_TAGS = Object.freeze([]);
const RECENT_MS = 10 * 60_000;
const DIR_CAP = 300;
/** 一次 embedding 发多少条（跟检索那边批量写库一个量级）。 */
const EMBED_CHUNK = 32;
/** 一次补向量最多花多久：出站是等回复的地方，不能让 embedding 拖住她（补不完下一轮再补）。 */
const EMBED_BUDGET_MS = 8_000;
const EXT = { 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** 同一个工作区？路径写法可能不一样（相对 / 绝对），比绝对路径。 */
const sameWs = (a, b) => {
	const x = String(a ?? ''); const y = String(b ?? '');
	if (x === '' || y === '') return false;
	try { return resolve(x) === resolve(y); } catch { return x === y; }
};

/**
 * OneBot 的 summary 里哪些是废话。
 * 实测 5 张收藏里 3 张是 `[动画表情]`——这种当标签等于没标签，还占位。
 */
const SUMMARY_NOISE = new Set(['动画表情', '表情', '图片', '表情图', '其他', '未知', 'mface', 'face', 'image']);

/**
 * 从 OneBot 的 summary 里捡标签：`[可以可以]` → `['可以可以']`，`[动画表情]` → `[]`。
 * 白捡的，不用额外调模型。捡不到就返回空数组，调用方自己决定要不要退。
 */
export function tagsFromSummary(summary) {
	const raw = String(summary ?? '').trim().replace(/^[\[［]|[\]］]$/g, '').trim();
	if (raw === '' || SUMMARY_NOISE.has(raw.toLowerCase())) return [];
	// 一句话的 summary（`[柴犬笑]`）当标签；太长或带标点的不要（那是描述不是标签）
	if ([...raw].length > TAG_LEN || /[，。！？!?,.\s]/.test(raw)) return [];
	return [raw];
}

/**
 * 看图打标时模型说的「我看不清」——那是失败，不是标签。
 *
 * 只认**说看不见图**的那几句，不认情绪词：「不知道」「不确定」「抱歉」「无奈」都是表情包
 * 正经的感觉（尴尬 / 摊手 / 道歉那几张），把它们当失败会让这些表情永远打不上标。
 */
const VISION_FAIL = /看不清|看不到|看不见|无法(?:查看|看到|识别|看清)|没有(?:看到)?图|不是一张图/;
/** 模型爱加的「标签：」这种前缀词，不是标签。 */
const VISION_NOISE = new Set(['标签', '关键词', 'tags', 'tag']);
/** 送给模型的提问：要短词，别要句子。 */
const VISION_TAG_PROMPT = '这是一张表情包图片。用 2~4 个不超过 4 个字的短词描述它（情绪或画面，比如「得意」「柴犬」「睡觉」）。只输出这些词，用「、」分隔，不要前缀、标点和别的字。看不清就只输出：看不清';
/** 超过这个大小就不送模型看了：base64 还要再胀三分之一，超出任何模型吃得下的范围。 */
const VISION_MAX_BYTES = 4 * 1024 * 1024;
/** 标签几个字封顶：跟提示词里说的一样（短词）。长句、模型编出来的整段描述都不该进池子。 */
const VISION_TAG_LEN = 4;

/**
 * 看图打标的结果 → 干净的标签数组。
 * 噪声规则复用 tagsFromSummary：短词留，废话和长句丢；模型说「看不清」这类当失败。
 * @param {string} text 模型回的话
 * @returns {string[]}
 */
export function tagsFromVision(text) {
	const raw = String(text ?? '').trim();
	if (raw === '' || VISION_FAIL.test(raw)) return [];
	const out = [];
	for (const one of raw.split(/[,，、;；:：\s]+/)) {
		const t = one.trim();
		if (t === '' || VISION_NOISE.has(t.toLowerCase())) continue;
		const tag = tagsFromSummary(t)[0] ?? '';
		if (tag === '' || [...tag].length > VISION_TAG_LEN) continue;
		if (!out.includes(tag)) out.push(tag);
		if (out.length >= TAG_MAX) break;
	}
	return out;
}

/**
 * 拿表情的「感觉」去和库里每张比，返回最像的几张（按相似度降序）。
 *
 * 为什么要 top-N 而不是 top-1：实测同一感觉下「小兔ok」和「兔子OK」两张都对，
 * 精确取第一张会让每次都是同一张。V1 实测 top3 命中 6/6，所以候选池 5 张够。
 *
 * @param {{vec: Float32Array, pool: Array<{file: string, vec: Float32Array}>}} p
 * @returns {Array<{file: string, sim: number}>}
 */
export function rankByFeel({ vec, pool, top = 5 }) {
	const sims = [];
	for (const one of pool) {
		if (!one.vec || one.vec.length !== vec.length) continue;
		let s = 0;
		for (let i = 0; i < vec.length; i++) s += vec[i] * one.vec[i];
		sims.push({ file: one.file, sim: s });
	}
	sims.sort((a, b) => b.sim - a.sim);
	return sims.slice(0, Math.max(1, top));
}

/**
 * 回复里的「按感觉挑」写法：`![想表达的感觉](_stickers/@感觉)`。
 * 取出来换成真文件名。没写 `@` 的（正常 `_stickers/兔子OK.gif`）原样不动。
 * @returns {{text: string, feels: Array<{whole: string, feel: string}>}}
 */
export function parseFeelRefs(text) {
	const feels = [];
	const out = String(text ?? '').replace(
		/!\[([^\]\n]*)\]\(\s*_stickers[\\/]@([^)\s]+)\s*\)/g,
		(whole, _alt, feel) => { feels.push({ whole, feel: String(feel).trim() }); return whole; }
	);
	return { text: out, feels };
}

/** 标签串 → 干净的标签数组（去重、限个数和字数）。 */
export function stickerTags(raw) {
	const out = [];
	for (const one of String(raw ?? '').split(/[,，、;；\s]+/)) {
		const t = one.trim().slice(0, TAG_LEN);
		if (t !== '' && !out.includes(t)) out.push(t);
		if (out.length >= TAG_MAX) break;
	}
	return out;
}

/**
 * 回复里的 [收藏表情:名字|标签] 抠出来（发出去的文字里去掉）。
 * @returns {{text: string, items: Array<{name: string, tags: string[]}>, names: string[]}}
 */
export function parseCollect(text) {
	const items = [];
	const out = String(text ?? '').replace(COLLECT_RE, (_m, name, tags) => {
		const n = String(name ?? '').trim();
		if (n !== '') items.push({ name: n, tags: stickerTags(tags) });
		return '';
	})
		.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
	// names 是老接口（调用方按名字取），保留避免改动扩散
	return { text: out, items, names: items.map((x) => x.name) };
}

/** 文件名用的名字：去掉路径符号和空白，≤20 字。 */
export function stickerName(raw) {
	const s = [...String(raw ?? '').trim().replace(/\.(png|jpe?g|gif|webp)$/i, '').replace(/[\\/:*?"<>|\s.\u0000-\u001f]+/g, '').replace(/^_+/, '')].slice(0, 20).join('');
	return s;
}

/** 汉字（含日文假名）：名字里有这些 → 是人起的，不动。 */
const CJK_RE = /[㐀-鿿぀-ヿ]/;
/** 常见的「机器默认名」（整个名字就是这个）。 */
const GENERIC_NAMES = new Set([
	'image', 'photo', 'screenshot', 'untitled', 'unknown', 'default', 'temp', 'tmp', 'file', 'copy', 'download',
	'图片', '照片', '截图', '截屏', '未命名', '微信图片', '微信截图', '新建图片'
]);
/** 常见的自动名前缀（相机 / 截屏 / 微信 / 导出工具）。 */
const AUTO_PREFIX_RE = /^(img|image|dsc|pxl|screenshot|wx_?camera|mmexport|wechat|微信图片|微信截图|新建图片|未命名|截图|截屏|照片|图片)/i;
/** 日期：2023-11-01 / 2023年11月1日。 */
const DATE_RE = /\d{4}[-年/.]\d{1,2}[-月/.]\d{1,2}/;
/** 常见词（≥4 字母）：名字里有这些 → 是人起的，别动。 */
const COMMON_WORDS = [
	'good', 'morning', 'night', 'happy', 'birthday', 'sleep', 'sleepy', 'cute', 'nice', 'cool', 'love', 'hate',
	'smile', 'laugh', 'sorry', 'thank', 'star', 'moon', 'rain', 'snow', 'cake', 'bird', 'baby', 'girl', 'boy',
	'king', 'hero', 'fish', 'food', 'game', 'home', 'tree', 'ball', 'work', 'play', 'book', 'door', 'road', 'fire',
	'face', 'hand', 'hair', 'head', 'foot', 'jump', 'kiss', 'pray', 'wave', 'clap', 'dance', 'party', 'angel',
	'magic', 'super', 'power', 'hello', 'kitty', 'panda', 'bear', 'wolf', 'crazy', 'funny', 'mood', 'milk', 'candy',
	'sweet', 'spicy', 'warm', 'sunny', 'cloudy', 'money', 'music', 'song', 'flower', 'grass', 'house', 'tired',
	'proud', 'shock', 'doubt', 'great', 'best', 'meow', 'woof'
];
/** 短词（3 字母）：整词匹配才算（`cat_2023` 里的 `cat`）。 */
const SHORT_WORDS = new Set([
	'cat', 'dog', 'sad', 'bad', 'ok', 'hi', 'mom', 'dad', 'lol', 'oops', 'fox', 'cow', 'bee', 'pig',
	'sun', 'ice', 'red', 'cry', 'run', 'fun', 'wow', 'yes', 'my', 'me'
]);

/**
 * 名字里有常见词 → 是人起的（`goodmorning` 里含 `good`，`cat_2023` 里整词是 `cat`）。
 */
function hasCommonWord(name) {
	const lower = name.toLowerCase();
	for (const w of COMMON_WORDS) if (lower.includes(w)) return true;
	return lower.split(/[^a-z0-9]+/).filter(Boolean).some((t) => SHORT_WORDS.has(t));
}

/**
 * 名字是「机器起的」吗（哈希 / 相机默认名 / 时间戳 / 一串没意义的字母数字）？
 *
 * 这类名字不带任何信息，面板上根本认不出哪张是哪张；看图打标已经知道这张图是什么了，
 * 顺手换成第一个标签当名字。**主人自己起的名字一个字都不动**（有汉字 / 常见词 / 短名 → 不算）。
 *
 * @param {string} raw 文件名（带不带扩展名都行）
 * @returns {boolean}
 */
export function isAutoName(raw) {
	const name = stickerName(raw);
	if (name === '') return false;
	if (GENERIC_NAMES.has(name.toLowerCase())) return true;
	if (AUTO_PREFIX_RE.test(name)) return true;
	// 哈希：纯十六进制。带数字的一律算；纯字母的（`deadbeef`）要够长（8+），
	// 免得 `decade`、`facade` 这种碰巧是十六进制的词被当成哈希
	if (/^[0-9a-f]{6,}$/i.test(name) && (/\d/.test(name) || name.length >= 8)) return true;
	// 纯数字 / 序号 / 时间戳：`20231101`、`20231101_120000`、`1699999999999`
	if (/^[\d\-_:]+$/.test(name) && (name.match(/\d/g)?.length ?? 0) >= 5) return true;
	if (DATE_RE.test(name)) return true;
	// 长（>8）又没有汉字、也没有常见词 → 一串没意义的字母数字
	if ([...name].length > 8 && !CJK_RE.test(name) && !hasCommonWord(name)) return true;
	return false;
}

export function stickerConfig(raw) {
	const v = raw ?? {};
	const n = Number(v.perDay);
	const listed = Number(v.biliPanelListed);
	return {
		collect: v.collect !== false,
		perDay: Number.isFinite(n) ? Math.min(100, Math.max(0, Math.floor(n))) : 10,
		// B站 私信平台表情面板（默认关）
		biliPanel: v.biliPanel === true,
		biliPanelListed: Number.isFinite(listed) ? Math.min(60, Math.max(0, Math.floor(listed))) : 30
	};
}

export class StickerBox {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => ReturnType<typeof stickerConfig>} deps.getConfig
	 */
	constructor({ db, getConfig, log }) {
		Object.assign(this, { db, getConfig });
		this.log = log ?? (() => {});
		this.recent = new Map(); // sessionId → [{ bytes, mediaType, sticker, summary, from, at }]
	}

	/** 网关：这轮转进会话的一张图。 */
	remember(sessionId, img) {
		if (!img?.bytes || !EXT[img.mediaType]) return;
		const list = (this.recent.get(sessionId) ?? []).filter((x) => Date.now() - x.at < RECENT_MS);
		list.push({ ...img, at: Date.now() });
		this.recent.set(sessionId, list.slice(-4));
		if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value);
	}

	collected() {
		return getKv(this.db, 'stickers.collected', []) ?? [];
	}

	/**
	 * 把一批表情的「标签串」嵌成向量存起来（向量塞 kv，实测 300 条 1.62MB / 读 4ms）。
	 * 失败就当没有——出站时按文件名降级，不影响别的。
	 *
	 * 幂等：只处理「还没向量」或「向量是别的模型打的」那些条目，没有待办就不发请求。
	 * `model` 不给就从 embedder 自己读当前模型（向量本来就是它出的，写错 id 会让整库白重打）。
	 *
	 * @param {string} workspacePath
	 * @param {{embed: Function, getConfig?: Function}} embedder
	 * @param {{model?: string}} [opts]
	 * @returns {Promise<number>} 成功打上向量的条数
	 */
	async embedStickers(workspacePath, embedder, { model = '' } = {}) {
		if (!embedder) return 0;
		const cfg = embedder.getConfig?.() ?? {};
		const mid = String(model || cfg.model || '');
		const all = this.collected();
		const todo = all.filter((x) => sameWs(x.workspacePath, workspacePath) &&
			(x.tags ?? []).length > 0 && (!x.vec || (mid !== '' && x.vecModel !== mid)));
		if (todo.length === 0) return 0;
		let n = 0;
		// 一批一次发太多会超时（查询超时只有 800ms，批量要按写库的 10s 算），分块发、失败不拖垮整批
		const started = Date.now();
		for (let i = 0; i < todo.length; i += EMBED_CHUNK) {
			// 出站是等回复的地方：补向量最多花 EMBED_BUDGET_MS，补不完的下一轮再补（幂等，不丢进度）。
			const left = EMBED_BUDGET_MS - (Date.now() - started);
			if (left <= 500) break;
			const chunk = todo.slice(i, i + EMBED_CHUNK);
			let r = null;
			try {
				r = await embedder.embed(chunk.map((x) => x.tags.join('、')), { timeoutMs: Math.min(cfg.writeTimeoutMs ?? 10_000, left) });
			} catch { r = null; }
			if (!r) continue;
			for (const [j, one] of chunk.entries()) {
				const v = r.vectors?.[j];
				if (!v) continue;
				one.vec = normalizeToBlob(v).toString('base64');
				one.vecModel = mid;
				n++;
			}
		}
		if (n > 0) setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
		return n;
	}

	/**
	 * 回复正文里的 `![感觉](_stickers/@感觉)` 换成真文件名。
	 * 认不出来的整段去掉（别让 `@xxx` 原样漏到她的话里）。
	 * @returns {Promise<{text: string, resolved: Array<{feel: string, file: string|null}>}>}
	 */
	async resolveFeelRefs(text, workspacePath, embedder, { model = '' } = {}) {
		const parsed = parseFeelRefs(text);
		if (parsed.feels.length === 0) return { text: parsed.text, resolved: [] };
		let out = parsed.text;
		const resolved = [];
		for (const one of parsed.feels.slice(0, 2)) {
			const r = await this.pickByFeel(workspacePath, one.feel, embedder, { model, top: 5 });
			resolved.push({ feel: one.feel, file: r.ok ? r.file : null });
			out = out.split(one.whole).join(r.ok ? `![${one.feel}](_stickers/${r.file})` : '');
		}
		return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), resolved };
	}

	/**
	 * 她说「想发个什么感觉的」→ 找出最像的那张。
	 * @returns {Promise<{ok: boolean, file?: string, reason?: string, candidates?: string[]}>}
	 */
	async pickByFeel(workspacePath, feel, embedder, { model = '', avoid = [], top = 5 } = {}) {
		const want = String(feel ?? '').trim();
		if (want === '') return { ok: false, reason: '没说要什么感觉' };
		if (!embedder) return { ok: false, reason: '没配嵌入模型' };
		// 池子里的向量得先有：贴着标签但还没打过向量的，先补上（幂等，没待办就不发请求）。
		// 不补的话这池子永远是空的 —— 「按感觉挑」对所有表情都是死路。
		await this.embedStickers(workspacePath, embedder, { model });
		const pool = this.collected()
			.filter((x) => sameWs(x.workspacePath, workspacePath) && typeof x.vec === 'string' && x.vec !== '')
			.map((x) => ({ file: x.file, vec: blobToF32(Buffer.from(x.vec, 'base64')) }));
		if (pool.length === 0) return { ok: false, reason: '还没有表情打过标签' };
		const r = await embedder.embed([want]);
		if (!r) return { ok: false, reason: '算相似度失败' };
		const q = new Float32Array(normalizeToBlob(r.vectors[0]).buffer.slice(0));
		const ranked = rankByFeel({ vec: q, pool, top: Math.max(top, 1) });
		const fresh = ranked.filter((x) => !avoid.includes(x.file));
		const pick = (fresh.length > 0 ? fresh : ranked)[0];
		if (!pick) return { ok: false, reason: '没找到像的' };
		return { ok: true, file: pick.file, candidates: ranked.map((x) => x.file) };
	}

	/**
	 * 面板清单：收藏记录（含文件已经没了的）+ 当前工作区里主人自己放进 _stickers 的图。
	 * 目录里的图不写 kv、不定时扫，面板打开时现算。
	 * @returns {{file: string, workspacePath: string, from: string, summary: string, tags: string[], at: number, exists: boolean, tracked: boolean}[]}
	 */
	list(workspacePath) {
		const ws = String(workspacePath ?? '').trim();
		const rows = this.collected();
		const items = rows.map((x) => ({
			file: x.file, workspacePath: x.workspacePath, from: x.from ?? '', summary: x.summary ?? '',
			tags: Array.isArray(x.tags) ? x.tags : EMPTY_TAGS, at: x.at ?? 0,
			exists: existsSync(join(x.workspacePath, '_stickers', x.file)), tracked: true
		}));
		if (ws === '') return items;
		const known = new Set(rows.filter((x) => sameWs(x.workspacePath, ws)).map((x) => x.file));
		let names = [];
		try { names = readdirSync(join(ws, '_stickers')); } catch { return items; }
		for (const name of names) {
			if (known.has(name) || !IMAGE_EXT.has(extname(name).slice(1).toLowerCase())) continue;
			let at = 0;
			try { at = statSync(join(ws, '_stickers', name)).mtimeMs; } catch { /* 读不到就当没有 */ }
			items.push({ file: name, workspacePath: ws, from: '主人放的', summary: '', tags: EMPTY_TAGS, at, exists: true, tracked: false });
		}
		return items;
	}

	/**
	 * 改名字：文件真的在 _stickers 里才改；撞名直接拒绝（不自动加序号）；收藏记录里的文件名跟着改，主人自己放的不写 kv。
	 * @returns {{ok: boolean, file?: string, reason?: string}}
	 */
	rename(file, newName, workspacePath) {
		const ws = String(workspacePath ?? '');
		const old = basename(String(file ?? ''));
		if (old === '') return { ok: false, reason: '没有这张' };
		const all = this.collected();
		const hit = all.find((x) => x.file === old && sameWs(x.workspacePath, ws));
		const dir = join(hit?.workspacePath ?? ws, '_stickers');
		const from = join(dir, old);
		if (!existsSync(from)) return { ok: false, reason: '没有这张' };
		const ext = extname(old).slice(1).toLowerCase();
		if (!IMAGE_EXT.has(ext)) return { ok: false, reason: '只支持图片文件' };
		const base = stickerName(basename(String(newName ?? '')));
		if (base === '') return { ok: false, reason: '名字不能用' };
		const target = `${base}.${ext}`;
		if (target === old) return { ok: true, file: old };
		if (existsSync(join(dir, target))) return { ok: false, reason: '已经有同名了' };
		try { renameSync(from, join(dir, target)); } catch { return { ok: false, reason: '改名失败' }; }
		if (hit) {
			hit.file = target;
			setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
		}
		return { ok: true, file: target };
	}

	/**
	 * 看图打上标之后，给「机器起的名字」换一个有意义的名字。
	 *
	 * 导入存的是用户原始文件名（`95BC0E6AC`、`IMG_20231101`），不带任何信息，面板上根本认不出
	 * 哪张是哪张；看图打标已经知道这张图是什么了，就用第一个标签当新名字。
	 * **主人自己起的名字一个字都不动**（`得意猫` 不改）。
	 *
	 * 撞名加数字后缀（`得意` → `得意2`），不覆盖别的那张；kv 里的 `file` 跟着改，引用才不断。
	 * 没标签 / 判断不了 / 改名失败 → 静默返回 `{ ok: false, reason }`，原名照旧。
	 *
	 * @param {string} file 现在叫什么
	 * @param {string[]} tags 看图打上的标签（取第一个当名字）
	 * @param {string} workspacePath
	 * @returns {{ok: boolean, file?: string, reason?: string}}
	 */
	autoRename(file, tags, workspacePath) {
		const ws = String(workspacePath ?? '');
		const old = basename(String(file ?? ''));
		if (old === '') return { ok: false, reason: '没有这张' };
		const list = Array.isArray(tags) ? tags : [];
		if (list.length === 0) return { ok: false, reason: '没有标签' };
		const ext = extname(old).slice(1).toLowerCase();
		if (!IMAGE_EXT.has(ext)) return { ok: false, reason: '只支持图片文件' };
		const all = this.collected();
		const hit = all.find((x) => x.file === old && sameWs(x.workspacePath, ws));
		const dir = join(hit?.workspacePath ?? ws, '_stickers');
		const from = join(dir, old);
		if (!existsSync(from)) return { ok: false, reason: '没有这张' };
		const cur = basename(old, `.${ext}`);
		if (!isAutoName(cur)) return { ok: false, reason: '名字是自己起的' };
		const base = stickerName(list[0]);
		if (base === '') return { ok: false, reason: '名字不能用' };
		if (base === cur) return { ok: false, reason: '名字没变' };
		// 撞名就加数字后缀，别覆盖别的那张
		let target = `${base}.${ext}`;
		for (let i = 2; existsSync(join(dir, target)); i++) target = `${base}${i}.${ext}`;
		try { renameSync(from, join(dir, target)); } catch { return { ok: false, reason: '改名失败' }; }
		if (hit) {
			hit.file = target;
			setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
		}
		return { ok: true, file: target };
	}

	/**
	 * 面板手动补 / 改标签：老表情（收藏时模型没给标签、早期导入的）没标签就永远进不了
	 * 「按感觉挑」的池子，主人能在卡片上自己补。
	 *
	 * 写回 kv 的 `tags` / `tagsBy: 'manual'`；**标签真变了就把向量作废**（`vec` / `vecModel` 清掉），
	 * 下次 `pickByFeel` 里 `embedStickers` 会按新标签懒补 —— 拿旧标签的向量去比只会挑错。
	 * 标签没变则一个字节都不动（不白扔向量）。
	 *
	 * 主人自己放进 `_stickers` 的图本来没有 kv 记录，补标签时顺手补一条（否则它进不了池子）。
	 * 没有这张 / 不是图片 / 空参数 → 静默返回 `{ ok: false, reason }`，不抛。
	 *
	 * @param {string} file 文件名（给了 `hash` 时可以留空）
	 * @param {string|string[]|null} rawTags 标签串（`得意、猫`）/ 数组；空 = 清空标签
	 * @param {string} workspacePath
	 * @param {{hash?: string}} [opts] 按 sha1 定位（改名后文件名变了也能改标签）
	 * @returns {{ok: boolean, tags?: string[], file?: string, reason?: string}}
	 */
	setTags(file, rawTags, workspacePath, { hash = '' } = {}) {
		const ws = String(workspacePath ?? '');
		const name = basename(String(file ?? ''));
		const key = String(hash ?? '').trim();
		if (name === '' && key === '') return { ok: false, reason: '没有这张' };
		const all = this.collected();
		const hit = all.find((x) => (key !== '' ? x.hash === key : (x.file === name && sameWs(x.workspacePath, ws))));
		const target = hit?.file ?? name;
		if (target === '') return { ok: false, reason: '没有这张' };
		const dir = join(hit?.workspacePath ?? ws, '_stickers');
		const path = join(dir, target);
		if (!existsSync(path)) return { ok: false, reason: '没有这张' };
		if (!IMAGE_EXT.has(extname(target).slice(1).toLowerCase())) return { ok: false, reason: '只支持图片文件' };

		const tags = stickerTags(Array.isArray(rawTags) ? rawTags.join(',') : rawTags);
		if (!hit) {
			// 目录里的图、还没写 kv：没有标签就等于没改，不凭空造一条记录
			if (tags.length === 0) return { ok: true, tags, file: target };
			let bytes = null; let at = Date.now();
			try { bytes = readFileSync(path); at = statSync(path).mtimeMs; } catch { return { ok: false, reason: '读不了这张图' }; }
			all.unshift({
				file: target, hash: createHash('sha1').update(bytes).digest('hex'), workspacePath: ws,
				from: '主人放的', summary: '', tags, tagsBy: 'manual', at
			});
			setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
			return { ok: true, tags, file: target };
		}

		const before = (hit.tags ?? []).join(',');
		hit.tags = tags;
		hit.tagsBy = tags.length > 0 ? 'manual' : '';
		if (before !== tags.join(',')) {
			delete hit.vec;
			delete hit.vecModel;
		}
		setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
		return { ok: true, tags, file: target };
	}

	/**
	 * 存最近一张（优先表情）为 名字.扩展名。
	 * @returns {{ok: boolean, file?: string, reason?: string}}
	 */
	collect(sessionId, rawName, workspacePath, { from = '', tags = [] } = {}) {
		const cfg = this.getConfig();
		if (!cfg.collect) return { ok: false, reason: '收藏表情包关着' };
		const name = stickerName(rawName);
		if (name === '') return { ok: false, reason: '名字不能用' };
		const list = (this.recent.get(sessionId) ?? []).filter((x) => Date.now() - x.at < RECENT_MS);
		const img = [...list].reverse().find((x) => x.sticker) ?? list[list.length - 1];
		if (!img) return { ok: false, reason: '最近没有能存的表情' };
		const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
		const today = getKv(this.db, `stickers.day.${day}`, 0) ?? 0;
		if (today >= cfg.perDay) return { ok: false, reason: '今天存够了' };
		const hash = createHash('sha1').update(img.bytes).digest('hex');
		const all = this.collected();
		const dup = all.find((x) => x.hash === hash && x.workspacePath === workspacePath);
		if (dup && existsSync(join(workspacePath, '_stickers', dup.file))) return { ok: false, reason: `已经存过了（${dup.file}）`, file: dup.file };
		const dir = join(workspacePath, '_stickers');
		mkdirSync(dir, { recursive: true });
		if (readdirSync(dir).length >= DIR_CAP) return { ok: false, reason: '表情包太多了，先删几张' };
		let file = `${name}.${EXT[img.mediaType]}`;
		for (let i = 2; existsSync(join(dir, file)); i++) file = `${name}${i}.${EXT[img.mediaType]}`;
		writeFileSync(join(dir, file), img.bytes);
		setKv(this.db, `stickers.day.${day}`, today + 1);
		// 她自己没给标签就白捡 summary 的（`[可以可以]` → 标签；`[动画表情]` → 空）
		const clean = stickerTags(Array.isArray(tags) ? tags.join(',') : tags);
		const fromSummary = clean.length === 0 ? tagsFromSummary(img.summary) : [];
		const useTags = clean.length > 0 ? clean : fromSummary;
		all.unshift({
			file, hash, workspacePath, from: String(from).slice(0, 24), summary: String(img.summary ?? '').slice(0, 30),
			tags: useTags, tagsBy: useTags.length > 0 ? (clean.length > 0 ? 'self' : 'summary') : '', at: Date.now()
		});
		setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
		this.recent.set(sessionId, list.filter((x) => x !== img));
		return { ok: true, file, tags: useTags };
	}

	/**
	 * 导入一张现成的表情（麦麦的表情包库）：不占每天收藏的额度，同一张图（sha1）不重复存，_stickers 满了就停。
	 * @returns {{ok: boolean, file?: string, reason?: string, dup?: boolean}}
	 */
	importImage({ bytes, mediaType, name, workspacePath, from = '', summary = '', tags = [] }) {
		if (!bytes || !EXT[mediaType]) return { ok: false, reason: '不是支持的图片格式' };
		const base = stickerName(name) || 'sticker';
		const hash = createHash('sha1').update(bytes).digest('hex');
		const all = this.collected();
		const dup = all.find((x) => x.hash === hash && x.workspacePath === workspacePath);
		if (dup && existsSync(join(workspacePath, '_stickers', dup.file))) return { ok: false, dup: true, reason: `已经有了（${dup.file}）`, file: dup.file };
		const dir = join(workspacePath, '_stickers');
		mkdirSync(dir, { recursive: true });
		if (readdirSync(dir).length >= DIR_CAP) return { ok: false, full: true, reason: '表情包太多了，先删几张' };
		let file = `${base}.${EXT[mediaType]}`;
		for (let i = 2; existsSync(join(dir, file)); i++) file = `${base}${i}.${EXT[mediaType]}`;
		writeFileSync(join(dir, file), bytes);
		const clean = stickerTags(Array.isArray(tags) ? tags.join(',') : tags);
		const fromSummary = clean.length === 0 ? tagsFromSummary(summary) : [];
		const useTags = clean.length > 0 ? clean : fromSummary;
		all.unshift({
			file, hash, workspacePath, from: String(from).slice(0, 24), summary: String(summary).slice(0, 30),
			tags: useTags, tagsBy: useTags.length > 0 ? (clean.length > 0 ? 'self' : 'summary') : '', at: Date.now()
		});
		setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
		return { ok: true, file, tags: useTags };
	}

	/**
	 * 看图打标签：导入的图没有标签，就永远进不了「按感觉挑」的池子（那边只认有标签的）。
	 *
	 * 让宿主模型看一次图回几个短词。**识图是宿主模型的能力**：插件只保证把图送到它面前，
	 * 它看不见 / 调用失败 / 回得不像标签 → 当没标签（静默降级），绝不报错、绝不瞎填。
	 *
	 * @param {{file: string, bytes: Buffer, mediaType?: string, workspacePath: string}} o
	 * @param {(prompt: string, images: Array<{data: string, mediaType: string, name: string}>) => Promise<string|null>} [vision]
	 * @returns {Promise<string[]>} 打上的标签（没打上就是空数组）
	 */
	async tagByVision(o, vision) {
		if (typeof vision !== 'function' || !o?.bytes) return [];
		if (o.bytes.length > VISION_MAX_BYTES) return [];
		const all = this.collected();
		const hit = all.find((x) => x.file === o.file && sameWs(x.workspacePath, o.workspacePath));
		if (!hit) return [];
		if ((hit.tags ?? []).length > 0) return hit.tags; // 已经有标签了（模型自己标的 / summary 捡的），不覆盖
		let out = null;
		try {
			out = await vision(VISION_TAG_PROMPT, [{ data: o.bytes.toString('base64'), mediaType: o.mediaType ?? 'image/png', name: o.file }]);
		} catch { return []; }
		const tags = tagsFromVision(out);
		if (tags.length === 0) return [];
		hit.tags = tags;
		hit.tagsBy = 'vision';
		setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
		return tags;
	}

	/** 设置页删一张：收藏的和主人自己放的都能删；文件已经没了就把收藏记录也删掉。 */
	remove(file, workspacePath) {
		const ws = String(workspacePath ?? '');
		const name = basename(String(file ?? ''));
		if (name === '') return false;
		const all = this.collected();
		const hit = all.find((x) => x.file === name && sameWs(x.workspacePath, ws));
		const path = join(hit?.workspacePath ?? ws, '_stickers', name);
		if (!hit && !existsSync(path)) return false;
		try { unlinkSync(path); } catch { /* 已经没了 */ }
		if (hit) setKv(this.db, 'stickers.collected', all.filter((x) => x !== hit));
		return true;
	}
}
