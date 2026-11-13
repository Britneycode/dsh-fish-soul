// 抖音私信「永久卡 processing / 变 unknown 挡住整个会话」的三条修复。
//
// 真机 2026-11-13 的现象：
//   #292 08:44:21 进来 → 一直 processing（20 分钟没人动）
//   #296/#297 08:45:40 进来 → 08:46:37 变 unknown（这一轮没拿到处理确认）
//   同一条 unknown 会把**同会话后面所有消息**挡住（next() 的 NOT EXISTS）。
//
// 三条修复各自对应一个能独立复现的判据：
//   ① 兜底结算：turn/end 丢了（会话恢复 / 事件丢失 / provider 异常）时，
//      消息不能永远卡在 processing —— 超过 90 秒就落「待核实」，队列继续走。
//   ② 锁被占时也要能自愈：收件箱维护原本挂在 exclusive 锁里面的 pollInner，
//      读私信 hang 住时锁不放 → pollInner 排不上 → 卡住的消息永远回收不回来。
//   ③ unknown 只挡「自己之后 30 秒内」的消息：面板已经不给核实入口了
//      （v0.15.53 删掉了那块 UI），一条 unknown 挡住整个会话就是永久哑掉。
//
// 外加一条配套：迟到的成功确认（turn/end 迟到 / 90 秒兜底先落了待核实）
// 要能把 unknown 改回 done —— 否则慢一点的正常轮次会被误判成「要核实」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DouyinInbox } from '../lib/douyin-inbox.js';
import { DouyinChannel } from '../lib/channels/douyin.js';
import { ChatGateway, SOURCE_DOUYIN } from '../lib/gateway.js';
import { openDatabase } from '../lib/db.js';

const home = mkdtempSync(join(tmpdir(), 'fish-stuck-'));
process.env.DSH_HOME = home;
const db = openDatabase();
const box = new DouyinInbox(db);
/** 每个用例前清空收件表：next() 取的是全局最老的一条 pending，别的用例留着会串味。 */
const reset = () => db.exec('DELETE FROM douyin_inbox');
const msg = (id, channelId = 'douyin:stuck') => ({ channelId, messageId: id, text: id, timeMs: Date.now() });
const statusOf = (id) => db.prepare('SELECT status,error FROM douyin_inbox WHERE id=?').get(id);
/** 把某条记录的时间戳往前挪 ms 毫秒（造「已经过去多久」）。 */
const age = (id, ms) => db.prepare('UPDATE douyin_inbox SET updated_at=?,created_at=? WHERE id=?').run(Date.now() - ms, Date.now() - ms, id);
/** 只挪 updated_at（造「待核实是什么时候留下的」），created_at 不动。 */
const ageOnly = (id, ms) => db.prepare('UPDATE douyin_inbox SET updated_at=? WHERE id=?').run(Date.now() - ms, id);

// ── ① 兜底结算：turn/end 丢了也不能永远卡在 processing ──────────────────────
test('处理中超过 90 秒没等到结算，落「待核实」，队列不再被它占着', () => {
	reset();
	box.record('stuck-timeout', {}, [msg('t1')]);
	const row = box.next();
	assert.ok(box.start(row.id), '要能开始处理');
	assert.equal(statusOf(row.id).status, 'processing');

	age(row.id, 91_000);
	assert.equal(box.reclaimStuck(), 1, '超时的处理中要被回收');
	assert.equal(statusOf(row.id).status, 'unknown', '收不回来的那一轮落待核实（可能已经发出去了）');
	assert.match(statusOf(row.id).error, /没等到确认|卡住/, '要说清为什么');
});

test('还在正常处理中（不到 90 秒）不被回收', () => {
	reset();
	box.record('stuck-fresh', {}, [msg('t2')]);
	const row = box.next();
	box.start(row.id);

	age(row.id, 30_000);
	assert.equal(box.reclaimStuck(), 0, '没超时不回收（模型慢一点是正常的）');
	assert.equal(statusOf(row.id).status, 'processing');
});

test('迟到的成功确认能把「待核实」改回已完成（兜底不会误伤慢轮次）', () => {
	reset();
	box.record('stuck-late', {}, [msg('t3')]);
	const row = box.next();
	box.start(row.id);
	box.settle([row.id], false); // 兜底先落待核实
	assert.equal(statusOf(row.id).status, 'unknown');

	box.settle([row.id], true); // 迟到的 turn/end 说这轮其实成功了
	assert.equal(statusOf(row.id).status, 'done', '迟到的成功要能改回已完成');
});

