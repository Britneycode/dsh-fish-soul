// 跨平台转达：主人在 QQ 私聊里让她去抖音 / B站 私信自己一条（relayTo / afterRelay）。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-relay-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();

const calls = [];      // 真的发出去的消息
const journaled = [];  // 记进聊天日志的
const logs = [];       // 日志（发失败时的原因在这里）

let dyResult = { ok: true, delivered: true, parts: [] };
let dyThrows = null;

const cfg = {
	qq: { enabled: true }, masterQqUin: '10001',
	bili: { enabled: true, masterUid: '555', autoReply: true },
	douyin: { enabled: true, masterName: '未云', autoReply: true }
};

const bili = {
	connected: true,
	send: async (mid, text) => { calls.push(['bili', mid, text]); },
	sendImage: async () => {}
};
const douyin = {
	connected: true,
	send: async (name, parts) => {
		if (dyThrows !== null) throw dyThrows;
		calls.push(['douyin', name, parts]);
		return dyResult;
	}
};

const gw = new ChatGateway({
	ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
	getConfig: () => cfg, log: (level, msg) => { logs.push([level, msg]); },
	channel: { connected: true, selfId: '1000', send: async () => '1', isFriend: () => true },
	bili, douyin,
	soul: {
		beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {},
		availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [],
		journalOut: (channelId, text) => { journaled.push([channelId, text]); }
	}
});

const ok = (msg) => { console.log('  ✓ ' + msg); };

// 1. 抖音目标不能核验时，转达必须拒绝，不能调用底层发送。
{
 const r = await gw.relayTo('douyin','晚安呀');
 assert.equal(r.ok,false); assert.equal(r.delivered,false); assert.match(r.reason,/身份/);
 assert.equal(calls.length,0); ok('抖音目标未验证时停止转达');
}

// 2. B站能发出去
{
	const r = await gw.relayTo('bili', '来了');
	assert.equal(r.ok, true, 'B站转达：ok 应为 true');
	assert.equal(r.delivered, true, 'B站转达：delivered 应为 true');
	assert.deepEqual(calls.at(-1), ['bili', '555', '来了'], 'B站 send 应收到（uid, 正文）');
	ok('B站私信发得出去');
}

// 3. 出站进了聊天日志
{
	assert.ok(!journaled.some(([c]) => c.startsWith('douyin:')), '未发送不写成功日志');
	assert.ok(journaled.some(([c, t]) => c === 'bili:555' && t === '来了'), 'B站那条应进聊天日志');
	ok('发出去的消息都记进了聊天日志');
}

// 5. B站没填 UID
{
	cfg.bili.masterUid = '';
	const r = await gw.relayTo('bili', '在吗');
	assert.equal(r.ok, false, '没填 UID 不该发出去');
	assert.match(r.reason, /UID/, '理由里要点明是 UID 没填');
	cfg.bili.masterUid = '555';
	ok('B站没填主人的 UID 时不发');
}

// 6. B站没连上
{
	bili.connected = false;
	const r = await gw.relayTo('bili', '在吗');
	assert.equal(r.ok, false, '没连上不该发出去');
	assert.match(r.reason, /没连上/, '理由里要点明是没连上');
	bili.connected = true;
	ok('B站没连上时不发');
}

// 7. 平台写错
{
	const r = await gw.relayTo('qq', '在吗');
	assert.equal(r.ok, false, '只支持 douyin / bili');
	assert.match(r.reason, /只支持/, '理由里要点明只支持哪两个平台');
	ok('平台写错时直接拒绝');
}

// 9. 主人闸门
{
	assert.equal(gw.isMasterChannel('private:10001'), true, '主人 QQ 私聊算主人');
	assert.equal(gw.isMasterChannel('group:991'), false, '群聊不算主人');
	assert.equal(gw.isMasterChannel('douyin:未云'), false, '昵称不能授予主人权限');
	ok('只有主人的私聊算主人');
}

// 10. 空内容不发
{
	const before = calls.length;
	const r = await gw.relayTo('douyin', '   ');
	assert.equal(r.ok, false, '空内容不该发出去');
	assert.equal(calls.length, before, '空内容时不该调 send');
	ok('空内容不发');
}

db.close();
console.log('✓ 抖音转达安全暂停，B站转达及错误边界正常');
