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
 *
 * 断点续传：开始导入时把整份计划（每人要提炼的分段）和进度写进 import_job 表，每提炼完一段就和新记忆同一个事务记下进度；
 * DSH 重启 / 崩溃后这份任务标成「中断」，设置页点「继续」从下一段接着跑，已经写进去的不会重复。
 * 较早的聊天：每人最近 12 段逐段提炼；更早的部分按时间切成至多 4 个时间段，每段抽样压到一段的长度，
 * 让模型写「那段时间」的总结（调用额度不够时先砍这些）。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { setKv, getKv } from './db.js';
import { tokenizeForBm25 } from './segment.js';
import { stageBase, jaccard } from './soul-memory.js';
import { ensurePerson, importMemories } from './importer.js';
import { pad2 } from './time-util.js';

const STAGES = ['stranger', 'acquaintance', 'friend', 'close'];
const CHUNK_CHARS = 3500;
const CHUNKS_PER_PERSON = 12;
const DEFAULT_MAX_CALLS = 150;
const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_MESSAGES = 200_000;
const MAX_ERAS = 4;
const MAX_JOB_ERRORS = 50;
const MAX_MISSES = 3;
const JOB_KEEP = 20;
const JOB_PLAN_TTL_MS = 30 * 24 * 3600_000;

export const IMPORT_JOB_SQL = `
CREATE TABLE IF NOT EXISTS import_job (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  file_name   TEXT NOT NULL DEFAULT '',
  file_hash   TEXT NOT NULL DEFAULT '',
  format      TEXT NOT NULL DEFAULT '',
  plan        TEXT NOT NULL,
  progress    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_job_updated ON import_job(updated_at);
`;

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
		const t = Date.parse(`${m[1]}-${pad2(m[2])}-${pad2(m[3])}T${pad2(m[4])}:${m[5]}:${m[6] ?? '00'}+08:00`);
		return Number.isFinite(t) ? t : null;
	}
	// SillyTavern 的 "January 1, 2024 12:00am"
	const fixed = s.replace(/(\d)(am|pm)$/i, '$1 $2');
	const t = Date.parse(fixed);
	return Number.isFinite(t) ? t : null;
}

/** "张三(123456)" / "张三<123456@qq.com>" / "张三" → { name, qq } */
function splitSender(raw) {
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
		// 最近的几段逐段提炼（越近越要紧）；更早的按时间段抽样总结
		const kept = chunks.slice(-CHUNKS_PER_PERSON);
		const dropped = chunks.slice(0, Math.max(0, chunks.length - CHUNKS_PER_PERSON));
		const eras = buildEras(dropped);
		out.push({
			qq: p.qq, name: p.name, messageCount: p.messageCount, firstMs: p.firstMs,
			chunks: [...eras, ...kept.map(({ chat, ...rest }) => rest)],
			// 超出每人段数上限、这次不会交给模型的较早部分（预览里要明说，别让人以为全导进去了）
			dropped: { chunks: dropped.length, chars: dropped.reduce((n, c) => n + c.text.length, 0), fromMs: dropped[0]?.startMs ?? null, toMs: dropped.at(-1)?.endMs ?? null }
		});
	}
	return out.sort((a, b) => b.messageCount - a.messageCount);
}

/**
 * 超出每人段数上限的较早分段 → 至多 MAX_ERAS 个时间段：相邻的段按顺序均分成几组，
 * 每组的聊天行均匀抽样到一段的长度（CHUNK_CHARS），交给模型写「那段时间」的总结。
 */
