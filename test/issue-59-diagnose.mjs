// #59 ③ 诊断页一键自检：只读 GET /diagnose，六项结果（版本 / 通道 / QQ 登录 / 记忆条数 / 今日次数 / 补丁）。
// 约定：查不动的那一项自己标红并带原因，整个接口照常 200，不抛 500。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-issue59-diag-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');
const { pluginVersion } = await import('../lib/update-check.js');

const db = openDatabase();

// 把 registerRoutes 挂出来的处理器抓出来直接调（假宿主）
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

const cfg = {
	qq: { enabled: true },
	bili: { enabled: false },
	douyin: { enabled: false },
	masterQqUin: '10001'
};
const deps = {
	db,
	clock: { getRoleDateParts: () => ({ dateStr: '2030-01-01' }) },
	life: { stateSnapshot: () => ({ today: { proactiveCount: 4 } }) },
	gateway: { decisions: [{ at: Date.now(), kind: 'interject' }, { at: Date.now(), kind: 'reply' }] },
	channel: { status: () => ({ connected: true, selfId: '1000', nickname: '小鱼', friendCount: 12 }) },
	bili: { status: () => ({ loggedIn: false }) },
	getConfig: () => cfg,
	saveConfig: () => {},
	log: () => {}
};

// ── 1. 六项都在，字段齐 ──
{
	const handler = mount(deps);
	const res = await call(handler, '/diagnose');
	assert.equal(res.ok, true, '整体成功');
	assert.equal(res.items.length, 6, '六项');
	assert.deepEqual(res.items.map((x) => x.key), ['version', 'channels', 'qq', 'memory', 'today', 'patch'], '六项的顺序与名字');
	for (const it of res.items) {
		assert.equal(typeof it.label, 'string', `${it.key} 有名字`);
		assert.equal(typeof it.ok, 'boolean', `${it.key} 有红绿`);
		assert.equal(typeof it.detail, 'string', `${it.key} 有说明`);
		assert.notEqual(it.detail, '', `${it.key} 的说明不是空串`);
	}
	const by = Object.fromEntries(res.items.map((x) => [x.key, x]));
	assert.equal(by.version.ok, true, '版本读到了');
	assert.equal(by.version.detail, `v${pluginVersion()}`, '版本号跟 package.json 一致');
	assert.equal(by.channels.ok, true, '开着的通道都连着');
	assert.match(by.channels.detail, /QQ 已连/, '通道里写了 QQ 状态');
	assert.match(by.channels.detail, /B站 没开/, '没开的通道也说明白');
	assert.equal(by.qq.ok, true, 'QQ 连上了');
	assert.match(by.qq.detail, /已登录 小鱼/, 'QQ 登录态写了登的是谁');
	assert.equal(by.memory.ok, true, '记忆条数查到了');
	assert.match(by.memory.detail, /0 条/, '新库记忆是 0 条');
	assert.equal(by.today.ok, true, '今日次数查到了');
	assert.match(by.today.detail, /插嘴 1 次/, '插嘴次数对得上动态缓冲');
	assert.match(by.today.detail, /主动开口 4 次/, '主动开口次数对得上 life');
	assert.equal(by.patch.ok, true, '补丁文件在');
}

// ── 2. QQ 没连上 → QQ 登录态和通道都标红，但不抛错 ──
{
	const handler = mount({ ...deps, channel: { status: () => ({ connected: false, lastError: '连接被拒' }) } });
	const res = await call(handler, '/diagnose');
	assert.equal(res.ok, true, '接口还是 200');
	const by = Object.fromEntries(res.items.map((x) => [x.key, x]));
	assert.equal(by.qq.ok, false, 'QQ 没连上 → 红');
	assert.match(by.qq.detail, /没连上/, '说了为什么');
	assert.match(by.qq.detail, /连接被拒/, '带了底层错误');
	assert.equal(by.channels.ok, false, '通道那项也跟着红');
	assert.equal(by.memory.ok, true, '别的项照常');
}

// ── 3. db 查不动 → 记忆那项标红带原因，接口不 500 ──
{
	const broken = { prepare: () => { throw new Error('database is locked'); } };
	const handler = mount({ ...deps, db: broken });
	const res = await call(handler, '/diagnose');
	assert.equal(res.ok, true, '接口还是 200，不抛 500');
	const by = Object.fromEntries(res.items.map((x) => [x.key, x]));
	assert.equal(by.memory.ok, false, '记忆查不到 → 红');
	assert.match(by.memory.detail, /查不到/, '说了原因');
	assert.equal(by.version.ok, true, '别的项不受影响');
}

// ── 4. QQ 关着 → 通道那项只看开着的通道 ──
{
	const handler = mount({
		...deps,
		getConfig: () => ({ ...cfg, qq: { enabled: false } }),
		channel: { status: () => ({ connected: false }) } // QQ 关着时连接也是断的
	});
	const res = await call(handler, '/diagnose');
	const by = Object.fromEntries(res.items.map((x) => [x.key, x]));
	assert.equal(by.channels.ok, true, 'QQ 关着不算故障');
	assert.match(by.channels.detail, /QQ 没开/, '说明 QQ 关着');
	assert.equal(by.qq.ok, false, 'QQ 登录态那项还是红的');
	assert.match(by.qq.detail, /QQ 没开/, '登录态那项说明是没开');
}

// ── 5. 只读：不写任何东西（GET 之外的方法都不该被这个路由接住）──
{
	const handler = mount(deps);
	const res = await call(handler, '/diagnose', 'POST');
	assert.equal(res.ok, false, 'POST 不是这个路由');
	assert.equal(res.error, 'not found', '回 404 的内容');
}

db.close();
console.log('✓ #59 ③ 诊断自检：六项齐、红的带原因、db 坏了也不 500、只读');
