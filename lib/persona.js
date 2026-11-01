/**
 * persona.js —— 角色卡加载（SillyTavern 迁移兼容层）。
 *
 *  - 来源：$DSH_HOME/fish-soul/persona.json 或 persona.png（PNG tEXt/iTXt 中的 ccv3 / chara base64）；
 *  - 字段：V3/V2/扁平三种结构，读 name / description / personality / scenario / system_prompt /
 *    mes_example / first_mes / post_history_instructions / character_book；
 *  - 宏：{{char}} / <BOT> → 角色名；{{user}} / <USER> 在静态段替换为"对方"，动态段替换为真实昵称；
 *  - 世界书：constant 条目进静态人格段；关键词条目按本轮消息命中后进瞬态块（不碰前缀缓存）。
 */
import { personaAnchor } from './soul-memory.js';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

/** 读取 PNG 里的文本块（tEXt / 未压缩或压缩的 iTXt）。 */
export function readPngTextChunks(buf) {
	const out = {};
	const SIG = '89504e470d0a1a0a';
	if (buf.subarray(0, 8).toString('hex') !== SIG) return out;
	let off = 8;
	while (off + 8 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.subarray(off + 4, off + 8).toString('latin1');
		const data = buf.subarray(off + 8, off + 8 + len);
		if (type === 'tEXt') {
			const z = data.indexOf(0);
			if (z > 0) out[data.subarray(0, z).toString('latin1')] = data.subarray(z + 1).toString('latin1');
		} else if (type === 'iTXt') {
			const z = data.indexOf(0);
			if (z > 0) {
				const key = data.subarray(0, z).toString('latin1');
				const compressed = data[z + 1] === 1;
				let p = z + 3;
				p = data.indexOf(0, p) + 1; // language tag
				p = data.indexOf(0, p) + 1; // translated keyword
				const body = data.subarray(p);
				out[key] = (compressed ? inflateSync(body) : body).toString('utf8');
			}
		} else if (type === 'IEND') break;
		off += 12 + len;
	}
	return out;
}

