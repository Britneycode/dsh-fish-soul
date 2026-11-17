/**
 * 工作区路径守卫：sameWorkspace / knownWorkspace。
 *
 * 为什么抽出来：
 *   routes-v07.js 的 _stickers 路由靠这两个函数挡「随便指个目录来读改删文件」。
 *   抽成独立模块让其他需要校验工作区路径的路由直接 import，
 *   让「不校验」变成「import 不到」——设计消除，不靠记得调。
 *
 * 参照：D40（/stickers 写路由加 knownWorkspace 白名单）。
 */
import { resolve } from 'node:path';

/** 同一个工作区？路径写法可能不一样（相对 / 绝对），比绝对路径。 */
export function sameWorkspace(a, b) {
	const x = String(a ?? ''); const y = String(b ?? '');
	if (x === '' || y === '') return false;
	try { return resolve(x) === resolve(y); } catch { return x === y; }
}

/**
 * ws 得是认得的工作区（当前工作区 / 收藏记录里出现过的），不能随便指个目录来读、改、删文件。
 * @param {string} p 待校验的工作区路径
 * @param {{ workspacePath?: () => string }} gateway 网关（拿当前工作区）
 * @param {{ collected?: () => Array<{workspacePath: string}> }} stickers 表情包（拿历史工作区）
 */
export function knownWorkspace(p, gateway, stickers) {
	const ws = String(p ?? '');
	if (ws === '') return false;
	if (sameWorkspace(ws, gateway?.workspacePath?.() ?? '')) return true;
	return (stickers?.collected() ?? []).some((x) => sameWorkspace(x.workspacePath, ws));
}
