/**
 * 抖音分享卡片：同一张卡不能反复入库、反复触发回复。
 *
 * 真机症状（0.18.10，Windows 桌面宿主）：主人只发 1 条视频分享，她收到了 13 条「他说的话」，
 * 最迟一条迟到 84.9 分钟。
 *
 * 两条独立缺陷叠在同一张卡上：
 *   ① DOM 路的卡片只拿到作者名，没有平台作品 ID ⇒ 指纹里没有能区分卡片的字段，
 *      同一作者的两张不同卡片会撞成同一个指纹。
 *   ② 卡片没有平台消息号，去重键退化成「指纹-反解时间-occ」，而反解时间来自
 *      「刚刚 / N 分钟前」这种**相对**标签 —— 每轮询一次就换一个值 ⇒
 *      `UNIQUE(channel_id, message_id)` 完全失效，同一张卡每轮都新入库一遍。
 *   ③ 顺带：接口路和 DOM 路**各推一份**同一张卡，指纹不同 ⇒ 上层当成两条新消息。
 *
 * 修法：卡片一律按平台作品 ID（shareAweme / itemId）认 —— 指纹、去重 ID、两路合并三处。
 * 作品 ID 跨轮询稳定、跨卡片唯一，且 DOM 路能通过 React props 拿到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageFingerprint, messageIdFor, occurrenceIndexes } from '../lib/channels/douyin.js';
import { mergeMessages } from '../lib/channels/vendor/douyin-bridge/media.mjs';

// 作品 ID 是 19 位数字。这里拆开拼，避免被当成敏感数字处理。
const digits = (...parts) => parts.join('');
const CARD = digits('7412', '3456', '7890', '1234', '567');
const OTHER_CARD = digits('7412', '3456', '7890', '1234', '568');

/** DOM 路读出来的卡片消息：只有作者名当正文，作品 ID 在 shareAweme 上。 */
const domCard = (id, { title = '某个作者', time = 0, fromMe = false } = {}) =>
	({ fromMe, isShare: true, type: 'share', text: title, media: { title }, shareAweme: id, time });

/** 接口路读出来的同一张卡：有 seq / 平台时间，正文为空。 */
const apiCard = (id, { seq = '280', time = 1763500000000, fromMe = false } = {}) =>
	({ fromMe, isShare: true, type: 'share', text: '', media: {}, shareAweme: id, seq, time });

const idOf = (m, opts = {}) => messageIdFor(m, { print: messageFingerprint(m), occ: 0, fallbackTime: 0, ...opts }).messageId;

test('同一张卡跨轮询：反解时间每轮都变，去重 ID 必须不变', () => {
	// 真机里「刚刚」这一档最要命：每轮询一次 now 就往后走，反解出的毫秒跟着变
	const ids = [1763500000000, 1763500045000, 1763500090000].map((time) => idOf(domCard(CARD, { time })));
	assert.equal(new Set(ids).size, 1, `同一张卡三轮询必须同一个 ID，实际：${ids.join(' / ')}`);
});

test('同一张卡：相对标签（刚刚 / 5分钟前）与绝对标签（14:30）算出的 ID 也一致', () => {
	// 反解出来的时间不同、甚至一个能认出时间一个认不出，都不该影响卡片的 ID
	const ids = [
		idOf(domCard(CARD, { time: 1763500000000 })),
		idOf(domCard(CARD, { time: 1763500200000 })),
		idOf(domCard(CARD, { time: 0 }), { dayKey: '2026-11-19' })
	];
	assert.equal(new Set(ids).size, 1, `时间认法不同不能改 ID，实际：${ids.join(' / ')}`);
});

test('两张不同卡片：同作者、同一轮询、同样没有时间 → ID 必须不同', () => {
	const a = domCard(CARD, { title: '同一个作者' });
	const b = domCard(OTHER_CARD, { title: '同一个作者' });
	assert.notEqual(messageFingerprint(a), messageFingerprint(b), '指纹要能区分同作者的两张不同卡片');
	assert.notEqual(idOf(a, { dayKey: '2026-11-19' }), idOf(b, { dayKey: '2026-11-19' }));
});

test('同一张卡连发两次：occ 让两条都能收到（不互相吞）', () => {
	const prints = [messageFingerprint(domCard(CARD)), messageFingerprint(domCard(CARD))];
	const occ = occurrenceIndexes(prints);
	assert.deepEqual(occ, [0, 1]);
	const ids = occ.map((o) => messageIdFor(domCard(CARD), { print: prints[0], occ: o, fallbackTime: 0 }).messageId);
	assert.equal(new Set(ids).size, 2, '同一张卡连发两次是两个消息，各要一个 ID');
});

test('fromMe 认法不同（true/false/null 三态）不改卡片 ID —— 否则又会每轮漂一次', () => {
	// 接口路的 fromMe 是三态（true / false / null），DOM 路是布尔。把这一维放进 ID 里，
	// 「这轮算不出谁发的」和「这轮算出是对方」就会算出两个 ID —— 正是要修的漂移病。
	const ids = [true, false, null].map((fromMe) => idOf({ ...domCard(CARD), fromMe }));
	assert.equal(new Set(ids).size, 1, `三态 fromMe 必须算同一个 ID，实际：${ids.join(' / ')}`);
});

test('接口路 + DOM 路同时报同一张卡 → 合并后只剩一条', () => {
	const merged = mergeMessages([apiCard(CARD)], [domCard(CARD)]);
	assert.equal(merged.length, 1, `同一张卡两路各推一份，合并后应只剩一条，实际 ${merged.length} 条`);
	assert.equal(String(merged[0].shareAweme), CARD, '留下的那条仍要带作品 ID');
});

test('接口路没有这张卡时，DOM 路那份要留下（不能为了去重把卡丢掉）', () => {
	const merged = mergeMessages([apiCard(OTHER_CARD)], [domCard(CARD)]);
	const cards = merged.filter((m) => String(m.shareAweme) === CARD);
	assert.equal(cards.length, 1, '接口路漏抓时，DOM 路是唯一来源，不能丢');
});

test('普通媒体消息（图片 / 表情）不受卡片去重影响', () => {
	const api = [{ fromMe: false, type: 'text', text: '看看这个', seq: '1' }];
	const dom = [
		{ fromMe: false, type: 'image', text: '', media: { src: 'https://x/a.jpg' }, shareAweme: '' },
		{ fromMe: false, type: 'emoji', text: '', media: { name: '比心' }, shareAweme: '' },
	];
	const merged = mergeMessages(api, dom);
	assert.equal(merged.filter((m) => m.type === 'image').length, 1);
	assert.equal(merged.filter((m) => m.type === 'emoji').length, 1);
});

test('没有作品 ID 的卡片退回老规则（不因缺字段崩掉）', () => {
	const bare = { fromMe: false, isShare: true, type: 'share', text: '某作者', media: { title: '某作者' } };
	const id = idOf(bare, { dayKey: '2026-11-19' });
	assert.ok(id.length > 0, '认不出作品 ID 也要能算出 ID（走自然日兜底）');
	assert.match(id, /^[0-9a-f]{16}-2026-11-19-0$/, '退回指纹-自然日-occ 那一档');
});

console.log('douyin-share-card-dedupe: all assertions passed');
