/**
 * #217 日记「想聊的」永远注入不到提示词：ownerId 恒为 null。
 *
 * 病根（真机库核实 + 本地复现）：
 *   写日记时按 `who` 反查人（`findOwnerByName` 是 `WHERE display_name = ?` 精确等值），
 *   而日记 prompt 只让模型输出 `{"who":"对方的名字"}`，**从没把可用的名册给它**。
 *   模型于是写「主人」「xxx」这种称呼，display_name 却是真实 QQ 昵称 ⇒ 永远不相等
 *   ⇒ `ownerId=null` ⇒ `topicsFor()` 按 ownerId 精确过滤 ⇒ 那一行一次都注入不出来，
 *   而且没有任何报错。附带：想聊对象里还会混进刷到的视频作者（永远走不到）。
 *
 * 契约（四条，都打真行为，不复制被测逻辑）：
 *   ① 材料里带出「今天真的跟她说过话的人」，且群的 owner（`group:*`）不算人
 *   ② prompt 里**真的**出现这份名单（接线断言：抓 callLlm 收到的 prompt，不是只测纯函数）
 *   ③ 「主人」这种唯一语义的称呼能解析到 user:master；名单里的昵称原样能解析
 *   ④ 认不出的人（视频作者 / 名单外路人）不落库 —— 存下来只会是面板里一条死条目
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { tmpHome } = await import('./_tmp.mjs');
process.env.DSH_HOME = tmpHome('fish-soul-diary217-');

const { openDatabase } = await import('../lib/db.js');
const { DiaryWriter } = await import('../lib/behavior.js');

const NOW = Date.parse('2026-11-24T23:30:00+08:00');

/** 内存库 + 真表结构（openDatabase 建出来的那份 DDL）。 */
function freshDb() {
	const file = openDatabase();
	const schema = file.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL').all().map((r) => r.sql);
	const db = new DatabaseSync(':memory:');
	for (const sql of schema) { try { db.exec(sql); } catch { /* 索引 / 触发器顺序 */ } }
	file.close();
	db.prepare("INSERT INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('master','10001','真实昵称甲','close',10,?,?)").run(NOW, NOW);
	db.prepare("INSERT INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('p_abc','20002','真实昵称乙','stranger',3,?,?)").run(NOW, NOW);
	return db;
}

const ins = (db, owner, kind, content, channelId = 'private:x', channel = 'qq') => db.prepare(
	`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
	 VALUES ('feiyu',?,?,?,?,?,'',2,0,'',?,?,'active')`
).run(owner, channel, channelId, kind, content, NOW, NOW);

/** 真 findOwnerByName（和 index.js 的 ownerByName 同形：精确等值 + 唯一才认）。 */
const findOwnerByName = (db) => (name) => {
	const rows = db.prepare('SELECT canonical_id FROM person WHERE display_name = ? LIMIT 2').all(name);
	return rows.length === 1 ? `user:${rows[0].canonical_id}` : null;
};

function makeDiary(db, { topics, onPrompt } = {}) {
	return new DiaryWriter({
		db,
		clock: { now: () => NOW },
		callLlm: async (prompt) => {
			onPrompt?.(prompt);
			return JSON.stringify({ diary: '今天挺平常的，随便写两句。', topics: topics ?? [] });
		},
		getConfig: () => ({ behavior: { diary: { enabled: true, hour: 18 } } }),
		personaName: () => '飞羽',
		findOwnerByName: findOwnerByName(db),
		log: () => {}
	});
}

// ── ① 材料带出「今天说过话的人」──

test('material.people：只收私聊小结里的人，群不算人、刷视频不算人', () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');
	ins(db, 'user:p_abc', 'episode', '问了高数');
	ins(db, 'group:123456', 'episode', '群里聊游戏', 'group:123456');
	ins(db, 'self', 'event', '我在B站刷到 某UP主 的视频', 'bili:video:BV1', 'bili');

	const mat = makeDiary(db).material('2026-11-24');
	assert.deepEqual(mat.people.map((p) => p.name).sort(), ['真实昵称乙', '真实昵称甲'], '只有今天说过话的两个人');
	assert.ok(mat.people.every((p) => p.ownerId.startsWith('user:')), 'ownerId 是 user: 形状');
	assert.ok(!mat.people.some((p) => p.name === '某UP主'), '视频作者不进名单');
});

// ── ② prompt 里真的出现名单（接线断言）──

