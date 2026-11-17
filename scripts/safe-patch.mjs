/**
 * 安全的文件补丁脚本：读文件 → 替换 → 写回 → 语法检查。
 *
 * 为什么要有这个：
 *   `node -e "..."` 里写正则会被 shell 吃掉反斜杠（\s → s、\d → d），
 *   导致「回退脚本写出来的代码是坏的，回退后测试仍然绿」——假安全。
 *   这个脚本把「改代码」变成「写文件再跑」，不会被 shell 转义坑。
 *
 * 用法：
 *   node scripts/safe-patch.mjs <文件> <旧字符串> <新字符串>
 *   node scripts/safe-patch.mjs --check <文件>   # 只检查语法不改
 *
 * 替换是精确匹配（不是正则），避免转义问题。
 * 替换后自动跑 node --check（如果是 .js/.mjs 文件）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [,, ...args] = process.argv;

if (args.length === 0 || args[0] === '--help') {
	console.log('用法：');
	console.log('  node scripts/safe-patch.mjs <文件> <旧字符串> <新字符串>');
	console.log('  node scripts/safe-patch.mjs --check <文件>');
	process.exit(0);
}

if (args[0] === '--check') {
	const file = args[1];
	if (!file) { console.error('缺文件名'); process.exit(1); }
	try {
		execSync(`node --check "${file}"`, { stdio: 'pipe' });
		console.log(`✓ ${file} 语法检查通过`);
	} catch {
		console.error(`✗ ${file} 语法检查失败`);
		process.exit(1);
	}
	process.exit(0);
}

const [file, oldStr, newStr] = args;
if (!file || oldStr === undefined || newStr === undefined) {
	console.error('用法：node scripts/safe-patch.mjs <文件> <旧字符串> <新字符串>');
	process.exit(1);
}

let src;
try { src = readFileSync(file, 'utf8'); } catch { console.error(`读不到 ${file}`); process.exit(1); }

const count = src.split(oldStr).length - 1;
if (count === 0) {
	console.error(`在 ${file} 里找不到旧字符串`);
	process.exit(1);
}
if (count > 1) {
	console.error(`在 ${file} 里找到 ${count} 处旧字符串，不够精确——请加更多上下文让它唯一`);
	process.exit(1);
}

const patched = src.replace(oldStr, newStr);
writeFileSync(file, patched, 'utf8');
console.log(`✓ ${file} 替换完成（1 处）`);

// 自动语法检查
if (file.endsWith('.js') || file.endsWith('.mjs')) {
	try {
		execSync(`node --check "${file}"`, { stdio: 'pipe' });
		console.log(`✓ ${file} 语法检查通过`);
	} catch {
		console.error(`✗ ${file} 替换后语法检查失败——请立即检查`);
		process.exit(1);
	}
}
