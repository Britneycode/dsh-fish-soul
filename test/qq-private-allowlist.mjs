// 私聊白名单（qq.privateAllowList / qq.allFriends）。
//
// 为什么需要：群的准入靠 groupAllowList 管，私聊这一支原来只判「是不是好友」，
// 好友申请一通过就等于放进来一个能一直触发她的人，没有按人收口的地方。
// 语义跟群对齐：名单空 = 谁都不放行（主人永远放行），要放开所有好友得显式开 allFriends。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-private-allow-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();
const ok = (m) => console.log('✓', m);

const mkGateway = (over = {}) => {
	const qq = { enabled: true, allGroups: true, batchMs: 60, followUpCount: 0, followUpSeconds: 0, interject: { enabled: false }, ...over };
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
	return { gw, enq };
};

const privateMsg = (over = {}) => ({
	channel: 'qq', chatType: 'private', channelId: 'private:30003', targetId: '30003',
	userId: '30003', nickname: '路人', subType: 'friend', messageId: 'p1', mentioned: false, replyId: null,
	text: '在吗', images: [], links: [], records: [], files: [], forwards: [], timeMs: Date.now(), ...over
});

// ── 1. 名单空 + 没开 allFriends：好友也不回（默认拒绝），只记 ──
{
	const { gw, enq } = mkGateway();
	await gw.decide(privateMsg({ messageId: 'a' }), null, gw.qqConfig());
	assert.equal(enq.length, 0, '名单空：不该回');
	ok('名单空 = 谁都不放行（好友也挡）');
}

// ── 2. 名单里有他：回 ──
{
	const { gw, enq } = mkGateway({ privateAllowList: ['30003'] });
	await gw.decide(privateMsg({ messageId: 'b' }), null, gw.qqConfig());
	assert.equal(enq.length, 1, '在名单里：要回');
	ok('在名单里 = 回');
}

// ── 3. 名单里没有他：不回 ──
{
	const { gw, enq } = mkGateway({ privateAllowList: ['40004'] });
	await gw.decide(privateMsg({ messageId: 'c' }), null, gw.qqConfig());
	assert.equal(enq.length, 0, '不在名单里：不回');
	ok('不在名单里 = 只记不回');
}

// ── 4. 主人永远放行（名单空、allFriends 关也一样）──
{
	const { gw, enq } = mkGateway();
	await gw.decide(privateMsg({ messageId: 'd', userId: '10001', channelId: 'private:10001', targetId: '10001', nickname: '主人' }), null, gw.qqConfig());
	assert.equal(enq.length, 1, '主人不受名单限制');
	ok('主人永远放行');
}

// ── 5. allFriends = true：所有好友都回（等价旧的默认行为）──
{
	const { gw, enq } = mkGateway({ allFriends: true });
	await gw.decide(privateMsg({ messageId: 'e' }), null, gw.qqConfig());
	assert.equal(enq.length, 1, 'allFriends：好友都要回');
	ok('allFriends = true 恢复老行为');
}

// ── 6. 不是好友：仍然只记（白名单再松也不越过好友判断）──
{
	const { gw, enq } = mkGateway({ allFriends: true });
	const gwNoFriend = gw;
	gwNoFriend.channel.isFriend = () => false;
	await gwNoFriend.decide(privateMsg({ messageId: 'f', subType: 'group', userId: '55555', channelId: 'private:55555', targetId: '55555' }), null, gw.qqConfig());
	assert.equal(enq.length, 0, '不是好友：不回');
	ok('非好友仍然只记不回');
}

console.log('\nQQ 私聊白名单：全部通过');
