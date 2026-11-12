#!/usr/bin/env node
/**
 * check-rings.mjs —— 发版后校验四环：npm latest 的版本和 gitHead 是不是本次提交。
 *
 * 为什么要有这个脚本（2026-11-12）：
 *   CI 里那段 shell 连续三次 `free(): invalid next size (normal)` + exit 134
 *   （glibc 堆损坏）。病根是拿 registry 的**整包文档**（265KB）反复解析。
 *   现在只用两个小端点（各约 6KB）：
 *     - /<版本>   单版本文档：这个版本发出去没有、gitHead 对不对
 *     - /latest   latest 标签指向哪个版本
 *
 * 两段式等待（0.15.42 真机教训：单版本 6 分钟内就有了，latest 标签还没跟上）：
 *   ① 先等单版本端点出现 —— 它同步最快，能证明 npm publish 真的成功了；
 *   ② 再等 latest 标签指到这个版本 —— 这一步慢是正常的（CDN 缓存）。
 *   分开等的好处：失败时说得出是「包没发出去」还是「标签还没跟上」。
 *
 * 用法：
 *   node scripts/check-rings.mjs                  # 用 package.json 版本 + 本地 HEAD
 *   node scripts/check-rings.mjs 0.15.41 <sha>    # 指定版本和提交
 *   node scripts/check-rings.mjs --wait 900       # 每段最多等多少秒（默认 900）
 *   node scripts/check-rings.mjs --base <url>     # 换 registry 根地址（测试用）
 *
 * 退出码：0 = 对齐；1 = 没对齐（并说清是哪一环）。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = 'https://registry.npmjs.org/dsh-fish-soul';

/** 解析参数。 */
function parseArgs(argv) {
	const out = { wait: 900, base: BASE, ver: '', sha: '' };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--wait') { out.wait = Number(argv[++i]) || 900; continue; }
		if (a === '--base') { out.base = String(argv[++i] ?? BASE); continue; }
		rest.push(a);
	}
	[out.ver = '', out.sha = ''] = rest;
	return out;
}

/** 拉一个 JSON 端点，返回对象或 null（网络/解析失败都算 null）。 */
async function getJson(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询直到 getter() 返回非 null 或超时。返回 { value, elapsed, timedOut }。
 * 退避 5 → 10 → 20 → 30 封顶。
 */
async function pollUntil(getter, waitSec, log, label, sleepFn) {
	let elapsed = 0;
	let step = 5;
	for (;;) {
		const value = await getter();
		if (value !== null) return { value, elapsed, timedOut: false };
		if (elapsed >= waitSec) return { value: null, elapsed, timedOut: true };
		log(`${label}还没好，等 ${step}s…（已等 ${elapsed}s）`);
		await sleepFn(step * 1000);
		elapsed += step;
		step = Math.min(30, step * 2);
	}
}

export async function checkRings({
	ver, sha, base = BASE, waitSec = 900, log = console.log,
	getJsonFn = getJson, sleepFn = sleep
} = {}) {
	// ① 单版本端点：包真的发出去了吗、gitHead 对不对
	const verUrl = `${base}/${encodeURIComponent(ver)}`;
	const first = await pollUntil(() => getJsonFn(verUrl), waitSec, log, `registry 上的 ${ver} `, sleepFn);
	if (first.value === null) {
		return {
			ok: false, ring: 'npm-version',
			reason: `等了 ${first.elapsed}s，registry 上还是没有 ${ver} 这个版本 —— npm publish 可能没成功`
		};
	}
	const gotHead = String(first.value.gitHead ?? '');
	if (gotHead !== sha) {
		return {
			ok: false, ring: 'gitHead',
			reason: `registry 上 ${ver} 的 gitHead 是「${gotHead || '空'}」，不是 ${sha} —— 版本发出去了但提交不对`
		};
	}

	// ② latest 标签：指到这个版本了吗（CDN 缓存，比单版本慢，慢几分钟是正常的）
	const latestUrl = `${base}/latest`;
	const second = await pollUntil(async () => {
		const j = await getJsonFn(latestUrl);
		return j !== null && String(j.version ?? '') === ver ? j : null;
	}, waitSec, log, `latest 标签（当前应该指到 ${ver}）`, sleepFn);
	if (second.value === null) {
		const cur = await getJsonFn(latestUrl);
		return {
			ok: false, ring: 'npm-latest',
			reason: `等了 ${second.elapsed}s，latest 标签还是「${cur === null ? '读不到' : String(cur.version ?? '')}」—— 包已经发出去了，只是标签没跟上（CDN 缓存，过几分钟会自己好）`
		};
	}

	return { ok: true, version: ver, gitHead: gotHead };
}

// 作为脚本直接跑时（用 pathToFileURL 比手拼 file:// 稳：Windows 盘符要三个斜杠）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = parseArgs(process.argv.slice(2));
	const ver = args.ver || JSON.parse(readFileSync('package.json', 'utf8')).version;
	// 默认比对 **tag 指向的提交**，不是本地 HEAD。
	// 发版后经常再补一个纯文档提交（CHANGELOG 被 shell 吃掉代码标记那种），
	// 那时 HEAD 比 tag 晚一个提交，拿 HEAD 比会误报「gitHead 不对」。
	// tag 可能在远程而不在本地（CI 打的），所以先看本地再看 origin。
	// 都没有才退回 HEAD —— 那种情况下面本来就会报 npm-version。
	const tagSha = () => {
		for (const ref of [`v${ver}`, `refs/tags/v${ver}`]) {
			try { return execFileSync('git', ['rev-list', '-n', '1', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* 试下一个 */ }
		}
		try {
			// 远程 tag：`ls-remote` 输出是 "<sha>\trefs/tags/vX.Y.Z"
			const out = execFileSync('git', ['ls-remote', 'origin', `refs/tags/v${ver}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
			const sha = out.split(/\s+/)[0];
			if (/^[0-9a-f]{40}$/.test(sha)) return sha;
		} catch { /* 没网/没远程 */ }
		return '';
	};
	const sha = args.sha || tagSha() || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	console.log(`校验 v${ver} @ ${sha.slice(0, 7)}（每段最多等 ${args.wait}s）`);
	const r = await checkRings({ ver, sha, base: args.base, waitSec: args.wait });
	if (r.ok) {
		console.log(`四环对齐：main = tag v${r.version} = Release = npm ${r.version} (${r.gitHead})`);
	} else {
		console.error(`没对齐（卡在 ${r.ring}）：${r.reason}`);
		console.error(`手动查：curl -s ${args.base}/${ver} && echo && curl -s ${args.base}/latest`);
		process.exit(1);
	}
}
