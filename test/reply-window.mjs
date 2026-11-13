/**
 * `replyWindowMinutes`（超过多久的消息只记不回）三平台打通测试。
 *
 * 为什么要有这个测试：
 *   这个值以前**只在配置 schema 里存在**，路由既不保存也不回显，界面也就没有输入框。
 *   现在要在 QQ / B站 / 抖音 三个设置页各加一行「超过多久的消息只记不回」，
 *   那就必须把「保存 → 持久化 → 回显」整条路验通 —— 否则加出来的就是个死输入框：
 *   填了也存不下去（或存下去读不回来），界面看着像在改，实际什么都没发生。
 *   参考 test/douyin-state-echo.mjs（专门守这一类「写进去读不出来」的 bug）。
 *
 * 契约：
 *   ① 三处 schema 默认值都是 120（不是原来的 10）
 *   ② gateway 的四处兜底值都是 120（配置里没这个键时用的就是它）
 *   ③ 配置里**已经有值**时以配置为准（老配置不被这次改动冲掉）
 *   ④ 三个 config 路由都能保存它，并且保存后会落进配置
 *   ⑤ 三处回显（/channels/state 的 qq 块、biliState、douyinState）都能读回来
 *   ⑥ 范围夹在 1~1440：0 会被抬到 1（不能用 0 —— 见下面那段说明），超大值压到 1440
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';

const ok = (msg) => console.log('✓', msg);
const home = tmpHome('dsh-reply-window-');
process.env.DSH_HOME = home;

const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();

// ── ① 三处 schema 默认值 ────────────────────────────────────────────────────
//
// 直接查源码：这里的 z 是宿主注入的 schemastery（带 z.dict 扩展），npm 的 zod 造不出来，
// 为一个默认值把整套宿主依赖搬进测试不值得（和 test/chat-archive-default.mjs 同一取舍）。
{
	const schemaSrc = readFileSync(new URL('../lib/config-schema.js', import.meta.url), 'utf8');
	const platSrc = readFileSync(new URL('../lib/config-platforms.js', import.meta.url), 'utf8');
	const line = (src) => src.split('\n').filter((l) => /^\s*replyWindowMinutes: z\.number\(\)/.test(l));
	assert.equal(line(schemaSrc).length, 1, 'QQ 那边要有一行 replyWindowMinutes');
	assert.match(line(schemaSrc)[0], /default\(120\)/, 'QQ 默认 120（原来 10 太短，断线补拉的老消息全被当成旧消息）');
	assert.equal(line(platSrc).length, 2, 'B站 / 抖音 各一行');
	assert.match(line(platSrc)[0], /default\(120\)/, 'B站默认 120');
	assert.match(line(platSrc)[1], /default\(120\)/, '抖音默认 120');
	for (const src of [schemaSrc, platSrc]) {
		assert.doesNotMatch(src, /^\s*replyWindowMinutes: z\.number\(\)\.default\(10\)/m, '不能再留着旧的默认 10');
	}
	ok('schema 默认值：QQ / B站 / 抖音 三处都是 120');
}

// ── ② gateway 兜底值 ────────────────────────────────────────────────────────
//
// qqConfig / biliConfig / douyinConfig 是网关读配置的唯一入口（gateway-media 的
// 「旧消息只记不回」判断就是读它），配置里没这个键时它们给的值就是实际的兜底值。
{
	const makeGw = (cfg) => new ChatGateway({
		ctx: { get: () => undefined },
		db, clock: { now: () => Date.now() }, getConfig: () => cfg, log: () => {},
		channel: { connected: true, send: async () => 'mid' },
		soul: { beginTurn() {}, resolvePerson() { return null; }, memorizeUnanswered() {} }
	});

	const empty = makeGw({ qq: {}, bili: {}, douyin: {} });
	assert.equal(empty.qqConfig().replyWindowMinutes, 120, 'QQ：配置里没这个键时兜底 120');
	assert.equal(empty.biliConfig().replyWindowMinutes, 120, 'B站：兜底 120');
	assert.equal(empty.douyinConfig().replyWindowMinutes, 120, '抖音：兜底 120');

	// 老配置里有值 → 以配置为准，不能被新默认值冲掉
	const legacy = makeGw({ qq: { replyWindowMinutes: 45 }, bili: { replyWindowMinutes: 7 }, douyin: { replyWindowMinutes: 300 } });
	assert.equal(legacy.qqConfig().replyWindowMinutes, 45, '配置里有值就用配置的（老配置不受影响）');
	assert.equal(legacy.biliConfig().replyWindowMinutes, 7);
	assert.equal(legacy.douyinConfig().replyWindowMinutes, 300);
	ok('gateway 兜底值：没配时 120，配了就听配置的');
}

// ── ③④⑤ 三个路由：保存 + 回显 ──────────────────────────────────────────────
//
// 走真实路由（registerRoutes 挂出来的那一个），不手搓 handler：
// 这样「设置页 POST 的字段名」和「路由读的字段名」对不上时才会红。
let cfg = {
	qq: { enabled: true },
	bili: { enabled: false },
	douyin: { enabled: true },
	masterQqUin: '10001'
};

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
	// handleDouyinRoute 要求有这两个（否则直接回「抖音模块没加载」）
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

// ── QQ ──
{
	cfg = { qq: { enabled: true }, bili: {}, douyin: {} };
	const res = await call('/channels/qq-config', 'POST', { replyWindowMinutes: 300 });
	assert.equal(res.ok, true, 'QQ 保存要成功');
	assert.equal(cfg.qq.replyWindowMinutes, 300, 'QQ：保存的值要真的落进配置');

	const st = await call('/channels/state');
	assert.equal(st.qq.replyWindowMinutes, 300, 'QQ：保存过的值要从 /channels/state 读回来（读不回来 = 输入框是死的）');

	// 没配过 / 没带字段 → 沿用配置；配置里也没有 → 120
	cfg = { qq: { enabled: true }, bili: {}, douyin: {} };
	await call('/channels/qq-config', 'POST', { batchMs: 3000 });
	assert.equal((await call('/channels/state')).qq.replyWindowMinutes, 120, 'QQ：没配过时回显兜底 120（不是 undefined）');

	cfg = { qq: { enabled: true, replyWindowMinutes: 45 }, bili: {}, douyin: {} };
	await call('/channels/qq-config', 'POST', { batchMs: 3000 });
	assert.equal(cfg.qq.replyWindowMinutes, 45, 'QQ：请求里没带这个字段时不能把已存的值冲掉');
	ok('QQ：保存 / 回显 / 沿用已存值，都对得上');
}

// ── B站 ──
{
	cfg = { qq: {}, bili: { enabled: true }, douyin: {} };
	const res = await call('/channels/bili-config', 'POST', { replyWindowMinutes: 240 });
	assert.equal(res.ok, true, 'B站保存要成功');
	assert.equal(cfg.bili.replyWindowMinutes, 240, 'B站：保存的值要落进配置');

	const st = await call('/channels/state');
	assert.equal(st.bili.replyWindowMinutes, 240, 'B站：要能从 biliState 读回来');

	cfg = { qq: {}, bili: { enabled: true }, douyin: {} };
	await call('/channels/bili-config', 'POST', { pollSeconds: 30 });
	assert.equal((await call('/channels/state')).bili.replyWindowMinutes, 120, 'B站：没配过时回显兜底 120');
	ok('B站：保存 / 回显都对得上');
}

// ── 抖音 ──
{
	cfg = { qq: {}, bili: {}, douyin: { enabled: true } };
	const res = await call('/channels/douyin-config', 'POST', { replyWindowMinutes: 60 });
	assert.equal(res.ok, true, '抖音保存要成功');
	assert.equal(cfg.douyin.replyWindowMinutes, 60, '抖音：保存的值要落进配置');

	const st = await call('/channels/state');
	assert.equal(st.douyin.replyWindowMinutes, 60, '抖音：要能从 douyinState 读回来');

	cfg = { qq: {}, bili: {}, douyin: { enabled: true } };
	await call('/channels/douyin-config', 'POST', { masterName: '主人' });
	assert.equal((await call('/channels/state')).douyin.replyWindowMinutes, 120, '抖音：没配过时回显兜底 120');
	ok('抖音：保存 / 回显都对得上');
}

// ── ⑥ 范围 1~1440 ──────────────────────────────────────────────────────────
//
// 最小是 1 分钟，不是 0。**0 不是一个有意义的配置值**，两条读它的路都会给出用户没想要的结果：
//   · 「旧消息只记不回」的判断是 `Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000`
//     （gateway.js:868 / gateway-media.js:67,108,148）。0 ⇒ 窗口是 0 毫秒 ⇒
//     连 1 秒前发来的消息也算旧消息 ⇒ 表现成「自动回复开着却一条都不回」。
//   · 同一个数字还被 QQ 重发队列拿去当 `windowMs`（gateway.js:151 的
//     `(Number(...) || 10) * 60_000`）。0 会被 `|| 10` 换成 10 分钟 ——
//     即「0 在这里等于 10」，和上面那条路的 0 又不一致。
//   一个数字在两处被解释成两个意思，索性把下限卡在 1：真要「只记不回」，
//   用「自动回复」那个开关表达，不靠把这个值调成 0。
// （注：0 在别处确实有「不限 / 关掉」的用法，例如 proactive.idleRealGapMinutes、
//   interject.cooldownMinutes；但那是各自开关自己的约定，不是这个值的语义，别照搬。）
for (const [path, key] of [['/channels/qq-config', 'qq'], ['/channels/bili-config', 'bili'], ['/channels/douyin-config', 'douyin']]) {
	cfg = { qq: { enabled: true }, bili: { enabled: true }, douyin: { enabled: true } };
	await call(path, 'POST', { replyWindowMinutes: 0 });
	assert.equal(cfg[key].replyWindowMinutes, 1, `${key}：0 要被抬到 1（0 不是「永不过期」）`);

	cfg = { qq: { enabled: true }, bili: { enabled: true }, douyin: { enabled: true } };
	await call(path, 'POST', { replyWindowMinutes: 999999 });
	assert.equal(cfg[key].replyWindowMinutes, 1440, `${key}：超大值压到 1440`);

	cfg = { qq: { enabled: true }, bili: { enabled: true }, douyin: { enabled: true } };
	await call(path, 'POST', { replyWindowMinutes: '30' });
	assert.equal(cfg[key].replyWindowMinutes, 30, `${key}：字符串数字也要认（输入框给的就是字符串）`);
}
ok('范围夹取：三平台都是 1~1440，0 抬到 1、超大压到 1440、字符串也能收');

db.close();
console.log('\nreply-window ok');
