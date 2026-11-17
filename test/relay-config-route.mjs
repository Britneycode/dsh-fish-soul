/**
 * 熟人传话的配置路由：保存 → 回显 → 非法值被拒。
 *
 * 为什么要有这个测试（和 qq-mention-only-echo / reply-window 同一族）：
 *   设置页保存成功但后端漏透传字段时，面板 refresh 后读不到 → UI 显示「关」
 *   而功能其实开着，或者反过来。凡是「写进去读不回来」的都要靠回显断言守着。
 *
 * 另外白名单的格式校验必须在保存时就把关：填错了静默失效，
 * 主人会以为配好了，直到某天想用才发现一条都发不出去。
 */
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const ok = (msg) => console.log('✓', msg);
process.env.DSH_HOME = tmpHome('dsh-relay-config-');

const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');

const db = openDatabase();

let cfg = { qq: { enabled: true }, bili: {}, douyin: {}, masterQqUin: '10001' };

const deps = {
	db,
	clock: { getRoleDateParts: () => ({ dateStr: '2030-01-01' }), now: () => 1000 },
	embedder: {},
	worker: {},
	life: { browseState: () => ({ count: 0 }), stateSnapshot: () => ({ today: {}, relayConfig: cfg.relay ?? {} }) },
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

function mount() {
	let handler = null;
	registerRoutes({
		effect: (fn) => { fn(); },
		webServer: { register: (o) => { handler = o.handler; } }
	}, deps);
	return handler;
}

async function call(path, method = 'GET', body = null, headers = {}) {
	const handler = mount();
	let out = '';
	const req = new (await import('node:stream')).Readable({
		read() { this.push(body === null ? null : JSON.stringify(body)); if (body !== null) this.push(null); }
	});
	req.url = `/api/plugins/fish-soul${path}`;
	req.method = method;
	req.headers = headers;
	const res = { writeHead: () => {}, end: (text) => { out = text; } };
	await handler(req, res);
	return JSON.parse(out);
}

// 1. 默认关：没配过就不能用
{
	cfg = { qq: { enabled: true }, bili: {}, douyin: {}, masterQqUin: '10001' };
	const state = await call('/life/state');
	assert.equal(state.relayConfig?.enabled === true, false, '默认必须是关（功能默认关是红线）');
	assert.deepEqual(state.relayConfig?.allowList ?? [], [], '默认白名单是空的 = 谁都不能用');
	ok('默认关、白名单为空');
}

// 2. 打开 + 配白名单 → 保存成功 → 读得回来
{
	const res = await call('/relay/config', 'POST', { enabled: true, allowList: ['qq:10001', 'bili:555', 'douyin:770'], perDay: 3 });
	assert.equal(res.ok, true, `保存要成功，实际：${res.error}`);
	assert.equal(cfg.relay.enabled, true, '开关要真的落进配置');
	assert.equal(cfg.relay.perDay, 3, '上限要真的落进配置');
	assert.deepEqual(cfg.relay.allowList, ['qq:10001', 'bili:555', 'douyin:770'], '白名单要真的落进配置');
	const state = await call('/life/state');
	assert.equal(state.relayConfig.enabled, true, '打开后要读回来 true（读不回来 = 开关自己弹回去）');
	assert.deepEqual(state.relayConfig.allowList, ['qq:10001', 'bili:555', 'douyin:770'], '白名单要读得回来');
	ok('保存 → 回显一致');
}

// 3. 关掉 → 读回来 false
{
	const res = await call('/relay/config', 'POST', { enabled: false, allowList: ['qq:10001'], perDay: 5 });
	assert.equal(res.ok, true);
	assert.equal((await call('/life/state')).relayConfig.enabled, false, '关掉后要读回来 false');
	ok('关掉能读回来');
}

// 4. 白名单格式非法 → 拒绝保存（不能静默失效）
{
	const before = JSON.stringify(cfg.relay);
	const res = await call('/relay/config', 'POST', { enabled: true, allowList: ['未云', 'qq:abc', 'bili:'], perDay: 5 });
	assert.equal(res.ok, false, '昵称 / 非数字 uid 必须被拒');
	assert.match(res.error, /不是平台 uid/, '要说清哪里不对');
	assert.equal(JSON.stringify(cfg.relay), before, '被拒时不能改动已存的配置');
	ok('非法白名单被拒且不改配置');
}

// 5. 白名单里有一条非法 → 整批拒（不做「能用的留下」的静默部分成功）
{
	const before = JSON.stringify(cfg.relay);
	const res = await call('/relay/config', 'POST', { enabled: true, allowList: ['qq:10001', '乱写'], perDay: 5 });
	assert.equal(res.ok, false, '混了非法项要整批拒');
	assert.equal(JSON.stringify(cfg.relay), before, '整批拒时不能改动配置');
	ok('混了非法项整批拒');
}

// 6. perDay 钳制到 1..50
{
	await call('/relay/config', 'POST', { enabled: true, allowList: ['qq:10001'], perDay: 999 });
	assert.equal(cfg.relay.perDay, 50, '上限过大的要钳到 50');
	await call('/relay/config', 'POST', { enabled: true, allowList: ['qq:10001'], perDay: -3 });
	assert.equal(cfg.relay.perDay, 1, '下限要钳到 1');
	await call('/relay/config', 'POST', { enabled: true, allowList: ['qq:10001'], perDay: 7.9 });
	assert.equal(cfg.relay.perDay, 7, '小数要取整');
	ok('perDay 钳制 1..50');
}

// 7. 白名单去重（同一人写两遍不该占两个位置）
{
	const res = await call('/relay/config', 'POST', { enabled: true, allowList: ['qq:10001', 'qq:10001', 'bili:555'], perDay: 5 });
	assert.equal(res.ok, true);
	assert.deepEqual(cfg.relay.allowList, ['qq:10001', 'bili:555'], '重复的要合并');
	ok('白名单去重');
}

// 8. 不幂等：每次保存都整体替换（不是追加）
{
	await call('/relay/config', 'POST', { enabled: true, allowList: ['qq:10001', 'bili:555'], perDay: 5 });
	await call('/relay/config', 'POST', { enabled: true, allowList: ['qq:10001'], perDay: 5 });
	assert.deepEqual(cfg.relay.allowList, ['qq:10001'], '第二次保存要把 bili:555 移除（整体替换语义）');
	ok('每次保存整体替换');
}

console.log('relay-config-route: all assertions passed');