// ── ② 锁被占时也要能自愈 ────────────────────────────────────────────────────
test('读私信的锁被焊死时，卡住的 processing 每轮照样能被回收', async () => {
	reset();
	const ch = new DouyinChannel({
		db,
		// exclusive 永远不放锁：模拟真机上「驱动读 hang 住，锁焊死」
		host: { running: true, loggedIn: true, exclusive: async () => undefined },
		getConfig: () => ({ enabled: true }),
		log: () => {},
		onMessage: async () => ({ done: true }),
		driver: { checkLogin: async () => true, list: async () => ({ ok: true, conversations: [] }) },
	});
	ch.consumePushFrames = async () => {};
	ch.inbox.record('stuck-lock', {}, [msg('t4')]);
	const row = ch.inbox.next();
	ch.inbox.start(row.id);
	age(row.id, 91_000);

	await ch.pollOnce();
	assert.equal(statusOf(row.id).status, 'unknown', '锁被占着也要能回收（否则这条永远 processing）');
});

test('收件箱维护不排在读私信的锁后面', () => {
	const src = readFileSync(new URL('../lib/channels/douyin.js', import.meta.url), 'utf8');
	const pollOnce = src.slice(src.indexOf('async pollOnce()'), src.indexOf('async pollInner()'));
	assert.ok(/reclaimStuck/.test(pollOnce), '回收要放在 pollOnce（拿锁之前）');
	assert.ok(!/reclaimStuck/.test(src.slice(src.indexOf('async pollInner()'), src.indexOf('async drainInbox()'))), 'pollInner 里不再回收（它排在锁后面）');
});

// ── ③ unknown 只挡「自己之后 30 秒内」的消息 ────────────────────────────────
test('一条待核实只按住它之后 30 秒内的同会话消息，超过就不挡了', () => {
	reset();
	const ch = 'douyin:block-window';
	box.record('stuck-window', {}, [msg('w1', ch), msg('w2', ch)]);
	const first = box.next();
	box.start(first.id);
	box.settle([first.id], false);

	assert.equal(box.next(), null, '刚变待核实时，后面紧跟着的那条先按住（给核实留时间）');

	ageOnly(first.id, 60_000); // 待核实已经是 60 秒前的事了
	const after = box.next();
	assert.ok(after, '超过 30 秒后同会话后面的消息要能继续走');
	assert.equal(JSON.parse(after.payload).messageId, 'w2');
});

test('待核实不挡别的会话', () => {
	reset();
	box.record('stuck-window2', {}, [msg('w3', 'douyin:one'), msg('w4', 'douyin:two')]);
	const first = box.next();
	box.start(first.id);
	box.settle([first.id], false);
	const other = box.next();
	assert.ok(other, '别的会话不受这条待核实影响');
	assert.equal(JSON.parse(other.payload).messageId, 'w4');
});

test('「待核实」的窗口按它自己落下多久算，不看消息什么时候入队', () => {
	reset();
	const ch = 'douyin:queued';
	box.record('stuck-queued', {}, [msg('q1', ch), msg('q2', ch)]);
	const first = box.next();
	box.start(first.id);
	box.settle([first.id], false); // q1 变待核实

	const rows = db.prepare('SELECT id FROM douyin_inbox ORDER BY id').all();
	const q2 = rows[1].id;
	ageOnly(first.id, 40_000); // 待核实是 40 秒前落的 ⇒ 30 秒窗口早就过了
	age(q2, 20_000); // q2 的入队时间比待核实还早 20 秒 —— 拿入队时间去比的话它会永远落在窗口里

	const after = box.next();
	assert.ok(after, '不能因为入队时间早就永远卡住');
	assert.equal(JSON.parse(after.payload).messageId, 'q2');
});

// ── ④ 网关侧：这一轮为什么没成功，要留在运行日志里 ──────────────────────────
/** 造一个只用到 onSessionEvent 的网关壳子。 */
function fakeGateway(inbox, entries) {
	return Object.assign(Object.create(ChatGateway.prototype), {
		bound: new Map([['s', {}]]),
		turns: new Map(),
		waiters: new Map(),
		interjectTurns: new Set(),
		douyin: { inbox },
		note: () => {},
		log: () => {},
		diag: { add: (key, detail, level) => entries.push({ key, detail, level }) },
		sendReply: async () => true,
	});
}

