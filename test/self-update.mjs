// 一键更新：走宿主 plugin-manager.updateBundle，不自己 spawn pnpm。
// link 安装由宿主拒绝（返回 failed + diagnostic），面板拿到一句话原因。
import assert from 'node:assert/strict';
import { applyUpdate, pluginManagerOf } from '../lib/self-update.js';
import { handleUpdateRoute } from '../lib/routes-update.js';

const state = { ok: true, current: '0.15.33', latest: '0.15.34', hasUpdate: true, command: 'dsh plugin add dsh-fish-soul@0.15.34' };

assert.equal(pluginManagerOf(null), null);
assert.equal(pluginManagerOf({}), null);
assert.equal(pluginManagerOf({ 'plugin-manager': {} }), null, '没有 updateBundle 不算');

// 宿主没有服务
assert.deepEqual(
	await applyUpdate({ ctx: {}, state }),
	{ ok: false, error: '宿主没有插件管理服务，用「复制更新命令」手动装' }
);
// 没检查过 / 已是最新
assert.equal((await applyUpdate({ ctx: { 'plugin-manager': { updateBundle: async () => ({}) } }, state: { hasUpdate: false } })).ok, false);

// 宿主拒绝（link 安装走这条）
{
	const calls = [];
	const ctx = { 'plugin-manager': { updateBundle: async (name, version) => { calls.push([name, version]); return { from: '0.15.33', to: version, step: 'check', result: { application: 'failed', stage: 'install', error: { code: 'invalid-spec', diagnostic: 'dsh-fish-soul is not installed from a registry under its own name' } } }; } } };
	const r = await applyUpdate({ ctx, state });
	assert.equal(r.ok, false);
	assert.match(r.error, /not installed from a registry/);
	assert.deepEqual(calls, [['dsh-fish-soul', '0.15.34']], '版本号原样交给宿主，自己不拼命令');
}

// 宿主抛异常
{
	const ctx = { 'plugin-manager': { updateBundle: async () => { throw new Error('pnpm 锁被占用'); } } };
	const r = await applyUpdate({ ctx, state });
	assert.equal(r.ok, false);
	assert.match(r.error, /pnpm 锁被占用/);
}

// 成功
{
	const ctx = { 'plugin-manager': { updateBundle: async () => ({ from: '0.15.33', to: '0.15.34', step: 'install', result: { application: 'applied', changed: true } }) } };
	const r = await applyUpdate({ ctx, state });
	assert.deepEqual(r, { ok: true, from: '0.15.33', to: '0.15.34', restart: true });
}

// 失败且宿主回滚成功：文案要带「已回滚」
{
	const ctx = { 'plugin-manager': { updateBundle: async () => ({ from: '0.15.33', to: '0.15.34', result: { application: 'failed', error: { diagnostic: '装完校验失败' } }, restore: { application: 'applied' } }) } };
	const r = await applyUpdate({ ctx, state });
	assert.match(r.error, /已回滚到原版本/);
}

// 路由：canApply 反映服务在不在；apply 走 applyUpdate
{
	const updater = { state: () => state };
	const run = async (method, path, ctx) => {
		let out = null;
		await handleUpdateRoute({
			method, path, req: {}, readBody: async () => '', sameOrigin: () => true,
			send: (code, payload) => { out = { code, payload }; },
			deps: { updater, ctx, saveConfig: async () => {} }
		});
		return out;
	};
	let r = await run('GET', '/update/state', {});
	assert.equal(r.payload.canApply, false, '没有服务时按钮不出现');
	r = await run('GET', '/update/state', { 'plugin-manager': { updateBundle: async () => ({}) } });
	assert.equal(r.payload.canApply, true);
	r = await run('POST', '/update/apply', {});
	assert.equal(r.payload.ok, false);
	assert.match(r.payload.error, /没有插件管理服务/);
	r = await run('POST', '/update/apply', { 'plugin-manager': { updateBundle: async () => ({ from: '0.15.33', to: '0.15.34', result: { application: 'applied' } }) } });
	assert.equal(r.payload.ok, true);
	assert.equal(r.payload.to, '0.15.34');
	// 跨源拒绝
	let forbidden = null;
	await handleUpdateRoute({
		method: 'POST', path: '/update/apply', req: {}, readBody: async () => '', sameOrigin: () => false,
		send: (code, payload) => { forbidden = { code, payload }; }, deps: { updater, ctx: {}, saveConfig: async () => {} }
	});
	assert.equal(forbidden.code, 403);
}

console.log('self-update ok');
