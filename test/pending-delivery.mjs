// #80：待办（remember 时登记的到期提醒）投递不准时、错过就再也不触发。
//
// 报告里两句话，对应两类问题：
// ①「总是会延迟一会」—— tick 是 15 分钟一轮，到点提醒只能跟着这个粒度走（平均晚 7.5 分钟、最坏 15 分钟），
//    而且一轮只投一条：三条同时到点要分别等 15/30/45 分钟。
//    修法：按最近一条 due_at 单独挂闹钟，只跑到点投递那一段；一次把用户交代的全发掉。
// ②「错过那个时间点很久都没办法再触发」—— 投递失败只重试 3 次、每次 +10 分钟，半小时后就永久 failed；
//    被「顺口提起」过的（surfaced）更是提起一次就再也不回来。
//    修法：退避阶梯 1/2/5/10/30/60 分钟共 6 次；surfaced 过 6 小时退回 pending。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { VirtualClock } from '../lib/clock.js';
import { LifeEngine } from '../lib/life.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;

const home = tmpHome('dsh-80-');
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const db = openDatabase();
process.env.DSH_HOME = prevHome;

// 虚拟钟 ×1000：1 虚拟分钟 ≈ 60 真实毫秒，测试里等得起
const t = Date.parse('2030-01-01T06:00:00Z'); // 14:00 UTC+8，落在活跃时段
const clock = new VirtualClock(1000, t);
const cfg = () => ({
	proactive: {
		enabled: true, dailyMaxCount: 5, activeHours: [8, 24], idleTriggerHours: 6, idleRealGapMinutes: 30,
		targets: { masterCanonicalId: 'user:master', masterPrivateChannelId: 'private:123', selfGroupChannelIds: [] }
	}
});
const sent = [];
let nextResult = true;
let nextTimedOut = false;
const mk = () => new LifeEngine({
	db, clock, getConfig: cfg, callLlm: async () => null, log: () => {},
	deliver: async (ch, reason, meta) => {
		sent.push([ch, reason]);
		if (nextTimedOut) meta.timedOut = true;
		return nextResult;
	}
});
let life = mk();
const parts = clock.getRoleDateParts();
db.prepare(`INSERT INTO day (date, character_id, plan_json, proactive_count, last_proactive_at, generated_at)
	VALUES (?, 'feiyu', ?, 0, NULL, ?)`).run(parts.dateStr, JSON.stringify({ date: parts.dateStr, dailyMoodTone: '平静', schedule: [] }), t);

/** 插一条到点的待办。channel 默认是白名单里的主人私聊。 */
const addPending = (dueAt, { channelId = 'private:123', origin = 'user', reason = '九点提醒开会', status = 'pending', surfacedAt = null } = {}) => {
	const r = db.prepare(`
		INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at, origin, surfaced_at)
		VALUES ('feiyu', 'user:master', 'qq-private', ?, ?, ?, ?, ?, ?, ?)
	`).run(channelId, dueAt, reason, status, t, origin, surfacedAt);
	return Number(r.lastInsertRowid);
};
const row = (id) => db.prepare('SELECT * FROM pending WHERE id = ?').get(id);
const clearPending = () => db.prepare('DELETE FROM pending').run();

// ① 三条同时到点 → 一轮全发，不再 15/30/45 分钟地排队
clearPending();
const ids = [addPending(t - 3 * MIN), addPending(t - 2 * MIN), addPending(t - MIN)];
sent.length = 0;
assert.equal(await life.flushDue(cfg().proactive), true, '有到点的待办就要算"这一轮投过"（不再走空闲兜底）');
assert.equal(sent.length, 3, '三条到点的提醒一轮全发（以前一轮只发一条）');
for (const id of ids) assert.equal(row(id).status, 'done', `待办 #${id} 发出去就该置 done`);
console.log('ok 1 三条同时到点：一轮全发');

