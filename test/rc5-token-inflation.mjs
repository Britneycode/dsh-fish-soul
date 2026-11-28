/**
 * DSH RC5 token 通胀根因回归与性能验证测试：
 * 1) 模拟 DSH RC5 RuntimeContextProjection：连续 50 轮活跃对话 + 同轮多步工具调用，验证永久 <system-reminder> 追加次数为 0；
 * 2) registerAgentSections：静态 rules section、suppressRuntimeContext()、context required: true 与向后兼容；
 * 3) ChatGateway：sound_read / OpenMotion / MCP 工具过滤、system-prompt/assemble 与 agent/pre-step 作用域过滤；
 * 4) registerExtraTools：options.when 条件激活（桌面会话不挂载 7 个仅聊天工具）；
 * 5) DiaryWriter / SlangLearner / memoryLabel / websearch / SocialBase.personaBlock 上界与幂等验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.js';
import { VirtualClock } from '../lib/clock.js';
import { ChatGateway } from '../lib/gateway.js';
import { registerAgentSections } from '../lib/routes.js';
import { registerExtraTools } from '../lib/index-tools.js';
import { DiaryWriter, behaviorLines } from '../lib/behavior.js';
import { SlangLearner } from '../lib/slang.js';
import { memoryLabel } from '../lib/memory-label.js';
import { formatSearch } from '../lib/websearch.js';
import { SocialBase } from '../lib/social.js';
import { setKv } from '../lib/db.js';

function tmpDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakeAgentCtx() {
	const sections = [];
	const contexts = [];
	const listeners = new Map();
	const restrictions = [];
	let suppressed = false;
	const agentCtx = {
		effect: (fn) => { fn(); return () => {}; },
		tools: {
			restrict: (spec) => restrictions.push(spec),
			definitions: () => [
				{ name: 'remember' }, { name: 'recall' }, { name: 'forget' }, { name: 'chat_search' },
				{ name: 'send_elsewhere' }, { name: 'relay_to_friend' },
				{ name: 'make_douyin_video' }, { name: 'make_douyin_note' }, { name: 'fish_search' },
				{ name: 'scheduled_tasks_list' }, { name: 'scheduled_tasks_update' },
				{ name: 'sound_read' }, { name: 'bash' }, { name: 'read' }, { name: 'write' },
				{ name: 'mcp__filesystem__read_file' }, { name: 'mcp__openmotion__render' }
			]
		},
		systemPrompt: {
			section: (s) => { sections.push(s); return () => {}; },
			context: (c) => { contexts.push(c); return () => {}; },
			suppressRuntimeContext: () => { suppressed = true; }
		},
		on: (event, handler, opts) => {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push({ handler, prepend: Boolean(opts?.prepend) });
			return () => {};
		}
	};
	return { agentCtx, sections, contexts, listeners, restrictions, isSuppressed: () => suppressed };
}

test('registerAgentSections: mounts static rules section, suppresses host context, sets required:true', () => {
	const mock = makeFakeAgentCtx();
	registerAgentSections(mock.agentCtx, {
		personaText: () => '你是测试角色',
		rulesText: () => '[QQ 回复规则] 短消息',
		suppressHostContext: true,
		buildContextBlock: () => '此刻状态',
		log: () => {}
	});
	assert.deepEqual(mock.sections.map((s) => [s.name, s.order]), [
		['fish-soul-persona', 89000],
		['fish-soul-rules', 89100]
	]);
	assert.equal(mock.contexts.length, 1);
	assert.equal(mock.contexts[0].name, 'fish-soul');
	assert.equal(mock.contexts[0].required, true);
	assert.equal(mock.isSuppressed(), true);

	// 省略新参数时保持向后兼容（仅挂 persona + context，不调 suppressRuntimeContext）
	const compat = makeFakeAgentCtx();
	registerAgentSections(compat.agentCtx, {
		personaText: 'compat-persona',
		buildContextBlock: () => 'compat-ctx',
		log: () => {}
	});
	assert.deepEqual(compat.sections.map((s) => s.name), ['fish-soul-persona']);
	assert.equal(compat.isSuppressed(), false);
});

test('ChatGateway: restricts tools cleanly and strips bloated coding/MCP/pre-step injections on restricted chats', async () => {
	const dir = tmpDir('fish-gw-');
	process.env.DSH_HOME = dir;
	const db = openDatabase();
	const ws = join(dir, 'ws');
	mkdirSync(join(ws, '_stickers'), { recursive: true });
	for (let i = 0; i < 45; i++) {
		writeFileSync(join(ws, '_stickers', `s${String(i).padStart(2, '0')}.png`), 'x');
	}
	const cfg = {
		masterQqUin: '10001',
		voice: { enabled: true, saveIncoming: false },
		douyin: { enabled: true, video: { enabled: false, provider: 'openmotion' }, post: { enabled: true } },
		relay: { enabled: true },
		tools: { web: { enabled: false }, sessionAllow: 'memory', masterSessionAllow: 'memory' },
		qq: { sendMode: 'passive', targets: {} }
	};
	const mounted = [];
	const gw = new ChatGateway({
		ctx: { get: () => null },
		db,
		clock: new VirtualClock({ db }),
		getConfig: () => cfg,
		channel: { connected: true, send: async () => {} },
		soul: { beginTurn: async () => {} },
		agentSections: (agentCtx, channelId) => registerAgentSections(agentCtx, {
			personaText: 'p',
			rulesText: `rules:${channelId}`,
			suppressHostContext: true,
			buildContextBlock: () => 'ctx',
			log: () => {}
		}),
		onSectionsMounted: (sid, ch) => mounted.push([sid, ch])
	});
	gw.voiceGuardReady = true;

	// deterministic sticker helper preserves sort & limit while listStickers keeps original behavior
	const s1 = gw.stableStickers(ws, 10);
	const s2 = gw.stableStickers(ws, 10);
	assert.deepEqual(s1, s2);
	assert.equal(s1.length, 10);

	// 1) restricted QQ private session: sound_read off (saveIncoming=false), openmotion off (video.enabled=false), MCP off
	const qqMock = makeFakeAgentCtx();
	await gw.setupAgent(qqMock.agentCtx, 'private:10001');
	const allow = qqMock.restrictions[0]?.allow ?? [];
	assert.ok(!allow.includes('sound_read'), 'saveIncoming=false 时不应暴露 sound_read');
	assert.ok(!allow.includes('mcp__openmotion__render'), 'video.enabled=false 时不应暴露 openmotion');
	assert.ok(!allow.includes('mcp__filesystem__read_file'), '受限会话不暴露 MCP');

	// Verify system-prompt/assemble filter strips host coding/MCP sections and preserves fish-soul-* + harness:identity
	const assembleEntry = qqMock.listeners.get('system-prompt/assemble')[0];
	assert.equal(assembleEntry.prepend, true);
	const filteredAssembly = await assembleEntry.handler(
		null,
		null,
		async () => ({
			sections: [
				{ name: 'harness:identity', text: 'id' },
				{ name: 'harness:source', text: 'source bloat' },
				{ name: 'app:web-surface', text: 'surface bloat' },
				{ name: 'mcp:filesystem', text: 'mcp instructions' },
				{ name: 'tool:bash', text: 'bash manual' },
				{ name: 'tool:web_search', text: 'web manual' },
				{ name: 'fish-soul-persona', text: 'persona' },
				{ name: 'fish-soul-rules', text: 'rules' }
			]
		})
	);
	assert.deepEqual(filteredAssembly.sections.map((s) => s.name), ['harness:identity', 'fish-soul-persona', 'fish-soul-rules']);

	// Verify agent/pre-step strips AGENTS.md, time-context, skill-catalog
	const preStepEntry = qqMock.listeners.get('agent/pre-step')[0];
	assert.equal(preStepEntry.prepend, true);
	const filteredStep = await preStepEntry.handler(
		{},
		async () => ({
			kind: 'enter',
			messages: [
				{ role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md' }] },
				{ role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'time' }] },
				{ role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'skills' }] },
				{ role: 'user', source: { kind: 'fish-soul/qq' }, content: [{ type: 'text', text: '在干嘛' }] }
			]
		})
	);
	assert.deepEqual(filteredStep.messages.map((m) => m.source.kind), ['fish-soul/qq']);

	// 2) sound_read only on QQ when enabled + saveIncoming=true
	cfg.voice.saveIncoming = true;
	const qqVoiceAllow = gw.allowedTools(qqMock.agentCtx, 'private:10001');
	assert.ok(qqVoiceAllow.includes('sound_read'));
	const biliVoiceAllow = gw.allowedTools(qqMock.agentCtx, 'bili:999');
	assert.ok(!biliVoiceAllow.includes('sound_read'), 'B站通道不暴露 sound_read');

	// 3) hostToolNames drops mcp__* even when douyinHostVisible() would be true
	const hNames = gw.hostToolNames(qqMock.agentCtx);
	assert.ok(!hNames.some((n) => n.startsWith('mcp__')));
});

test('registerExtraTools: hides chat-only tools on desktop sessions via options.when', () => {
	const dir = tmpDir('fish-tools-');
	process.env.DSH_HOME = dir;
	const db = openDatabase();
	const registered = [];
	const mockCtx = {
		effect: (fn) => { fn(); return () => {}; },
		tools: {
			register: (def, opts) => registered.push({ name: def.name, when: opts?.when })
		}
	};
	const noop = () => {};
	registerExtraTools(mockCtx, {
		defineTool: (x) => x,
		objectSchema: (x) => ({ type: 'object', properties: x }),
		clock: new VirtualClock({ db }),
		db,
		life: { armPendingAlarm: noop },
		worker: { enqueueRealtime: noop },
		embedder: null,
		embeddingCfg: () => ({}),
		retrievalCfg: () => ({}),
		memoryLabel: () => '',
		nearDuplicateSync: () => null,
		tokenizeForBm25: (x) => x,
		parseRoleIso: () => null,
		sessionForTool: () => ({ ownerId: 'user:master' }),
		UNKNOWN_OWNER: 'user:unknown',
		recall: async () => [],
		reinforce: noop,
		gateway: null,
		douyinSocial: null,
		getConfig: () => ({}),
		webConfig: () => ({ enabled: false }),
		ownSearchReady: () => false,
		runWebSearch: async () => ({ answer: '', results: [] }),
		formatSearch: () => '',
		relaySenderId: () => '',
		parseRelayTarget: () => ({ ok: false, error: 'no' }),
		log: noop,
		toolWhen: {
			send_elsewhere: ({ agent }) => agent?.id === 'qq-master',
			relay_to_friend: ({ agent }) => agent?.id === 'qq-master',
			make_douyin_video: ({ agent }) => agent?.id === 'qq-master',
			make_douyin_note: ({ agent }) => agent?.id === 'qq-master',
			fish_search: ({ agent }) => agent?.id === 'qq-master'
		},
		RELAY_TOOL: 'send_elsewhere',
		RELAY_FRIEND_TOOL: 'relay_to_friend',
		DOUYIN_VIDEO_TOOL: 'make_douyin_video',
		DOUYIN_NOTE_TOOL: 'make_douyin_note',
		OWN_WEB_TOOL: 'fish_search'
	});
	const byName = new Map(registered.map((r) => [r.name, r.when]));
	assert.equal(byName.get('remember'), undefined);
	assert.equal(byName.get('recall'), undefined);
	assert.equal(byName.get('forget'), undefined);
	for (const chatOnly of ['send_elsewhere', 'relay_to_friend', 'make_douyin_video', 'make_douyin_note', 'fish_search']) {
		assert.equal(typeof byName.get(chatOnly), 'function', `${chatOnly} 必须带 when`);
		assert.equal(byName.get(chatOnly)({ agent: { id: 'desktop-default' } }), false, `${chatOnly} 桌面会话隐藏`);
		assert.equal(byName.get(chatOnly)({ agent: { id: 'qq-master' } }), true, `${chatOnly} 对应聊天会话显示`);
	}
});

test('unit bounds: DiaryWriter single-show, deterministic SlangLearner, memoryLabel, websearch, SocialBase.personaBlock', () => {
	const dir = tmpDir('fish-unit-');
	process.env.DSH_HOME = dir;
	const db = openDatabase();
	const now = Date.parse('2026-11-28T10:00:00+08:00');
	setKv(db, 'diary.topics', { date: '2026-11-28', at: now, items: [{ ownerId: 'user:master', topic: '问问昨晚加班累不累' }] });
	const dw = new DiaryWriter({ db, clock: { now: () => now }, worker: null, callLlm: async () => '{}', getConfig: () => ({}), personaName: () => '小鱼', life: null });
	assert.deepEqual(dw.topicsFor('user:master', now), ['问问昨晚加班累不累']);
	assert.deepEqual(dw.topicsFor('user:master', now, { skipShown: true }), ['问问昨晚加班累不累']);
	dw.markTopicsShown('user:master', now);
	assert.deepEqual(dw.topicsFor('user:master', now, { skipShown: true }), []);
	assert.deepEqual(dw.topicsFor('user:master', now), ['问问昨晚加班累不累']);

	// behaviorLines static separation
	const dynOnly = behaviorLines({
		db, getConfig: () => ({ behavior: { moodAffects: false, outFilter: { enabled: true } } }),
		session: { channel: 'qq-private', channelId: 'private:10001' }, known: [{ ownerId: 'user:master', displayName: '主人' }],
		tone: '', now, diary: dw, moods: null, includeStatic: false, diaryTopics: []
	});
	assert.ok(!dynOnly.some((l) => l.includes('[说话方式]')));

	// deterministic slang
	setKv(db, 'slang.global', {
		terms: Array.from({ length: 12 }, (_, i) => ({ term: `词${i}`, meaning: `义${i}` })),
		expressions: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, situation: `场合${i}`, style: `说法${i}`, count: i + 1 }))
	});
	const sl = new SlangLearner({ db, callLlm: async () => '{}', getConfig: () => ({ enabled: true }), personaName: () => '小鱼', titleOf: () => '测试' });
	const outA = sl.contextLines('private:10001', '普通消息', { deterministic: true, maxTerms: 6, maxExpressions: 2 });
	for (let k = 0; k < 20; k++) {
		assert.deepEqual(sl.contextLines('private:10001', '普通消息', { deterministic: true, maxTerms: 6, maxExpressions: 2 }), outA);
	}

	// memoryLabel caps long evidence
	const lbl = memoryLabel({ owner_id: 'user:master', kind: 'fact', content: '喜欢美式', created_at: now, evidence: '长证据'.repeat(60) }, now);
	assert.ok(lbl.length < 130);

	// websearch caps snippet and omits raw URL
	const wsOut = formatSearch('天气', {
		answer: '',
		results: [{ title: '今日天气', url: 'https://example.com/long-tracking-url?x=123456', site: '天气网', date: '2026-11-28', snippet: '晴天'.repeat(180) }]
	});
	assert.ok(!wsOut.includes('https://example.com/long-tracking-url'));
	assert.ok(wsOut.length < 260);

	// SocialBase.personaBlock bounds huge staticText / postHistory / lore
	const longCard = `性格：温柔冷静。\n\n对话示例：\n${'A：示例对话\nB：回复\n'.repeat(120)}\n开场白风格参考：\n${'嗨你好呀\n'.repeat(80)}\n怎么像个活人：\n${'像真人一样\n'.repeat(80)}`;
	const sb = new SocialBase({
		db, clock: { now: () => now }, worker: null, callLlm: async () => '',
		getConfig: () => ({}),
		persona: () => ({
			name: '小鱼', staticText: longCard, anchor: '温和',
			postHistory: '规则'.repeat(300),
			lore: Array.from({ length: 10 }, (_, i) => ({ constant: true, content: `设定${i}:` + '内容'.repeat(60) }))
		})
	});
	const pBlock = sb.personaBlock();
	assert.ok(pBlock.length < 3000, `Social personaBlock expected < 3000 chars, got ${pBlock.length}`);
});

test('E2E RC5 simulation: 50 turns of active QQ conversation produce 0 permanent runtimeContext appends', async () => {
	const dir = tmpDir('fish-rc5-50t-');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = dir;
	try {
		const mod = await import('../lib/index.js');
		const handlers = new Map();
		const registeredTools = [];
		const registeredSections = new Map();
		const registeredContexts = new Map();
		const agentsLive = new Map();
		const wsDir = join(dir, 'fish-soul', 'workspace');
		mkdirSync(wsDir, { recursive: true });
		const agentsSvc = {
			get: (id) => agentsLive.get(id),
			create: async ({ sessionId, setup }) => {
				const a = { id: sessionId, session: { id: sessionId }, ctx: makeFakeAgentCtx() };
				const mockCtx = {
					...a.ctx.agentCtx,
					systemPrompt: {
						section: (s) => {
							if (!registeredSections.has(sessionId)) registeredSections.set(sessionId, []);
							registeredSections.get(sessionId).push(s);
							return () => {};
						},
						context: (c) => {
							registeredContexts.set(sessionId, c);
							return () => {};
						},
						suppressRuntimeContext: () => {}
					}
				};
				await setup?.(mockCtx, a);
				agentsLive.set(sessionId, a);
				return { agent: a, dispose: async () => {} };
			},
			resume: async ({ resumeSessionId, setup }) => {
				const a = { id: resumeSessionId, session: { id: resumeSessionId }, ctx: makeFakeAgentCtx() };
				await setup?.(a.ctx.agentCtx, a);
				agentsLive.set(resumeSessionId, a);
				return { agent: a, dispose: async () => {} };
			}
		};
		const wsReg = {
			create: async (path, title) => ({ path, title, attachSession: async () => {} }),
			list: () => [{ path: wsDir, title: '鱼', sessionIds: [] }]
		};
		const toolsSvc = {
			register: (d, o) => { registeredTools.push({ d, o }); return () => {}; },
			definitions: () => registeredTools.map((x) => x.d),
			get: (n) => registeredTools.find((x) => x.d.name === n)?.d,
			guard: () => () => {}
		};
		const disposers = [];
		const ctx = {
			logger: { info() {}, warn() {}, error() {} },
			agents: agentsSvc,
			workspaceRegistry: wsReg,
			get: (name) => {
				if (name === 'agents') return agentsSvc;
				if (name === 'tools') return toolsSvc;
				if (name === 'workspaceRegistry') return wsReg;
				if (name === 'webServer') return { register: () => () => {} };
				return null;
			},
			tools: toolsSvc,
			webServer: { register: () => () => {} },
			systemPrompt: { section: () => () => {}, context: () => () => {} },
			effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return typeof d === 'function' ? d : () => {}; },
			on: (ev, fn) => { handlers.set(ev, fn); return () => {}; }
		};
		try {
			await mod.apply(ctx, { masterQqUin: '10001' });
			const db = mod.testHooks.gateway.db;
			// 种 60 个表情文件（触发旧代码每次随机洗牌）、多条说话方式
			const stickerDir = join(dir, '_stickers');
			mkdirSync(stickerDir, { recursive: true });
			for (let i = 0; i < 60; i++) writeFileSync(join(stickerDir, `st_${String(i).padStart(2, '0')}.png`), 'x');
			setKv(db, 'slang.private:10001', {
				terms: Array.from({ length: 12 }, (_, i) => ({ term: `词${i}`, meaning: `含义${i}` })),
				expressions: Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, situation: `场景${i}`, style: `语气${i}`, count: i + 1 }))
			});

			// 使用 agent/inbox/inserted 在同一个 QQ 会话下跑 50 轮活跃对话（每轮 >4 字、同 30 分钟窗口）
			const sid = 'qq-50t-sim';
			const mockAgent = {
				id: sid,
				session: { id: sid },
				ctx: {
					effect: (fn) => { fn(); return () => {}; },
					systemPrompt: {
						section: (s) => {
							if (!registeredSections.has(sid)) registeredSections.set(sid, []);
							registeredSections.get(sid).push(s);
							return () => {};
						},
						context: (c) => {
							registeredContexts.set(sid, c);
							return () => {};
						},
						suppressRuntimeContext: () => {}
					}
				}
			};
			const inboxFn = handlers.get('agent/inbox/inserted');
			let prevCtx = null;
			let prevSec = null;
			let runtimeAppends = 0;
			let staticDrifts = 0;
			let staticChars = 0;
			let maxCtxChars = 0;
			const msgs = ['今天中午吃了黄焖鸡米饭', '晚上下班准备去超市买点水果', '明天还要早起开个周会真是困死了', '刚买了一杯冰美式提提神', '你在家有没有乖乖待着呀'];
			for (let turn = 0; turn < 50; turn++) {
				inboxFn({
					agent: mockAgent,
					message: { role: 'user', content: [{ type: 'text', text: msgs[turn % msgs.length] }], source: { kind: 'user-qq', userId: '10001', nickname: '主人' } }
				});
				const arg = { agent: mockAgent };
				const secs = registeredSections.get(sid) ?? [];
				const secText = secs.map((s) => (typeof s.text === 'function' ? s.text(arg) : s.text)).join('\n');
				const ctxText = registeredContexts.get(sid).text(arg);
				staticChars = secText.length;
				if (ctxText.length > maxCtxChars) maxCtxChars = ctxText.length;
				assert.ok(!ctxText.includes('[QQ 回复规则]'), '静态规则不再重复出现在每轮 runtime context');
				assert.ok(!ctxText.includes('[别被带跑]'), '防带跑声明不再出现在每轮 runtime context');
				assert.ok(!ctxText.includes('[说话方式]'), '说话方式不再出现在每轮 runtime context');
				assert.ok(!ctxText.includes('[记住你是谁]'), '人格锚点不再出现在每轮 runtime context');
				assert.ok(!ctxText.includes('[上网]'), '上网声明不再出现在每轮 runtime context');
				assert.ok(secText.includes('[QQ 回复规则]') && secText.includes('[别被带跑]') && secText.includes('[说话方式]'), '静态规则完整保留在 section');
				if (prevSec !== null && prevSec !== secText) staticDrifts++;
				if (prevCtx !== null && prevCtx !== ctxText) runtimeAppends++;
				prevSec = secText;
				prevCtx = ctxText;
			}
			assert.equal(staticDrifts, 0, `预期 50 轮静态 section 0 漂移（保持 KV Cache），实际 ${staticDrifts}`);
			assert.equal(runtimeAppends, 0, `预期同 30 分钟活跃连聊 50 轮 0 次 runtime context 漂移追加，实际 ${runtimeAppends} 次`);
			assert.ok(staticChars > 0 && maxCtxChars < 500, `瞬态 context 上界应 <500 chars，实际 ${maxCtxChars}`);

			// 验证单轮内多步工具调用（Step 1 -> Step 2）严格冻结瞬态上下文
			const turnObj = { channelId: 'private:10001', replyChannel: 'private:10001' };
			mod.testHooks.gateway.turns.set(sid, turnObj);
			const step1 = registeredContexts.get(sid).text({ agent: mockAgent });
			setKv(db, 'slang.private:10001', { terms: [{ term: '新梗', meaning: '测试变更' }], expressions: [] });
			const step2 = registeredContexts.get(sid).text({ agent: mockAgent });
			assert.equal(step2, step1, '同一轮内多步重算必须命中 _turnContextBlock 冻结快照');
			mod.testHooks.gateway.turns.delete(sid);

			const desktopAgent = { id: 'desktop-other-session' };
			for (const x of registeredTools) {
				if (['send_elsewhere', 'relay_to_friend', 'make_douyin_video', 'make_douyin_note', 'fish_search', 'scheduled_tasks_list', 'scheduled_tasks_update'].includes(x.d.name)) {
					assert.equal(typeof x.o?.when, 'function', `${x.d.name} 必须配置 when`);
					assert.equal(x.o.when({ agent: desktopAgent }), false, `${x.d.name} 在普通桌面会话不暴露`);
				}
			}
			console.log(`[benchmark] BEFORE(~RC5 baseline): +2100~3000 tok/turn permanent reminder appends | AFTER(50 turns): static=${staticChars} chars (0 drifts), volatileMax=${maxCtxChars} chars, rc5Appends=${runtimeAppends}/50`);
		} finally {
			for (const d of disposers) { try { d(); } catch {} }
		}
	} finally {
		process.env.DSH_HOME = prevHome;
	}
});
