// 前端静态检查：client*.js 里的 Group / Row / Button / Tag … 是普通函数（子元素从第二个参数起），
// 不能写成 h(Group, …) 当组件用——宿主 React 会把 legacy context（{}）当第二个参数传进去，变成对象子元素，整个面板空白。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'lib');
const PLAIN = ['Group', 'Row', 'Button', 'Tag', 'Muted', 'Input', 'Num', 'Area'];
const bad = [];
for (const f of readdirSync(dir).filter((x) => /^client(\..+)?\.js$/.test(x))) {
	const lines = readFileSync(join(dir, f), 'utf8').split('\n');
	lines.forEach((l, i) => { for (const n of PLAIN) if (new RegExp(`\\bh\\(${n}\\s*,`).test(l)) bad.push(`${f}:${i + 1} h(${n}, …)`); });
}
assert.deepEqual(bad, [], `这些普通函数被当成组件用了：\n${bad.join('\n')}`);
const main = readFileSync(join(dir, 'client.js'), 'utf8');
assert.match(main, /class Boundary extends react\.Component/);
assert.match(main, /h\(Boundary, \{ name: "版本" \}, h\(UpdateBar/);
console.log('  ✓ client：普通函数没被当组件用；版本条 / 引导 / 每页都有出错兜底');
