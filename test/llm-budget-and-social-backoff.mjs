// 回归测试：每日后台模型预算、失败次数与冷却状态、B站/抖音评论空回复退避、[不回] 正则修复，以及大文件拆出契约。
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-llm-budget-');
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
const { openDatabase, setKv } = await import('../lib/db.js');
const db = openDatabase();
process.env.DSH_HOME = prevHome;

const { LlmRouter } = await import('../lib/llm.js');
const { handleV07Route } = await import('../lib/routes-v07.js');
const { BiliSocial } = await import('../lib/social.js');
const { DouyinSocial } = await import('../lib/douyin-social.js');
const { fishSoulConfigSchema } = await import('../lib/config-schema.js');

const ok = (msg) => console.log('✓', msg);

const makeRouter = (localDb, script, { cfg = {}, host = null, now } = {}) => {
	const calls = [];
	const ctx = {
		get: (n) => {
			if (n === 'llm') return {
				listProviders: () => [{ id: 'p1', name: 'P1' }],
				listModels: async () => [{ id: 'm1', name: 'M1' }],
				async *stream(o) {
					calls.push({ model: o.model, maxTokens: o.maxTokens });
					yield* script(calls.length - 1, o);
				}
			};
			if (n === 'agentDefaultModel') return { currentSelection: () => host };
			return undefined;
		}
	};
	const router = new LlmRouter({ ctx, db: localDb, getConfig: () => cfg, now });
	return { router, calls };
};

