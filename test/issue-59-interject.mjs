// #59 ① 主人在聊的插嘴闸门：主人刚跟她说过话，她在群里就少插话（默认开、分钟可配、能整个关掉）。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-issue59-ij-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway, interjectConfig } = await import('../lib/gateway.js');

const db = openDatabase();

// ── 配置：默认开、5 分钟 ──
{
	assert.equal(interjectConfig(undefined).masterQuiet, true, '默认开着这条闸门');
	assert.equal(interjectConfig(undefined).masterQuietMinutes, 5, '默认 5 分钟');
	assert.equal(interjectConfig({ masterQuiet: false }).masterQuiet, false, '能整个关掉');
	assert.equal(interjectConfig({ masterQuietMinutes: 99 }).masterQuietMinutes, 99, '分钟可配');
	assert.equal(interjectConfig({ masterQuietMinutes: -3 }).masterQuietMinutes, 0, '负数夹到 0（= 不压制）');
}

const qq = { enabled: true, allGroups: true, batchMs: 60, followUpCount: 3, followUpSeconds: 120, interject: { enabled: true, chance: 1, cooldownMinutes: 0, maxPerHour: 30 } };
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
gw.enqueue = () => {}; // 只测判定，不真转会话

const msg = (over = {}) => ({
	channel: 'qq', chatType: 'private', channelId: 'private:10001', targetId: '10001', groupId: null,
	userId: '10001', nickname: '主人', subType: 'friend', messageId: 'm1', mentioned: false, replyId: null,
	text: '在吗', images: [], links: [], records: [], files: [], forwards: [], timeMs: Date.now(), ...over
});
const chance = () => gw.interjectChance({ channelId: 'group:991', text: '有人一起打游戏吗', userId: '30003' }, null, gw.qqConfig());

// 1. 没人找她：正常插话概率
assert.equal(chance(), 1, '没有主人在聊时按原来的概率');

// 2. 主人在私聊里跟她说话 → 群里插话压到五分之一
await gw.decide(msg(), null, gw.qqConfig());
assert.equal(gw.masterActiveAt > 0, true, '记下了主人最近一次说话的时间');
assert.equal(chance(), 0.2, '主人在私聊 → 群里插话 ×0.2');

// 3. 主人在别的群说话也一样压（这条闸门不分群：她只有一个人）
await gw.decide(msg({ chatType: 'group', channelId: 'group:777', groupId: '777', mentioned: true }), null, gw.qqConfig());
assert.equal(chance(), 0.2, '主人在别的群 → 群里插话照样压');

// 4. 超过 5 分钟就不压了
gw.masterActiveAt = Date.now() - 6 * 60_000;
assert.equal(chance(), 1, '超过 5 分钟恢复原样');

// 5. 旧消息 / 补拉的历史不算"主人在聊"
gw.masterActiveAt = 0;
const old = Date.now() - 30 * 60_000;
await gw.decide(msg({ timeMs: old }), null, gw.qqConfig());
assert.equal(gw.masterActiveAt, old, '记的是消息自己的时间');
assert.equal(chance(), 1, '半小时前的旧消息不算在聊');

// 6. 关掉这条闸门 → 什么都不压
qq.interject.masterQuiet = false;
await gw.decide(msg(), null, gw.qqConfig());
assert.equal(chance(), 1, '关掉后主人在聊也照插');
qq.interject.masterQuiet = true;

// 7. 没设主人 QQ 号 → 什么都不压（不该把所有人当主人）
gw.masterActiveAt = 0;
const qq2 = { ...qq, masterQqUin: '' };
const gw2 = new ChatGateway({
	ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
	getConfig: () => ({ qq: qq2, masterQqUin: '' }), log: () => {},
	channel: { connected: true, selfId: '1000', send: async () => '1', isFriend: () => true },
	soul: { beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [] }
});
gw2.enqueue = () => {};
assert.equal(gw2.interjectChance({ channelId: 'group:991', text: '有人一起打游戏吗', userId: '30003' }, null, gw2.qqConfig()), 1, '没设主人就不压');

db.close();
console.log('✓ #59 ① 主人在聊的插嘴闸门：默认开、5 分钟、私聊 / 别的群都压、过期恢复、能关掉');
