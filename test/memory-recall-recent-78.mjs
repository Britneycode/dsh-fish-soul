// #78：带时间词的问句要能想起近期的记忆（真机症状：问「你刚才刷了什么视频呀」，她答对了，
// 但那是上下文瞬态块兜的底 —— 记忆检索召回的 9 条里一条都不是刚刷的视频）。
//
// 根因不在「忘了」，在排序：
//   · BM25 里「刷」「视频」在几百条记忆里都出现过，idf 几乎为 0；「刚才」「什么」几乎查不到 ——
//     一句「你刚才刷了什么视频呀」没有一个词有区分度；
//   · 刷视频的记忆写进来时 importance 恒为 1（lib/browse.js），30 天半衰期还会淡，分层只给 recent 1.1；
//   · 老记忆靠 important + longTerm(1.2) 赢，刚刷的视频连 BM25 前 50 都进不去（候选就被砍掉了）。
//
// 修复（lib/retrieval.js）：带时间词时，窗口内的近期记忆先进候选池（截断之前），排序时再加权。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('memory-recall-recent-78-');
const { openDatabase } = await import('../lib/db.js');
const { recallSync, recencyIntent, recencyWeight } = await import('../lib/retrieval.js');
const { decayFactor } = await import('../lib/soul-memory.js');
const { tokenizeForBm25 } = await import('../lib/segment.js');

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const clock = { now: () => NOW };
const ok = (n) => console.log('✓', n);

