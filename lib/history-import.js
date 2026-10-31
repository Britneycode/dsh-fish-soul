/**
 * history-import.js —— 聊天记录导入（v0.6）：从别的 bot / 工具搬过来那天，她就"认识"老朋友。
 *
 * 支持的来源（自动识别）：
 *  - QQ 消息管理器导出的 txt（"2024-01-01 12:00:00 张三(123456)" / "张三(123456) 2024-01-01 12:00:00" 两种抬头）；
 *  - SillyTavern 聊天记录 jsonl（第一行是元数据，之后每行一条 {name, is_user, send_date, mes}）；
 *  - JSON 消息数组 / {messages:[…]}（QQChatExporter 一类：sender{uin,name} + content{text} + time）；
 *  - 记忆 JSON 数组（{content, qqUin|ownerId, kind…}）→ 直接走 importer.js 的记忆导入；
 *  - 麦麦（MaiBot）的数据库文件：mai_messages（新版）/ messages（旧版）里 platform=qq 的消息，
 *    以及 person_info.memory_points（麦麦已经记下的印象，直接变成记忆，不花模型调用）。
 *
 * 流程：预览（识别格式、列出说话人和条数、估算要调几次模型）→ 主人确认"哪个是她自己"、给没有 QQ 号的人填 QQ 号
 * → 后台按人分段交给模型提炼成记忆（第三人称、带大致时间、附上出处），去重（同句 / 关键词重合 ≥ 80%）后写库，
 * 进向量队列；关系阶段只升不降，互动次数累加；新记忆够多的人顺手跑一次 Dream 写"印象"。
 * 没有 QQ 号的人不导入（以后在 QQ 上遇到会对不上人）。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setKv, getKv } from './db.js';
import { tokenizeForBm25 } from './segment.js';
import { stageBase } from './soul-memory.js';
import { ensurePerson, importMemories } from './importer.js';

const STAGES = ['stranger', 'acquaintance', 'friend', 'close'];
const CHUNK_CHARS = 3500;
const CHUNKS_PER_PERSON = 12;
const DEFAULT_MAX_CALLS = 150;
const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_MESSAGES = 200_000;

// ───────────────────────── 解析 ─────────────────────────

/** "2024-1-2 3:04:05"（按 UTC+8 理解）/ 秒 / 毫秒 / ISO → 毫秒；看不懂返回 null。 */
export function parseTime(v) {
	if (v === undefined || v === null || v === '') return null;
	if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return null;
		return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
	}
	const s = String(v).trim();
	const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d+)?$/.exec(s);
	if (m) {
		const p = (x) => String(x).padStart(2, '0');
		const t = Date.parse(`${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${m[5]}:${m[6] ?? '00'}+08:00`);
		return Number.isFinite(t) ? t : null;
	}
	// SillyTavern 的 "January 1, 2024 12:00am"
	const fixed = s.replace(/(\d)(am|pm)$/i, '$1 $2');
	const t = Date.parse(fixed);
	return Number.isFinite(t) ? t : null;
}

/** "张三(123456)" / "张三<123456@qq.com>" / "张三" → { name, qq } */
export function splitSender(raw) {
	const s = String(raw ?? '').trim();
	let m = /^(.*?)\s*[(（](\d{5,12})[)）]$/.exec(s);
	if (m) return { name: m[1].trim() || m[2], qq: m[2] };
	m = /^(.*?)\s*<([^>]+)>$/.exec(s);
	if (m) {
		const qq = /^(\d{5,12})@qq\.com$/i.exec(m[2])?.[1] ?? '';
		return { name: m[1].trim() || m[2], qq };
	}
	return { name: s, qq: '' };
}