try {
	// 1. config-schema 默认 llmBudget 全为 0（不限）
	{
		const makeNode = (def, shape = null) => new Proxy({ __def: def, __shape: shape }, {
			get(target, prop) {
				if (prop in target) return target[prop];
				if (prop === 'default') return (v) => makeNode(v, target.__shape);
				return () => makeNode(target.__def, target.__shape);
			}
		});
		const fakeZ = {
			object: (shape) => makeNode({}, shape),
			string: () => makeNode(''),
			number: () => makeNode(0),
			boolean: () => makeNode(false),
			array: () => makeNode([]),
			dict: () => makeNode({}),
			any: () => makeNode(null)
		};
		const schema = fishSoulConfigSchema(fakeZ);
		assert.ok(schema.__shape.llmBudget, 'schema 必须包含 llmBudget');
		assert.deepEqual(schema.__shape.llmBudget.__def, {}, 'llmBudget 默认为空对象');
		assert.equal(schema.__shape.llmBudget.__shape.dailyCalls.__def, 0);
		assert.equal(schema.__shape.llmBudget.__shape.dailyTokens.__def, 0);
		ok('config-schema：llmBudget 默认为 { dailyCalls: 0, dailyTokens: 0 }');
	}

	// 2. LlmRouter 每日调用次数 & token 上限 + 按角色日历天重置
	{
		let clockMs = Date.parse('2026-11-26T23:59:50+08:00');
		const cfg = { llmBudget: { dailyCalls: 2, dailyTokens: 0 } };
		const { router, calls } = makeRouter(db, function* () {
			yield { type: 'text-delta', text: '{"ok":1}' };
			yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 20 } };
			yield { type: 'finish', reason: { kind: 'stop' } };
		}, { cfg, now: () => clockMs });

		assert.equal(await router.call('a', { feature: 'dream' }), '{"ok":1}');
		assert.equal(await router.call('b', { feature: 'dream' }), '{"ok":1}');
		const f1 = {};
		assert.equal(await router.call('c', { feature: 'dream', failureInfo: f1 }), null);
		assert.equal(f1.code, 'budget_exceeded');
		assert.equal(calls.length, 2, '达到 dailyCalls 上限后不再发模型请求');

		// 跨过 UTC+8 零点：新一天的次数重置，可以继续调
		clockMs = Date.parse('2026-11-27T00:00:05+08:00');
		assert.equal(await router.call('d', { feature: 'dream' }), '{"ok":1}');
		assert.equal(calls.length, 3);

		// dailyTokens 上限：累计 in+out = 60，设上限 60 直接拦下一次
		cfg.llmBudget = { dailyCalls: 0, dailyTokens: 60 };
		const f2 = {};
		assert.equal(await router.call('e', { feature: 'dream', failureInfo: f2 }), null);
		assert.equal(f2.code, 'budget_exceeded');
		assert.equal(calls.length, 3, '达到 dailyTokens 上限后不再发模型请求');
		ok('LlmRouter：dailyCalls / dailyTokens 护栏生效且跨天清零');
	}

	// 3. 失败次数按模型统计 & modelStatus 实时冷却状态
	{
		let clockMs = Date.parse('2026-11-26T12:00:00+08:00');
		let shouldFail = true;
		const cfg = { models: { dream: { provider: 'p1', model: 'm1' } } };
		const { router } = makeRouter(db, function* () {
			if (shouldFail) {
				yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } } };
				return;
			}
			yield { type: 'text-delta', text: 'ok' };
			yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
			yield { type: 'finish', reason: { kind: 'stop' } };
		}, { cfg, now: () => clockMs });

		for (let i = 0; i < 3; i++) await router.call('x', { feature: 'dream' });
		const st = router.modelStatus();
		assert.equal(st.m1.key, 'p1/m1');
		assert.equal(st.m1.streak, 3);
		assert.equal(st.m1.cooling, true);
		assert.ok(st.m1.cooldownMs > 0, '连败 3 次后进入冷却并暴露在 modelStatus');
		const u = router.usage(1);
		assert.equal(u.byModel.m1.failed, 3, 'byModel[m].failed 统计失败次数');

		// 冷却期过且恢复成功：modelStatus 清空，但历史 failed 次数保留
		clockMs += st.m1.cooldownMs + 1000;
		shouldFail = false;
		assert.equal(await router.call('x', { feature: 'dream' }), 'ok');
		assert.deepEqual(router.modelStatus(), {}, '恢复后冷却状态清空');
		assert.equal(router.usage(1).byModel.m1.failed, 3);
		ok('LlmRouter：byModel[m].failed 计数与 modelStatus 冷却恢复正确');
	}

	// 4. /models/state 与 /models/config 路由
	{
		const cfg = { llmBudget: { dailyCalls: 12, dailyTokens: 5000 } };
		const saved = [];
		const { router } = makeRouter(db, function* () {
			yield { type: 'text-delta', text: 'ok' };
			yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
			yield { type: 'finish', reason: { kind: 'stop' } };
		}, { cfg });
		let lastResp = null;
		const handledGet = await handleV07Route({
			method: 'GET', path: '/models/state', url: new URL('http://localhost/models/state'),
			req: {}, res: {}, send: (_code, body) => { lastResp = body; },
			readBody: async () => '', sameOrigin: () => true,
			deps: { db, getConfig: () => cfg, saveConfig: () => {}, llmRouter: router }
		});
		assert.equal(handledGet, true);
		assert.equal(lastResp.ok, true);
		assert.deepEqual(lastResp.budget, { dailyCalls: 12, dailyTokens: 5000 });
		assert.ok('modelStatus' in lastResp && 'todayUsage' in lastResp);

		let postResp = null;
		const handledPost = await handleV07Route({
			method: 'POST', path: '/models/config', url: new URL('http://localhost/models/config'),
			req: {}, res: {}, send: (_code, body) => { postResp = body; },
			readBody: async () => JSON.stringify({ budget: { dailyCalls: -3, dailyTokens: 9999.7 } }),
			sameOrigin: () => true,
			deps: { db, getConfig: () => cfg, saveConfig: (p) => saved.push(p), llmRouter: router }
		});
		assert.equal(handledPost, true);
		assert.equal(postResp.ok, true);
		assert.deepEqual(saved[0].llmBudget, { dailyCalls: 0, dailyTokens: 9999 }, 'cleanBudget 归整并拦截负数');
		ok('routes-v07：/models/state 与 /models/config 读写预算与状态正确');
	}

	// 5. BiliSocial 评论轮询空回复指数退避（10m → 20m → ... 封顶 60m）
	{
		let clockMs = 1_700_000_000_000;
		const nowSec = Math.floor(Date.now() / 1000);
		let feedReads = 0;
		let llmAnswer = '';
		setKv(db, 'bili.comments.cursor', { time: nowSec - 60 });
		const social = new BiliSocial({
			db,
			clock: { now: () => clockMs, getRoleDateParts: () => ({ dateStr: '2026-11-26' }) },
			client: {
				uid: 999,
				loggedIn: true,
				authInvalid: false,
				replyFeed: async () => {
					feedReads++;
					return [{ id: 'c1', rpid: 1, oid: 10, root: 1, type: 1, mid: 123, name: '路人', title: '视频', content: '你好', time: nowSec }];
				},
				replyComment: async () => ({ ok: true })
			},
			getConfig: () => ({ enabled: true, comments: { enabled: true, perHour: 10 } }),
			callLlm: async () => llmAnswer,
			replyGapMs: 0,
			now: () => clockMs
		});

		await social.pollComments();
		assert.equal(social.commentFailStreak, 1);
		assert.equal(social.commentRetryAfter, clockMs + 10 * 60_000);

		clockMs += 5 * 60_000;
		const skippedPoll = await social.pollComments();
		assert.equal(skippedPoll.backoff, true);
		assert.equal(feedReads, 1, '退避窗口内不再次拉取评论');

		clockMs += 5 * 60_000;
		await social.pollComments();
		assert.equal(social.commentFailStreak, 2);
		assert.equal(social.commentRetryAfter, clockMs + 20 * 60_000, '连续空回复退避翻倍至 20 分钟');

		clockMs += 20 * 60_000;
		llmAnswer = '谢谢你呀';
		const okPoll = await social.pollComments();
		assert.equal(okPoll.replied, 1);
		assert.equal(social.commentFailStreak, 0);
		assert.equal(social.commentRetryAfter, 0);
		ok('BiliSocial：评论空回复指数退避与恢复清零正确');
	}

	// 6. DouyinSocial：空回复退避 + /[不回]/ 不再误杀 "不错" / "回头见"
	{
		let clockMs = 1_700_000_000_000;
		let llmReply = '';
		const sentReplies = [];
		setKv(db, 'douyin.comments.seeded', true);
		let comments = [
			{ cid: 'dc1', author: '甲', content: '加油', isAuthor: false, canReply: true },
			{ cid: 'dc2', author: '乙', content: '拜拜', isAuthor: false, canReply: true },
			{ cid: 'dc3', author: '丙', content: '哈哈', isAuthor: false, canReply: true }
		];
		const answers = ['', '不错呀', '回头见', '[不回]'];
		let idx = 0;
		const social = new DouyinSocial({
			db,
			clock: { now: () => clockMs, getRoleDateParts: () => ({ dateStr: '2026-11-26' }) },
			getConfig: () => ({ enabled: true, comments: { enabled: true, perHour: 10 } }),
			callLlm: async () => { llmReply = answers[idx++] ?? ''; return llmReply; },
			worker: { enqueueRealtime: () => {} },
			host: { running: true, loggedIn: true, exclusive: async (_l, fn) => fn() },
			driver: {
				listWorks: async () => [{ id: 'w1', title: '视频', kind: 'video' }],
				openWork: async () => ({ ok: true }),
				listComments: async () => comments,
				replyApi: async ({ cid, text }) => { sentReplies.push({ cid, text }); return { ok: true }; }
			},
			replyGapMs: 0,
			now: () => clockMs
		});

		await social.pollComments();
		assert.equal(social.commentFailStreak, 1);
		const b1 = await social.pollComments();
		assert.equal(b1.backoff, true);

		clockMs += 10 * 60_000;
		const r2 = await social.pollComments();
		assert.equal(r2.replied, 2, '含「不错」「回头见」的回复不能被误杀');
		assert.equal(r2.skipped, 1, '[不回] 正常跳过');
		assert.deepEqual(sentReplies.map((x) => x.text), ['不错呀', '回头见']);
		assert.equal(social.commentFailStreak, 0);
		ok('DouyinSocial：空回复退避与 /\\[不回\\]/ 正则修复有效');
	}

	// 7. 拆出契约与行数守卫（< 1500 行 & 导出完整）
	{
		for (const file of ['lib/channels/douyin.js', 'lib/gateway.js', 'lib/index.js']) {
			const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/).length;
			assert.ok(lines < 1500, `${file} 拆完必须严格 < 1500 行（当前 ${lines}）`);
		}
		const dy = await import('../lib/channels/douyin.js');
		assert.equal(typeof dy.DouyinHost, 'function');
		assert.equal(typeof dy.convTimeMs, 'function');
		const gw = await import('../lib/gateway.js');
		assert.equal(typeof gw.ChatGateway.prototype.ensureSession, 'function');
		assert.equal(typeof gw.ChatGateway.prototype.dispatch, 'function');
		assert.equal(typeof gw.ChatGateway.prototype.onSessionEvent, 'function');
		const toolsMod = await import('../lib/index-tools.js');
		assert.equal(typeof toolsMod.registerExtraTools, 'function');
		ok('拆分文件行数 (<1500) 与对外导出契约完整');
	}

	// 8. client.models.js 端到端渲染与预算输入框状态同步
	{
		let cfg = { models: { dream: { provider: 'p1', model: 'm1' } }, llmBudget: { dailyCalls: 25, dailyTokens: 50000 } };
		const { router } = makeRouter(db, function* () {
			yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } } };
		}, { cfg });
		for (let i = 0; i < 3; i++) await router.call('ui-test', { feature: 'dream' });

		const pendingLoads = [];
		const api = async (method, path, body) => {
			let out = null;
			const p = handleV07Route({
				method, path, url: new URL(`http://localhost${path}`), req: {}, res: {},
				send: (_c, b) => { out = b; },
				readBody: async () => JSON.stringify(body ?? {}),
				sameOrigin: () => true,
				deps: {
					db, getConfig: () => cfg,
					saveConfig: (patch) => { cfg = { ...cfg, ...patch }; },
					llmRouter: router,
					voice: { ready: () => false, status: () => ({}) },
					webConfig: () => ({ enabled: false, perDay: 20, provider: 'host', apiKey: '', baseURL: '' })
				}
			});
			pendingLoads.push(p);
			await p;
			return out;
		};

		const prevWindow = globalThis.window;
		let chunkMod = null;
		globalThis.window = {
			__ModuleLoader__: {
				load: ({ factory }) => {
					const states = [];
					let idx = 0;
					const fakeReact = {
						Fragment: 'Fragment',
						useState: (init) => {
							const i = idx++;
							if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
							return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
						},
						useCallback: (fn) => fn,
						useEffect: () => {}
					};
					chunkMod = { exports: factory(() => fakeReact), resetHooks: () => { idx = 0; }, states };
				}
			}
		};
		try {
			new Function(readFileSync(new URL('../lib/client.models.js', import.meta.url), 'utf8'))();
			const stateData = await api('GET', '/models/state');
			const h = (tag, props, ...children) => ({
				tag,
				props: props ?? {},
				children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
			});
			const ui = {
				h,
				Group: (p, ...c) => h('Group', p, ...c),
				Row: (p, ...c) => h('Row', p, ...c),
				Select: (p, ...c) => h('Select', p, ...c),
				Muted: (t) => h('Muted', {}, t),
				State: (k, t) => h('State', { kind: k }, t),
				Seg: (p) => h('Seg', p),
				Num: (p) => h('Num', p),
				Empty: (t) => h('Empty', {}, t),
				Tag: (t, k) => h('Tag', { kind: k }, t),
				Switch: (p) => h('Switch', p),
				Secret: (p) => h('Secret', p),
				Input: (p) => h('Input', p),
				Button: (p, ...c) => h('Button', p, ...c)
			};
			const render = (node) => {
				if (!node || typeof node !== 'object') return node;
				if (typeof node.tag === 'function') return render(node.tag(node.props));
				return { ...node, children: (node.children ?? []).map(render) };
			};
			const collect = (node, acc = []) => {
				if (!node) return acc;
				if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
				if (node.props?.title) acc.push(node.props.title);
				if (node.props?.meta) acc.push(node.props.meta);
				if (node.tag === 'Tag') acc.push(`[Tag:${node.props.kind}:${node.children.join('')}]`);
				(node.children ?? []).forEach((c) => collect(c, acc));
				return acc;
			};
			const findNums = (node, out = []) => {
				if (!node || typeof node !== 'object') return out;
				if (node.tag === 'Num') out.push(node);
				(node.children ?? []).forEach((c) => findNums(c, out));
				return out;
			};
			const mountUsage = () => {
				chunkMod.resetHooks();
				return render(chunkMod.exports.ModelsPane({ api, notify: (m) => { throw new Error(m); }, ui, section: 'usage' }));
			};

			chunkMod.states[0] = stateData;
			const t1 = mountUsage();
			const texts = collect(t1);
			assert.ok(texts.some((x) => x.includes('每日后台上限')), '应渲染每日后台上限');
			assert.ok(texts.some((x) => x.includes('今日已用')), '应渲染今日已用统计');
			assert.ok(texts.some((x) => /（失败 \d+）/.test(x)), '应渲染失败次数');
			assert.ok(texts.some((x) => x.includes('[Tag:warning:冷却 ')), '应渲染冷却警告标签');

			const nums1 = findNums(t1);
			const callsInput = nums1.find((n) => n.props['aria-label'] === '每日调用上限');
			const tokInput = nums1.find((n) => n.props['aria-label'] === '每日 token 上限');
			callsInput.props.onChange({ target: { value: '88' } });
			tokInput.props.onChange({ target: { value: '120000' } });
			const t2 = mountUsage();
			await findNums(t2).find((n) => n.props['aria-label'] === '每日调用上限').props.onBlur();
			assert.deepEqual(cfg.llmBudget, { dailyCalls: 88, dailyTokens: 120000 });

			// 负数归零后，输入框也必须同步清成空串（不再残留 "-5"）
			findNums(t2).find((n) => n.props['aria-label'] === '每日调用上限').props.onChange({ target: { value: '-5' } });
			const t3 = mountUsage();
			await findNums(t3).find((n) => n.props['aria-label'] === '每日调用上限').props.onBlur();
			assert.deepEqual(cfg.llmBudget, { dailyCalls: 0, dailyTokens: 120000 });
			const t4 = mountUsage();
			assert.equal(findNums(t4).find((n) => n.props['aria-label'] === '每日调用上限').props.value, '');
			await Promise.allSettled(pendingLoads);
		} finally {
			globalThis.window = prevWindow;
		}
		ok('client.models.js：用量渲染、冷却标签与预算归零回显正确');
	}
} finally {
	db.close();
	rmSync(home, { recursive: true, force: true });
}
