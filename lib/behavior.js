/**
 * behavior.js —— v0.9「她的习惯」（纯函数 + 小服务；网关那边的接线在 gateway-behavior.js）：
 *  - 心情影响行为：今天的基调 × 她对这个人的情绪 → 回复快慢、插话积极性、表情包 / 语音多少；
 *  - 去 AI 味：发出去之前去掉"作为 AI / 综上所述 / 希望对你有帮助 / 首先其次最后"、markdown，太长的截到句末；
 *  - 合并转发：get_forward_msg 展开一层（限条数）；
 *  - 每个群一段「群设定」（主人写，只在那个群的上下文里出现）；
 *  - 按聊天选模型：单个聊天 → 私聊 / 群聊默认 → DSH 默认（找不到的提供方跳过）；
 *  - 群里冷热：潜水 → 热闹（窗口内条数 + 人数够）插话概率变高 → 她说完话冷却、慢慢恢复；
 *  - 记忆调试器、每日日记（第二天想聊的话题；可选发 QQ 空间）、每轮判断心情（默认关）。
 */
import { getKv, setKv } from './db.js';
import { segmentsToText, sanitizeName } from './channels/onebot.js';
import { insertMemory, getMood, setMood, relTime } from './soul-memory.js';
import { recallSync, vectorRanks, excludedMemories } from './retrieval.js';

