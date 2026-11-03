import assert from 'node:assert/strict';
import { registerAgentSections, registerAgentHooks } from '../lib/routes.js';
import { ChatGateway } from '../lib/gateway.js';

const ok = (name) => console.log('✓', name);
const logs = [];
const log = (level, msg) => logs.push([level, msg]);
/** 只给 Outbox 建表用的最小 db（这个测试不碰记忆库）。 */
const fakeDb = {
	exec() {},
	prepare() { return { run() {}, get() { return { n: 0 }; }, all() { return []; } }; }
};

// ── 1 按 agent 注册：两段都挂到 agentCtx 自己的 systemPrompt 上 ──
function fakeAgentCtx({ withPrompt = true } = {}) {
	const got = { section: null, context: null, effects: 0 };
	const ctx = {
		effect(fn) {
			got.effects += 1;
			const dispose = fn();
			return typeof dispose === 'function' ? dispose : () => {};
		}
	};
	if (withPrompt) {
		ctx.systemPrompt = {
			section: (s) => { got.section = s; return () => {}; },
			context: (c) => { got.context = c; return () => {}; }
		};
	}
	return { ctx, got };
}

{
	const { ctx, got } = fakeAgentCtx();
	const built = [];
	const okAll = registerAgentSections(ctx, {
		personaText: () => '我是小鱼',
		buildContextBlock: (arg) => { built.push(arg); return '此刻状态'; },
		log
	});
	assert.equal(okAll, true, '两段都挂上要返回 true');
	assert.equal(got.section.name, 'fish-soul-persona');
	assert.equal(got.section.order, 89000);
	assert.equal(got.section.interpolate, false);
	assert.equal(got.section.text({ agent: { id: 'S1' } }), '我是小鱼', 'agent 段不再按 id 过滤：本来就只属于这个会话');
	assert.equal(got.context.name, 'fish-soul');
	assert.equal(got.context.order, 900);
	const arg = { agent: { id: 'S1' } };
	assert.equal(got.context.text(arg), '此刻状态');
	assert.deepEqual(built, [arg], '瞬态块还是按宿主的 arg 现算');
	assert.equal(got.effects, 2, '两段都走 effect（agent 释放时自动回收）');
	ok('registerAgentSections：人格 + 瞬态块挂在 agent 自己的 ctx 上');
}

// ── 2 宿主不给 agent 级 systemPrompt：不抛、返回 false，让全局兜底接手 ──
{
	const { ctx } = fakeAgentCtx({ withPrompt: false });
	logs.length = 0;
	const okAll = registerAgentSections(ctx, { personaText: () => 'x', buildContextBlock: () => 'y', log });
	assert.equal(okAll, false);
	assert.equal(logs.filter(([lv]) => lv === 'warn').length, 2, '两段各记一条 warn');
	ok('挂不上时安静退回（不抛错，调用方保留全局过滤）');
}

// ── 3 全局兜底：自己的会话让位，别人的会话照旧 ──
function fakeGlobalCtx() {
	const got = {};
	const ctx = {
		effect(fn) { fn(); return () => {}; },
		systemPrompt: {
			section: (s) => { got.section = s; return () => {}; },
			context: (c) => { got.context = c; return () => {}; }
		},
		on: (ev, h) => { got[`on:${ev}`] = h; return () => {}; }
	};
	return { ctx, got };
}

{
	const { ctx, got } = fakeGlobalCtx();
	const scoped = new Set(['S1']);
	const fish = new Set(['S1', 'fish-native']);
	let noted = 0;
	registerAgentHooks(ctx, {
		personaText: () => '我是小鱼',
		buildContextBlock: () => '此刻状态',
		noteInteraction: () => { noted += 1; },
		isFishSession: (arg) => fish.has(String(arg?.agent?.id ?? '')),
		isAgentScoped: (arg) => scoped.has(String(arg?.agent?.id ?? '')),
		log
	});
	assert.equal(got.section.text({ agent: { id: 'S1' } }), '', '按 agent 挂过的会话：全局段必须让位，否则注两遍');
	assert.equal(got.context.text({ agent: { id: 'S1' } }), '', '瞬态块同理');
	assert.equal(got.section.text({ agent: { id: 'fish-native' } }), '我是小鱼', '鱼的 DSH 原生会话（没有 agent 段）走全局兜底');
	assert.equal(got.section.text({ agent: { id: 'tech' } }), '', '不是鱼的会话：整块不给');
	assert.equal(got.context.text({ agent: { id: 'tech' } }), '', '不是鱼的会话：瞬态块也不给');
	got['on:agent/inbox/inserted']({ agent: { id: 'S1' } });
	assert.equal(noted, 1, '互动登记还是全局监听');
	ok('registerAgentHooks：全局兜底只服务没按 agent 挂过的鱼的会话');
}

// ── 4 网关接线：setup 时把 agentCtx 和自己的 agent 一起交出去 ──
{
	const calls = [];
	const ctx = {
		get: (n) => (n === 'agents' ? { get: () => undefined, resume: async () => ({ agent: { id: 'S2' } }) } : undefined),
		tools: { get: () => undefined }
	};
	const gw = new ChatGateway({
		ctx, db: fakeDb, clock: { now: () => 0 }, getConfig: () => ({ qq: {} }), log,
		channel: { connected: true, send: async () => '' },
		soul: {}, agentPrompt: (agentCtx, agent) => { calls.push([agentCtx, agent]); return true; }
	});
	const { ctx: agentCtx } = fakeAgentCtx();
	await gw.setupAgent(agentCtx, 'private:1', { id: 'S2' });
	assert.equal(calls.length, 1, 'setupAgent 要把 agentPrompt 叫起来');
	assert.equal(calls[0][0], agentCtx);
	assert.deepEqual(calls[0][1], { id: 'S2' }, '宿主 setup 的第二个参数（agent）要一路传下去，好记账哪些会话已按 agent 挂过');
	assert.equal(gw.agentPrompt !== null, true);
	// 没配 agentPrompt 的旧构造也要能跑（本地测试 / 老代码路径）
	const gw2 = new ChatGateway({ ctx, db: fakeDb, clock: { now: () => 0 }, getConfig: () => ({ qq: {} }), log, channel: { connected: true, send: async () => '' }, soul: {} });
	await gw2.setupAgent(agentCtx, 'private:1', { id: 'S3' });
	assert.equal(gw2.agentPrompt, null);
	ok('gateway.setupAgent：把 agentCtx + agent 交给 agentPrompt（没配也不炸）');
}

// ── 5 agentPrompt 抛错不影响建会话 ──
{
	const ctx = {
		get: (n) => (n === 'agents' ? { get: () => undefined, resume: async () => ({ agent: { id: 'S4' } }) } : undefined),
		tools: { get: () => undefined }
	};
	logs.length = 0;
	const gw = new ChatGateway({
		ctx, db: fakeDb, clock: { now: () => 0 }, getConfig: () => ({ qq: {} }), log,
		channel: { connected: true, send: async () => '' }, soul: {},
		agentPrompt: () => { throw new Error('宿主不认 agentCtx.systemPrompt'); }
	});
	await gw.setupAgent(fakeAgentCtx().ctx, 'private:1', { id: 'S4' });
	assert.equal(logs.some(([lv, msg]) => lv === 'warn' && msg.includes('按 agent 挂人格失败')), true, '失败只记 warn');
	ok('agentPrompt 出错只记 warn，不拖垮建会话');
}

console.log('per-agent-sections: 全过');
