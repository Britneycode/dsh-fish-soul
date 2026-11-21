/**
 * POST /sessions/reset 路由契约测试：
 *   ① 跨站 POST 必须被 sameOrigin 拦截（403）
 *   ② 非法 channelId 拒绝（ok: false）
 *   ③ 合法 channelId 退役旧会话并在同一工作区下新建活会话
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { tmpHome } from './_tmp.mjs';

const ok = (msg) => console.log('✓', msg);
const home = tmpHome('dsh-session-reset-route-');
process.env.DSH_HOME = home;

const { openDatabase, findChatSession } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { registerRoutes } = await import('../lib/routes.js');

const db = openDatabase();
const created = [];
const agents = {
	async create(opts) {
		created.push(opts);
		return { agent: { id: opts.sessionId, session: { id: opts.sessionId }, options: { model: 'm0' }, followup: async () => {} }, dispose: async () => {} };
	},
	async resume(opts) {
		return { agent: { id: opts.resumeSessionId, session: { id: opts.resumeSessionId }, options: { model: 'm0' }, followup: async () => {} }, dispose: async () => {} };
	},
	get: () => undefined
};

const gw = new ChatGateway({
	ctx: { get: (name) => (name === 'agents' ? agents : undefined), tools: { restrict: () => () => {} } },
	db,
	clock: { now: () => Date.now() },
	getConfig: () => ({ qq: { enabled: true }, masterQqUin: '10001' }),
	log: () => {},
	channel: { connected: true, selfId: '1000', send: async () => '1', isFriend: () => true },
	bili: null,
	douyin: null,
	soul: { beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [], journalOut: () => {} },
	note: () => {}
});

const deps = {
	db,
	clock: { getRoleDateParts: () => ({ dateStr: '2030-01-01' }) },
	embedder: {},
	worker: {},
	life: { browseState: () => ({ count: 0 }), stateSnapshot: () => ({ today: {} }) },
	getConfig: () => ({ qq: { enabled: true }, bili: {}, douyin: {}, masterQqUin: '10001' }),
	saveConfig: () => {},
	log: () => {},
	gateway: gw,
	channel: { status: () => ({ connected: true }), restart() {} },
	bili: { status: () => ({ loggedIn: false }), restart() {} },
	biliClient: null,
	browser: null,
	biliSocial: null,
	douyin: { status: () => ({ running: false }) },
	douyinHost: { browsers: [], status: () => ({ state: 'stopped' }) },
	douyinBrowser: null,
	douyinSocial: null
};

let handler = null;
registerRoutes({
	effect: (fn) => { fn(); },
	webServer: { register: (o) => { handler = o.handler; } }
}, deps);

async function call(path, method = 'POST', body = {}, headers = {}) {
	let status = 0;
	let out = '';
	const req = new Readable({
		read() { this.push(JSON.stringify(body)); this.push(null); }
	});
	req.url = `/api/plugins/fish-soul${path}`;
	req.method = method;
	req.headers = headers;
	const res = {
		writeHead: (code) => { status = code; },
		end: (text) => { out = text; }
	};
	await handler(req, res);
	return { status, json: JSON.parse(out) };
}

// 1. 跨站 POST 必须被 sameOrigin 挡下
const blocked = await call('/sessions/reset', 'POST', { channelId: 'private:30001' }, { 'sec-fetch-site': 'cross-site' });
assert.equal(blocked.status, 403, '跨站请求必须回 403');
assert.equal(blocked.json.ok, false);
ok('跨站 POST 返回 403');

// 2. 非法 channelId 拒绝
const badId = await call('/sessions/reset', 'POST', { channelId: 'invalid-channel' }, { 'sec-fetch-site': 'same-origin' });
assert.equal(badId.status, 200);
assert.equal(badId.json.ok, false, '非法 channelId 要返回 ok:false');
ok('非法 channelId 拒绝');

// 3. 合法 channelId 退役旧会话并沿用原工作区新建会话
const customWs = join(home, 'ws-reset-custom');
await gw.createSession({ channelId: 'private:30001', chatType: 'private', targetId: '30001', title: '测试人' }, customWs);
const beforeRow = findChatSession(db, 'qq', 'private:30001');
assert.ok(beforeRow, '重置前应存在活会话');

const okRes = await call('/sessions/reset', 'POST', { channelId: 'private:30001' }, { 'sec-fetch-site': 'same-origin' });
assert.equal(okRes.status, 200);
assert.equal(okRes.json.ok, true, `重置失败：${JSON.stringify(okRes.json)}`);
assert.equal(okRes.json.prevSessionId, beforeRow.session_id);
assert.notEqual(okRes.json.sessionId, beforeRow.session_id, '应该生成新的 sessionId');

const oldDbRow = db.prepare('SELECT status FROM chat_session WHERE session_id = ?').get(beforeRow.session_id);
assert.equal(oldDbRow?.status, 'retired', '旧会话应标成 retired');
const newDbRow = findChatSession(db, 'qq', 'private:30001');
assert.equal(newDbRow?.session_id, okRes.json.sessionId, '新会话应成为 active');
assert.equal(newDbRow?.workspace_path, customWs, '重置后的新会话应沿用原工作区');
ok('合法 channelId 退役旧会话并新建同工作区会话');

console.log('session-reset-route ok');
