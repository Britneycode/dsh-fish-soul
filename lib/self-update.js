/**
 * self-update.js —— 设置页「一键更新」。
 *
 * 不自己 spawn pnpm。宿主的 plugin-manager 服务已经做了版本校验、兼容性检查、
 * 精确安装和失败回滚（updateBundle）。这里只负责：
 *  - 找到那个服务（ctx['plugin-manager']，cordis 代理按服务名解析）；
 *  - 把最新版本号交给它；
 *  - 把它的拒绝 / 失败原样转成面板能显示的一句话。
 *
 * link 安装（开发目录软链）由宿主自己拒绝：bundle.source 不是 registry 规格时
 * updateBundle 直接返回「不是从 registry 以自己的名字安装的」。这种安装一键更新
 * 等于覆盖开发目录，拒绝是对的，面板继续给「复制更新命令」。
 */

/** @param {object} ctx @returns {object | null} */
export function pluginManagerOf(ctx) {
	try {
		const v = ctx?.['plugin-manager'];
		return v && typeof v.updateBundle === 'function' ? v : null;
	} catch {
		return null;
	}
}

/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {{ latest?: string | null, current?: string }} deps.state 现有 UpdateChecker.state() 的结果
 * @param {string} [deps.packageName]
 * @returns {Promise<{ok: boolean, error?: string, from?: string, to?: string, restart?: boolean}>}
 */
export async function applyUpdate({ ctx, state, packageName = 'dsh-fish-soul' }) {
	const pm = pluginManagerOf(ctx);
	if (pm === null) return { ok: false, error: '宿主没有插件管理服务，用「复制更新命令」手动装' };
	const version = String(state?.latest ?? '').trim();
	if (version === '' || state?.hasUpdate !== true) return { ok: false, error: '没有可更新的版本，先检查更新' };
	let outcome;
	try {
		outcome = await pm.updateBundle(packageName, version);
	} catch (error) {
		return { ok: false, error: `更新失败：${error instanceof Error ? error.message : error}` };
	}
	const result = outcome?.result ?? {};
	if (result.application === 'failed' || result.application === 'cancelled' || typeof outcome === 'string') {
		const reason = result.error?.diagnostic ?? result.error?.code ?? (typeof outcome === 'string' ? outcome : '');
		const restored = outcome?.restore?.application === 'applied' ? '（已回滚到原版本）' : '';
		return { ok: false, error: `没更新成：${reason || '宿主拒绝了这次更新'}${restored}` };
	}
	return { ok: true, from: outcome?.from ?? state?.current ?? '', to: outcome?.to ?? version, restart: true };
}
