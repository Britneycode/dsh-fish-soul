/**
 * 探针：用真实宿主包（@deepseek-ai/dsh-system-prompt rc.6 + dsh-scope）验证
 * 「在 agent 自己的 scope 里注册的 section / context，只对这个 agent 生效，agent 释放时自动摘掉」。
 *
 * 这是 per-agent 重构（#41 遗留坑位）的地基：如果 scoped 注册其实会外溢到别的会话，重构就不成立。
 * 只读：不碰 soul.db、不写任何仓库文件。跑法见 RUNBOOK「per-agent 探针」。
 *
 * 注意：section 进 assemble().sections（renderPrompt 渲染），context 进 assemble().contexts
 * （宿主作为运行时快照插到对话里），两条通道要分开断言。
 */
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt';
import { createScope } from '@deepseek-ai/dsh-scope';
import assert from 'node:assert/strict';

const ctx = new Context();
ctx.plugin(SystemPrompt, {});
await new Promise((r) => setTimeout(r, 100));

let passed = false;
let failed = null;
ctx.plugin({
	inject: ['systemPrompt'],
	apply: async (pluginCtx) => {
		try {
			const sp = pluginCtx.systemPrompt;
			// 模拟 ctx.agents.create / resume 的 setup(agentCtx)：两个独立的 agent scope
			const agentA = createScope(pluginCtx, 'agent-A'); // 鱼的会话
			const agentB = createScope(pluginCtx, 'agent-B'); // 宿主自己的技术会话

			agentA.ctx.systemPrompt.section({
				name: 'fish-soul-persona', order: 89000, interpolate: false, text: '你是小鱼，住在杭州。'
			});
			agentA.ctx.systemPrompt.context({
				name: 'fish-soul', order: 900, text: '此刻状态：正在复习高数。'
			});

			const of = async (scope) => sp.assemble(scope === undefined ? {} : { scope });
			const sectionsOf = (asm) => asm.sections.map((s) => s.text).join('\n');
			const contextsOf = (asm) => asm.contexts.map((c) => c.text).join('\n');

			const a = await of('agent-A');
			const b = await of('agent-B');
			const none = await of(undefined);

			assert.match(sectionsOf(a), /你是小鱼，住在杭州/, 'A 应该拿到人格段');
			assert.match(contextsOf(a), /正在复习高数/, 'A 应该拿到瞬态块');
			assert.doesNotMatch(sectionsOf(b), /小鱼/, 'B 不该拿到人格段（per-agent 不外溢）');
			assert.doesNotMatch(contextsOf(b), /复习高数/, 'B 不该拿到瞬态块');
			assert.doesNotMatch(sectionsOf(none), /小鱼/, '无 scope 的 assemble 不该拿到人格段');

			// 同名的全局段会被 scoped 段遮蔽（不是叠加两份）
			pluginCtx.effect(() => pluginCtx.systemPrompt.section({ name: 'fish-soul-persona', order: 89000, text: '全局版人格' }));
			const aShadow = await of('agent-A');
			assert.doesNotMatch(sectionsOf(aShadow), /全局版人格/, 'scoped 段应遮蔽同名全局段');
			assert.match(sectionsOf(aShadow), /你是小鱼，住在杭州/);
			const bShadow = await of('agent-B');
			assert.match(sectionsOf(bShadow), /全局版人格/, '别的 agent 仍拿全局段（遮蔽只对自己）');

			// agent 释放 → 段跟着走，全局段对 B 照旧
			await agentA.dispose();
			assert.doesNotMatch(sectionsOf(await of('agent-A')), /小鱼/, 'agent dispose 后人格段应被摘掉');
			await agentB.dispose();

			console.log('✓ 真实宿主（dsh-system-prompt rc.6）验证通过：');
			console.log('  per-agent 段 / 瞬态块只对所属 agent 生效，同名全局段被遮蔽，agent dispose 后自动摘掉');
			console.log('  A 渲染 :', JSON.stringify(renderPrompt(a)).slice(0, 100));
			console.log('  A 瞬态 :', JSON.stringify(renderContextSections(a) ?? '').slice(0, 100));
			passed = true;
		} catch (error) { failed = error; }
	}
});
await new Promise((r) => setTimeout(r, 1500));
if (failed !== null) throw failed;
assert.ok(passed, '探针没有跑到断言结束');
await ctx.stop?.();