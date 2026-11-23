// 抖音群消息要真的能走到「已交给模型」（2026-11-19 真机修）。
//
// 主人反馈：「抖音私信功能有问题」+「还有消息没回」。
// 前面的修复让群消息**入库了**，但它还是回不了 —— 有三道独立的阻塞：
//   ① index.js 的 onMessage 只接了 onDouyinMessage，��消息根本没进网关
//   ② normalizeDouyinMessage 的群分支把 userId 设成**昵称**，
//      网关按 isIdentityKey（`douyin:<数字uid>`）判身份 ⇒ 每条都被「身份未确认」拒掉
//   ③ 发送时 adapter / channel 只认 `0:1:` 形状的 convId ⇒ 群会话发不出去
//
// 这个测试走**真的** DouyinChannel → 真的 ChatGateway（和 index.js 一样的接线）。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-group-reply-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');

const ok = (m) => console.log('✓', m);
const db = openDatabase();

const SELF = '9000000000000000001';
const GROUP_CONV = '123456789012345678:987654321098765432:0';
const MEMBER = '551122334455667788';
const GROUP_NAME = '测试群';

// ── 网关：群消息（身份键形状）要能被授权并交给模型 ──
{
	let enqueued = [];
	const config = {
		qq: { enabled: true }, masterQqUin: '123', tools: { sessionAllow: 'all' },
		douyin: {
			enabled: true, masterName: '主人', autoReply: true, groupReply: true,
			masterUid: `douyin:${MEMBER}`, replyAll: true
		}
	};
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => config, log: () => {}, channel: { connected: true },
		douyin: { connected: true, send: async () => ({ ok: true, delivered: true }) },
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	// 抓 enqueue：它是「交给模型」的那一步
	gw.enqueue = (...args) => { enqueued.push(args); return { queued: true }; };

	const r = await gw.onDouyinGroupMessage({
		channelId: `douyin-group:${GROUP_NAME}`, userId: `douyin:${MEMBER}`, nickname: '国服玉环',
		peerName: GROUP_NAME, chatType: 'group', text: '有人一起玩吗', messageId: 'm1', timeMs: Date.now()
	});
	assert.equal(r.queued, true, `群消息要交给模型，实际：${JSON.stringify(r)}`);
	assert.equal(enqueued.length, 1, '要真的 enqueue 一次');
	ok('群消息（身份键）能走到「已交给模型」');
}

// ── 昵称 / uid:<id> 仍然不算身份（不能因为放宽而让冒充进门）──
{
	const config = {
		qq: { enabled: true }, masterQqUin: '123', tools: { sessionAllow: 'all' },
		douyin: { enabled: true, masterName: '主人', autoReply: true, groupReply: true, replyAll: true }
	};
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => config, log: () => {}, channel: { connected: true },
		douyin: { connected: true, send: async () => ({ ok: true, delivered: true }) },
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	for (const userId of ['国服玉环', `uid:${MEMBER}`, '']) {
		const r = await gw.onDouyinGroupMessage({
			channelId: `douyin-group:${GROUP_NAME}`, userId, nickname: '国服玉环',
			peerName: GROUP_NAME, chatType: 'group', text: '冒充', messageId: 'm2', timeMs: Date.now()
		});
		assert.match(String(r.review ?? ''), /身份/, `「${userId}」不算身份，要被拒`);
	}
	ok('昵称 / uid:<id> / 空身份仍然被拒（没因为群聊而放松冒充防线）');
}

// ── 端到端：真 DouyinChannel 收到群消息 → 交给网关 → 被授权 ──
{
	let passed = [];
	const config = {
		qq: { enabled: true }, masterQqUin: '123', tools: { sessionAllow: 'all' },
		douyin: {
			enabled: true, masterName: '主人', autoReply: true, groupReply: true,
			masterUid: `douyin:${MEMBER}`, replyAll: true
		}
	};
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => config, log: () => {}, channel: { connected: true },
		douyin: { connected: true, send: async () => ({ ok: true, delivered: true }) },
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	gw.enqueue = (...args) => { passed.push(args); return { queued: true }; };

	const ch = new DouyinChannel({
		db, host: {}, getConfig: () => config, selfSecUid: SELF,
		driver: {
			read: async () => ({
				ok: true, convId: GROUP_CONV,
				messages: [{ fromMe: false, seq: '910', text: '在的在的', time: Date.now(), senderId: MEMBER, senderName: '国服玉环', convId: GROUP_CONV, convType: 2 }]
			})
		},
		// 🔴 接线必须和 lib/index.js 一样：按 chatType 分发到群入口
		onMessage: async (m) => (m?.chatType === 'group' ? gw.onDouyinGroupMessage(m) : gw.onDouyinMessage(m))
	});
	await ch.readConversation({ c: { time: '' }, name: GROUP_NAME, key: 'conv-group-e2e', st: null, sig: 'new', unread: true });
	assert.equal(passed.length, 1, '群消息要真的走到 enqueue');
	assert.equal(passed[0][0].userId, `douyin:${MEMBER}`, '身份键要从 uid 拼出来');
	ok('端到端：群消息 → 网关 → 已交给模型');
}

// ── 接线断言：index.js 必须按 chatType 分发（否则群消息根本进不了网关）──
//
// 🔴 这条是「复制版逻辑」的教训：上面那个端到端用例自己在测试里写了一遍分发，
//    所以把 lib/index.js 改坏它照样绿 —— 测不到生产接线。
//    这里直接读 index.js 的源码断言。
{
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	const line = src.split('\n').find((l) => l.includes('onMessage:') && l.includes('onDouyinGroupMessage'));
	assert.ok(line !== undefined, 'index.js 的 onMessage 必须按 chatType 分发到群入口');
	assert.ok(line.includes("chatType === 'group'"), '群消息要进 onDouyinGroupMessage');
	assert.ok(line.includes('onDouyinMessage'), '非群消息照旧进 onDouyinMessage');
	ok('接线：index.js 按 chatType 分发（群 → 群入口）');
}

console.log('抖音群回复链路：测试全部通过');