/** QQ 消息管理器 txt。 */
export function parseQqTxt(text, { fileName = '' } = {}) {
	const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
	const H1 = /^(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}:\d{2})\s+(.+?)\s*$/;
	const H2 = /^(.+?)\s+(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}:\d{2})\s*$/;
	const chats = [];
	let chat = null;
	let group = '';
	let cur = null;
	const flush = () => {
		if (cur !== null && cur.text.trim() !== '') chat.messages.push({ ...cur, text: cur.text.trim() });
		cur = null;
	};
	const newChat = (title) => {
		flush();
		chat = { key: `txt:${chats.length}`, kind: /群/.test(group) ? 'group' : 'private', title, messages: [] };
		chats.push(chat);
	};
	for (const line of lines) {
		const sec = /^消息对象\s*[:：]\s*(.+)$/.exec(line.trim());
		if (sec) { newChat(sec[1].trim()); continue; }
		const grp = /^消息分组\s*[:：]\s*(.+)$/.exec(line.trim());
		if (grp) { flush(); group = grp[1].trim(); continue; }
		if (/^={8,}$/.test(line.trim()) || /^消息记录（/.test(line.trim())) { flush(); continue; }
		const h1 = H1.exec(line);
		const h2 = h1 ? null : H2.exec(line);
		if (h1 || h2) {
			if (chat === null) newChat(fileName.replace(/\.txt$/i, '') || '聊天记录');
			flush();
			const timeMs = parseTime(h1 ? h1[1] : h2[2]);
			const { name, qq } = splitSender(h1 ? h1[2] : h2[1]);
			cur = { name, qq, self: name === '我', text: '', timeMs };
			continue;
		}
		if (cur !== null) cur.text += `${line}\n`;
	}
	flush();
	for (const c of chats) {
		// 没写分组的：两个以上不是她的人在说话就当群
		const others = new Set(c.messages.filter((m) => !m.self).map((m) => m.qq || m.name));
		if (!/群/.test(group) && others.size > 1) c.kind = 'group';
		const gq = /[(（](\d{5,12})[)）]\s*$/.exec(c.title);
		if (c.kind === 'group' && gq) c.groupId = gq[1];
	}
	return { format: 'qq-txt', chats: chats.filter((c) => c.messages.length > 0) };
}

/** SillyTavern jsonl。 */
export function parseSillyTavern(text) {
	const rows = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const meta = rows.find((r) => r.user_name !== undefined || r.character_name !== undefined) ?? {};
	const msgs = rows.filter((r) => typeof r.mes === 'string' && r.is_system !== true);
	const n = msgs.length;
	const messages = msgs.map((r, i) => ({
		name: String(r.name ?? (r.is_user ? meta.user_name : meta.character_name) ?? (r.is_user ? 'User' : '角色')),
		qq: '',
		self: r.is_user !== true,
		text: r.mes.trim(),
		timeMs: parseTime(r.send_date) ?? (Date.now() - (n - i) * 60_000)
	})).filter((m) => m.text !== '');
	return { format: 'sillytavern', chats: [{ key: 'st:0', kind: 'private', title: `SillyTavern·${meta.character_name ?? '角色'}`, messages }] };
}

function looksLikeMemory(it) {
	return it && typeof it === 'object' && (typeof it.content === 'string' || typeof it.memory === 'string') &&
		(it.qqUin !== undefined || it.ownerId !== undefined || it.kind !== undefined || it.importance !== undefined) &&
		it.sender === undefined && it.mes === undefined;
}

