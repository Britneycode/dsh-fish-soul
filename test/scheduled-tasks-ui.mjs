// #190：定时任务面板（client.scheduled-tasks.js）—— 真渲染 + 真点按钮。
//
// 为什么不能只查字符串：这个分块是自己注册的懒加载 chunk，写错了（比如把保存按钮
// 挂到错误的回调上、或者提交时少带一个字段）光看源码看不出来。��里把分块真的跑起来：
//   - 假 React（带状态）渲染出面板；
//   - 假 api 记录每一次请求；
//   - 真去点「新建 / 保存 / 开关 / 删除」，然后断言**发出去的请求**对不对。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.scheduled-tasks.js', import.meta.url), 'utf8');
let factory = null;
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (o) => { factory = o.factory; } } }, console });
assert.equal(typeof factory, 'function', '分块要通过 window.__ModuleLoader__.load 注册');

const flatten = (children) => {
	const out = [];
	const walk = (c) => {
		if (Array.isArray(c)) { c.forEach(walk); return; }
		if (c === null || c === undefined || c === false || c === true) return;
		out.push(c);
	};
	walk(children);
	return out;
};

const slots = [];
let cursor = 0;
const effects = [];
const react = {
	Fragment: Symbol('Fragment'),
	createElement: (type, props, ...kids) => ({ type, props: props ?? {}, children: kids.flat(Infinity) }),
	useState: (init) => {
		const i = cursor++;
		if (slots.length <= i) slots[i] = typeof init === 'function' ? init() : init;
		return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
	},
	useEffect: (fn) => { effects.push(fn); },
	useCallback: (fn) => fn,
	useRef: (v) => ({ current: v }),
	Children: { forEach: (children, cb) => flatten(children).forEach((c, i) => cb(c, i)) },
	isValidElement: (x) => Boolean(x && x.type)
};

const plugin = factory(() => react);

const ui = {
	h: react.createElement,
	Group: (props, ...kids) => react.createElement('section', { className: 'fs-group' },
		props.title ? react.createElement('h3', { className: 'fs-group-head' }, props.title) : null,
		props.aside ?? null, ...kids),
	Row: (props, ...kids) => react.createElement('div', { className: 'fs-row' },
		react.createElement('span', { className: 'fs-row-label' }, props.title),
		props.meta ? react.createElement('span', { className: 'fs-row-meta' }, props.meta) : null,
		react.createElement('div', { className: 'fs-ctl' }, ...kids)),
	Input: (props) => react.createElement('input', props),
	Num: (props) => react.createElement('input', { type: 'number', ...props }),
	Area: (props) => react.createElement('textarea', props),
	Select: (props, ...options) => react.createElement('select',
		{ ...props, onChange: (e) => props.onChange?.({ target: { value: e.target.value } }) }, ...options),
	Seg: (props) => react.createElement('div', { className: 'fs-seg' },
		...props.options.map((o) => react.createElement('button', { key: o.value, type: 'button', onClick: () => props.onChange(o.value) }, o.label))),
	Switch: (props) => react.createElement('button',
		{ type: 'button', role: 'switch', checked: props.checked === true, 'aria-checked': props.checked === true,
			onChange: props.onChange, onClick: () => props.onChange(!props.checked) }),
	Button: (props, ...kids) => react.createElement('button', { type: 'button', ...props }, ...kids),
	Tag: (text, tone) => react.createElement('span', { 'data-tone': tone }, text),
	Muted: (text) => react.createElement('span', { className: 'fs-unit' }, text),
	useConfirm: () => [async () => confirmAnswer, null]
};

let confirmAnswer = true;
const calls = [];
const notified = [];
let state = {
	ok: true,
	tasks: [{
		id: 3, name: '盯服务器', prompt: '看看服务器有没有挂', enabled: true, recurrence: 'interval',
		intervalMinutes: 20, dailyHhmm: null, nextRunAt: Date.now() + 20 * 60_000,
		nextRunAtLabel: '2099-01-02 09:00', nextRunAtInput: '2099-01-02T09:00', scheduleLabel: '每隔 20 分钟',
		target: 'private:10001', targetLabel: '主人私聊', status: 'active', stateLabel: '下一次 2099-01-02 09:00',
		attempts: 0, lastError: '', createdAt: 1, updatedAt: 1
	}],
	destinations: [{ id: 'private:10001', label: '主人私聊', kind: 'private' }, { id: 'group:88888', label: '测试群（88888）', kind: 'group' }]
};
const api = async (method, path, body) => {
	calls.push({ method, path, body });
	if (method === 'GET') return state;
	return { ok: true, tasks: state.tasks, destinations: state.destinations };
};
const notify = (text) => { notified.push(text); };

const props = { api, notify, ui };
const render = () => { cursor = 0; return plugin.ScheduledTasksPane(props); };
const tick = () => new Promise((r) => setTimeout(r, 5));

function walk(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
	out.push(node);
	walk(node.children, out);
	return out;
}
const findAll = (tree, pred) => walk(tree).filter((n) => pred(n));
const buttonByText = (tree, text) => findAll(tree, (n) => n.type === 'button' && flatten(n.children).includes(text))[0];
/** 分块跑在 vm 里，它造出来的对象原型不是本 realm 的 —— 比较前先拍平。 */
const plain = (o) => JSON.parse(JSON.stringify(o));
/** 面板上所有文字拼起来（用来断言「这句话确实渲染出来了」）。 */
const textOf = (tree) => flatten(walk(tree).map((n) => n.children)).filter((c) => typeof c === 'string').join('\n');

