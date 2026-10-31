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

-- 鱼自己刷 B站看过的视频（去重 + 设置页"最近看过"）；seen_at 虚拟钟、seen_real_at 物理钟
CREATE TABLE IF NOT EXISTS bili_seen (
  bvid          TEXT PRIMARY KEY,
  aid           TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  owner_name    TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'recommend',
  impression    TEXT NOT NULL DEFAULT '',
  skipped       INTEGER NOT NULL DEFAULT 0,
  liked         INTEGER NOT NULL DEFAULT 0,
  memory_id     INTEGER,
  seen_at       INTEGER NOT NULL,
  seen_real_at  INTEGER NOT NULL
);

-- 鱼自己刷抖音看过的视频（同上）
CREATE TABLE IF NOT EXISTS douyin_seen (
  aweme_id      TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  impression    TEXT NOT NULL DEFAULT '',
  skipped       INTEGER NOT NULL DEFAULT 0,
  liked         INTEGER NOT NULL DEFAULT 0,
  memory_id     INTEGER,
  seen_at       INTEGER NOT NULL,
  seen_real_at  INTEGER NOT NULL
);
`;

/** 旧库增量迁移：ALTER 失败（列已存在）即忽略。 */
const MIGRATIONS = [
	'ALTER TABLE pending ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
	// 'user' = 用户亲口交代的提醒（不占每日主动配额）；'dream' = Dream 整理时补登记的（占配额）
	"ALTER TABLE pending ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'",
	// v0.4：B站 UID（同一个人的 QQ 和 B站可以归到一个 canonical_id 下）
	'ALTER TABLE person ADD COLUMN bili_uid TEXT',
	'CREATE UNIQUE INDEX IF NOT EXISTS idx_person_bili ON person(bili_uid)',
	// v0.5：抖音会话名（建表时就有 UNIQUE 列，这里只给极老的库兜底）
	'CREATE UNIQUE INDEX IF NOT EXISTS idx_person_douyin ON person(douyin_uid)',
	// v0.6：记忆的出处（当时那句原话 / 从哪份聊天记录导入 / 主人在设置页改的）
	"ALTER TABLE memory ADD COLUMN evidence TEXT NOT NULL DEFAULT ''",
	// v0.8：私密（私聊里说的敏感事，群里不提）、说的是谁、被想起的次数 / 时间（遗忘曲线）
	"ALTER TABLE memory ADD COLUMN visibility TEXT NOT NULL DEFAULT 'normal'",
	'ALTER TABLE memory ADD COLUMN about TEXT',
	'ALTER TABLE memory ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0',
	'ALTER TABLE memory ADD COLUMN last_recalled_at INTEGER',
	'CREATE INDEX IF NOT EXISTS idx_memory_about ON memory(character_id, about, status)',
	// v0.8：好感度、上次结算时间、上一次来聊的时间（隔了 1 小时以上才算新的一次）、主人手动定的阶段不自动改
	'ALTER TABLE person ADD COLUMN affinity REAL',
	'ALTER TABLE person ADD COLUMN affinity_at INTEGER',
	'ALTER TABLE person ADD COLUMN prev_seen_at INTEGER',
	'ALTER TABLE person ADD COLUMN stage_locked INTEGER NOT NULL DEFAULT 0',
	`CREATE TRIGGER IF NOT EXISTS person_prev_seen AFTER UPDATE OF last_seen_at ON person
	 WHEN NEW.last_seen_at - OLD.last_seen_at > 3600000
	 BEGIN UPDATE person SET prev_seen_at = OLD.last_seen_at WHERE canonical_id = NEW.canonical_id; END`
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

/**
 * 人物印象（v0.6）：Dream 按这个人的记忆写的一段画像，进聊天上下文；主人在设置页改过就锁住（Dream 不再改）。
 * 存 kv `profile.<ownerId>` = { text, by: 'dream'|'user', locked, updatedAt }。
 */
export function getProfile(db, ownerId) {
	const v = getKv(db, `profile.${ownerId}`, null);
	return v !== null && typeof v === 'object' && typeof v.text === 'string' ? v : null;
}

export function setProfile(db, ownerId, { text, by = 'dream', locked = false, updatedAt }) {
	const clean = String(text ?? '').trim().slice(0, 400);
	if (clean === '') { db.prepare('DELETE FROM kv WHERE key = ?').run(`profile.${ownerId}`); return null; }
	const v = { text: clean, by, locked: locked === true, updatedAt: Number(updatedAt) || Date.now() };
	setKv(db, `profile.${ownerId}`, v);
	return v;
}

/** 只读查人（工具调用用）：不自增 interaction_count，避免关系阶段被工具调用刷高。 */
export function findPersonByQq(db, qqUin) {
	if (!qqUin) return null;
	return db.prepare('SELECT * FROM person WHERE qq_uin = ?').get(qqUin) ?? null;
}

export function findPersonByBili(db, uid) {
	if (!uid) return null;
	return db.prepare('SELECT * FROM person WHERE bili_uid = ?').get(String(uid)) ?? null;
}

export function findPersonByDouyin(db, name) {
	if (!name) return null;
	return db.prepare('SELECT * FROM person WHERE douyin_uid = ?').get(String(name)) ?? null;
}

const PLATFORM_COLUMN = { bili: 'bili_uid', douyin: 'douyin_uid' };

/**
 * B站私信认人：
 *  - 主人 UID → canonical_id='master'（和主人 QQ 是同一个人）；
 *  - 设置页"B站 UID = QQ 号"对应上的 → 那个 QQ 的人；
 *  - 其余新建一个只有 bili_uid 的人。
 * 之前已经单独建过的 B站身份，后来在设置页对应到了别人：把它的记忆 / 待办并过去，旧身份删掉。
 */
export function resolveOrCreateBiliPerson(db, { biliUid, nickname, nowMs, masterBiliUid, linkedQq }) {
	return resolveOrCreatePlatformPerson(db, { platform: 'bili', platformId: biliUid, nickname, nowMs, masterId: masterBiliUid, linkedQq });
}

/**
 * 外部平台（B站 UID / 抖音会话名）认人，规则同上。抖音认的是私信会话里显示的名字（拿不到抖音号），
 * 存在 person.douyin_uid 里。
 * @param {object} p
 * @param {'bili'|'douyin'} p.platform
 */
export function resolveOrCreatePlatformPerson(db, { platform, platformId, nickname, nowMs, masterId, linkedQq }) {
	const col = PLATFORM_COLUMN[platform];
	if (!col) throw new Error(`未知平台 ${platform}`);
	const others = Object.values(PLATFORM_COLUMN).filter((c) => c !== col);
	const uid = String(platformId);
	const name = String(nickname ?? '');
	const findByPlatform = () => db.prepare(`SELECT * FROM person WHERE ${col} = ?`).get(uid) ?? null;
	db.exec('BEGIN');
	try {
		let target = null;
		if (masterId && uid === String(masterId)) {
			target = db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get() ?? null;
			if (target === null) {
				db.prepare(`
					INSERT INTO person (canonical_id, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
					VALUES ('master', ?, 'close', 0, ?, ?)
				`).run(name || '主人', nowMs, nowMs);
				target = db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get();
			}
		} else if (linkedQq) {
			target = findPersonByQq(db, String(linkedQq));
			if (target === null) {
				const cid = randomCanonicalId();
				db.prepare(`
					INSERT INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
					VALUES (?, ?, ?, 'stranger', 0, ?, ?)
				`).run(cid, String(linkedQq), name || '未知用户', nowMs, nowMs);
				target = db.prepare('SELECT * FROM person WHERE canonical_id = ?').get(cid);
			}
		}
		const existing = findByPlatform();
		if (target !== null && existing !== null && existing.canonical_id !== target.canonical_id) {
			const from = `user:${existing.canonical_id}`;
			const to = `user:${target.canonical_id}`;
			db.prepare('UPDATE memory SET owner_id = ? WHERE owner_id = ?').run(to, from);
			db.prepare('UPDATE pending SET owner_id = ? WHERE owner_id = ?').run(to, from);
			db.prepare(`UPDATE person SET ${col} = NULL WHERE canonical_id = ?`).run(existing.canonical_id);
			db.prepare(`
				UPDATE person SET interaction_count = interaction_count + ?, first_seen_at = MIN(first_seen_at, ?) WHERE canonical_id = ?
			`).run(existing.interaction_count ?? 0, existing.first_seen_at ?? nowMs, target.canonical_id);
			// 旧身份身上还挂着别的号（QQ / 另一个平台）就留着，只摘掉这个平台的
			if (!existing.qq_uin && others.every((c) => !existing[c])) db.prepare('DELETE FROM person WHERE canonical_id = ?').run(existing.canonical_id);
		}
		if (target === null) target = existing;
		if (target === null) {
			const cid = randomCanonicalId();
			db.prepare(`
				INSERT INTO person (canonical_id, ${col}, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
				VALUES (?, ?, ?, 'stranger', 0, ?, ?)
			`).run(cid, uid, name || uid, nowMs, nowMs);
			target = db.prepare('SELECT * FROM person WHERE canonical_id = ?').get(cid);
		}
		// 名字：只有这个平台身份的人跟着平台昵称走；和 QQ / 别的平台合并的人保留原来的称呼
		const keepName = Boolean(target.qq_uin) || target.canonical_id === 'master' || others.some((c) => target[c]);
		db.prepare(`
			UPDATE person SET ${col} = ?, interaction_count = interaction_count + 1, last_seen_at = ?,
			  display_name = CASE WHEN ? = 0 AND ? <> '' THEN ? ELSE display_name END
			WHERE canonical_id = ?
		`).run(uid, nowMs, keepName ? 1 : 0, name, name, target.canonical_id);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
	return findByPlatform();
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
	// 主人先从 B站来过（master 行还没有 QQ 号）：补上 QQ 号，下面的 Upsert 走更新分支而不是主键冲突
	if (isMaster) db.prepare("UPDATE person SET qq_uin = ? WHERE canonical_id = 'master' AND qq_uin IS NULL").run(qqUin);
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
