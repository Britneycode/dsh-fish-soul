/**
 * 抖音路由信息（PR3）：convId / inboxIds 的写入、吸收与结算。
 *
 * 三件事：
 *   ① 路由字段写进 source 的**位置和字段名不变**（宿主会重放旧格式消息）。
 *   ② 吸收路由：宿主重放的消息里带 convId / inboxIds 时，turn state 要认出来。
 *   ③ 结算：turn 结束 / 分派失败时，收件箱记录要被结算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-route-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { DouyinAdapter } = await import('../lib/douyin-adapter.js');

const CONV = '0:1:900001:1234567890123456789';

// ── ① routeOf：字段名与条件不变 ────────────────────────────
test('routeOf：抖音这批带 convId + inboxIds；别的平台不写 convId', () => {
	const db = openDatabase();
	const ad = new DouyinAdapter({ db, getConfig: () => ({}) });
	const items = [
		{ m: { inboxId: 11, convId: CONV } },
		{ m: { inboxId: 12, convId: CONV } }
	];
	// 抖音：convId 取**最后一条**消息的，inboxIds 全收
	const r = ad.routeOf(items, 'douyin');
	assert.deepEqual(r.inboxIds, [11, 12]);
	assert.equal(r.convId, CONV);
	// 别的平台：不写 convId（改前是 `platform === 'douyin' && last.convId`）
	assert.equal(ad.routeOf(items, 'qq').convId, undefined, '非抖音平台不写 convId');
	// 没有 inboxId / convId 时不写空字段
	assert.deepEqual(ad.routeOf([{ m: {} }], 'douyin'), {});
	// inboxIds 为空数组时也不写
	assert.deepEqual(ad.routeOf([{ m: { inboxId: null } }], 'douyin'), {});
});

// ── ② absorbRoute：宿主重放的消息要认得出路由信息 ──────────
test('absorbRoute：宿主重放的 source 带 convId / inboxIds 时要吸收进 state', () => {
	const db = openDatabase();
	const ad = new DouyinAdapter({ db, getConfig: () => ({}) });
	const st = { convId: '', inboxIds: [] };
	ad.absorbRoute(st, { convId: CONV, inboxIds: [7, 8] });
	assert.equal(st.convId, CONV, 'convId 要认出来（出站靠它校验发给谁）');
	assert.deepEqual(st.inboxIds, [7, 8]);
	// 重复吸收要去重（同一批消息可能被重放多次）
	ad.absorbRoute(st, { convId: CONV, inboxIds: [8, 9] });
	assert.deepEqual(st.inboxIds, [7, 8, 9], 'inboxIds 去重');
	// 没有路由字段时不动 state
	const st2 = { convId: '', inboxIds: [] };
	ad.absorbRoute(st2, { channelId: 'douyin:x' });
	assert.equal(st2.convId, '');
	assert.deepEqual(st2.inboxIds, []);
});

// ── ③ settle：结算走适配器 ─────────────────────────────────
test('settle：适配器把结算交给收件箱', () => {
	const db = openDatabase();
	const calls = [];
	const ad = new DouyinAdapter({ db, getConfig: () => ({}), inbox: () => ({ settle: (ids, ok, why) => calls.push({ ids, ok, why }) }) });
	ad.settle([1, 2], true, '');
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].ids, [1, 2]);
	assert.equal(calls[0].ok, true);
	ad.settle([3], false, '不确定');
	assert.equal(calls[1].why, '不确定');
	// 没有收件箱时静默返回，不抛
	const bare = new DouyinAdapter({ db, getConfig: () => ({}) });
	assert.doesNotThrow(() => bare.settle([1], true, ''));
});

// ── 接线：dispatch 写进 source 的路由字段 ─────────────────
//
// 这条守的是「写侧」：dispatch 算出来的路由字段要真的进 followup 的 source 顶层。
// 少了它，适配器的 routeOf 整个坏了也没人发现（测试 1 打的是适配器单测层，
// 测试 4/5 自己往 source 里塞字段、不经过 dispatch）。
test('网关：dispatch 抖音批 → followup source 顶层带 convId / inboxIds；QQ 批不带 convId', async () => {
	const db = openDatabase();
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ masterQqUin: '12345678', douyin: { enabled: true, masterUid: 'douyin:1234567890123456789' } }),
		log: () => {}, channel: { connected: true },
		douyin: { connected: true, send: async () => ({ ok: true, delivered: true }), inbox: { settle: () => {} } },
		soul: {
			memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }),
			beginTurn: () => {}, endTurn: () => {}
		}
	});
	const followups = [];
	// 假 agent：只提供 dispatchInner 用到的东西，followup 把 source 记下来
	const agent = {
		id: 'sess-d', options: {},
		followup: async (msg) => { followups.push(msg); return { id: 'f1' }; }
	};
	gw.ensureSession = async () => agent;
	gw.applyChatModelFor = () => {};
	gw.typing = () => {};
	gw.admitImages = async (text) => text;
	gw.videoNotes = async () => [];
	gw.runExclusiveForSession = async (_id, fn) => fn();

	// 抖音一批：带 convId + inboxId
	await gw.dispatch('douyin:某人', [
		{ m: { userId: 'douyin:1234567890123456789', nickname: '某人', messageId: 'm1', chatType: 'private', targetId: '某人', inboxId: 42, convId: CONV, timeMs: Date.now() }, person: null }
	]);
	assert.equal(followups.length, 1, '要发出一个 followup');
	const src = followups[0].source;
	assert.deepEqual(src.inboxIds, [42], 'inboxIds 要在 source 顶层');
	assert.equal(src.convId, CONV, 'convId 要在 source 顶层');
	// 字段名不能变：宿主重放旧格式消息靠的就是这两个键
	assert.ok(Object.hasOwn(src, 'convId') && Object.hasOwn(src, 'inboxIds'), '字段名固定为 convId / inboxIds');

	// QQ 一批：不带 convId
	followups.length = 0;
	await gw.dispatch('private:12345678', [
		{ m: { userId: '12345678', nickname: '主人', messageId: 'm2', chatType: 'private', targetId: '12345678', timeMs: Date.now() }, person: null }
	]);
	assert.equal(followups.length, 1);
	assert.equal(Object.hasOwn(followups[0].source, 'convId'), false, 'QQ 批不带 convId');
	assert.equal(Object.hasOwn(followups[0].source, 'inboxIds'), false, 'QQ 批不带 inboxIds');
});
test('网关：宿主重放带 convId 的抖音消息 → turn state 认得出 convId', () => {
	const db = openDatabase();
	const settled = [];
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ masterQqUin: '12345678', douyin: { enabled: true, masterUid: 'douyin:1234567890123456789' } }),
		log: () => {}, channel: { connected: true },
		douyin: { connected: true, send: async () => ({ ok: true, delivered: true }), inbox: { settle: (ids, ok, why) => settled.push({ ids, ok, why }) } },
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	assert.ok(gw.douyinAdapter instanceof DouyinAdapter, '构造时就建好了');
	// 模拟宿主重放一条带 convId 的抖音消息。
	// onSessionEvent 只处理「我们自己的会话」（bound 里有登记），且 source.kind 必须是我们的来源。
	gw.bound.set('sess-1', { session_id: 'sess-1', channel_id: 'douyin:某人' });
	const st = gw.turnState('sess-1');
	gw.onSessionEvent({ id: 'sess-1' }, {
		type: 'user/message',
		data: { message: { id: 'm1', source: { kind: 'fish-soul/douyin', channelId: 'douyin:某人', convId: CONV, inboxIds: [42] } } }
	});
	assert.equal(st.convId, CONV, 'convId 要被吸收（重放路径）');
	assert.deepEqual(st.inboxIds, [42], 'inboxIds 要被吸收（重放路径）');
});

// ── 接线：回复发出去后，收件箱要通过适配器结算 ───────────────
test('网关：回复发出去 → 收件箱经适配器结算（ids 就是这一轮吸收的那些）', async () => {
	const db = openDatabase();
	const settled = [];
	const sent = [];
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ masterQqUin: '12345678', douyin: { enabled: true, masterUid: 'douyin:1234567890123456789' } }),
		log: () => {}, channel: { connected: true },
		douyin: {
			connected: true,
			send: async (name, parts, convId) => { sent.push({ name, parts, convId }); return { ok: true, delivered: true, parts }; },
			inbox: { settle: (ids, ok, why) => settled.push({ ids, ok, why }) }
		},
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	gw.bound.set('sess-1', {
		session_id: 'sess-1', channel_id: 'douyin:某人', title: '抖音·某人', workspace_path: ''
	});
	const st = gw.turnState('sess-1');
	gw.onSessionEvent({ id: 'sess-1' }, {
		type: 'user/message',
		data: { message: { id: 'm1', source: { kind: 'fish-soul/douyin', channelId: 'douyin:某人', convId: CONV, inboxIds: [42, 43] } } }
	});
	// 模型回了话
	gw.onSessionEvent({ id: 'sess-1' }, {
		type: 'assistant/message',
		data: { message: { content: [{ type: 'text', text: '在的' }] } }
	});
	// 这一轮结束 → 触发发送 → 结算
	gw.onSessionEvent({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	// sendReply 是异步的：轮询等结算发生（不用固定 sleep —— 固定间隔会变成时序 flake）
	for (let i = 0; i < 100 && settled.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(sent.length, 1, '回复要发到抖音');
	assert.equal(sent[0].convId, CONV, '带原会话 ID 发（昵称不算证据）');
	assert.equal(settled.length, 1, '收件箱要被结算');
	assert.deepEqual(settled[0].ids, [42, 43], '结算的是这一轮吸收到的 inboxIds');
	assert.equal(settled[0].ok, true, '发成功了就是 ok');
});
