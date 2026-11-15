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


// ── 7. 被白名单挡住的好友：语音不落盘（只记就返回，到不了 hearVoice）──
{
	const { gw } = mkGateway();
	const heard = [];
	gw.hearVoice = async () => { heard.push(1); };
	await gw.decide(privateMsg({ messageId: 'g', records: [{}] }), { canonical_id: 'person-x' }, gw.qqConfig());
	assert.equal(heard.length, 0, '不在名单里的好友语音不能落盘');
	ok('白名单挡住的好友不到 hearVoice');
}

// ── 8. 在名单里的好友：语音照常交给 hearVoice ──
{
	const { gw } = mkGateway({ privateAllowList: ['30003'] });
	const heard = [];
	gw.hearVoice = async () => { heard.push(1); };
	await gw.decide(privateMsg({ messageId: 'h', records: [{}] }), { canonical_id: 'person-x' }, gw.qqConfig());
	assert.equal(heard.length, 1, '在名单里要听');
	ok('在名单里的好友语音照常听');
}

// ── 9. 设置页那条保存路径：写进去、读回来、不带字段不能冲掉 ──
{
	const { registerRoutes } = await import('../lib/routes.js');
	let cfg = { qq: { enabled: true, privateAllowList: ['1491459939'], allFriends: false }, masterQqUin: '10001' };
	const deps = {
		db, clock: { getRoleDateParts: () => ({ dateStr: '2030-01-01' }) },
		embedder: {}, worker: {},
		life: { browseState: () => ({ count: 0 }), stateSnapshot: () => ({ today: {} }) },
		getConfig: () => cfg,
		saveConfig: (patch) => { cfg = { ...cfg, ...patch, qq: { ...(cfg.qq ?? {}), ...(patch.qq ?? {}) } }; },
		log: () => {},
		gateway: { workspacePath: () => '/ws', listWorkspaces: () => [], isPaused: () => false },
		channel: { status: () => ({ connected: true }), restart() {} },
		bili: { status: () => ({ loggedIn: false }), restart() {} }, biliClient: null, browser: null, biliSocial: null,
		douyin: { status: () => ({ running: false }) },
		douyinHost: { browsers: [], status: () => ({ state: 'stopped' }) },
		douyinBrowser: null, douyinSocial: null
	};
	const call = async (path, method = 'GET', body = null) => {
		let handler = null;
		registerRoutes({ effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } }, deps);
		let out = '';
		const { Readable } = await import('node:stream');
		const req = new Readable({ read() { this.push(body === null ? null : JSON.stringify(body)); if (body !== null) this.push(null); } });
		req.url = `/api/plugins/fish-soul${path}`;
		req.method = method;
		req.headers = {};
		await handler(req, { writeHead() {}, end(text) { out = text; } });
		return JSON.parse(out);
	};
	const panelSave = { enabled: true, wsUrl: 'ws://127.0.0.1:3001', masterQqUin: '10001', groupAllowList: [], allGroups: false, mentionOnly: false };
	await call('/channels/qq-config', 'POST', panelSave);
	assert.deepEqual(cfg.qq.privateAllowList, ['1491459939'], '面板保存不带名单时不能把已存的名单冲掉');
	assert.equal(cfg.qq.allFriends, false, '面板保存不带 allFriends 时不能改掉已存的开关');
	let st = await call('/channels/state');
	assert.deepEqual(st.qq.privateAllowList, ['1491459939'], '已存名单要从 /channels/state 读回来');
	assert.equal(st.qq.allFriends, false);
	const saved = await call('/channels/qq-config', 'POST', { ...panelSave, privateAllowList: ['private:30003', ' 40004 '], allFriends: true });
	assert.equal(saved.ok, true);
	assert.deepEqual(cfg.qq.privateAllowList, ['30003', '40004'], 'private: 前缀和空格要清掉');
	assert.equal(cfg.qq.allFriends, true);
	st = await call('/channels/state');
	assert.deepEqual(st.qq.privateAllowList, ['30003', '40004']);
	assert.equal(st.qq.allFriends, true, '打开所有好友后回显也得是 true');
	const bad = await call('/channels/qq-config', 'POST', { ...panelSave, privateAllowList: ['不是号'] });
	assert.equal(bad.ok, false);
	assert.deepEqual(cfg.qq.privateAllowList, ['30003', '40004'], '非法号码不能覆盖已存名单');
	ok('设置页保存 / 回显 / 不带字段不冲掉');
}

console.log('\nQQ 私聊白名单：全部通过');