test('prompt 真的把名单交给模型：出现昵称 + 「只能挑今天真的跟你说过话的这些人」', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');
	ins(db, 'user:p_abc', 'episode', '问了高数');

	let prompt = '';
	await makeDiary(db, { onPrompt: (p) => { prompt = p; }, topics: [] }).tick({ force: true });

	assert.match(prompt, /只能挑今天真的跟你说过话的这些人/);
	// 契约变更（M2）：标注从名册行挪到行外 —— 行里带「（主人）」会被「原样照抄」照进去，
	// who 变成「真实昵称甲（主人）」就永远对不上 display_name。这里断言新的正确形状。
	assert.match(prompt, /^- 真实昵称甲$/m, '名册行是干净的名字');
	assert.match(prompt, /上面第一个是你的主人/);
	assert.match(prompt, /- 真实昵称乙/);
	assert.match(prompt, /who 必须原样照抄上面的名字/, '要明确禁止编称呼');
});

test('今天没人跟她说过话时，不硬塞一份空名单', async () => {
	const db = freshDb();
	ins(db, 'self', 'event', '我在B站刷到 某UP主 的视频', 'bili:video:BV1', 'bili');

	let prompt = '';
	await makeDiary(db, { onPrompt: (p) => { prompt = p; }, topics: [] }).tick({ force: true });
	assert.doesNotMatch(prompt, /只能挑今天真的跟你说过话的这些人/, '没名单就不提名单');
});

// ── ③ 称呼 → 人 ──

test('「主人」能解析到 user:master，昵称原样能解析，且 topicsFor 真的取得到', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');
	ins(db, 'user:p_abc', 'episode', '问了高数');

	const r = await makeDiary(db, {
		topics: [
			{ who: '主人', topic: '想跟他说说话' },
			{ who: '真实昵称乙', topic: '问问他高数复习到哪了' }
		]
	}).tick({ force: true });

	assert.equal(r.topics.length, 2);
	assert.equal(r.topics.find((t) => t.topic === '想跟他说说话').ownerId, 'user:master', '「主人」要认出来');
	assert.equal(r.topics.find((t) => t.topic.includes('高数')).ownerId, 'user:p_abc');

	const diary = makeDiary(db);
	assert.deepEqual(diary.topicsFor('user:master', NOW), ['想跟他说说话'], '这才是注入得出来的那一行');
	assert.deepEqual(diary.topicsFor('user:p_abc', NOW), ['问问他高数复习到哪了']);
});

test('「主人」被引号/书名号包着也能认（模型爱加引号）', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');

	const r = await makeDiary(db, { topics: [{ who: '「主人」', topic: '想问问他' }] }).tick({ force: true });
	assert.equal(r.topics[0]?.ownerId, 'user:master');
});

// ── ④ 认不出的人不落库 ──

test('刷到的视频作者 / 名单外路人被丢掉，不产生删不掉的死条目', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');
	ins(db, 'self', 'event', '我在B站刷到 某UP主 的视频', 'bili:video:BV1', 'bili');

	const r = await makeDiary(db, {
		topics: [
			{ who: '主人', topic: '想跟他说说话' },
			{ who: '某UP主', topic: '想问问他单片机怎么学' },
			{ who: '楼下小卖部老板', topic: '想问问他进货没' }
		]
	}).tick({ force: true });

	assert.deepEqual(r.topics.map((t) => t.who), ['主人'], '只留下认得出的那个人');
	assert.ok(r.topics.every((t) => t.ownerId !== null), '库里不许有 ownerId=null 的条目');
});

// ── 回归：原来的正常路径不许坏 ──

test('提示词里写的真是今天聊过的内容（材料没被改坏）', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭吃什么');
	ins(db, 'self', 'event', '今天想明白一件事', 'self', 'self');

	let prompt = '';
	await makeDiary(db, { onPrompt: (p) => { prompt = p; }, topics: [] }).tick({ force: true });
	assert.match(prompt, /和真实昵称甲：聊了晚饭吃什么/);
	assert.match(prompt, /今天想明白一件事/);
	assert.match(prompt, /今天是 2026-11-24/);
});

// ── 独立审查抓出的四个问题（M1~M4），每条都配一条会变红的断言 ──

test('M1 回归：master 行默认叫「主人」，主人今天没进小结时也不能把人丢掉', async () => {
	const db = freshDb();
	// ensureMasterPerson 建出的 master 行 display_name 就是「主人」（db.js:684）
	db.prepare("DELETE FROM person WHERE canonical_id = 'master'").run();
	db.prepare("INSERT INTO person (canonical_id, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('master','主人','close',0,?,?)").run(NOW, NOW);
	ins(db, 'user:p_abc', 'episode', '问了高数');   // 今天只有 p_abc 说过话，master 不在名单里

	const r = await makeDiary(db, { topics: [{ who: '主人', topic: '想跟他说说话' }] }).tick({ force: true });
	assert.equal(r.topics[0]?.ownerId, 'user:master', '「主人」必须能认，不能因为名单里没有就丢掉');
	assert.deepEqual(makeDiary(db).topicsFor('user:master', NOW), ['想跟他说说话']);
});