/** PNG 卡 → JSON（优先 V3 的 ccv3，其次 V2 的 chara）。 */
export function parsePngCard(buf) {
	const chunks = readPngTextChunks(buf);
	const raw = chunks.ccv3 ?? chunks.chara;
	if (raw === undefined) throw new Error('PNG 中没有 ccv3/chara 角色卡数据');
	return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

export function applyMacros(text, { charName, userName }) {
	return String(text ?? '')
		.replace(/\{\{char\}\}|<BOT>/gi, charName)
		.replace(/\{\{user\}\}|<USER>/gi, userName)
		.replace(/\{\{original\}\}/gi, '');
}

/**
 * @returns {{name:string, staticText:string, postHistory:string, lore:Array<{keys:string[], content:string}>, source:string}}
 */
export function loadPersona(dir, log = () => {}) {
	const fallback = {
		name: 'feiyu',
		staticText: '你是 feiyu（鱼）：一个有自己的作息、会记住每个说过话的人的 QQ 好友。',
		postHistory: '',
		lore: [],
		anchor: '',
		routine: '',
		perspective: [],
		moods: {},
		template: null,
		source: 'builtin'
	};
	let raw = null;
	let source = 'builtin';
	try {
		const pngPath = join(dir, 'persona.png');
		const jsonPath = join(dir, 'persona.json');
		if (existsSync(jsonPath)) { raw = JSON.parse(readFileSync(jsonPath, 'utf8')); source = 'persona.json'; }
		else if (existsSync(pngPath)) { raw = parsePngCard(readFileSync(pngPath)); source = 'persona.png'; }
	} catch (error) {
		log('error', `[fish-soul] 角色卡读取失败：${String(error instanceof Error ? error.message : error)}`);
	}
	if (raw === null) return fallback;

	const card = raw.data ?? raw;
	const name = String(card.name ?? card.char_name ?? 'feiyu');
	const m = (t) => applyMacros(t, { charName: name, userName: '对方' });
	const parts = [];
	if (card.system_prompt) parts.push(m(card.system_prompt));
	if (card.description ?? card.char_persona) parts.push(m(card.description ?? card.char_persona));
	if (card.personality) parts.push(`性格：${m(card.personality)}`);
	if (card.scenario ?? card.world_scenario) parts.push(`场景：${m(card.scenario ?? card.world_scenario)}`);
	const ex = Array.isArray(card.mes_example) ? card.mes_example.join('\n') : (card.mes_example ?? card.example_dialogue);
	if (ex) parts.push(`对话示例：\n${m(ex)}`);
	if (card.first_mes ?? card.char_greeting) parts.push(`开场白风格参考：${m(card.first_mes ?? card.char_greeting)}`);

	const lore = [];
	const entries = card.character_book?.entries ?? [];
	const list = Array.isArray(entries) ? entries : Object.values(entries);
	for (const e of list) {
		if (e?.enabled === false || e?.disable === true) continue;
		const content = m(e?.content ?? '');
		if (content.trim() === '') continue;
		if (e.constant === true) parts.push(`设定：${content}`);
		else {
			const keys = [...(e.keys ?? e.key ?? [])].map(String).filter(Boolean);
			const secondary = [...(e.secondary_keys ?? e.keysecondary ?? [])].map(String).filter(Boolean);
			// SillyTavern：selective 打开时次要关键词按 selectiveLogic 生效（0 任一 / 1 不全有 / 2 都没有 / 3 全有）
			const logic = Number(e.extensions?.selectiveLogic ?? e.selectiveLogic ?? 0);
			const order = Number(e.priority ?? e.insertion_order ?? e.order ?? 100);
			if (keys.length > 0) lore.push({ keys, secondary, selective: e.selective === true && secondary.length > 0, logic, order: Number.isFinite(order) ? order : 100, caseSensitive: e.case_sensitive === true || e.extensions?.case_sensitive === true, content });
		}
	}
	lore.sort((a, b) => b.order - a.order);
	const perspective = perspectiveOf(card.extensions?.fish_soul?.perspective);
	if (perspective.length > 0) parts.push(`看事情的方式（是你自己的；遇到相关的事才自然影响你怎么看、怎么选，几条之间可以有矛盾。不是聊天主题，别说教，也别每件事都套一遍）：\n${perspective.map((x) => `- ${m(x)}`).join('\n')}`);
	parts.push(LIVED);
	return {
		name,
		staticText: parts.length > 0 ? parts.join('\n\n') : `你是 ${name}。`,
		postHistory: card.post_history_instructions ? String(card.post_history_instructions) : '',
		lore,
		anchor: personaAnchor(card),
		routine: str(card.extensions?.fish_soul?.routine, 300),
		perspective,
		moods: Object.fromEntries(Object.entries(moodsOf(card.extensions?.fish_soul?.moods)).map(([k, v]) => [k, m(v)])),
		template: card.extensions?.fish_soul?.template ?? null,
		source
	};
}

/**
 * 怎么像个活人（借鉴 HDS-Interlude 的连续生活写作指导）：前文是经历不是模板；熟悉感来自共同经历；
 * 她有自己的事；接住哪一点由此刻决定，不排轮换表。每张卡都带，放静态段（不占每轮）。
 */
export const LIVED = '怎么像个活人：前面聊过的是发生过的事，不是下一句的模板——别照搬自己上文的句式、开头和收尾，说过的事可以有后续。' +
	'熟悉感来自你们一起经历过的事，不用每次证明自己的性格，也不用每次都回得漂亮。你有自己正在做的事和还没做完的事，不是等着被提问。' +
	'对方的话里哪一点让你在意就接哪一点：可以认真答，可以只接一半、拐到自己更在意的地方、反问一个词，或者先放着；长短也由这会儿想说多少决定，别把这些排成轮换表。' +
	'被冤枉、被冒犯，先有真实的反应（不爽、顶回去、冷一下），别急着讲道理、列理由自证；对方追问了再解释，可以带点情绪。' +
	'被问心里怎么想，一次只说一点，剩下的以后再说。你只知道对方说过的和你看到的，可以猜错、会错意。话说完了就停，不用每条结尾都递个问题，也别用「对了」硬找话；词穷、说不清楚也正常。';

/** 看事情的方式：字符串（按行拆）或数组 → 最多 5 条，每条 ≤120 字 */
export function perspectiveOf(v) {
	const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n+/) : [];
	return list.map((x) => str(x, 120).replace(/^[-•·\s]+/, '')).filter(Boolean).slice(0, 5);
}

