/**
 * 探针（端到端）：用**真实宿主的 agent 工厂**跑 `ctx.agents.create({ setup })`，确认
 *   1) setup(agentCtx) 里注册的人格段 / 瞬态块真进得了那个 agent 的 prompt 组装；
 *   2) 完全不外溢到宿主自己建的会话（不注册全局段就没有 provider）；
 *   3) agent 释放后自动摘掉。
 *
 * 和 probe-per-agent.mjs 的区别：那个只验 SystemPrompt 的 scope 语义；这个走真 AgentLoop 工厂
 * （agentCtx 的 service 解析链、未发布 setup 事务、enter/announce 时序都是真的）。
 *
 * 依赖：`@deepseek-ai/dsh-agent-loop@0.1.0-rc.6`（不在用户装机目录里）。跑法见 RUNBOOK。
 * 只读：不碰 soul.db、不写仓库文件。
 */
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionStore from '@deepseek-ai/dsh-session';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';

const ctx = new Context();
// 装机 bundle 里这些是各自独立挂的；探针按最小集合手动挂，让 loop 的 inject 能解析出来
ctx.plugin(SystemPrompt, {});
ctx.plugin(AgentRegistry, {});
ctx.plugin(SessionStore, {});
ctx.plugin(ToolRuntime, {});
ctx.plugin(LlmRuntime, {});
ctx.plugin(AgentLoop, {});
await new Promise((r) => setTimeout(r, 1200));
// loop 的服务齐全了才说明装配成功（缺 sessions / llm / tools 时 apply 根本不会跑）
console.log('装配：', ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
	.map((n) => `${n}=${ctx.get(n) === undefined ? '✗' : '✓'}`).join(' '));

let passed = false;
let failed = null;

// 模拟插件：一个会话挂人格（per-agent），另一个不挂（宿主自己的会话）
ctx.plugin({
	inject: ['systemPrompt', 'agents'],
	apply: async (pluginCtx) => {
		try {
			const sp = pluginCtx.systemPrompt;
			// 宿主自己也是这么组装的：scope 就是 agent 本身（assembleContextFor 的写法）
			const asmOf = (agent) => sp.assemble(assembleContextFor(agent));
			const promptOf = async (agent) => renderPrompt(await asmOf(agent));

			const fish = await pluginCtx.agents.create({
				sessionId: 'fish-session-1',
				meta: { cwd: process.cwd() },
				setup: (agentCtx) => {
					agentCtx.effect(() => agentCtx.systemPrompt.section({
						name: 'fish-soul-persona', order: 89000, interpolate: false, text: '你是小鱼，住在杭州。'
					}));
					agentCtx.effect(() => agentCtx.systemPrompt.context({
						name: 'fish-soul', order: 900, text: '此刻状态：正在复习高数。'
					}));
				}
			});

			const host = await pluginCtx.agents.create({
				sessionId: 'host-session-1',
				meta: { cwd: process.cwd() }
			});

			const fishPrompt = await promptOf(fish.agent);
			const hostPrompt = await promptOf(host.agent);
			assert.match(fishPrompt, /你是小鱼，住在杭州/, '鱼的会话应该拿到人格段（setup 注册真的进了组装）');
			assert.doesNotMatch(hostPrompt, /小鱼/, '宿主自己的会话不该拿到人格段');

			// 瞬态块走 contexts 通道，不混进 renderPrompt
			const asm = await asmOf(fish.agent);
			assert.match(asm.contexts.map((c) => c.text).join('\n'), /正在复习高数/, '瞬态块进了 contexts 通道');

			await fish.dispose();
			assert.doesNotMatch(await promptOf(fish.agent), /小鱼/, 'agent dispose 后人格段应被摘掉');
			await host.dispose();

			console.log('✓ 真实 AgentLoop 工厂端到端验证通过：');
			console.log('  setup(agentCtx) 注册的段进得了本会话组装，不外溢到宿主会话，dispose 后自动摘');
			passed = true;
		} catch (error) { failed = error; }
	}
});

await new Promise((r) => setTimeout(r, 3000));
if (failed !== null) throw failed;
assert.ok(passed, '探针没有跑到断言结束');
await ctx.stop?.();