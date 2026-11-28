// 抖音群聊的消息要能真的入库（2026-11-19 真机修）。
//
// 症状（主人收到的反馈）：「回复没发出去（发送失败）」+ 运行日志每分钟刷一条
// 「抖音私信可能有遗漏」。
//
// 根因：`lib/channels/douyin.js` 的 `identity === ''` 是**单聊**的判据
//      （会话 ID 形状 `0:1:<我>:<对方>`）。群会话 ID 是 `<数字>:<数字>:...`
//      ⇒ 必然推不出对端 ⇒ 每轮轮询都在那里 return：
//      消息不入库、游标不推进 ⇒ 每轮都判「窗口对不齐」⇒ 日志刷屏。
//
// 这个测试走**真的** readConversation（跟 douyin-inbox.mjs 同一个入口），
// 不是测纯函数 —— 纯函数测不到那处闸门。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'fish-group-read-'));
process.env.DSH_HOME = home;
const { openDatabase, getKv } = await import('../lib/db.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');

const db = openDatabase();
const ok = (m) => console.log('✓', m);

// 群会话 ID：不是 0:1: 形状 ⇒ conversationIdentity 必然推不出对端
const GROUP_CONV = '123456789012345678:987654321098765432:0';
const SENDER = '551122334455667788';
const groupMsg = (seq, text, name) => ({
	fromMe: false, seq, text, time: Date.now(),
	senderId: SENDER, senderName: name, convId: GROUP_CONV, convType: 2
});

// ── 群消息要能入库、游标要能推进 ──
{
	let got = [];
	const ch = new DouyinChannel({
		db, host: {}, getConfig: () => ({ groups: [] }), selfSecUid: '9000000000000000001',
		driver: {
			read: async () => ({ ok: true, messages: [groupMsg('900', '有人一起玩吗', '国服玉环')], convId: GROUP_CONV })
		},
		onMessage: async (m) => { got.push(m); return { queued: true }; }
	});
	await ch.readConversation({ c: { time: '' }, name: '国服玉环（成长版）', key: 'conv-group', st: null, sig: 'new', unread: true });
	const rows = db.prepare("SELECT channel_id, message_id, payload FROM douyin_inbox WHERE channel_id='douyin-group:国服玉环（成长版）'").all();
	assert.equal(rows.length, 1, '群消息要能入库（以前被身份闸门挡在门外）');
	assert.equal(got.length, 1, '群消息要交给网关处理');
	assert.equal(got[0].chatType, 'group');
	assert.equal(got[0].userId, 'douyin:551122334455667788', '🔴 身份键必须是 douyin:<uid>（网关按 isIdentityKey 判，昵称过不了 ⇒ 群消息一条都回不了）');
	// 🔴 游标必须推进：推进了才不会有「每轮都判窗口对不齐」
	const cur = getKv(db, 'conv-group', null);
	assert.notEqual(cur, null, '游标要写下来');
	assert.equal(cur.group, true, '游标要记住这是群');
	assert.equal(cur.window.length, 1, '窗口要记下来（下一轮靠它对齐）');
	ok('群消息：入库 + 交给网关 + 游标推进');
}

// ── 第二轮：窗口能对齐 ⇒ 不再报「可能有遗漏」──
{
	const ch = new DouyinChannel({
		db, host: {}, getConfig: () => ({ groups: [] }), selfSecUid: '9000000000000000001',
		driver: {
			read: async () => ({ ok: true, messages: [groupMsg('901', '在的在的', '弗列加特')], convId: GROUP_CONV })
		},
		onMessage: async () => ({ queued: true })
	});
	// 上一轮的游标里窗口是 ['...900']，这次读到 901 ⇒ 窗口滚走了 ⇒ 会报一次缺口（这是设计）
	// 但关键是：游标**继续推进**，不会每轮都卡在同一处。
	await ch.readConversation({ c: { time: '' }, name: '国服玉环（成长版）', key: 'conv-group', st: getKv(db, 'conv-group', null), sig: 'new', unread: true });
	const cur = getKv(db, 'conv-group', null);
	assert.notEqual(cur, null, '游标继续存在');
	assert.equal(cur.window.length, 1, '窗口跟着更新了');
	const gapRows = db.prepare("SELECT COUNT(*) n FROM douyin_inbox_gap WHERE channel_id='douyin-group:国服玉环（成长版）' AND acknowledged=0").get().n;
	assert.equal(gapRows, 1, '缺口表里只留一条（去重生效）');
	ok('第二轮：游标继续推进，缺口表不重复堆');
}

// ── 单聊那条路没被带坏（回归）──
{
	const CONV = '0:1:9000000000000000001:9000000000000000002';
	const ch = new DouyinChannel({
		db, host: {}, getConfig: () => ({ groups: [] }), selfSecUid: '9000000000000000001',
		driver: {
			read: async () => ({ ok: true, messages: [{ fromMe: false, seq: '950', text: '在吗', time: Date.now(), senderId: '9000000000000000002', convId: CONV }], convId: CONV })
		},
		onMessage: async () => ({ queued: true })
	});
	await ch.readConversation({ c: { time: '' }, name: '某人', key: 'conv-single', st: null, sig: 'new', unread: true });
	const rows = db.prepare("SELECT COUNT(*) n FROM douyin_inbox WHERE channel_id='douyin:某人'").get().n;
	assert.equal(rows, 1, '单聊照常入库');
	ok('单聊：没被群聊的改动带坏');
}

// ── 🔴 群会话的 convId 必须被固定（串会话防线）──
//
// 群的会话 ID 没有「谁是对端」可推，所以固定靠「游标里记着的是同一个群」。
// 固定没了，别的会话的 ID 就能顶掉这条游标（串会话）。
{
	const reads = [];
	const ch = new DouyinChannel({
		db, host: {}, getConfig: () => ({ groups: [] }), selfSecUid: '9000000000000000001',
		driver: {
			read: async (_name, opts) => {
				reads.push(opts);
				// 这次读回来的会话 ID 跟游标里记的不一样 ⇒ 必须是别的会话
				return { ok: true, convId: '777777777777777777:888888888888888888:0', messages: [] };
			}
		},
		onMessage: async () => ({ queued: true })
	});
	const st = getKv(db, 'conv-group', null);
	assert.notEqual(st, null, '要有上一轮的游标');
	await ch.readConversation({ c: { time: '' }, name: '国服玉环（成长版）', key: 'cursor-group', st, sig: 'new', unread: true });
	assert.equal(reads[0].expectConvId, GROUP_CONV, '🔴 群会话也要固定 convId —— 固定没了别的会话就能顶掉它');
	ok('群会话：convId 被固定（串会话防线在）');
}

console.log('抖音群聊入库：测试全部通过');