export function buildEras(dropped, maxEras = MAX_ERAS) {
	if (dropped.length === 0) return [];
	const n = Math.min(maxEras, dropped.length);
	const eras = [];
	for (let g = 0; g < n; g++) {
		const part = dropped.slice(Math.floor((g * dropped.length) / n), Math.floor(((g + 1) * dropped.length) / n));
		if (part.length === 0) continue;
		const lines = part.flatMap((c) => c.text.split('\n').filter(Boolean));
		const total = lines.reduce((s, l) => s + l.length + 1, 0);
		let text = lines.join('\n');
		if (total > CHUNK_CHARS) {
			// 均匀抽样：按平均行长估算能放几行，等间隔取，保持时间顺序
			const avg = total / lines.length;
			const want = Math.max(1, Math.floor(CHUNK_CHARS / avg));
			const picked = [];
			let size = 0;
			for (let i = 0; i < want; i++) {
				const l = lines[Math.floor((i * lines.length) / want)];
				if (size + l.length + 1 > CHUNK_CHARS) {
					// 单独一行就超过一段（几千字的长消息）：截一截也要放进去，别交给模型一段空白
					if (picked.length === 0) { picked.push(l.slice(0, CHUNK_CHARS - 1)); size = CHUNK_CHARS; }
					break;
				}
				picked.push(l);
				size += l.length + 1;
			}
			text = picked.join('\n');
		}
		if (text.trim() === '') continue; // 没有内容的时间段不花模型调用
		const titles = [...new Set(part.map((c) => c.chatTitle))];
		eras.push({
			era: true, chatTitle: titles.slice(0, 3).join('、'), kind: part[0].kind, channelId: part[0].channelId,
			startMs: part[0].startMs, endMs: part.at(-1).endMs, text: `${text}\n`,
			sourceChunks: part.length, sourceChars: part.reduce((s, c) => s + c.text.length, 0), sampled: total > CHUNK_CHARS
		});
	}
	return eras;
}

/** 总调用次数上限：轮流从每个人最近的一段往前取（时间段总结排在最前，额度不够先砍它们）。 */
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

/** 预览用：这次会导入多少、有多少较早的聊天不会交给模型。 */
export function coverageOf(persons) {
	const truncated = persons.filter((p) => (p.dropped?.chunks ?? 0) > 0);
	const froms = truncated.map((p) => p.dropped.fromMs).filter((t) => t !== null);
	return {
		persons: persons.length,
		chunksPerPerson: CHUNKS_PER_PERSON,
		chunkChars: CHUNK_CHARS,
		keptChunks: persons.reduce((n, p) => n + p.chunks.length, 0),
		eraChunks: persons.reduce((n, p) => n + p.chunks.filter((c) => c.era).length, 0),
		maxEras: MAX_ERAS,
		droppedChunks: truncated.reduce((n, p) => n + p.dropped.chunks, 0),
		droppedChars: truncated.reduce((n, p) => n + p.dropped.chars, 0),
		droppedFromMs: froms.length > 0 ? Math.min(...froms) : null,
		truncatedPersons: truncated.length,
		topTruncated: [...truncated].sort((a, b) => b.dropped.chunks - a.dropped.chunks).slice(0, 5)
			.map((p) => ({ name: p.name, qq: p.qq, droppedChunks: p.dropped.chunks, keptFromMs: p.chunks.find((c) => !c.era)?.startMs ?? null }))
	};
}

