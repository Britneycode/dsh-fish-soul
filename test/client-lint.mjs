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

// 窄容器导航在宿主内部滚动列中吸顶，保持单行并允许横向滚动。
const css = readFileSync(join(dir, 'panel.css'), 'utf8');
const narrow = css.slice(css.indexOf('@container (max-width:720px)'));
assert.match(narrow, /\.fs-side\{[^}]*position:sticky;top:0/);
assert.match(narrow, /\.fs-nav\{[^}]*flex-wrap:nowrap;[^}]*overflow-x:auto/);
assert.match(narrow, /\.fs-tab\{flex:none\}/);
console.log('  ✓ 窄容器：顶部导航吸顶、单行并可横向滚动');

// 插件主题自包含，宿主浅色时覆盖；数值与进度条沿用统一规则。
assert.match(css, /--bg-window:#0f1116;--bg-sidebar:#0b0d11;--bg-surface:#14171f;--bg-control:#0b0d12/);
assert.match(css, /--border-hairline:rgba\(255,255,255,\.055\);--border-subtle:rgba\(255,255,255,\.095\)/);
assert.match(css, /html\[data-ds-theme-source\] body:not\(\[data-ds-dark-theme\]\)/);
assert.match(css, /--accent:#4d6bfe/);
assert.match(css, /\.fs-track\{[^}]*height:5px/);
assert.match(css, /\.fs-row-meta\{[^}]*font-variant-numeric:tabular-nums/);
assert.doesNotMatch(main, /desc && !tip \? h\("span", \{ className: "fs-row-desc"/);
console.log('  ✓ 插件主题：深浅模式、细边框、数字排版与进度条');
