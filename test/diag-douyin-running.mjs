// 诊断页「抖音 没跑」判据：**用真实 DouyinChannel**，不用 mock。
//
// 踩过两次坑，两次都是「判错字段」：
//   ① 判 `douyinSt.state === 'running'` —— `state` 是 **DouyinHost** 的字段，
//      在 **DouyinChannel** 上恒 undefined ⇒ 一直假红「抖音 没跑」。
//   ② 改成判 `douyinSt.running` —— 那是**轮询循环**存活标志；`pollOnce()` 在
//      `!host.running` 时直接 return 且不记错误 ⇒ 浏览器崩了/被暂停它还是 true
//      ⇒ 变成一直假绿（比假红更糟：看不出坏）。
//
// 正确判据是 `connected` = running && host.running && host.loggedIn。
// ⚠️ 所以本测试**必须 new 真的 DouyinChannel**：mock 一个 `{running:true}` 的对象，
//    无论生产代码怎么改都会绿 —— 上一版就栽在这上面（改真实 status() 的字段名，
//    测试照样全绿）。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-diag-douyin-running-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');

const db = openDatabase();

function mount(deps) {
	let handler = null;
	const ctx = {
		effect: (fn) => { fn(); },
		webServer: { register: (o) => { handler = o.handler; } }
	};
	registerRoutes(ctx, deps);
	return handler;
}

async function call(handler, path, method = 'GET') {
	let out = null;
	const res = {
		writeHead: () => {},
		end: (text) => { out = JSON.parse(text); }
	};
	await handler({ method, url: `/api/plugins/fish-soul${path}`, headers: {} }, res);
	return out;
}

/**
 * 造一对**真的** DouyinChannel + DouyinHost（host 用最小假实现，
 * 但 `running` / `loggedIn` / `state` 都是真实字段形状）。
 */
function realChannel({ running = true, hostRunning = true, loggedIn = true, hostState = 'running', hostError = '', paused = false, pausedWhy = '' } = {}) {
	// 真实 DouyinHost 有 `paused` / `pausedWhy` 字段（lib/channels/douyin.js:892-894
	// 的 status() 直接读 this.paused），所以假 host 也必须放在对象上，
	// 不能只塞进 status() 的返回值 —— 否则测的是「我编的形状」而不是生产形状。
	const host = {
		running: hostRunning,
		loggedIn,
		paused,
		status: () => ({ state: hostState, paused, pausedWhy, lastError: hostError, busy: false, loggedIn })
	};
	const channel = new DouyinChannel({
		host, db,
		getConfig: () => ({ enabled: true, autoReply: true }),
		log: () => {},
		onMessage: () => ({ done: true })
	});
	channel.running = running;
	return { channel, host };
}

function baseDeps(channel, host) {
	return {
		db,
		clock: { getRoleDateParts: () => ({ dateStr: '2030-01-01' }) },
		life: { stateSnapshot: () => ({ today: { proactiveCount: 0 } }) },
		gateway: { decisions: [] },
		getConfig: () => ({ qq: { enabled: false }, bili: { enabled: false }, douyin: { enabled: true }, masterQqUin: '' }),
		saveConfig: () => {},
		channel: null,
		bili: null,
		douyin: channel,
		douyinHost: host,
		log: () => {}
	};
}

const channelsItem = (out) => out.items.find((i) => i.key === 'channels');

// ① 全都正常 ⇒ 绿 +「抖音 在跑」
{
	const { channel, host } = realChannel();
	const it = channelsItem(await call(mount(baseDeps(channel, host)), '/diagnose'));
	assert.equal(it.ok, true, `抖音正常时通道应为绿，实际：${it.detail}`);
	assert.match(it.detail, /抖音 在跑/, `文案应含「抖音 在跑」，实际：${it.detail}`);
}

