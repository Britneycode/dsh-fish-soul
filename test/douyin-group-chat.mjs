// 抖音群聊：以前整个群被「单聊身份闸门」挡住（2026-11-19 真机）。
//
// 症状（主人收到的反馈）：
//   ① 运行日志里「抖音私信可能有遗漏」每分钟刷一条
//   ② 「回复没发出去（发送失败）」
//   ③ 群里的消息她一条都不回
//
// 根因：`lib/channels/douyin.js` 的 `identity === ''` 闸门是**单聊**的判据
//      （会话 ID 形状 `0:1:<我>:<对方>`），而群会话 ID 是 `<数字>:<数字>:...`
//      ⇒ 群聊必然推不出对端 ⇒ 每轮轮询都在那里 return：
//      不入库、不推进游标 ⇒ 每轮都判「窗口对不齐」⇒ 日志刷屏。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-group-chat-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinInbox } = await import('../lib/douyin-inbox.js');
const { DiagLog } = await import('../lib/diag-log.js');

const ok = (m) => console.log('✓', m);
const db = openDatabase();

// ── 1. 群会话 ID 不是单聊形状 ⇒ conversationIdentity 必然为空 ──
{
	const { conversationIdentity } = await import('../lib/douyin-conversation.js');
	const groupConv = '123456789012345678:987654321098765432:0';
	assert.equal(conversationIdentity(groupConv, ['9000000000000000001']), '', '群会话推不出「会话对端」');
	assert.equal(conversationIdentity('0:1:9000000000000000001:9000000000000000002', ['9000000000000000001']), 'douyin:9000000000000000002', '单聊能推出对端');
	ok('根因确认：群会话推不出对端，单聊可以');
}

// ── 2. 群消息按**发言人**认人，不靠会话对端 ──
{
	const msgs = [
		{ convId: '123456789012345678:987654321098765432:0', convType: 2, senderId: '551122334455667788', senderName: '国服玉环', text: '有人一起玩吗', fromMe: false },
		{ convId: '123456789012345678:987654321098765432:0', convType: 2, senderId: '991122334455667788', senderName: '弗列加特', text: '在的在的', fromMe: false }
	];
	const { isGroupConversation, normalizeDouyinMessage } = await import('../lib/channels/douyin.js');
	assert.equal(isGroupConversation(msgs, { name: '国服玉环（成长版）', groups: [] }), true, 'convType=2 ⇒ 群');
	const norm = normalizeDouyinMessage(msgs[0], {
		name: '国服玉环（成长版）', timeMs: 1_700_000_000_000, messageId: 'm1', group: true, members: {}, identity: '', convId: msgs[0].convId
	});
	assert.notEqual(norm, null, '群消息要能归一化（identity 为空也不该被丢）');
	assert.equal(norm.chatType, 'group');
	// 🔴 身份键必须是 douyin:<uid>（网关按 isIdentityKey 判，昵称过不了 ⇒ 群消息一条都回不了）
	assert.equal(norm.userId, 'douyin:551122334455667788', '按发言人 uid 认人');
	assert.equal(norm.nickname, '国服玉环', '昵称单独留着，只作展示');
	ok('群消息：identity 为空也能归一化，按发言人 uid 认人');
}

// ── 3. 🔴 同一会话反复窗口错位 ⇒ 运行日志只记一条（不再每轮刷屏）──
{
	// 🔴 用**真的** DiagLog：去重（按 key 合并计数）是它做的，假桩测不到。
	const diag = new DiagLog({ db });
	const inbox = new DouyinInbox(db, diag);
	const gap = { channelId: 'douyin-group:国服玉环（成长版）', reason: '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查' };
	const cursor = { convId: '123456789012345678:987654321098765432:0', group: true, window: [] };
	// 连着 30 轮窗口错位（真机每分钟一轮）
	for (let i = 0; i < 30; i++) inbox.record('cursor-group', cursor, [], gap);
	const gapRows = db.prepare("SELECT COUNT(*) n FROM douyin_inbox_gap WHERE channel_id=? AND reason=? AND acknowledged=0").get(gap.channelId, gap.reason).n;
	assert.equal(gapRows, 1, '表里只留一条未确认的缺口');
	const notes = diag.list().filter((e) => e.key.startsWith('douyin-inbox-gap'));
	assert.equal(notes.length, 1, `🔴 运行日志只该记一条，实际记了 ${notes.length} 条 —— 每轮刷屏就是这么来的`);
	assert.equal(notes[0].count, 30, '合并成一条，count 记着发生了多少次');
	ok('窗口错位反复发生：运行日志只记一条（不刷屏）');
}

// ── 4. 确认过之后又出现 ⇒ 重新记一条（用户要看得见它回来了）──
{
	// DiagLog 按 key 合并（窗口 5 分钟，比轮询间隔大）⇒ 窗口内的重复并成一条带计数。
	// 「确认过之后又出现」要看得见 ⇒ 时间推过合并窗口。
	let now = 3_000_000;
	const diag = new DiagLog({ db, now: () => now });
	const inbox = new DouyinInbox(db, diag);
	const gap = { channelId: 'douyin-group:另一个群', reason: '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查' };
	const cursor = { convId: '999:888:0', group: true, window: [] };
	inbox.record('cursor-group2', cursor, [], gap);
	assert.equal(diag.list().filter((e) => e.key.startsWith('douyin-inbox-gap')).length, 1, '第一次要记一条');
	db.prepare('UPDATE douyin_inbox_gap SET acknowledged=1 WHERE channel_id=?').run(gap.channelId);
	now += 6 * 60_000; // 推过合并窗口（5 分钟）
	inbox.record('cursor-group2', cursor, [], gap);
	assert.equal(diag.list().filter((e) => e.key.startsWith('douyin-inbox-gap')).length, 2, '确认过之后又出现 ⇒ 再记一条（不能永远合并到看不见）');
	ok('确认后复发：推过合并窗口后重新记一条');
}

// ── 5. 不同会话各自记（不能把两个群并成一条）──
{
	const diag = new DiagLog({ db });
	const inbox = new DouyinInbox(db, diag);
	const reason = '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查';
	inbox.record('c-a', { convId: '1:2:0', window: [] }, [], { channelId: 'douyin-group:甲群', reason });
	inbox.record('c-b', { convId: '3:4:0', window: [] }, [], { channelId: 'douyin-group:乙群', reason });
	assert.equal(diag.list().filter((e) => e.key.startsWith('douyin-inbox-gap')).length, 2, '两个群各自一条');
	ok('不同会话：各自一条，不合并');
}

console.log('抖音群聊：测试全部通过');