/** 不同心情下她怎么说话（借鉴 Mirrai 的 imperfectionProfile：每个人不完美的样子随心情变）。 */
export const MOOD_KEYS = ['开心', '低落', '生气', '犯懒', '好久不见'];

/** { 开心: '…' } 或者「开心：…」一行一条 → 只留认得的几种心情，每条 ≤80 字 */
export function moodsOf(v) {
	const pairs = v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v)
		: typeof v === 'string' ? v.split(/\n+/).map((l) => l.match(/^\s*([^：:]{1,6})[：:]\s*(.+)$/)).filter(Boolean).map((x) => [x[1].trim(), x[2]]) : [];
	const out = {};
	for (const [k, t] of pairs) if (MOOD_KEYS.includes(k) && str(t, 80) !== '') out[k] = str(t, 80);
	return out;
}

const str = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

/** 现在磁盘上的卡（persona.json 优先，其次 persona.png）；读不到 = null。 */
export function readPersonaCard(dir) {
	try {
		const jsonPath = join(dir, 'persona.json');
		if (existsSync(jsonPath)) return { card: JSON.parse(readFileSync(jsonPath, 'utf8')), source: 'persona.json' };
		const pngPath = join(dir, 'persona.png');
		if (existsSync(pngPath)) return { card: parsePngCard(readFileSync(pngPath)), source: 'persona.png' };
	} catch { /* 读不到就当没有 */ }
	return null;
}

/**
 * 设置页传上来的卡 → 规整的 chara_card_v2（V2 / V3 / 扁平都收）。
 * 认识的字段做类型和长度清理，别的字段（alternate_greetings、别家扩展…）原样留着，导回 SillyTavern 不丢东西。
 */
export function normalizeCard(input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('人格卡格式不对');
	const src = input.data && typeof input.data === 'object' ? input.data : input;
	const name = str(src.name ?? src.char_name, 40);
	if (name === '') throw new Error('名字不能空着');
	const ext = src.extensions && typeof src.extensions === 'object' && !Array.isArray(src.extensions) ? src.extensions : {};
	const fish = ext.fish_soul && typeof ext.fish_soul === 'object' ? ext.fish_soul : {};
	const book = src.character_book && typeof src.character_book === 'object' ? src.character_book : {};
	const raw = Array.isArray(book.entries) ? book.entries : Object.values(book.entries ?? {});
	const entries = raw.filter((e) => e && typeof e === 'object').slice(0, 200).map((e, i) => {
		const keys = [...(Array.isArray(e.keys) ? e.keys : Array.isArray(e.key) ? e.key : [])].map((k) => str(k, 40)).filter(Boolean).slice(0, 20);
		return { ...e, keys, content: str(e.content, 2000), constant: e.constant === true || keys.length === 0, enabled: e.enabled !== false && e.disable !== true, id: e.id ?? i + 1 };
	}).filter((e) => e.content !== '');
	const mesExample = Array.isArray(src.mes_example) ? src.mes_example.join('\n') : (src.mes_example ?? src.example_dialogue);
	const anchor = str(fish.anchor, 80);
	const routine = str(fish.routine, 300);
	const perspective = perspectiveOf(fish.perspective);
	const moods = moodsOf(fish.moods);
	const fishOut = { ...fish };
	delete fishOut.anchor; delete fishOut.routine; delete fishOut.perspective; delete fishOut.moods;
	if (perspective.length > 0) fishOut.perspective = perspective;
	if (Object.keys(moods).length > 0) fishOut.moods = moods;
	if (anchor !== '') fishOut.anchor = anchor;
	if (routine !== '') fishOut.routine = routine;
	if (typeof fishOut.template !== 'string' || fishOut.template === '') delete fishOut.template;
	return {
		spec: 'chara_card_v2',
		spec_version: '2.0',
		data: {
			...src,
			name,
			description: str(src.description ?? src.char_persona, 8000),
			personality: str(src.personality, 2000),
			scenario: str(src.scenario ?? src.world_scenario, 2000),
			first_mes: str(src.first_mes ?? src.char_greeting, 1000),
			mes_example: str(mesExample, 6000),
			system_prompt: str(src.system_prompt, 4000),
			post_history_instructions: str(src.post_history_instructions, 1000),
			extensions: { ...ext, fish_soul: fishOut },
			character_book: { ...book, entries }
		}
	};
}

