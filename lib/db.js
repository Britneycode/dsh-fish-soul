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

CREATE TABLE IF NOT EXISTS weekly_source (
  summary_id INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, source_id), UNIQUE(source_id)
);
CREATE INDEX IF NOT EXISTS idx_weekly_summary ON weekly_source(summary_id);

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

-- 鱼自己发的动态（v0.10）；created_at 虚拟钟、created_real_at 物理钟
CREATE TABLE IF NOT EXISTS social_post (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT NOT NULL DEFAULT 'bili',
  post_id         TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  created_real_at INTEGER NOT NULL
);

-- 别人在她评论区的留言，回没回都记一笔（去重用）；status = replied / skipped / failed
CREATE TABLE IF NOT EXISTS social_reply (
  platform        TEXT NOT NULL DEFAULT 'bili',
  notify_id       TEXT NOT NULL,
  from_uid        TEXT NOT NULL DEFAULT '',
  from_name       TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  reply           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'replied',
  created_real_at INTEGER NOT NULL,
  PRIMARY KEY (platform, notify_id)
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
	"ALTER TABLE memory ADD COLUMN importance_locked INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE memory ADD COLUMN importance_auto_recalled INTEGER NOT NULL DEFAULT 0",
	'CREATE INDEX IF NOT EXISTS idx_memory_about ON memory(character_id, about, status)',
	'CREATE INDEX IF NOT EXISTS idx_memory_superseded_by ON memory(superseded_by) WHERE superseded_by IS NOT NULL',
	// v0.8：好感度、上次结算时间、上一次来聊的时间（隔了 1 小时以上才算新的一次）、主人手动定的阶段不自动改
	'ALTER TABLE person ADD COLUMN affinity REAL',
	'ALTER TABLE person ADD COLUMN affinity_at INTEGER',
	'ALTER TABLE person ADD COLUMN prev_seen_at INTEGER',
	'ALTER TABLE person ADD COLUMN stage_locked INTEGER NOT NULL DEFAULT 0',
	// 0.11.3：刷 B站时收藏了（默认收藏夹）
	'ALTER TABLE bili_seen ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0',
	`CREATE TRIGGER IF NOT EXISTS person_prev_seen AFTER UPDATE OF last_seen_at ON person
	 WHEN NEW.last_seen_at - OLD.last_seen_at > 3600000
	 BEGIN UPDATE person SET prev_seen_at = OLD.last_seen_at WHERE canonical_id = NEW.canonical_id; END`,
	// v0.15.9（#68）：删除整个人物卡（不只是清空记忆）——person 行软删除，
	// 已删的不出现在记忆区列表里，但行还在（不可恢复，先备份再删）
	'ALTER TABLE person ADD COLUMN deleted_at INTEGER',
	// #78 第 2 步：同一个人的 B站 / 抖音 私信并进 QQ 私聊那个会话。
	// 旧会话不删（聊天记录还在），只是标成 retired + 并进了哪个会话
	'ALTER TABLE chat_session ADD COLUMN merged_into TEXT',
	// #80：待办被「顺口提起」过（status='surfaced'）的时间。
	// 提起不等于说到——那轮她没提，这条以前就永远消失了；现在过一阵能退回 pending 重来
	'ALTER TABLE pending ADD COLUMN surfaced_at INTEGER'
];

/**
 * `weekly_protect` 触发器定义（周记不可编辑/不可恢复）。
 * 单份：建库时 exec 用，`reassignMemoryOwner` 临时摘除后重建也用同一份 ——
 * 防止改了一处忘了另一处，重建出和原始定义不一致的触发器。
 */
