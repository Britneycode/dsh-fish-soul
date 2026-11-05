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
assert.match(narrow, /grid-template-rows:auto minmax\(0,1fr\)/);
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

// 主面板以导航项打开版本页；设置页仍在顶部展示版本设置。
assert.match(main, /standalone \? \[\.\.\.baseTabs, \["version", "版本更新"\]\] : baseTabs/);
assert.match(main, /tab === "version" \? h\(UpdateBar, \{ notify, onUpdateState: setUpdateAvailable \}\)/);
assert.match(main, /h\(GroupedTabs, \{ items: tabs, value: tab, onChange: goTab, hasUpdate: standalone && updateAvailable \}\)/);
assert.match(main, /standalone \? null : h\("div", \{ className: "fs-settings-update" \}/);
assert(main.indexOf('className: "fs-settings-update"') < main.indexOf('className: "fs-main-head"'));
assert.doesNotMatch(main, /fs-ver-panel/);
console.log('  ✓ 版本入口：主面板导航页、设置页顶部显示');

// 引导进度只计算实际已完成项；短标题不会改变接口或未知步骤。
assert.match(main, /steps\.filter\(\(x\) => x\.done\)\.length/);
assert.match(main, /ONBOARDING_LABELS\[x\.id\] \?\? x\.title/);
assert.match(main, /api\("GET", "\/onboarding\/state"\)/);
assert.match(main, /api\("POST", "\/onboarding\/dismiss"/);
assert.match(css, /\.fs-onboarding \.fs-item-main\{white-space:normal/);
console.log('  ✓ 首次引导：真实进度、兼容未知步骤与窄屏换行');

// 主页面导航单行吸顶，版本提示来自实际状态；设置页仍使用原有布局。
assert.match(css, /\.fs-standalone \.fs-side\{[^}]*position:sticky;top:0/);
assert.match(css, /\.fs-standalone \.fs-nav\{[^}]*flex-direction:row;flex-wrap:nowrap;[^}]*overflow-x:auto/);
assert.match(main, /nav\.scrollLeft/);
assert.match(main, /standalone && updateAvailable/);
assert.match(main, /onUpdateState: setUpdateAvailable/);
assert.match(css, /\.fs\.fs-standalone \.fs-side,\.fs\.fs-settings \.fs-side\{[^}]*position:sticky;top:0/);
assert.match(main, /label: "记忆", ids: \["retrieval", "inspector"\]/);
assert.match(main, /label: "角色", ids: \["persona", "behavior"\]/);
assert.match(main, /label: "日常", ids: \["life", "activity"\]/);
assert.match(main, /label: "平台", ids: \["qq", "bili", "douyin"\]/);
assert.match(main, /label: "系统", ids: \["models", "interface", "version"\]/);
assert.match(main, /remembered\.current/);
console.log('  ✓ 两级导航：完整分类、吸顶、状态记忆和更新提示');

// 引导为独立可复访页面；仅未完成且用户未操作时自动打开。
assert.match(main, /label: "开始", ids: \["guide"\]/);
assert.match(main, /\[\["guide", "使用引导"\]\] : \[\]/);
assert.match(main, /!hasInteracted\.current && readGuideVisible\(\) && r\?\.ok && r\.dismissed === false/);
assert.match(main, /r\.steps\.some\(\(step\) => !step\.done\)/);
assert.match(main, /tab === "guide" \? h\(Onboarding/);
assert.match(main, /data\.dismissed \? null : IconButton\("close", "以后不再自动显示"/);
assert.match(main, /onDismiss: \(\) => goTab\("retrieval"\)/);
console.log('  ✓ 使用引导：独立入口、自动显示和可重新访问');
// 隐藏入口与引导进度分离，设置页可恢复，并防止隐藏后自动打开。
assert.match(main, /fish-soul:guide-visible/);
assert.match(main, /Button\(\{ variant: "ghost", onClick: onHide \}, "隐藏开始"\)/);
assert.match(main, /tab === "interface" \? Row\(\{ title: "显示开始" \}/);
assert.match(main, /readGuideVisible\(\) && r\?\.ok/);
assert.match(main, /current === "guide" \? "retrieval" : current/);
console.log('  ✓ 开始入口：可隐藏、持久化并在界面设置中恢复');
