// 版本检查：版本号比较、npm 优先 / GitHub 兜底 / 都失败、有新版时给出更新命令、结果存 kv、路由。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { UpdateChecker, compareVersions, pluginVersion, updateCommand } from '../lib/update-check.js';
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

// 自动检查开关
assert.equal(up.state().autoCheck, true);
auto = false;
assert.equal(up.state().autoCheck, false);
up.start(); up.stop();

// 路由
const saved = [];
const deps = { updater: up, saveConfig: async (p) => { saved.push(p); auto = p.update.autoCheck; } };
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
r = await run('POST', '/update/config', JSON.stringify({ autoCheck: 'yes' }));
assert.equal(r.code, 400);
assert.equal((await run('GET', '/other')).handled, false);

console.log('update-check ok');