const WEEKLY_PROTECT_SQL = `CREATE TRIGGER IF NOT EXISTS weekly_protect BEFORE UPDATE ON memory
WHEN OLD.kind='weekly' AND (OLD.content IS NOT NEW.content OR OLD.kind IS NOT NEW.kind OR OLD.visibility IS NOT NEW.visibility OR OLD.owner_id IS NOT NEW.owner_id OR OLD.channel IS NOT NEW.channel OR OLD.channel_id IS NOT NEW.channel_id OR OLD.about IS NOT NEW.about OR (OLD.status != 'active' AND NEW.status = 'active'))
BEGIN SELECT RAISE(ABORT, 'derived weekly summary cannot be edited or restored'); END;`;

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
	db.exec(`
	CREATE TRIGGER IF NOT EXISTS weekly_source_changed AFTER UPDATE OF content,status,valid_to,visibility,owner_id,channel,channel_id,kind,about ON memory
	WHEN OLD.content IS NOT NEW.content OR OLD.status IS NOT NEW.status OR OLD.valid_to IS NOT NEW.valid_to OR OLD.visibility IS NOT NEW.visibility OR OLD.owner_id IS NOT NEW.owner_id OR OLD.channel IS NOT NEW.channel OR OLD.channel_id IS NOT NEW.channel_id OR OLD.kind IS NOT NEW.kind OR OLD.about IS NOT NEW.about
	BEGIN
	 UPDATE memory SET status='outdated', valid_to=NEW.updated_at, updated_at=NEW.updated_at WHERE id IN (SELECT summary_id FROM weekly_source WHERE source_id=OLD.id) AND status='active';
	 DELETE FROM vec WHERE memory_id IN (SELECT summary_id FROM weekly_source WHERE source_id=OLD.id);
	END;
	CREATE TRIGGER IF NOT EXISTS weekly_source_deleted BEFORE DELETE ON memory
	BEGIN
	 UPDATE memory SET status='outdated', valid_to=OLD.updated_at WHERE id IN (SELECT summary_id FROM weekly_source WHERE source_id=OLD.id) AND status='active';
	 DELETE FROM vec WHERE memory_id IN (SELECT summary_id FROM weekly_source WHERE source_id=OLD.id);
	END;
	${WEEKLY_PROTECT_SQL}
	`);
	return db;
}

/**
 * 把一个人的记忆搬给另一个人（认人合并 / 主人换号时用）。
 *
 * 🔴 为什么不能直接 `UPDATE memory SET owner_id = ?`：
 *    `weekly_protect` 触发器把 `owner_id` 变化也算作「周记被编辑」→ `RAISE(ABORT)`。
 *    于是「主人换 QQ 号」「设置页把 B站 UID 关联到某个 QQ」这类正当合并会直接抛错，
 *    认人阶段就断，整条通道不回话（而报错信息是「derived weekly summary cannot be
 *    edited or restored」，根本指不到真正的操作上）。
 *
 * 修法：搬之前临时摘掉触发器，搬完立刻按原定义重建 —— **不改触发器语义**
 * （周记照样不能被编辑 / 不能被恢复），只是放行「换主人」这一种操作。
 * 用 try/finally 保证触发器一定重建，哪怕搬的过程抛错。
 */
export function reassignMemoryOwner(db, from, to) {
	db.exec('DROP TRIGGER IF EXISTS weekly_protect');
	try {
		db.prepare('UPDATE memory SET owner_id = ? WHERE owner_id = ?').run(to, from);
		db.prepare('UPDATE pending SET owner_id = ? WHERE owner_id = ?').run(to, from);
	} finally {
		// 无论搬成功还是抛错，触发器都要回来（它守的是周记不被篡改）。
		// 用共享的常量：保证重建出来的和 openDatabase 建库时的定义是同一份
		db.exec(WEEKLY_PROTECT_SQL);
	}
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
	// 查找也要归一：库里存的是 `douyin:<uid>`，调用方给的可能是 `uid:<uid>` 或裸 uid。
	// 不归一就等于「换个写法就查不到这个人」。
	return db.prepare('SELECT * FROM person WHERE douyin_uid = ?').get(normalizeDouyinIdentity(name)) ?? null;
}