/** 每个用例一份干净的库：夹具互不干扰。 */
function setup() {
	process.env.DSH_HOME = tmpHome('memory-recall-recent-78-');
	const db = openDatabase();
	const insert = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
		importance, emotion, created_at, updated_at, status)
		VALUES ('feiyu', 'self', 'bili', 'bili:video:x', 'event', ?, ?, ?, 0, ?, ?, 'active')`);
	const add = (content, importance, ageDays) => {
		const at = NOW - ageDays * DAY;
		return Number(insert.run(content, tokenizeForBm25(content), importance, at, at).lastInsertRowid);
	};
	const recall = (query, topK = 5) => recallSync({ db, clock, config: { topK }, characterId: 'feiyu', ownerId: 'user:a', query, vec: null });
	const explain = (query, topK = 5) => recallSync({ db, clock, config: { topK }, characterId: 'feiyu', ownerId: 'user:a', query, vec: null, explain: true });
	return { db, add, recall, explain };
}

test('时间意图认的是「刚才」这类词，不是「金刚」「今天的晚饭」', () => {
	assert.ok(recencyIntent('你刚才刷了什么视频呀？'), '「刚才」是时间意图');
	assert.ok(recencyIntent('刚刚那条视频'), '「刚刚」是时间意图');
	assert.ok(recencyIntent('你最近刷了什么'), '「最近」是时间意图');
	assert.ok(recencyIntent('上次那个梗'), '「上次」也是纯指时间的词');
	assert.equal(recencyIntent('今天晚饭吃什么'), null, '「今天晚饭」里的「今天」是话题，不是时间意图');
	assert.equal(recencyIntent('昨天写的东西在哪'), null, '「昨天」同理，不能动普通问句');
	assert.equal(recencyIntent('金刚侠的电影'), null, '「金刚」不是「刚」');
	assert.equal(recencyIntent('晚饭吃什么'), null, '没有时间词就没有时间意图');
	ok('时间意图只认「刚才 / 刚刚 / 最近」这类纯指时间的词');
});

test('「刚才」的问句：刚写的那条要能想起来，且排在老的、重要的前面', () => {
	const { db, add, recall } = setup();
	const oldId = add('我在B站刷到猫猫视频', 3, 40); // 老的、重要的：importance 3，不衰减，分层 longTerm
	const freshId = add('我在B站刷到狗狗的视频《狗子日常》，也挺好笑', 1, 0); // 刚写的：importance 1，分层 recent

	const plain = recall('刷了什么视频');
	assert.equal(plain[0].id, oldId, '普通问句还是老的重要的排前面（老行为不能变）');

	const withTime = recall('你刚才刷了什么视频呀？');
	assert.ok(withTime.some((m) => m.id === freshId), '刚刷的那条要能被想起来');
	assert.equal(withTime[0].id, freshId, '问「刚才」问的就是最近的，它该排第一');
	db.close();
	ok('带「刚才」的问句先想起近期的记忆');
});

test('近期记忆要进得了候选池：BM25 前 50 截断之前就得算进去', () => {
	const { db, add, recall } = setup();
	// 60 条老记忆把 BM25 前 50 占满（刷/视频 到处都是 → idf 几乎为 0，长度归一化让短的赢）
	const oldIds = [];
	for (let i = 0; i < 60; i++) oldIds.push(add(`我在B站刷到猫猫的视频片段${String(i).padStart(2, '0')}`, 3, 30));
	// 刚写的这条又长又新，BM25 分垫底 —— 普通查询时它在候选池外面（进不了前 50）
	const freshId = add('我在B站刷到狗狗的视频《狗子日常》，也挺好笑，就是那种看完会一直想着的猫猫片，特别治愈', 1, 0);

	const plain = recall('你刷了什么视频', 70);
	assert.ok(!plain.some((m) => m.id === freshId), '普通问句时它本来就该在候选池外面（这正是真机症状）');

	const withTime = recall('你刚才刷了什么视频呀？', 70);
	assert.ok(withTime.some((m) => m.id === freshId), '带「刚才」时它必须被捞进候选池');
	const ids = withTime.map((m) => m.id);
	const freshPos = ids.indexOf(freshId);
	const oldPos = ids.map((id, i) => (oldIds.includes(id) ? i : -1)).filter((i) => i >= 0);
	assert.ok(freshPos >= 0 && oldPos.every((p) => p > freshPos), '而且要排在所有老记忆前面');
	db.close();
	ok('时间加权在候选截断之前生效（不是事后加权）');
});

test('时间意图只重排命中的记忆，不把对不上的塞进召回', () => {
	const { db, add, recall } = setup();
	const freshId = add('我在B站刷到狗狗的视频《狗子日常》，也挺好笑', 1, 0);
	add('企鹅在冰棍摊前排队', 1, 0); // 同样刚写的，但跟问句对不上

	const hit = recall('你刚才刷了什么视频呀？', 10);
	assert.ok(hit.some((m) => m.id === freshId), '命中的近期记忆要能被想起来');
	assert.ok(!hit.some((m) => String(m.content).includes('企鹅')), '对不上词的记忆不能被时间加权捞出来');
	db.close();
	ok('只影响排序，不新增记忆');
});

test('遗忘曲线没被时间加权改掉：重要度 >= 3 恒不衰减', () => {
	const { db, add, explain } = setup();
	add('我在B站刷到猫猫视频', 3, 40);
	const oldId = db.prepare('SELECT id FROM memory WHERE content = ?').get('我在B站刷到猫猫视频').id;

	assert.equal(decayFactor({ importance: 3, updated_at: NOW - 400 * DAY, recall_count: 0, emotion: 0 }, NOW), 1, '重要的记忆永远不淡');
	assert.ok(decayFactor({ importance: 1, updated_at: NOW - 400 * DAY, recall_count: 0, emotion: 0 }, NOW) < 1, '不重要的会淡');
	// 同一条记忆，带不带时间词，衰减出来一样 —— 时间加权只改排序权重
	// （召回结果在 recalled 里，没被召回的才在 others 里，两边都要找）
	const find = (res, id) => [...res.recalled, ...res.others].find((c) => c.id === id);
	const a = find(explain('你刚才刷了什么视频呀？'), oldId);
	const b = find(explain('刷了什么视频'), oldId);
	assert.ok(a && b, '这条记忆在两种查询下都该出现在结果里');
	assert.equal(a.decay, b.decay, '衰减曲线没变');
	assert.equal(a.recency, 1, '老的记忆不加时间权重');
	assert.equal(recencyWeight({ created_at: NOW - 1000 }, NOW, recencyIntent('刚才')), 1.5, '窗口内的记忆加权');
	db.close();
	ok('时间加权只加在排序权重上，遗忘曲线原样');
});
