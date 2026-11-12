// 设置页脚本能被宿主加载前，先要过两关：
//   ① 语法（node --check）
//   ② 模块注册形状（client*.js 必须走 window.__ModuleLoader__.load）
//
// 两起真机事故（2026-11-12 同一天踩了两次）：
//   - 删 `client.douyin.js` 里一个死输入框时少留了一个括号 → 文件语法错，
//     宿主 bundle 能加载但注册阶段没跑，设置页显示 "loaded without registering"；
//   - 新写的 `client.diag.js` 写成裸 ES module（没包 __ModuleLoader__.load，
//     且用了 `React` 而不是 `require("react")`）→ 同样的报错。
//
// 共同点：CI 的逻辑套件一个都测不出来，宿主只有在真机上打开那一页才报。
// 这个套件用最便宜的办法把它们拦在发版之前。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs = ['lib', 'lib/channels', 'lib/channels/vendor/douyin-bridge', 'lib/vendor'];
const files = dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).map((f) => join(dir, f)));

// ① 语法
let failed = null;
for (const file of files) {
	const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
	if (r.status !== 0) {
		failed = `${file}: ${r.stderr.split('\n').slice(0, 3).join(' | ')}`;
		break;
	}
}
assert.equal(failed, null, failed ?? undefined);
console.log(`✓ ${files.length} 个 lib 脚本语法检查通过`);

// ② 分块页的注册形状
// `client.js` 是主面板（入口，由宿主按插件主文件加载），其余 client.*.js 都是
// require.async 按需加载的分块 —— 它们**必须**自己注册，否则宿主只加载不认领。
const chunks = readdirSync('lib').filter((f) => /^client\..+\.js$/.test(f));
assert.ok(chunks.length > 0, '至少要有一个分块页');
for (const file of chunks) {
	const src = readFileSync(join('lib', file), 'utf8');
	assert.match(src, /window\.__ModuleLoader__\.load\(\{/, `${file} 必须用 window.__ModuleLoader__.load 注册（否则宿主报 loaded without registering）`);
	assert.match(src, new RegExp(`chunk:\\s*"${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), `${file} 的 chunk 名要和文件名一致`);
	assert.match(src, /factory:\s*\(require\)\s*=>/, `${file} 要有 factory(require)`);
	assert.match(src, /require\("react"\)/, `${file} 要从 factory 的 require 里拿 react（别用全局 React，宿主不提供）`);
	assert.doesNotMatch(src, /\bReact\./, `${file} 不能用大写 React —— 宿主只提供 require("react")`);
	assert.match(src, /return\s*\{[^}]*Pane/, `${file} 要导出至少一个 *Pane`);
}
console.log(`✓ ${chunks.length} 个分块页的注册形状正确（__ModuleLoader__ + require("react") + 导出 Pane）`);

console.log('client-syntax ok');
