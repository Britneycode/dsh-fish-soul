/**
 * 静态检查：真实身份标识符（QQ 号 / 抖音 uid / B站 uid）不进仓库。
 *
 * 为什么要有这个测试：
 *   仓库是公开的。真实 QQ 号 / 抖音 uid 一旦提交，历史里永久留存、不可撤回。
 *   靠「提交前记得 git status 逐个看」在真机上证明是不够的 —— 已经漏过。
 *
 * 设计要点：
 *   黑名单只存**哈希**，不存真值 —— 否则这个脚本自己就是泄漏源。
 *   判据：精确匹配整个数字 token（哈希比对），不靠长度/模式猜 —— 零误报。
 *
 * 扫两处：
 *   ① 工作区副本（readFileSync）
 *   ② **索引里的版本**（git show :<path>）—— `git commit` 提交的是索引，不是工作区。
 *      「先 git add 密内容、再把工作区改干净」时，工作区是干净的、索引是密的，
 *      只扫工作区会放过这次真正要提交的内容。
 *   ⇒ 改了文件但还没 `git add` 时，检查会报「已暂存版本」命中 —— 那是**对的**：
 *      现在 `git commit` 提交的就是索引里那份。`git add` 同步后即恢复绿色。
 *
 * 只扫 git 视角的文件（ls-files + --others --exclude-standard）：
 *   gitignore 的本地文件（交接文档 / history/ / 探针脚本）不进仓库，不该被拦。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── 黑名单：只存 sha256 前 16 位，**不存真值**（存真值等于这个脚本自己就是泄漏源）。
// 加新值时算出哈希再贴进来：
//   node -e "console.log(require('crypto').createHash('sha256').update('要拦的值').digest('hex').slice(0,16))"
const BLOCKED = new Map([
	['ffd02f553314b7f4', '主人 QQ 号'],
	['5dd6571f762b5f39', '主人抖音 uid'],
	['72b75cbde2cc73ef', '机器人自己抖音 uid'],
	['f45897f1b90c4e18', '抖音 uid 的 Number 截断值（可反推真实 uid 前 16 位）'],
	['6cee4e6e3291b439', '机器人自己的 QQ 号（曾误填成主人）'],
	['2463c5745dfd7e12', '另一个真实 QQ 号'],
	['e1b94d6a65728571', '主人 B站 uid'],
	['be5b56a1d03f0159', '主人另一个 B站 uid']
]);

// ── baseline：已知存量（文件路径 → 该文件里允许出现的值哈希）。只减不增。
//    存量已清零（2026-11-17），这个机制保留着：将来若又有存量，加回文件即可，
//    不用临时改代码。没 baseline 文件时正常工作。
const BASELINE_FILE = join(import.meta.dirname, 'check-secrets.baseline.txt');
const baseline = new Map();  // file → Set<hash>
if (existsSync(BASELINE_FILE)) {
	for (const line of readFileSync(BASELINE_FILE, 'utf8').split('\n')) {
		const [file, hash] = line.trim().split('\t');
		if (!file || !hash) continue;
		if (!baseline.has(file)) baseline.set(file, new Set());
		baseline.get(file).add(hash);
	}
}

// ── 收集要扫的文件：**只扫会被提交的文件**。
// 判据是 git 的视角，不是文件系统的视角：
//   `git ls-files`                 = 已跟踪
//   `git ls-files -o --exclude-standard` = 未跟踪但没被忽略（即将提交的）
// gitignore 的本地文件（docs/handoff.md、history/、探针脚本）不进仓库 ⇒ 不扫、不拦、不占 baseline。
const SCAN_EXT = /\.(mjs|js|json|md|yml|yaml|txt|css|html|sh)$/;
function listRepoFiles() {
	// ⚠️ `-c core.quotePath=false` 不能省：git 默认把非 ASCII 路径转义成
	// "docs/\346\226\260...\346\241\243" 这种带引号的八进制串，末尾的引号会让
	// SCAN_EXT 判 false ⇒ **中文名文件被静默跳过**（仓库里本来就有中文名文件）。
	const res = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files'], { cwd: root, encoding: 'utf8' });
	const untracked = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
	if (res.status !== 0) throw new Error(`git ls-files 失败：${res.stderr || '未知'}`);
	if (untracked.status !== 0) throw new Error(`git ls-files --others 失败：${untracked.stderr || '未知'}`);
	const all = `${res.stdout}\n${untracked.stdout}`;
	return [...new Set(all.split('\n').map((x) => x.trim()).filter(Boolean))].filter((f) => SCAN_EXT.test(f));
}

const hits = [];      // 新增命中（要报错）
const known = [];     // 存量（baseline 覆盖）

/** 扫一段文本，返回命中位置。 */
function scanText(rel, src, label) {
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		// 只认「整个数字 token」：前后不是数字
		for (const m of lines[i].matchAll(/(?<!\d)(\d{8,20})(?!\d)/g)) {
			const hash = h(m[1]);
			if (!BLOCKED.has(hash)) continue;
			const where = `${rel}:${i + 1}${label}`;
			if (baseline.get(rel)?.has(hash)) { known.push(`${where}（${BLOCKED.get(hash)}，存量）`); continue; }
			hits.push(`${where} 出现${BLOCKED.get(hash)}`);
		}
	}
}

for (const rel of listRepoFiles()) {
	// ① 工作区副本
	let src;
	try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
	scanText(rel, src, '');

	// ② 索引里的版本（staged）——「先 git add 密内容，再把工作区改干净」时
	//    工作区是干净的、索引里是密的 ⇒ 只扫工作区会放过这次要提交的内容。
	const staged = spawnSync('git', ['show', `:${rel}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (staged.status === 0 && staged.stdout !== src) scanText(rel, staged.stdout, '（已暂存版本）');
}

assert.deepEqual(hits, [], `这些地方出现了真实身份标识符（仓库是公开的，提交后不可撤回）：\n${hits.join('\n')}\n\n改法：换成明显假的占位符（如 12345678 / 1234567890123456789）。`);
console.log(`✓ 真实身份脱敏检查：新增命中 0 处；存量 ${known.length} 处（baseline 覆盖，待清理）`);