// ② 到点闹钟：按 due_at 精确醒来，只跑到点投递那一段
clearPending();
sent.length = 0;
life = mk();
life.armPendingAlarm();
assert.equal(life.alarm, null, '没有待办就不该挂闹钟');
addPending(t + MIN);
life.armPendingAlarm();
assert.notEqual(life.alarm, null, '有待办就要挂上闹钟');
await sleep(1500);
assert.deepEqual(sent, [['private:123', '九点提醒开会']], '闹钟到点后自己投递，不用等 15 分钟 tick（#80 ①）');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pending WHERE status = 'done'").get().n, 1);
life.stop();
assert.equal(life.alarm, null, 'stop 要把闹钟一起清掉');
console.log('ok 2 到点闹钟：不等 15 分钟 tick');

// ③ 非白名单的待办不该拿来定闹钟（否则白醒一轮），也不该被主动投递
clearPending();
sent.length = 0;
life = mk();
const stranger = addPending(t - MIN, { channelId: 'private:999', reason: '别人家的提醒' });
const later = addPending(t + 30 * MIN, { reason: '半小时后提醒' });
const delay = life.nextPendingVirtualDelay();
const expectDelay = row(later).due_at - clock.now();
assert.ok(delay !== null && Math.abs(delay - expectDelay) < 5000, '跳过早到点的非白名单待办，取白名单里最近的那条');
await life.flushDue(cfg().proactive);
assert.equal(sent.length, 0, '非白名单待办不主动投递（等对方开口时顺口提）');
assert.equal(row(stranger).status, 'pending', '非白名单待办保持 pending');
console.log('ok 3 非白名单待办：不定闹钟、不主动投递');

// ④ 投不出去：按阶梯退避，6 次才判 failed（以前 3 次 × 10 分钟 = 半小时就死了）
clearPending();
sent.length = 0;
life = mk();
nextResult = false;
const flaky = addPending(t - MIN, { reason: '明天考试' });
await life.flushDue(cfg().proactive);
let r = row(flaky);
assert.equal(r.attempts, 1, '失败一次记一次');
assert.equal(r.status, 'pending', '第一次失败当然还得重试');
assert.equal(r.due_at, t - MIN + MIN, '第一次失败顺延 1 分钟（阶梯第一档）');
db.prepare('UPDATE pending SET attempts = 5, due_at = ? WHERE id = ?').run(t - MIN, flaky);
life.lastProactiveReal.clear(); // 15 秒物理冷却是真实时间，测试里跳过
await life.flushDue(cfg().proactive);
r = row(flaky);
assert.equal(r.attempts, 6, '第六次也记上');
assert.equal(r.status, 'failed', '6 次都发不出去才放弃');
console.log('ok 4 投递失败：阶梯退避 6 次，总窗口约 1 小时 48 分');

// ⑤ 模型超时：同样退避（不然模型卡住会每分钟重叫一次），但状态仍是 pending
clearPending();
life = mk();
nextResult = false;
nextTimedOut = true;
const slow = addPending(t - MIN, { reason: '到点该说了' });
await life.flushDue(cfg().proactive);
assert.equal(row(slow).status, 'pending', '超时不是"发不出去"，还得重试');
assert.equal(row(slow).attempts, 1, '超时也要计一次，否则会无限重试');
nextTimedOut = false;
nextResult = true;
console.log('ok 5 模型超时：仍算待重试，但会退避');

// ⑥ surfaced 过的待办：6 小时还没说到，退回 pending 重来（以前提起一次就永远消失）
clearPending();
sent.length = 0;
life = mk();
const surfacedLong = addPending(t - 2 * 3600_000, { channelId: 'private:999', status: 'surfaced', surfacedAt: t - 7 * 3600_000, reason: '上次没说完' });
const surfacedFresh = addPending(t - 2 * 3600_000, { channelId: 'private:999', status: 'surfaced', surfacedAt: t - 3600_000, reason: '刚提过' });
await life.flushDue(cfg().proactive);
assert.equal(row(surfacedLong).status, 'pending', '过了 6 小时要退回 pending，别让提醒就这么没了（#80 ②）');
assert.equal(row(surfacedFresh).status, 'surfaced', '刚提起过的先不动，给对方回话的机会');
console.log('ok 6 surfaced 回收：提起过没说到，6 小时后重来');

console.log('\npending-delivery ok');
