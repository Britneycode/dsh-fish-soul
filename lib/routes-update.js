/**
 * routes-update.js —— 版本与更新：
 *   GET  /update/state   当前版本、上次检查结果（不联网）
 *   POST /update/check   现在检查一次（npm → GitHub）
 *   POST /update/config  { autoCheck } 自动检查开关
 *   POST /update/apply   一键更新到上次检查到的最新版（走宿主 plugin-manager，失败它自己回滚）
 */
import { pluginVersion, installInfo } from './update-check.js';
import { applyUpdate, pluginManagerOf } from './self-update.js';

const BODY_MAX = 4 * 1024;

export async function handleUpdateRoute({ method, path, req, send, readBody, sameOrigin, deps }) {
	if (!path.startsWith('/update/')) return false;
	const { updater, saveConfig } = deps;
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };
	// ⚠️ fallback 的字段集要和正常路径**完全一致**（少一个字段，面板就少一块东西）。
	//    这次修的就是「漏字段导致按钮消失」，同一个坑不能留半个。
	const fallback = () => ({
		ok: true, current: pluginVersion(), latest: null, hasUpdate: false, checkedAt: null,
		checking: false, autoCheck: true, source: '', notes: '', notesUrl: '', publishedAt: null, error: '', command: '',
		canApply: pluginManagerOf(deps.ctx) !== null,
		installMode: installInfo().mode, installPath: installInfo().path
	});

	if (method === 'GET' && path === '/update/state') {
		if (!guard()) return true;
		send(200, updater ? { ...updater.state(), canApply: pluginManagerOf(deps.ctx) !== null } : fallback());
		return true;
	}
	if (method === 'POST' && path === '/update/apply') {
		if (!guard()) return true;
		if (!updater) { send(200, { ok: false, error: '更新检查没起来' }); return true; }
		const r = await applyUpdate({ ctx: deps.ctx, state: updater.state() });
		send(200, r.ok ? { ...updater.state(), ...r, canApply: true } : r);
		return true;
	}
	if (method === 'POST' && path === '/update/check') {
		if (!guard()) return true;
		if (!updater) { send(200, { ...fallback(), ok: false, error: '更新检查没起来' }); return true; }
		await updater.check();
		// ⚠️ 别漏 canApply：面板把整个响应换进 data，漏了它「一键更新」按钮就没了
		//    （点一下「检查更新」，按钮凭空消失 —— 主人会以为功能坏了）。
		send(200, { ...updater.state(), canApply: pluginManagerOf(deps.ctx) !== null });
		return true;
	}
	if (method === 'POST' && path === '/update/config') {
		if (!guard()) return true;
		const raw = await readBody(req);
		if (raw.length > BODY_MAX) { send(413, { ok: false, error: '请求太大' }); return true; }
		const b = JSON.parse(raw || '{}');
		if (typeof b.autoCheck !== 'boolean') { send(400, { ok: false, error: 'autoCheck 要是 true / false' }); return true; }
		await saveConfig({ update: { autoCheck: b.autoCheck } });
		// ⚠️ 刚打开自动检查就查一次：否则那 30 秒的启动机会早就被 autoCheck=false 时烧掉了，
		//    打开开关后要等十几个小时才有下一次 —— 面板继续显示旧结果（正是要消灭的那种陈旧）。
		if (b.autoCheck && updater) { try { await updater.check(); } catch { /* 查不到不影响保存 */ } }
		send(200, updater
			? { ...updater.state(), autoCheck: b.autoCheck, canApply: pluginManagerOf(deps.ctx) !== null }
			: { ...fallback(), autoCheck: b.autoCheck });
		return true;
	}
	return false;
}
