// 内联卡片要有交付账本（2026-11-19 修）。
//
// 以前：聊天里发的链接变成的卡片**完全不记账**。
// 后果：同一封私信被判「待核实」后主人在面板点重试 ⇒ 再发一张卡
//       ⇒ 对方收到两张一模一样的卡片。
//
// 现在：跟主动分享共用同一套 `douyin.cardDelivery.*` 账本，提交过就绝不自动重发。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-inline-ledger-');
const { openDatabase, getKv } = await import('../lib/db.js');
const { DouyinAdapter } = await import('../lib/douyin-adapter.js');

const ok = (m) => console.log('✓', m);
const db = openDatabase();
const CONV = '0:1:123:456';
const VIDEO = '7707911549709601777';

/** 造一个能记录卡片、可控制结果的适配器。 */
const makeAdapter = (cardResults) => {
	let i = 0;
	const cards = [];
	const adapter = new DouyinAdapter({
		db: () => db,
		getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
		inbox: () => null,
		channel: () => ({
			async shareCard(p) {
				cards.push(p.videoId);
				const r = cardResults[Math.min(i, cardResults.length - 1)];
				i++;
				return r;
			},
			async send() { return { ok: true, delivered: true, parts: [] }; },
		}),
		sendText: async () => ({ ok: false }),
		note: () => {}, log: () => {}, diag: () => {},
	});
	return { adapter, cards };
};

const link = `https://www.douyin.com/video/${VIDEO}`;

// ── 1. 成功一次 ⇒ 账本记 verified ──
{
	const { adapter, cards } = makeAdapter([{ ok: true, verified: true }]);
	await adapter.send({ channel_id: 'douyin:某人' }, link, [], CONV);
	assert.equal(cards.length, 1, '发了一张卡');
	const hash = adapter.inlineDeliveryId(CONV, VIDEO);
	const key = `douyin.cardDelivery.${(await import('node:crypto')).createHash('sha256').update(hash).digest('hex').slice(0, 32)}.${VIDEO}`;
	const st = getKv(db, key, null);
	assert.notEqual(st, null, '账本里要有一条记录');
	assert.equal(st.phase, 'verified', '成功要记 verified');
	ok('成功：账本记 verified');
}

// ── 2. 🔴 同一张卡再发一次 ⇒ 账本说 verified，不该再发 ──
{
	const { adapter, cards } = makeAdapter([{ ok: true, verified: true }]);
	await adapter.send({ channel_id: 'douyin:某人' }, link, [], CONV);
	assert.equal(cards.length, 0, `🔴 已经发过的卡不该再发，实际发了 ${cards.length} 次`);
	ok('已发过的卡：不重复发（账本挡住）');
}

// ── 3. 🔴 提交过但没回读到 ⇒ unknown，之后再发也不重发 ──
{
	const conv2 = '0:1:123:999';
	const { adapter, cards } = makeAdapter([{ ok: false, verified: false, submitted: true, error: '分享已提交但没回读' }]);
	const r1 = await adapter.send({ channel_id: 'douyin:某人' }, link, [], conv2);
	assert.equal(cards.length, 1, '第一次要真的发');
	assert.equal(r1.cardOk, false, '没回读到就不算成功');
	// 再发一次（模拟重试）
	const r2 = await adapter.send({ channel_id: 'douyin:某人' }, link, [], conv2);
	assert.equal(cards.length, 1, `🔴 提交过的卡绝不能重发，实际发了 ${cards.length} 次`);
	assert.equal(r2.cardOk, false, '仍然是未确认状态');
	ok('提交过未确认：不重发（这正是重复卡片的来源）');
}

// ── 4. 没提交过（压根没发出去）⇒ 可以再试 ──
{
	const conv3 = '0:1:123:888';
	const { adapter, cards } = makeAdapter([
		{ ok: false, verified: false, error: '浏览器没在运行' },   // 第一次：没提交
		{ ok: true, verified: true },                              // 第二次：成功
	]);
	const r1 = await adapter.send({ channel_id: 'douyin:某人2' }, link, [], conv3);
	assert.equal(r1.cardOk, false, '第一次失败');
	assert.equal(cards.length, 1);
	// 再发（模拟重试）
	const r2 = await adapter.send({ channel_id: 'douyin:某人2' }, link, [], conv3);
	assert.equal(cards.length, 2, '没提交过就该允许再试（不是所有失败都要永久封死）');
	assert.equal(r2.cardOk, true, '第二次成功');
	ok('没提交过：允许重试（只有「提交过」才封死）');
}

// ── 5. 账本写不进去 ⇒ 降级成不记账照常发 ──
{
	const cards = [];
	const adapter = new DouyinAdapter({
		db: () => ({}),  // 没有 kv 表
		getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
		inbox: () => null,
		channel: () => ({
			async shareCard(p) { cards.push(p.videoId); return { ok: true, verified: true }; },
			async send() { return { ok: true, delivered: true, parts: [] }; },
		}),
		sendText: async () => ({ ok: false }),
		note: () => {}, log: () => {}, diag: () => {},
	});
	const r = await adapter.send({ channel_id: 'douyin:某人' }, link, [], '0:1:777:888');
	assert.equal(cards.length, 1, '账本坏了也要照常发卡片（不能因为记账失败就不干活）');
	assert.equal(r.cardOk, true);
	ok('账本不可用：降级成不记账照常发');
}

// ── 6. 🔴 不同轮（不同 scope）⇒ 能发第二次 ──
//
// 这条和上面「不重复发」是一对：账本不能把「同一个视频」永久封死。
// 她今天说「这个好看」发一张，过几天说「再看一次」必须还能发。
{
	const conv4 = '0:1:123:555';
	const { adapter, cards } = makeAdapter([{ ok: true, verified: true }]);
	await adapter.send({ channel_id: 'douyin:某人' }, link, [], conv4, 'session-aaa');
	assert.equal(cards.length, 1, '第一轮发一张');
	// 同一轮重试：不该再发
	await adapter.send({ channel_id: 'douyin:某人' }, link, [], conv4, 'session-aaa');
	assert.equal(cards.length, 1, '同一轮重试不重发');
	// 下一轮：应该能发
	await adapter.send({ channel_id: 'douyin:某人' }, link, [], conv4, 'session-bbb');
	assert.equal(cards.length, 2, '🔴 不同轮要能发第二次（不能永久封死同一个视频）');
	ok('不同轮：同一个视频还能再发（账本只挡同一轮的重试）');
}

console.log('内联卡片交付账本：测试全部通过');
