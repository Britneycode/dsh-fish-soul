/**
 * 「群里只回点名」开关：保存后要能从 /channels/state 读回来。
 *
 * 为什么要有这个测试：
 *   这个开关曾经在面板上「打开 → 过一会儿自己弹回关闭」：
 *   保存确实成功了（配置文件里 mentionOnly: true），但 /channels/state
 *   的 qq 块漏了透传这个字段，面板 refresh 后 useForm 重建读不到它，
 *   回退成 false —— 功能其实生效，只是 UI 显示骗人。
 *   和 test/reply-window.mjs 同一族：「写进去读不回来」的 bug 都要靠
 *   回显断言守着，不然谁顺手删掉一行透传测试照样绿。
 */
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const ok = (msg) => console.log('✓', msg);
process.env.DSH_HOME = tmpHome('dsh-mention-only-echo-');

const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');

const db = openDatabase();

let cfg = { qq: { enabled: true }, bili: {}, douyin: {}, masterQqUin: '10001' };

function mount() {
	let handler = null;
	registerRoutes({
		effect: (fn) => { fn(); },
		webServer: { register: (o) => { handler = o.handler; } }
	}, deps);
	return handler;
}

const deps = {
	db,
	clock: { getRoleDateParts: () => ({ dateStr: '2030-01-01' }) },
	embedder: {},
	worker: {},
	life: { browseState: () => ({ count: 0 }), stateSnapshot: () => ({ today: {} }) },
	getConfig: () => cfg,
	saveConfig: (patch) => { cfg = { ...cfg, ...patch }; },
	log: () => {},
	gateway: { workspacePath: () => '/ws', listWorkspaces: () => [], isPaused: () => false },
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

async function call(path, method = 'GET', body = null) {
	const handler = mount();
	let out = '';
	const req = new (await import('node:stream')).Readable({
		read() { this.push(body === null ? null : JSON.stringify(body)); if (body !== null) this.push(null); }
	});
	req.url = `/api/plugins/fish-soul${path}`;
	req.method = method;
	req.headers = {};
	const res = { writeHead: () => {}, end: (text) => { out = text; } };
	await handler(req, res);
	return JSON.parse(out);
}

// 打开 → 保存成功 → state 读回来 true（开关不再自己弹回去）
cfg = { qq: { enabled: true }, bili: {}, douyin: {}, masterQqUin: '10001' };
let res = await call('/channels/qq-config', 'POST', { mentionOnly: true });
assert.equal(res.ok, true, '保存要成功');
assert.equal(cfg.qq.mentionOnly, true, '保存的值要真的落进配置');
assert.equal((await call('/channels/state')).qq.mentionOnly, true, '打开后 /channels/state 要读回来 true（读不回来 = 开关自己弹回去）');

// 关掉 → 回 false
res = await call('/channels/qq-config', 'POST', { mentionOnly: false });
assert.equal(res.ok, true);
assert.equal((await call('/channels/state')).qq.mentionOnly, false, '关掉后要读回来 false');

// 请求里没带这个字段（改别的设置）→ 已存的值不能被冲掉
await call('/channels/qq-config', 'POST', { mentionOnly: true });
await call('/channels/qq-config', 'POST', { batchMs: 3000 });
assert.equal(cfg.qq.mentionOnly, true, '请求没带这个字段时不能冲掉已存的 true');
assert.equal((await call('/channels/state')).qq.mentionOnly, true, '冲不掉：state 仍读回来 true');

ok('「群里只回点名」开关：保存 → 回显 → 不带字段不冲掉，全对得上');
