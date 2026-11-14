// 群里只回点名（qq.mentionOnly）：关掉「接着听」和「自己想插一句」，
// 只在她被 @ / 叫名字时开口。默认关 ⇒ 老行为不变。
//
// 为什么需要：几个机器人待在同一个群，一个点名、另一个接听 → 互相触发，
// 每轮都算「被点名」⇒ 无限来回刷屏。现有的闸门（白名单 / 插话概率 / 每小时上限）
// 全是按群和按时间的，没有一条能识别「对面也是机器人」。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-mention-only-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();
const ok = (m) => console.log('✓', m);

// ── 配置读取层：没配 / 配了都要读对 ──
{
	const mk = (qq) => new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ qq }), log: () => {},
		channel: { connected: true, selfId: '1000', isFriend: () => true },
		soul: { beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [] }
	});
	assert.equal(mk({}).qqConfig().mentionOnly, false, '没配 = 关（老行为不变）');
	assert.equal(mk({ mentionOnly: true }).qqConfig().mentionOnly, true, '配了 = 开');
	assert.equal(mk({ mentionOnly: 'yes' }).qqConfig().mentionOnly, false, '只认布尔 true，字符串不算');
	ok('配置：mentionOnly 默认关，只认 true');
}

const mkGateway = (over = {}) => {
	const qq = { enabled: true, allGroups: true, batchMs: 60, followUpCount: 3, followUpSeconds: 120, interject: { enabled: true, chance: 1, cooldownMinutes: 0, maxPerHour: 30 }, ...over };
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ qq, masterQqUin: '10001' }), log: () => {},
		channel: { connected: true, selfId: '1000', send: async () => '1', groupName: async () => '群', getMessage: async () => null, isFriend: () => true },
		soul: {
			beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {},
			availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => []
		}
	});
	gw.random = () => 0.5;
	const enq = [];
	gw.enqueue = (m, p, cfg, x) => { enq.push({ m, x }); };
	return { gw, enq, qq };
};

const groupMsg = (over = {}) => ({
	channel: 'qq', chatType: 'group', channelId: 'group:991', targetId: '991', groupId: '991',
	userId: '30003', nickname: '路人', subType: '', messageId: 'g1', mentioned: false, replyId: null,
	text: '今天好热', images: [], links: [], records: [], files: [], forwards: [], timeMs: Date.now(), ...over
});

// ── 1. 默认关：点名后接着听，没点名也可能插话（老行为，不能被打挂）──
{
	const { gw, enq } = mkGateway();
	await gw.decide(groupMsg({ mentioned: true, messageId: 'a' }), null, gw.qqConfig());
	assert.equal(gw.follow.has('group:991'), true, '默认关：点名后进入接听');
	// 接听中，没点名也收
	await gw.decide(groupMsg({ messageId: 'b' }), null, gw.qqConfig());
	assert.equal(enq.length, 2, '默认关：接听中没点名也回');
	assert.equal(gw.follow.get('group:991')?.剩, 2, '接听条数递减');
	ok('默认关：点名后接着听，接听中没点名也回（老行为不变）');
}

// ── 2. 打开后：点名照回，但不进入接听 ──
{
	const { gw, enq } = mkGateway({ mentionOnly: true });
	await gw.decide(groupMsg({ mentioned: true, messageId: 'a' }), null, gw.qqConfig());
	assert.equal(enq.length, 1, '打开后：点名照回');
	assert.equal(gw.follow.has('group:991'), false, '打开后：不进入接听');
	ok('打开后：点名照回，但不进入接听');
}

// ── 3. 打开后：没点名 + 没接听 → 不回，也不插话（这就是堵住机器人互相刷屏的那一下）──
{
	const { gw, enq } = mkGateway({ mentionOnly: true });
	// interject.chance = 1（必插话），random 也固定 0.5 —— 默认一定会插话
	for (let i = 0; i < 5; i++) await gw.decide(groupMsg({ messageId: `n${i}`, text: `随便说点什么 ${i}` }), null, gw.qqConfig());
	assert.equal(enq.length, 0, '打开后：没点名就一句都不回（插话被关掉）');
	ok('打开后：没点名不接听也不插话（连续 5 条都不回）');
}

// ── 4. 打开后：叫名字算点名，照回 ──
{
	const { gw, enq } = mkGateway({ mentionOnly: true, callNames: ['小鱼'] });
	await gw.decide(groupMsg({ text: '小鱼你在吗', messageId: 'c' }), null, gw.qqConfig());
	assert.equal(enq.length, 1, '打开后：叫名字照回');
	ok('打开后：叫名字（callNames）仍算点名');
}

// ── 5. 关回去 → 接听和插话都恢复（开关是双向的，不是单向熔断）──
{
	const { gw, enq, qq } = mkGateway({ mentionOnly: true });
	await gw.decide(groupMsg({ messageId: 'd' }), null, gw.qqConfig());
	assert.equal(enq.length, 0, '开着：不回');
	qq.mentionOnly = false;
	await gw.decide(groupMsg({ messageId: 'e' }), null, gw.qqConfig());
	assert.equal(enq.length, 1, '关回去：插话恢复');
	ok('关回去：接听 / 插话都恢复');
}

// ── 6. 群里只回点名不影响私聊 ──
{
	const { gw, enq } = mkGateway({ mentionOnly: true });
	await gw.decide({
		channel: 'qq', chatType: 'private', channelId: 'private:10001', targetId: '10001', groupId: null,
		userId: '10001', nickname: '主人', subType: 'friend', messageId: 'p1', mentioned: false, replyId: null,
		text: '在吗', images: [], links: [], records: [], files: [], forwards: [], timeMs: Date.now()
	}, null, gw.qqConfig());
	assert.equal(enq.length, 1, '私聊照常回（这个开关只管群）');
	ok('群里只回点名不影响私聊');
}

console.log('\ngroup-mention-only ok');
