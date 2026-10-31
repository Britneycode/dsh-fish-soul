/**
 * routes-soul.js —— v0.6 的路由（routes.js 转进来）：
 *  - 记忆纠正：改一条（旧的标 superseded、留着能恢复）、手动加一条、恢复被 Dream 判过时 / 改掉的、立刻整理一次；
 *  - 人物：画像（关系 / 称呼 / 印象 / 各平台身份 / 统计），主人可改关系阶段和印象（改了就锁住，Dream 不再动）；
 *  - 动态："为什么回 / 为什么没回 / 想起了什么"、Dream 的改动记录、暂停中的聊天；暂停 / 恢复某个聊天；
 *  - 备份：状态、立刻备份、自动备份开关；导出全部记忆（JSON，能原样导回）；
 *  - 聊天记录导入：预览 → 开始 → 进度 → 取消。
 */
import { getProfile, setProfile, getKv } from './db.js';
import { tokenizeForBm25 } from './segment.js';
import { platformOf } from './gateway.js';
import { STAGES, PROFILE_FIELDS, stageBase, effectiveAffinity, getMood, mergeProfileFields, digestConfig } from './soul-memory.js';

const KINDS = ['fact', 'event', 'feeling', 'episode'];
const IMPORT_BODY_MAX = 40 * 1024 * 1024;

const ownerToCanonical = (ownerId) => String(ownerId ?? '').replace(/^user:/, '');

function memoryView(m) {
	return {
		id: m.id, ownerId: m.owner_id, channel: m.channel, channelId: m.channel_id, kind: m.kind, content: m.content,
		importance: m.importance, emotion: m.emotion, createdAt: m.created_at, updatedAt: m.updated_at, status: m.status,
		supersededBy: m.superseded_by ?? null, evidence: m.evidence ?? '', source: sourceLabel(m.source_session),
		visibility: m.visibility ?? 'normal', about: m.about ?? null
	};
}

/** source_session → 给人看的出处。 */
export function sourceLabel(src) {
	const s = String(src ?? '');
	if (s === 'import') return '导入（记忆文件）';
	if (s === 'history-import') return '导入（聊天记录）';
	if (s === 'manual') return '主人手动加的';
	if (s === '') return '没回的消息';
	return '聊天里记的';
}

/**
 * @returns {Promise<boolean>} 处理了就返回 true
 */
