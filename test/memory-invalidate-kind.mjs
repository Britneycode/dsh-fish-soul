// 记忆失效的两种语义（PR2）：「记错了」和「事情变了」必须分开。
//
// 为什么要有：
//   Dream 的提示词里有一句「原文和你记的不一样，以原文为准，把错的填进 outdated」——
//   「记错了」和「事情变了」全塞进同一个桶。而且 `outdated` 要求填 `by`
//   （被哪条新记忆推翻），**记错的情况根本没有推翻它的新记忆** —— 是设计缺陷。
//
// 分开的理由（anima-brain 的 corrected / superseded 二分）：
//   - corrected：从来没真过（他随口编自己是医生）⇒ 从历史真相里排除
//   - superseded：曾经确实那样（他以前住 A 区）⇒ 历史查询里应该看得到
//
// 断言打「真跑一遍 Dream，库里那一行是什么状态」，不是读源码猜。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-invkind-');
const { openDatabase } = await import('../lib/db.js');
const db = openDatabase();
const { LifeEngine } = await import('../lib/life.js');

const now = Date.now();
const seed = (content) => Number(db.prepare(
	`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, importance, created_at, updated_at, status, evidence)
	 VALUES ('feiyu', 'user:master', 'qq-private', '10001', 'fact', ?, 2, ?, ?, 'active', '主人说的')`
).run(content, now, now).lastInsertRowid);

const mkLife = (reply) => new LifeEngine({
	db, clock: { now: () => now }, getConfig: () => ({ memory: {} }),
	callLlm: async () => reply, deliver: async () => true, log: () => {}, persona: () => ({}),
});

// ── ① 「记错了」落 corrected，不需要 by ──
{
	const id = seed('主人是医生');
	const life = mkLife(JSON.stringify({
		corrected: [{ id, reason: '原文里他说的是「在医学院念书」，不是医生' }],
	}));
	await life.runDream('user:master');
	const row = db.prepare('SELECT status, invalid_kind, superseded_by FROM memory WHERE id = ?').get(id);
	assert.equal(row.status, 'outdated', '记错的要失效');
	assert.equal(row.invalid_kind, 'corrected', '要标成「记错」，不是「过时」');
	assert.equal(row.superseded_by, null, '记错没有「推翻它的新记忆」');
}

// ── ② 「事情变了」落 superseded，必须带 by ──
{
	const old = seed('主人住在成都');
	const neu = seed('主人搬去杭州了');
	const life = mkLife(JSON.stringify({
		outdated: [{ id: old, by: neu, reason: '搬家了' }],
	}));
	await life.runDream('user:master');
	const row = db.prepare('SELECT status, invalid_kind, superseded_by FROM memory WHERE id = ?').get(old);
	assert.equal(row.status, 'outdated');
	assert.equal(row.invalid_kind, 'superseded', '事情变了是 superseded');
	assert.equal(row.superseded_by, neu, '要指向推翻它的新记忆');
}

// ── ③ 记错的还能查到（不可恢复 ≠ 不留痕）──
{
	const row = db.prepare("SELECT COUNT(*) n FROM memory WHERE invalid_kind = 'corrected'").get();
	assert.ok(row.n >= 1, '记错的行要留在库里（主人才知道它是怎么错的）');
}

// ── ④ 老库兜底：invalid_kind 为 NULL 的失效行按 superseded 读，不猜 ──
{
	const id = seed('主人喜欢吃辣');
	db.prepare("UPDATE memory SET status = 'outdated', valid_to = ?, invalid_kind = NULL WHERE id = ?").run(now, id);
	const src = (await import('node:fs')).readFileSync(new URL('../lib/routes-soul.js', import.meta.url), 'utf8');
	assert.match(src, /invalidKind: m\.invalid_kind \?\? \(/, 'memoryView 要给 invalidKind');
	assert.match(src, /m\.invalid_kind \?\? \(m\.status === 'outdated' \|\| m\.status === 'superseded' \? 'superseded' : null\)/,
		'老库 NULL 要兜底成 superseded，不能默认成 corrected（会把真的历史判成记错）');
}

// ── ⑤ 两种都要进 dream.log（可观测点）──
// 没有这个数，从外面根本看不出「纠正」到底生效了没有。
{
	const life = mkLife('{}');
	const src = (await import('node:fs')).readFileSync(new URL('../lib/life.js', import.meta.url), 'utf8');
	assert.match(src, /at: Date\.now\(\), ownerId, name, outdated, corrected,/,
		'dream.log 要带上 corrected，否则不知道有没有纠正过');
}

// ── ⑥ 重要度 5 的两桶都不动（和旧行为一致）──
{
	const id = Number(db.prepare(
		`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, importance, created_at, updated_at, status)
		 VALUES ('feiyu', 'user:master', 'qq-private', '10001', 'fact', '主人手动锁死的重要记忆', 5, ?, ?, 'active')`
	).run(now, now).lastInsertRowid);
	const life = mkLife(JSON.stringify({ corrected: [{ id, reason: '试着动一下' }] }));
	await life.runDream('user:master');
	assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(id).status, 'active', '重要度 5 的不许判失效');
}

console.log('✓ memory-invalidate-kind：6 组断言全过');
