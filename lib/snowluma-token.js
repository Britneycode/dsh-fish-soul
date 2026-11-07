/**
 * snowluma-token.js —— 从 SnowLuma 自己的配置里把「正向 WS 的访问令牌」读出来。
 *
 * 为什么要有它（2026-11-07 真机踩到）：SnowLuma 每次更新 / 重建配置都会**重新生成**
 * 访问令牌，而插件这边是手填的。结果就是「SnowLuma 明明活着、QQ 消息照收，插件却一直
 * 连不上」，界面上还只显示「连接中」（那是另一个 bug，见 snowluma.js 的 closeReason）。
 * 让插件自己去找那把钥匙，比让人每次手动同步靠谱。
 *
 * 🔴 只读，不写：绝不改 SnowLuma 的任何文件。
 * 🔴 令牌值不进日志、不进状态接口 —— 调用方只拿它去连 WS。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** SnowLuma 的安装目录可能在哪（从最可信的指针往下退）。 */
function candidateRoots(env = process.env) {
	const out = [];
	const push = (p) => { const v = String(p ?? '').trim(); if (v !== '' && !out.includes(v)) out.push(v); };
	// ① 显式配置（用户/别的插件指过路）
	push(env.FISH_SOUL_SNOWLUMA_ROOT);
	// ② snowluma-control 插件写的运行记录（里面 root 是它启动的 SnowLuma 目录）
	try {
		const home = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
		const rec = join(home, 'snowluma-control.json');
		if (existsSync(rec)) {
			const j = JSON.parse(readFileSync(rec, 'utf8'));
			push(j?.root);
		}
	} catch { /* 读不到就算了 */ }
	// ③ 跟本插件同级（两个插件常挂在同一个父目录下）
	try {
		const proj = join(import.meta.dirname, '..', '..');
		push(join(proj, 'SnowLuma'));
	} catch { /* 忽略 */ }
	return out;
}

/** 这个目录看起来是不是 SnowLuma 的安装目录。 */
function looksLikeSnowLuma(dir) {
	try {
		return existsSync(join(dir, 'index.mjs')) && existsSync(join(dir, 'config'));
	} catch { return false; }
}

/**
 * 从 SnowLuma 的 onebot 配置里取正向 WS 的访问令牌（onebot_<uin>.json → networks.wsServers[]）。
 * @param {string} file
 * @param {{port?: number}} [opts] 指定端口（默认取 3001 那条，取不到就用第一条带令牌的）
 * @returns {string} 令牌；找不到返回 ''
 */
export function tokenFromOnebotConfig(file, { port = 3001 } = {}) {
	let j;
	try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return ''; }
	const rows = j?.networks?.wsServers;
	if (!Array.isArray(rows) || rows.length === 0) return '';
	const want = rows.find((r) => Number(r?.port) === Number(port) && typeof r?.accessToken === 'string' && r.accessToken !== '');
	const any = rows.find((r) => typeof r?.accessToken === 'string' && r.accessToken !== '');
	return String((want ?? any)?.accessToken ?? '');
}

/**
 * 找 SnowLuma 的正向 WS 的访问令牌。
 * @param {{env?: NodeJS.ProcessEnv, port?: number, roots?: string[]}} [opts]
 * @returns {{token: string, from: string}} token 为空表示没找到（from 仍给出线索）
 */
export function findSnowlumaToken({ env = process.env, port = 3001, roots } = {}) {
	for (const root of roots ?? candidateRoots(env)) {
		if (!looksLikeSnowLuma(root)) continue;
		const dir = join(root, 'config');
		let files = [];
		try {
			files = readdirSync(dir).filter((f) => /^onebot.*\.json$/i.test(f)).map((f) => join(dir, f));
		} catch { continue; }
		// 新的排前面（SnowLuma 重建配置时是覆盖写）
		files.sort((a, b) => { try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; } });
		for (const f of files) {
			const t = tokenFromOnebotConfig(f, { port });
			if (t !== '') return { token: t, from: f };
		}
	}
	return { token: '', from: '' };
}
