// #78：记忆的「出处」不能一律写成「没回的消息」。
//
// 报告人的记忆列表里绝大部分都标着「没回的消息 · 聊天自动记」—— 而「聊天自动记」是聊完自动整理
// 写下的记忆，出处却是空的，界面就退回默认文案「没回的消息」。她看到这段记忆时也会被这个标签
// 带着理解成"一条我没回的消息"，而不是"我跟他聊过这件事"。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('memory-source-');
const { openDatabase } = await import('../lib/db.js');
const { ChatJournal, ChatDigester, insertMemory } = await import('../lib/soul-memory.js');
const { sourceLabel } = await import('../lib/routes-soul.js');

const db = openDatabase();
const ok = (n) => console.log('✓', n);
const now = Date.parse('2026-11-09T12:00:00Z');

// 1. 出处映射：空的不再一律当「没回的消息」
assert.equal(sourceLabel('chat', 'qq-private'), '聊天里记的', '聊完整理写的记忆是「聊天里记的」');
assert.equal(sourceLabel('', 'bili'), '自己刷B站时记的');
assert.equal(sourceLabel('', 'douyin'), '自己刷抖音时记的');
assert.equal(sourceLabel('', 'self'), '她自己记的', '日记这类她自己写的');
assert.equal(sourceLabel('', 'qq-private'), '没回的消息', '私聊里没回的才是没回的消息');
assert.equal(sourceLabel('', 'qq-group'), '没回的消息', '群里没接的话也是没回的消息');
assert.equal(sourceLabel('manual'), '主人手动加的');
ok('出处：聊天里记的 / 刷视频记的 / 她自己记的 / 没回的消息 分得开');

// 2. 写记忆时能把出处带上（以前 source_session 一律写空）
{
	const id = insertMemory(db, null, { ownerId: 'user:master', channel: 'qq-private', channelId: 'private:10001', kind: 'fact', content: '主人说他在练吉他', importance: 2, sourceSession: 'chat' }, now);
	assert.equal(db.prepare('SELECT source_session FROM memory WHERE id = ?').get(id).source_session, 'chat');
	ok('写记忆能带出处（source_session 不再是死的空串）');
}

// 3. 聊完自动记：写下来的记忆出处是「聊天里记的」，不是「没回的消息」
{
	const journal = new ChatJournal({ keepRecent: 50 });
	// 换一个人、换一件事：上面那条「练吉他」会被判成近似重复，只刷新不新增
	journal.add('private:20002', { who: '阿二', ownerId: 'user:p2', text: '我下周要考科目二' });
	journal.add('private:20002', { who: '鱼', ownerId: null, self: true, text: '紧张吗' });
	const digester = new ChatDigester({
		db, clock: { now: () => now }, journal, worker: null,
		callLlm: async () => JSON.stringify({
			memories: [{ who: '阿二', content: '阿二下周要考科目二', kind: 'event', importance: 3 }],
			self: [], summary: '阿二要考科目二', people: []
		}),
		getConfig: () => ({}), related: () => [], findOwnerByName: () => null,
		personaName: () => '鱼', titleOf: () => 'QQ·阿二', note: () => {}, log: () => {}
	});
	const r = await digester.digest('private:20002');
	assert.ok(r && r.added >= 1, '聊完整理应该写下记忆');
	const row = db.prepare("SELECT * FROM memory WHERE content = '阿二下周要考科目二'").get();
	assert.equal(row.source_session, 'chat', '聊完整理写的记忆要标上「从聊天里整理的」');
	assert.equal(sourceLabel(row.source_session, row.channel), '聊天里记的');
	const ep = db.prepare("SELECT source_session FROM memory WHERE kind = 'episode' AND content = '阿二要考科目二'").get();
	assert.equal(ep.source_session, 'chat', '聊完小结也一样');
	ok('聊完自动记 / 聊完小结：出处是「聊天里记的」');
}

// 4. 动态页：这一轮记忆有没有参与，要记下来（否则「她怎么想不起来」在界面上查不出来）
{
	const { ChatGateway } = await import('../lib/gateway.js');
	const sent = [];
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => now }, getConfig: () => ({ qq: { enabled: true } }), log: () => {},
		channel: { connected: true, selfId: '1000', send: async (cid, segs) => { sent.push([cid, segs]); return 'm1'; }, isFriend: () => true },
		soul: { beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', journalOut: () => {},
			recallInfo: () => ({ memories: ['#1 主人在练吉他'], at: now, unknown: false }) }
	});
	gw.sleep = async () => {};
	gw.bound.set('sess-1', { channel_id: 'private:10001', session_id: 'sess-1', workspace_path: process.env.DSH_HOME, title: 'QQ·主人', paused: 0 });
	await gw.sendReply('sess-1', { text: '练到哪了', images: [], fromUs: true, messageIds: [], replyTo: null, channelId: 'private:10001' });
	assert.equal(gw.decisions[0].kind, 'sent');
	assert.deepEqual(gw.decisions[0].memories, ['#1 主人在练吉他'], '召回到的记进动态');
	assert.equal(gw.decisions[0].recallAt, now, '这一轮跑过瞬态块');
	assert.equal(gw.decisions[0].speakerUnknown, false);
	ok('动态页：记得下这一轮召回到什么、有没有跑过');

	// 没跑瞬态块（会话没登记 / 认人失败）：明确标出来，而不是什么都不显示
	const gw2 = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => now }, getConfig: () => ({ qq: { enabled: true } }), log: () => {},
		channel: { connected: true, selfId: '1000', send: async () => 'm1', isFriend: () => true },
		soul: { beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', journalOut: () => {},
			recallInfo: () => ({ memories: [], at: 0, unknown: true }) }
	});
	gw2.sleep = async () => {};
	gw2.bound.set('sess-2', { channel_id: 'private:10001', session_id: 'sess-2', workspace_path: process.env.DSH_HOME, title: 'QQ·主人', paused: 0 });
	await gw2.sendReply('sess-2', { text: '嗯', images: [], fromUs: true, messageIds: [], replyTo: null, channelId: 'private:10001' });
	assert.equal(gw2.decisions[0].recallAt, undefined, '没跑就不写时间');
	assert.deepEqual(gw2.decisions[0].memories ?? [], []);
	ok('动态页：没跑瞬态块的时候看得出来（不再是空白）');
}

console.log('memory-source-label ok');
