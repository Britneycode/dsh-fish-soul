#!/usr/bin/env node
/**
 * 标记审计：拆完提交后，逐条确认「每个 issue 的关键改动还在工作树里」。
 *
 * 为什么需要它（2026-11-21 #160/#161/#166/#167/#78 那一轮）：
 *   为了「一个 issue 一个提交」，用「checkout 回基线 → 按提交顺序逐块替换」重建文件。
 *   后一个提交的替换块是**基于 HEAD 写的**，不是基于前一个提交的结果 ——
 *   于是提交 C 把提交 B 在同一文件里的改动全冲掉了。
 *   **测试没抓住**（那时测试是红的，但红的原因不是这个），是手写的标记审计脚本抓到的。
 *
 * 用法：
 *   # 审计文件（JSON）：{ "标记名": ["文件里必须还存在的字符串", ...], ... }
 *   node scripts/marker-audit.mjs markers.json
 *
 *   # 临时查一条
 *   node scripts/marker-audit.mjs --marker "#166 候选通道名" --in lib/life.js --text "private:"
 *
 *   # 只看某个提交之后（默认看工作树）
 *   node scripts/marker-audit.mjs markers.json --ref HEAD~3
 *
 * 审计文件形状（markers.json，不进仓库，含真实业务细节时放本机）：
 *   {
 *     "#166 候选通道名": { "file": "lib/life.js", "contains": ["private:", "bili:"] },
 *     "#167 今天日期":   { "file": "lib/life.js", "contains": ["今天是"] },
 *     "#160 复合键":     { "file": "lib/gateway.js", "contains": ["ownMessagesByChannel"] }
 *   }
 *
 * 退出码：全部存在 → 0；有任何一条缺失 → 1（CI / 手动都能用）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');

/** 从工作树或某个 git ref 读文件内容。 */
function readSource(file, ref) {
	const abs = join(root, file);
	if (!ref) {
		if (!existsSync(abs)) return null;
		return readFileSync(abs, 'utf8');
	}
	const r = spawnSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' });
	if (r.status !== 0) return null;
	return r.stdout;
}

function parseArgs(argv) {
	const out = { file: '', ref: '', marker: '', in: '', text: '' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--ref') out.ref = argv[++i] ?? '';
		else if (a === '--marker') out.marker = argv[++i] ?? '';
		else if (a === '--in') out.in = argv[++i] ?? '';
		else if (a === '--text') out.text = argv[++i] ?? '';
		else if (!a.startsWith('--') && !out.file) out.file = a;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));

// ── 两种入口：审计文件 / 单条临时查 ──
let entries;
if (args.marker || args.in || args.text) {
	if (!args.in || !args.text) {
		console.error('单条模式需要 --in <file> --text <必须存在的字符串>（--marker 只是标签）');
		process.exit(2);
	}
	entries = { [args.marker || args.text]: { file: args.in, contains: [args.text] } };
} else if (args.file) {
	const p = resolve(args.file);
	if (!existsSync(p)) {
		console.error(`审计文件不存在：${p}`);
		process.exit(2);
	}
	entries = JSON.parse(readFileSync(p, 'utf8'));
} else {
	console.error('用法：node scripts/marker-audit.mjs <markers.json> [--ref <git-ref>]');
	console.error('     node scripts/marker-audit.mjs --marker <标签> --in <file> --text <字符串> [--ref <git-ref>]');
	process.exit(2);
}

// ── 逐条查 ──
const rows = [];
let missing = 0;
for (const [name, spec] of Object.entries(entries)) {
	const file = String(spec?.file ?? '').trim();
	const needles = Array.isArray(spec?.contains) ? spec.contains.map(String) : [];
	if (file === '' || needles.length === 0) {
		rows.push({ name, file, ok: false, why: '配置不完整（缺 file 或 contains）' });
		missing++;
		continue;
	}
	const src = readSource(file, args.ref);
	if (src === null) {
		rows.push({ name, file, ok: false, why: `文件读不到${args.ref ? `（ref ${args.ref}）` : ''}` });
		missing++;
		continue;
	}
	const gone = needles.filter((n) => !src.includes(n));
	if (gone.length > 0) {
		rows.push({ name, file, ok: false, why: `缺：${gone.map((g) => JSON.stringify(g)).join('、')}` });
		missing++;
	} else {
		rows.push({ name, file, ok: true, why: `${needles.length} 处都在` });
	}
}

// ── 报告 ──
const where = args.ref ? `ref ${args.ref}` : '工作树';
const w = Math.max(...rows.map((r) => r.name.length), 10);
console.log(`标记审计（${where}）：${rows.length} 条\n`);
for (const r of rows) {
	console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(w)}  ${r.file}  ${r.why}`);
}
if (missing > 0) {
	console.log(`\n${missing} 条标记缺失 —— 很可能是后一个提交把前一个提交的改动冲掉了。`);
	console.log('排查：git log -p -- <file> 看那个文件被哪些提交改过，逐个 checkout 比对。');
	process.exit(1);
}
console.log('\n全部标记都在。');