const num = (x, d, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const bool = (x, d) => (x === undefined || x === null ? d : x === true);
const r2 = (x) => Math.round(x * 100) / 100;
const DAY = 86_400_000;

/** 设置里的 behavior → 规整后的参数。 */
export function behaviorConfig(raw) {
	const v = raw ?? {};
	const o = v.outFilter ?? {}; const f = v.forward ?? {}; const ht = v.heat ?? {}; const ia = v.interactions ?? {}; const tm = v.turnMood ?? {}; const d = v.diary ?? {};
	return {
		moodAffects: bool(v.moodAffects, true),
		outFilter: { enabled: bool(o.enabled, true), maxChars: Math.floor(num(o.maxChars, 300, 60, 2000)) },
		forward: { enabled: bool(f.enabled, true), maxLines: Math.floor(num(f.maxLines, 15, 3, 50)) },
		heat: {
			enabled: bool(ht.enabled, true), windowSec: num(ht.windowSec, 120, 30, 900), hotCount: Math.floor(num(ht.hotCount, 6, 3, 50)),
			hotSpeakers: Math.floor(num(ht.hotSpeakers, 3, 1, 20)), boost: num(ht.boost, 1.8, 1, 5), coolMinutes: num(ht.coolMinutes, 20, 0, 240)
		},
		interactions: {
			pokeBack: bool(ia.pokeBack, true), pokeBackChance: num(ia.pokeBackChance, 0.5, 0, 1),
			react: bool(ia.react, false), reactChance: num(ia.reactChance, 0.3, 0, 1), typing: bool(ia.typing, true)
		},
		turnMood: { enabled: bool(tm.enabled, false), minConfidence: num(tm.minConfidence, 0.7, 0, 1) },
		diary: { enabled: bool(d.enabled, true), hour: Math.floor(num(d.hour, 23, 18, 23)), qzone: bool(d.qzone, false) }
	};
}

// ───────────────────────── 心情 → 行为 ─────────────────────────

/** [回复慢多少, 插话积极性, 表情包, 语音, 给她的提示] */
const TONE_FX = { 元气: [0.8, 1.3, 1.3, 1.2, '今天挺有精神'], 慵懒: [1.35, 0.6, 0.8, 0.7, '今天懒洋洋的'] };
const MOOD_FX = {
	开心: [0.85, 1.3, 1.4, 1.2, '心情不错，话可以多一点，表情包可以多发'],
	感动: [1, 1.1, 1.2, 1.1, '心里暖暖的'],
	想念: [0.7, 1.2, 1.1, 1.3, '有点想对方，回得快一点'],
	担心: [0.9, 1, 0.7, 1, '有点担心对方，少开玩笑'],
	委屈: [1.4, 0.5, 0.5, 0.6, '有点委屈，回得慢一点、话少一点，不太想发表情包'],
	生气: [1.7, 0.3, 0.3, 0.4, '在生气，回得慢、简短，不发表情包和语音'],
	失落: [1.4, 0.6, 0.6, 0.7, '有点失落，话少一点']
};
export const NEUTRAL_MOOD = Object.freeze({ delay: 1, interject: 1, sticker: 1, voice: 1, tone: '', mood: '', hint: '' });

/** 今天的基调 + 她对这个人的情绪（getMood 的结果，强度 level 1~3）→ 行为倍率。 */
export function moodProfile({ tone = '', mood = null } = {}) {
	const t = TONE_FX[tone];
	let [d, i, s, v] = t ?? [1, 1, 1, 1];
	const hints = t ? [t[4]] : [];
	const fx = mood ? MOOD_FX[mood.label] : undefined;
	if (fx) {
		const k = Math.min(1, Math.max(0.3, Number(mood.level ?? 2) / 2));
		d *= 1 + (fx[0] - 1) * k; i *= 1 + (fx[1] - 1) * k; s *= 1 + (fx[2] - 1) * k; v *= 1 + (fx[3] - 1) * k;
		hints.push(fx[4]);
	}
	return { delay: r2(d), interject: r2(i), sticker: r2(s), voice: r2(v), tone: t ? tone : '', mood: fx ? mood.label : '', hint: hints.join('，') };
}

/** 心情不好 / 懒的时候，第一条之前多等一会儿（最多 6 秒）。 */
export function firstDelayMs(profile, random = Math.random) {
	const d = Number(profile?.delay ?? 1);
	if (!(d > 1.05)) return 0;
	return Math.round(Math.min(6000, (d - 1) * 5000 * (0.7 + random() * 0.6)));
}

// ───────────────────────── 去 AI 味 ─────────────────────────

const AI_PHRASES = [
	[/(?:作为|身为)(?:一个|一名|一款)?\s*(?:AI|ai|人工智能|语言模型|大模型|AI\s*助手|智能助手|虚拟助手|聊天机器人)[^，。,.!！?？\n]*[，,]?\s*/g, 'AI 自称'],
	// 「你怀疑我是AI」「谁说我是AI」「我是AI吗」是在吐槽 / 反问，不是自称
	[/(?<!(?:怀疑|以为|觉得|当|说|问|猜|认为|觉着|嫌)[^，。,.!！?？\n]{0,3})我(?:只)?是(?:一个|一名|一款|个)?\s*(?:AI|ai|人工智能|语言模型|大模型|AI\s*助手|智能助手|聊天机器人)(?!\s*(?:吗|嘛|么|？|\?|的话))[^，。,.!！?？\n]*[，,。.!！]?\s*/g, 'AI 自称'],
	[/(?:希望|但愿)(?:以上|这些|我的)?(?:回答|内容|建议|信息|解释)?(?:能|可以)?(?:对你|对您)?有(?:所)?帮助[^。！!\n]*[。！!～~]?/g, '客套收尾'],
	[/(?:如果|若)(?:你|您)(?:还)?有(?:任何|其他|别的)?(?:问题|疑问|需要)[^。！!\n]*[。！!～~]?/g, '客套收尾'],
	[/(?:综上所述|总而言之|总的来说|总结一下|简而言之)[，,：:]?\s*/g, '总结腔'],
	[/(?:请注意|需要注意的是|值得注意的是)[，,：:]\s*/g, '说明书腔']
];
const ORDINAL_RE = /(?:^|[。！？!?\n，,]\s*)(首先|其次|然后|再次|最后|第一|第二|第三)[，,、：:]\s*/g;

/**
 * 群消息给模型看的格式是"昵称：内容"，模型有时照猫画虎，回复里每段前面带上自己的名字（"鱼：…"）。
 * 每行开头的「自己的名字 + 冒号」去掉（名字 ≤12 字；对方的名字不动）。
 */
export function stripSelfName(text, names = []) {
	const list = [...new Set(names.map((n) => String(n ?? '').trim()).filter((n) => n !== '' && [...n].length <= 12))];
	if (list.length === 0) return String(text ?? '');
	const esc = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	return String(text ?? '').replace(new RegExp(`^([ \\t]*)(?:${esc})[ \\t]*[:：][ \\t]*`, 'gm'), '$1');
}

/**
 * 去 AI 味（只改写 / 删 / 截短，不撤回）：返回 { text, changes }。
 * 改完变成空的（整段都是套话 / AI 自称）返回空字符串，调用方这轮就不发。
 */
export function deAi(input, { maxChars = 300 } = {}) {
	const changes = new Set();
	let t = String(input ?? '');
	const before = t;
	// markdown
	t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
		.replace(/^\s*>\s?/gm, '')
		.replace(/^\s*[-*•]\s+/gm, '').replace(/^\s*\d{1,2}[.、)]\s+/gm, '')
		.replace(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
		.replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
		.replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join('，'))
		.replace(/`([^`\n]+)`/g, '$1');
	if (t !== before) changes.add('markdown');
	for (const [re, label] of AI_PHRASES) {
		const next = t.replace(re, '');
		if (next !== t) { changes.add(label); t = next; }
	}
	const ordinals = t.match(ORDINAL_RE) ?? [];
	if (ordinals.length >= 2) {
		t = t.replace(ORDINAL_RE, (m, w) => m.slice(0, m.indexOf(w)));
		changes.add('首先其次');
	}
	t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^[，,、 \t]+/gm, '').trim();
	// 整段都是套话 / AI 自称：这条不发（调用方当成 [不回]）
	if (t.replace(/\s/g, '') === '') return { text: '', changes: [...changes, '整段都是套话'] };
	// 太长：按段累计，超了就截到最后一个句末
	const plain = (s) => [...s.replace(/^\s*\[语音\]\s*/gm, '')].length;
	if (plain(t) > maxChars) {
		const paras = t.split(/\n{2,}/);
		const out = [];
		let used = 0;
		for (const p of paras) {
			const n = plain(p);
			if (used + n <= maxChars) { out.push(p); used += n; continue; }
			const room = maxChars - used;
			if (room >= 20) {
				const cut = [...p].slice(0, room).join('');
				const m = cut.match(/^[\s\S]*[。！？!?～~…]/);
				const piece = m ? m[0] : '';
				if (piece.length >= 10) out.push(piece);
			}
			break;
		}
		if (out.length === 0) out.push([...paras[0]].slice(0, maxChars).join('').replace(/[，,、；;：:]?$/, '…'));
		t = out.join('\n\n');
		changes.add('太长截短');
	}
	return { text: t, changes: [...changes] };
}

// ───────────────────────── 合并转发 ─────────────────────────

export const FORWARD_MARK = '【合并转发（暂时看不了）】';

/** get_forward_msg 的返回（各家实现字段不一样）→ "昵称：内容" 几行；嵌套的转发不再展开。 */
export function forwardLines(data, { maxLines = 15 } = {}) {
	const list = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.message) ? data.message
		: Array.isArray(data?.content) ? data.content : [];
	const out = [];
	for (const node of list) {
		const d = node?.type === 'node' ? node.data ?? {} : node ?? {};
		const raw = d.content ?? d.message;
		const segs = Array.isArray(raw) ? raw : typeof raw === 'string' ? [{ type: 'text', data: { text: raw } }] : [];
		const name = sanitizeName(String(d.sender?.card || d.sender?.nickname || d.nickname || d.name || d.sender?.user_id || d.user_id || ''), '某人');
		const text = segmentsToText(segs).text.split(FORWARD_MARK).join('【合并转发】').replace(/\s+/g, ' ').trim().slice(0, 80);
		if (text !== '') out.push(`${name}：${text}`);
	}
	if (out.length > maxLines) return [...out.slice(0, maxLines), `……（后面还有 ${out.length - maxLines} 条）`];
	return out;
}

// ───────────────────────── 群设定 / 冷热 ─────────────────────────

const NOTES_KEY = 'group.notes';
export function groupNotes(db) { return getKv(db, NOTES_KEY, {}) ?? {}; }
export function groupNote(db, groupId) { return String(groupNotes(db)[String(groupId)]?.text ?? ''); }
export function setGroupNote(db, groupId, text, now = Date.now()) {
	const all = groupNotes(db);
	const t = String(text ?? '').trim().slice(0, 500);
	if (t === '') delete all[String(groupId)]; else all[String(groupId)] = { text: t, updatedAt: now };
	setKv(db, NOTES_KEY, all);
	return t;
}

/** 群里的冷热：最近一段时间的条数 / 人数 + 她上次说话的时间。 */
export class GroupHeat {
	constructor() { this.msgs = new Map(); }
	observe(channelId, userId, now = Date.now()) {
		const list = (this.msgs.get(channelId) ?? []).filter((x) => now - x.t < 15 * 60_000);
		list.push({ t: now, u: String(userId) });
		this.msgs.set(channelId, list.slice(-200));
	}
	state(channelId, cfg, lastSpoke = 0, now = Date.now()) {
		const list = (this.msgs.get(channelId) ?? []).filter((x) => now - x.t < cfg.windowSec * 1000);
		const speakers = new Set(list.map((x) => x.u)).size;
		const base = { count: list.length, speakers };
		const since = lastSpoke > 0 ? now - lastSpoke : Infinity;
		if (cfg.coolMinutes > 0 && since < cfg.coolMinutes * 60_000) {
			return { ...base, state: 'cooling', label: '刚说过话，冷却中', factor: r2(0.2 + 0.8 * since / (cfg.coolMinutes * 60_000)) };
		}
		if (list.length >= cfg.hotCount && speakers >= cfg.hotSpeakers) return { ...base, state: 'hot', label: '群里正热闹', factor: cfg.boost };
		return { ...base, state: 'diving', label: list.length === 0 ? '群里没人说话' : '潜水中', factor: 1 };
	}
}

// ───────────────────────── 按聊天选模型 ─────────────────────────

function cleanSel(v) {
	if (!v || typeof v !== 'object') return null;
	const provider = String(v.provider ?? '').trim().slice(0, 100);
	const model = String(v.model ?? '').trim().slice(0, 200);
	return provider !== '' && model !== '' ? { provider, model } : null;
}

export function chatModelsConfig(raw) {
	const seen = new Set();
	const overrides = [];
	for (const o of Array.isArray(raw?.overrides) ? raw.overrides : []) {
		const channelId = String(o?.channelId ?? '').trim().slice(0, 120);
		const sel = cleanSel(o);
		if (!/^(private|group|bili|douyin):./.test(channelId) || sel === null || seen.has(channelId)) continue;
		seen.add(channelId);
		overrides.push({ channelId, ...sel });
	}
	return { private: cleanSel(raw?.private), group: cleanSel(raw?.group), overrides: overrides.slice(0, 200) };
}

/** 这个聊天用哪个模型：单独指定的 → 私聊 / 群聊默认 → null（= 跟 DSH 默认）；提供方已经没了的跳过。 */
export function resolveChatModel(raw, channelId, { known = () => true } = {}) {
	const c = chatModelsConfig(raw);
	const kind = String(channelId ?? '').split(':')[0];
	const chain = [];
	const o = c.overrides.find((x) => x.channelId === channelId);
	if (o) chain.push({ provider: o.provider, model: o.model, from: 'chat' });
	const def = kind === 'group' ? c.group : c.private;
	if (def) chain.push({ ...def, from: kind === 'group' ? 'group' : 'private' });
	return chain.find((s) => known(s.provider)) ?? null;
}

// ───────────────────────── 每轮判断心情（默认关）─────────────────────────

const MOODS = ['开心', '感动', '想念', '担心', '委屈', '生气', '失落'];

function parseJson(text) {
	const m = String(text ?? '').match(/\{[\s\S]*\}/);
	if (!m) return null;
	try { return JSON.parse(m[0]); } catch { return null; }
}

/** 一句话之后她对这个人的情绪有没有明显变化（模型给把握，低于门槛不改）。 */
export function makeMoodJudge({ db, clock, callLlm, getConfig, personaName, recentLines, note }) {
	return async function judge(ownerId, who, text, channelId) {
		const cfg = behaviorConfig(getConfig().behavior).turnMood;
		const t = String(text ?? '').trim();
		if (!cfg.enabled || !ownerId || t === '' || [...t].length < 2) return null;
		const now = clock.now();
		const cur = getMood(db, ownerId, now);
		const prompt = `你是${personaName()}。判断你读完${who}这句话之后，你对${who}的情绪有没有明显变化。\n` +
			`你之前对${who}的情绪：${cur?.label ?? '平静'}\n` +
			`最近的聊天：\n${(recentLines?.(channelId) ?? []).join('\n') || '（没有）'}\n这句：${who}：${t.slice(0, 300)}\n` +
			`只输出 JSON：{"mood":"${MOODS.join('/')}/平静","intensity":1到3,"confidence":0到1,"reason":"十个字以内"}。` +
			'普通闲聊、没有明显变化就填平静、confidence 给低。';
		const parsed = parseJson(await callLlm(prompt, { maxTokens: 300 }));
		if (!parsed) return null;
		const label = String(parsed.mood ?? '').trim();
		const confidence = Number(parsed.confidence) || 0;
		const out = { label, confidence, reason: String(parsed.reason ?? '').slice(0, 30), changed: false };
		if (!MOODS.includes(label) || confidence < cfg.minConfidence || label === cur?.label) return out;
		setMood(db, ownerId, { label, reason: out.reason, intensity: Number(parsed.intensity) || 2 }, now);
		out.changed = true;
		note?.('mood', { channelId, who, text: t, reason: `情绪变成「${label}」（把握 ${Math.round(confidence * 100)}%）${out.reason ? `：${out.reason}` : ''}` });
		return out;
	};
}

// ───────────────────────── 每日日记 ─────────────────────────

function dayOf(ms) {
	const d = new Date(ms + 8 * 3600_000);
	return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

/** 每晚（虚拟时间过了设定的点）写一篇她自己的日记：记成"她自己"的私密记忆，顺便列出明天想跟谁聊什么。 */
export class DiaryWriter {
	constructor({ db, clock, worker, callLlm, getConfig, personaName, life, findOwnerByName, note, log, qzone }) {
		Object.assign(this, { db, clock, worker, callLlm, getConfig, personaName, life, findOwnerByName, note, qzone });
		this.log = log ?? (() => {});
		this.timer = null;
		this.running = false;
	}

	start(everyMs = 5 * 60_000) {
		if (this.timer !== null) return;
		this.timer = setInterval(() => { void this.tick().catch(() => {}); }, everyMs);
		this.timer.unref?.();
	}

	stop() { if (this.timer !== null) clearInterval(this.timer); this.timer = null; }

	cfg() { return behaviorConfig(this.getConfig().behavior).diary; }

	/** 今天的材料：日程、聊过的（小结）、她自己说过的、动态里的聊天次数。 */
	material(date) {
		const start = Date.parse(`${date}T00:00:00+08:00`);
		const end = start + DAY;
		const db = this.db;
		const eps = db.prepare(`SELECT m.content, p.display_name AS name FROM memory m LEFT JOIN person p ON ('user:' || p.canonical_id) = m.owner_id
			WHERE m.character_id = 'feiyu' AND m.kind = 'episode' AND m.status = 'active' AND m.created_at >= ? AND m.created_at < ? ORDER BY m.created_at LIMIT 20`).all(start, end);
		const self = db.prepare(`SELECT content FROM memory WHERE character_id = 'feiyu' AND owner_id = 'self' AND kind <> 'diary' AND status = 'active'
			AND created_at >= ? AND created_at < ? ORDER BY created_at LIMIT 10`).all(start, end);
		const snap = this.life?.stateSnapshot?.() ?? null;
		const plan = snap?.today?.date === date ? snap.today : null;
		return {
			tone: plan?.dailyMoodTone ?? '', schedule: (plan?.scheduleSummary ?? []).map((s) => `${s.range ?? ''} ${s.activity ?? ''}`.trim()),
			episodes: eps.map((e) => `${e.name ? `和${e.name}：` : ''}${e.content}`), self: self.map((s) => s.content)
		};
	}

	/** 到点了就写（force = 设置页"现在写一篇"）。返回 { date, diary, topics } 或 null。 */
	async tick({ force = false } = {}) {
		const cfg = this.cfg();
		if (!force && !cfg.enabled) return null;
		const now = this.clock.now();
		const { date, hour } = dayOf(now);
		if (!force && (hour < cfg.hour || getKv(this.db, 'diary.last', '') === date)) return null;
		if (this.running) return null;
		const tries = Number(getKv(this.db, `diary.tries.${date}`, 0)) || 0;
		if (!force && tries >= 3) return null;
		this.running = true;
		try {
			const mat = this.material(date);
			if (!force && mat.episodes.length === 0 && mat.self.length === 0) { setKv(this.db, 'diary.last', date); return null; }
			setKv(this.db, `diary.tries.${date}`, tries + 1);
			const name = this.personaName();
			const prompt = `你是${name}。今天是 ${date}，睡前写一篇自己的日记。\n` +
				(mat.tone ? `今天的基调：${mat.tone}\n` : '') +
				(mat.schedule.length ? `今天的安排：${mat.schedule.join('；')}\n` : '') +
				`今天聊过的：\n${mat.episodes.map((e) => `- ${e}`).join('\n') || '（没怎么聊天）'}\n` +
				(mat.self.length ? `今天自己说过的事：\n${mat.self.map((e) => `- ${e}`).join('\n')}\n` : '') +
				'要求：第一人称、口语、像真的日记，100~200 字；写自己的感受，别人的私事一笔带过、别写细节；不要提 AI、模型、系统。\n' +
				'再想想明天想主动跟谁聊点什么（最多 3 条，没有就空）。\n' +
				'只输出 JSON：{"diary":"……","topics":[{"who":"对方的名字","topic":"想聊的事（一句话）"}]}';
			const parsed = parseJson(await this.callLlm(prompt, { maxTokens: 900 }));
			const diary = String(parsed?.diary ?? '').trim().slice(0, 600);
			if (diary === '') { this.note?.('failed', { title: '日记', reason: '日记没写成（模型没给结果）' }); return null; }
			insertMemory(this.db, this.worker, { ownerId: 'self', channel: 'self', channelId: '', kind: 'diary', content: `${date} 的日记：${diary}`, importance: 2, private: true }, now);
			const topics = (Array.isArray(parsed.topics) ? parsed.topics : []).slice(0, 3).map((x) => ({
				who: String(x?.who ?? '').trim().slice(0, 24), topic: String(x?.topic ?? '').trim().slice(0, 80)
			})).filter((x) => x.topic !== '').map((x) => ({ ...x, ownerId: x.who ? this.findOwnerByName?.(x.who) ?? null : null }));
			setKv(this.db, 'diary.topics', { date, at: now, items: topics });
			setKv(this.db, 'diary.last', date);
			this.note?.('diary', { title: '日记', reason: '写了今天的日记', text: diary });
			if (cfg.qzone && typeof this.qzone === 'function') {
				try { await this.qzone(diary); this.note?.('diary', { title: '日记', reason: '日记发到了 QQ 空间' }); } catch (error) {
					this.note?.('failed', { title: '日记', reason: `日记没发到 QQ 空间：${String(error instanceof Error ? error.message : error).slice(0, 60)}` });
				}
			}
			return { date, diary, topics };
		} finally {
			this.running = false;
		}
	}

	/** 昨晚（36 小时内）日记里想跟这个人聊的。 */
	topicsFor(ownerId, now = this.clock.now()) {
		const t = getKv(this.db, 'diary.topics', null);
		if (!t || !Array.isArray(t.items) || now - Number(t.at ?? 0) > 36 * 3600_000) return [];
		return t.items.filter((x) => x.ownerId === ownerId).map((x) => x.topic);
	}

	entries(n = 7) {
		return this.db.prepare(`SELECT id, content, created_at FROM memory WHERE character_id = 'feiyu' AND owner_id = 'self' AND kind = 'diary' AND status = 'active'
			ORDER BY created_at DESC LIMIT ?`).all(n).map((m) => ({ id: m.id, content: m.content, at: m.created_at }));
	}

	state() {
		return { config: this.cfg(), last: getKv(this.db, 'diary.last', '') || null, topics: getKv(this.db, 'diary.topics', null), entries: this.entries() };
	}
}

// ───────────────────────── 记忆调试器 / 上下文 ─────────────────────────

/** 输入一句话 + 一个人：会想起哪些（分数、排名），没想起来的为什么。 */
export async function debugRecall({ db, clock, embedder, embeddingCfg, config, ownerId, text, inGroup = false }) {
	const query = String(text ?? '').trim().slice(0, 500);
	let vec = null;
	try {
		vec = await Promise.race([
			vectorRanks({ db, embedder, characterId: 'feiyu', ownerId, query, embeddingCfg }).catch(() => null),
			new Promise((r) => { const t = setTimeout(() => r(null), 6000); t.unref?.(); })
		]);
	} catch { vec = null; }
	const res = recallSync({ db, clock, config, characterId: 'feiyu', ownerId, query, vec, excludePrivate: inGroup, explain: true });
	const now = clock.now();
	const when = (list) => list.map((m) => ({ ...m, when: relTime(m.createdAt, now) }));
	return { query, inGroup, topK: res.topK, vector: res.vector, recalled: when(res.recalled), others: when(res.others), excluded: excludedMemories(db, 'feiyu', ownerId, { inGroup }) };
}

/** 瞬态块里 v0.9 的几行：群设定、她现在的状态（心情 → 行为）、昨晚日记里想聊的。 */
export function behaviorLines({ db, getConfig, session, known, tone, now, diary }) {
	const out = [];
	const cfg = behaviorConfig(getConfig().behavior);
	const inGroup = session.channel === 'qq-group';
	if (inGroup && session.channelId) {
		const note = groupNote(db, session.channelId.slice(6));
		if (note) out.push(`[这个群的设定（主人写的，只在这个群适用）] ${note}`);
	}
	if (cfg.moodAffects && session.channel !== 'dsh') {
		const last = known[known.length - 1];
		const p = moodProfile({ tone, mood: last ? getMood(db, last.ownerId, now) : null });
		if (p.hint) out.push(`[你现在的状态] ${p.hint}——体现在回复的快慢、长短和语气上，别直接说出来。`);
	}
	if (!inGroup && known.length === 1 && diary) {
		const topics = diary.topicsFor(known[0].ownerId, now);
		if (topics.length > 0) out.push(`[昨晚日记里想跟 ${known[0].displayName} 聊的] ${topics.join('；')}（合适就自然地提，不合适就算了）`);
	}
	return out;
}
