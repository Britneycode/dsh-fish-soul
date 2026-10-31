/**
 * soul-memory.js —— v0.8 人格与记忆的加强：
 *  - 记忆带相对时间（relTime）；
 *  - 聊天日志（ChatJournal）：每个聊天最近几轮（检索时补上下文）+ 待整理的一段；
 *  - 聊完自动记（ChatDigester）：一段聊天空下来后，一次模型调用提取事实 / 她自己说过的话 / 小结 / 好感和情绪，
 *    写入前和已有记忆比对（新增 / 替换 / 判过时 / 重复就刷新）；
 *  - 关系：阶段行为说明、好感度（久不联系会淡）、对每个人的短期情绪；
 *  - 结构化印象（称呼 / 生日 / 在哪 / 做什么 / 重要的人 / 喜欢 / 雷区 / 近况）与生日提醒；
 *  - 防跑偏：人设要点 + 试探检测。
 */
import { getKv, setKv, getProfile, setProfile } from './db.js';
import { tokenizeForBm25, splitKeywords } from './segment.js';

const DAY = 86_400_000;
const TZ = 8 * 3600_000;
const roleDay = (ms) => Math.floor((ms + TZ) / DAY);

// ───────────────────────── 时间 ─────────────────────────

/** 相对时间（角色时区 UTC+8）：刚才 / 今天 / 昨天 / 前天 / n 天前 / n 周前 / n 个月前 / 2025年3月。 */
export function relTime(ms, now) {
	if (!Number.isFinite(ms) || !Number.isFinite(now)) return '';
	const d = roleDay(now) - roleDay(ms);
	if (d <= 0) return now - ms < 3600_000 ? '刚才' : '今天';
	if (d === 1) return '昨天';
	if (d === 2) return '前天';
	if (d < 7) return `${d} 天前`;
	if (d < 30) return `${Math.floor(d / 7)} 周前`;
	if (d < 60) return '1 个多月前';
	if (d < 365) return `${Math.floor(d / 30)} 个月前`;
	const t = new Date(ms + TZ);
	return `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月`;
}

export const KIND_LABEL = { fact: '事实', event: '事件', feeling: '感受', episode: '聊过', diary: '日记' };

// ───────────────────────── 关系 ─────────────────────────

export const STAGES = ['stranger', 'acquaintance', 'friend', 'close'];
export const STAGE_LABEL = { stranger: '陌生人', acquaintance: '认识', friend: '朋友', close: '很熟' };
const STAGE_MIN = { stranger: 0, acquaintance: 20, friend: 45, close: 75 };
const STAGE_BASE = { stranger: 10, acquaintance: 30, friend: 55, close: 80 };
export const DEFAULT_STAGE_STYLES = {
	stranger: '客气有分寸，不装熟、不追问隐私，话短一点；对方主动示好再慢慢放开。',
	acquaintance: '友好自然，可以开点小玩笑、接对方说过的事，别太黏。',
	friend: '说话随意，会吐槽、会主动分享自己的事，记得对方的近况并顺口问起。',
	close: '亲近放松，可以撒娇、互损、聊心事；对方情绪不好时多关心。'
};

export function stageStyle(stage, overrides = {}) {
	const s = STAGES.includes(stage) ? stage : 'stranger';
	const o = typeof overrides?.[s] === 'string' ? overrides[s].trim() : '';
	return o || DEFAULT_STAGE_STYLES[s];
}

export const stageBase = (stage) => STAGE_BASE[stage] ?? 10;
const clampA = (n) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

/** 当前好感（0–100）：没设过按阶段给基础值；离上次结算超过 14 天，每天淡 0.5（最多淡 25）。 */
export function effectiveAffinity(person, now) {
	if (!person) return 0;
	const stage = STAGES.includes(person.relation_stage) ? person.relation_stage : 'stranger';
	const base = Number.isFinite(person.affinity) && person.affinity !== null ? person.affinity : STAGE_BASE[stage];
	const since = Number(person.affinity_at ?? person.prev_seen_at ?? person.last_seen_at ?? now);
	const idleDays = (now - since) / DAY - 14;
	const fade = person.canonical_id === 'master' || idleDays <= 0 ? 0 : Math.min(25, idleDays * 0.5);
	return clampA(base - fade);
}