function extractPrompt({ personaName, name, chunk }) {
	const range = [fmtDay(chunk.startMs), fmtDay(chunk.endMs)].filter(Boolean);
	const when = range.length === 0 ? '' : range[0] === range[1] ? `，${range[0]}` : `，${range[0]} ~ ${range[1]}`;
	if (chunk.era) {
		return `你是「${personaName}」。下面是${chunk.kind === 'group' ? `群聊「${chunk.chatTitle}」里「${name}」说的话（和你接的话）` : `你和「${name}」过去的私聊记录`}${when}` +
			`${chunk.sampled ? `的抽样（这段时间一共约 ${chunk.sourceChars} 字，这里只截了一部分）` : ''}。这是比较早的一段时间。\n` +
			`总结这段时间里关于「${name}」值得长期记住的东西：TA 那时候在做什么、经历了什么、你们关系怎么样、发生过的大事。` +
			'每条用第三人称写成一句完整的话，写明是哪段时间（比如"2023 年上半年"），只写反复出现或明确说过的，别从零星几句推测，没有就空数组。\n' +
			'只输出 JSON：{"memories":[{"content":"...","kind":"fact|event|feeling","importance":1到4,"emotion":-2到2}],' +
			'"relation":"stranger|acquaintance|friend|close"}，最多 4 条。\n聊天记录：\n' + chunk.text;
	}
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
		this.running = null;
		db.exec(IMPORT_JOB_SQL);
		// 上次没跑完就退出了（重启 / 崩溃）：标成中断，等主人点「继续」
		const n = db.prepare("UPDATE import_job SET status = 'interrupted', updated_at = ? WHERE status = 'running'").run(Date.now()).changes;
		if (n > 0) this.log('info', `[fish-soul] 有 ${n} 份聊天记录导入上次没跑完，设置页可以继续`);
		this.pruneJobs();
	}

	/**
	 * import_job 清理：plan 里存着整份分段原文，不能一直攒。
	 * 导完 / 放弃的任务马上清掉 plan（只留进度，用来提示"这份导入过"）；没跑完的超过 30 天也清（不能再继续）；
	 * 总共只留最近 JOB_KEEP 份。
	 */
	pruneJobs(now = Date.now()) {
		try {
			this.db.prepare("UPDATE import_job SET plan = '' WHERE plan != '' AND (status IN ('done', 'discarded') OR updated_at < ?) AND status != 'running'").run(now - JOB_PLAN_TTL_MS);
			this.db.prepare("UPDATE import_job SET status = 'discarded' WHERE plan = '' AND status IN ('interrupted', 'cancelled', 'error')").run();
			this.db.prepare(`DELETE FROM import_job WHERE status != 'running' AND id NOT IN (
				SELECT id FROM import_job ORDER BY updated_at DESC LIMIT ${JOB_KEEP})`).run();
		} catch (error) {
			this.log('warn', `[fish-soul] 清理导入任务记录失败：${String(error instanceof Error ? error.message : error)}`);
		}
	}

	/** 文件指纹：同一份文件再导入时提醒一下。 */
	static fingerprint({ text, dbPath }) {
		if (String(dbPath ?? '').trim() !== '') {
			let st = null;
			try { st = statSync(String(dbPath).trim()); } catch { /* 读不到就只用路径 */ }
			return createHash('sha1').update(`db:${String(dbPath).trim()}:${st?.size ?? ''}:${Math.floor(st?.mtimeMs ?? 0)}`).digest('hex');
		}
		return createHash('sha1').update(String(text ?? '')).digest('hex');
	}

	/** 解析上传的文本 / 本机数据库路径 → 预览（解析结果暂存 30 分钟，start 时用 previewId 取）。 */
	preview({ text, fileName = '', dbPath = '' }) {
		let parsed;
		if (String(dbPath).trim() !== '') parsed = readMaiBotDb(String(dbPath).trim());
		else parsed = parseHistoryText(text, { fileName });
		if (parsed.format === 'unknown') throw new Error('看不出这是什么格式（支持 QQ 导出的 txt、SillyTavern 的 jsonl、消息 / 记忆 JSON、麦麦的数据库）');
		const fileHash = HistoryImporter.fingerprint({ text, dbPath });
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
		this.previews.set(id, { parsed, fileName: fileName || dbPath, fileHash, at: Date.now() });
		for (const [k, v] of this.previews) if (Date.now() - v.at > PREVIEW_TTL_MS) this.previews.delete(k);
		const mapping = Object.fromEntries(list.filter((s) => s.suggestQq).map((s) => [s.key, s.suggestQq]));
		const persons = buildPersonChunks(parsed, { selfKeys: list.filter((s) => s.self).map((s) => s.key), mapping, personaName: this.personaName() });
		const prev = this.db.prepare("SELECT id, status, progress, updated_at FROM import_job WHERE file_hash = ? AND status != 'discarded' ORDER BY updated_at DESC LIMIT 1").get(fileHash);
		const warnings = [...(parsed.warnings ?? [])];
		let previous = null;
		if (prev) {
			const pg = safeJson(prev.progress) ?? {};
			previous = { id: prev.id, status: prev.status, done: pg.done ?? 0, total: pg.total ?? 0, inserted: pg.inserted ?? 0, at: prev.updated_at };
			warnings.push(prev.status === 'done' ? '这份文件之前导入过（重复的记忆会自动跳过，但还是会花模型调用）'
				: `这份文件上次导入到 ${previous.done}/${previous.total} 段没跑完，可以直接点上面的「继续」`);
		}
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
			coverage: coverageOf(persons),
			previous,
			warnings
		};
	}

	/** 当前 / 最近一份任务（带能不能继续）。 */
	state() {
		if (this.job?.status === 'running') return this.job;
		const row = this.db.prepare("SELECT id, status, progress FROM import_job WHERE status != 'discarded' ORDER BY updated_at DESC LIMIT 1").get();
		if (row) {
			const job = { ...(safeJson(row.progress) ?? {}), id: row.id, status: row.status };
			job.resumable = ['interrupted', 'cancelled', 'error'].includes(row.status) && (job.done ?? 0) < (job.total ?? 0);
			return job;
		}
		return this.job ?? getKv(this.db, 'import.last', null);
	}

	cancel() {
		this.controller?.abort();
	}

	/** 等后台任务跑完（测试 / 退出用）。 */
	async idle() {
		await this.running?.catch(() => {});
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
		const plan = {
			fileName: pv.fileName,
			direct: pv.parsed.memories ?? [],
			persons: persons.map((p) => ({ qq: p.qq, name: p.name, messageCount: p.messageCount, firstMs: p.firstMs, chunks: p.chunks }))
		};
		const job = {
			id: String(previewId), status: 'running', fileName: pv.fileName, format: pv.parsed.format, startedAt: Date.now(), finishedAt: null,
			total: persons.reduce((s, p) => s + p.chunks.length, 0), done: 0, inserted: 0, duplicates: 0, direct: 0, directDone: false,
			eras: persons.reduce((s, p) => s + p.chunks.filter((c) => c.era).length, 0),
			cursor: { pi: 0, ci: 0 }, current: '',
			persons: persons.map((p) => ({ qq: p.qq, name: p.name, inserted: 0, best: -1, finalized: false })), errors: []
		};
		const now = Date.now();
		this.db.prepare('INSERT OR REPLACE INTO import_job (id, status, file_name, file_hash, format, plan, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.run(job.id, 'running', pv.fileName, pv.fileHash ?? '', job.format, JSON.stringify(plan), JSON.stringify(job), now, now);
		return this.launch(job, plan);
	}

	/** 继续一份中断 / 停止 / 出错的任务（从下一段接着跑）。 */
	resume(id) {
		if (this.job?.status === 'running') throw new Error('已经在导入了，等这一份完成');
		const row = id
			? this.db.prepare('SELECT * FROM import_job WHERE id = ?').get(String(id))
			: this.db.prepare("SELECT * FROM import_job WHERE status IN ('interrupted', 'cancelled', 'error') ORDER BY updated_at DESC LIMIT 1").get();
		if (!row) throw new Error('没有可以继续的导入');
		if (!['interrupted', 'cancelled', 'error'].includes(row.status)) throw new Error(row.status === 'done' ? '这份已经导完了' : '这份不能继续');
		const plan = safeJson(row.plan);
		const job = safeJson(row.progress);
		if (!plan || !job) throw new Error('这份导入的记录坏了，只能重新导');
		Object.assign(job, { status: 'running', finishedAt: null, resumedAt: Date.now(), resumes: (job.resumes ?? 0) + 1 });
		this.saveProgress(job);
		this.log('info', `[fish-soul] 继续导入 ${job.fileName}：从第 ${job.done + 1}/${job.total} 段接着跑`);
		return this.launch(job, plan);
	}

	/** 放弃一份没跑完的任务（不再提示继续；已写进去的记忆保留）。 */
	discard(id) {
		if (this.job?.status === 'running' && this.job.id === String(id)) throw new Error('正在跑，先停止');
		const r = this.db.prepare("UPDATE import_job SET status = 'discarded', plan = '', updated_at = ? WHERE id = ? AND status != 'running'").run(Date.now(), String(id));
		return r.changes > 0;
	}

	launch(job, plan) {
		this.job = job;
		this.controller = new AbortController();
		const signal = this.controller.signal;
		this.running = this.run(plan, signal).catch((error) => {
			job.status = 'error';
			pushError(job, String(error instanceof Error ? error.message : error));
		}).finally(() => {
			job.finishedAt = Date.now();
			job.current = '';
			if (job.status === 'running') job.status = signal.aborted ? 'cancelled' : 'done';
			this.saveProgress(job);
			setKv(this.db, 'import.last', job);
			this.running = null;
			this.pruneJobs();
		});
		return job;
	}

	saveProgress(job) {
		this.db.prepare('UPDATE import_job SET status = ?, progress = ?, updated_at = ? WHERE id = ?').run(job.status, JSON.stringify(job), Date.now(), job.id);
	}

	async run(plan, signal) {
		const job = this.job;
		const master = String(this.masterQq?.() ?? '');
		const fileName = plan.fileName;
		if (!job.directDone) {
			if (plan.direct.length > 0) {
				const r = importMemories({ db: this.db, clock: this.clock, worker: this.worker, items: plan.direct, masterQqUin: master });
				job.direct = r.inserted;
				job.duplicates += r.duplicates;
			}
			job.directDone = true;
			this.saveProgress(job);
		}
		const persona = this.personaName();
		let calls = 0;
		let misses = 0; // 连续几段模型没回
		for (let pi = job.cursor.pi; pi < plan.persons.length; pi++) {
			if (signal.aborted) return;
			const p = plan.persons[pi];
			const jp = job.persons[pi];
			const nowMs = this.clock.now();
			const cid = ensurePerson(this.db, p.qq, p.name, nowMs, master);
			const ownerId = `user:${cid}`;
			job.current = p.name;
			const existing = this.db.prepare("SELECT content FROM memory WHERE owner_id = ? AND status = 'active'").all(ownerId).map((r) => tokenSet(r.content));
			const exact = this.db.prepare("SELECT 1 FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND content = ? AND status = 'active' LIMIT 1");
			const insert = this.db.prepare(`
				INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
				                    importance, emotion, source_session, created_at, updated_at, status, evidence)
				VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, 'history-import', ?, ?, 'active', ?)
			`);
			const startCi = pi === job.cursor.pi ? job.cursor.ci : 0;
			for (let ci = startCi; ci < p.chunks.length; ci++) {
				if (signal.aborted) return;
				const chunk = p.chunks[ci];
				let text = null;
				try {
					text = await this.callLlm(extractPrompt({ personaName: persona, name: p.name, chunk }), { signal, maxTokens: 1200 });
				} catch { text = null; }
				if (signal.aborted) return;
				calls++;
				misses = text === null ? misses + 1 : 0;
				// 这次（新开始 / 继续）的第一段就没回，或者连着 3 段没回：模型多半不可用。停在这一段（不算完成），
				// 任务标成出错、可以「继续」；别一路空跑把整份标成「完成」
				if (text === null && (calls === 1 || misses >= MAX_MISSES)) {
					throw new Error(calls === 1 ? '没有可用的模型（先在 DSH 里配好模型再导入 / 继续）' : `模型连着 ${misses} 段没回，先停下（配好模型后可以继续）`);
				}
				const queued = [];
				let parsed = null;
				if (text === null) pushError(job, `${p.name}：这一段模型没回`);
				else {
					try { parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch { parsed = null; }
					if (parsed === null) pushError(job, `${p.name}：这一段模型回的不是 JSON`);
				}
				// 这一段的新记忆和进度同一个事务：中途退出，要么都在、要么都不在，继续时不会重复
				this.db.exec('BEGIN');
				try {
					if (parsed !== null) {
						const rank = STAGES.indexOf(parsed.relation);
						if (rank > jp.best) jp.best = rank;
						const range = [fmtDay(chunk.startMs), fmtDay(chunk.endMs)].filter(Boolean);
						const evidence = `导入${chunk.era ? '（时间段总结）' : ''}：${fileName} · ${chunk.chatTitle}${range.length ? ` · ${range[0]}${range[1] !== range[0] ? ` ~ ${range[1]}` : ''}` : ''}`;
						const createdAt = Math.min(nowMs, Number.isFinite(chunk.endMs) ? chunk.endMs : nowMs);
						const channel = chunk.kind === 'group' ? 'qq-group' : 'qq-private';
						for (const mem of (Array.isArray(parsed.memories) ? parsed.memories : []).slice(0, chunk.era ? 4 : 8)) {
							const content = String(mem?.content ?? '').trim().slice(0, 300);
							if ([...content].length < 4) continue;
							const tokens = tokenSet(content);
							if (exact.get(ownerId, content) !== undefined || existing.some((t) => jaccard(t, tokens) >= 0.8)) { job.duplicates++; continue; }
							const kind = ['fact', 'event', 'feeling'].includes(mem.kind) ? mem.kind : 'fact';
							const importance = Math.min(chunk.era ? 4 : 5, Math.max(1, Math.round(Number(mem.importance ?? 2)) || 2));
							const emotion = Math.min(2, Math.max(-2, Math.round(Number(mem.emotion ?? 0)) || 0));
							const r = insert.run(ownerId, channel, chunk.channelId || `private:${p.qq}`, kind, content, tokenizeForBm25(content),
								importance, emotion, createdAt, createdAt, evidence);
							existing.push(tokens);
							queued.push([Number(r.lastInsertRowid), content]);
						}
					}
					job.done++;
					job.inserted += queued.length;
					jp.inserted += queued.length;
					job.cursor = ci + 1 < p.chunks.length ? { pi, ci: ci + 1 } : { pi: pi + 1, ci: 0 };
					this.saveProgress(job);
					this.db.exec('COMMIT');
				} catch (error) {
					this.db.exec('ROLLBACK');
					throw error;
				}
				for (const [id, content] of queued) this.worker.enqueueRealtime(id, content);
			}
			if (p.chunks.length === 0) job.cursor = { pi: pi + 1, ci: 0 };
			// 关系只升不降；互动次数累加（每人只加一次，续传不重复）；第一次见面的时间往前挪
			if (!jp.finalized) {
				const person = this.db.prepare('SELECT relation_stage, first_seen_at FROM person WHERE canonical_id = ?').get(cid);
				if (person) {
					const next = jp.best > STAGES.indexOf(person.relation_stage) ? STAGES[jp.best] : person.relation_stage;
					this.db.prepare('UPDATE person SET relation_stage = ?, interaction_count = interaction_count + ?, first_seen_at = MIN(first_seen_at, ?) WHERE canonical_id = ?')
						.run(next, p.messageCount, Number.isFinite(p.firstMs) ? p.firstMs : person.first_seen_at, cid);
					// 升了阶段：好感跟上（否则下次结算又按好感降回去）
					if (next !== person.relation_stage) this.db.prepare('UPDATE person SET affinity = MAX(COALESCE(affinity, 0), ?), affinity_at = ? WHERE canonical_id = ?').run(stageBase(next), this.clock.now(), cid);
				}
				jp.finalized = true;
				this.saveProgress(job);
			}
			if (jp.inserted >= 3 && this.life !== null && !signal.aborted && !jp.dreamed) {
				try { await this.life.runDream(ownerId); jp.dreamed = true; } catch { /* 印象下次 Dream 再写 */ }
			}
		}
		job.current = '';
		this.log('info', `[fish-soul] 聊天记录导入完成：${fileName}，新记忆 ${job.inserted} 条（直接导入 ${job.direct} 条）`);
	}
}

function safeJson(raw) {
	try { return JSON.parse(raw); } catch { return null; }
}

function pushError(job, msg) {
	job.errors.push(msg);
	if (job.errors.length > MAX_JOB_ERRORS) job.errors.splice(0, job.errors.length - MAX_JOB_ERRORS);
}
