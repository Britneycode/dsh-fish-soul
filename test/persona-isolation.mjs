// 人格卡不能漏进「不是我们的会话」。
//
// 用户反馈（2026-11-14）：开一个新会话，上下文里被注入了肥鱼的人格，变成肥鱼了。
//
// 根因：`noteInteraction`（`agent/inbox/inserted` 钩子）里第一行
//     mountSectionsFor(payload?.agent);
// 是**无条件**的 —— 注释写的是「所有会话都在 inbox 时补挂一次做保险」，
// 但 inbox 事件对宿主里**每一个**会话都会来，包括用户自己开的技术对话。
// 于是那些会话的每次组装都会带上 `fish-soul-persona`（人格卡）和
// `fish-soul`（瞬态块：此刻状态 / Top5 记忆 / 群摘要）。
//
// 这条路径本来只该服务两种会话：
//   ① 我们自己建/恢复的（`gateway.isOurSession(agentId)`）—— setup 时挂过，这里是保险；
//   ② 别的插件把 QQ 消息转进它建的会话（后面那句 `if (person !== null)`）。
//
// 历史背景（#40 / #41）：以前挂在插件的全局 ctx.systemPrompt 上，靠 injectsFor 返回空串兜，
// 结果人格段真的漏进过用户的技术对话。当时的修法就是「只挂 per-agent」—— 但这条
// 无条件补挂把洞又开回来了，只是换了条路。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('fish-soul-isolation-');
process.env.DSH_HOME = home;
const { registerAgentSections } = await import('../lib/routes.js');

const ok = (m) => console.log('✓', m);

/** 假 agentCtx：记录挂了哪些段 */
const fakeCtx = () => {
	const sections = [];
	const contexts = [];
	return {
		sections,
		contexts,
		effect: (fn) => { fn(); },
		systemPrompt: {
			section: (s) => { sections.push(s.name); },
			context: (s) => { contexts.push(s.name); }
		}
	};
};

// ── 1. registerAgentSections 本身只挂两块，且都挂在这个 agentCtx 上 ──
{
	const c = fakeCtx();
	registerAgentSections(c, { personaText: () => '肥鱼的人格卡', buildContextBlock: () => '瞬态块', log: () => {} });
	assert.deepEqual(c.sections, ['fish-soul-persona'], '人格段挂在这个 agent 上');
	assert.deepEqual(c.contexts, ['fish-soul'], '瞬态块挂在这个 agent 上');
	ok('registerAgentSections 只挂两块，且只挂传进来的那个 agentCtx');
}

// ── 2. 🔴 关键契约：这个函数**只能**被我们的会话 / 转进来的 QQ 会话调用 ──
// 这里钉住判定条件本身：isOurSession 为假、又没有认出 person 的会话，不该调它。
// 用源码断言（index.js 的启动流程没法在单测里整段跑起来）。
{
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	// 找到 noteInteraction 里那一行「无条件补挂」
	const lines = src.split('\n');
	const noteStart = lines.findIndex((l) => l.includes('function noteInteraction(payload)'));
	assert.ok(noteStart > 0, '找到 noteInteraction');
	// 往后找第一处 mountSectionsFor 调用（行内可能带守卫，如 `if (ours) mountSectionsFor(...)`）
	let firstCall = -1;
	for (let i = noteStart; i < lines.length; i++) {
		// 跳过注释行（我自己就在注释里引用了这行代码，不能把说明当成调用）
		const code = lines[i].replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
		if (code.includes('mountSectionsFor(payload?.agent)')) { firstCall = i; break; }
		if (lines[i].includes('function mountSectionsFor')) break;
	}
	assert.ok(firstCall > 0, '找到第一处 mountSectionsFor');
	// 🔴 关键：这一行自己必须带守卫，或者它上面 8 行内有 ours / person !== null 的判定。
	//    裸的 `mountSectionsFor(payload?.agent);` 就是漏洞本身（人格卡会漏进用户自己的会话）。
	const self = lines[firstCall];
	// `ours` 的定义可能在更上面（中间夹着注释块），搜到函数开头
	const above = lines.slice(noteStart, firstCall + 1).join('\n');
	assert.match(self, /if \(ours\)|if \(person !== null\)/,
		`第一处补挂必须带「是不是我们的会话」守卫，实际是：${self.trim()}`);
	assert.match(above, /isOurSession/,
		'守卫要用 isOurSession 判，不是猜');
	ok('noteInteraction 的第一处补挂带隔离守卫（人格卡不漏进别人的会话）');
}

console.log('\npersona-isolation ok');

// ── 3. isOurSession 的判定依据必须是 chat_session 登记，不是工作区 / 标题 ──
{
	const { openDatabase, insertChatSession } = await import('../lib/db.js');
	const { ChatGateway } = await import('../lib/gateway.js');
	process.env.DSH_HOME = tmpHome('fish-soul-isolation-ws-');
	const db = openDatabase();
	const ws = 'D:/some/workspace';
	insertChatSession(db, { channel: 'qq', channelId: 'private:10001', sessionId: 'ours-1', workspacePath: ws, title: 'QQ·某人', nowMs: Date.now() });

	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ qq: {}, sessions: { workspacePath: ws } }), log: () => {},
		channel: { connected: true, selfId: '1000', isFriend: () => true },
		soul: { beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '鱼', recallInfo: () => [] }
	});

	assert.equal(gw.isOurSession('ours-1'), true, '登记过的会话是我们的');
	assert.equal(gw.isOurSession('not-ours'), false, '没登记的不是我们的（用户自己开的）');
	// 🔴 关键：同一个工作区下、但不是我们建的会话，不能被认成我们的
	//    （工作区只是个路径，谁都能在里面开会话）
	assert.equal(gw.isOurSession('user-tech-chat'), false, '同一个工作区里用户自己的会话也不算我们的');
	// 内存里没有但库里有 → 要认（宿主重启后别的路径恢复的情况）
	gw.bound.delete('ours-1');
	assert.equal(gw.isOurSession('ours-1'), true, '内存里没有但库里有登记 → 仍认得出（查库兜底）');
	ok('isOurSession 按 chat_session 登记判定（不是工作区 / 标题），且有查库兜底');
}
