// 验证 dispatchInner 与 triggerProactive 在调用 agent.followup 前会 await soul.beginTurn 返回的预取 Promise。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-prefetch-await-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();
const ok = (n) => console.log('✓', n);

function makeGateway(onBeginTurn, onFollowup) {
	const gw = new ChatGateway({
		ctx: { get: () => undefined },
		db,
		clock: { now: () => Date.now() },
		getConfig: () => ({ qq: { enabled: true }, masterQqUin: '10001' }),
		log: () => {},
		channel: { connected: true, selfId: '1000', send: async () => 'mid-1', isFriend: () => true },
		soul: {
			beginTurn: onBeginTurn,
			nowLabel: () => '现在是 2026-11-27 17:00',
			resolvePerson: () => null,
			memorizeUnanswered: () => {},
			availability: () => 'idle',
			personaName: () => '小鱼',
			recallInfo: () => []
		}
	});
	gw.judgeTurn = async () => {};
	const agent = {
		id: 'sess-prefetch-1',
		followup: async (payload) => { await onFollowup(payload); }
	};
	gw.ensureSession = async () => agent;
	gw.bound.set(agent.id, { channel_id: 'private:10001', session_id: agent.id, workspace_path: process.env.DSH_HOME, title: 'QQ·主人', paused: 0 });
	return { gw, agent };
}

// ── ① dispatchInner：必须等到 beginTurn 的异步向量预取落地后再调 agent.followup ──
{
	let vecReady = false;
	const { gw, agent } = makeGateway(
		() => new Promise((resolve) => setTimeout(() => { vecReady = true; resolve(); }, 25)),
		async () => {
			assert.equal(vecReady, true, 'dispatchInner 调 agent.followup 时向量预取必须已经完成');
		}
	);
	await gw.dispatchInner('private:10001', [{
		m: {
			channel: 'qq', chatType: 'private', channelId: 'private:10001', targetId: '10001',
			userId: '10001', nickname: '主人', messageId: 'm-1', text: '在吗',
			images: [], links: [], records: [], files: [], forwards: [], timeMs: Date.now()
		},
		person: { canonical_id: 'master', display_name: '主人' }
	}], agent);
	ok('dispatchInner 在 agent.followup 前 await soul.beginTurn');
}

// ── ② triggerProactive：同样必须等到 beginTurn 的异步向量预取落地后再调 agent.followup ──
{
	let vecReady = false;
	let followupCalls = 0;
	const { gw } = makeGateway(
		() => new Promise((resolve) => setTimeout(() => { vecReady = true; resolve(); }, 25)),
		async () => {
			followupCalls++;
			assert.equal(vecReady, true, 'triggerProactive 调 agent.followup 时向量预取必须已经完成');
		}
	);
	const p = gw.triggerProactive('private:10001', '好久没说话了');
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(followupCalls, 1);
	// 主动开口等发送回执结束，手动触发 turn/end 回收 waiter
	const waiterKey = [...gw.waiters.keys()][0];
	gw.waiters.get(waiterKey)?.resolve(true);
	clearTimeout(gw.waiters.get(waiterKey)?.timer);
	gw.waiters.delete(waiterKey);
	assert.equal(await p, true);
	ok('triggerProactive 在 agent.followup 前 await soul.beginTurn');
}

db.close();
console.log('✓ prefetch-vec-await：2 组断言全过');