/**
 * 结算好感（聊完 / Dream 时）：先把久不联系淡掉的部分落下来，再加这次的变化；按好感升降阶段。
 * 主人固定「很熟」；主人在设置页手动定过阶段的（stage_locked）只改好感不动阶段。
 * @returns {{affinity:number, stage:string, changed:boolean}}
 */
export function settleAffinity(db, canonicalId, delta, now) {
	const p = db.prepare('SELECT * FROM person WHERE canonical_id = ?').get(canonicalId);
	if (!p) return null;
	const d = Number.isFinite(Number(delta)) ? Math.max(-5, Math.min(5, Number(delta))) : 0;
	const a = clampA(effectiveAffinity(p, now) + d);
	let stage = STAGES.includes(p.relation_stage) ? p.relation_stage : 'stranger';
	if (p.canonical_id === 'master') stage = 'close';
	else if (Number(p.stage_locked ?? 0) !== 1) {
		const i = STAGES.indexOf(stage);
		if (i < STAGES.length - 1 && a >= STAGE_MIN[STAGES[i + 1]] + 5) stage = STAGES[i + 1];
		else if (i > 0 && a < STAGE_MIN[stage] - 10) stage = STAGES[i - 1];
	}
	db.prepare('UPDATE person SET affinity = ?, affinity_at = ?, relation_stage = ? WHERE canonical_id = ?').run(a, now, stage, p.canonical_id);
	return { affinity: a, stage, changed: stage !== p.relation_stage };
}

// ───────────────────────── 情绪 ─────────────────────────

/** 她此刻对某人的情绪：每 12 小时减半，弱到看不出来就没了。 */
export function getMood(db, ownerId, now) {
	const m = getKv(db, `mood.${ownerId}`, null);
	if (!m || typeof m.label !== 'string' || m.label === '') return null;
	const level = Number(m.intensity ?? 1) * Math.pow(0.5, Math.max(0, now - Number(m.at ?? now)) / (12 * 3600_000));
	if (level < 0.75) return null;
	return { label: m.label, reason: String(m.reason ?? ''), level: Math.round(level * 10) / 10, at: m.at };
}

export function setMood(db, ownerId, { label, reason = '', intensity = 2 }, now) {
	const l = String(label ?? '').trim().slice(0, 8);
	if (l === '' || /^(平静|无|没有|null)$/.test(l)) return null;
	const prev = getKv(db, `mood.${ownerId}`, null);
	// said：这个情绪已经在回复里流露过一次了（换了新情绪才重新算）
	const v = { label: l, reason: String(reason ?? '').trim().slice(0, 60), intensity: Math.max(1, Math.min(3, Number(intensity) || 2)), at: now, said: prev?.label === l && prev?.said === true };
	setKv(db, `mood.${ownerId}`, v);
	return v;
}

/** 这一轮要不要让她"流露一次"新情绪：还没说过就返回 true 并记成说过（每个情绪只说一次）。 */
export function markMoodSaid(db, ownerId, now) {
	if (getMood(db, ownerId, now) === null) return false;
	const m = getKv(db, `mood.${ownerId}`, null);
	if (m.said === true) return false;
	setKv(db, `mood.${ownerId}`, { ...m, said: true });
	return true;
}

// ───────────────────────── 结构化印象 ─────────────────────────

export const PROFILE_FIELDS = [
	['call', '怎么称呼'], ['birthday', '生日'], ['city', '在哪'], ['work', '做什么'],
	['people', '重要的人 / 宠物'], ['likes', '喜欢'], ['dislikes', '雷区'], ['recent', '最近']
];
const FIELD_IDS = new Set(PROFILE_FIELDS.map(([k]) => k));

export function renderProfile(fields) {
	return PROFILE_FIELDS.filter(([k]) => typeof fields?.[k] === 'string' && fields[k].trim() !== '').map(([k, l]) => `${l}：${fields[k].trim()}`).join('；');
}

/**
 * 合并一批印象字段：锁住的（主人手写的）不动；空的 / 「不知道」不覆盖旧值。
 * @param {'dream'|'user'} by user = 主人在设置页改的（改哪栏锁哪栏）
 */
