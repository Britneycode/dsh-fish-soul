// #78 第 1 步：回复发到「这一轮从哪个通道进来的」，不再只认会话绑定的那个通道。
//
// 为什么要有这个测试：共享会话之后一个会话会对应多个通道（QQ 私聊 + B站 私信）。
// 如果 sendReply 还读 row.channel_id，从 B站 进来的话会回到 QQ 去 —— 而 QQ 那边没人问，
// 表现是「她答了但没人收到」。这是回复路由，错了最贵。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('reply-target-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { sourceLabel } = await import('../lib/routes-soul.js');

const db = openDatabase();
const ok = (n) => console.log('✓', n);

const sent = [];
const cfg = { qq: { enabled: true }, masterQqUin: '875692618', bili: { enabled: true, masterUid: '172195454' } };

function gateway(over = {}) {
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ ...cfg, ...over }), log: () => {},
		channel: { connected: true, selfId: '1000', send: async (channelId, segs) => { sent.push([channelId, segs]); return 'mid-1'; }, isFriend: () => true },
		bili: { connected: true, send: async (mid, text) => { sent.push([`bili:${mid}`, text]); }, sendImage: async () => {} },
		soul: { beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [], journalOut: () => {} }
	});
	gw.sleep = async () => {}; // 别真等打字延迟
	return gw;
}

const turn = (channelId) => ({ text: '好呀', images: [], fromUs: true, messageIds: [], replyTo: null, channelId });

// 一个会话，绑定的是 QQ 私聊（老库里的形态）
const bind = (gw) => {
	gw.bound.set('sess-1', { channel_id: 'private:875692618', session_id: 'sess-1', workspace_path: process.env.DSH_HOME, title: 'QQ·主人', paused: 0 });
	return gw;
};

{
	// 1. 这一轮是从 QQ 进来的：还是发 QQ（行为不变）
	sent.length = 0;
	const gw = bind(gateway());
	await gw.sendReply('sess-1', turn('private:875692618'));
	assert.equal(sent.length, 1);
	assert.equal(sent[0][0], 'private:875692618');
	ok('QQ 进来的话回 QQ（老行为没变）');
}

{
	// 2. 同一个会话，这一轮是从 B站 私信进来的：回 B站，别回 QQ
	sent.length = 0;
	const gw = bind(gateway());
	await gw.sendReply('sess-1', turn('bili:172195454'));
	assert.equal(sent.length, 1);
	assert.equal(sent[0][0], 'bili:172195454', '回复必须发回 B站，不能落到绑定的 QQ 通道');
	ok('会话绑着 QQ，但这一轮从 B站 进来 → 回 B站');
}

{
	// 3. 没登记本轮通道（重启后重建的老会话）：退回绑定通道，跟以前一模一样
	sent.length = 0;
	const gw = bind(gateway());
	await gw.sendReply('sess-1', { text: '好呀', images: [], fromUs: true, messageIds: [], replyTo: null });
	assert.equal(sent[0][0], 'private:875692618');
	ok('没登记本轮通道 → 退回会话绑定的通道（老会话行为不变）');
}

{
	// 4. 群里回复的格式判断也跟着本轮通道走（不能拿绑定的 QQ 私聊去判断是不是群）
	sent.length = 0;
	const gw = bind(gateway());
	await gw.sendReply('sess-1', turn('group:88888'));
	assert.equal(sent[0][0], 'group:88888');
	ok('本轮是群 → 按群发到那个群，不是绑定的私聊');
}

{
	// 5. 记忆出处：自己刷视频记的不能再标成「没回的消息」
	assert.equal(sourceLabel('', 'bili'), '自己刷B站时记的');
	assert.equal(sourceLabel('', 'douyin'), '自己刷抖音时记的');
	assert.equal(sourceLabel('', 'bili-private'), '没回的消息', '私信里没回的才算没回的消息');
	assert.equal(sourceLabel('', 'qq-private'), '没回的消息');
	assert.equal(sourceLabel('manual'), '主人手动加的');
	assert.equal(sourceLabel('weekly'), '周记');
	assert.equal(sourceLabel(''), '没回的消息', '没给 channel 时保持原样（不猜），老行为');
	ok('记忆出处：刷视频记的不再被标成「没回的消息」');
}

{
	// 6. 共享会话 + 插件重启后宿主重放消息：本轮通道从消息来源里补回来，否则会回错平台
	sent.length = 0;
	const gw = bind(gateway());
	gw.onSessionEvent({ id: 'sess-1' }, { type: 'user/message', data: { message: { id: 'm1', content: [{ type: 'text', text: '在吗' }], source: { kind: 'fish-soul/bili', channelId: 'bili:172195454' } } } });
	gw.onSessionEvent({ id: 'sess-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在呢' }] } } });
	gw.onSessionEvent({ id: 'sess-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 1);
	assert.equal(sent[0][0], 'bili:172195454', '消息来源带着通道就按它回，别落到会话绑定的 QQ');
	ok('重启后重放的消息：按消息来源里的通道回复，不回错平台');
}

{
	// 7. 设置页选了「一律回 QQ」：B站 进来的话也回 QQ（共享会话里 QQ 就是会话绑定的那个）
	sent.length = 0;
	const gw = bind(gateway({ sessions: { replyTarget: 'qq' } }));
	await gw.sendReply('sess-1', turn('bili:172195454'));
	assert.equal(sent[0][0], 'private:875692618', '一律回 QQ：B站 问的也回 QQ');
	assert.equal(gw.replyChannelFor({ id: 'sess-1' }, 'bili:172195454'), 'private:875692618', '提示词里的回复规则也要按 QQ 给');
	ok('一律回 QQ：回复和提示词规则都跟会话主通道走');
}

{
	// 8. 没设 / 设成乱七八糟的值：按来源回（默认不能因为配置写错就变）
	sent.length = 0;
	const gw = bind(gateway({ sessions: { replyTarget: '由她决定' } }));
	assert.equal(gw.replyTarget(), 'source', '认不出来的值退回默认');
	await gw.sendReply('sess-1', turn('bili:172195454'));
	assert.equal(sent[0][0], 'bili:172195454');
	ok('配置写错不改变行为：还是哪边问的就回哪边');
}

console.log('reply-target ok');
