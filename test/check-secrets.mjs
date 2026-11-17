/**
 * 静态检查：真实身份标识符（QQ 号 / 抖音 uid）不进仓库。
 *
 * 为什么要有这个测试：
 *   仓库是公开的。真实 QQ 号 / 抖音 uid 一旦提交，历史里永久留存、不可撤回。
 *   靠「提交前记得 git status 逐个看」在真机上证明是不够的 —— 已经漏过（见 baseline）。
 *
 * 设计要点：
 *   黑名单只存**哈希**，不存真值 —— 否则这个脚本自己就是泄漏源。
 *   baseline 记「已知存量」的文件+哈希，让存量可见、新增被拦，
 *   不用一次性改一堆测试夹具（存量清理单独立项）。
 *
 * 判据：精确匹配整个数字 token（哈希比对），不靠长度/模式猜 —— 零误报。
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
	['f45897f1b90c4e18', '抖音 uid 的 Number 截断值（可反推真实 uid 前 16 位）']
]);

// ── baseline：已知存量（文件路径 → 该文件里允许出现的值哈希）。只减不增。
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
	const res = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
	const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
	if (res.status !== 0) throw new Error(`git ls-files 失败：${res.stderr || '未知'}`);
	const all = `${res.stdout}\n${untracked.stdout}`;
	return [...new Set(all.split('\n').map((x) => x.trim()).filter(Boolean))].filter((f) => SCAN_EXT.test(f));
}

const hits = [];      // 新增命中（要报错）
const known = [];     // 存量（baseline 覆盖）
for (const rel of listRepoFiles()) {
	const full = join(root, rel);
	let src;
	try { src = readFileSync(full, 'utf8'); } catch { continue; }
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		// 只认「整个数字 token」：前后不是数字
		for (const m of lines[i].matchAll(/(?<!\d)(\d{8,20})(?!\d)/g)) {
			const hash = h(m[1]);
			if (!BLOCKED.has(hash)) continue;
			const where = `${rel}:${i + 1}`;
			if (baseline.get(rel)?.has(hash)) { known.push(`${where}（${BLOCKED.get(hash)}，存量）`); continue; }
			hits.push(`${where} 出现${BLOCKED.get(hash)}`);
		}
	}
}

assert.deepEqual(hits, [], `这些地方出现了真实身份标识符（仓库是公开的，提交后不可撤回）：\n${hits.join('\n')}\n\n改法：换成明显假的占位符（如 12345678 / 1234567890123456789）。`);
console.log(`✓ 真实身份脱敏检查：新增命中 0 处；存量 ${known.length} 处（baseline 覆盖，待清理）`);
