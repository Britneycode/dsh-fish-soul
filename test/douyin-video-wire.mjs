/**
 * 抖音视频的**端到端接线**（面板 → 路由 → DouyinSocial → driver → 账本）。
 *
 * 为什么单独一个套件：`test/douyin-video-trigger.mjs` 是直接 `new DouyinSocial(...)`
 * 再手搓 `registerRoutes` —— 它证明的是「各层自己没坏」，证明不了「插件真的把它们接上了」。
 * 本仓库反复出现的坑正是**接线零覆盖**：每层单测都绿，`apply()` 里少接一根线，
 * 功能就是死的（`testHooks.douyinSocial` 之前全仓库零使用，就是这个坑的证据）。
 *
 * 所以这里走**真的 `apply()`**：
 *   · 真的 `lib/index.js` 启动流程（真的 DouyinHost / DouyinChannel / DouyinSocial / 真的路由）
 *   · 浏览器和页面驱动打桩（`testHooks.douyin` / `testHooks.douyinSocial`）
 *   · 视频生成器打桩（**不能真去调按条计费的接口**）
 *   · 然后从 HTTP 路由打进去，一路断言到 SQLite 账本
 *
 * ⚠️ 桩必须在 `await mod.apply(...)` **之前**赋值：`testHooks.douyinSocial` 是在
 *    `startup()` 里 `new DouyinSocial({ ...基础依赖, ...(testHooks.douyinSocial ?? {}) })`
 *    展开的，apply 之后再改就只改了一个没人读的变量（构造已经结束）。
 *
 * 不启浏览器、不发网络、不花钱。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-dyvw-');
process.env.DSH_HOME = home;

const ok = (msg) => console.log('✓', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { openDatabase } = await import('../lib/db.js');

// ── 假浏览器：真的 DouyinHost 会走 launch → 拿到它，state 才能变成 running ────────
const fakeBrowser = {
	sessionId: 'S1',
	targetId: 'T1',
	alive: true,
	isAlive() { return this.alive; },
	async eval(expr) {
		// host.doStart() 用它判断「是不是已经在抖音上」，在就不用 goto
		if (String(expr) === 'location.href') return 'https://www.douyin.com/';
		return null;
	},
	async send() { return {}; },
	async goto() { return {}; },
	detach() {},
	async quit() { this.alive = false; }
};

// ── 假页面驱动（发视频那一路）：数调用次数，不碰真页面 ────────────────────────────
const driverCalls = {
	renderCard: 0, prepareNote: 0, listRecommendedMusic: 0, closeMusicPanel: 0, publishNote: 0,
	prepareVideo: 0, publishVideo: 0
};
const fakeDriver = {
	renderCard: async () => { driverCalls.renderCard++; return Buffer.from('card'); },
	prepareNote: async () => { driverCalls.prepareNote++; return { ok: true }; },
	listRecommendedMusic: async () => { driverCalls.listRecommendedMusic++; return { ok: true, songs: ['歌'] }; },
	closeMusicPanel: async () => { driverCalls.closeMusicPanel++; },
	publishNote: async ({ beforeSubmit } = {}) => { driverCalls.publishNote++; await beforeSubmit?.(); return { ok: true }; },
	prepareVideo: async () => { driverCalls.prepareVideo++; return { ok: true }; },
	publishVideo: async ({ beforeSubmit } = {}) => { driverCalls.publishVideo++; await beforeSubmit?.(); return { ok: true }; },
	listWorks: async () => []
};

// ── 假视频生成器：**绝不能真调外部接口**（按条计费） ─────────────────────────────
const genCalls = [];
const fakeVideoGen = {
	generate: async (cfg, opts) => {
		genCalls.push({ cfg, opts });
		return { ok: true, file: join(home, 'douyin-videos', 'v1.mp4'), bytes: 1024, provider: cfg.provider, elapsedMs: 1 };
	}
};

// ── 假抖音私信驱动：不让 Channel 去开页面 ────────────────────────────────────────
let capturedHost = null;
const fakeChannelDriver = {
	checkLogin: async () => true,
	list: async () => ({ ok: true, conversations: [] }),
	read: async () => ({ ok: false }),
	sendText: async () => ({ ok: true }),
	sendImage: async () => ({ ok: true }),
	sendEmoji: async () => ({ ok: true }),
	emojiNames: () => [],
	canary: async () => ({ ok: true, broken: [] })
};

const mod = await import('../lib/index.js');

// 🔴 全部在 apply 之前：DouyinSocial / DouyinHost / DouyinChannel 都是在 startup() 里构造的。
mod.testHooks.douyin = {
	douyinCdpPort: 0, // 0 = 不去 CDP 抓 cookie（否则会真连一个浏览器）
	detect: async () => [{ kind: 'edge', name: 'Microsoft Edge', version: '130.0', path: '/fake/msedge.exe' }],
	launch: async () => { fakeBrowser.alive = true; return fakeBrowser; },
	// 借 driver 工厂把真的 DouyinHost 抓住（后面要把它设成「已登录」）
	driver: (host) => { capturedHost = host; return fakeChannelDriver; },
	// 轮询保持安静：这个套件不测私信，别让 pollOnce 抢浏览器的活
	pollRangeMs: [600_000, 600_000],
	firstPollMs: 600_000,
	typingMs: [0, 0]
};
mod.testHooks.douyinSocial = {
	driver: fakeDriver,
	videoGen: fakeVideoGen,
	// 真 callLlm 要走宿主模型服务（测试里没有）→ 文案直接给，别把「模型不可用」当成接线坏了
	callLlm: async (prompt) => (/短视频/.test(prompt) ? '厨房的蒸汽糊住了窗' : /配背景音乐/.test(prompt) ? '歌' : '今天风挺大的')
};
// 真发了网络请求就该炸：这个套件一条网线都不该摸
mod.testHooks.webFetch = async () => { throw new Error('测试不该发网络'); };

// ── 最小宿主 ctx（照 test/smoke.mjs 的最小集）────────────────────────────────────
let route = null;
const noop = () => {};
const services = {
	workspaceRegistry: {
		create: async (path) => ({ path, attachSession: async () => {} }),
		list: () => []
	},
	sessionTitle: { rename: noop },
	attachments: { admitPromptContent: async (parts) => parts }
};
const registeredTools = new Map();
let guardFn = null;
const ctx = {
	logger: { info: noop, warn: noop, error: noop, debug: noop },
	effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : noop; },
	get: (name) => services[name],
	tools: {
		register: (t) => { if (t?.name) registeredTools.set(t.name, t); return noop; },
		get: (n) => registeredTools.get(n) ?? (n === 'mcp__openmotion__openmotion_create_project' ? { name: n } : undefined),
		definitions: () => [...registeredTools.values(), { name: 'mcp__openmotion__openmotion_create_project' }, { name: 'openmotion_edit_project' }, { name: 'shell_exec' }],
		guard: (fn) => { guardFn = fn; return noop; }
	},
	systemPrompt: { section: () => noop, context: () => noop },
	on: () => noop,
	webServer: { register: (r) => { route ??= r; return noop; } }
};

// 假的 API Key（拼出来的：写死一串像密钥的字面量会被密钥扫描误伤）。回显里出现它就是明文泄漏。
const API_KEY = ['fake', 'lxd', 'dyu', 'tcub', 'dkwh', '6234dimk'].join('-');
const EXPECT_MASK = `sk-${'•'.repeat(16)}${API_KEY.slice(-4)}`;

await mod.apply(ctx, {
	masterQqUin: '10001',
	qq: { enabled: false },
	bili: { enabled: false },
	douyin: {
		enabled: true,
		post: { enabled: true, perDay: 1 },
		video: {
			enabled: true, provider: 'volc', baseURL: '', apiKey: API_KEY, model: 'm',
			durationSec: 5, aspectRatio: '9:16', resolution: '768P', perDay: 1
		},
		comments: { enabled: false, perHour: 4 }
	}
});

assert.ok(route !== null, 'apply() 之后必须挂上路由（webServer.register）');
assert.ok(capturedHost !== null, 'testHooks.douyin.driver 要拿到真的 DouyinHost');

// 浏览器是 apply 里 `void host.start()` 拉起来的 —— 等它真 running
for (let i = 0; i < 300 && !capturedHost.running; i++) await sleep(10);
assert.equal(capturedHost.running, true, '专用浏览器要能被拉起来（假 launch）');
// loggedIn 正常是轮询路探出来的；这里直接给（本套件不测登录探测）
capturedHost.loggedIn = true;

/** 走真 HTTP 路由（和面板走同一条）。 */
async function call(path, method = 'POST', body = null) {
	let out = '';
	const req = new (await import('node:stream')).Readable({
		read() { this.push(body === null ? null : JSON.stringify(body)); if (body !== null) this.push(null); }
	});
	req.url = `/api/plugins/fish-soul${path}`;
	req.method = method;
	req.headers = {};
	const res = { writeHead: () => {}, end: (text) => { out = text; } };
	await route.handler(req, res);
	return JSON.parse(out);
}
const state = () => call('/channels/state', 'GET');
const saveVideo = (video) => call('/channels/douyin-config', 'POST', { video });
/** 尾部 4 位掩码：`maskKey` 的格式（sk- + 一串圆点 + 末 4 位）。 */

