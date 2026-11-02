/**
 * routes-update.js —— 版本与更新：
 *   GET  /update/state   当前版本、上次检查结果（不联网）
 *   POST /update/check   现在检查一次（npm → GitHub）
 *   POST /update/config  { autoCheck } 自动检查开关
 * 只检查、提示，不替用户装新版本。
 */
import { pluginVersion } from './update-check.js';

const BODY_MAX = 4 * 1024;

export async function handleUpdateRoute({ method, path, req, send, readBody, sameOrigin, deps }) {
	if (!path.startsWith('/update/')) return false;
	const { updater, saveConfig } = deps;
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };
	const fallback = () => ({ ok: true, current: pluginVersion(), latest: null, hasUpdate: false, checkedAt: null, checking: false, autoCheck: true });

	if (method === 'GET' && path === '/update/state') {
		send(200, updater ? updater.state() : fallback());
		return true;
	}
	if (method === 'POST' && path === '/update/check') {
		if (!guard()) return true;
		if (!updater) { send(200, { ...fallback(), ok: false, error: '更新检查没起来' }); return true; }
		await updater.check();
		send(200, updater.state());
		return true;
	}
	if (method === 'POST' && path === '/update/config') {
		if (!guard()) return true;
		const raw = await readBody(req);
		if (raw.length > BODY_MAX) { send(413, { ok: false, error: '请求太大' }); return true; }
		const b = JSON.parse(raw || '{}');
		if (typeof b.autoCheck !== 'boolean') { send(400, { ok: false, error: 'autoCheck 要是 true / false' }); return true; }
		await saveConfig({ update: { autoCheck: b.autoCheck } });
		send(200, updater ? { ...updater.state(), autoCheck: b.autoCheck } : { ...fallback(), autoCheck: b.autoCheck });
		return true;
	}
	return false;
}
