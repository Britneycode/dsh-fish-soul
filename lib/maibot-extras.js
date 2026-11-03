/**
 * maibot-extras.js —— 从麦麦（MaiBot）的数据库搬表情包、表达方式和黑话。
 *
 * 两代表结构都认（按实际有的表和列探测，不认的跳过并说明）：
 *  - 旧版（Peewee，0.10~0.12）：emoji / expression / jargon，会话表 chat_streams(stream_id → group_id / user_id)；
 *  - 新版（SQLModel，1.x）：images(image_type = emoji) / expressions / jargons，会话表 chat_sessions(session_id → …)。
 * 去向：
 *  - 表情包 → 工作区 _stickers/（按使用次数挑前 N 张；被禁用、未注册、文件已不在的跳过；同一张图不重复存）；
 *  - 表达方式（situation / style / count）→ 对应聊天的「说话方式」；
 *  - 黑话（只要麦麦判定是黑话、且有意思的）→ 对应聊天的「梗」；
 *  - 对不上具体 QQ 聊天的（全局的、会话表里查不到的）→ slang.global，所有 QQ 聊天都能用。
 * 只读打开麦麦的库，不改它。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { GLOBAL_ID } from './slang.js';
import { sniffImage as sniffImageKind } from './imageconv.js';

const MAX_EMOJI_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_EMOJIS = 30;

/** 看文件头猜图片类型（magic bytes 逻辑与 imageconv 共用一套，这里把短名映射回 MIME）。 */
export function sniffImage(bytes) {
	const kind = sniffImageKind(bytes);
	return kind ? `image/${kind}` : null;
}

/** 表情的名字：麦麦旧版有 emotion（逗号分隔的情绪词），新版只有描述 → 取第一个词 / 描述开头。 */
export function emojiName(emotion, description) {
	const first = String(emotion ?? '').split(/[,，、;；\s]+/).map((x) => x.trim()).find(Boolean);
	if (first) return first.slice(0, 12);
	const d = String(description ?? '').replace(/^(这是|这个是?|是)?(一张|一个|一幅)?(表情包|表情|图片|图)?[，,：:\s]*/, '').split(/[，,。.！!？?；;：:\n]/)[0].trim();
	return d.slice(0, 12) || '表情';
}

