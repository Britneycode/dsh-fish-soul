// 设置页脚本能被宿主加载前，先要过语法关。
//
// 2026-11-12 的真机事故：删 `client.douyin.js` 里一个死输入框时少留了一个括号，
// 宿主 bundle 能加载文件，但注册阶段直接没跑，设置页显示
// “loaded without registering”。这类错误 CI 的 99 个逻辑套件测不出来，
// 得靠最便宜的 `node --check` 守住。
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs = ['lib', 'lib/channels', 'lib/channels/vendor/douyin-bridge', 'lib/vendor'];
const files = dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).map((f) => join(dir, f)));

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
console.log('client-syntax ok');