/** JSON：记忆数组 / 消息数组 / {messages:[…]}（QQChatExporter 一类）。 */
export function parseJsonHistory(value, { fileName = '' } = {}) {
	if (Array.isArray(value) && value.length > 0 && value.every(looksLikeMemory)) return { format: 'memories', chats: [], memories: value };
	const list = Array.isArray(value) ? value : Array.isArray(value?.messages) ? value.messages : Array.isArray(value?.data?.messages) ? value.data.messages : null;
	if (list === null) return { format: 'unknown', chats: [] };
	const info = value?.chatInfo ?? value?.chat ?? value?.meta ?? {};
	const title = String(info.name ?? value?.title ?? fileName.replace(/\.json$/i, '') ?? '聊天记录');
	const chats = new Map();
	for (const m of list) {
		if (!m || typeof m !== 'object') continue;
		const sender = m.sender ?? {};
		const senderObj = typeof sender === 'object' ? sender : {};
		const name = String(senderObj.name ?? senderObj.nickname ?? senderObj.card ?? senderObj.remark ?? m.sender_name ?? m.nickname ?? m.user_nickname ?? m.name ?? (typeof sender === 'string' ? sender : '') ?? '').trim();
		const qq = String(senderObj.uin ?? senderObj.user_id ?? senderObj.qq ?? m.user_id ?? m.qq ?? m.userId ?? m.uin ?? m.sender_id ?? '').trim();
		const c = m.content ?? m.text ?? m.message ?? m.mes ?? m.raw_message ?? '';
		const text = String(typeof c === 'string' ? c : c?.text ?? (Array.isArray(c) ? c.map((x) => x?.text ?? x?.data?.text ?? '').join('') : '')).trim();
		if (text === '' || (name === '' && qq === '')) continue;
		const groupId = String(m.group_id ?? m.groupId ?? info.groupId ?? (info.type === 'group' ? info.id ?? '' : '') ?? '');
		const key = groupId !== '' ? `group:${groupId}` : 'json:0';
		if (!chats.has(key)) chats.set(key, { key, kind: groupId !== '' || info.type === 'group' ? 'group' : 'private', title, groupId: groupId || undefined, messages: [] });
		chats.get(key).messages.push({
			name: name || qq, qq: /^\d{5,12}$/.test(qq) ? qq : '', text,
			self: m.is_self === true || m.isSelf === true || m.self === true || m.from_me === true || m.fromMe === true,
			timeMs: parseTime(m.time ?? m.timestamp ?? m.send_date ?? m.date ?? m.msgTime)
		});
	}
	for (const c of chats.values()) {
		const others = new Set(c.messages.filter((x) => !x.self).map((x) => x.qq || x.name));
		if (others.size > 1) c.kind = 'group';
	}
	return { format: 'json-messages', chats: [...chats.values()] };
}