test('M2：名册行里不带（主人）标注 —— 照抄整行也必须能认出', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');

	let prompt = '';
	// 模型照抄整行（如果行尾有标注，who 就会带上它）
	const r = await makeDiary(db, { onPrompt: (p) => { prompt = p; }, topics: [{ who: '真实昵称甲（主人）', topic: '想问他' }] }).tick({ force: true });

	assert.match(prompt, /^- 真实昵称甲$/m, '名册行是干净的名字');
	assert.doesNotMatch(prompt, /- 真实昵称甲（主人）/, '标注不能长在要照抄的那一行里');
	assert.match(prompt, /上面第一个是你的主人/, '主人信息要另外说一句');
	assert.equal(r.topics[0]?.ownerId, 'user:master', '照抄带括号注解也要能认');
});

test('M3：认不出的排在前面，也不能把合法的挤掉（配额在过滤之后）', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');

	const r = await makeDiary(db, {
		topics: [
			{ who: '某UP主', topic: '想问单片机' },
			{ who: '楼下老板', topic: '想问进货' },
			{ who: '路人丙', topic: '想问路' },
			{ who: '主人', topic: '想跟他说说话' }   // 第 4 条，旧的 slice(0,3) 会把它砍掉
		]
	}).tick({ force: true });

	assert.deepEqual(r.topics.map((t) => t.who), ['主人'], '合法的那条不能被 3 条垃圾挤掉');
	assert.equal(r.topics.length, 1);
});

test('M3：仍然最多存 3 条（配额没被放大）', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');
	ins(db, 'user:p_abc', 'episode', '问了高数');

	const r = await makeDiary(db, {
		topics: Array.from({ length: 6 }, (_, i) => ({ who: i % 2 ? '主人' : '真实昵称乙', topic: `话题${i}` }))
	}).tick({ force: true });
	assert.equal(r.topics.length, 3, '上限还是 3 条');
});

test('M4：忙日 20 条群小结之后，晚间私聊小结仍在名册里（取最近 20 条，不是最早 20 条）', async () => {
	const db = freshDb();
	// 20 条白天的群小结（更早）
	for (let i = 0; i < 20; i++) {
		db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
		 VALUES ('feiyu','group:123456','qq','group:123456','episode',?,'',2,0,'',?,?,'active')`).run(`群聊第${i}段`, NOW - 3600_000 * 5 + i, NOW - 3600_000 * 5 + i);
	}
	// 晚间 22:00 的私聊小结（最晚）
	db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
	 VALUES ('feiyu','user:master','qq','private:10001','episode','晚上聊了心事','',2,0,'',?,?,'active')`).run(NOW, NOW);

	const mat = makeDiary(db).material('2026-11-24');
	assert.ok(mat.people.some((p) => p.name === '真实昵称甲'), '晚间私聊的人必须在名册里');
	assert.ok(!mat.people.some((p) => p.ownerId.startsWith('group:')), '群不进名册');
});

test('person 行不存在（LEFT JOIN 给 null）时，名册里不出现 null / undefined 名字', () => {
	const db = freshDb();
	// owner_id 是人形状但 person 表里没有这一行
	db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
	 VALUES ('feiyu','user:ghost','qq','private:ghost','episode','幽灵聊过','',2,0,'',?,?,'active')`).run(NOW, NOW);
	ins(db, 'user:master', 'episode', '聊了晚饭');

	const mat = makeDiary(db).material('2026-11-24');
	assert.ok(!mat.people.some((p) => !p.name), '没有 name 的条目不能进名册');
	assert.deepEqual(mat.people.map((p) => p.name), ['真实昵称甲']);
});

test('S1：全角弯引号 / 【】包着的「主人」也认得出', async () => {
	const db = freshDb();
	ins(db, 'user:master', 'episode', '聊了晚饭');

	const r = await makeDiary(db, {
		topics: [
			{ who: '“主人”', topic: 'a' },
			{ who: '【主人】', topic: 'b' },
			{ who: '‘主人’', topic: 'c' }
		]
	}).tick({ force: true });
	assert.equal(r.topics.length, 3);
	assert.ok(r.topics.every((t) => t.ownerId === 'user:master'));
});
