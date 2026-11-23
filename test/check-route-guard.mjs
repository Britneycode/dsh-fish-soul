/**
 * 静态检查：写操作路由（POST/PUT/DELETE/PATCH）必须有 sameOrigin 校验。
 *
 * 为什么要有这个测试：
 *   面板路由挂在宿主的 /api/plugins/fish-soul/* 前缀下，任何网页都能发起写请求过来。
 *   sameOrigin 是唯一的 CSRF 防线。漏一个 = 任何网页都能改你的配置 / 删你的记忆。
 *
 * 两种合法模式：
 *   A. 文件级总闸：文件顶部有 if (!sameOrigin(req)) { send(403); return true; }
 *      （routes-douyin.js 就是这种——所有写请求先过总闸，后面不用再逐个加）
 *   B. 逐路由校验：每个写路由（POST/PUT/DELETE/PATCH）if 块里有 sameOrigin(req) 或 guard()
 *      （routes.js / routes-soul.js / routes-v07.js 等是这种）
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'lib');
const files = readdirSync(dir).filter((f) => /^routes(-[\w]+)?\.js$/.test(f));

const holes = [];

for (const f of files) {
	const src = readFileSync(join(dir, f), 'utf8');

	// 模式 A：文件级总闸（在函数开头、第一个路由判断之前就有 sameOrigin）
	// 特征：sameOrigin 出现在文件前 80 行内，且后面跟着 send(403
	const earlyLines = src.split('\n').slice(0, 80).join('\n');
	if (earlyLines.includes('sameOrigin') && earlyLines.includes('403')) {
		// 有总闸的文件不用逐路由检查
		continue;
	}

	// 模式 B：逐路由检查
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// 只匹配最外层的写路由判断（缩进 ≤4 个 tab 的 if）
		// 排除嵌套子分支（如 if (path === '/bili/post-now') { 在外层写路由块内部）
		const indent = line.match(/^(\t*)/)?.[1]?.length ?? 0;
		if (indent > 4) continue; // 嵌套太深的不是最外层路由

		const isWrite = /method\s*===\s*'(?:POST|PUT|DELETE|PATCH)'/.test(line) || /\bpost\b/.test(line);
		const hasPath = /path\s*===\s*'|path\.startsWith\s*\(|path\.match\s*\(|\/[^/\s]+\/\.test\s*\(\s*path\s*\)/.test(line);
		if (!isWrite || !hasPath) continue;
		if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

		// 从这个 if 开始往下扫 5 行，找 sameOrigin 或 guard
		const window = lines.slice(i, i + 6).join('\n');
		if (!window.includes('sameOrigin') && !window.includes('guard()')) {
			holes.push(`${f}:${i + 1} ${line.trim().slice(0, 80)}`);
		}
	}
}

assert.deepEqual(holes, [], `这些写路由（POST/PUT/DELETE/PATCH）没有 sameOrigin/guard 校验（CSRF 洞）：\n${holes.join('\n')}`);
console.log(`✓ 写路由 sameOrigin 检查：${files.length} 个路由文件，全部写路由（POST/PUT/DELETE/PATCH）有校验`);