/** 文件内容 → 解析结果（按扩展名和内容猜格式）。 */
export function parseHistoryText(text, { fileName = '' } = {}) {
	const body = String(text ?? '').replace(/^\uFEFF/, '');
	const head = body.trimStart();
	if (/\.jsonl$/i.test(fileName) || (/^\{/.test(head) && /\n\s*\{/.test(head) && /"mes"\s*:/.test(head))) return parseSillyTavern(body);
	if (/^[[{]/.test(head)) {
		try { return parseJsonHistory(JSON.parse(body), { fileName }); } catch { /* 不是整段 JSON */ }
	}
	const txt = parseQqTxt(body, { fileName });
	return txt.chats.length > 0 ? txt : { format: 'unknown', chats: [] };
}

/** memory_points：JSON 数组，元素是 "分类:内容:权重" 字符串或 {content}。 */
function memoryPointsOf(raw) {
	let v = raw;
	try { if (typeof v === 'string') v = JSON.parse(v); } catch { return []; }
	if (!Array.isArray(v)) return [];
	return v.map((x) => {
		if (typeof x === 'string') {
			const parts = x.split(':');
			return (parts.length >= 3 ? parts.slice(1, -1).join(':') : x).trim();
		}
		return String(x?.content ?? x?.text ?? x?.point ?? '').trim();
	}).filter((x) => x.length >= 2);
}

/** 麦麦（MaiBot）的数据库：新版 mai_messages、旧版 messages；只取 QQ 平台。 */
export function readMaiBotDb(path) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
		const colsOf = (t) => new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((r) => r.name));
		const table = tables.has('mai_messages') ? 'mai_messages' : tables.has('messages') ? 'messages' : null;
		if (table === null) throw new Error('这个数据库里没有麦麦的消息表（mai_messages / messages）');
		const cols = colsOf(table);
		const pick = (...names) => names.find((n) => cols.has(n)) ?? null;
		const timeCol = pick('timestamp', 'time');
		const textCol = pick('processed_plain_text', 'display_message', 'plain_text');
		const userCol = pick('user_id');
		if (!timeCol || !textCol || !userCol) throw new Error(`消息表 ${table} 的字段对不上（缺时间 / 正文 / user_id）`);
		const nameCols = ['user_cardname', 'user_nickname'].filter((c) => cols.has(c));
		const chatCol = pick('session_id', 'chat_id');
		const groupCol = pick('group_id', 'chat_info_group_id');
		const platformCol = pick('platform', 'user_platform', 'chat_info_platform');
		const sel = [`"${timeCol}" AS t`, `"${textCol}" AS x`, `"${userCol}" AS u`,
			nameCols.length > 0 ? `COALESCE(${nameCols.map((c) => `NULLIF("${c}", '')`).join(', ')}, '') AS n` : "'' AS n",
			chatCol ? `"${chatCol}" AS c` : "'' AS c", groupCol ? `"${groupCol}" AS g` : "'' AS g",
			platformCol ? `"${platformCol}" AS p` : "'qq' AS p"].join(', ');
		const rows = db.prepare(`SELECT ${sel} FROM "${table}" ORDER BY "${timeCol}" DESC LIMIT ${MAX_MESSAGES}`).all().reverse();
		const chats = new Map();
		let otherPlatform = 0;
		for (const r of rows) {
			if (String(r.p ?? 'qq').toLowerCase() !== 'qq') { otherPlatform++; continue; }
			const text = String(r.x ?? '').trim();
			if (text === '') continue;
			const g = String(r.g ?? '').trim();
			const key = String(r.c || (g !== '' ? `group:${g}` : `private:${r.u}`));
			if (!chats.has(key)) chats.set(key, { key, kind: g !== '' ? 'group' : 'private', title: g !== '' ? `麦麦·群 ${g}` : `麦麦·私聊 ${String(r.n || r.u)}`, groupId: g || undefined, messages: [] });
			chats.get(key).messages.push({ name: String(r.n || r.u), qq: String(r.u ?? ''), self: false, text, timeMs: parseTime(r.t) });
		}
		// 麦麦已经记下的印象
		const memories = [];
		if (tables.has('person_info')) {
			const pc = colsOf('person_info');
			if (pc.has('user_id') && (pc.has('memory_points') || pc.has('impression'))) {
				const fields = ['user_id', ...['platform', 'person_name', 'user_nickname', 'memory_points', 'impression'].filter((c) => pc.has(c))];
				for (const p of db.prepare(`SELECT ${fields.map((f) => `"${f}"`).join(', ')} FROM person_info`).all()) {
					if (p.platform !== undefined && String(p.platform ?? 'qq').toLowerCase() !== 'qq') continue;
					const qq = String(p.user_id ?? '');
					if (!/^\d{5,12}$/.test(qq)) continue;
					const nickname = String(p.person_name || p.user_nickname || '');
					const points = [...memoryPointsOf(p.memory_points), ...(typeof p.impression === 'string' && p.impression.trim() !== '' ? [p.impression.trim()] : [])];
					for (const content of points.slice(0, 40)) memories.push({ qqUin: qq, nickname, content: nickname ? `${nickname}：${content}` : content, kind: 'fact', importance: 2 });
				}
			}
		}
		return { format: 'maibot', chats: [...chats.values()], memories, warnings: otherPlatform > 0 ? [`跳过了 ${otherPlatform} 条不是 QQ 平台的消息`] : [] };
	} finally {
		db.close();
	}
}

// ───────────────────────── 提炼 ─────────────────────────

const speakerKey = (m) => (m.qq ? `qq:${m.qq}` : `name:${m.name}`);

function fmtDay(ms) {
	if (!Number.isFinite(ms)) return '';
	return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}
function fmtStamp(ms) {
	if (!Number.isFinite(ms)) return '';
	return new Date(ms + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
}

function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let n = 0;
	for (const x of a) if (b.has(x)) n++;
	return n / (a.size + b.size - n);
}
const tokenSet = (text) => new Set(tokenizeForBm25(text).split(' ').filter(Boolean));

/**
 * 解析结果 + 主人的确认 → 每个人要交给模型的分段。
 * @returns {Array<{qq:string, name:string, messageCount:number, firstMs:number|null, chunks:Array<{chatTitle:string, kind:string, channelId:string, startMs:number|null, endMs:number|null, text:string}>}>}
 */
export function buildPersonChunks(parsed, { selfKeys, mapping, personaName = '我' }) {
	const self = new Set(selfKeys ?? []);
	const qqOf = (m) => {
		const k = speakerKey(m);
		const mapped = String(mapping?.[k] ?? '').trim();
		return /^\d{5,12}$/.test(mapped) ? mapped : (m.qq || '');
	};
	const persons = new Map();
	const personOf = (qq, name) => {
		if (!persons.has(qq)) persons.set(qq, { qq, name, messageCount: 0, firstMs: null, lines: [] });
		return persons.get(qq);
	};
	for (const chat of parsed.chats ?? []) {
		const msgs = [...chat.messages].sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));
		const isSelf = (m) => m.self === true || self.has(speakerKey(m));
		const line = (m) => `[${fmtStamp(m.timeMs)}] ${isSelf(m) ? personaName : m.name}：${m.text.replace(/\s+/g, ' ').slice(0, 300)}`;
		if (chat.kind === 'private') {
			const other = msgs.find((m) => !isSelf(m));
			if (!other) continue;
			const qq = qqOf(other);
			if (!qq) continue;
			const p = personOf(qq, other.name);
			for (const m of msgs) {
				if (!isSelf(m)) { p.messageCount++; p.firstMs = p.firstMs === null ? m.timeMs : Math.min(p.firstMs, m.timeMs ?? p.firstMs); }
				p.lines.push({ chat, timeMs: m.timeMs, text: line(m), channelId: `private:${qq}` });
			}
			continue;
		}
		// 群：每个人自己说的话 + 紧跟着她接的话
		for (let i = 0; i < msgs.length; i++) {
			const m = msgs[i];
			if (isSelf(m)) continue;
			const qq = qqOf(m);
			if (!qq) continue;
			const p = personOf(qq, m.name);
			p.messageCount++;
			p.firstMs = p.firstMs === null ? m.timeMs : Math.min(p.firstMs, m.timeMs ?? p.firstMs);
			const channelId = chat.groupId ? `group:${chat.groupId}` : '';
			p.lines.push({ chat, timeMs: m.timeMs, text: line(m), channelId });
			for (let j = i + 1; j < Math.min(msgs.length, i + 3) && isSelf(msgs[j]); j++) p.lines.push({ chat, timeMs: msgs[j].timeMs, text: line(msgs[j]), channelId });
		}
	}
	const out = [];
	for (const p of persons.values()) {
		const chunks = [];
		let cur = null;
		for (const l of p.lines) {
			if (cur === null || cur.chat !== l.chat || cur.text.length + l.text.length > CHUNK_CHARS) {
				cur = { chat: l.chat, chatTitle: l.chat.title, kind: l.chat.kind, channelId: l.channelId, startMs: l.timeMs, endMs: l.timeMs, text: '' };
				chunks.push(cur);
			}
			cur.text += `${l.text}\n`;
			cur.endMs = l.timeMs ?? cur.endMs;
		}
		// 只留最近的几段（越近越要紧），按时间顺序交给模型
		out.push({ qq: p.qq, name: p.name, messageCount: p.messageCount, firstMs: p.firstMs, chunks: chunks.slice(-CHUNKS_PER_PERSON).map(({ chat, ...rest }) => rest) });
	}
	return out.sort((a, b) => b.messageCount - a.messageCount);
}

