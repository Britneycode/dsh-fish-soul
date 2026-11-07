// #72：抖音页面被浏览器「睡」掉（长时间不用 → 白屏）时，
// 自检该先刷新自救一次，别一上来就报「改版」把自动回复停了。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-dyrec-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinChannel, DouyinHost } = await import('../lib/channels/douyin.js');

const ok = (s) => console.log(`  ✓ ${s}`);
const db = openDatabase();

/** 假 host：只实现 refresh（页面刷新）。 */
const fakeHost = ({ refresh = async () => true } = {}) => ({
	running: true,
	refresh,
	exclusive: async (_label, fn) => await fn(),
});

/** 假 driver：自检按脚本依次返回（用完就重复最后一个）。 */
function fakeDriver(reports) {
	let i = 0;
	return {
		canary: async () => {
			const r = reports[Math.min(i, reports.length - 1)];
			i++;
			return typeof r === 'function' ? await r() : r;
		},
	};
}

const newChannel = (host, driver, notes = []) => new DouyinChannel({
	host, db, driver, getConfig: () => ({}), log: () => {}, onMessage: () => {}, notify: (k, t) => notes.push([k, t]),
});

// ① 自检本来就过 → 不该刷新
{
	let refreshes = 0;
	const ch = newChannel(fakeHost({ refresh: async () => { refreshes++; return true; } }), fakeDriver([{ ok: true }]));
	const r = await ch.runCanary();
	assert.equal(r.ok, true);
	assert.equal(refreshes, 0, '自检过了不该刷新页面');
	assert.equal(ch.replyPaused, false);
}
ok('自检过了：不刷新、不停自动回复');

// ② 自检没过 → 刷新一次 → 认回来了 → 当什么都没发生
{
	let refreshes = 0;
	const notes = [];
	const ch = newChannel(
		fakeHost({ refresh: async () => { refreshes++; return true; } }),
		fakeDriver([{ ok: false, broken: ['conversationItem'] }, { ok: true }]),
		notes,
	);
	const r = await ch.runCanary();
	assert.equal(refreshes, 1, '自检没过要刷新一次');
	assert.equal(r.ok, true, '刷新完认回来了');
	assert.equal(r.recovered.ok, true);
	assert.equal(ch.replyPaused, false, '白屏不是改版，不该停自动回复');
	assert.deepEqual(notes.at(-1), ['douyin.page', null], '恢复后把「页面变了」的提示撤掉');
}
ok('白屏：刷新一次救回来，不当成改版');

// ③ 刷新也没用 → 还是当成认不出页面，停自动回复
{
	const notes = [];
	const ch = newChannel(
		fakeHost({ refresh: async () => true }),
		fakeDriver([{ ok: false, broken: ['conversationItem'] }]),
		notes,
	);
	const r = await ch.runCanary();
	assert.equal(r.ok, false);
	assert.equal(r.recovered.ok, false, '刷新完还是认不出');
	assert.equal(ch.replyPaused, true);
	assert.ok(String(notes.at(-1)[1]).includes('改版'), '还是提示改版');
}
ok('刷新也救不回来：照旧停自动回复并提示');

// ④ 冷却：10 分钟内不重复刷（页面真改版时别一直刷）
{
	let refreshes = 0;
	const ch = newChannel(
		fakeHost({ refresh: async () => { refreshes++; return true; } }),
		fakeDriver([{ ok: false, broken: ['conversationItem'] }]),
	);
	await ch.runCanary();
	await ch.runCanary();
	assert.equal(refreshes, 1, '冷却期内不重复刷新');
	assert.equal(ch.canaryReport.recovered.skipped, 'cooldown');
}
ok('冷却：10 分钟内只刷一次');

// ⑤ host 没有 refresh（比如旧版本）→ 不炸，照旧处理
{
	const ch = newChannel({ running: true, exclusive: async (_l, fn) => await fn() }, fakeDriver([{ ok: false, broken: ['x'] }]));
	const r = await ch.runCanary();
	assert.equal(r.recovered.skipped, 'no-refresh');
	assert.equal(ch.replyPaused, true);
}
ok('host 不会刷新：照旧处理，不炸');

// ⑥ DouyinHost.refresh()：在抖音页面上是「刷新」，页面跑偏了才「导航回去」
{
	const calls = [];
	const host = new DouyinHost({ db, getConfig: () => ({}), openPanel: async () => { calls.push('panel'); } });
	host.browser = {
		isAlive: () => true,
		eval: async () => 'https://www.douyin.com/jingxuan',
		reload: async () => { calls.push('reload'); return { url: 'https://www.douyin.com/jingxuan' }; },
		goto: async () => { calls.push('goto'); },
	};
	host.state = 'running';
	assert.equal(await host.refresh(), true);
	assert.deepEqual(calls, ['reload', 'panel'], '刷新 + 重新打开私信面板');
}
{
	const calls = [];
	const host = new DouyinHost({ db, getConfig: () => ({}), openPanel: async () => { calls.push('panel'); } });
	host.browser = {
		isAlive: () => true,
		eval: async () => 'about:blank',
		reload: async () => { calls.push('reload'); },
		goto: async () => { calls.push('goto'); },
	};
	host.state = 'running';
	assert.equal(await host.refresh(), true);
	assert.deepEqual(calls, ['goto', 'panel'], '页面已经跑偏：导航回抖音，不是刷新');
}
{
	const host = new DouyinHost({ db, getConfig: () => ({}) });
	assert.equal(await host.refresh(), false, '浏览器没在跑就不刷');
}
ok('DouyinHost.refresh：刷新 / 导航回抖音 / 浏览器没跑');

console.log('douyin-recovery ok');