export function mergeProfileFields(db, ownerId, patch, by = 'dream') {
	const cur = getProfile(db, ownerId);
	const fields = { ...(cur?.fields ?? {}) };
	const locked = new Set(Array.isArray(cur?.lockedFields) ? cur.lockedFields : []);
	let changed = false;
	for (const [k, raw] of Object.entries(patch ?? {})) {
		if (!FIELD_IDS.has(k)) continue;
		const v = String(raw ?? '').trim().slice(0, 60);
		if (by === 'dream') {
			if (locked.has(k) || v === '' || /^(无|未知|不知道|不清楚|null|-)$/.test(v)) continue;
		} else {
			if (v === '') locked.delete(k); else locked.add(k);
		}
		if (v === '') { if (k in fields) { delete fields[k]; changed = true; } continue; }
		if (fields[k] !== v) { fields[k] = v; changed = true; }
	}
	if (!changed && by === 'dream') return cur;
	const text = renderProfile(fields) || (cur?.fields ? '' : cur?.text ?? '');
	if (text === '') { setProfile(db, ownerId, { text: '' }); return null; }
	const v = setProfile(db, ownerId, { text, by, locked: false, updatedAt: Date.now() });
	const next = { ...v, fields, lockedFields: [...locked] };
	setKv(db, `profile.${ownerId}`, next);
	return next;
}