/** 总调用次数上限：轮流从每个人最近的一段往前取。 */
export function capChunks(persons, maxCalls) {
	const want = persons.map((p) => ({ ...p, keep: 0 }));
	let left = Math.max(0, maxCalls);
	let progressed = true;
	while (left > 0 && progressed) {
		progressed = false;
		for (const p of want) {
			if (left <= 0) break;
			if (p.keep < p.chunks.length) { p.keep++; left--; progressed = true; }
		}
	}
	return want.map(({ keep, ...p }) => ({ ...p, chunks: keep === 0 ? [] : p.chunks.slice(-keep) })).filter((p) => p.chunks.length > 0);
}

function extractPrompt({ personaName, name, chunk }) {
	const range = [fmtDay(chunk.startMs), fmtDay(chunk.endMs)].filter(Boolean);
	const when = range.length === 0 ? '' : range[0] === range[1] ? `，${range[0]}` : `，${range[0]} ~ ${range[1]}`;
	return `你是「${personaName}」。下面是${chunk.kind === 'group' ? `群聊「${chunk.chatTitle}」里「${name}」说的话（和你接的话）` : `你和「${name}」过去的私聊记录`}${when}。\n` +
		`从里面提取关于「${name}」值得长期记住的东西：TA 是谁、怎么称呼、喜欢和讨厌什么、经历和近况、你们之间发生过的事、TA 交代过的约定。` +
		'每条用第三人称写成一句完整的话，带上大致时间（比如"2024 年 3 月"），不要编造，没有值得记的就空数组。\n' +
		'只输出 JSON：{"memories":[{"content":"...","kind":"fact|event|feeling","importance":1到5,"emotion":-2到2}],' +
		'"relation":"stranger|acquaintance|friend|close"}，最多 8 条。\n聊天记录：\n' + chunk.text;
}