const UNDO_REMOVE = { fish_soul_undo: 'remove' };

/**
 * 写 persona.json。旧的那张：留一份做「撤销」（persona.prev.json），再按时间存一份进 persona-backups/（最多 20 份）；
 * 之前用的是 persona.png / 内置的鱼 ⇒ 撤销就是删掉 persona.json。
 */
export function savePersonaCard(dir, card) {
	mkdirSync(dir, { recursive: true });
	const jsonPath = join(dir, 'persona.json');
	const prevPath = join(dir, 'persona.prev.json');
	if (existsSync(jsonPath)) {
		copyFileSync(jsonPath, prevPath);
		const backups = join(dir, 'persona-backups');
		mkdirSync(backups, { recursive: true });
		copyFileSync(jsonPath, join(backups, `persona-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
		const old = readdirSync(backups).filter((f) => /^persona-.*\.json$/.test(f)).sort();
		for (const f of old.slice(0, Math.max(0, old.length - 20))) rmSync(join(backups, f), { force: true });
	} else {
		writeFileSync(prevPath, JSON.stringify(UNDO_REMOVE));
	}
	const tmp = `${jsonPath}.tmp`;
	writeFileSync(tmp, JSON.stringify(card, null, 2));
	renameSync(tmp, jsonPath);
}

export function canUndoPersona(dir) {
	return existsSync(join(dir, 'persona.prev.json'));
}

/** 撤销上一次更换（只有一层）。 */
export function undoPersona(dir) {
	const prevPath = join(dir, 'persona.prev.json');
	if (!existsSync(prevPath)) throw new Error('没有可以撤销的更换');
	const raw = readFileSync(prevPath, 'utf8');
	let prev = null;
	try { prev = JSON.parse(raw); } catch { /* 坏了就当删除 */ }
	const jsonPath = join(dir, 'persona.json');
	if (prev === null || prev.fish_soul_undo === 'remove') rmSync(jsonPath, { force: true });
	else writeFileSync(jsonPath, raw);
	rmSync(prevPath, { force: true });
}

/**
 * 本轮命中的世界书条目：主关键词任一命中；selective 时再按次要关键词逻辑过滤；按优先级排，最多 limit 条。
 * text 传本轮的话 + 最近几句（前面聊到的设定也能接上）。
 */
export function matchLore(lore, text, limit = 4) {
	const raw = String(text ?? '');
	if (raw === '') return [];
	const lower = raw.toLowerCase();
	const has = (e, k) => (e.caseSensitive ? raw.includes(k) : lower.includes(k.toLowerCase()));
	return lore.filter((e) => {
		if (!e.keys.some((k) => has(e, k))) return false;
		if (!e.selective) return true;
		const hits = (e.secondary ?? []).filter((k) => has(e, k)).length;
		const n = (e.secondary ?? []).length;
		if (e.logic === 1) return hits < n;
		if (e.logic === 2) return hits === 0;
		if (e.logic === 3) return hits === n;
		return hits > 0;
	}).slice(0, limit);
}