/**
 * 抖音身份键归一：统一成 `douyin:<数字uid>`。
 *
 * 这一列历史上混着四种写法：`douyin:<uid>`（私信会话身份）、`uid:<uid>`（群聊老格式）、
 * 裸数字 uid、裸昵称。认人是按这一列**精确匹配**的 ⇒ 换个写法就是「新的人」⇒
 * 同一个人被拆成多行，各自记一套好感 / 印象 / 记忆 —— 就是「人物关系乱」的样子。
 *
 * 裸昵称还原不出 uid（`小明` → `douyin:???`），所以原样保留：
 * 同一个名字还是同一个人，但不能硬套到某个 uid 上。
 *
 * @param {unknown} raw
 * @returns {string} 归一后的键；空串原样返回空串
 */
export function normalizeDouyinIdentity(raw) {
	const s = String(raw ?? '').trim();
	if (s === '') return '';
	const m = /^(?:douyin:|uid:)?(\d+)$/.exec(s);
	return m === null ? s : `douyin:${m[1]}`;
}

/**
 * 同一个人的「另一种写法」在库里可能留下的键。
 *
 * ① `uid:<同样的数字>` / 裸数字 —— 群聊老格式、无前缀老格式，只是写法不同
 * ② **截断孪生**：`uid:<数字被 Number 抹平后的版本>`
 *    19 位 uid 过一次 `Number()` 末几位就没了（`Number('9007199254740993')`
 *    === '9007199254740992'，就是 MAX_SAFE_INTEGER 边界）—— 同一个人于是留下两个
 *    身份，各记一套好感。
 *    认它的判据：`Number(存的) === Number(准的)` 且两者数字不同。
 *    同一个双精度数不可能是两个人的真 uid（真 uid 不会正好等于别人的截断值），
 *    所以这个判断是可靠的；16 位以内的 uid 本来就精确，不会命中。
 *
 * @returns {string[]} 库里确实存在的那些「另一个写法」的键
 */
function douyinTwinKeys(db, canonical) {
	const m = /^douyin:(\d+)$/.exec(canonical);
	if (m === null) return [];
	const digits = m[1];
	const keys = [`uid:${digits}`, digits];
	const lossy = String(Number(digits));
	if (lossy !== digits) keys.push(`uid:${lossy}`, lossy);
	const stmt = db.prepare('SELECT canonical_id FROM person WHERE douyin_uid = ?');
	return keys.filter((k) => stmt.get(k) !== undefined);
}

/**
 * 把「同一个人的另一种写法」那一行归到新格式（`douyin:<id>`）。
 *
 * · 只有那一种写法 ⇒ 原地改键（还是那个人，记忆不用搬）
 * · 两种写法都在 ⇒ 老的并进新的：记忆跟着走、互动次数加起来，老的摘掉
 *   （不并的话同一个人永远有两套好感 / 印象，而且各记各的）
 *
 * 截断孪生（被 Number 抹过的那一版）只并**只挂在这一个平台**的老行 ——
 * 它身上还挂着 QQ / B站号的话，说明那是个真人留下的身份，不是残留键，不动。
 */
function mergeDouyinTwinRows(db, uid, nowMs) {
	for (const twin of douyinTwinKeys(db, uid)) {
		const old = db.prepare('SELECT * FROM person WHERE douyin_uid = ?').get(twin);
		if (old === undefined || old === null) continue;
		const cur = db.prepare('SELECT * FROM person WHERE douyin_uid = ?').get(uid);
		// ⚠ node:sqlite 的 get() 查不到返回 undefined（不是 null）——两种都当成「没有」。
		if (cur === undefined || cur === null) {
			db.prepare('UPDATE person SET douyin_uid = ? WHERE canonical_id = ?').run(uid, old.canonical_id);
			continue;
		}
		if (old.canonical_id === cur.canonical_id) continue;
		// 只挂在这一个平台的老行才并：挂着别的号的是真人身份，不能搬
		if (old.qq_uin || old.bili_uid) continue;
		// 走 helper：直接 UPDATE 会被 weekly_protect 触发器 ABORT（周记也算 owner 变化）
		reassignMemoryOwner(db, `user:${old.canonical_id}`, `user:${cur.canonical_id}`);
		db.prepare(`
			UPDATE person SET interaction_count = interaction_count + ?, first_seen_at = MIN(first_seen_at, ?), last_seen_at = MAX(last_seen_at, ?)
			WHERE canonical_id = ?
		`).run(old.interaction_count ?? 0, old.first_seen_at ?? nowMs, old.last_seen_at ?? nowMs, cur.canonical_id);
		db.prepare('UPDATE person SET douyin_uid = NULL WHERE canonical_id = ?').run(old.canonical_id);
		// 老行身上还有别的号（QQ / B站）就留着，只摘这个平台的；什么都没有就整行删掉
		if (!old.qq_uin && !old.bili_uid) db.prepare('DELETE FROM person WHERE canonical_id = ?').run(old.canonical_id);
	}
}

