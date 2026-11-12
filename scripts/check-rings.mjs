#!/usr/bin/env node
/**
 * check-rings.mjs —— 发版后校验四环：npm latest 的版本和 gitHead 是不是本次提交。
 *
 * 为什么要有这个脚本（2026-11-12）：
 *   CI 里那段 shell 连续三次 `free(): invalid next size (normal)` + exit 134
 *   （glibc 堆损坏）。病根是拿 registry 的**整包文档**（265KB）反复解析。
 *   现在只用 `/latest` 端点（约 6KB，一次带 version + gitHead 两个字段）。
 *
 * 用法：
 *   node scripts/check-rings.mjs                  # 用 package.json 版本 + 本地 HEAD
 *   node scripts/check-rings.mjs 0.15.41 <sha>    # 指定版本和提交
 *   node scripts/check-rings.mjs --wait 300       # 最多等 300 秒（默认 300）
 *   node scripts/check-rings.mjs --url <url>      # 换端点（测试用）
 *
 * 退出码：0 = 对齐；1 = 没对齐（并说清是哪一环）。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/dsh-fish-soul/latest';

/** 解析参数。 */
function parseArgs(argv) {
	const out = { wait: 300, url: REGISTRY, ver: '', sha: '' };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--wait') { out.wait = Number(argv[++i]) || 300; continue; }
		if (a === '--url') { out.url = String(argv[++i] ?? REGISTRY); continue; }
		rest.push(a);
	}
	[out.ver = '', out.sha = ''] = rest;
	return out;
}

/** 拉一次 /latest，返回 { version, gitHead } 或 null（网络/解析失败都算 null）。 */
async function probe(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
		if (!res.ok) return null;
		const j = await res.json();
		return { version: String(j.version ?? ''), gitHead: String(j.gitHead ?? '') };
	} catch {
		return null;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function checkRings({ ver, sha, url = REGISTRY, waitSec = 300, log = console.log, probeFn = probe, sleepFn = sleep } = {}) {
	let elapsed = 0;
	let step = 5;
	let last = null;
	while (elapsed <= waitSec) {
		last = await probeFn(url);
		if (last !== null && last.version === ver) break;
		if (elapsed >= waitSec) break;
		log(`registry latest 还是「${last === null ? '读不到' : last.version}」，等 ${step}s…（已等 ${elapsed}s）`);
		await sleepFn(step * 1000);
		elapsed += step;
		step = Math.min(30, step * 2);
	}
	if (last === null) return { ok: false, ring: 'registry', reason: 'registry 读不到（网络或端点异常）' };
	if (last.version !== ver) return { ok: false, ring: 'npm-latest', reason: `npm latest 还是 ${last.version || '读不到'}，不是 ${ver}` };
	if (last.gitHead !== sha) return { ok: false, ring: 'gitHead', reason: `npm 的 gitHead 是 ${last.gitHead || '读不到'}，不是 ${sha}` };
	return { ok: true, version: last.version, gitHead: last.gitHead };
}

// 作为脚本直接跑时（用 pathToFileURL 比手拼 file:// 稳：Windows 盘符要三个斜杠）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = parseArgs(process.argv.slice(2));
	const ver = args.ver || JSON.parse(readFileSync('package.json', 'utf8')).version;
	const sha = args.sha || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	console.log(`校验 v${ver} @ ${sha.slice(0, 7)}（最多等 ${args.wait}s）`);
	const r = await checkRings({ ver, sha, url: args.url, waitSec: args.wait });
	if (r.ok) {
		console.log(`四环对齐：main = tag v${r.version} = Release = npm ${r.version} (${r.gitHead})`);
	} else {
		console.error(`没对齐（卡在 ${r.ring}）：${r.reason}`);
		console.error('手动查：curl -s https://registry.npmjs.org/dsh-fish-soul/latest');
		process.exit(1);
	}
}
