// [表情:xx] 兜底：模型自己造的格式，库里有的换成真图发，没有的保留原样，让主人看到她本来想发什么。
// 红验证：把兜底表情包 的未命中分支改回返回空串 → 「保留」那几条红；删掉 gateway 里 兜底表情包 的调用 → 「走 sendReply」那条红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-sticker-fallback-');
const { openDatabase } = await import('../lib/db.js');
const { 兜底表情包, 抠正文图 } = await import('../lib/channels/vendor/qq-bridge.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();

/** 最小可用的网关：只测出站那一块，别的依赖给空实现。 */
const gateway = ({ sent = [] } = {}) => Object.assign(Object.create(ChatGateway.prototype), {
	db,
	log: () => {},
	diag: null,
	stickers: null,
	random: () => 0.5,
	ownMessages: new Map(),
	ownMessagesByChannel: new Map(),
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
	resolveImageFile: (name) => ({ type: 'image', data: { file: name } }),
	attachmentSegment: async () => null,
	replyTarget: () => '',
	qqConfig: () => ({ followUpCount: 0, followUpSeconds: 0, followUpSmart: false }),
	channel: {
		async send(channelId, segs) {
			sent.push({ channelId, segs });
			return `mid-${sent.length}`;
		},
		async getMessage() { return null; }
	}
});

// ── 1. 纯函数：匹配到 → 换成 markdown 图 ──
test('匹配到 → 换成 ![名](_stickers/文件)', () => {
	const files = ['兔子OK.gif', '鲸鱼撒娇.gif', '嘿嘿坏笑.jpg'];
	const out = 兜底表情包('好耶 [表情:兔子OK]', files);
	assert.equal(out, '好耶 ![兔子OK](_stickers/兔子OK.gif)', '匹配到要换成真图');
});

// ── 2. 纯函数：匹配不到 → 保留原样，不静默丢掉（#189） ──
test('匹配不到 → 保留原样', () => {
	const files = ['兔子OK.gif'];
	const out = 兜底表情包('好耶 [表情:比耶开心]', files);
	assert.equal(out, '好耶 [表情:比耶开心]', '库里没有就原样留着');
});

// ── 3. 纯函数：空贴纸列表 → 全部保留 ──
test('空列表 → 保留原样', () => {
	const out = 兜底表情包('好耶 [表情:兔子OK]', []);
	assert.equal(out, '好耶 [表情:兔子OK]', '空列表也原样留着');
});

// ── 3b. 纯函数：空名 [表情:] 也保留（#189：空名同样让主人看到） ──
test('空名 [表情:] → 保留原样', () => {
	const out = 兜底表情包('好耶 [表情:] 再见', ['兔子OK.gif']);
	assert.equal(out, '好耶 [表情:] 再见', '空名也原样留着');
});

// ── 4. 纯函数：不含 [表情: → 原样返回 ──
test('不含 [表情: → 原样', () => {
	const out = 兜底表情包('普通回复 [doge]', ['兔子OK.gif']);
	assert.equal(out, '普通回复 [doge]', '不含 [表情: 不动');
});

// ── 5. 组合：兜底之后 抠正文图 能认出图 ──
test('兜底 + 抠正文图 → 图被认出', () => {
	const files = ['兔子OK.gif'];
	const after = 兜底表情包('好耶 [表情:兔子OK]', files);
	const picked = 抠正文图(after);
	assert.equal(picked.图.length, 1, '抠出 1 张图');
	assert.equal(picked.图[0].value, '_stickers/兔子OK.gif', '路径对');
	assert.equal(picked.净文字, '好耶', '净文字对');
});

// ── 6. 接线：走真 sendReply，[表情:xx] 变成真图发出去 ──
test('走 sendReply：[表情:兔子OK] 变成真图，不是文字', async () => {
	const ws = join(process.env.DSH_HOME, 'ws-send');
	mkdirSync(join(ws, '_stickers'), { recursive: true });
	writeFileSync(join(ws, '_stickers', '兔子OK.gif'), 'GIF89a');

	const sent = [];
	const g = gateway({ sent });
	g.listStickers = () => ['兔子OK.gif'];

	const st = { text: '好耶 [表情:兔子OK]', images: [], channelId: 'private:1234567890' };
	const row = { channel_id: 'private:1234567890', title: '主人', workspace_path: ws, status: 'active' };
	await g.sendReply.call(Object.assign(g, { bound: new Map([['s1', row]]) }), 's1', st);

	assert.equal(sent.length, 2, `应该发出 2 条（1 文字 + 1 图），实际 ${sent.length}`);
	assert.equal(sent[0].segs[0].type, 'text', '第一条是文字');
	assert.equal(sent[0].segs[0].data.text, '好耶', '文字部分干净');
	assert.equal(sent[1].segs[0].type, 'image', '第二条是图');
});

// ── 7. 接线：库里没有的名字 → 原样当文字发出去，主人看得到她本来想发什么（#189） ──
test('走 sendReply：[表情:不存在] 原样发出，不被静默剥掉', async () => {
	const ws = join(process.env.DSH_HOME, 'ws-send2');
	mkdirSync(join(ws, '_stickers'), { recursive: true });
	writeFileSync(join(ws, '_stickers', '兔子OK.gif'), 'GIF89a');

	const sent = [];
	const g = gateway({ sent });
	g.listStickers = () => ['兔子OK.gif'];

	const st = { text: '好耶 [表情:不存在]', images: [], channelId: 'private:1234567890' };
	const row = { channel_id: 'private:1234567890', title: '主人', workspace_path: ws, status: 'active' };
	await g.sendReply.call(Object.assign(g, { bound: new Map([['s2', row]]) }), 's2', st);

	assert.equal(sent.length, 1, `应该只发 1 条（纯文字），实际 ${sent.length}`);
	assert.equal(sent[0].segs[0].type, 'text', '第一条是文字');
	assert.equal(sent[0].segs[0].data.text, '好耶 [表情:不存在]', '库里没有的名字原样留着，主人看得到');
});

// ── 8. 接线（assertWire 形式）：剪断 listStickers，[表情:兔子OK] 就发不出图 ──
// 前两条只证明「走真 sendReply 时结果对」；这条证明「结果对**是因为**经过了 listStickers」。
// 若谁把兜底那行的 `this.listStickers(...)` 换成别的来源，剪断它结果不变，这条就红。
test('接线：剪断 listStickers 后 [表情:兔子OK] 发不出图（证明兜底真的用了它）', async () => {
	const { assertWire } = await import('./_wire.mjs');
	const ws = join(process.env.DSH_HOME, 'ws-wire');
	mkdirSync(join(ws, '_stickers'), { recursive: true });
	writeFileSync(join(ws, '_stickers', '兔子OK.gif'), 'GIF89a');

	const sent = [];
	const g = gateway({ sent });
	g.listStickers = () => ['兔子OK.gif'];
	const row = { channel_id: 'private:1234567890', title: '主人', workspace_path: ws, status: 'active' };
	const st = { text: '好耶 [表情:兔子OK]', images: [], channelId: 'private:1234567890' };

	const { wired, cut } = await assertWire({
		run: async () => {
			sent.length = 0;
			await g.sendReply.call(Object.assign(g, { bound: new Map([['s9', row]]) }), 's9', st);
			return sent.map((x) => x.segs[0]?.type);
		},
		target: () => g,
		method: 'listStickers',
		pick: (types) => types,
		why: '#170 的 [表情:] 兜底必须经过 listStickers 才能把名字换成真图'
	});

	assert.deepEqual(wired, ['text', 'image'], '正常：文字 + 图');
	assert.deepEqual(cut, ['text'], '剪断 listStickers：只剩文字（兜底拿不到文件名）');
});