/** 会话 id（stream_id / session_id）→ channelId（group:群号 / private:QQ 号）；不是 QQ 的 → null。 */
function sessionMap(db, tables, colsOf) {
	const map = new Map();
	const table = tables.has('chat_sessions') ? 'chat_sessions' : tables.has('chat_streams') ? 'chat_streams' : null;
	if (table === null) return map;
	const cols = colsOf(table);
	const idCol = cols.has('session_id') ? 'session_id' : cols.has('stream_id') ? 'stream_id' : null;
	if (idCol === null) return map;
	const sel = [idCol, ...['group_id', 'user_id', 'platform', 'group_platform'].filter((c) => cols.has(c))];
	for (const r of db.prepare(`SELECT ${sel.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all()) {
		const platform = String(r.group_platform || r.platform || 'qq').toLowerCase();
		if (platform !== 'qq') { map.set(String(r[idCol]), null); continue; }
		const g = String(r.group_id ?? '').trim();
		const u = String(r.user_id ?? '').trim();
		map.set(String(r[idCol]), g !== '' ? `group:${g}` : u !== '' ? `private:${u}` : null);
	}
	return map;
}

const truthy = (v) => v === 1 || v === true || v === '1' || String(v).toLowerCase() === 'true';

/**
 * 读麦麦库里的表情 / 表达方式 / 黑话（只读）。
 * @returns {{emojis: Array<{path:string|null, name:string, description:string, usage:number}>,
 *   expressions: Array<{situation:string, style:string, count:number, channelId:string}>,
 *   jargons: Array<{term:string, meaning:string, count:number, channelId:string}>, warnings: string[], schema: string}}
 */
export function readMaiBotExtras(dbPath) {
	const path = String(dbPath ?? '').trim();
	if (path === '' || !existsSync(path)) throw new Error('找不到这个数据库文件');
	const db = new DatabaseSync(path, { readOnly: true });
	const warnings = [];
	try {
		const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
		const colsOf = (t) => new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((r) => r.name));
		const sessions = sessionMap(db, tables, colsOf);
		let unmapped = 0; let otherPlatform = 0;
		const channelOf = (sid, global = false) => {
			if (global || sid === null || sid === undefined || String(sid) === '') return GLOBAL_ID;
			if (!sessions.has(String(sid))) { unmapped++; return GLOBAL_ID; }
			const c = sessions.get(String(sid));
			if (c === null) { otherPlatform++; return null; }
			return c;
		};
		const schema = tables.has('images') || tables.has('expressions') || tables.has('jargons') ? 'new' : 'old';

		// ── 表情包 ──
		const emojis = [];
		const roots = [dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))];
		const resolve = (p) => {
			const s = String(p ?? '').trim();
			if (s === '') return null;
			const cands = isAbsolute(s) ? [s] : roots.map((r) => join(r, s));
			return cands.find((c) => { try { return statSync(c).isFile(); } catch { return false; } }) ?? null;
		};
		const eTable = tables.has('emoji') ? 'emoji' : tables.has('images') ? 'images' : null;
		if (eTable !== null) {
			const c = colsOf(eTable);
			if (c.has('full_path')) {
				const where = [
					eTable === 'images' && c.has('image_type') ? "LOWER(image_type) = 'emoji'" : null,
					c.has('is_banned') ? '(is_banned IS NULL OR is_banned = 0)' : null,
					c.has('is_registered') ? 'is_registered = 1' : null,
					c.has('no_file_flag') ? '(no_file_flag IS NULL OR no_file_flag = 0)' : null
				].filter(Boolean);
				const usage = c.has('usage_count') ? 'usage_count' : c.has('query_count') ? 'query_count' : '0';
				const rows = db.prepare(`SELECT full_path, ${c.has('description') ? 'description' : "''"} AS d, ${c.has('emotion') ? 'emotion' : "''"} AS e, ${usage} AS u
					FROM "${eTable}" ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${usage} DESC LIMIT 1000`).all();
				let missing = 0;
				for (const r of rows) {
					const file = resolve(r.full_path);
					if (file === null) { missing++; continue; }
					emojis.push({ path: file, name: emojiName(r.e, r.d), description: String(r.d ?? '').slice(0, 60), usage: Number(r.u) || 0 });
				}
				if (missing > 0) warnings.push(`${missing} 张表情的图片文件找不到（麦麦的数据库要和它的 data 目录在一起）`);
			}
		}

		// ── 表达方式 ──
		const expressions = [];
		const xTable = tables.has('expression') ? 'expression' : tables.has('expressions') ? 'expressions' : null;
		if (xTable !== null) {
			const c = colsOf(xTable);
			if (c.has('situation') && c.has('style')) {
				const sid = c.has('chat_id') ? 'chat_id' : c.has('session_id') ? 'session_id' : null;
				const where = [c.has('rejected') ? '(rejected IS NULL OR rejected = 0)' : null].filter(Boolean);
				const rows = db.prepare(`SELECT situation, style, ${c.has('count') ? 'count' : '1'} AS n, ${sid ? `"${sid}"` : 'NULL'} AS s
					FROM "${xTable}" ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${c.has('count') ? 'count' : 'rowid'} DESC LIMIT 5000`).all();
				for (const r of rows) {
					const channelId = channelOf(r.s);
					if (channelId === null) continue;
					expressions.push({ situation: String(r.situation ?? ''), style: String(r.style ?? ''), count: Number(r.n) || 1, channelId });
				}
			}
		}

		// ── 黑话 ──
		const jargons = [];
		const jTable = tables.has('jargon') ? 'jargon' : tables.has('jargons') ? 'jargons' : null;
		if (jTable !== null) {
			const c = colsOf(jTable);
			if (c.has('content') && c.has('meaning')) {
				const where = [c.has('is_jargon') ? 'is_jargon = 1' : null, "meaning IS NOT NULL AND TRIM(meaning) != ''"].filter(Boolean);
				const sel = ['content', 'meaning', c.has('count') ? 'count AS n' : '1 AS n', c.has('is_global') ? 'is_global AS g' : '0 AS g',
					c.has('chat_id') ? 'chat_id AS s' : 'NULL AS s', c.has('session_id_dict') ? 'session_id_dict AS sd' : 'NULL AS sd'];
				const rows = db.prepare(`SELECT ${sel.join(', ')} FROM "${jTable}" WHERE ${where.join(' AND ')} ORDER BY ${c.has('count') ? 'count' : 'rowid'} DESC LIMIT 5000`).all();
				for (const r of rows) {
					const base = { term: String(r.content ?? ''), meaning: String(r.meaning ?? ''), count: Number(r.n) || 1 };
					if (truthy(r.g)) { jargons.push({ ...base, channelId: GLOBAL_ID }); continue; }
					// 新版：session_id_dict = {"会话": 次数, …}；旧版：chat_id
					let sids = [];
					if (r.sd) { try { sids = Object.keys(JSON.parse(r.sd) ?? {}); } catch { sids = []; } }
					if (sids.length === 0) sids = [r.s];
					const seen = new Set();
					for (const s of sids) {
						const channelId = channelOf(s);
						if (channelId === null || seen.has(channelId)) continue;
						seen.add(channelId);
						jargons.push({ ...base, channelId });
					}
				}
			}
		}
		if (eTable === null && xTable === null && jTable === null) throw new Error('这个数据库里没有麦麦的表情包 / 表达方式 / 黑话表');
		if (unmapped > 0) warnings.push(`${unmapped} 条对不上具体聊天（会话表里查不到），放进「所有聊天」`);
		if (otherPlatform > 0) warnings.push(`跳过了 ${otherPlatform} 条不是 QQ 平台的`);
		return { emojis, expressions, jargons, warnings, schema };
	} finally {
		db.close();
	}
}

/** 预览：每类多少条、分到几个聊天、样例。 */
export function previewMaiBotExtras(dbPath, { titleOf = (c) => c } = {}) {
	const x = readMaiBotExtras(dbPath);
	const byChannel = new Map();
	for (const e of x.expressions) byChannel.set(e.channelId, { ...(byChannel.get(e.channelId) ?? { expressions: 0, jargons: 0 }), expressions: (byChannel.get(e.channelId)?.expressions ?? 0) + 1 });
	for (const j of x.jargons) byChannel.set(j.channelId, { ...(byChannel.get(j.channelId) ?? { expressions: 0, jargons: 0 }), jargons: (byChannel.get(j.channelId)?.jargons ?? 0) + 1 });
	return {
		schema: x.schema,
		emojis: { count: x.emojis.length, sample: x.emojis.slice(0, 8).map((e) => e.name) },
		expressions: { count: x.expressions.length, sample: x.expressions.slice(0, 5).map((e) => `当${e.situation}时，${e.style}`) },
		jargons: { count: x.jargons.length, sample: x.jargons.slice(0, 5).map((j) => `${j.term}：${j.meaning}`) },
		chats: [...byChannel.entries()].map(([channelId, n]) => ({ channelId, title: channelId === GLOBAL_ID ? '所有聊天' : titleOf(channelId), ...n }))
			.sort((a, b) => (b.expressions + b.jargons) - (a.expressions + a.jargons)).slice(0, 30),
		warnings: x.warnings
	};
}

/**
 * 导入。
 * @param {{dbPath: string, slang: {importEntries: Function}, stickers: {importImage: Function}|null, workspacePath: string|null,
 *   emojis?: boolean, expressions?: boolean, jargons?: boolean, maxEmojis?: number}} opts
 */
export function importMaiBotExtras({ dbPath, slang, stickers, workspacePath, emojis = true, expressions = true, jargons = true, maxEmojis = DEFAULT_MAX_EMOJIS }) {
	const x = readMaiBotExtras(dbPath);
	const out = { emojis: 0, emojiDup: 0, emojiFailed: 0, expressions: 0, terms: 0, skipped: 0, chats: 0, warnings: [...x.warnings] };
	if (expressions || jargons) {
		const per = new Map();
		const bucket = (c) => { if (!per.has(c)) per.set(c, { terms: [], expressions: [] }); return per.get(c); };
		if (expressions) for (const e of x.expressions) bucket(e.channelId).expressions.push(e);
		if (jargons) for (const j of x.jargons) bucket(j.channelId).terms.push(j);
		for (const [channelId, entries] of per) {
			const r = slang.importEntries(channelId, entries);
			out.expressions += r.expressions; out.terms += r.terms; out.skipped += r.skipped;
		}
		out.chats = per.size;
	}
	if (emojis) {
		if (!stickers || !workspacePath) out.warnings.push('表情包没导：QQ 工作区还没准备好（先连一次 QQ）');
		else {
			const cap = Math.min(100, Math.max(0, Math.floor(Number(maxEmojis)) || DEFAULT_MAX_EMOJIS));
			for (const e of x.emojis) {
				if (out.emojis >= cap) break;
				let bytes;
				try {
					if (statSync(e.path).size > MAX_EMOJI_BYTES) { out.emojiFailed++; continue; }
					bytes = readFileSync(e.path);
				} catch { out.emojiFailed++; continue; }
				const mediaType = sniffImage(bytes);
				if (mediaType === null) { out.emojiFailed++; continue; }
				const r = stickers.importImage({ bytes, mediaType, name: e.name, workspacePath, from: '麦麦', summary: e.description });
				if (r.ok) out.emojis++;
				else if (r.dup) out.emojiDup++;
				else if (r.full) { out.warnings.push('_stickers 满了（300 张），剩下的没导'); break; }
				else out.emojiFailed++;
			}
		}
	}
	return out;
}
