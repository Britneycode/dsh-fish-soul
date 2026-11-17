// 版本检查：版本号比较、npm 优先 / GitHub 兜底 / 都失败、有新版时给出更新命令、结果存 kv、路由。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { UpdateChecker, compareVersions, pluginVersion, updateCommand, installMode, installInfo, modeFromPath } from '../lib/update-check.js';
import { handleUpdateRoute } from '../lib/routes-update.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(pluginVersion(), pkg.version);

assert.equal(compareVersions('0.11.2', '0.11.2'), 0);
assert.equal(compareVersions('v0.11.3', '0.11.2'), 1);
assert.equal(compareVersions('0.9.0', '0.11.0'), -1);
assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
assert.equal(compareVersions('0.12.0-beta.1', '0.12.0'), -1);
assert.equal(compareVersions('0.12.0', '0.12.0-beta.1'), 1);
assert.equal(compareVersions('0.12.0-beta.2', '0.12.0-beta.1'), 1);
assert.equal(updateCommand('0.12.0'), 'dsh plugin --profile desktop add dsh-fish-soul@0.12.0');

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
let npm = () => json({ version: '0.12.0' });
let gh = () => json({ tag_name: 'v0.12.0', body: '## 新东西\n- 版本显示', html_url: 'https://github.com/x/releases/tag/v0.12.0', published_at: '2025-01-01T00:00:00Z' });
const calls = [];
const fetchImpl = async (url) => {
	calls.push(url);
	if (String(url).includes('registry.npmjs.org')) return npm();
	if (String(url).includes('api.github.com')) return gh();
	throw new Error('unexpected ' + url);
};
const logs = [];
let auto = true;
const up = new UpdateChecker({ db, getConfig: () => ({ autoCheck: auto }), log: (l, m) => logs.push([l, m]), fetchImpl, current: '0.11.2', now: () => 42 });

// 还没检查
let s = up.state();
assert.equal(s.current, '0.11.2'); assert.equal(s.latest, null); assert.equal(s.hasUpdate, false); assert.equal(s.command, '');

// npm 有新版 + GitHub 说明
s = await up.check();
assert.equal(s.latest, '0.12.0'); assert.equal(s.source, 'npm'); assert.equal(s.hasUpdate, true);
assert.equal(s.command, 'dsh plugin --profile desktop add dsh-fish-soul@0.12.0');
assert.match(s.notes, /版本显示/); assert.match(s.notesUrl, /v0\.12\.0/); assert.equal(s.checkedAt, 42);
assert.equal(logs.filter(([, m]) => m.includes('有新版本')).length, 1);
// 同一版本不重复刷日志
await up.check();
assert.equal(logs.filter(([, m]) => m.includes('有新版本')).length, 1);

// 结果存 kv：新实例不联网也能读到
const up2 = new UpdateChecker({ db, getConfig: () => ({}), fetchImpl: async () => { throw new Error('不该联网'); }, current: '0.11.2' });
assert.equal(up2.state().latest, '0.12.0'); assert.equal(up2.state().hasUpdate, true);
// 已经装了最新的
const up3 = new UpdateChecker({ db, getConfig: () => ({}), fetchImpl, current: '0.12.0' });
assert.equal(up3.state().hasUpdate, false); assert.equal(up3.state().command, ''); assert.equal(up3.state().notes, '');

// npm 挂了 → GitHub 兜底
npm = () => json({}, 503);
s = await up.check();
assert.equal(s.latest, '0.12.0'); assert.equal(s.source, 'github'); assert.equal(s.error, '');

// 都挂了 → error，不抛
npm = () => { throw new Error('ECONNRESET'); };
gh = () => json({}, 403);
s = await up.check();
assert.equal(s.latest, null); assert.equal(s.hasUpdate, false); assert.match(s.error, /npm/); assert.match(s.error, /GitHub/);
assert.ok(logs.some(([l]) => l === 'warn'));

// 同时点两次只跑一次
npm = () => json({ version: '0.11.2' }); gh = () => json({ tag_name: 'v0.11.2' });
calls.length = 0;
const [a, b] = await Promise.all([up.check(), up.check()]);
assert.equal(calls.filter((u) => String(u).includes('npmjs')).length, 1);
assert.equal(a.hasUpdate, false); assert.equal(b.latest, '0.11.2');

// check() 返回时 checking 已经是 false（不然按钮会一直「检查中…」）
const done = await up.check();
assert.equal(done.checking, false);
const pending = up.check();
assert.equal(up.state().checking, true);
assert.equal((await pending).checking, false);