// ───────────────────────── 后台任务 ─────────────────────────

export class HistoryImporter {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {{now(): number}} deps.clock
	 * @param {{enqueueRealtime(id: number, text: string): void}} deps.worker
	 * @param {(prompt: string, opts?: object) => Promise<string|null>} deps.callLlm
	 * @param {{runDream(ownerId: string): Promise<void>}|null} [deps.life]
	 * @param {() => string} deps.personaName
	 * @param {() => string} deps.masterQq
	 * @param {() => string} deps.selfQq 她现在登录的 QQ 号（麦麦 / QQ 导出里她自己的消息）
	 */
	constructor({ db, clock, worker, callLlm, life = null, log, personaName, masterQq, selfQq }) {
		Object.assign(this, { db, clock, worker, callLlm, life, personaName, masterQq, selfQq });
		this.log = log ?? (() => {});
		this.previews = new Map();
		this.job = null;
		this.controller = null;
	}

	/** 解析上传的文本 / 本机数据库路径 → 预览（解析结果暂存 30 分钟，start 时用 previewId 取）。 */
	preview({ text, fileName = '', dbPath = '' }) {
		let parsed;
		if (String(dbPath).trim() !== '') parsed = readMaiBotDb(String(dbPath).trim());
		else parsed = parseHistoryText(text, { fileName });
		if (parsed.format === 'unknown') throw new Error('看不出这是什么格式（支持 QQ 导出的 txt、SillyTavern 的 jsonl、消息 / 记忆 JSON、麦麦的数据库）');
		const selfQq = String(this.selfQq?.() ?? '');
		const master = String(this.masterQq?.() ?? '');
		const speakers = new Map();
		for (const chat of parsed.chats) {
			for (const m of chat.messages) {
				const k = speakerKey(m);
				if (!speakers.has(k)) speakers.set(k, { key: k, name: m.name, qq: m.qq, count: 0, self: false, chats: new Set() });
				const sp = speakers.get(k);
				sp.count++;
				sp.chats.add(chat.title);
				if (m.self === true || (selfQq !== '' && m.qq === selfQq)) sp.self = true;
			}
		}
		const list = [...speakers.values()].sort((a, b) => b.count - a.count).slice(0, 200).map((sp) => {
			const person = sp.qq ? this.db.prepare('SELECT display_name, relation_stage FROM person WHERE qq_uin = ?').get(sp.qq) : undefined;
			// SillyTavern 里的"用户"默认就是主人
			const suggestQq = sp.qq || (parsed.format === 'sillytavern' && !sp.self && master !== '' ? master : '');
			return { key: sp.key, name: sp.name, qq: sp.qq, suggestQq, count: sp.count, self: sp.self, chats: [...sp.chats].slice(0, 3),
				existing: person ? { displayName: person.display_name, relationStage: person.relation_stage } : null };
		});
		const id = randomUUID();
		this.previews.set(id, { parsed, fileName: fileName || dbPath, at: Date.now() });
		for (const [k, v] of this.previews) if (Date.now() - v.at > PREVIEW_TTL_MS) this.previews.delete(k);
		const mapping = Object.fromEntries(list.filter((s) => s.suggestQq).map((s) => [s.key, s.suggestQq]));
		const persons = buildPersonChunks(parsed, { selfKeys: list.filter((s) => s.self).map((s) => s.key), mapping, personaName: this.personaName() });
		return {
			previewId: id,
			format: parsed.format,
			fileName: fileName || dbPath,
			chats: parsed.chats.slice(0, 50).map((c) => ({ title: c.title, kind: c.kind, count: c.messages.length })),
			chatCount: parsed.chats.length,
			messageCount: parsed.chats.reduce((s, c) => s + c.messages.length, 0),
			memoryCount: (parsed.memories ?? []).length,
			speakers: list,
			estimate: { persons: persons.length, calls: Math.min(DEFAULT_MAX_CALLS, persons.reduce((s, p) => s + p.chunks.length, 0)) },
			warnings: parsed.warnings ?? []
		};
	}