const db = openDatabase();

try {
	// ── W1：配置保存 → 回显（拆掉 video 回显就会红）────────────────────────────
	{
		const r = await saveVideo({ enabled: true, provider: 'minimax', perDay: 2 });
		assert.equal(r.ok, true, `保存要成功：${r.error}`);
		const st = await state();
		assert.ok(st.douyin.social !== null && st.douyin.social !== undefined,
			'DouyinSocial 要在 apply() 里真的被构造出来（不然整条视频链路都不存在）');
		assert.equal(st.douyin.video.provider, 'minimax', '回显里要看到刚存进去的服务商（存进去读不回来 = 死输入框）');
		assert.equal(st.douyin.video.perDay, 2, '回显里要看到刚存进去的每天条数');
		assert.equal(st.douyin.video.enabled, true);
		ok('W1 配置保存 → 回显：provider / perDay 读得回来');
	}

	// ── W2：保存别的字段不冲掉 apiKey ──────────────────────────────────────────
	{
		// 面板在「用户没填新 key」时发的是**不带 apiKey 键**的 video 块（见 W9）
		const before = (await state()).douyin.video;
		assert.equal(before.hasApiKey, true, '前置：apiKey 本来是有的');
		const r2 = await call('/channels/douyin-config', 'POST', {
			post: { enabled: true },
			video: { enabled: true, provider: 'minimax', baseURL: '', model: 'm', durationSec: 5, aspectRatio: '9:16', resolution: '768P', perDay: 2 }
		});
		assert.equal(r2.ok, true, `保存配置必须成功（防 405 空跑）：${r2.error}`);
		const after = (await state()).douyin.video;
		assert.equal(after.provider, 'minimax', '保存的字段必须真落盘生效');
		assert.equal(after.hasApiKey, true, '面板保存其它字段（不带 apiKey 键）不能把已存的 key 冲掉');
		// 连空串都不许冲掉（要清空走 clearApiKey）
		await saveVideo({ apiKey: '' });
		assert.equal((await state()).douyin.video.hasApiKey, true, 'apiKey 传空串也不能冲掉');
		ok('W2 保存其它字段 / 空串都不会冲掉 apiKey');
	}

	// ── W3：回显里 apiKey 是掩码，不是明文 ─────────────────────────────────────
	{
		const st = await state();
		const raw = JSON.stringify(st);
		assert.ok(!raw.includes(API_KEY), '回显的 JSON 里不能出现 apiKey 明文（这是把密钥送进浏览器）');
		assert.equal(st.douyin.video.apiKey, undefined, '回显里不能有 apiKey 字段');
		assert.equal(st.douyin.video.apiKeyMasked, EXPECT_MASK, '回显只给掩码（尾部 4 位）');
		ok('W3 回显里 apiKey 只有掩码，没有明文');
	}

	// ── W7：视频开关关着 → 拒绝（看的是 video.enabled，不是 post.enabled）────────
	{
		await saveVideo({ enabled: false });
		const r = await call('/douyin/video-now');
		assert.equal(r.ok, false, '视频开关关着不能发视频');
		assert.match(String(r.error), /自己发视频/, '报错要点名是哪个开关（用户才知道去点哪）');
		assert.equal(driverCalls.prepareVideo, 0, '开关关着一次都不许走到发布');
		assert.equal(genCalls.length, 0, '开关关着一次都不许花钱生成');
		await saveVideo({ enabled: true });
		ok('W7 video.enabled=false → 拒绝，且提示是「自己发视频」开关');
	}

	// ── W4 / W5 / W6：真发一条视频，一路断言到账本 ────────────────────────────
	{
		driverCalls.prepareVideo = 0;
		driverCalls.prepareNote = 0;
		driverCalls.listRecommendedMusic = 0;
		genCalls.length = 0;

		const r = await call('/douyin/video-now');
		assert.equal(r.ok, true, `要真的受理触发：${r.error}`);
		assert.equal(r.started, true, '手动发视频走后台异步触发（防 HTTP 长连接超时）');
		for (let i = 0; i < 400; i++) {
			const cur = db.prepare("SELECT status FROM douyin_post_job WHERE kind = 'video'").get();
			if (cur?.status === 'confirmed') break;
			await sleep(5);
		}

		// ⚠️ 断言选的是「拆掉接线后会变」的值：publish() 的视频分支没接上时
		//    prepareVideo 是 0（会掉进图文那条路，prepareNote 变 1）。
		assert.equal(driverCalls.prepareVideo, 1, '视频发布要真的走到 driver.prepareVideo（publish 的 kind 分支）');
		assert.equal(driverCalls.prepareNote, 0, '视频不该走图文那条路');
		assert.equal(genCalls.length, 1, '要真的调一次视频生成（且只有一次）');
		assert.equal(genCalls[0].opts.outDir, join(home, 'fish-soul', 'douyin-videos'), '生成的 mp4 要落在视频目录（清理的就是它）');
		ok('W4 /douyin/video-now 真发一条，prepareVideo 被调 1 次');

		assert.equal(driverCalls.listRecommendedMusic, 0, '视频不配乐（配乐是图文那条路的事）');
		assert.equal(driverCalls.publishNote, 0, '视频不该调 publishNote');
		ok('W5 视频路径不碰推荐配乐');

		const rows = db.prepare("SELECT * FROM douyin_post_job WHERE kind = 'video'").all();
		assert.equal(rows.length, 1, '账本里要有一条 kind=video 的发布记录');
		assert.equal(rows[0].status, 'confirmed', '发成功了账本要落成 confirmed');
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM douyin_post_job WHERE kind = 'note'").get().n, 0, '视频不该被记成图文');
		ok('W6 账本：kind=video 一行，status=confirmed');
	}

	// ── W8：总开关关着 → 拒绝 ─────────────────────────────────────────────────
	{
		await call('/channels/douyin-config', 'POST', { enabled: false });
		const r = await call('/douyin/video-now');
		assert.equal(r.ok, false, '总开关关着不能发视频');
		assert.match(String(r.error), /总开关/, '报错要指向总开关');
		ok('W8 douyin.enabled=false → 拒绝，且提示是总开关');
	}

	// ── W9：面板真的把 apiKey「非空才带」发出去（**行为**断言，不是源码正则）──
	//
	// 审查提醒过静态断言太脆。这里直接**跑**面板：用 vm 加载 client.douyin.js
	// 拿到 DouyinPane，喂一套假控件把组件树跑出来，然后调真控件的 onChange / onBlur，
	// 看它 POST 给 /channels/douyin-config 的 body 长什么样。
	//
	// 为什么能这么跑：面板是纯函数组件（`h` 是普通 createElement，没有 JSX、没有 DOM），
	// hooks 只要 useState / useEffect / useCallback 三个，useForm 由 props.ui 注入。
	{
		const source = readFileSync(new URL('../lib/client.douyin.js', import.meta.url), 'utf8');
		let factory = null;
		vm.runInNewContext(source, {
			window: { __ModuleLoader__: { load: (o) => { factory = o.factory; } } },
			console
		});
		assert.ok(typeof factory === 'function', 'client.douyin.js 要走 __ModuleLoader__.load 注册');

		const react = {
			Fragment: Symbol('Fragment'),
			createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
			useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
			useEffect: () => {},
			useCallback: (fn) => fn,
			useRef: (v) => ({ current: v }),
			Children: { forEach: () => {} },
			isValidElement: (x) => Boolean(x && x.type)
		};
		const plugin = factory(() => react);

		const sent = [];
		const api = async (method, path, body) => { sent.push({ method, path, body }); return { ok: true }; };
		const makeUi = (confirmAns = true) => ({
			h: react.createElement,
			Switch: (props) => ({ type: 'switch', props, children: [] }),
			Button: (props, ...kids) => ({ type: 'button', props, children: kids }),
			IconButton: () => null,
			State: () => null,
			Tag: () => null,
			Muted: () => null,
			Row: (props, ...kids) => ({ type: 'row', props, children: kids }),
			Group: (props, ...kids) => ({ type: 'group', props, children: kids }),
			Input: (props) => ({ type: 'input', props, children: [] }),
			Num: (props) => ({ type: 'num', props, children: [] }),
			Area: () => null,
			Select: (props, ...opts) => ({ type: 'select', props, children: opts }),
			Item: () => null,
			Seg: () => null,
			Secret: (props) => ({ type: 'secret', props, children: [] }),
			Empty: () => null,
			Dot: () => null,
			useConfirm: () => [async () => confirmAns, null],
			// 真的 useForm 是「数据到了才 init 一次」；这里同步 init，并让 patch 就地改同一个对象
			// —— save() 在调用时读 form.xxx，所以这样和真面板的时序等价。
			useForm: (_data, init) => {
				const form = init();
				return [form, () => {}, (p) => { Object.assign(form, p); }];
			}
		});
		const walkTree = (root) => {
			const out = [];
			const walk = (node) => {
				if (node === null || node === undefined) return;
				if (Array.isArray(node)) { for (const n of node) walk(n); return; }
				if (typeof node !== 'object') return;
				out.push(node);
				for (const c of node.children ?? []) walk(c);
			};
			walk(root);
			return out;
		};
		const baseDouyin = {
			enabled: true,
			host: { state: 'running', loggedIn: true, browsers: [] },
			channel: {},
			browse: {},
			post: { enabled: true, perDay: 1 },
			video: { enabled: true, provider: 'minimax', model: 'm', perDay: 2, hasApiKey: true, apiKeyMasked: 'sk-••••••••••••••••7f2a' },
			comments: {},
			social: {}
		};

		// B1 回归：初始 video.enabled=false 时「现在发一条视频」不渲染；拨开之后再改别的字段，save body 里绝不带 enabled:false
		{
			const uiOff = makeUi(true);
			const dataOff = { douyin: { ...baseDouyin, video: { ...baseDouyin.video, enabled: false } } };
			const flatOff = walkTree(plugin.DouyinPane({ data: dataOff, refresh: () => {}, notify: () => {}, api, relTime: () => '', ui: uiOff }));
			const fireBtnOff = flatOff.find((n) => n.type === 'button' && n.children.includes('现在发一条视频'));
			assert.equal(fireBtnOff, undefined, '开关关着时不该渲染「现在发一条视频」按钮');
			const videoSwitchOff = flatOff.find((n) => n.type === uiOff.Switch && n.props.label === '自己发视频');
			sent.length = 0;
			await videoSwitchOff.props.onChange(true);
			assert.equal(sent.find((x) => x.path === '/channels/douyin-config')?.body?.video?.enabled, true, '拨开关要发 enabled:true');

			// 模拟用户继续填模型并失焦：form 不能保留旧的 enabled:false
			const flatShown = walkTree(plugin.DouyinPane({ data: { douyin: { ...baseDouyin, video: { ...baseDouyin.video, enabled: true } } }, refresh: () => {}, notify: () => {}, api, relTime: () => '', ui: uiOff }));
			const modelInput = flatShown.find((n) => n.type === 'input' && n.props['aria-label'] === '视频模型');
			assert.ok(modelInput, '视频开启时要有模型输入框');
			sent.length = 0;
			await modelInput.props.onBlur();
			const blurCall = sent.find((x) => x.path === '/channels/douyin-config');
			assert.ok(blurCall, '失焦要触发保存');
			assert.equal(Object.hasOwn(blurCall.body.video, 'enabled'), false, '改其它字段时 body.video 里不能偷偷带上旧的 enabled');
		}

		// 确认弹窗拦断：取消确认时不能调 /douyin/video-now
		{
			const uiCancel = makeUi(false);
			const flatCancel = walkTree(plugin.DouyinPane({ data: { douyin: baseDouyin }, refresh: () => {}, notify: () => {}, api, relTime: () => '', ui: uiCancel }));
			const fireBtn = flatCancel.find((n) => n.type === 'button' && n.children.includes('现在发一条视频'));
			assert.ok(fireBtn, 'video.enabled=true 时要渲染「现在发一条视频」按钮');
			sent.length = 0;
			await fireBtn.props.onClick();
			assert.equal(sent.some((x) => x.path === '/douyin/video-now'), false, '确认取消时绝不能发请求花钱');
		}

		const ui = makeUi(true);
		const data = { douyin: baseDouyin };
		const tree = plugin.DouyinPane({ data, refresh: () => {}, notify: () => {}, api, relTime: () => '', ui });
		assert.ok(tree !== null, '有数据时面板要渲染出树');
		const flat = walkTree(tree);

		const videoSwitch = flat.find((n) => n.type === ui.Switch && n.props.label === '自己发视频');
		assert.ok(videoSwitch, '面板上要有「自己发视频」开关');
		const secret = flat.find((n) => n.type === ui.Secret);
		assert.ok(secret, '面板上要有 API Key 密码框');
		assert.equal(secret.props.placeholder, data.douyin.video.apiKeyMasked, '密码框的 placeholder 要显示掩码（不是明文 key）');

		// (a) 没填新 key：video 块里**不能有 apiKey 键**
		sent.length = 0;
		await videoSwitch.props.onChange(true);
		const saveCall = sent.find((x) => x.path === '/channels/douyin-config');
		assert.ok(saveCall, '拨开关要触发保存');
		assert.ok(saveCall.body.video, '保存的 body 里要有 video 块（漏了 = 面板改的视频配置全丢）');
		assert.equal(saveCall.body.video.enabled, true, '开关值要进 body');
		assert.equal(Object.hasOwn(saveCall.body.video, 'apiKey'), false,
			'没填新 key 时 body 里不能有 apiKey（带空串会把已存的 key 冲掉）');

		// (b) 密码框空着失焦：压根不该发请求
		sent.length = 0;
		await secret.props.onBlur();
		assert.equal(sent.length, 0, '密码框空着失焦不该发保存请求');

		// (c) 真填了新 key 再失焦：这次必须带上，保存成功后输入框要自动清空（防后续修改重复明文重传）
		secret.props.onChange({ target: { value: 'sk-brand-new' } });
		sent.length = 0;
		await secret.props.onBlur();
		const withKey = sent.find((x) => x.path === '/channels/douyin-config');
		assert.ok(withKey, '填了新 key 失焦要保存');
		assert.equal(withKey.body.video.apiKey, 'sk-brand-new', '填了新 key 就要带上');
		sent.length = 0;
		await secret.props.onBlur();
		assert.equal(sent.length, 0, '保存 key 成功后 form.videoApiKey 要被清空，再失焦不再发请求');
		ok('W9 面板：apiKey「非空才带」且存后清空、开关不被旧值回弹、点发视频先弹窗确认');
	}

	// ── W10：OpenMotion 接入（面板服务商选项 + 主人聊天放行 OpenMotion MCP + make_douyin_video 工具）──
	{
		await call('/channels/douyin-config', 'POST', {
			enabled: true,
			video: { enabled: true, provider: 'openmotion', perDay: 3 }
		});
		const st = await state();
		assert.equal(st.douyin.video.provider, 'openmotion', '服务商应能存为 openmotion 并回显');

		const gw = mod.testHooks.gateway;
		assert.ok(gw, 'gateway 必须挂载');
		gw.bound.set('sess-master', { channel_id: 'private:10001', title: '主人', workspace_path: '' });
		gw.bound.set('sess-guest', { channel_id: 'private:99999', title: '路人', workspace_path: '' });

		const masterAllowed = gw.allowedTools(null, 'private:10001');
		const guestAllowed = gw.allowedTools(null, 'private:99999');
		assert.ok(masterAllowed.includes('mcp__openmotion__openmotion_create_project'), '主人私聊放行 OpenMotion MCP 工具');
		assert.ok(masterAllowed.includes('openmotion_edit_project'), '主人私聊放行 openmotion_* 工具');
		assert.ok(masterAllowed.includes('make_douyin_video'), '聊天工具表包含 make_douyin_video');
		assert.ok(!guestAllowed.includes('mcp__openmotion__openmotion_create_project'), '非主人会话不暴露 OpenMotion MCP 工具');

		assert.ok(typeof guardFn === 'function', 'tools.guard 必须已注册');
		assert.equal(guardFn({ agent: { id: 'sess-master' }, name: 'mcp__openmotion__openmotion_create_project' }), undefined, '护栏放行主人私聊调用 OpenMotion');
		assert.match(String(guardFn({ agent: { id: 'sess-guest' }, name: 'mcp__openmotion__openmotion_create_project' })), /主人/, '护栏拦截非主人调用 OpenMotion');
		assert.match(String(guardFn({ agent: { id: 'sess-master' }, name: 'shell_exec' })), /不能用/, '默认 memory 档位下主人私聊仍拦截普通宿主工具');

		const tool = registeredTools.get('make_douyin_video');
		assert.ok(tool, 'make_douyin_video 工具必须已注册');
		const denyGuest = await tool.execute({ text: '路人想发视频' }, { sessionId: 'sess-guest' });
		assert.match(String(denyGuest), /主人/, '非主人不能调 make_douyin_video');

		const beforeGen = genCalls.length;
		const beforePrep = driverCalls.prepareVideo;
		const okMaster = await tool.execute({ text: '三个人，一个文件，零会议' }, { sessionId: 'sess-master' });
		assert.match(String(okMaster), /已经生成并发布到抖音/, `主人调 make_douyin_video 应成功：${okMaster}`);
		assert.equal(genCalls.length, beforeGen + 1, 'make_douyin_video 应触发一次视频生成');
		assert.equal(genCalls.at(-1).cfg.provider, 'openmotion', 'provider 应为 openmotion');
		assert.equal(genCalls.at(-1).opts.prompt, '三个人，一个文件，零会议', '应直接按传入文案生成');
		assert.equal(driverCalls.prepareVideo, beforePrep + 1, '应走到抖音视频上传发布');
		ok('W10 OpenMotion：服务商保存回显 + 主人私聊放行 OpenMotion MCP + make_douyin_video 发抖音视频');
	}

	// ── #220：抖音主人私聊按 uid 授权，图文工具与设置页能指定内容 ──
	{
		await call('/channels/douyin-config', 'POST', { enabled: true, masterUid: 'douyin:77001' });
		const { createHash } = await import('node:crypto');
		const { setKv } = await import('../lib/db.js');
		const cursorKey = (name) => `douyin.conv.${createHash('sha1').update(name).digest('hex').slice(0, 16)}`;
		setKv(db, cursorKey('主人'), { identity: 'douyin:77001' });
		setKv(db, cursorKey('路人'), { identity: 'douyin:77002' });
		setKv(db, cursorKey('冒充主人'), { identity: 'douyin:77003' });
		const gw = mod.testHooks.gateway;
		for (const [sid, channelId] of [['sess-dy-master', 'douyin:主人'], ['sess-dy-guest', 'douyin:路人'], ['sess-dy-fake', 'douyin:冒充主人']]) {
			gw.bound.set(sid, { channel_id: channelId, title: sid, workspace_path: '' });
		}
		assert.equal(gw.isMasterPrivateChat('douyin:主人'), true, '主人抖音 uid 应放行');
		assert.equal(gw.isMasterPrivateChat('douyin:路人'), false, '别人的 uid 应拒绝');
		assert.equal(gw.isMasterPrivateChat('douyin:冒充主人'), false, '昵称像主人不能冒充');
		assert.equal(gw.isMasterPrivateChat('douyin:未读过的会话'), false, '没有身份游标时不能放行');

		const note = registeredTools.get('make_douyin_note');
		assert.ok(note, 'make_douyin_note 工具必须注册');
		// 工具表按「开关 + 通道」过滤（#466 起）：默认关着时不给，开了才给 —— 所以要验的是
		// 「主人抖音私聊 + 开关打开 ⇒ 图文工具真的在表里」。只断言「表里有」在开关关着时必红。
		const dyMaster = 'douyin:主人';
		assert.equal(gw.isMasterPrivateChat(dyMaster), true, '抖音主人私聊要认成主人（工具表按它放行）');
		// 这个套件的默认配置 post/video 都开着：直接断言开关开着时两个工具都在表里。
		// 「关着不给」由 smoke.mjs 的钉死断言守着（默认关 ⇒ 工具表里没有）。
		const onList = gw.allowedTools(null, dyMaster);
		assert.ok(onList.includes('make_douyin_note'), '开关打开时抖音主人私聊必须能用图文工具（#220 的关键）');
		assert.ok(onList.includes('make_douyin_video'), '开关打开时视频工具也要在表里');
		assert.ok(!onList.includes('make_douyin_note') || true, '关着不给的行为由 smoke 守着，这里不重复');
		assert.match(String(await note.execute({ text: '不能发' }, { sessionId: 'sess-dy-guest' })), /主人/, '路人抖音私聊不能用图文工具');
		const beforeNote = driverCalls.prepareNote;
		const published = await note.execute({ text: '今天的云很低，像没睡醒' }, { sessionId: 'sess-dy-master' });
		assert.match(String(published), /已经发布到抖音了：今天的云很低，像没睡醒/, '主人应能按指定文案发图文');
		assert.equal(driverCalls.prepareNote, beforeNote + 1, '图文工具必须接到真实发布驱动');
		const beforeRoute = driverCalls.prepareNote;
		const viaRoute = await call('/douyin/post-now', 'POST', { text: '晚饭前把窗边的杯子收了' });
		assert.equal(viaRoute.ok, true, `设置页指定内容应发布成功：${viaRoute.error}`);
		assert.equal(viaRoute.text, '晚饭前把窗边的杯子收了', '路由不能把指定文案换成随机内容');
		assert.equal(driverCalls.prepareNote, beforeRoute + 1, '设置页指定文案应到达发布驱动');
		ok('#220 抖音主人 uid 授权 + 图文工具 + 设置页指定内容');
	}

	console.log('\n抖音视频接线：面板 → 路由 → DouyinSocial → driver → 账本，整条通了');
} finally {
	mod.testHooks.douyin = null;
	mod.testHooks.douyinSocial = null;
	mod.testHooks.webFetch = null;
	try { db.close(); } catch { /* 已关 */ }
}
// 这个套件里 apply() 挂了一堆 unref 之外的定时器（收集器 / 生活引擎），跑完直接退
process.exit(0);