// 调度：没查过 → 30 秒；刚查过 → 约 12 小时（±10%）；早该查了 → 30 秒
{
	let t = 0;
	const db2 = new DatabaseSync(':memory:');
	db2.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	const u = new UpdateChecker({ db: db2, getConfig: () => ({}), fetchImpl, current: '0.11.2', now: () => t, random: () => 1 });
	assert.equal(u.nextDelay(), 30_000);
	await u.check();
	assert.equal(u.nextDelay(), 12 * 3600_000 * 1.1);
	t = 6 * 3600_000;
	assert.equal(u.nextDelay(), 12 * 3600_000 * 1.1 - 6 * 3600_000);
	t = 20 * 3600_000;
	assert.equal(u.nextDelay(), 30_000);
	const lo = new UpdateChecker({ db: db2, getConfig: () => ({}), fetchImpl, current: '0.11.2', now: () => 0, random: () => 0 });
	assert.equal(lo.nextDelay(), 12 * 3600_000 * 0.9);
}

// 安装方式：判据是「解 symlink 后的路径在不在 DSH 目录下面」。
// ⚠️ 断言要打**行为**（合成路径 → 期望模式），不能只打「我此刻跑在开发仓里」——
//    后者测的是环境：主人把仓库 clone 进某个项目的 node_modules 下开发时就会红，
//    而功能其实是对的。判据本身（dev/registry 的分界）必须被真正执行到。
{
	const HOME = 'C:/Users/x/.dsh';
	const cases = [
		// [目录, 期望]
		['D:/Demo/program/qq-bot/dsh-fish-soul', 'dev'],                                  // 开发仓在别处
		['C:/Users/x/.dsh/profiles/desktop/node_modules/dsh-fish-soul', 'registry'],       // npm 装
		['C:/Users/x/.dsh/profiles/desktop/node_modules/.pnpm/dsh-fish-soul@0.18.7/node_modules/dsh-fish-soul', 'registry'], // pnpm 装
		['C:/someproject/node_modules/dsh-fish-soul', 'dev'],                              // 开发仓恰好在 node_modules 下 —— 不能误判成 registry
		['C:/Users/x/.dsh-other/x', 'dev'],                                                // 只是前缀像
		['C:/Users/x/.dsh', 'unknown']
	];
	for (const [dir, want] of cases) {
		assert.equal(modeFromPath(dir, HOME), want, `${dir} 应判成 ${want}`);
	}
	// 本机这条只留一条，且只作「环境恰好如此」的记录
	const info = installInfo();
	assert.ok(['dev', 'registry', 'unknown'].includes(info.mode), 'mode 要是三种之一');
	assert.equal(up.state().installMode, info.mode, 'state 要带上安装方式');
	assert.equal(up.state().installPath, info.path, 'state 要带上路径');
}

// 🔴 **进程刚启动时，结果旧到会误导人（> 1 小时）就补查一次**。
//    以前 nextDelay() 只看 kv 里的 checkedAt ⇒ 宿主重启后可能要再等好几个小时才重查，
//    面板一直显示上一次的旧结果（实测 latest 停在 0.18.5，而 npm 上早就是 0.18.7 了）。
//    ⚠️ 但**不能每次启动都问**：GitHub 未认证 API 是 60 次/小时/IP，崩溃重启循环会吃满；
//    而且 nextDelay() 的文档写着「重启频繁时也不会每次启动都去问」—— 那是一条既有承诺。
{
	const armOf = async (u) => {
		let armed = null;
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = (fn, ms) => { armed = ms; return { unref() {} }; };
		try { u.start(); } finally { globalThis.setTimeout = realSetTimeout; }
		return armed;
	};
	// (a) 上次查的结果很旧（7 小时前）⇒ 补查（30 秒）
	{
		const db3 = new DatabaseSync(':memory:');
		db3.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
		let t = 7 * 3600_000;
		const u3 = new UpdateChecker({ db: db3, getConfig: () => ({}), fetchImpl, current: '0.11.2', now: () => t, random: () => 1 });
		await u3.check();            // 查一次（checkedAt = t）
		t += 7 * 3600_000;           // 又过了 7 小时 ⇒ 结果旧到会误导人
		assert.equal(await armOf(u3), 30_000, '结果超过 1 小时了 ⇒ 进程启动后补查（30 秒）');
	}
	// (b) 上次刚查过 ⇒ 不补查，接着 12 小时的排程（别把 API 打满）
	{
		const db4 = new DatabaseSync(':memory:');
		db4.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
		const u4 = new UpdateChecker({ db: db4, getConfig: () => ({}), fetchImpl, current: '0.11.2', now: () => 0, random: () => 1 });
		await u4.check();            // checkedAt = 0
		const armed = await armOf(u4);
		assert.ok(armed > 30_000, `刚查过就不该补查（否则每次重启都打一遍 API），实际排程 ${armed}ms`);
	}
}

// 自动检查开关
assert.equal(up.state().autoCheck, true);
auto = false;
assert.equal(up.state().autoCheck, false);
up.start(); up.stop();

