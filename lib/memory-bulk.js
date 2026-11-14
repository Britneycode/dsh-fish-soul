/**
 * memory-bulk.js —— 记忆批量操作（设置页「记忆」里勾选多条 / 按筛选条件一次处理）。
 *
 * 选法：ids（勾的那几条）或 filter（某个人 / 内容包含 / 来源），二选一；按筛选最多一次 5000 条。
 * 动作：forget（删 = 标 archived + 清向量，能在人物卡「改掉 / 过时的」里恢复）、restore（恢复删掉 / 过时的）、
 *       importance（1~5）、kind（事实 / 事件 / 感受 / 聊过）、visibility（normal / private）。
 * dryRun 只数会动到几条，不改。
 */
export const KINDS = ['fact', 'event', 'feeling', 'episode'];
export const SOURCES = {
	chat: "COALESCE(source_session, '') NOT IN ('import', 'history-import', 'manual', 'weekly', '')",
	import: "source_session = 'import'",
	'history-import': "source_session = 'history-import'",
	manual: "source_session = 'manual'",
	weekly: "kind = 'weekly'"
};
const MAX_IDS = 1000;
const MAX_FILTER = 5000;

/** 筛选条件 → WHERE（只认白名单字段；内容包含用 instr，不拼用户输入）。 */
export function filterWhere(filter = {}, { archived = false } = {}) {
	const where = ["character_id = 'feiyu'", archived ? "status IN ('archived', 'outdated', 'superseded')" : "status = 'active' AND valid_to IS NULL"];
	const params = [];
	if (filter.ownerId && filter.ownerId !== 'all') { where.push('owner_id = ?'); params.push(String(filter.ownerId)); }
	const q = String(filter.q ?? '').trim();
	if (q !== '') { where.push('instr(content, ?) > 0'); params.push(q.slice(0, 100)); }
	if (filter.source && SOURCES[filter.source]) where.push(`(${SOURCES[filter.source]})`);
	if (filter.visibility === 'private' || filter.visibility === 'normal') { where.push('visibility = ?'); params.push(filter.visibility); }
	return { sql: where.join(' AND '), params, narrowed: where.length > 2 };
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync, clock: {now(): number}, worker: {enqueueRealtime(id: number, text: string): void},
 *   ids?: number[], filter?: object, action: string, value?: any, dryRun?: boolean}} opts
 * @returns {{ok: true, matched: number, changed: number, ids: number[]} | {ok: false, error: string}}
 */
export function bulkMemory({ db, clock, worker, ids, filter, action, value, dryRun = false }) {
	const restore = action === 'restore';
	let rows;
	if (Array.isArray(ids)) {
		const list = [...new Set(ids.map(Number).filter(Number.isInteger))];
		if (list.length === 0) return { ok: false, error: '一条都没选' };
		if (list.length > MAX_IDS) return { ok: false, error: `一次最多 ${MAX_IDS} 条` };
		const status = restore ? "status IN ('archived', 'outdated', 'superseded')" : "status = 'active' AND valid_to IS NULL";
		rows = db.prepare(`SELECT id, content, kind FROM memory WHERE character_id = 'feiyu' AND ${status} AND id IN (${list.map(() => '?').join(',')})`).all(...list);
	} else if (filter && typeof filter === 'object') {
		const { sql, params, narrowed } = filterWhere(filter, { archived: restore });
		if (!narrowed) return { ok: false, error: '按条件批量至少要选一个人、来源或输入要包含的字（防止误删全部）' };
		rows = db.prepare(`SELECT id, content, kind FROM memory WHERE ${sql} ORDER BY id DESC LIMIT ${MAX_FILTER + 1}`).all(...params);
		if (rows.length > MAX_FILTER) return { ok: false, error: `符合条件的超过 ${MAX_FILTER} 条，条件再收窄一点` };
	} else return { ok: false, error: '要么勾选几条，要么给筛选条件' };

	let set = null;
	if (action === 'importance') {
		const n = Math.round(Number(value));
		if (!(n >= 1 && n <= 5)) return { ok: false, error: '重要度是 1~5' };
		set = ['importance = ?, importance_locked = 1, importance_auto_recalled = 0', n];
	} else if (action === 'kind') {
		if (!KINDS.includes(value)) return { ok: false, error: '类型不对' };
		set = ['kind = ?', value];
	} else if (action === 'visibility') {
		if (value !== 'private' && value !== 'normal') return { ok: false, error: '只能是 private / normal' };
		set = ['visibility = ?', value];
	} else if (action !== 'forget' && action !== 'restore') return { ok: false, error: `不认识的操作：${action}` };

	if (action !== 'forget') rows = rows.filter((r) => r.kind !== 'weekly'); // 派生周记不允许更改范围、类型或恢复
	const matched = rows.map((r) => r.id);
	if (dryRun || rows.length === 0) return { ok: true, matched: rows.length, changed: 0, ids: matched.slice(0, 50) };
	const now = clock.now();
	db.exec('BEGIN');
	try {
		if (action === 'forget') {
			const archive = db.prepare("UPDATE memory SET status = 'archived', valid_to = ?, updated_at = ? WHERE id = ?");
			const dropVec = db.prepare('DELETE FROM vec WHERE memory_id = ?');
			for (const id of matched) { archive.run(now, now, id); dropVec.run(id); }
		} else if (restore) {
			const up = db.prepare("UPDATE memory SET status = 'active', valid_to = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?");
			for (const id of matched) up.run(now, id);
		} else {
			const up = db.prepare(`UPDATE memory SET ${set[0]}, updated_at = ? WHERE id = ?`);
			for (const id of matched) up.run(set[1], now, id);
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
	if (restore) for (const r of rows) worker.enqueueRealtime(r.id, r.content);
	return { ok: true, matched: rows.length, changed: rows.length, ids: matched.slice(0, 50) };
}