	state() {
		return this.job ?? getKv(this.db, 'import.last', null);
	}

	cancel() {
		this.controller?.abort();
	}

	/**
	 * 开始导入（后台跑，立刻返回）。
	 * @param {{previewId: string, selfKeys?: string[], mapping?: Record<string,string>, maxCalls?: number}} opts
	 */
	start({ previewId, selfKeys = [], mapping = {}, maxCalls = DEFAULT_MAX_CALLS }) {
		if (this.job?.status === 'running') throw new Error('已经在导入了，等这一份完成');
		const pv = this.previews.get(String(previewId));
		if (!pv) throw new Error('预览过期了，重新选一下文件');
		this.previews.delete(String(previewId));
		const persons = capChunks(buildPersonChunks(pv.parsed, { selfKeys, mapping, personaName: this.personaName() }),
			Math.min(500, Math.max(0, Math.floor(Number(maxCalls)) || DEFAULT_MAX_CALLS)));
		const direct = pv.parsed.memories ?? [];
		this.job = {
			id: previewId, status: 'running', fileName: pv.fileName, format: pv.parsed.format, startedAt: Date.now(), finishedAt: null,
			total: persons.reduce((s, p) => s + p.chunks.length, 0), done: 0, inserted: 0, duplicates: 0, direct: 0,
			current: '', persons: persons.map((p) => ({ qq: p.qq, name: p.name, inserted: 0 })), errors: []
		};
		this.controller = new AbortController();
		void this.run(persons, direct, pv.fileName, this.controller.signal).catch((error) => {
			this.job.status = 'error';
			this.job.errors.push(String(error instanceof Error ? error.message : error));
		}).finally(() => {
			this.job.finishedAt = Date.now();
			if (this.job.status === 'running') this.job.status = this.controller?.signal.aborted ? 'cancelled' : 'done';
			setKv(this.db, 'import.last', this.job);
		});
		return this.job;
	}

