// 抖音主人的消息必须并进 master 那一行，不能新开一行。
//
// 真机症状（2026-11-14，库查证）：master 行同时挂着 QQ + B站，但没有 douyin_uid；
// 主人的抖音消息建成了独立的 person 行（56 条记忆），于是「抖音的记忆跟 QQ/B站 分开」。
//
// 根因：认人走 `resolveOrCreatePlatformPerson({ masterId: cfg.masterUid || '' })`。
// `douyin.masterUid` 是空的时候认不出是主人 ⇒ 新建 person 行 ⇒ 记忆归到新行。
// 注意 `douyin.links` 里的「昵称=QQ号」和 kv 里的 `douyin.uin.<uid>` 绑定表
// **都不参与建 person 行**（前者只定位候选，后者只管并会话）—— 所以「绑定表里有」不代表
// 记忆会并到一起。这是最容易误判的一点。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('douyin-master-person-');
process.env.DSH_HOME = home;
const { openDatabase, resolveOrCreatePlatformPerson, setKv } = await import('../lib/db.js');

const ok = (m) => console.log('✓', m);
const UID = '2874562949425280';
const KEY = `douyin:${UID}`;

const fresh = (tag) => {
	process.env.DSH_HOME = tmpHome(`douyin-master-person-${tag}-`);
	return openDatabase();
};
const seedMaster = (db, douyinUid = null) => {
	db.prepare(`INSERT INTO person (canonical_id, qq_uin, bili_uid, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('master', '3630958828', '3546699440064926', ?, 'later', 'close', 10, ?, ?)`).run(douyinUid, Date.now(), Date.now());
};
const memOf = (db, cid) => db.prepare("SELECT COUNT(*) n FROM memory WHERE owner_id = ? AND status='active'").get(`user:${cid}`).n;
const insertMem = (db, cid, text) => db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
	VALUES ('feiyu', ?, 'douyin-private', 'douyin:未云', 'fact', ?, '', 2, 0, '', ?, ?, 'active')`).run(`user:${cid}`, text, Date.now(), Date.now());

// ── 1. 配了 masterUid：主人的抖音消息认成 master，不新开行 ──
{
	const db = fresh('with');
	seedMaster(db);
	const before = db.prepare('SELECT COUNT(*) n FROM person').get().n;
	const p = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID, nickname: '未云', nowMs: Date.now(), masterId: KEY });
	assert.equal(p.canonical_id, 'master', '配了 masterUid ⇒ 认成主人');
	assert.equal(db.prepare('SELECT COUNT(*) n FROM person').get().n, before, '不新开 person 行');
	assert.equal(db.prepare("SELECT douyin_uid FROM person WHERE canonical_id='master'").get().douyin_uid, KEY, '抖音身份挂到 master 上');
	ok('配了 masterUid ⇒ 抖音消息并进 master，不新开行');
}

// ── 2. masterUid 空：会新开一行（这就是真机里发生的事）──
{
	const db = fresh('empty');
	seedMaster(db);
	const p = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID, nickname: '未云', nowMs: Date.now(), masterId: '' });
	assert.notEqual(p.canonical_id, 'master', 'masterUid 空 ⇒ 认不出主人，新开一行');
	assert.equal(db.prepare("SELECT COUNT(*) n FROM person WHERE canonical_id='master' AND douyin_uid IS NULL").get().n, 1, 'master 行还是没挂抖音身份');
	ok('masterUid 空 ⇒ 新开一行（真机症状的复现）');
}

// ── 3. 🔴 关键：绑定表 / links 里有「未云=QQ」也不能救 —— 那是并会话用的，不参与建行 ──
{
	const db = fresh('binding');
	seedMaster(db);
	// 模拟真机：绑定表里明明有一条对的
	setKv(db, `douyin.uin.${UID}`, '3630958828');
	const p = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID, nickname: '未云', nowMs: Date.now(), masterId: '' });
	assert.notEqual(p.canonical_id, 'master', '绑定表存在不代表记忆会并到一起（它只管并会话）');
	ok('绑定表 / links 里有映射也不能替代 masterUid（记忆归属看 person 行）');
}

// ── 4. 之后再填 masterUid：下一轮消息自动并回来，记忆跟着走 ──
{
	const db = fresh('later');
	seedMaster(db);
	// 先按 masterUid 空的样子建出一行，并记一条
	const first = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID, nickname: '未云', nowMs: Date.now(), masterId: '' });
	insertMem(db, first.canonical_id, '抖音里说的一句话');
	assert.equal(memOf(db, first.canonical_id), 1);
	assert.equal(memOf(db, 'master'), 0);

	// 补上 masterUid，再收一条消息
	const second = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID, nickname: '未云', nowMs: Date.now(), masterId: KEY });
	assert.equal(second.canonical_id, 'master', '补上 masterUid 后认成主人');
	assert.equal(memOf(db, 'master'), 1, '之前那条记忆搬到 master 名下了');
	assert.equal(memOf(db, first.canonical_id), 0, '旧行没记忆了');
	assert.equal(db.prepare('SELECT COUNT(*) n FROM person WHERE canonical_id = ?').get(first.canonical_id).n, 0, '旧行删掉了（没挂别的平台号）');
	ok('事后补 masterUid：下一轮消息自动并回来，记忆跟着走');
}

// ── 5. 归一：配置里写 douyin:<uid>，消息来的是裸 uid，也要认得出 ──
{
	const db = fresh('norm');
	seedMaster(db);
	const p = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID, nickname: '未云', nowMs: Date.now(), masterId: `uid:${UID}` });
	assert.equal(p.canonical_id, 'master', 'masterId 的 uid:/douyin: 前缀写法都能归一');
	ok('masterId 写法归一（uid:<uid> / douyin:<uid> 都认）');
}

// ── 6. 陌生人不受影响：masterUid 配了也不会把别人认成主人 ──
{
	const db = fresh('stranger');
	seedMaster(db);
	const p = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: '2060933357111416', nickname: 'Re.', nowMs: Date.now(), masterId: KEY });
	assert.notEqual(p.canonical_id, 'master', '别人还是别人');
	assert.equal(p.douyin_uid, 'douyin:2060933357111416');
	ok('配了 masterUid 也不会把陌生人认成主人');
}

console.log('\ndouyin-master-person-merge ok');
