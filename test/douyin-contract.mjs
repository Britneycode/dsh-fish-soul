/**
 * 抖音模块化的契约测试（PR1，只加不改）。
 *
 * 目的：把「抖音在网关里承诺的行为」钉成显式断言，重构（PR2~PR5）前后这些断言都必须绿。
 * 全部通过网关公开方法测试，不直接 import 任何新文件。
 *
 * 四条保证：
 *   ① 昵称不授权：昵称形状的身份不入队；masterName 等于昵称也不授权；
 *      isMasterChannel / sessionOpenFor 对抖音一律 false。
 *   ② 没有 convId 就拒发：convId 为空 / 格式不符 / 群聊形状时 sendDouyin 返回 ok:false
 *      且通道 send 调用次数为 0；sendReply 在 st.convId 缺失时同样不发。
 *   ③ 重发带原会话 ID：outbox.enqueue({convId}) 后，在同一个库上新建 Outbox 模拟重启，
 *      重试时发送方收到同一个 convId。
 *   ④ 结果未知不自动重发：outbox unknown 状态不重试（已有 test/outbox.mjs 覆盖 QQ，
 *      这里补抖音路径：convId 也一并被保住）。
 *
 * 红验证：依次手工破坏这四条（改 sendDouyin 的 convId 校验、改 outbox 不传 convId、
 * 改 onDouyinMessage 不按身份拦），每条至少让这里一条断言红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-contract-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { Outbox } = await import('../lib/outbox.js');

/** 造一个最小网关：抖音通道是 spy，soul 是替身。 */
function makeGateway(overrides = {}) {
	const db = openDatabase();
	const sends = [];
	const config = {
		qq: { enabled: true }, masterQqUin: '12345678', tools: { sessionAllow: 'all' },
		douyin: { enabled: true, masterName: '主人', masterUid: 'douyin:111', autoReply: true, replyWindowMinutes: 30 },
		...(overrides.config ?? {})
	};
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db,
		clock: { now: () => Date.now() },
		getConfig: () => config,
		log: () => {},
		channel: { connected: true, send: async () => 'ok', isFriend: () => true },
		douyin: {
			connected: true,
			send: async (name, parts, target) => { sends.push({ name, parts, target }); return { ok: true, delivered: true }; },
			selfUids: () => []
		},
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) },
		...(overrides.deps ?? {})
	});
	return { gw, db, sends, config };
}

// ── ① 昵称不授权 ─────────────────────────────────────────────
test('昵称形状的身份不入队、不授权、不给主人待遇', async () => {
	const { gw, db, sends } = makeGateway();
	const r = await gw.onDouyinMessage({ userId: '主人', peerName: '主人', channelId: 'douyin:主人', chatType: 'private', text: '在吗', timeMs: Date.now() });
	assert.match(r.review, /身份/, '昵称身份必须被拦在「身份未确认」');
	// 不进入队列 = 后续不会触发 sendDouyin
	assert.equal(sends.length, 0);
	// masterName 等于昵称也不授权：昵称冒充主人没用
	assert.equal(gw.isMasterChannel('douyin:主人'), false);
	assert.equal(gw.sessionOpenFor('douyin:主人'), false);
	assert.equal(gw.personKeyOf({ channelId: 'douyin:主人', chatType: 'private', userId: '主人' }), '', '昵称算不出 QQ 号');
	// db 是共享真库，不关
});

test('masterName 配置成昵称也不授权（昵称不是身份）', async () => {
	const { gw, db } = makeGateway({ config: { douyin: { enabled: true, masterName: '主人', masterUid: '', autoReply: true } } });
	// masterUid 没填：「主人」这个昵称不能顶替数字身份
	assert.equal(gw.masterDouyinIdentity(), '', 'masterUid 没填时昵称不能当身份');
	assert.equal(await gw.masterDouyinConvId(), '', '没有身份就拿不到会话 ID');
	// db 是共享真库，不关
});

// ── ② 没有 convId 就拒发 ────────────────────────────────────
test('sendDouyin：convId 为空 / 格式错 / 群聊形状 → ok:false 且通道 send 次数为 0', async () => {
	const { gw, db, sends } = makeGateway();
	const bad = ['', 'abc', '0:2:111:222', '0:1:abc:222', '0:1:111:222:333'];
	for (const convId of bad) {
		const r = await gw.sendDouyin({ channel_id: 'douyin:某人', title: '抖音·某人' }, '你好', [], convId);
		assert.equal(r.ok, false, `convId=${JSON.stringify(convId)} 必须拒发`);
		assert.match(r.error, /会话|身份/, '要给一句人话原因');
	}
	assert.equal(sends.length, 0, '通道 send 一次都不能被调用');
	// db 是共享真库，不关
});

test('sendDouyin：合法 convId 才放行，convId 原样传给通道', async () => {
	const { gw, db, sends } = makeGateway();
	const r = await gw.sendDouyin({ channel_id: 'douyin:某人', title: '抖音·某人' }, '你好', [], '0:1:111:222');
	assert.equal(r.ok, true);
	assert.equal(sends.length, 1);
	assert.equal(sends[0].target, '0:1:111:222', 'convId 必须原样带到通道层');
	assert.equal(sends[0].name, '某人', '会话名从 channel_id 取');
	// db 是共享真库，不关
});