// ② 浏览器没起来（host.running=false，但轮询循环还活着）⇒ 必须红
//    这正是「只判 running 会假绿」的那个场景。
{
	const { channel, host } = realChannel({ hostRunning: false, loggedIn: false, hostState: 'error', hostError: '浏览器没起来' });
	assert.equal(channel.running, true, '前置：轮询循环仍活着（模拟 pollOnce 直接 return 的情形）');
	const it = channelsItem(await call(mount(baseDeps(channel, host)), '/diagnose'));
	assert.equal(it.ok, false, `浏览器没起来时必须判红（只判 running 会在这里假绿），实际：${it.detail}`);
	assert.match(it.detail, /抖音 没跑/, `文案应含「抖音 没跑」，实际：${it.detail}`);
	assert.match(it.detail, /浏览器没起来/, `应说清卡在哪一步，实际：${it.detail}`);
}

// ③ 浏览器被暂停 ⇒ 红，且带出暂停原因
{
	const { channel, host } = realChannel({ hostState: 'paused', paused: true, pausedWhy: '主人手动暂停' });
	const it = channelsItem(await call(mount(baseDeps(channel, host)), '/diagnose'));
	assert.equal(it.ok, false, `暂停时必须判红，实际：${it.detail}`);
	assert.match(it.detail, /暂停/, `应说明是被暂停了，实际：${it.detail}`);
	assert.match(it.detail, /主人手动暂停/, `应带出暂停原因，实际：${it.detail}`);
}

// ④ 浏览器停了 ⇒ 红
{
	const { channel, host } = realChannel({ hostRunning: false, loggedIn: false, hostState: 'stopped' });
	const it = channelsItem(await call(mount(baseDeps(channel, host)), '/diagnose'));
	assert.equal(it.ok, false, `浏览器停了必须判红，实际：${it.detail}`);
}

// ⑤ 浏览器在跑但没登录 ⇒ 红，且说明是没登录
{
	const { channel, host } = realChannel({ loggedIn: false, hostState: 'running' });
	const it = channelsItem(await call(mount(baseDeps(channel, host)), '/diagnose'));
	assert.equal(it.ok, false, `没登录必须判红，实际：${it.detail}`);
	assert.match(it.detail, /没登录/, `应说明是没登录，实际：${it.detail}`);
}

// ⑥ 轮询循环没启动 ⇒ 红
{
	const { channel, host } = realChannel({ running: false });
	const it = channelsItem(await call(mount(baseDeps(channel, host)), '/diagnose'));
	assert.equal(it.ok, false, `轮询没启动必须判红，实际：${it.detail}`);
	assert.match(it.detail, /轮询没启动/, `应说明轮询没启动，实际：${it.detail}`);
}

// ⑦ 抖音没开 ⇒ 不因抖音判红
{
	const { channel, host } = realChannel({ running: false, hostRunning: false });
	const deps = baseDeps(channel, host);
	deps.getConfig = () => ({ qq: { enabled: false }, bili: { enabled: false }, douyin: { enabled: false }, masterQqUin: '' });
	const it = channelsItem(await call(mount(deps), '/diagnose'));
	assert.equal(it.ok, true, '抖音没开时不该因抖音判红');
	assert.match(it.detail, /抖音 没开/, `文案应是「抖音 没开」，实际：${it.detail}`);
}

// ⑧ 契约：真实 DouyinChannel.status() 必须有 connected，且没有 state
//    （这条打的是**真的** status()，不是 mock —— 改字段名会让它红）
{
	const { channel } = realChannel();
	const st = channel.status();
	assert.equal(typeof st.connected, 'boolean', 'DouyinChannel.status() 必须暴露 connected');
	assert.equal(st.connected, true, '全正常时 connected 应为 true');
	assert.equal('state' in st, false, 'DouyinChannel.status() 不该有 state（那是 DouyinHost 的字段）');

	const broken = realChannel({ hostRunning: false, loggedIn: false });
	assert.equal(broken.channel.status().connected, false,
		'浏览器没起来时 connected 必须是 false（running 仍是 true —— 这正是不能判 running 的原因）');
	assert.equal(broken.channel.status().running, true, '前置：running 此时仍为 true');
}

console.log('✓ 诊断页抖音可用性判据（8 组，打真实 DouyinChannel）全部通过');
db.close();
