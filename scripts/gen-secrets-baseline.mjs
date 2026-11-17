/**
 * 生成 test/check-secrets.baseline.txt：把仓库里**现有**的真实身份标识符记成 baseline。
 *
 * 只在「确认存量、准备单独立项清理」时跑一次。之后 baseline 只减不增
 * （check-secrets.mjs 会拦新增命中）。
 *
 * 用法：node scripts/gen-secrets-baseline.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = join(import.meta.dirname, '..');
const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// 与 test/check-secrets.mjs 同一份黑名单（只存哈希，不存真值）
const BLOCKED = new Set([
	'ffd02f553314b7f4', '5dd6571f762b5f39', '72b75cbde2cc73ef', 'f45897f1b90c4e18'
]);

const SKIP_DIRS = new Set(['node_modules', '.git', '.alma-snapshots', 'probe-scratch', 'probe-group', 'probe-gid', 'probe-group-uid', 'probe-webp-tmp', '.benchmark']);
const SCAN_EXT = /\.(mjs|js|json|md|yml|yaml|txt|css|html|sh)$/;
function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const full = join(dir, name);
		let st;
		try { st = statSync(full); } catch { continue; }
		if (st.isDirectory()) walk(full, out);
		else if (SCAN_EXT.test(name)) out.push(full);
	}
	return out;
}

const rows = new Set();
for (const full of walk(root)) {
	const rel = relative(root, full).split(sep).join('/');
	// 生成器与检查脚本自身跳开：它们只存哈希，不该出现在 baseline 里
	if (rel === 'test/check-secrets.mjs' || rel === 'scripts/gen-secrets-baseline.mjs') continue;
	let src;
	try { src = readFileSync(full, 'utf8'); } catch { continue; }
	for (const line of src.split('\n')) {
		for (const m of line.matchAll(/(?<!\d)(\d{8,20})(?!\d)/g)) {
			if (BLOCKED.has(h(m[1]))) rows.add(`${rel}\t${h(m[1])}`);
		}
	}
}
const sorted = [...rows].sort();
writeFileSync(join(root, 'test', 'check-secrets.baseline.txt'), sorted.join('\n') + '\n');
console.log(`baseline 写入 ${sorted.length} 行`);
