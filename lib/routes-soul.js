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

import { bulkMemory } from './memory-bulk.js';
import { dateCompact } from './time-util.js';

const KINDS = ['fact', 'event', 'feeling', 'episode'];
const IMPORT_BODY_MAX = 40 * 1024 * 1024;

const ownerToCanonical = (ownerId) => String(ownerId ?? '').replace(/^user:/, '');

function memoryView(m) {
	return {
		id: m.id, ownerId: m.owner_id, channel: m.channel, channelId: m.channel_id, kind: m.kind, content: m.content,
		importance: m.importance, importanceLocked: m.importance_locked === 1, importanceAutoRecalled: m.importance_auto_recalled === 1, emotion: m.emotion, createdAt: m.created_at, updatedAt: m.updated_at, status: m.status,
		supersededBy: m.superseded_by ?? null, evidence: m.evidence ?? '', source: sourceLabel(m.source_session, m.channel),
		visibility: m.visibility ?? 'normal', about: m.about ?? null
	};
}

/**
 * source_session → 给人看的出处。
 *
 * `source_session` 为空的不只有「没回的消息」：刷视频写记忆（`browse.js` / `douyin-browse.js`）
 * 也是空的，以前一律标成「没回的消息」，她自己刷到的视频被标成"一条没回的消息"，
 * 界面上（连她自己看到这段时）都会误读。空的时候按 channel 分：#78 里就是这么被带偏的。
 * @param {string} src memory.source_session
 * @param {string} [channel] memory.channel（bili / douyin 是刷视频，*-private 是私信）
 */
export function sourceLabel(src, channel = '') {
	const s = String(src ?? '');
	if (s === 'import') return '导入（记忆文件）';
	if (s === 'history-import') return '导入（聊天记录）';
	if (s === 'manual') return '主人手动加的';
	if (s === 'weekly') return '周记';
	if (s === '') {
		const ch = String(channel ?? '');
		if (ch === 'bili') return '自己刷B站时记的';
		if (ch === 'douyin') return '自己刷抖音时记的';
		// 日记这类她自己写的：也不是「没回的消息」
		if (ch === 'self') return '她自己记的';
		return '没回的消息';
	}
	return '聊天里记的';
}

/**
 * @returns {Promise<boolean>} 处理了就返回 true
 */
