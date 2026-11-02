/**
 * worldinfo.js —— 世界书（SillyTavern World Info / Lorebook）：
 *  - 条目统一成一种形状（角色卡里的 character_book 和单独导入的世界书都用它）；
 *  - 关键词支持正则（"/龙(族|人)/i" 这种写法）、整词匹配、区分大小写、次要关键词逻辑、触发概率；
 *  - 扫描深度：只看最近 N 条消息（条目可以自己指定 scanDepth）；预算：本轮注入的世界书总字数上限，超了按优先级丢；
 *  - 单独导入的世界书存在 kv `worldinfo.books`，可开关、可删，所有聊天生效（常驻条目每轮都带，算进预算）。
 */
import { randomUUID } from 'node:crypto';
import { getKv, setKv } from './db.js';

const KV_KEY = 'worldinfo.books';
const MAX_BOOKS = 20;
const MAX_ENTRIES = 1000;
const MAX_CONTENT = 4000;

export function loreConfig(raw) {
	const v = raw ?? {};
	const num = (x, d, lo, hi) => { const n = Math.floor(Number(x)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
	return { scanDepth: num(v.scanDepth, 4, 1, 50), budgetChars: num(v.budgetChars, 1200, 100, 20000), maxEntries: num(v.maxEntries, 6, 1, 50) };
}

const list = (x) => (Array.isArray(x) ? x : typeof x === 'string' && x.trim() !== '' ? x.split(/[,，]/) : []).map((k) => String(k).trim()).filter(Boolean);
const optBool = (...vals) => { for (const v of vals) if (v === true || v === false) return v; return null; };
const optNum = (...vals) => { for (const v of vals) { if (v === null || v === undefined || v === '') continue; const n = Number(v); if (Number.isFinite(n)) return n; } return null; };

/**
 * SillyTavern 的各种条目写法 → 统一形状。
 * @param {object} e  World Info 条目（key/keysecondary/order/disable…）或角色卡 character_book 条目（keys/secondary_keys/insertion_order/enabled…）
 * @param {(s: string) => string} [m] 宏替换
 */
export function normalizeEntry(e, m = (s) => s) {
	if (!e || typeof e !== 'object') return null;
	const content = m(String(e.content ?? '')).slice(0, MAX_CONTENT);
	const ext = e.extensions ?? {};
	const order = optNum(e.order, e.insertion_order, e.priority) ?? 100;
	const probability = optNum(e.probability, ext.probability);
	const useProbability = optBool(e.useProbability, ext.useProbability);
	return {
		uid: String(e.uid ?? e.id ?? ''),
		comment: String(e.comment ?? e.name ?? '').slice(0, 80),
		keys: list(e.keys ?? e.key),
		secondary: list(e.secondary_keys ?? e.keysecondary),
		// selective 打开时次要关键词按 selectiveLogic 生效（0 任一 / 1 不全有 / 2 都没有 / 3 全有）
		selective: e.selective === true && list(e.secondary_keys ?? e.keysecondary).length > 0,
		logic: Number(optNum(ext.selectiveLogic, e.selectiveLogic) ?? 0),
		order,
		constant: e.constant === true,
		disabled: e.enabled === false || e.disable === true,
		caseSensitive: optBool(e.caseSensitive, e.case_sensitive, ext.case_sensitive) === true,
		wholeWords: optBool(e.matchWholeWords, ext.match_whole_words) === true,
		scanDepth: optNum(e.scanDepth, ext.scan_depth),
		probability: useProbability === false || probability === null ? 100 : Math.min(100, Math.max(0, probability)),
		content
	};
}

/** "/pattern/flags" → RegExp（坏的正则当普通文字） */
export function parseRegexKey(k) {
	const m = /^\/(.+)\/([a-z]*)$/s.exec(String(k));
	if (!m) return null;
	try { return new RegExp(m[1], m[2].replace(/[gy]/g, '')); } catch { return null; }
}

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = new WeakMap();
/** 条目的关键词 → 判断函数（缓存在条目上）。 */
function matcherOf(e) {
	let m = matchers.get(e);
	if (m) return m;
	const one = (k) => {
		const re = parseRegexKey(k);
		if (re) return (text) => re.test(text);
		// 整词：只对纯字母数字的词加边界（中文没有词边界，照常包含匹配）
		if (e.wholeWords && /^[\w\s'-]+$/.test(k)) {
			const w = new RegExp(`(?:^|[^\\w])${ESC(k)}(?:$|[^\\w])`, e.caseSensitive ? '' : 'i');
			return (text) => w.test(text);
		}
		if (e.caseSensitive) return (text) => text.includes(k);
		const low = k.toLowerCase();
		return (text, lower) => lower.includes(low);
	};
	m = { keys: (e.keys ?? []).map(one), secondary: (e.secondary ?? []).map(one) };
	matchers.set(e, m);
	return m;
}

/**
 * 本轮命中的世界书条目。
 * @param {Array} lore 统一形状的条目
 * @param {string|string[]} input 最近的消息（数组从旧到新；字符串按行当消息）
 * @param {number|{limit?: number, maxEntries?: number, scanDepth?: number, budgetChars?: number, random?: () => number}} [opts]
 *   数字 = 最多几条（旧写法）。常驻条目（constant）不看关键词；按优先级（order 大的先）排，超出条数或预算的丢掉。
 */
export function matchLore(lore, input, opts = 4) {
	const o = typeof opts === 'number' ? { limit: opts } : (opts ?? {});
	const limit = o.limit ?? o.maxEntries ?? 4;
	const budget = o.budgetChars ?? Infinity;
	const depth = o.scanDepth ?? Infinity;
	const random = o.random ?? Math.random;
	const msgs = (Array.isArray(input) ? input : String(input ?? '').split('\n')).map((x) => String(x ?? '')).filter((x) => x !== '');
	const windows = new Map();
	const textAt = (d) => {
		const k = Number.isFinite(d) && d > 0 ? Math.floor(d) : Infinity;
		if (!windows.has(k)) { const t = (k === Infinity ? msgs : msgs.slice(-k)).join('\n'); windows.set(k, [t, t.toLowerCase()]); }
		return windows.get(k);
	};
	const hits = [];
	for (const e of lore ?? []) {
		if (!e || e.disabled || String(e.content ?? '').trim() === '') continue;
		if (!e.constant) {
			if (msgs.length === 0 || (e.keys ?? []).length === 0) continue;
			const [text, lower] = textAt(e.scanDepth ?? depth);
			const m = matcherOf(e);
			if (!m.keys.some((f) => f(text, lower))) continue;
			if (e.selective) {
				const n = m.secondary.length;
				const got = m.secondary.filter((f) => f(text, lower)).length;
				const pass = e.logic === 1 ? got < n : e.logic === 2 ? got === 0 : e.logic === 3 ? got === n : got > 0;
				if (!pass) continue;
			}
		}
		if ((e.probability ?? 100) < 100 && random() * 100 >= e.probability) continue;
		hits.push(e);
	}
	hits.sort((a, b) => Number(b.constant === true) - Number(a.constant === true) || (b.order ?? 100) - (a.order ?? 100));
	const out = [];
	let used = 0;
	for (const e of hits) {
		if (out.length >= limit) break;
		const len = String(e.content).length;
		if (used + len > budget) continue; // 放不下这条，看看后面短的
		out.push(e);
		used += len;
	}
	return out;
}

/**
 * 文件内容 → { name, entries }。认：SillyTavern 世界书（{entries:{"0":{…}}}）、角色卡的 character_book（{entries:[…]}）、
 * 整张角色卡（data.character_book）。
 */
export function parseWorldInfo(value, { fileName = '' } = {}) {
	let v = value;
	if (typeof v === 'string') { try { v = JSON.parse(v.replace(/^\uFEFF/, '')); } catch { throw new Error('不是有效的 JSON'); } }
	if (!v || typeof v !== 'object') throw new Error('不是世界书');
	const book = v.entries ? v : v.data?.character_book ?? v.character_book ?? v.originalData ?? null;
	if (!book || !book.entries || typeof book.entries !== 'object') throw new Error('没找到世界书条目（entries）');
	const raw = Array.isArray(book.entries) ? book.entries : Object.values(book.entries);
	const entries = raw.slice(0, MAX_ENTRIES).map((e) => normalizeEntry(e)).filter((e) => e && e.content.trim() !== '' && (e.constant || e.keys.length > 0));
	if (entries.length === 0) throw new Error('世界书里没有能用的条目（要有内容，且有关键词或设为常驻）');
	const name = String(book.name ?? v.name ?? v.data?.name ?? '').trim() || String(fileName).replace(/\.(json|lorebook)$/i, '') || '世界书';
	return { name: name.slice(0, 40), entries };
}

export class WorldBooks {
	constructor({ db }) {
		this.db = db;
		this.cache = null;
	}

	books() {
		return getKv(this.db, KV_KEY, []) ?? [];
	}

	save(list) {
		setKv(this.db, KV_KEY, list);
		this.cache = null;
	}

	/** 打开的世界书的所有条目（带来源书名）。 */
	activeEntries() {
		if (this.cache === null) this.cache = this.books().filter((b) => b.enabled !== false).flatMap((b) => b.entries.map((e) => ({ ...e, book: b.name })));
		return this.cache;
	}

	import(value, { fileName = '' } = {}) {
		const { name, entries } = parseWorldInfo(value, { fileName });
		const list = this.books();
		if (list.length >= MAX_BOOKS) throw new Error(`最多 ${MAX_BOOKS} 本世界书，先删几本`);
		const book = { id: randomUUID().slice(0, 8), name, enabled: true, importedAt: Date.now(), entries };
		this.save([...list, book]);
		return book;
	}

	setEnabled(id, enabled) {
		const list = this.books();
		const b = list.find((x) => x.id === id);
		if (!b) return false;
		b.enabled = enabled === true;
		this.save(list);
		return true;
	}

	remove(id) {
		const list = this.books();
		if (!list.some((x) => x.id === id)) return false;
		this.save(list.filter((x) => x.id !== id));
		return true;
	}

	summary() {
		return this.books().map((b) => ({
			id: b.id, name: b.name, enabled: b.enabled !== false, importedAt: b.importedAt,
			entries: b.entries.length, constant: b.entries.filter((e) => e.constant).length, regex: b.entries.filter((e) => e.keys.some((k) => parseRegexKey(k))).length,
			sample: b.entries.slice(0, 5).map((e) => (e.constant ? `常驻：${e.comment || e.content.slice(0, 16)}` : e.keys.slice(0, 3).join(' / ')))
		}));
	}
}