test('这一轮没正常结束时，运行日志里能看出原因', () => {
	reset();
	box.record('stuck-diag', {}, [msg('g1')]);
	const row = box.next();
	box.start(row.id);
	const entries = [];
	const gw = fakeGateway(box, entries);

	gw.onSessionEvent({ id: 's' }, { type: 'user/message', data: { message: { id: 'm1', source: { kind: SOURCE_DOUYIN, channelId: 'douyin:g', inboxIds: [row.id] } } } });
	gw.onSessionEvent({ id: 's' }, { type: 'turn/end', data: { reason: { kind: 'content_filter' } } });

	const e = entries.find((x) => x.key.startsWith('turn-end-failed'));
	assert.ok(e, '没正常结束要在运行日志里留一条');
	assert.equal(e.detail.reasonKind, 'content_filter', '要记下结束原因');
	assert.equal(e.detail.fromUs, true, '要记下这一轮是不是我们自己发的');
	assert.deepEqual(e.detail.inboxIds, [row.id], '要记下是哪几条私信等着这次结算');
});

test('正常回完的一轮不写运行日志（热路径别刷屏）', () => {
	reset();
	box.record('stuck-diag2', {}, [msg('g2')]);
	const row = box.next();
	box.start(row.id);
	const entries = [];
	const gw = fakeGateway(box, entries);

	gw.onSessionEvent({ id: 's' }, { type: 'user/message', data: { message: { id: 'm2', source: { kind: SOURCE_DOUYIN, channelId: 'douyin:g', inboxIds: [row.id] } } } });
	gw.onSessionEvent({ id: 's' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });

	assert.equal(entries.filter((x) => x.key.startsWith('turn-end-failed')).length, 0, '成功的一轮不写');
	assert.equal(entries.filter((x) => x.key.startsWith('inbox-settle')).length, 0, '正常成功不写结算日志（热路径别刷屏）');
});

test('会话事件对不上号（bound 里没有）时，运行日志里能看出是哪个会话', () => {
	reset();
	const entries = [];
	const gw = fakeGateway(box, entries);

	gw.onSessionEvent({ id: 'fish-soul-abcd' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	const e = entries.find((x) => x.key === 'session-event-drop');
	assert.ok(e, '认不出的会话要留一条');
	assert.equal(e.detail.sessionId, 'fish-soul-abcd');
	assert.deepEqual(e.detail.known, ['s'], '要列出已知的会话，好对号');
});

test('别人的会话事件不记（否则运行日志会被刷爆）', () => {
	reset();
	const entries = [];
	const gw = fakeGateway(box, entries);

	gw.onSessionEvent({ id: 'someone-else-session' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	assert.equal(entries.filter((x) => x.key === 'session-event-drop').length, 0, '不是我们的会话就别记');
});

test('结算落「待核实」时，运行日志里说得清是哪几条、为什么', () => {
	reset();
	box.record('stuck-settle', {}, [msg('s1')]);
	const row = box.next();
	box.start(row.id);
	const entries = [];
	const gw = fakeGateway(box, entries);

	gw.onSessionEvent({ id: 's' }, { type: 'user/message', data: { message: { id: 'm1', source: { kind: SOURCE_DOUYIN, channelId: 'douyin:g', inboxIds: [row.id] } } } });
	gw.onSessionEvent({ id: 's' }, { type: 'turn/end', data: { reason: { kind: 'content_filter' } } });

	const e = entries.find((x) => x.key.startsWith('inbox-settle'));
	assert.ok(e, '结算要留一条（否则不知道是哪几条私信没成）');
	assert.deepEqual(e.detail.ids, [row.id], '要记下是哪几条私信');
	assert.equal(e.detail.ok, false);
	assert.match(e.detail.reason, /content_filter/, '要记下结束原因');
	assert.match(statusOf(row.id).error, /content_filter/, '收件表里的原因也要说清（不是一句「结果不确定」）');
});

test('回复没发出去时，运行日志里说得清是发送失败（不是模型没结束）', async () => {
	reset();
	box.record('stuck-send', {}, [msg('s2')]);
	const row = box.next();
	box.start(row.id);
	const entries = [];
	const gw = fakeGateway(box, entries);
	gw.sendReply = async () => { throw new Error('输入框被读操作清掉了'); };

	gw.onSessionEvent({ id: 's' }, { type: 'user/message', data: { message: { id: 'm2', source: { kind: SOURCE_DOUYIN, channelId: 'douyin:g', inboxIds: [row.id] } } } });
	gw.onSessionEvent({ id: 's' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	await new Promise((resolve) => setTimeout(resolve, 0)); // 等 sendReply 的拒绝处理完

	const e = entries.find((x) => x.key.startsWith('inbox-settle'));
	assert.ok(e, '发送失败也要留一条');
	assert.match(e.detail.reason, /回复没发出去/, `要说清是发送失败：${JSON.stringify(e?.detail ?? {})}`);
	assert.match(statusOf(row.id).error, /回复没发出去/, '收件表里的原因也要说清');
});

test.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
