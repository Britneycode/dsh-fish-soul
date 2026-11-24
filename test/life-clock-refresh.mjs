// 日常页从「熟人传话」切到「主动开口」时，真实 FishSoulSection 必须启动并清理虚拟时钟。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let factory;
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let activeRunner = null;
const react = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	Component: class {},
	useState(initial) { return activeRunner.useState(initial); },
	useRef(initial) { return activeRunner.useRef(initial); },
	useEffect(effect, deps) { return activeRunner.useEffect(effect, deps); },
	useCallback(callback, deps) { return activeRunner.useCallback(callback, deps); },
};

function hookRunner(component, initialStates = []) {
	const slots = initialStates.map((value) => ({ value }));
	let cursor = 0;
	let dirty = false;
	let pending = [];
	let view = null;
	const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
	const runner = {
		useState(initial) {
			const index = cursor++;
			if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
			const set = (next) => {
				const value = typeof next === 'function' ? next(slots[index].value) : next;
				if (Object.is(value, slots[index].value)) return;
				slots[index].value = value;
				dirty = true;
			};
			return [slots[index].value, set];
		},
		useRef(initial) {
			const index = cursor++;
			if (!slots[index]) slots[index] = { current: initial };
			return slots[index];
		},
		useCallback(callback, deps) {
			const index = cursor++;
			if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { callback, deps };
			return slots[index].callback;
		},
		useEffect(effect, deps) {
			const index = cursor++;
			const previous = slots[index];
			if (previous && sameDeps(previous.deps, deps)) return;
			pending.push(() => {
				previous?.cleanup?.();
				const cleanup = effect();
				slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
			});
		},
		render(props = {}) {
			cursor = 0;
			activeRunner = runner;
			try { view = component(props); } finally { activeRunner = null; }
			return view;
		},
		flush() {
			do {
				dirty = false;
				runner.render();
				const effects = pending;
				pending = [];
				for (const effect of effects) effect();
			} while (dirty);
			return view;
		},
		unmount() {
			for (const slot of slots) slot?.cleanup?.();
		},
	};
	return runner;
}

let nextTimer = 1;
const timers = new Map();
const cleared = new Set();
const setIntervalFake = (callback, delay) => {
	const id = nextTimer++;
	timers.set(id, { id, callback, delay });
	return id;
};
const clearIntervalFake = (id) => { cleared.add(id); timers.delete(id); };
const activeClockTimers = () => [...timers.values()].filter((timer) => timer.delay === 1000);

vm.runInNewContext(source.replace(
	'exports.apply = apply;',
	'exports.__lifeClockTest = { FishSoulSection, GroupedTabs, Tabs }; exports.apply = apply;',
), {
	window: {
		__ModuleLoader__: { load: ({ factory: loaded }) => { factory = loaded; } },
		localStorage: { getItem: () => null, setItem: () => {} },
		addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
	},
	fetch: async (url) => url.endsWith('/ui/panel.css')
		? { ok: true, text: async () => '' }
		: { status: 200, json: async () => url.endsWith('/onboarding/state')
			? { ok: true, dismissed: true, steps: [] }
			: { ok: true } },
	setInterval: setIntervalFake,
	clearInterval: clearIntervalFake,
	setTimeout: () => { throw new Error('本场景不应创建 timeout'); },
	clearTimeout: () => {},
	console,
});
const controls = factory((name) => {
	if (name === 'react') return react;
	throw new Error(`缺少可选模块 ${name}`);
}).__lifeClockTest;

// 直接给定打开设置时的日常页状态，避免先进入「主动开口」而提前触发时钟 effect。
const main = hookRunner(controls.FishSoulSection, [null, undefined, true, 'daily', 'relay']);
const tabs = hookRunner(controls.Tabs);
main.flush();
for (let i = 0; i < 8; i++) await Promise.resolve();
main.flush();

function navButtons() {
	const found = [];
	const visit = (node) => {
		if (Array.isArray(node)) { for (const child of node) visit(child); return; }
		if (!node || typeof node !== 'object') return;
		if (node.type === controls.GroupedTabs) { visit(node.type(node.props)); return; }
		if (node.type === controls.Tabs) { visit(tabs.render(node.props)); return; }
		if (node.type === 'button') found.push(node);
		visit(node.children);
	};
	visit(main.flush());
	return found;
}
function clickNav(label) {
	const button = navButtons().find((node) => node.props['aria-label'] === label || node.children.includes(label));
	assert(button, `应渲染导航按钮「${label}」`);
	button.props.onClick();
	main.flush();
}
function selectedNav(label) {
	const button = navButtons().find((node) => node.props['aria-label'] === label);
	assert.equal(button?.props['aria-selected'], true, `初始子页应为「${label}」`);
}

selectedNav('熟人传话');
assert.equal(activeClockTimers().length, 0, '熟人传话页不应运行虚拟时钟');
clickNav('主动开口');
assert.equal(activeClockTimers().length, 1, '从熟人传话切到主动开口后应安装 1000ms 虚拟时钟 interval');
const clock = activeClockTimers()[0];
clickNav('熟人传话');
assert(cleared.has(clock.id), '离开主动开口时应清理原虚拟时钟 interval');
assert.equal(activeClockTimers().length, 0, '离开主动开口后不应残留虚拟时钟 interval');
main.unmount();
tabs.unmount();
clickNav('主动开口');
const guideClock = activeClockTimers()[0];
clickNav('使用引导');
assert(cleared.has(guideClock.id), '从主动开口进入使用引导时应清理时钟 interval');
assert.equal(activeClockTimers().length, 0, '使用引导页不应残留时钟 interval');
console.log('✓ 生活页虚拟时钟：子页切入时启动，切出或进入引导时清理');