export async function handleSoulRoute({ method, path, url, req, res, send, readBody, sameOrigin, deps }) {
	const { db, clock, worker, life, gateway, backup, historyImporter, getConfig, saveConfig, journal, digester, weekly, storage, chatArchive, diag } = deps;
	const post = method === 'POST';
	const body = async () => {
		const raw = await readBody(req);
		if (raw.length > IMPORT_BODY_MAX) throw new Error('文件太大（上限 40 MB），拆开再导');
		return JSON.parse(raw || '{}');
	};
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };

	// 鱼自己的记忆没有 person 行，单独读取旧档，不伪造人物或关系。
	if (path === '/inspector/self-outdated' && method === 'GET') {
		const offset = Math.min(1000000, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0)));
		const where = "character_id = 'feiyu' AND owner_id = 'self' AND status IN ('outdated', 'superseded', 'archived')";
		const total = db.prepare(`SELECT COUNT(*) AS n FROM memory WHERE ${where}`).get().n;
		const items = db.prepare(`SELECT * FROM memory WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT 30 OFFSET ?`).all(offset).map(memoryView);
		send(200, { ok: true, total, items }); return true;
	}

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
	// 「整理时对照聊天原文」的配置（回显和保存两侧都要有 —— 少一边就是
	// 「写进去了但读不出来」，上次「允许发表情」就是这个形态）
	const transcriptCfg = (m) => ({
		transcriptReview: m.transcriptReview === true,
		transcriptMaxLines: Math.min(200, Math.max(1, Math.floor(Number(m.transcriptMaxLines) || 40))),
	});
	const memState = () => {
		const m = getConfig().memory ?? {};
		const c = digestConfig({ enabled: m.autoExtract, idleMinutes: m.idleMinutes, maxLines: m.maxLines });
		return {
			ok: true, autoExtract: c.enabled, idleMinutes: c.idleMinutes, maxLines: c.maxLines,
			...transcriptCfg(m), // 让设置页读得到；也让人从接口能看出这个开关的样子
			pending: journal?.pendingCount() ?? 0, running: digester?.running === true,
			last: digester?.last ?? getKv(db, 'digest.last', null),
		};
	};
	if (path === '/memory/state' && method === 'GET') { send(200, memState()); return true; }
	if (path === '/memory/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const s = {};
		if (b.autoExtract !== undefined) s.autoExtract = b.autoExtract === true;
		if (b.idleMinutes !== undefined && Number.isFinite(Number(b.idleMinutes))) s.idleMinutes = Math.min(240, Math.max(1, Math.floor(Number(b.idleMinutes))));
		if (b.maxLines !== undefined && Number.isFinite(Number(b.maxLines))) s.maxLines = Math.min(80, Math.max(10, Math.floor(Number(b.maxLines))));
		if (b.transcriptReview !== undefined) s.transcriptReview = b.transcriptReview === true;
		if (b.transcriptMaxLines !== undefined && Number.isFinite(Number(b.transcriptMaxLines))) s.transcriptMaxLines = Math.min(200, Math.max(1, Math.floor(Number(b.transcriptMaxLines))));
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

	if (path === '/memory/weekly/state' && method === 'GET') { send(200, weekly?.state() ?? { ok: false, error: '周记未启动' }); return true; }
	if (path === '/memory/weekly/config' && post) {
		if (!guard()) return true;
		const b = await body();
		if (typeof b.enabled !== 'boolean') { send(200, {ok:false, error:'参数不对'}); return true; }
		saveConfig({ memory: { weeklyAuto: b.enabled } });
		send(200, weekly?.state() ?? {ok:false,error:'周记未启动'}); return true;
	}
	if (path === '/memory/weekly/run' && post) {
		if (!guard()) return true;
		send(200, weekly ? await weekly.runOne() : {ok:false,error:'周记未启动'}); return true;
	}
	if (path === '/memory/weekly/sources' && method === 'GET') {
		const id = Number(url.searchParams.get('summaryId'));
		if (!Number.isSafeInteger(id) || !db.prepare("SELECT id FROM memory WHERE id=? AND kind='weekly'").get(id)) { send(200,{ok:false,error:'没有找到周记'}); return true; }
		const sources=db.prepare("SELECT m.id,m.content,m.status,m.visibility FROM weekly_source w JOIN memory m ON m.id=w.source_id WHERE w.summary_id=? ORDER BY m.created_at,m.id").all(id);
		send(200, {ok:true,sources}); return true;
	}

	// 全量数据库存档与容量管理；不清理在线记忆。
	if (path === '/storage/state' && method === 'GET') { send(200,storage?.state() ?? {ok:false,error:'存档未启动'}); return true; }
	if (path === '/storage/config' && post) {
		if (!guard()) return true; const b=await body(); const patch={};
		if (b.auto !== undefined) { if(typeof b.auto!=='boolean'){send(200,{ok:false,error:'参数不对'});return true;} patch.auto=b.auto; }
		if (b.keep !== undefined) { const n=Number(b.keep); if(!Number.isFinite(n)||n<0||n>200||!Number.isInteger(n)){send(200,{ok:false,error:'存档份数须在 0–200（0 = 不限）'});return true;} patch.keep=n; }
		for(const k of ['warnMB','freeMB']) if(b[k]!==undefined) { const n=Number(b[k]);if(!Number.isFinite(n)||n<50||n>1048576){send(200,{ok:false,error:'阈值须在 50–1048576 MB'});return true;}patch[k]=Math.floor(n); }
		saveConfig({storage:patch});send(200,storage?.state() ?? {ok:false,error:'存档未启动'});return true;
	}
	if(path === '/storage/snapshot' && post) { if(!guard())return true;send(200,storage?await storage.snapshot({force:true}):{ok:false,error:'存档未启动'});return true; }
	if(path === '/storage/restore' && post) {if(!guard())return true;const b=await body();send(200,storage&&backup?await storage.stageRestore(String(b.file??''),backup):{ok:false,error:'存档未启动'});return true;}
	if(path === '/storage/delete' && post) {if(!guard())return true;const b=await body();send(200,storage?.remove(String(b.file??''))??{ok:false,error:'存档未启动'});return true;}
	if(path === '/storage/search' && method === 'GET') {
		const query=String(url.searchParams.get('q')??'').trim().slice(0,100), before=Math.max(1,Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER);
		const items=db.prepare("SELECT id,owner_id AS ownerId,kind,status,visibility,content,created_at AS createdAt FROM memory WHERE character_id='feiyu' AND id<? AND (?='' OR instr(content,?)>0) ORDER BY id DESC LIMIT 100").all(before,query,query);
		send(200,{ok:true,items,next:items.length===100?items[items.length-1].id:null});return true;
	}
	// 仅保存已明确选择的会话文本，不声称包含平台的所有历史消息。
	if(path === '/chat-archive/state' && method === 'GET') {send(200,chatArchive?.state()??{ok:false,error:'聊天存档未启动'});return true;}
	if(path === '/chat-archive/list' && method === 'GET') {send(200,chatArchive?.list(String(url.searchParams.get('channel')??''),Math.max(1,Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER))??{ok:false,error:'聊天存档未启动'});return true;}
	if(path === '/chat-archive/delete' && post) {if(!guard())return true;const b=await body();send(200,chatArchive?.remove(String(b.channel??''))??{ok:false,error:'聊天存档未启动'});return true;}
	if(path === '/chat-archive/config' && post) {
		if(!guard())return true;const b=await body();
		if(typeof b.enabled!=='boolean'||!Array.isArray(b.channels)||b.channels.length>30||!Number.isInteger(b.days)||b.days<1||b.days>3650) {send(200,{ok:false,error:'存档设置不正确'});return true;}
		const channels=[...new Set(b.channels.map(x=>typeof x==='string'?x.trim():'').filter(x=>x!==''))];
		// 注意：channels 允许留空（= 所有会话都记）。只有**填了才有格式要求**。
		if(channels.some(x=>x.length>160||!/^(private|group|bili|douyin|douyin-group):\S(?:[^\r\n]*\S)?$/.test(x))) {send(200,{ok:false,error:'请填写有效的会话 ID（留空 = 记所有会话）'});return true;}
		saveConfig({chatArchive:{enabled:b.enabled,channels,days:b.days}});chatArchive?.prune();send(200,chatArchive?.state()??{ok:false,error:'聊天存档未启动'});return true;
	}

	// ── 记忆纠正 ──
	// 手动锁定可阻止自动升重要度，解锁不改变当前数值。
	if (path === '/inspector/importance-lock' && post) {
		if (!guard()) return true;
		const b = await body();
		const id = Number(b.id);
		if (!Number.isSafeInteger(id) || typeof b.locked !== 'boolean') { send(200, { ok: false, error: '参数不对' }); return true; }
		const r = db.prepare("UPDATE memory SET importance_locked = ? WHERE id = ? AND character_id = 'feiyu' AND status = 'active' AND valid_to IS NULL").run(b.locked ? 1 : 0, id);
		send(200, r.changes ? { ok: true } : { ok: false, error: '没有找到记忆' }); return true;
	}
	if (path === '/inspector/memory-edit' && post) {
		if (!guard()) return true;
		const b = await body();
		const id = Number(b.id);
		const m = db.prepare("SELECT * FROM memory WHERE id = ? AND status = 'active'").get(id);
		if (!m) { send(200, { ok: false, error: `没有找到记忆 #${b.id}` }); return true; }
		if (m.kind === 'weekly') { send(200, {ok:false,error:'周记由原记忆生成，不能直接编辑'}); return true; }
		const content = typeof b.content === 'string' ? b.content.trim().slice(0, 500) : m.content;
		if (content === '') { send(200, { ok: false, error: '内容不能为空（要删就点删除）' }); return true; }
		const kind = KINDS.includes(b.kind) ? b.kind : m.kind;
		const importance = b.importance === undefined ? m.importance : Math.min(5, Math.max(1, Math.round(Number(b.importance)) || 1));
		const now = clock.now();
		if (content === m.content) {
			db.prepare('UPDATE memory SET kind = ?, importance = ?, importance_locked = CASE WHEN ? THEN 1 ELSE importance_locked END, importance_auto_recalled = CASE WHEN ? THEN 0 ELSE importance_auto_recalled END, updated_at = ? WHERE id = ?').run(kind, importance, b.importance !== undefined ? 1 : 0, b.importance !== undefined ? 1 : 0, now, id);
			send(200, { ok: true, id });
			return true;
		}
		// 内容改了：新写一条，旧的标 superseded（留着出处，能恢复）
		let newId = 0;
		db.exec('BEGIN');
		try {
			const r = db.prepare(`
				INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion,
				                    source_session, created_at, updated_at, status, evidence, visibility, about, importance_locked)
				VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 'active', ?, ?, ?, ?)
			`).run(m.owner_id, m.channel, m.channel_id, kind, content, tokenizeForBm25(content), importance, m.emotion, m.created_at, now,
				`主人在设置页改过（原来是：${m.content.slice(0, 120)}）`, m.visibility ?? 'normal', m.about ?? null, b.importance !== undefined ? 1 : Number(m.importance_locked ?? 0));
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
			                    source_session, created_at, updated_at, status, evidence, importance_locked)
			VALUES ('feiyu', ?, 'manual', ?, ?, ?, ?, ?, 0, 'manual', ?, ?, 'active', '主人在设置页加的', ?)
		`).run(ownerId, p?.qq_uin ? `private:${p.qq_uin}` : '', KINDS.includes(b.kind) ? b.kind : 'fact', content, tokenizeForBm25(content),
			Math.min(5, Math.max(1, Math.round(Number(b.importance ?? 3)) || 3)), now, now, b.importance !== undefined ? 1 : 0);
		worker.enqueueRealtime(Number(r.lastInsertRowid), content);
		send(200, { ok: true, id: Number(r.lastInsertRowid) });
		return true;
	}
	// 批量：{ ids[] | filter{ownerId,q,source,visibility}, action, value, dryRun }
	if (path === '/inspector/bulk' && post) {
		if (!guard()) return true;
		const b = await body();
		send(200, bulkMemory({ db, clock, worker, ids: Array.isArray(b.ids) ? b.ids : undefined, filter: Array.isArray(b.ids) ? undefined : b.filter, action: String(b.action ?? ''), value: b.value, dryRun: b.dryRun === true }));
		return true;
	}
	if (path === '/inspector/memory-restore' && post) {
		if (!guard()) return true;
		const b = await body();
		const id = Number(b.id);
		const m = db.prepare("SELECT * FROM memory WHERE id = ? AND status IN ('outdated', 'superseded', 'archived')").get(id);
		if (!m) { send(200, { ok: false, error: `#${b.id} 不用恢复` }); return true; }
		if (m.kind === 'weekly') { send(200,{ok:false,error:'失效周记不能恢复，请查看原记忆'}); return true; }
		db.prepare("UPDATE memory SET status = 'active', valid_to = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?").run(clock.now(), id);
		worker.enqueueRealtime(id, m.content);
		send(200, { ok: true, id });
		return true;
	}

	// ── 动态 / 暂停 ──
	// ── 运行日志（系统页）──
	// 排查用的装置层面事件：启动卡在哪、人格段挂不上、会话恢复失败、上下文长度。
	// 和 /activity（对话层面的动态）分开：一事实一出处，别混在一起。
	if (path === '/diag-log' && method === 'GET') {
		send(200, { ok: true, entries: (diag?.list?.(200) ?? []) });
		return true;
	}
	if (path === '/diag-log/clear' && post) {
		if (!guard()) return true;
		diag?.clear?.();
		send(200, { ok: true });
		return true;
	}
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
	if (path === '/backup/restore' && post) {
		if (!guard()) return true;
		const b = await body();
		const pending = backup.stageRestore(String(b.file ?? ''));
		send(200, { ok: true, pending, ...(backup?.state() ?? {}) });
		return true;
	}
	if (path === '/backup/restore-cancel' && post) {
		if (!guard()) return true;
		backup.cancelRestore();
		send(200, { ok: true, ...(backup?.state() ?? {}) });
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
			createdAt: m.created_at, visibility: m.visibility, ...(m.about ? { about: m.about } : {}), ...(m.evidence ? { evidence: m.evidence } : {})
		}));
		const name = `fish-soul-memories-${dateCompact()}.json`;
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
	if (path === '/import/history/resume' && post) {
		if (!guard()) return true;
		const b = await body();
		const job = historyImporter.resume(b.id ? String(b.id) : '');
		send(200, { ok: true, job });
		return true;
	}
	if (path === '/import/history/discard' && post) {
		if (!guard()) return true;
		const b = await body();
		send(200, historyImporter.discard(String(b.id ?? '')) ? { ok: true } : { ok: false, error: '没有这份导入' });
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
