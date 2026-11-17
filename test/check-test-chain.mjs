/**
 * 自指检查：test/ 下的每个 .mjs 套件都必须在 package.json 的 test 脚本里。
 *
 * 为什么要有这个测试：
 *   parallel.mjs 从 package.json 的 test 脚本解析套件列表。
 *   忘加 = CI 根本不跑 = 白写。这个检查让「忘加」变成「CI 红」。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dirname;
const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf8'));
const script = pkg.scripts.test;
const inChain = new Set([...script.matchAll(/node\s+(test\/[\w.-]+\.mjs)/g)].map((m) => m[1]));

// 排除：
//   _ 开头 = 辅助文件（_tmp.mjs）
//   check-test-chain.mjs = 本检查自身
//   parallel.mjs = CI runner（不是测试）
//   bench-retrieval.mjs = 基准测试（不在 CI 里跑）
//   smoke-v05~v09 / smoke-persona / smoke-social = smoke.mjs 内部 import 的子套件（不单独进链）
const SKIP = new Set([
	'test/_tmp.mjs', 'test/check-test-chain.mjs', 'test/parallel.mjs', 'test/bench-retrieval.mjs',
	'test/smoke-v05.mjs', 'test/smoke-v06.mjs', 'test/smoke-v07.mjs', 'test/smoke-v08.mjs', 'test/smoke-v09.mjs',
	'test/smoke-persona.mjs', 'test/smoke-social.mjs'
]);
const onDisk = readdirSync(dir)
	.filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
	.map((f) => `test/${f}`)
	.filter((f) => !SKIP.has(f));

const missing = onDisk.filter((f) => !inChain.has(f));
assert.deepEqual(missing, [], `这些套件在磁盘上但没在 package.json test 链里（CI 不会跑）：\n${missing.join('\n')}`);

// 反向：链里引用的文件必须在磁盘上
const phantom = [...inChain].filter((f) => {
	try { readFileSync(join(dir, '..', f)); return false; } catch { return true; }
});
assert.deepEqual(phantom, [], `这些套件在 test 链里但磁盘上不存在：\n${phantom.join('\n')}`);

console.log(`✓ 测试链自指检查：${onDisk.length} 个套件全在链里，链里 ${inChain.size} 个全在磁盘上`);
