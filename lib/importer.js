/**
 * importer.js —— 记忆批量导入（零回退迁移的第一步：旧插件 / 其他工具积累的记忆不能在切换当天清零）。
 *
 * 输入是一个宽松的 JSON 数组，兼容常见字段名（content/text/memory，created_at/createdAt/timestamp）。
 * 去重：同 owner + 同 content 的 active 记忆不重复写入。导入后进实时向量队列，后台补 embedding。
 */
import { tokenizeForBm25 } from './segment.js';

const KINDS = new Set(['fact', 'event', 'feeling']);

function toMs(v, fallback) {
	if (v === undefined || v === null || v === '') return fallback;
	const n = Number(v);
	if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n; // 秒 → 毫秒
	const parsed = Date.parse(String(v));
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function ensurePerson(db, qqUin, nickname, nowMs, masterQqUin) {
	const isMaster = masterQqUin !== '' && qqUin === masterQqUin;
	const existing = db.prepare('SELECT canonical_id FROM person WHERE qq_uin = ?').get(qqUin);
	if (existing !== undefined) return existing.canonical_id;
	const id = isMaster ? 'master' : `p_${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
	db.prepare(`
		INSERT INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES (?, ?, ?, ?, 0, ?, ?)
		ON CONFLICT(canonical_id) DO UPDATE SET qq_uin = COALESCE(person.qq_uin, excluded.qq_uin)
	`).run(id, qqUin, nickname || '未知用户', isMaster ? 'close' : 'stranger', nowMs, nowMs);
	return id;
}

export function importMemories({ db, clock, worker, items, dryRun = false, masterQqUin = '' }) {
	const nowMs = clock.now();
	const report = { total: items.length, inserted: 0, duplicates: 0, skipped: 0, errors: [] };
	const exists = db.prepare(`
		SELECT 1 FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND content = ? AND status = 'active' LIMIT 1
	`);
	const insert = db.prepare(`
		INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
		                    importance, emotion, source_session, created_at, updated_at, status)
		VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, 'active')
	`);
	const queued = [];
	db.exec('BEGIN');
	try {
		items.forEach((it, i) => {
			const content = String(it?.content ?? it?.text ?? it?.memory ?? '').trim();
			if (content === '') { report.skipped += 1; return; }
			let ownerId = typeof it.ownerId === 'string' && it.ownerId !== '' ? it.ownerId : null;
			const qq = String(it.qqUin ?? it.qq ?? it.userId ?? '').trim();
			if (ownerId === null && qq !== '') ownerId = `user:${ensurePerson(db, qq, it.nickname, nowMs, masterQqUin)}`;
			if (ownerId === null) { report.skipped += 1; report.errors.push(`#${i}: 缺少 ownerId / qqUin`); return; }
			if (exists.get(ownerId, content) !== undefined) { report.duplicates += 1; return; }
			const createdAt = Math.min(nowMs, toMs(it.createdAt ?? it.created_at ?? it.timestamp, nowMs));
			const kind = KINDS.has(it.kind) ? it.kind : 'fact';
			const importance = Math.min(5, Math.max(1, Number(it.importance ?? 2) || 2));
			const emotion = Math.min(2, Math.max(-2, Number(it.emotion ?? 0) || 0));
			const channel = String(it.channel ?? (ownerId === 'self' ? 'qq-private' : 'qq-private'));
			const channelId = String(it.channelId ?? it.channel_id ?? (qq !== '' ? `private:${qq}` : ''));
			if (!dryRun) {
				const r = insert.run(ownerId, channel, channelId, kind, content, tokenizeForBm25(content),
					importance, emotion, createdAt, createdAt);
				queued.push([Number(r.lastInsertRowid), content]);
			}
			report.inserted += 1;
		});
		if (dryRun) db.exec('ROLLBACK'); else db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
	for (const [id, content] of queued) worker.enqueueRealtime(id, content);
	return { ...report, dryRun };
}