const PLATFORM_COLUMN = { bili: 'bili_uid', douyin: 'douyin_uid' };

/**
 * 这个身份是不是「好几个人拼一起」。
 *
 * 判据：逗号切开后**至少两段**各自都能在 person 表里对上已知的人（身份键或显示名）。
 * 这样 "Bob, Jr." 这种带逗号的真名字不会误判 —— 它的两段都不是已知的人。
 *
 * @param {object} db
 * @param {string} raw
 * @param {string} [excludeId] 排除某一行（用它自己来对「已知的人」时）
 * @returns {boolean}
 */
export function isMergedNameList(db, raw, excludeId = '') {
	const parts = String(raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
	if (parts.length < 2) return false;
	const stmt = db.prepare('SELECT 1 FROM person WHERE (douyin_uid = ? OR display_name = ?) AND canonical_id <> ? LIMIT 1');
	let hits = 0;
	for (const p of parts) {
		if (stmt.get(p, p, excludeId) !== undefined) hits++;
		if (hits >= 2) return true;
	}
	return false;
}

/**
 * 清掉「把几个名字拼一起」的脏身份行。
 *
 * 历史上有过 `Re., 未云, 云` 这种值 —— 旧代码把一段对话里的**几个人**
 * 拼成了一个身份，于是「和 A、B、C 寒暄」被记成了**一个人**的互动：好几个人的
 * 往来记在一个人头上，就是「人物关系乱」本身。
 *
 * 处理：**只清理，不合并**。它对应的是「好几个人」，并到其中任何一个都是把别人的
 * 往来记到那个人头上 —— 正是要修的那个病。它身上的记忆也只是这几段对话的小结
 * （episode / weekly），没有属于「这个人」自己的事实，跟着一起清掉。
 *
 * 判据见 {@link isMergedNameList}：至少两段各自都能对上已知的人。带逗号的真名字
 * 对不上 ⇒ 不动。
 *
 * @returns {Array<{canonicalId:string, douyinUid:string, memories:number}>}
 */
export function cleanupMergedDouyinNames(db) {
	const rows = db.prepare("SELECT canonical_id, douyin_uid FROM person WHERE douyin_uid LIKE '%,%'").all();
	const cleaned = [];
	for (const row of rows) {
		if (!isMergedNameList(db, row.douyin_uid, row.canonical_id)) continue;
		const owner = `user:${row.canonical_id}`;
		const n = db.prepare('SELECT COUNT(*) n FROM memory WHERE owner_id = ?').get(owner).n;
		db.prepare('DELETE FROM vec WHERE memory_id IN (SELECT id FROM memory WHERE owner_id = ?)').run(owner);
		db.prepare('DELETE FROM memory WHERE owner_id = ?').run(owner);
		db.prepare('DELETE FROM pending WHERE owner_id = ?').run(owner);
		db.prepare('DELETE FROM kv WHERE key IN (?, ?, ?)').run(`profile.${owner}`, `mood.${owner}`, `dream.watermark.${owner}`);
		db.prepare('DELETE FROM person WHERE canonical_id = ?').run(row.canonical_id);
		cleaned.push({ canonicalId: row.canonical_id, douyinUid: row.douyin_uid, memories: n });
	}
	return cleaned;
}

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
	const uid = platform === 'douyin' ? normalizeDouyinIdentity(platformId) : String(platformId);
	const name = String(nickname ?? '');
	const findByPlatform = () => db.prepare(`SELECT * FROM person WHERE ${col} = ?`).get(uid) ?? null;
	db.exec('BEGIN');
	try {
		// 库里可能还留着同一个人的另一种写法（`uid:<id>` 群聊老格式、或者被 Number 抹过一遍的截断版）：
		// 归一后按新键查不到 ⇒ 同一个人被拆成两行。先收拾掉，后面的 existing 拿到的就是归一后的那一行。
		if (platform === 'douyin') mergeDouyinTwinRows(db, uid, nowMs);
		let target = null;
		// 主人身份也归一：配置里填 `douyin:<uid>`，消息来的是 `uid:<uid>`（群聊老格式）时，
		// 不归一就永远对不上 ⇒ 主人被当成陌生人。
		const masterKey = platform === 'douyin' ? normalizeDouyinIdentity(masterId) : String(masterId ?? '');
		if (masterKey !== '' && uid === masterKey) {
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
			// 走 helper：直接 UPDATE 会被 weekly_protect 触发器 ABORT（周记也算 owner 变化）
			reassignMemoryOwner(db, from, to);
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
			  display_name = CASE WHEN ? = 0 AND ? <> '' THEN ? ELSE display_name END,
			  deleted_at = NULL
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

/** 8 位随机 canonical_id（p_xxxxxxxx，十六进制；importer 造新 person 也用同一套）。 */
export function randomCanonicalId() {
	return `p_${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
}

/** 桌面端 / 主人兜底：拿到 canonical_id='master' 的 person 行，没有就建一个。 */
export function ensureMasterPerson(db, nowMs) {
	const row = db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get();
	if (row) return row;
	db.prepare(`
		INSERT INTO person (canonical_id, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('master', '主人', 'close', 0, ?, ?)
	`).run(nowMs, nowMs);
	return db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get();
}

/**
 * person 原子自动注册（审查 #05）：按 qq_uin Upsert。
 * 主人 QQ 固定映射 canonical_id='master'、relation_stage='close'。
 * @returns {object} person 行
 */
export function resolveOrCreatePerson(db, { qqUin, nickname, nowMs, masterQqUin }) {
	// ⚠️ 一律转字符串再比、再写。
	//    OneBot 事件里的 user_id 是**数字**，配置里的 masterQqUin 是**字符串**；
	//    混着用会出现两种诡异结果：
	//      ① `10001 === '10001'` 为假 → 主人认不出来（原本就有这个隐患）
	//      ② 数字写进 TEXT 列会存成 "10001.0" → 跟字符串 "10001" 永远对不上
	//    所以入口统一 String()，后面的比较和写入都用同一个值。
	qqUin = String(qqUin ?? '');
	const master = masterQqUin === undefined || masterQqUin === null ? undefined : String(masterQqUin);
	const isMaster = master !== undefined && master !== '' && qqUin === master;
	masterQqUin = master;
	const canonicalId = isMaster ? 'master' : randomCanonicalId();
	const initialStage = isMaster ? 'close' : 'stranger';
	// 主人换过 QQ 号：master 行上还挂着旧号。
	// 旧号占着 master 的 qq_uin，新号 INSERT 时既撞 qq_uin 的 UNIQUE、又撞 canonical_id='master' 主键，
	// 而下面的 Upsert 只兜得住 qq_uin —— 于是每轮消息都在认人阶段抛
	// `UNIQUE constraint failed: person.canonical_id`，整条 QQ 通道一个字都不回。
	//
	// 修法：**只在「master 行恰好挂着这个号、但这个号已经不是主人」时**把那一行处理掉。
	//
	// 🔴 这个判据必须写死成「master 行挂着 qqUin」，不能放宽成「只要不是当前 master 就摘」：
	//    放宽后随便哪个陌生人来一条消息都会把主人的 qq_uin 清空（smoke 里 55555 就这么干过）。
	//
	// 🔴 也不能只在 isMaster 时处理 —— 旧号自己那条消息先到时 isMaster 是假，
	//    不处理就永远卡在「旧号顶着 master、新号撞主键」的死循环里。
	//
	// ⚠️ 参数必须是字符串：数字写进 TEXT 列会变成 "10001.0"，跟 "10001" 永远对不上。
	//    入口已经统一 String() 过了。
	if (!isMaster && master !== undefined && master !== '') {
		const stale = db.prepare("SELECT * FROM person WHERE qq_uin = ? AND canonical_id = 'master'").get(qqUin) ?? null;
		if (stale !== null) {
			// master 行上还挂着别的平台身份（主人先从 B站 / 抖音来过）⇒ 只摘 QQ 号，不搬行
			if (stale.bili_uid !== null || stale.douyin_uid !== null) {
				db.prepare("UPDATE person SET qq_uin = NULL WHERE canonical_id = 'master' AND qq_uin = ?").run(qqUin);
			} else {
				// 整行都是「曾经的主人」⇒ 给它一个新身份退回陌生人，记忆跟着走，不丢
				const newCid = randomCanonicalId();
				db.prepare("UPDATE person SET canonical_id = ?, relation_stage = 'stranger' WHERE canonical_id = 'master' AND qq_uin = ?").run(newCid, qqUin);
				reassignMemoryOwner(db, 'user:master', `user:${newCid}`);
				// 腾出来的 master 主键补一行，给真正的主人接管
				db.prepare(`
					INSERT INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
					VALUES ('master', NULL, '主人', 'close', 0, ?, ?)
				`).run(nowMs, nowMs);
			}
		}
	}
	// 主人先从 B站来过 / 刚腾出位置：master 行没有 QQ 号就补上，下面的 Upsert 才不会撞主键
	if (isMaster) db.prepare("UPDATE person SET qq_uin = ? WHERE canonical_id = 'master' AND qq_uin IS NULL").run(qqUin);

	// 🔴 非主人这条消息如果正好命中 master 行（上面刚摘成 NULL、但 canonical_id 还是 master 的那行，
	//    或从没设过主人的老库），下面那句 `ON CONFLICT(qq_uin)` 只会更新名字和次数，
	//    **canonical_id 仍然是 'master'** —— 旧号于是继续顶着主人的身份，新号反而接管不了。
	//    所以在 INSERT 之前把它挪成一个独立的陌生人身份（记忆跟着搬，不丢）。
	//
	// ⚠️ **只在「这一行除了 qq_uin 没有别的身份」时才搬**。
	//    master 行上还可能挂着 bili_uid / douyin_uid（主人先从那两个平台来过），
	//    把整行搬走会连带把主人的 B站 / 抖音身份一起搬给陌生人 —— smoke 里
	//    「B站私信认主人」那条就是这么红的。这种情况只摘 qq_uin，不搬行。
	if (!isMaster) {
		const hijack = db.prepare("SELECT * FROM person WHERE qq_uin IS NOT NULL AND canonical_id = 'master' AND qq_uin = ?").get(qqUin) ?? null;
		if (hijack !== null && hijack.bili_uid === null && hijack.douyin_uid === null) {
			const newCid = randomCanonicalId();
			db.prepare("UPDATE person SET canonical_id = ?, relation_stage = 'stranger' WHERE canonical_id = 'master' AND qq_uin = ?").run(newCid, qqUin);
			reassignMemoryOwner(db, 'user:master', `user:${newCid}`);
		}
	}
	return db.prepare(`
		INSERT INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES (@canonicalId, @qqUin, @nickname, @initialStage, 1, @nowMs, @nowMs)
		ON CONFLICT(qq_uin) DO UPDATE SET
		  display_name = CASE WHEN @nickname <> '' THEN @nickname ELSE person.display_name END,
		  interaction_count = person.interaction_count + 1,
		  last_seen_at = @nowMs,
		  deleted_at = NULL
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