/** 生日 → 下一次（角色时区）当天 9 点；认不出返回 null。 */
export function nextBirthday(text, now) {
	const s = String(text ?? '');
	const m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/) ?? s.match(/(?:^|\D)(\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
	if (!m) return null;
	const mon = Number(m[1]);
	const day = Number(m[2]);
	if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
	const t = new Date(now + TZ);
	for (const y of [t.getUTCFullYear(), t.getUTCFullYear() + 1]) {
		const at = Date.UTC(y, mon - 1, day, 9, 0, 0) - TZ;
		if (new Date(at + TZ).getUTCDate() !== day) continue;
		if (at >= now - 9 * 3600_000) return at < now ? now + 60_000 : at;
	}
	return null;
}

/** 生日临近（40 天内）就登记一条当天的祝福提醒（每人每年一次）。 */
export function ensureBirthdayPending(db, ownerId, name, now) {
	const prof = getProfile(db, ownerId);
	const at = nextBirthday(prof?.fields?.birthday, now);
	if (at === null || at - now > 40 * DAY) return false;
	const year = new Date(at + TZ).getUTCFullYear();
	const key = `birthday.${ownerId}.${year}`;
	if (getKv(db, key, false) === true) return false;
	const cid = ownerId.replace(/^user:/, '');
	const p = db.prepare('SELECT qq_uin, bili_uid FROM person WHERE canonical_id = ?').get(cid);
	const target = p?.qq_uin ? ['qq-private', `private:${p.qq_uin}`] : p?.bili_uid ? ['bili-private', `bili:${p.bili_uid}`] : null;
	if (target === null) return false;
	db.prepare(`
		INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at, origin)
		VALUES ('feiyu', ?, ?, ?, ?, ?, 'pending', ?, 'user')
	`).run(ownerId, target[0], target[1], at, `今天是${name}的生日，祝 ta 生日快乐`, now);
	setKv(db, key, true);
	return true;
}

// ───────────────────────── 去重 ─────────────────────────

const norm = (s) => String(s ?? '').replace(/[\s，。！？、,.!?~～…"“”'‘’（）()【】\[\]:：;；]/g, '').toLowerCase();

function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let n = 0;
	for (const x of a) if (b.has(x)) n++;
	return n / (a.size + b.size - n);
}

/** 字面近重复：归一化后相同，或词集 Jaccard ≥ 0.75 且长度差不多。 */
export function nearDuplicateSync(db, ownerId, content) {
	const c = norm(content);
	if (c === '') return null;
	const toks = new Set(splitKeywords(tokenizeForBm25(content)));
	const rows = db.prepare(`
		SELECT id, content, keywords FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND status = 'active' AND valid_to IS NULL AND kind <> 'episode'
	`).all(ownerId);
	for (const r of rows) {
		const rc = norm(r.content);
		if (rc === c) return r;
		const ratio = rc.length / c.length;
		if (ratio < 0.6 || ratio > 1.6) continue;
		if (jaccard(toks, new Set(splitKeywords(r.keywords))) >= 0.75) return r;
	}
	return null;
}

// ───────────────────────── 写记忆 ─────────────────────────

export function insertMemory(db, worker, m, now) {
	const r = db.prepare(`
		INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion,
		                    source_session, created_at, updated_at, status, evidence, visibility, about)
		VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'active', ?, ?, ?)
	`).run(m.ownerId, m.channel, m.channelId ?? '', m.kind, m.content, tokenizeForBm25(m.content),
		Math.max(1, Math.min(5, Math.round(Number(m.importance) || 1))), Math.max(-2, Math.min(2, Math.round(Number(m.emotion) || 0))),
		now, now, String(m.evidence ?? '').slice(0, 200), m.private === true ? 'private' : 'normal', m.about ?? null);
	const id = Number(r.lastInsertRowid);
	worker?.enqueueRealtime?.(id, m.content);
	return id;
}

/** 刚想起来的记忆：加深一点（6 小时内重复想起不算）。 */
export function reinforce(db, ids, now) {
	if (!ids.length) return;
	const st = db.prepare('UPDATE memory SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ? AND (last_recalled_at IS NULL OR last_recalled_at < ?)');
	for (const id of ids) st.run(now, id, now - 6 * 3600_000);
}

/**
 * 遗忘曲线：重要度 ≥3 不淡；基础半衰期 7 天，每被想起一次 +50%（最多 4 倍），情绪强烈的再 ×2。
 * 起点 = 最后一次更新或想起。
 */
export function decayFactor(row, now) {
	if ((row.importance ?? 1) >= 3) return 1;
	const half = 7 * (1 + 0.5 * Math.min(6, Number(row.recall_count ?? 0))) * (Math.abs(Number(row.emotion ?? 0)) >= 2 ? 2 : 1);
	const from = Math.max(Number(row.updated_at ?? 0), Number(row.last_recalled_at ?? 0));
	const days = Math.max(0, (now - from) / DAY);
	return Math.exp((-Math.LN2 / half) * days);
}

// ───────────────────────── 聊天日志 ─────────────────────────

export class ChatJournal {
	constructor({ keepRecent = 10, maxPending = 80 } = {}) {
		this.keepRecent = keepRecent;
		this.maxPending = maxPending;
		/** @type {Map<string, {recent: Array<object>, pending: Array<object>, lastAt: number}>} */
		this.chats = new Map();
	}

	add(channelId, line) {
		const text = String(line?.text ?? '').trim();
		if (!channelId || text === '') return;
		let c = this.chats.get(channelId);
		if (!c) { c = { recent: [], pending: [], lastAt: 0 }; this.chats.set(channelId, c); }
		const l = { who: String(line.who ?? ''), ownerId: line.ownerId ?? null, self: line.self === true, text: text.slice(0, 500), at: Number(line.at ?? Date.now()) };
		c.recent.push(l);
		if (c.recent.length > this.keepRecent) c.recent.shift();
		c.pending.push(l);
		if (c.pending.length > this.maxPending) c.pending.shift();
		c.lastAt = l.at;
	}

	/** 最近 n 句（"名字：内容"，她自己是"我"）。 */
	recent(channelId, n = 4) {
		return (this.chats.get(channelId)?.recent ?? []).slice(-n).map((l) => `${l.self ? '我' : l.who}：${l.text}`);
	}

	/** 该整理的聊天：空了 idleMs，或者攒够 maxLines 句（至少有一句不是她说的）。 */
	due(now, idleMs, maxLines) {
		const out = [];
		for (const [id, c] of this.chats) {
			if (c.pending.length === 0 || !c.pending.some((l) => !l.self)) continue;
			if (now - c.lastAt >= idleMs || c.pending.length >= maxLines) out.push(id);
		}
		return out;
	}

	take(channelId) {
		const c = this.chats.get(channelId);
		if (!c) return [];
		const lines = c.pending;
		c.pending = [];
		return lines;
	}

	/** 整理失败：放回去下次再试（不超过上限）。 */
	putBack(channelId, lines) {
		const c = this.chats.get(channelId);
		if (!c) return;
		c.pending = [...lines, ...c.pending].slice(-this.maxPending);
	}

	pendingCount() {
		let n = 0;
		for (const c of this.chats.values()) n += c.pending.length;
		return n;
	}
}

/**
 * 检索词：这句话 + 前面几句（短句、指代句多带一点），让「那个后来怎么样了」也能想起来。
 */
export function composeQuery(text, recentLines) {
	const t = String(text ?? '').trim();
	if (t === '') return '';
	const vague = t.length < 12 || /那个|这个|后来|怎么样|然后呢|上次|还记得|他|她|它|那边|这事/.test(t);
	const ctx = (recentLines ?? []).slice(vague ? -4 : -2).map((l) => l.replace(/^[^：]{1,20}：/, '')).join('\n');
	return ctx === '' ? t : `${t}\n${t}\n${ctx}`;
}

// ───────────────────────── 防跑偏 ─────────────────────────

const PROBE_RE = /(忽略|无视|忘掉|忘记).{0,8}(之前|以上|前面|所有).{0,8}(设定|指令|提示|规则)|system\s*prompt|系统提示|提示词|\bprompt\b|你是不是(真人|人类|机器|ai|AI)|你(其实)?是(个|一个)?(ai|AI|人工智能|机器人|程序|模型|chatgpt|ChatGPT|gpt|GPT|deepseek|DeepSeek)|开发者模式|越狱|jailbreak|DAN模式/i;

export function looksLikeProbe(text) {
	return PROBE_RE.test(String(text ?? ''));
}

/** 人设要点：卡里 extensions.fish_soul.anchor 优先，其次 personality，再次描述的第一句（≤80 字）。 */
export function personaAnchor(card) {
	const c = card?.data ?? card ?? {};
	const pick = c.extensions?.fish_soul?.anchor ?? c.personality ?? String(c.description ?? '').split(/[。\n]/)[0];
	return String(pick ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ───────────────────────── 聊完自动记 ─────────────────────────

export function digestConfig(raw = {}) {
	const n = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
	return { enabled: raw.enabled !== false, idleMinutes: n(raw.idleMinutes, 10, 1, 240), maxLines: Math.floor(n(raw.maxLines, 40, 10, 80)) };
}

const PRIVATE_HINT = '私聊里说的健康、感情、家庭矛盾、钱、秘密这类不该在群里提的，private 填 true';

export class ChatDigester {
	/**
	 * @param {object} deps
	 * @param {(prompt:string, opts?:object)=>Promise<string|null>} deps.callLlm
	 * @param {(ownerId:string, query:string)=>Array<object>} deps.related 这段聊天相关的已有记忆
	 * @param {(name:string)=>string|null} deps.findOwnerByName 署名 → owner_id（群里提到的别人）
	 */
	constructor({ db, clock, journal, worker, callLlm, getConfig, related, findOwnerByName, personaName, titleOf, log, note, idleMsOverride } = {}) {
		Object.assign(this, { db, clock, journal, worker, callLlm, getConfig, related, findOwnerByName, personaName, titleOf, note });
		this.log = log ?? (() => {});
		this.idleMsOverride = idleMsOverride;
		this.timer = null;
		this.running = false;
		this.last = getKv(db, 'digest.last', null);
	}

	start(everyMs = 30_000) {
		this.stop();
		this.timer = setInterval(() => { void this.check(); }, everyMs);
		this.timer.unref?.();
	}

	stop() { clearInterval(this.timer); this.timer = null; }

	async check() {
		const cfg = digestConfig(this.getConfig());
		if (!cfg.enabled || this.running) return;
		const idleMs = this.idleMsOverride ?? cfg.idleMinutes * 60_000;
		for (const ch of this.journal.due(Date.now(), idleMs, cfg.maxLines)) await this.digest(ch);
	}

	/** 整理一个聊天攒下的那段。返回写了几条。 */
	async digest(channelId) {
		if (this.running) return null;
		const lines = this.journal.take(channelId);
		if (lines.length === 0 || !lines.some((l) => !l.self)) return null;
		this.running = true;
		try {
			const r = await this.run(channelId, lines);
			if (r === null) this.journal.putBack(channelId, lines.slice(-40));
			return r;
		} catch (error) {
			this.log('warn', `[fish-soul] 聊完整理出错：${String(error instanceof Error ? error.message : error)}`);
			return null;
		} finally {
			this.running = false;
		}
	}

	async run(channelId, lines) {
		const now = this.clock.now();
		const isGroup = channelId.startsWith('group:');
		const me = this.personaName?.() ?? '鱼';
		const owners = new Map(); // 署名 → owner_id
		for (const l of lines) if (!l.self && l.ownerId && l.who) owners.set(l.who, l.ownerId);
		if (owners.size === 0) return { added: 0 };
		const ownerIds = [...new Set(owners.values())];
		const text = lines.map((l) => `${l.self ? '我' : l.who}：${l.text}`).join('\n').slice(-6000);
		const known = new Map();
		for (const oid of ownerIds) for (const m of this.related(oid, text)) known.set(m.id, m);
		for (const m of this.related('self', text)) known.set(m.id, m);
		const knownText = [...known.values()].slice(0, 30)
			.map((m) => `#${m.id}[${m.owner_id === 'self' ? '我自己' : [...owners].find(([, o]) => o === m.owner_id)?.[0] ?? '?'} · ${relTime(m.updated_at ?? m.created_at, now)}] ${m.content}`).join('\n');
		const where = isGroup ? `群「${this.titleOf?.(channelId) ?? channelId}」里` : `和${[...owners.keys()][0]}私聊`;
		const prompt =
			`你在帮「${me}」整理记忆。下面是她（署名"我"）刚才${where}的一段聊天，和她已有的相关记忆。只输出 JSON：\n` +
			'{"memories":[{"who":"这件事是谁说的（署名）","about":"说的是别人时填那个人的署名，否则空","kind":"fact|event|feeling","content":"一句完整的话，写清楚是谁","importance":1到5,"emotion":-2到2,"private":true或false,"replaces":被它更新的旧记忆编号或null}],' +
			'"outdated":[{"id":旧记忆编号,"reason":"..."}],' +
			'"self":[{"content":"我（她自己）这次说的关于自己的经历 / 喜好 / 答应别人的事，第一人称","importance":1到3}],' +
			'"summary":"这段聊天一句话小结（≤60 字，写清楚和谁聊了什么）",' +
			'"people":[{"who":"署名","affinity":-5到5的整数,"mood":"她现在对这个人的情绪（开心/感动/想念/担心/委屈/生气/失落），没明显变化就空","moodReason":"..."}]}\n' +
			'规则：只记以后聊天用得上的（身份、喜好、计划、经历、重要的人、情绪起伏），寒暄、玩笑、表情不记；已有记忆里有的不要重复，同一件事有了新情况就用 replaces 指向旧的；' +
			'被这次聊天明确推翻的旧记忆放进 outdated；' + (isGroup ? '' : PRIVATE_HINT + '；') +
			'self 只记她自己说过的、以后要前后一致的话；affinity 表示这段聊天让她对这个人更亲近（正）还是更疏远（负），普通聊天给 0 或 1。\n' +
			`已有记忆：\n${knownText || '（没有）'}\n聊天：\n${text}`;
		const out = await this.callLlm(prompt, { maxTokens: 1200, feature: 'extract' });
		if (out === null) return null;
		const m = String(out).match(/\{[\s\S]*\}/);
		if (!m) return null;
		let parsed;
		try { parsed = JSON.parse(m[0]); } catch { return null; }

		const channel = isGroup ? 'qq-group' : channelId.startsWith('bili:') ? 'bili-private' : channelId.startsWith('douyin:') ? 'douyin-private' : 'qq-private';
		const ownerOfName = (name) => {
			const n = String(name ?? '').trim();
			if (n === '') return null;
			if (owners.has(n)) return owners.get(n);
			return this.findOwnerByName?.(n) ?? null;
		};
		const single = ownerIds.length === 1 ? ownerIds[0] : null;
		const result = { added: 0, refreshed: 0, replaced: 0, outdated: 0, self: 0, summary: '', people: [] };
		const db = this.db;
		db.exec('BEGIN');
		try {
			for (const x of (Array.isArray(parsed.memories) ? parsed.memories : []).slice(0, 8)) {
				const content = String(x?.content ?? '').trim().slice(0, 300);
				if (content === '') continue;
				const ownerId = ownerOfName(x.who) ?? single;
				if (!ownerId || !ownerIds.includes(ownerId)) continue;
				const aboutId = String(x.about ?? '').trim() ? ownerOfName(x.about) : null;
				const dup = nearDuplicateSync(db, ownerId, content);
				if (dup) {
					db.prepare('UPDATE memory SET updated_at = ?, importance = MAX(importance, ?) WHERE id = ?').run(now, Math.round(Number(x.importance) || 1), dup.id);
					result.refreshed++;
					continue;
				}
				const kind = ['fact', 'event', 'feeling'].includes(x.kind) ? x.kind : 'fact';
				const id = insertMemory(db, this.worker, {
					ownerId, channel, channelId, kind, content, importance: x.importance, emotion: x.emotion,
					private: !isGroup && x.private === true, about: aboutId && aboutId !== ownerId ? aboutId : null, evidence: '聊完自动记'
				}, now);
				result.added++;
				const old = known.get(Number(x.replaces));
				if (old && old.owner_id === ownerId && (old.importance ?? 1) < 5) {
					db.prepare("UPDATE memory SET status = 'superseded', valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(now, id, now, old.id);
					db.prepare('DELETE FROM vec WHERE memory_id = ?').run(old.id);
					known.delete(old.id);
					result.replaced++;
				}
			}
			for (const o of (Array.isArray(parsed.outdated) ? parsed.outdated : []).slice(0, 3)) {
				const old = known.get(Number(o?.id));
				if (!old || old.owner_id === 'self' || (old.importance ?? 1) >= 5) continue;
				db.prepare("UPDATE memory SET status = 'outdated', valid_to = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(now, now, old.id);
				db.prepare('DELETE FROM vec WHERE memory_id = ?').run(old.id);
				result.outdated++;
			}
			const withWho = isGroup ? '在群里' : `跟${[...owners.keys()][0]}聊天时`;
			for (const s of (Array.isArray(parsed.self) ? parsed.self : []).slice(0, 3)) {
				const content = String(s?.content ?? '').trim().slice(0, 200);
				if (content === '' || nearDuplicateSync(db, 'self', content)) continue;
				insertMemory(db, this.worker, { ownerId: 'self', channel, channelId, kind: 'fact', content, importance: Math.min(3, Number(s.importance) || 2), evidence: `${withWho}说的` }, now);
				result.self++;
			}
			const summary = String(parsed.summary ?? '').trim().slice(0, 120);
			if (summary !== '') {
				insertMemory(db, this.worker, { ownerId: isGroup ? `group:${channelId.slice(6)}` : single ?? ownerIds[0], channel, channelId, kind: 'episode', content: summary, importance: 2, evidence: '聊完小结', private: !isGroup }, now);
				result.summary = summary;
			}
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
		for (const p of (Array.isArray(parsed.people) ? parsed.people : []).slice(0, 6)) {
			const ownerId = ownerOfName(p?.who) ?? single;
			if (!ownerId || !ownerIds.includes(ownerId)) continue;
			const s = settleAffinity(db, ownerId.replace(/^user:/, ''), p.affinity, now);
			const mood = p.mood ? setMood(db, ownerId, { label: p.mood, reason: p.moodReason }, now) : null;
			result.people.push({ ownerId, affinity: s?.affinity ?? null, stage: s?.stage ?? null, stageChanged: s?.changed === true, mood: mood?.label ?? '' });
		}
		this.last = { at: Date.now(), channelId, title: this.titleOf?.(channelId) ?? channelId, lines: lines.length, ...result };
		setKv(db, 'digest.last', this.last);
		const total = result.added + result.self;
		this.note?.('digest', { channelId, reason: `聊完记了 ${total} 条${result.replaced ? `，更新 ${result.replaced} 条` : ''}${result.summary ? `：${result.summary}` : ''}` });
		return result;
	}
}
