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

// #82：useConfirm() 返回 [confirm, confirmNode] 两件东西，confirm() 只是把待确认的那件事存进 state，
// 真正画出对话框的是 confirmNode。组件里只解构不渲染，点「删除这张卡」就什么都不发生——界面无反应、
// Promise 永不 settle。凡是用 useConfirm 的组件，必须把 confirmNode 挂进它返回的那棵树。
const confirmHoles = [];
let confirmUsers = 0;
for (const f of readdirSync(dir).filter((x) => /^client(\..+)?\.js$/.test(x))) {
	const src = readFileSync(join(dir, f), 'utf8');
	const marks = [];
	const re = /^\t\tfunction (\w+)\(/gm;
	let m;
	while ((m = re.exec(src)) !== null) marks.push([m[1], m.index]);
	marks.forEach(([name, start], i) => {
		const block = src.slice(start, i + 1 < marks.length ? marks[i + 1][1] : src.length);
		const destructure = /const \[confirm, confirmNode\] = useConfirm\(\);/.exec(block);
		if (destructure === null) return;
		confirmUsers += 1;
		const rest = block.slice(0, destructure.index) + block.slice(destructure.index + destructure[0].length);
		if (!/\bconfirmNode\b/.test(rest)) confirmHoles.push(`${f} ${name}`);
	});
}
assert.deepEqual(confirmHoles, [], `这些组件调了 confirm() 却没把对话框挂出去，点了没反应：\n${confirmHoles.join('\n')}`);
assert(confirmUsers >= 5, `只找到 ${confirmUsers} 个用 useConfirm 的组件，检查逻辑可能失效了`);
console.log(`  ✓ 确认对话框：${confirmUsers} 个组件都把 confirmNode 挂出去了（#82）`);

// 窄容器导航在宿主内部滚动列中吸顶，保持单行并允许横向滚动。
const css = readFileSync(join(dir, 'panel.css'), 'utf8');
const narrow = css.slice(css.indexOf('@container (max-width:720px)'));
assert.match(narrow, /\.fs-side\{[^}]*position:sticky;top:0/);
assert.match(narrow, /\.fs-nav\{[^}]*flex-wrap:nowrap;[^}]*overflow-x:auto/);
assert.match(narrow, /\.fs-tab\{flex:none\}/);
assert.match(narrow, /grid-template-rows:auto minmax\(0,1fr\)/);
console.log('  ✓ 窄容器：顶部导航吸顶、单行并可横向滚动');