test('sendReply：抖音回合缺 convId 不发，也不落到别的平台', async () => {
	const { gw, db, sends } = makeGateway();
	// 会话绑定的是抖音通道
	gw.bound.set('s1', { channel_id: 'douyin:某人', title: '抖音·某人', workspace_path: '' });
	// st 里没有 convId（重启后重放 / 老格式消息）
	const ok = await gw.sendReply('s1', { text: '你好', images: [], channelId: 'douyin:某人', convId: '' });
	assert.equal(ok, false, '缺 convId 的抖音回复不能发出去');
	assert.equal(sends.length, 0);
	// db 是共享真库，不关
});

// ── ③ 重发带原会话 ID ───────────────────────────────────────
test('outbox：enqueue 带 convId，模拟重启后重发仍带同一个 convId', async () => {
	const db = new DatabaseSync(':memory:');
	let now = 1_000_000;
	const seg = [{ type: 'text', data: { text: '在吗' } }];
	// 第一次：通道拒发（retry），入队
	{
		const channel = { connected: true, async send() { throw new Error('发送失败（retcode 1200）'); } };
		const box = new Outbox({ db, channel, windowMs: () => 600_000, now: () => now });
		box.enqueue({ channelId: 'douyin:某人', title: '抖音·某人', segs: seg, text: '在吗', convId: '0:1:111:222' });
		await box.flush({ force: true });
		assert.equal(db.prepare('SELECT conv_id FROM outbox').get().conv_id, '0:1:111:222', 'convId 必须落盘');
		box.stop();
	}
	// 模拟重启：同一个库新建 Outbox，重发必须带同一个 convId
	{
		const got = [];
		const channel = { connected: true, async send(cid, segs, convId) { got.push({ cid, convId }); return 'ok'; } };
		const box = new Outbox({ db, channel, windowMs: () => 600_000, now: () => now });
		await box.flush({ force: true });
		assert.equal(got.length, 1, '重发一次');
		assert.equal(got[0].convId, '0:1:111:222', '重发仍带原会话 ID');
		box.stop();
	}
	// db 是共享真库，不关
});

// ── ④ 结果未知不自动重发（抖音路径） ─────────────────────────
test('outbox：发送中断（sending）的记录重启后标 unknown，不自动重发，convId 保留', async () => {
	const db = new DatabaseSync(':memory:');
	let now = 1_000_000;
	const seg = [{ type: 'text', data: { text: '在吗' } }];
	// 造一条 sending 状态的记录（模拟发送过程中进程退出）
	{
		const channel = { connected: true, async send() { /* 永不返回 */ return new Promise(() => {}); } };
		const box = new Outbox({ db, channel, windowMs: () => 600_000, now: () => now });
		box.enqueue({ channelId: 'douyin:某人', title: '抖音·某人', segs: seg, text: '在吗', convId: '0:1:111:222' });
		// 手动把状态改成 sending（模拟「标记了发送中但进程退出」）
		db.prepare("UPDATE outbox SET status = 'sending'").run();
		box.stop();
	}
	// 重启：sending → unknown，不重发
	{
		let sends = 0;
		const warnings = [];
		const channel = { connected: true, async send() { sends++; return 'ok'; } };
		const box = new Outbox({ db, channel, windowMs: () => 600_000, now: () => now, onGiveUp: (item, reason) => warnings.push(reason) });
		await box.flush({ force: true });
		assert.equal(sends, 0, 'unknown 状态绝不自动重发');
		assert.equal(db.prepare('SELECT status FROM outbox').get().status, 'unknown');
		assert.equal(db.prepare('SELECT conv_id FROM outbox').get().conv_id, '0:1:111:222', 'convId 必须保住，人工核实时要用');
		assert.ok(warnings.some((w) => /可能已经发出/.test(w)), '要提示人工核实');
		box.stop();
	}
	// db 是共享真库，不关
});

// ── 收件箱侧：unknown 不重新分派 ────────────────────────────
test('收件箱 unknown 状态的消息不再重新分派（next() 不捞 unknown）', async () => {
	const { DouyinInbox } = await import('../lib/douyin-inbox.js');
	// DouyinInbox.record 会用 db.js 的 setKv 记游标，内存库没有 kv 表 —— 用真库。
	const db = openDatabase();
	const box = new DouyinInbox(db);
	box.record('contract-cursor-unknown-' + Date.now(), {}, [
		{ channelId: 'douyin:某人', messageId: 'c1', convId: '0:1:111:222', text: '你好', senderId: '222', time: Date.now() },
		{ channelId: 'douyin:某人', messageId: 'c2', convId: '0:1:111:222', text: '还在吗', senderId: '222', time: Date.now() }
	]);
	const first = box.next();
	assert.ok(first !== null, '第一条能取到');
	box.start(first.id);
	// 结算失败 → unknown；unknown 后面同会话的消息不能被取到（30 秒窗口内）
	box.settle([first.id], false);
	assert.equal(box.next(), null, 'unknown 后面的消息不能被重新分派');
	// 主人核实后选择重试 → 才回到 pending
	assert.equal(box.resolve(first.id, 'retry'), true);
	const again = box.next();
	assert.ok(again !== null, '核实重试后才能再取到');
	// db 是共享真库，不关
});