	async run(persons, direct, fileName, signal) {
		const master = String(this.masterQq?.() ?? '');
		if (direct.length > 0) {
			const r = importMemories({ db: this.db, clock: this.clock, worker: this.worker, items: direct, masterQqUin: master });
			this.job.direct = r.inserted;
			this.job.duplicates += r.duplicates;
		}
		const persona = this.personaName();
		for (const [pi, p] of persons.entries()) {
			if (signal.aborted) return;
			const nowMs = this.clock.now();
			const cid = ensurePerson(this.db, p.qq, p.name, nowMs, master);
			const ownerId = `user:${cid}`;
			this.job.current = p.name;
			const existing = this.db.prepare("SELECT content FROM memory WHERE owner_id = ? AND status = 'active'").all(ownerId).map((r) => tokenSet(r.content));
			const exact = this.db.prepare("SELECT 1 FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND content = ? AND status = 'active' LIMIT 1");
			const insert = this.db.prepare(`
				INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
				                    importance, emotion, source_session, created_at, updated_at, status, evidence)
				VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, 'history-import', ?, ?, 'active', ?)
			`);
			let best = -1;
			let insertedForPerson = 0;
			for (const chunk of p.chunks) {
				if (signal.aborted) return;
				let text = null;
				try {
					text = await this.callLlm(extractPrompt({ personaName: persona, name: p.name, chunk }), { signal, maxTokens: 1200 });
				} catch { text = null; }
				if (signal.aborted) return;
				this.job.done++;
				if (text === null) {
					if (this.job.done === 1) throw new Error('没有可用的模型（先在 DSH 里配好模型再导入）');
					this.job.errors.push(`${p.name}：这一段模型没回`);
					continue;
				}
				let parsed = null;
				try { parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch { parsed = null; }
				if (parsed === null) { this.job.errors.push(`${p.name}：这一段模型回的不是 JSON`); continue; }
				const rank = STAGES.indexOf(parsed.relation);
				if (rank > best) best = rank;
				const range = [fmtDay(chunk.startMs), fmtDay(chunk.endMs)].filter(Boolean);
				const evidence = `导入：${fileName} · ${chunk.chatTitle}${range.length ? ` · ${range[0]}${range[1] !== range[0] ? ` ~ ${range[1]}` : ''}` : ''}`;
				const createdAt = Math.min(nowMs, Number.isFinite(chunk.endMs) ? chunk.endMs : nowMs);
				const channel = chunk.kind === 'group' ? 'qq-group' : 'qq-private';
				const queued = [];
				this.db.exec('BEGIN');
				try {
					for (const mem of (Array.isArray(parsed.memories) ? parsed.memories : []).slice(0, 8)) {
						const content = String(mem?.content ?? '').trim().slice(0, 300);
						if ([...content].length < 4) continue;
						const tokens = tokenSet(content);
						if (exact.get(ownerId, content) !== undefined || existing.some((t) => jaccard(t, tokens) >= 0.8)) { this.job.duplicates++; continue; }
						const kind = ['fact', 'event', 'feeling'].includes(mem.kind) ? mem.kind : 'fact';
						const importance = Math.min(5, Math.max(1, Math.round(Number(mem.importance ?? 2)) || 2));
						const emotion = Math.min(2, Math.max(-2, Math.round(Number(mem.emotion ?? 0)) || 0));
						const r = insert.run(ownerId, channel, chunk.channelId || `private:${p.qq}`, kind, content, tokenizeForBm25(content),
							importance, emotion, createdAt, createdAt, evidence);
						existing.push(tokens);
						queued.push([Number(r.lastInsertRowid), content]);
					}
					this.db.exec('COMMIT');
				} catch (error) {
					this.db.exec('ROLLBACK');
					throw error;
				}
				for (const [id, content] of queued) this.worker.enqueueRealtime(id, content);
				insertedForPerson += queued.length;
				this.job.inserted += queued.length;
				this.job.persons[pi].inserted = insertedForPerson;
			}
			// 关系只升不降；互动次数累加；第一次见面的时间往前挪
			const person = this.db.prepare('SELECT relation_stage, first_seen_at FROM person WHERE canonical_id = ?').get(cid);
			if (person) {
				const next = best > STAGES.indexOf(person.relation_stage) ? STAGES[best] : person.relation_stage;
				this.db.prepare('UPDATE person SET relation_stage = ?, interaction_count = interaction_count + ?, first_seen_at = MIN(first_seen_at, ?) WHERE canonical_id = ?')
					.run(next, p.messageCount, Number.isFinite(p.firstMs) ? p.firstMs : person.first_seen_at, cid);
				// 升了阶段：好感跟上（否则下次结算又按好感降回去）
				if (next !== person.relation_stage) this.db.prepare('UPDATE person SET affinity = MAX(COALESCE(affinity, 0), ?), affinity_at = ? WHERE canonical_id = ?').run(stageBase(next), this.clock.now(), cid);
			}
			if (insertedForPerson >= 3 && this.life !== null && !signal.aborted) {
				try { await this.life.runDream(ownerId); } catch { /* 印象下次 Dream 再写 */ }
			}
		}
		this.job.current = '';
		this.log('info', `[fish-soul] 聊天记录导入完成：${fileName}，新记忆 ${this.job.inserted} 条（直接导入 ${this.job.direct} 条）`);
	}
}
