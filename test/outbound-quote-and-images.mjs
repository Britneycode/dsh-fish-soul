// #160 + #161：出站那两条。
//
// #160 —— 用户引用「她刚说过的话」时取不到原文。真根因：她自己发出去的消息只进内存
//         `ownMessages`，宿主一重启就空了，只能回头问 OneBot 的 `get_msg`；
//         而 QQ 的消息号会跨天复用，`get_msg` 取回隔天那条、被时间校验收掉 ⇒ 一直「原文没取到」。
//         修法：发送成功时按 (channel_id, message_id) 落 `own_message`，引用时先查库。
// #161 —— 出站图片被 push 进最后一条文字消息的段数组 ⇒ QQ 上「文字带着图」一个气泡。
//         修法：一张图一条消息。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-outbound-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();

/** 最小可用的网关：只测出站那两块，别的依赖给空实现。 */
const gateway = ({ sent = [] } = {}) => Object.assign(Object.create(ChatGateway.prototype), {
	db,
	log: () => {},
	diag: null,
	stickers: null,
	random: () => 0.5,
	ownMessages: new Map(),
	// sendReply 里的这几个 Map 都是网关自己初始化的，手搓的 this 得补上
	interjectTurns: new Set(),
	turnMood: new Map(),
	recentSent: new Map(),
	waiters: new Map(),
	sessionChains: new Map(),
	moodOf: () => ({ delay: 0, mood: '', tone: '' }),
	firstDelay: () => 0,
	sleep: async () => {},
	moodPick: (_p, picked) => picked,
	cleanOut: (t) => t,
	soul: { recallInfo: () => ({ memories: [], at: 0 }), journalOut: () => {} },
	outbox: { hasQueued: () => false, enqueue: () => {} },
	dropRepeats: (_row, p) => p,
	noteSent: () => {},
	note: () => {},
	channel: {
		async send(channelId, segs) {
			sent.push({ channelId, segs });
			return `mid-${sent.length}`;
		},
		async getMessage() { return null; }
	}
});

// ───────────────────────── #160 ─────────────────────────

test('#160 她说的那句话落库了，重启后（内存空了）照样认得出是她自己说的', async () => {
	const g = gateway();
	// 模拟：发出去一条消息（sender 回调那条路）
	g.rememberOwn('9001', '我刚吃完，你呢', 'private:1234567890');

	const row = db.prepare('SELECT text FROM own_message WHERE channel_id = ? AND message_id = ?').get('private:1234567890', '9001');
	assert.equal(row?.text, '我刚吃完，你呢', '出站消息要落库（以前只进内存）');

	// 模拟重启：内存清空
	g.ownMessages.clear();
	const line = await g.quoteLine('9001', 'private:1234567890');
	assert.match(line, /引用 我自己：我刚吃完，你呢/, '重启后引用她的话要能取到原文');
});

test('#160 内存里有就不查库（同一次运行里最快的路径没变）', async () => {
	const g = gateway();
	let queried = 0;
	const realPrepare = db.prepare.bind(db);
	g.db = { prepare: (sql) => { if (String(sql).includes('own_message')) queried++; return realPrepare(sql); } };
	g.rememberOwnCacheOnly('9002', '在的');
	const line = await g.quoteLine('9002', 'private:1234567890');
	assert.match(line, /引用 我自己：在的/);
	assert.equal(queried, 0, '命中内存时不该去查库');
});

test('#160 消息号只在聊天内唯一：别的聊天里同号不算她说的', async () => {
	const g = gateway();
	g.rememberOwn('9003', '这是私聊里说的', 'private:1234567890');
	g.ownMessages.clear();
	// 同一个消息号，但引用发生在另一个聊天里 —— 不能当成她的原文
	assert.equal(g.ownMessageText('9003', 'group:1125962189'), '', '换个聊天就不能认');
	assert.equal(g.ownMessageText('9003', 'private:1234567890'), '这是私聊里说的');
});

test('#160 没有 channelId 时只进内存，不往库里写（宁可不写，别写进错的聊天）', () => {
	const g = gateway();
	g.rememberOwn('9004', '不知道发去哪儿的');
	assert.equal(g.ownMessages.get('9004'), '不知道发去哪儿的', '内存照旧');
	const n = db.prepare("SELECT COUNT(*) n FROM own_message WHERE message_id = '9004'").get().n;
	assert.equal(n, 0, '没给 channelId 就不落库');
});

test('#160 写库抛错不能把发送打挂（引用是兜底，不是主路）', () => {
	const g = gateway();
	g.db = { prepare: () => { throw new Error('SQLITE_BUSY'); } };
	assert.doesNotThrow(() => g.rememberOwn('9005', '照发', 'private:1'));
	assert.equal(g.ownMessages.get('9005'), '照发', '内存那条仍然记住了');
});

// ───────────────────────── #161 ─────────────────────────

test('#161 一条文字 + 两张图 → 文字一条、图各一条（不并进文字气泡）', async () => {
	const sent = [];
	const g = gateway({ sent });
	// moodPick 收到的「图」是这个形状：{ value: 文件名 }
	g.resolveImageFile = (name) => ({ type: 'image', data: { file: name } });
	g.attachmentSegment = async () => null;
	g.replyTarget = () => '';
	g.qqConfig = () => ({ followUpCount: 0, followUpSeconds: 0, followUpSmart: false });
	g.dropRepeats = (_row, p) => p;

	const st = { text: '喏 ![猫](a.png) ![狗](b.png)', images: [], channelId: 'private:1234567890' };
	const row = { channel_id: 'private:1234567890', title: '主人', workspace_path: '.', status: 'active' };
	await g.sendReply.call(Object.assign(g, { bound: new Map([['s1', row]]) }), 's1', st);

	const total = sent.length;
	assert.equal(total, 3, `应该发出 3 条（1 文字 + 2 图），实际 ${total}`);
	const kinds = sent.map((x) => x.segs.map((s) => s.type).join('+'));
	assert.deepEqual(kinds, ['text', 'image', 'image'], `每条只该有一种段，实际 ${JSON.stringify(kinds)}`);
});