// 插件主题遵循宿主 --dsw-alias-* 令牌并提供暗/浅色兜底；数值与进度条沿用统一规则。
assert.match(css, /--bg-window:var\(--dsw-alias-bg-module-platform,#0f1116\);--bg-sidebar:var\(--dsw-alias-bg-module-platform,#0b0d11\);--bg-surface:var\(--dsw-alias-bg-layer-1,#14171f\);--bg-control:var\(--dsw-alias-bg-layer-3,#0b0d12\)/);
assert.match(css, /--border-hairline:var\(--dsw-alias-border-l2,rgba\(255,255,255,\.055\)\);--border-subtle:var\(--dsw-alias-border-l3,rgba\(255,255,255,\.095\)\)/);
assert.match(css, /html\[data-ds-theme-source\] body:not\(\[data-ds-dark-theme\]\)/);
assert.match(css, /--accent:var\(--dsw-alias-state-business-primary,#4d6bfe\)/);
assert.match(css, /\.fs-track\{[^}]*height:5px/);
assert.match(css, /\.fs-row-meta\{[^}]*font-variant-numeric:tabular-nums/);
assert.doesNotMatch(main, /desc && !tip \? h\("span", \{ className: "fs-row-desc"/);
console.log('  ✓ 插件主题：深浅模式、细边框、数字排版与进度条');

// 主面板与设置页都以系统分组下的独立页签打开版本更新，不再有顶部更新栏。
assert.match(main, /\["system", "系统", \[\["interface", "界面"\], \["version", "版本更新"\], \["diag", "运行日志"\]\]\]/);
assert.match(main, /tab === "version" \? h\(Boundary, \{ name: "版本" \}, h\(UpdateBar, \{ notify, onUpdateState: setUpdateAvailable \}\)\)/);
assert.match(main, /h\(GroupedTabs, \{ value: tab, onChange: goTab, hasUpdate: updateAvailable \}\)/);
assert.doesNotMatch(main, /fs-settings-update/);
assert.doesNotMatch(main, /fs-ver-panel/);
console.log('  ✓ 版本入口：主面板与设置页同为系统分组独立页签');

// 引导进度只计算实际已完成项；短标题不会改变接口或未知步骤。
assert.match(main, /steps\.filter\(\(x\) => x\.done\)\.length/);
assert.match(main, /ONBOARDING_LABELS\[x\.id\] \?\? x\.title/);
assert.match(main, /api\("GET", "\/onboarding\/state"\)/);
assert.match(main, /api\("POST", "\/onboarding\/dismiss"/);
assert.match(css, /\.fs-onboarding \.fs-item-main\{white-space:normal/);
console.log('  ✓ 首次引导：真实进度、兼容未知步骤与窄屏换行');

// 主页面导航单行吸顶，版本提示来自实际状态；设置页与主页共用同一导航。
assert.match(css, /\.fs-standalone \.fs-side\{[^}]*position:sticky;top:0/);
assert.match(css, /\.fs-standalone \.fs-nav\{[^}]*flex-direction:row;flex-wrap:nowrap;[^}]*overflow-x:auto/);
assert.match(main, /nav\.scrollLeft/);
assert.match(main, /hasUpdate: updateAvailable/);
assert.match(main, /onUpdateState: setUpdateAvailable/);
assert.match(css, /\.fs\.fs-standalone \.fs-side,\.fs\.fs-settings \.fs-side\{[^}]*position:sticky;top:0/);
assert.match(main, /\["memory", "记忆", \[\["retrieval", "检索设置"\], \["people", "人物与关系"\], \["memories", "记忆内容"\], \["recall-test", "检索测试"\], \["weekly", "周记"\], \["archives", "记忆存档"\], \["backups", "导入与备份"\]\]\]/);
assert.match(main, /\["daily", "日常", \[\["life", "主动开口"\], \["scheduled-tasks", "定时任务"\], \["relay", "熟人传话"\], \["activity", "最近动态"\], \["diary", "日记"\], \["stickers", "表情包"\], \["slang", "学到的说法"\]\]\]/);
assert.match(main, /\["channels", "平台", \[\["qq", "QQ"\], \["bili", "B站"\], \["douyin", "抖音"\]\]\]/);
assert.match(main, /remembered\.current/);
console.log('  ✓ 两级导航：完整分类、吸顶、状态记忆和更新提示');

// 引导为独立可复访页面；仅未完成且用户未操作时自动打开。

assert.match(main, /goTab\("guide"\)/);
assert.match(main, /tab === "guide" \? \[\] : SUBTABS\[tab\] \?\? \[\]/);
assert.match(main, /!hasInteracted\.current && readGuideVisible\(\) && r\?\.ok && r\.dismissed === false/);
assert.match(main, /r\.steps\.some\(\(step\) => !step\.done\)/);
assert.match(main, /tab === "guide" \? h\(Onboarding/);
assert.match(main, /data\.dismissed \? null : IconButton\("close", "以后不再自动显示"/);
assert.match(main, /onDismiss: \(\) => goTab\("memory"\)/);
console.log('  ✓ 使用引导：独立入口、自动显示和可重新访问');
// 隐藏入口与引导进度分离，设置页可恢复，并防止隐藏后自动打开。
assert.match(main, /fish-soul:guide-visible/);
assert.match(main, /Button\(\{ variant: "ghost", onClick: onHide \}, "隐藏开始"\)/);
assert.match(main, /subtab === "interface" \? Row\(\{ title: "显示开始" \}/);
assert.match(main, /readGuideVisible\(\) && r\?\.ok/);
assert.match(main, /current === "guide" \? "memory" : current/);
console.log('  ✓ 开始入口：可隐藏、持久化并在界面设置中恢复');

// 表单键必须对得上：useForm(data, () => ({...})) 里定义的键，和 form.xxx 用的键，
// 拼错一个就变成 undefined —— 表现是数字框显示空白、改了还存不进去（#61 就踩过：
// 初始化的键是 xxx，读的时候写成 form.yyy，空白了两天没人发现）。
{
	// 一个文件里有多套表单（QQ / B站 / 抖音各一块），键要合并起来看
	const blocks = [...main.matchAll(/useForm\(data, \(\) => \(\{([\s\S]*?)\}\)\)/g)].map((m) => m[1]);
	assert.ok(blocks.length > 0, '应该能找到 useForm 初始化块');
	const initKeys = new Set();
	for (const block of blocks) {
		for (const m of block.matchAll(/(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*:/g)) initKeys.add(m[1]);
	}
	const used = [...new Set([...main.matchAll(/form\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
	const missing = used.filter((k) => !initKeys.has(k));
	assert.deepEqual(missing, [],
		`这些 form 键读了但初始化块里没有（会显示空白 / 存不进去）：${missing.join(', ')}`);
	console.log(`  ✓ 表单键对得上：${blocks.length} 套表单、${used.length} 个 form 键全有初始化`);
}

// 通用控件重置必须是「零特异性」，否则它会盖掉宿主原子控件的组件样式。
// 真机症状：更新页「更新到 vX」渲染成黑底黑字（宿主 primary 是深色实心 + 反色字）。
// 根因：写成 `.fs :where(button,…)` ⇒ 特异性 (0,1,0)，跟宿主 `._button_xxx{color}` 打平，
// 而插件样式注入在宿主之后 ⇒ 平局时后者胜 ⇒ 反色字被改回继承色。
// 这里直接算特异性，不依赖具体写法（包 :where() 或去掉 .fs 前缀都算过）。
{
	const selectorOfReset = (raw) => {
		// 先去掉注释：注释里写了 `._button_xxx{color}` 这种例子，括号会带偏配对
		const cssNoComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
		for (const m of cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const [, sel, body] = m;
			if (!/color\s*:\s*inherit/.test(body)) continue;
			// 目标规则同时点名 button / input / textarea（不管有没有被 :where( 包着）
			if (/\bbutton\b/.test(sel) && /\binput\b/.test(sel) && /\btextarea\b/.test(sel)) return sel.trim();
		}
		return null;
	};
	// 特异性：(id, class/attr/pseudo-class, type/pseudo-element)。:where() 内部一律计 0。
	const specificity = (sel) => {
		let s = sel.replace(/:where\([^)]*\)/g, '*');   // :where() 不参与特异性
		s = s.replace(/::[\w-]+/g, ' ');                 // 伪元素
		const ids = (s.match(/#[\w-]+/g) || []).length;
		const classes = (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]+\]/g) || []).length
			+ (s.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
		const types = (s.match(/(^|[\s>+~,])[a-zA-Z][\w-]*/g) || []).length;
		return ids * 100 + classes * 10 + types;
	};
	const sel = selectorOfReset(css);
	assert.ok(sel, 'panel.css 里应该能找到通用控件重置规则（button/input/textarea 的 color:inherit）');
	assert.equal(specificity(sel), 0,
		`通用控件重置的选择器「${sel}」特异性是 ${specificity(sel)}，必须为 0 —— `
		+ '否则会盖掉宿主原子控件（Button/Pill/Input…）自己的组件类样式，'
		+ '宿主 primary 按钮会变成黑底黑字。包一层 :where() 即可。');
	assert.ok(!/^\.fs\s/.test(sel), `重置不要以 .fs 开头（特异性不为 0）：${sel}`);
	console.log(`  ✓ 控件重置零特异性：${sel}`);
}
