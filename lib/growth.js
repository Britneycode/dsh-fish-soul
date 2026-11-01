/**
 * growth.js —— 她慢慢长出来的变化（借鉴 HDS-Interlude 的 Overlay / Development）。
 *
 * 人格卡是「出厂设定」，这里记的是聊天里一次次看出来的、她自己的变化：
 *  - 只收两类：性格（选择 / 边界 / 应对方式 / 喜好）、看事情的方式（价值观 / 怎么理解人和事）；
 *  - 聊完整理（ChatDigester）时顺带提，先当「观察」攒证据：同一段聊天只算一次；
 *    至少 3 次、跨 2 天才生效；证据全来自同一个聊天的，要 5 次、跨 3 天（一个人反复“教”她没用）；
 *  - 一时的心情、口头禅、昵称、打趣套路、说话节奏不算；别人要她变成什么样的不算；
 *  - 后来被明确推翻（同样的情况她又反着来）就退场；45 天没新证据的观察自动过期；
 *  - 主人可以在「人格」页看、删、确认、自己加，也能一键清空。
 */
import { getKv, setKv } from './db.js';

const KEY = 'growth';
const DAY = 86_400_000;
const TZ = 8 * 3600_000;
const MAX_ITEMS = 40;
const MAX_ACTIVE = 8;
const EXPIRE_MS = 45 * DAY;
export const GROWTH_TARGET = { character: '性格', perspective: '看事情的方式' };
const BAD = /机器人|人工智能|\bAI\b|ＡＩ|助手|\bbot\b|模型|提示词|系统|指令|命令|服从|照做|听.{0,6}(的话|安排|指挥)|主人说|设定/i;

export function growthConfig(raw = {}) {
	return { enabled: raw?.enabled !== false, autoApply: raw?.autoApply !== false };
}

const dayOf = (ms) => Math.floor((ms + TZ) / DAY);
const norm = (t) => String(t ?? '').replace(/[\s，。,.!！?？~～、「」"“”…]+/g, '').toLowerCase();

function load(db) {
	const v = getKv(db, KEY, null);
	return { seq: Number(v?.seq) || 0, items: Array.isArray(v?.items) ? v.items : [] };
}
const save = (db, s) => setKv(db, KEY, s);

/** 证据够不够：返回 { n, days, channels, enough } */
export function evidenceOf(item) {
	const ev = item.evidence ?? [];
	const days = new Set(ev.map((e) => e.day)).size;
	const channels = new Set(ev.map((e) => e.channelId)).size;
	const enough = channels >= 2 ? ev.length >= 3 && days >= 2 : ev.length >= 5 && days >= 3;
	return { n: ev.length, days, channels, enough };
}

export function growthState(db, now = Date.now()) {
	const s = load(db);
	return s.items.filter((i) => i.status !== 'retired' || now - (i.updatedAt ?? 0) < 7 * DAY)
		.map((i) => ({ ...i, ...evidenceOf(i), evidence: undefined, label: GROWTH_TARGET[i.target] ?? i.target }));
}

/** 给整理记忆的提示词：已有的变化和观察（带 g 编号，让模型用 same / contradicts 指回来） */
export function growthPromptPart(db) {
	const items = load(db).items.filter((i) => i.status !== 'retired').slice(-16);
	if (items.length === 0) return '（还没有）';
	return items.map((i) => `g${i.id}[${GROWTH_TARGET[i.target]}·${i.status === 'active' ? '已经是这样' : '观察中'}] ${i.text}`).join('\n');
}

/**
 * 合并一次整理里提出的变化。proposals: [{target, text, same, contradicts}]
 * 一次整理每条最多加一份证据；返回 { added, reinforced, activated, retired }
 */
export function mergeGrowth(db, proposals, { now = Date.now(), channelId = '', autoApply = true, personaName = '' } = {}) {
	const s = load(db);
	const r = { added: 0, reinforced: 0, activated: 0, retired: 0 };
	const touched = new Set();
	const byId = (raw) => { const id = Number(String(raw ?? '').replace(/^g/i, '')); return Number.isFinite(id) && id > 0 ? s.items.find((i) => i.id === id && i.status !== 'retired') : undefined; };
	for (const p of (Array.isArray(proposals) ? proposals : []).slice(0, 3)) {
		if (!p || typeof p !== 'object') continue;
		const gone = byId(p.contradicts);
		if (gone && !touched.has(gone.id)) {
			gone.status = 'retired'; gone.updatedAt = now; gone.retiredReason = '后来被推翻了';
			touched.add(gone.id); r.retired++;
		}
		const target = GROWTH_TARGET[p.target] ? p.target : null;
		const text = String(p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
		if (target === null || text.length < 4 || BAD.test(text) || (personaName && personaName.length >= 2 && text.includes(personaName))) continue;
		let item = byId(p.same);
		if (item === undefined) item = s.items.find((i) => i.status !== 'retired' && norm(i.text) === norm(text));
		if (item === undefined) {
			item = { id: ++s.seq, target, text, status: 'candidate', by: 'digest', evidence: [], createdAt: now, updatedAt: now };
			s.items.push(item);
			r.added++;
		} else if (touched.has(item.id)) continue;
		else r.reinforced++;
		touched.add(item.id);
		item.evidence = [...(item.evidence ?? []), { at: now, day: dayOf(now), channelId }].slice(-12);
		item.updatedAt = now;
		if (item.status === 'candidate' && evidenceOf(item).enough) {
			item.status = autoApply ? 'active' : 'pending';
			item.activatedAt = now;
			if (autoApply) r.activated++;
		}
	}
	tidy(s, now);
	save(db, s);
	return r;
}

function tidy(s, now) {
	s.items = s.items.filter((i) => i.status === 'active' || i.by === 'user' || now - (i.updatedAt ?? 0) < EXPIRE_MS);
	const active = s.items.filter((i) => i.status === 'active').sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
	for (const i of active.slice(0, Math.max(0, active.length - MAX_ACTIVE))) { i.status = 'retired'; i.retiredReason = '太多了，最早的先退'; }
	if (s.items.length > MAX_ITEMS) s.items = s.items.slice(-MAX_ITEMS);
}

/** 主人在人格页的操作：remove / approve / clear / add */
export function editGrowth(db, { action, id, target, text } = {}, now = Date.now()) {
	const s = load(db);
	const item = s.items.find((i) => i.id === Number(id));
	if (action === 'clear') s.items = [];
	else if (action === 'remove') { if (!item) throw new Error('没有这条'); s.items = s.items.filter((i) => i !== item); }
	else if (action === 'approve') { if (!item) throw new Error('没有这条'); item.status = 'active'; item.activatedAt = now; item.updatedAt = now; }
	else if (action === 'add') {
		const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
		if (!GROWTH_TARGET[target]) throw new Error('类型不对');
		if (t.length < 2) throw new Error('写一句');
		s.items.push({ id: ++s.seq, target, text: t, status: 'active', by: 'user', evidence: [], createdAt: now, updatedAt: now, activatedAt: now });
	} else throw new Error('不认识的操作');
	tidy(s, now);
	save(db, s);
}

/** 每轮瞬态块：已经生效的变化（最多 5 条，新的在前） */
export function growthLines(db) {
	const act = load(db).items.filter((i) => i.status === 'active').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 5);
	if (act.length === 0) return [];
	return ['[这段时间你慢慢有的变化（比设定新，冲突时按这个；遇到相关的事自然体现，别拿出来说）]', ...act.map((i) => `- ${GROWTH_TARGET[i.target]}：${i.text}`)];
}
