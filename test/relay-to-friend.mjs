// 熟人传话：relayToFriend 的三道闸（开关 / 白名单 / 频次上限）+ 消息来源前缀。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-relay-friend-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();

const calls = [];
const notes = [];

const cfg = {
	qq: { enabled: true }, masterQqUin: '10001',
	bili: { enabled: true, masterUid: '555', autoReply: true },
	douyin: { enabled: true, masterName: '未云', autoReply: true },
	relay: { enabled: true, allowList: ['qq:10001', 'qq:10002', 'bili:555', 'douyin:770'], perDay: 10 }
};

const bili = { connected: true, send: async (mid, text) => { calls.push(['bili', mid, text]); } };
const douyin = {
	connected: true,
	send: async (name, parts, convId) => {
		calls.push(['douyin', name, parts, convId]);
		return { ok: true, delivered: true, parts: [] };
	}
};

const gw = new ChatGateway({
	ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
	getConfig: () => cfg, log: () => {},
	channel: { connected: true, selfId: '1000', send: async (cid, segs) => { calls.push(['qq', cid, segs]); return '1'; }, isFriend: () => true },
	bili, douyin,
	soul: {
		beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {},
		availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [],
		journalOut: () => {}
	},
	note: (kind, info) => { notes.push([kind, info]); }
});

const ok = (msg) => { console.log('  ✓ ' + msg); };

// 1. 功能没开时拒绝
{
	cfg.relay.enabled = false;
	const r = await gw.relayToFriend('qq:10001', 'bili:555', '在吗');
	assert.equal(r.ok, false);
	assert.match(r.reason, /没开/);
	ok('功能没开时拒绝');
}

// 2. 发起人不在白名单
{
	cfg.relay.enabled = true;
	const r = await gw.relayToFriend('qq:99999', 'bili:555', '在吗');
	assert.equal(r.ok, false);
	assert.match(r.reason, /白名单/);
	ok('发起人不在白名单时拒绝');
}

// 3. 收件人不在白名单
{
	const r = await gw.relayToFriend('qq:10001', 'bili:99999', '在吗');
	assert.equal(r.ok, false);
	assert.match(r.reason, /白名单/);
	ok('收件人不在白名单时拒绝');
}

// 4. 两边都在白名单：B站 能发出去，且带来源前缀
{
	const r = await gw.relayToFriend('qq:10001', 'bili:555', '晚上一起吃饭');
	assert.equal(r.ok, true);
	assert.equal(r.delivered, true);
	assert.equal(calls.at(-1)[0], 'bili');
	assert.equal(calls.at(-1)[1], '555');
	assert.ok(calls.at(-1)[2].includes('托我带句话'), '发出的消息要带来源前缀');
	assert.ok(calls.at(-1)[2].includes('晚上一起吃饭'), '内容要带原话');
	ok('B站 传话成功且带来源前缀');
}

// 5. QQ 收件人也能发
{
	const r = await gw.relayToFriend('qq:10001', 'qq:10002', '帮忙带个快递');
	assert.equal(r.ok, true);
	assert.equal(r.delivered, true);
	assert.equal(calls.at(-1)[0], 'qq');
	assert.equal(calls.at(-1)[1], 'private:10002');
	assert.ok(calls.at(-1)[2][0].data.text.includes('托我带句话'), 'QQ 那条也要带来源前缀');
	ok('QQ 传话成功且带来源前缀');
}

// 6. 抖音没确认过会话 ID 时拒绝（不按昵称猜）
//    判据打「外层那道闸」专属的文案 —— 里面 sendDouyin 还有第二道同类闸，
//    两道 reason 都含「确认过」，只匹配 /确认过/ 的话撤掉外层这测试仍然绿（验不出来）。
{
	const before = calls.length;
	const r = await gw.relayToFriend('qq:10001', 'douyin:770', '在吗');
	assert.equal(r.ok, false);
	assert.match(r.reason, /还没跟她确认过抖音会话/, '要挡在外层（没进到发送逻辑）');
	assert.equal(calls.length, before, '不该真的发出去');
	ok('抖音会话没确认时拒绝');
}

// 7. 抖音确认过会话 ID 后能发
{
	const { setKv } = await import('../lib/db.js');
	setKv(db, 'douyin.convId.douyin:770', '0:1:111:770');
	const r = await gw.relayToFriend('qq:10001', 'douyin:770', '在吗');
	assert.equal(r.ok, true);
	assert.equal(calls.at(-1)[0], 'douyin');
	assert.equal(calls.at(-1)[3], '0:1:111:770', '要带确认过的会话 ID');
	ok('抖音确认过会话后能发');
}

// 8. 自己带给自己（from == to）
{
	const r = await gw.relayToFriend('qq:10001', 'qq:10001', '测试');
	assert.equal(r.ok, false);
	assert.match(r.reason, /不用传话/);
	ok('自己带给自己拒绝');
}

// 9. 内容是空的
{
	const r = await gw.relayToFriend('qq:10001', 'bili:555', '');
	assert.equal(r.ok, false);
	assert.match(r.reason, /空的/);
	ok('空内容拒绝');
}

// 10. 频次上限：perDay 改成 1，发 1 条后第 2 条拒
{
	cfg.relay.perDay = 1;
	const before = calls.length;
	const r1 = await gw.relayToFriend('qq:10002', 'bili:555', '第一条');
	assert.equal(r1.ok, true, '额度内应该发出去');
	const r2 = await gw.relayToFriend('qq:10002', 'bili:555', '第二条');
	assert.equal(r2.ok, false, '超额度要拒');
	assert.match(r2.reason, /上限/);
	assert.equal(calls.length, before + 1, '超额度的那条不能真发出去');
	ok('频次上限到了拒绝且没真的发出去');
}

// 11. 频次按人算：另一个人还有自己的额度（qq:10003 前面没用过）
{
	cfg.relay.perDay = 1;
	cfg.relay.allowList = ['qq:10001', 'qq:10002', 'qq:10003', 'bili:555', 'douyin:770'];
	const r = await gw.relayToFriend('qq:10003', 'bili:555', '别人第一条');
	assert.equal(r.ok, true, '额度是按人算的，别人的额度不该被这条吃掉');
	ok('频次按发起人分别计');
}

// 12. 传话进了动态日志
{
	const relayNotes = gw.decisions.filter((d) => d.kind === 'relay');
	assert.ok(relayNotes.length >= 5, `应该至少有 5 条 relay 动态，实际 ${relayNotes.length}`);
	const one = relayNotes.at(-1);
	assert.ok(one.reason.includes('让带给'), '动态里要写清谁让带给谁');
	ok('传话进了动态日志');
}

console.log('relay-to-friend: all assertions passed');
