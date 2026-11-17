/**
 * 静态检查：client 半边（client*.js）不能 import 宿主侧模块。
 *
 * 为什么要有这个测试：
 *   client 是 React external，由宿主在浏览器里加载。import db.js / gateway.js
 *   等于把 SQLite / 网络层拉进浏览器——面板直接崩。
 *   只能 import React（宿主给的）和相对路径的 css。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'lib');
const files = readdirSync(dir).filter((f) => /^client(\..+)?\.js$/.test(f));

// client 允许 import 的模块（白名单）
const ALLOWED = new Set(['react', './panel.css', '@deepseek-ai/dsh-client-ui-primitives']);
// 相对路径的 client 内部互导也允许（client.js 的 ChunkTab 拉 client.douyin.js 等）
const ALLOWED_PREFIX = './client.';

const bad = [];
for (const f of files) {
	const src = readFileSync(join(dir, f), 'utf8');
	const imports = [...src.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
	// require 也查（client.js 用 require.async 拉分块）
	const requires = [...src.matchAll(/require(?:\.async)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
	for (const mod of [...imports, ...requires]) {
		if (ALLOWED.has(mod)) continue;
		if (mod.startsWith(ALLOWED_PREFIX)) continue;
		bad.push(`${f}: import/require '${mod}'`);
	}
}

assert.deepEqual(bad, [], `client 半边 import 了宿主侧模块（面板会崩）：\n${bad.join('\n')}`);
console.log(`✓ client import 边界检查：${files.length} 个 client 文件，全部只 import React / css / client 内部`);