export async function handleSoulRoute({ method, path, url, req, res, send, readBody, sameOrigin, deps }) {
	const { db, clock, worker, life, gateway, backup, historyImporter, getConfig, saveConfig, journal, digester } = deps;
	const post = method === 'POST';
	const body = async () => {
		const raw = await readBody(req);
		if (raw.length > IMPORT_BODY_MAX) throw new Error('文件太大（上限 40 MB），拆开再导');
		return JSON.parse(raw || '{}');
	};
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };

	// ── 人物画像 ──
	if (path === '/inspector/person' && method === 'GET') {
		const ownerId = String(url.searchParams.get('ownerId') ?? '');
		const p = db.prepare('SELECT * FROM person WHERE canonical_id = ?').get(ownerToCanonical(ownerId));
		if (!p) { send(200, { ok: false, error: '没有这个人' }); return true; }
		const counts = Object.fromEntries(db.prepare(`
			SELECT kind, COUNT(*) AS n FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND status = 'active' AND valid_to IS NULL GROUP BY kind
		`).all(ownerId).map((r) => [r.kind, r.n]));
		const outdated = db.prepare(`
			SELECT * FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND status IN ('outdated', 'superseded', 'archived')
			ORDER BY updated_at DESC LIMIT 30
		`).all(ownerId).map(memoryView);
		const pendings = db.prepare("SELECT id, due_at, reason FROM pending WHERE owner_id = ? AND status = 'pending' ORDER BY due_at LIMIT 20").all(ownerId)
			.map((x) => ({ id: x.id, dueAt: x.due_at, reason: x.reason }));
		const episodes = db.prepare(`
			SELECT id, content, channel_id, created_at FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND kind = 'episode' AND status = 'active'
			ORDER BY created_at DESC LIMIT 5
		`).all(ownerId).map((x) => ({ id: x.id, content: x.content, channelId: x.channel_id, at: x.created_at }));
		const now = clock.now();
		const prof = getProfile(db, ownerId);
		send(200, {
			ok: true,
			person: {
				ownerId, canonicalId: p.canonical_id, displayName: p.display_name, relationStage: p.relation_stage,
				qqUin: p.qq_uin ?? null, biliUid: p.bili_uid ?? null, douyinName: p.douyin_uid ?? null,
				interactionCount: p.interaction_count, firstSeenAt: p.first_seen_at, lastSeenAt: p.last_seen_at,
				affinity: effectiveAffinity(p, now), stageLocked: Number(p.stage_locked ?? 0) === 1 || p.canonical_id === 'master'
			},
			profile: prof, profileFields: prof?.fields ?? {}, lockedFields: prof?.lockedFields ?? [],
			fieldDefs: PROFILE_FIELDS.map(([id, label]) => ({ id, label })),
			mood: getMood(db, ownerId, now), episodes, counts, outdated, pendings
		});
		return true;
	}
	if (path === '/inspector/person' && post) {
		if (!guard()) return true;
		const b = await body();
		const ownerId = String(b.ownerId ?? '');
		const cid = ownerToCanonical(ownerId);
		const p = db.prepare('SELECT * FROM person WHERE canonical_id = ?').get(cid);
		if (!p) { send(200, { ok: false, error: '没有这个人' }); return true; }
		if (typeof b.displayName === 'string' && b.displayName.trim() !== '') db.prepare('UPDATE person SET display_name = ? WHERE canonical_id = ?').run(b.displayName.trim().slice(0, 40), cid);
		if (b.relationStage !== undefined) {
			if (!STAGES.includes(b.relationStage)) { send(200, { ok: false, error: '关系阶段不对' }); return true; }
			// 主人手动定的阶段：锁住，之后好感只涨跌、不自动升降
			if (b.relationStage !== p.relation_stage) db.prepare('UPDATE person SET relation_stage = ?, stage_locked = 1, affinity = ?, affinity_at = ? WHERE canonical_id = ?').run(b.relationStage, stageBase(b.relationStage), clock.now(), cid);
			else db.prepare('UPDATE person SET stage_locked = 1 WHERE canonical_id = ?').run(cid);
		}
		if (b.stageLocked === false) db.prepare('UPDATE person SET stage_locked = 0 WHERE canonical_id = ?').run(cid);
		if (b.profileFields && typeof b.profileFields === 'object') {
			const prof = mergeProfileFields(db, ownerId, b.profileFields, 'user');
			const p2 = db.prepare('SELECT * FROM person WHERE canonical_id = ?').get(cid);
			send(200, { ok: true, profile: prof, profileFields: prof?.fields ?? {}, lockedFields: prof?.lockedFields ?? [], stageLocked: Number(p2.stage_locked ?? 0) === 1 });
			return true;
		}
		if (typeof b.profile === 'string') setProfile(db, ownerId, { text: b.profile, by: 'user', locked: b.profileLocked !== false, updatedAt: Date.now() });
		else if (b.profileLocked === false) {
			const cur = getProfile(db, ownerId);
			if (cur) setProfile(db, ownerId, { ...cur, locked: false });
		}
		const p2 = db.prepare('SELECT stage_locked FROM person WHERE canonical_id = ?').get(cid);
		send(200, { ok: true, profile: getProfile(db, ownerId), stageLocked: Number(p2?.stage_locked ?? 0) === 1 });
		return true;
	}
	// 立刻整理一次（生成 / 刷新印象）
	if (path === '/inspector/dream' && post) {
		if (!guard()) return true;
		const b = await body();
		const ownerId = String(b.ownerId ?? '');
		if (!db.prepare('SELECT 1 FROM person WHERE canonical_id = ?').get(ownerToCanonical(ownerId))) { send(200, { ok: false, error: '没有这个人' }); return true; }
		if (life?.isDreamRunning) { send(200, { ok: false, error: '正在整理别人，稍等' }); return true; }
		await life.runDream(ownerId);
		send(200, { ok: true, profile: getProfile(db, ownerId) });
		return true;
	}

	// ── 契约 34–35：聊完自动记（状态 / 设置 / 现在整理）──
	const memState = () => {
		const m = getConfig().memory ?? {};
		const c = digestConfig({ enabled: m.autoExtract, idleMinutes: m.idleMinutes, maxLines: m.maxLines });
		return { ok: true, autoExtract: c.enabled, idleMinutes: c.idleMinutes, maxLines: c.maxLines, pending: journal?.pendingCount() ?? 0, running: digester?.running === true, last: digester?.last ?? getKv(db, 'digest.last', null) };
	};
	if (path === '/memory/state' && method === 'GET') { send(200, memState()); return true; }
	if (path === '/memory/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const s = {};
		if (b.autoExtract !== undefined) s.autoExtract = b.autoExtract === true;
		if (b.idleMinutes !== undefined && Number.isFinite(Number(b.idleMinutes))) s.idleMinutes = Math.min(240, Math.max(1, Math.floor(Number(b.idleMinutes))));
		if (b.maxLines !== undefined && Number.isFinite(Number(b.maxLines))) s.maxLines = Math.min(80, Math.max(10, Math.floor(Number(b.maxLines))));
		saveConfig({ memory: s });
		send(200, memState());
		return true;
	}
	if (path === '/memory/digest-now' && post) {
		if (!guard()) return true;
		if (!digester) { send(200, { ok: false, error: '整理没启动' }); return true; }
		if (digester.running) { send(200, { ok: false, error: '正在整理，稍等' }); return true; }
		const ids = [...(journal?.chats?.keys() ?? [])];
		let added = 0; let chats = 0;
		for (const id of ids) {
			const r = await digester.digest(id);
			if (r) { chats += 1; added += (r.added ?? 0) + (r.self ?? 0); }
		}
		send(200, { ...memState(), chats, added });
		return true;
	}

	// ── 记忆纠正 ──
	if (path === '/inspector/memory-edit' && post) {
		if (!guard()) return true;
		const b = await body();
		const id = Number(b.id);
		const m = db.prepare("SELECT * FROM memory WHERE id = ? AND status = 'active'").get(id);
		if (!m) { send(200, { ok: false, error: `没有找到记忆 #${b.id}` }); return true; }
		const content = typeof b.content === 'string' ? b.content.trim().slice(0, 500) : m.content;
		if (content === '') { send(200, { ok: false, error: '内容不能为空（要删就点删除）' }); return true; }
		const kind = KINDS.includes(b.kind) ? b.kind : m.kind;
		const importance = b.importance === undefined ? m.importance : Math.min(5, Math.max(1, Math.round(Number(b.importance)) || 1));
		const now = clock.now();
		if (content === m.content) {
			db.prepare('UPDATE memory SET kind = ?, importance = ?, updated_at = ? WHERE id = ?').run(kind, importance, now, id);
			send(200, { ok: true, id });
			return true;
		}
		// 内容改了：新写一条，旧的标 superseded（留着出处，能恢复）
		let newId = 0;
		db.exec('BEGIN');
		try {
			const r = db.prepare(`
				INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion,
				                    source_session, created_at, updated_at, status, evidence)
				VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 'active', ?)
			`).run(m.owner_id, m.channel, m.channel_id, kind, content, tokenizeForBm25(content), importance, m.emotion, m.created_at, now,
				`主人在设置页改过（原来是：${m.content.slice(0, 120)}）`);
			newId = Number(r.lastInsertRowid);
			db.prepare("UPDATE memory SET status = 'superseded', valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?").run(now, newId, now, id);
			db.prepare('DELETE FROM vec WHERE memory_id = ?').run(id);
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
		worker.enqueueRealtime(newId, content);
		send(200, { ok: true, id: newId, replaced: id });
		return true;
	}
	if (path === '/inspector/memory-add' && post) {
		if (!guard()) return true;
		const b = await body();
		const ownerId = String(b.ownerId ?? '');
		const content = String(b.content ?? '').trim().slice(0, 500);
		if (content === '') { send(200, { ok: false, error: '内容为空' }); return true; }
		if (ownerId !== 'self' && !db.prepare('SELECT 1 FROM person WHERE canonical_id = ?').get(ownerToCanonical(ownerId))) { send(200, { ok: false, error: '先选一个人' }); return true; }
		const p = db.prepare('SELECT qq_uin FROM person WHERE canonical_id = ?').get(ownerToCanonical(ownerId));
		const now = clock.now();
		const r = db.prepare(`
			INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion,
			                    source_session, created_at, updated_at, status, evidence)
			VALUES ('feiyu', ?, 'manual', ?, ?, ?, ?, ?, 0, 'manual', ?, ?, 'active', '主人在设置页加的')
		`).run(ownerId, p?.qq_uin ? `private:${p.qq_uin}` : '', KINDS.includes(b.kind) ? b.kind : 'fact', content, tokenizeForBm25(content),
			Math.min(5, Math.max(1, Math.round(Number(b.importance ?? 3)) || 3)), now, now);
		worker.enqueueRealtime(Number(r.lastInsertRowid), content);
		send(200, { ok: true, id: Number(r.lastInsertRowid) });
		return true;
	}
	if (path === '/inspector/memory-restore' && post) {
		if (!guard()) return true;
		const b = await body();
		const id = Number(b.id);
		const m = db.prepare("SELECT * FROM memory WHERE id = ? AND status IN ('outdated', 'superseded', 'archived')").get(id);
		if (!m) { send(200, { ok: false, error: `#${b.id} 不用恢复` }); return true; }
		db.prepare("UPDATE memory SET status = 'active', valid_to = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?").run(clock.now(), id);
		worker.enqueueRealtime(id, m.content);
		send(200, { ok: true, id });
		return true;
	}

	// ── 动态 / 暂停 ──
	if (path === '/activity' && method === 'GET') {
		const paused = gateway?.pausedMap() ?? {};
		send(200, {
			ok: true,
			decisions: (gateway?.decisions ?? []).slice(0, 150),
			dreamLog: (getKv(db, 'dream.log', []) ?? []).slice(0, 20),
			paused: Object.entries(paused).map(([channelId, until]) => ({ channelId, until, title: gateway?.titleOf(channelId) ?? channelId }))
		});
		return true;
	}
	if (path === '/sessions/pause' && post) {
		if (!guard()) return true;
		const b = await body();
		const channelId = String(b.channelId ?? '');
		if (!/^(private|group|bili|douyin):./.test(channelId)) { send(200, { ok: false, error: '聊天 id 不对' }); return true; }
		const until = gateway?.setPaused(channelId, Number(b.minutes ?? -1)) ?? null;
		gateway?.note(until === null ? 'resumed' : 'paused', { channelId, reason: until === null ? '设置页恢复' : '设置页暂停' });
		send(200, { ok: true, channelId, until, platform: platformOf(channelId) });
		return true;
	}

	// ── 备份 / 导出 ──
	if (path === '/backup/state' && method === 'GET') {
		send(200, { ok: true, ...(backup?.state() ?? {}) });
		return true;
	}
	if (path === '/backup/now' && post) {
		if (!guard()) return true;
		const r = backup.backupNow();
		send(200, { ok: true, ...r });
		return true;
	}
	if (path === '/backup/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const cur = getConfig().backup ?? {};
		saveConfig({ backup: { auto: b.auto === undefined ? cur.auto !== false : b.auto === true, keep: Math.min(60, Math.max(1, Math.floor(Number(b.keep ?? cur.keep ?? 7)) || 7)) } });
		send(200, { ok: true, ...(backup?.state() ?? {}) });
		return true;
	}
	if (path === '/export/memories' && method === 'GET') {
		const rows = db.prepare(`
			SELECT m.*, p.qq_uin, p.display_name FROM memory m LEFT JOIN person p ON p.canonical_id = substr(m.owner_id, 6)
			WHERE m.character_id = 'feiyu' AND m.status = 'active' AND m.valid_to IS NULL ORDER BY m.id
		`).all();
		const items = rows.map((m) => ({
			ownerId: m.owner_id, ...(m.qq_uin ? { qqUin: m.qq_uin } : {}), ...(m.display_name ? { nickname: m.display_name } : {}),
			content: m.content, kind: m.kind, importance: m.importance, emotion: m.emotion, channel: m.channel, channelId: m.channel_id,
			createdAt: m.created_at, ...(m.evidence ? { evidence: m.evidence } : {})
		}));
		const d = new Date();
		const name = `fish-soul-memories-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
		res.end(JSON.stringify(items, null, 1));
		return true;
	}

	// ── 聊天记录导入 ──
	if (path === '/import/history/preview' && post) {
		if (!guard()) return true;
		const b = await body();
		send(200, { ok: true, ...historyImporter.preview({ text: String(b.text ?? ''), fileName: String(b.fileName ?? ''), dbPath: String(b.dbPath ?? '') }) });
		return true;
	}
	if (path === '/import/history/start' && post) {
		if (!guard()) return true;
		const b = await body();
		const job = historyImporter.start({
			previewId: String(b.previewId ?? ''), selfKeys: Array.isArray(b.selfKeys) ? b.selfKeys.map(String) : [],
			mapping: b.mapping && typeof b.mapping === 'object' ? b.mapping : {}, maxCalls: b.maxCalls
		});
		send(200, { ok: true, job });
		return true;
	}
	if (path === '/import/history/state' && method === 'GET') {
		send(200, { ok: true, job: historyImporter?.state() ?? null });
		return true;
	}
	if (path === '/import/history/cancel' && post) {
		if (!guard()) return true;
		historyImporter?.cancel();
		send(200, { ok: true });
		return true;
	}
	return false;
}
