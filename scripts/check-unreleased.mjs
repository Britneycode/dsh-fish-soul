#!/usr/bin/env node
/**
 * check-unreleased.mjs —— 盘点「本地还有什么没发」。
 *
 * 为什么要有这个脚本（2026-11-27 真机踩过）：
 *   发版前 `git log origin/main..main` 干净、`git cherry` 一堆 `+`，
 *   结果合的时候才发现**内容早就在 main 里**（行号变了所以 cherry 报 +），
 *   白合一遍还引入冲突。
 *
 * 判据（两条同时成立才算「真未进」）：
 *   ① `git cherry -v origin/main <branch>` 有 `+`（patch 不等价）；
 *   ② 该提交的**关键标识符**（新增的函数/常量名、新增文件名）在 main 上找不到。
 *
 * ⚠️ 「找不到」对**文件**要区分两种情况：
 *    现在还挂在 main 树上 ⇒ 进过；
 *    曾经出现在 main 的历史里、之后被删掉 ⇒ **也进过**（比如先加后删的临时 / 清理对象）。
 *    只按「现在在不在树上」判，会把「已进 main 且已删除」误报成「未进」。
 *
 * ⚠️ 本脚本只是**筛查**，不是最终判据。它把分支和 origin/main 比，
 *    但对「分支是旧快照、内容落后」这种情况，它的 `+` 判据仍会命中 ——
 *    真正的确认要按文件做 `git diff origin/main <branch> -- <path>` 看差异方向
 *    （是分支多出来的，还是分支缺 main 的）。
 *
 * 用法：
 *   node scripts/check-unreleased.mjs                # 扫所有本地分支
 *   node scripts/check-unreleased.mjs <branch>       # 只扫一个分支
 *
 * 只读：不写文件、不改分支、不 push。
 */
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const tryGit = (...args) => {
	try { return git(...args); } catch { return ''; }
};

const main = 'origin/main';
if (tryGit('rev-parse', '--verify', main) === '') {
	console.error(`找不到 ${main}，先 git fetch origin main`);
	process.exit(2);
}

const branches = process.argv[2]
	? [process.argv[2]]
	: git('for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean);

/** 一个提交里「新增的关键标识符」：函数/常量名 + 新增文件名。 */
function identifiersOf(sha) {
	const out = new Set();
	// 新增文件名（A 状态）
	for (const line of tryGit('diff-tree', '--no-commit-id', '--name-status', '-r', sha).split('\n')) {
		const m = /^A\s+(.+)$/.exec(line);
		if (m) out.add(`file:${m[1]}`);
	}
	// 新增的函数/常量/方法名
	const diff = tryGit('show', '--format=', '--unified=0', sha);
	for (const line of diff.split('\n')) {
		if (!line.startsWith('+') || line.startsWith('+++')) continue;
		for (const re of [
			/^\+\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
			/^\+\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/,
			/^\+\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
			/^\+\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/
		]) {
			const m = re.exec(line);
			if (m) { out.add(`sym:${m[1]}`); break; }
		}
	}
	return [...out];
}

/** 标识符在 main 上是否存在。 */
function existsOnMain(id) {
	if (id.startsWith('file:')) {
		const path = id.slice(5);
		// 现在还挂在 main 的树上 ⇒ 肯定进过。
		try { execFileSync('git', ['cat-file', '-e', `${main}:${path}`], { stdio: 'pipe' }); return true; } catch { /* 看历史 */ }
		// 🔴 关键：**进过 main 之后又被删掉**的文件不能算「没进」。
		//    真机踩过：`test/check-secrets.baseline.txt` 由 ea75f7e 新增、后被故意删除
		//    （存量清零），按「现在不在树上」判就成了「真未进 main」的活跃 bug —— 假阳性。
		//    判据：main 的历史里有过这个文件的任何提交。
		return tryGit('log', '--format=%H', '-1', main, '--', path) !== '';
	}
	return tryGit('grep', '-l', id.slice(4), `${main}`, '--', 'lib/', 'test/', 'scripts/') !== '';
}

const rows = [];
for (const b of branches) {
	if (b === 'main') continue;
	const n = Number(tryGit('rev-list', '--count', `${main}..${b}`) || 0);
	if (n === 0) continue;
	const cherry = tryGit('cherry', main, b).split('\n').filter(Boolean);
	const plus = cherry.filter((l) => l.startsWith('+'));
	if (plus.length === 0) { rows.push({ branch: b, commits: n, verdict: 'merged', detail: 'cherry 全为 -，patch 等价' }); continue; }

	// 逐个 + 提交验证标识符
	let real = 0;
	const evidence = [];
	for (const line of plus) {
		const sha = line.slice(2).split(' ')[0];
		const ids = identifiersOf(sha);
		if (ids.length === 0) { real++; evidence.push(`${sha.slice(0, 7)} 无新标识符，按未进算`); continue; }
		const missing = ids.filter((id) => !existsOnMain(id));
		if (missing.length > 0) {
			real++;
			evidence.push(`${sha.slice(0, 7)} 缺 ${missing.slice(0, 3).map((x) => x.replace(/^(file|sym):/, '')).join(', ')}`);
		}
	}
	if (real === 0) rows.push({ branch: b, commits: n, verdict: 'content-in-main', detail: '标识符全在 main（行号变了）' });
	else rows.push({ branch: b, commits: n, verdict: 'unreleased', detail: evidence.join('；') });
}

const colors = { merged: '✓', 'content-in-main': '≈', unreleased: '✗' };
for (const r of rows) {
	console.log(`${colors[r.verdict]} ${r.branch}  (${r.commits} commits)`);
	console.log(`   ${r.detail}`);
}
const bad = rows.filter((r) => r.verdict === 'unreleased');
console.log(`\n${bad.length} 个分支有真未进 main 的内容`);
process.exit(0);