// 路由
const saved = [];
// 带一个宿主 plugin-manager 服务 ⇒ canApply 应为 true
const pm = { updateBundle: async () => ({}) };
const deps = {
	updater: up,
	ctx: { get: () => pm },
	saveConfig: async (p) => { saved.push(p); auto = p.update.autoCheck; }
};
const run = async (method, path, body, origin = true) => {
	let out = null;
	const handled = await handleUpdateRoute({
		method, path, req: {}, readBody: async () => body ?? '', sameOrigin: () => origin,
		send: (code, payload) => { out = { code, payload }; }, deps
	});
	return { handled, ...out };
};
let r = await run('GET', '/update/state');
assert.equal(r.code, 200); assert.equal(r.payload.current, '0.11.2');
r = await run('GET', '/update/state', '', false);
assert.equal(r.code, 403);
r = await run('POST', '/update/check', '', false);
assert.equal(r.code, 403);
r = await run('POST', '/update/config', JSON.stringify({ autoCheck: true }));
assert.equal(r.code, 200); assert.deepEqual(saved, [{ update: { autoCheck: true } }]); assert.equal(r.payload.autoCheck, true);

// ⚠️ canApply 必须在**每个**响应里都在。
//    面板把整个响应换进 data ⇒ 漏一个字段，那个字段就变 undefined ⇒
//    点一下「检查更新」或切一下自动检查开关，「一键更新」按钮就凭空消失。
for (const [method, path, body] of [['GET', '/update/state', ''], ['POST', '/update/check', ''], ['POST', '/update/config', JSON.stringify({ autoCheck: true })]]) {
	const rr = await run(method, path, body);
	assert.equal(rr.code, 200, path);
	assert.equal(rr.payload.canApply, true, `${path} 的响应要带 canApply（否则面板上「更新到」按钮会消失）`);
	assert.equal(rr.payload.installMode, installInfo().mode, `${path} 的响应要带 installMode（面板要据此说明为什么没有一键更新）`);
}
r = await run('POST', '/update/config', JSON.stringify({ autoCheck: 'yes' }));
assert.equal(r.code, 400);
assert.equal((await run('GET', '/other')).handled, false);

// ── 接线测试：ctx 有没有真的传到路由里 ──
//    ⚠️ 以前所有测试都是**手工构造 deps**（自己塞 ctx），从来不走真实的 registerRoutes 接线，
//    于是「deps 里压根没有 ctx」这件事谁都没发现 —— 一键更新按钮在真机上从来没渲染过。
{
	const { registerRoutes } = await import('../lib/routes.js');
	let handler = null;
	const pm2 = { updateBundle: async () => ({}) };
	const hostCtx = { effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } }, get: () => pm2 };
	// 生产形态的 deps：**没有 ctx**（就像 lib/index.js 里以前那样）
	const prodDeps = { updater: up, saveConfig: async () => {}, db, clock: { getRoleDateParts: () => ({ dateStr: '2030-01-01' }) } };
	registerRoutes(hostCtx, prodDeps);
	assert.equal(prodDeps.ctx, hostCtx, 'registerRoutes 必须把 ctx 放进 deps（否则 /update/ 拿不到宿主的 plugin-manager 服务）');
	const req = new (await import('node:stream')).Readable({ read() { this.push(null); } });
	req.url = '/api/plugins/fish-soul/update/state';
	req.method = 'GET';
	req.headers = {};
	let out = '';
	const res = { writeHead: () => {}, end: (t) => { out = t; } };
	await handler(req, res);
	const payload = JSON.parse(out);
	assert.equal(payload.ok, true);
	assert.equal(payload.canApply, true, '宿主有 plugin-manager 服务时 canApply 要是 true（否则面板上没有「更新到」按钮）');
	assert.ok(payload.installMode !== undefined, '响应要带 installMode');
}

// ── fallback 路径（updater 没起来时）的字段集必须和正常路径一致 ──
//    少一个字段，面板就少一块东西 —— 这次修的正是「漏字段导致按钮消失」，同一个坑不能留半个。
{
	const { registerRoutes } = await import('../lib/routes.js');
	let handler = null;
	const hostCtx2 = { effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } }, get: () => ({ updateBundle: async () => ({}) }) };
	// **没有 updater** —— 走 fallback 分支
	registerRoutes(hostCtx2, { saveConfig: async () => {} });
	const req = new (await import('node:stream')).Readable({ read() { this.push(null); } });
	req.url = '/api/plugins/fish-soul/update/state';
	req.method = 'GET';
	req.headers = {};
	let out = '';
	const res = { writeHead: () => {}, end: (t) => { out = t; } };
	await handler(req, res);
	const payload = JSON.parse(out);
	assert.equal(payload.ok, true);
	for (const k of ['current', 'latest', 'hasUpdate', 'checkedAt', 'checking', 'autoCheck', 'canApply', 'installMode', 'installPath', 'command', 'notes', 'notesUrl', 'error']) {
		assert.ok(k in payload, `fallback 的响应也要有 ${k}（面板按这些字段渲染，少一个就少一块）`);
	}
	assert.equal(payload.installMode, installInfo().mode, 'fallback 也要带上安装方式');
}

console.log('update-check ok');