let tree = render();
for (const fn of effects.splice(0)) fn();
await tick();
tree = render();

// ① 列表渲染：任务名、排期、发到哪儿都在
{
	assert.match(textOf(tree), /盯服务器/, '任务名要渲染出来');
	assert.match(textOf(tree), /每隔 20 分钟/, '排期要渲染出来');
	assert.match(textOf(tree), /主人私聊/, '发到哪儿要渲染出来');
	const switches = findAll(tree, (n) => n.props?.role === 'switch');
	assert.equal(switches.length, 1, '每个任务一个开关');
	assert.equal(switches[0].props.checked, true);
}

// ② 开关 → POST /scheduled-tasks/toggle
{
	const sw = findAll(render(), (n) => n.props?.role === 'switch')[0];
	sw.props.onChange(false);
	await tick();
	const toggle = calls.find((c) => c.path === '/scheduled-tasks/toggle');
	assert.ok(toggle, '开关要发 toggle 请求');
	assert.equal(toggle.method, 'POST');
	assert.deepEqual(plain(toggle.body), { id: 3, enabled: false });
}

// ③ 删除 → 先确认，再 POST /scheduled-tasks/delete
{
	confirmAnswer = true;
	const del = buttonByText(render(), '删');
	assert.ok(del, '每个任务要有删除按钮');
	del.props.onClick();
	await tick();
	const delCall = calls.find((c) => c.path === '/scheduled-tasks/delete');
	assert.ok(delCall, '删除要发 delete 请求');
	assert.deepEqual(plain(delCall.body), { id: 3 });
}

// ④ 取消确认 → 不发请求
{
	confirmAnswer = false;
	const before = calls.filter((c) => c.path === '/scheduled-tasks/delete').length;
	buttonByText(render(), '删').props.onClick();
	await tick();
	assert.equal(calls.filter((c) => c.path === '/scheduled-tasks/delete').length, before, '取消确认就不能删');
	confirmAnswer = true;
}

// ⑤ 新建 → 表单出来 → 填 → 保存 → POST /scheduled-tasks/create
{
	buttonByText(render(), '新建任务').props.onClick();
	tree = render();
	const nameInput = findAll(tree, (n) => n.props?.placeholder === '比如：盯着服务器')[0];
	assert.ok(nameInput, '点新建要出表单（任务名输入框）');
	const promptArea = findAll(tree, (n) => n.props?.placeholder === '比如：看看我的服务器有没有挂，挂了跟我说一声')[0];
	assert.ok(promptArea, '要有唤醒提示词输入框');
	const atInput = findAll(tree, (n) => n.props?.type === 'datetime-local')[0];
	assert.ok(atInput, '要有首次时间输入框');
	const numInput = findAll(tree, (n) => n.props?.type === 'number')[0];
	assert.ok(numInput, '要有间隔分钟输入框');
	const select = findAll(tree, (n) => n.type === 'select')[0];
	assert.ok(select, '要有「回复发到哪儿」的下拉');
	const options = findAll(select, (n) => n.type === 'option');
	assert.deepEqual(plain(options.map((o) => o.props.value)), ['private:10001', 'group:88888'], '下拉里是真实存在的目的地');

	nameInput.props.onChange({ target: { value: '每分钟检查' } });
	promptArea.props.onChange({ target: { value: '看一眼服务器' } });
	atInput.props.onChange({ target: { value: '2099-01-02T09:00' } });
	numInput.props.onChange({ target: { value: '1' } });
	select.props.onChange({ target: { value: 'group:88888' } });
	tree = render();
	buttonByText(tree, '加上任务').props.onClick();
	await tick();
	const created = calls.find((c) => c.path === '/scheduled-tasks/create');
	assert.ok(created, '保存要发 create 请求');
	assert.equal(created.method, 'POST');
	assert.deepEqual(plain(created.body), {
		name: '每分钟检查', prompt: '看一眼服务器', recurrence: 'interval',
		target: 'group:88888', at: '2099-01-02T09:00', intervalMinutes: 1
	});
}

// ⑥ 本地校验：名称空着就不该发请求
{
	buttonByText(render(), '新建任务').props.onClick();
	tree = render();
	buttonByText(tree, '加上任务').props.onClick();
	await tick();
	assert.equal(calls.filter((c) => c.path === '/scheduled-tasks/create').length, 1, '空表单不该发请求');
	assert.ok(notified.some((n) => /名称/.test(n)), '要说清楚哪里没填');
}

// ⑦ 改任务 → POST /scheduled-tasks/update（带 id）
{
	const edit = buttonByText(render(), '改');
	assert.ok(edit, '每个任务要有编辑按钮');
	edit.props.onClick();
	tree = render();
	const nameInput = findAll(tree, (n) => n.props?.placeholder === '比如：盯着服务器')[0];
	nameInput.props.onChange({ target: { value: '改过的名字' } });
	tree = render();
	buttonByText(tree, '保存修改').props.onClick();
	await tick();
	const updated = calls.find((c) => c.path === '/scheduled-tasks/update');
	assert.ok(updated, '保存修改要发 update 请求');
	assert.equal(updated.body.id, 3, '要带任务 id');
	assert.equal(updated.body.name, '改过的名字');
}

console.log('✓ #190 面板：渲染 / 开关 / 删除（带确认）/ 新建 / 改，全走真实请求');
