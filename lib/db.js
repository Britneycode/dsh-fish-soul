/**
 * db.js —— soul.db 打开、PRAGMA、6 表 DDL、身份映射（设计方案 §4/§5，审查 #01/#04/#05）。
 *
 * 要点：
 *  - 单一 SQLite 库（审查 #04）：拆 memory.db/life.db 会破坏 remember 同时写
 *    memory+pending 的单库事务；
 *  - 全部时间戳由 JS 传入 VirtualClock.now()，SQL 中严禁 CURRENT_TIMESTAMP / strftime；
 *  - person 自动注册走 ON CONFLICT(qq_uin) 原子 Upsert（审查 #05）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** $DSH_HOME：环境变量缺省回退 ~/.dsh（与宿主其他插件一致）。 */
export function dshHome() {
	const configured = process.env['DSH_HOME'];
	return configured === undefined || configured.trim() === ''
		? join(homedir(), '.dsh')
		: resolve(configured);
}

export function fishSoulDir() {
	return join(dshHome(), 'fish-soul');
}

export function configPath() {
	return join(dshHome(), 'fish-soul-config.json');
}

const DDL = `
CREATE TABLE IF NOT EXISTS memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  TEXT NOT NULL DEFAULT 'feiyu',
  owner_id      TEXT NOT NULL,
  channel       TEXT NOT NULL,
  channel_id    TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  keywords      TEXT NOT NULL DEFAULT '',
  importance    INTEGER NOT NULL DEFAULT 1,
  emotion       INTEGER NOT NULL DEFAULT 0,
  source_session TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  valid_to      INTEGER,
  superseded_by INTEGER,
  status        TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_memory_owner_active
  ON memory(character_id, owner_id, status, valid_to);
CREATE INDEX IF NOT EXISTS idx_memory_channel_recent
  ON memory(character_id, channel, channel_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS person (
  canonical_id      TEXT PRIMARY KEY,
  qq_uin            TEXT UNIQUE,
  douyin_uid        TEXT UNIQUE,
  display_name      TEXT NOT NULL DEFAULT '未知用户',
  aliases           TEXT NOT NULL DEFAULT '[]',
  relation_stage    TEXT NOT NULL DEFAULT 'stranger',
  interaction_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS day (
  date              TEXT NOT NULL,
  character_id      TEXT NOT NULL DEFAULT 'feiyu',
  plan_json         TEXT NOT NULL,
  proactive_count   INTEGER NOT NULL DEFAULT 0,
  last_proactive_at INTEGER,
  generated_at      INTEGER NOT NULL,
  PRIMARY KEY (character_id, date)
);

CREATE TABLE IF NOT EXISTS pending (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  TEXT NOT NULL DEFAULT 'feiyu',
  owner_id      TEXT NOT NULL,
  channel       TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  due_at        INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_due
  ON pending(character_id, status, due_at ASC);

CREATE TABLE IF NOT EXISTS vec_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  model_id      TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'openai-compatible',
  generation_id INTEGER NOT NULL DEFAULT 1,
  built_at      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS vec (
  memory_id     INTEGER PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  generation_id INTEGER NOT NULL,
  blob          BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

-- 一个外部聊天（QQ 私聊 / QQ 群）对应一个 DSH 会话；status='retired' 表示已被迁移或失效
CREATE TABLE IF NOT EXISTS chat_session (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  channel        TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  session_id     TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  last_inbound_at INTEGER,
  status         TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_chat_session_active
  ON chat_session(channel, channel_id, status);
`;

/** 旧库增量迁移：ALTER 失败（列已存在）即忽略。 */
const MIGRATIONS = [
	'ALTER TABLE pending ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
	// 'user' = 用户亲口交代的提醒（不占每日主动配额）；'dream' = Dream 整理时补登记的（占配额）
	"ALTER TABLE pending ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'"
];

/**
 * 打开（必要时创建）soul.db，固定 PRAGMA + DDL。
 * @returns {DatabaseSync}
 */
export function openDatabase() {
	mkdirSync(fishSoulDir(), { recursive: true });
	const db = new DatabaseSync(join(fishSoulDir(), 'soul.db'));
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA synchronous = NORMAL;');
	db.exec('PRAGMA busy_timeout = 5000;');
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec(DDL);
	for (const sql of MIGRATIONS) {
		try { db.exec(sql); } catch { /* 已迁移 */ }
	}
	return db;
}

/** kv 读写（虚拟钟快照、重建游标、Dream 水位等跨重启状态）。 */
export function getKv(db, key, fallback = null) {
	const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
	if (row === undefined) return fallback;
	try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setKv(db, key, value) {
	db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
		.run(key, JSON.stringify(value));
}

/** 只读查人（工具调用用）：不自增 interaction_count，避免关系阶段被工具调用刷高。 */
export function findPersonByQq(db, qqUin) {
	if (!qqUin) return null;
	return db.prepare('SELECT * FROM person WHERE qq_uin = ?').get(qqUin) ?? null;
}

/** 外部聊天 ↔ DSH 会话映射。 */
export function findChatSession(db, channel, channelId) {
	return db.prepare(`
		SELECT * FROM chat_session WHERE channel = ? AND channel_id = ? AND status = 'active'
		ORDER BY id DESC LIMIT 1
	`).get(channel, channelId) ?? null;
}

export function findChatSessionBySessionId(db, sessionId) {
	if (!sessionId) return null;
	return db.prepare('SELECT * FROM chat_session WHERE session_id = ?').get(String(sessionId)) ?? null;
}

export function insertChatSession(db, { channel, channelId, sessionId, workspacePath, title, nowMs }) {
	db.exec('BEGIN');
	try {
		// 同一个聊天只保留一个 active 会话
		db.prepare("UPDATE chat_session SET status = 'retired' WHERE channel = ? AND channel_id = ? AND status = 'active'")
			.run(channel, channelId);
		db.prepare(`
			INSERT INTO chat_session (channel, channel_id, session_id, workspace_path, title, created_at, status)
			VALUES (?, ?, ?, ?, ?, ?, 'active')
		`).run(channel, channelId, sessionId, workspacePath, title ?? '', nowMs);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
	return findChatSession(db, channel, channelId);
}

export function listChatSessions(db, channel) {
	return db.prepare(`
		SELECT * FROM chat_session WHERE channel = ? AND status = 'active' ORDER BY COALESCE(last_inbound_at, created_at) DESC
	`).all(channel);
}

/** 8 位随机 canonical_id（p_xxxxxxxx，十六进制）。 */
function randomCanonicalId() {
	return `p_${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
}

/**
 * person 原子自动注册（审查 #05）：按 qq_uin Upsert。
 * 主人 QQ 固定映射 canonical_id='master'、relation_stage='close'。
 * @returns {object} person 行
 */
export function resolveOrCreatePerson(db, { qqUin, nickname, nowMs, masterQqUin }) {
	const isMaster = masterQqUin !== undefined && masterQqUin !== '' && qqUin === masterQqUin;
	const canonicalId = isMaster ? 'master' : randomCanonicalId();
	const initialStage = isMaster ? 'close' : 'stranger';
	return db.prepare(`
		INSERT INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES (@canonicalId, @qqUin, @nickname, @initialStage, 1, @nowMs, @nowMs)
		ON CONFLICT(qq_uin) DO UPDATE SET
		  display_name = CASE WHEN @nickname <> '' THEN @nickname ELSE person.display_name END,
		  interaction_count = person.interaction_count + 1,
		  last_seen_at = @nowMs
		RETURNING *
	`).get({ canonicalId, qqUin, nickname: nickname ?? '', initialStage, nowMs });
}

/** 读取 vec_meta 单行；不存在时返回 null（首次使用由调用方写入）。 */
export function readVecMeta(db) {
	return db.prepare('SELECT * FROM vec_meta WHERE id = 1').get() ?? null;
}

/** 写入/覆盖 vec_meta 单行（部分字段更新，未提供的字段保持原值）。 */
export function writeVecMeta(db, patch, nowMs) {
	const cur = readVecMeta(db);
	const next = {
		model_id: patch.model_id ?? cur?.model_id ?? '',
		dim: patch.dim ?? cur?.dim ?? 0,
		provider: patch.provider ?? cur?.provider ?? 'openai-compatible',
		generation_id: patch.generation_id ?? cur?.generation_id ?? 1,
		built_at: patch.built_at ?? cur?.built_at ?? nowMs,
		status: patch.status ?? cur?.status ?? 'ready'
	};
	db.prepare(`
		INSERT INTO vec_meta (id, model_id, dim, provider, generation_id, built_at, status)
		VALUES (1, @model_id, @dim, @provider, @generation_id, @built_at, @status)
		ON CONFLICT(id) DO UPDATE SET
		  model_id = @model_id, dim = @dim, provider = @provider,
		  generation_id = @generation_id, built_at = @built_at, status = @status
	`).run(next);
	return next;
}

/**
 * 世代锁递增（审查 #08）：事务内 generation_id + 1 并清空旧 vec。
 * 飞行中的旧世代响应在 Worker 写库前校验 task.generation_id 时被丢弃。
 */
export function bumpGeneration(db, { modelId, dim, nowMs }) {
	db.exec('BEGIN');
	try {
		const cur = readVecMeta(db);
		// vec_meta 尚未初始化时建立首个世代 1，否则单调递增（审查 #08）。
		// 注意不能用 dim=0 判断：重建中途 dim 也是 0，回退到 1 会让旧世代飞行任务"复活"。
		const uninitialized = cur === null;
		const gen = uninitialized ? 1 : cur.generation_id + 1;
		db.prepare('DELETE FROM vec').run();
		writeVecMeta(db, {
			model_id: modelId ?? cur?.model_id ?? '',
			dim: dim ?? cur?.dim ?? 0,
			generation_id: gen,
			built_at: nowMs,
			status: 'building'
		}, nowMs);
		db.exec('COMMIT');
		return gen;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}
