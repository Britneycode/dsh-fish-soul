// 聊天里发抖音链接 → 原生卡片（对所有会话生效）。
//
// 为什么要有这个测试（2026-11-19 真机）：
//   主人问「有没有有趣的视频分享给我」，她用**文字**回了两条链接（截图里就是纯链接）。
//   原生卡片以前只在「她自己起意的分享待办」那条路才发，普通聊天回复走纯文本。
//   现在出站层把「单独成段的链接」改发卡片 —— 但有三条边界不能破，见下。
import assert from 'node:assert/strict';

import { ALONE_LINK } from '../lib/douyin-share-inline.js';
import { DouyinAdapter } from '../lib/douyin-adapter.js';

const ok = (m) => console.log('✓', m);

// ── 1. ALONE_LINK 必须是整段全匹配 ──
assert.equal(ALONE_LINK.test('https://www.douyin.com/video/7707911549709601777'), true, '整段链接命中');
assert.equal(ALONE_LINK.test('https://v.douyin.com/abc123'), true, '短链命中');
// 🔴 边界②：链接和句子混在一段里**不能**命中 —— 否则前面那半句会跟着消失
assert.equal(ALONE_LINK.test('猫跳舞那个 看这个 https://www.douyin.com/video/7707911549709601777'), false, '混着文字不命中');
assert.equal(ALONE_LINK.test('https://www.douyin.com/video/7707911549709601777 挺好笑'), false, '后面带字不命中');
assert.equal(ALONE_LINK.test('https://www.bilibili.com/video/BV1xx'), false, 'B站链接不命中');
ok('ALONE_LINK：只认「整段就是抖音链接」');

// ── 2. shareTargetFor：会话身份确认过才能发卡片 ──
// 注意 cfg 里必须有 shareCard: true —— 设置页那个开关现在也管这条路了。
const makeAdapter = (cfg = {}) => new DouyinAdapter({
	db: () => ({}),
	getConfig: () => ({ douyin: { enabled: true, shareCard: true, ...cfg } }),
	inbox: () => null,
	channel: () => null,
	sendText: async () => ({ ok: false }),
	note: () => {}, log: () => {}, diag: () => {}
});

{
	const a = makeAdapter();
	assert.deepEqual(a.shareTargetFor('未云', '0:1:123:456'), { convId: '0:1:123:456', name: '未云' }, '会话 ID 合法就能发');
	// 关键：**不要求**是主人 —— 这是「对所有会话生效」的核心
	assert.ok(a.shareTargetFor('路人甲', '0:1:123:999') !== null, '非主人会话也能发卡片');
	ok('shareTargetFor：有会话 ID 就能发，不限主人');
}

{
	const a = makeAdapter();
	assert.equal(a.shareTargetFor('未云', ''), null, '没有会话 ID 不发');
	assert.equal(a.shareTargetFor('未云', '未云'), null, '昵称不是会话 ID，不发');
	assert.equal(a.shareTargetFor('未云', '0:2:123:456'), null, '群会话不是单聊，不发');
	assert.equal(a.shareTargetFor('', '0:1:123:456'), null, '没有会话名不发');
	ok('shareTargetFor：拿不到确认过的会话身份就退回文字');
}

{
	const a = makeAdapter({ enabled: false });
	assert.equal(a.shareTargetFor('未云', '0:1:123:456'), null, '抖音通道关着不发卡片');
	ok('shareTargetFor：总开关关着就不发');
}

{
	// 🔴 审查 #3：设置页那个「发原生卡片」开关关了，聊天里就不能发卡片
	const a = makeAdapter({ shareCard: false });
	assert.equal(a.shareTargetFor('未云', '0:1:123:456'), null, 'shareCard 开关关着就不发卡片');
	ok('shareTargetFor：shareCard 开关关着就不发（开关不能形同虚设）');
}

/** 造一个能记录卡片的适配器。 */
const spyAdapter = ({ cardOk = true, cardSubmitted = false, noShareCard = false } = {}) => {
	const cards = [];
	const texts = [];
	const adapter = new DouyinAdapter({
		db: () => ({}),
		getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
		inbox: () => null,
		channel: () => ({
			async shareCard(p) {
				cards.push(p);
				if (noShareCard) return { ok: false, verified: false, error: '通道不支持卡片' };
				if (cardSubmitted) return { ok: false, verified: false, submitted: true, error: '分享已提交，但目标私信中没有确认到指定视频的原生卡片' };
				return cardOk ? { ok: true, verified: true } : { ok: false, verified: false, error: '浏览器没在运行' };
			},
			async send(name, parts) {
				texts.push(...parts.filter((p) => p.type === 'text').map((p) => p.text));
				return { ok: true, delivered: true, parts: [] };
			}
		}),
		sendText: async () => ({ ok: false }),
		note: () => {}, log: () => {}, diag: () => {}
	});
	return { adapter, cards, texts };
};

// ── 3. 端到端：单独成段的链接走卡片，其余走文字 ──
// 真机那句话的原样形态：文字 + 链接 + 文字 + 链接
{
	const { adapter, cards, texts } = spyAdapter();
	const reply = [
		'猫跳舞那个 扭得特别有灵性 评论那句“命运在卡点”给我笑半天',
		'https://www.douyin.com/video/7707911549709601777',
		'还有个桌宠小鲸鱼的 结尾直接扭头走人',
		'https://www.douyin.com/video/7680160212863652'
	].join('\n\n');
	const r = await adapter.send({ channel_id: 'douyin:未云' }, reply, [], '0:1:123:456');
	assert.equal(cards.length, 2, `两条链接各发一张卡片，实际 ${cards.length}`);
	assert.deepEqual(cards.map((c) => c.videoId), ['7707911549709601777', '7680160212863652']);
	assert.equal(texts.length, 2, `两段文字照旧发，实际 ${texts.length}`);
	assert.ok(texts[0].includes('猫跳舞'), '第一段文字还在');
	assert.ok(texts[1].includes('桌宠小鲸鱼'), '第二段文字还在');
	assert.equal(r.ok, true);
	ok('端到端：文字和卡片各归各位');
}

// 🔴 审查 #7：卡片必须绑到**本轮这条会话**，不能发给别人
{
	const { adapter, cards } = spyAdapter();
	await adapter.send({ channel_id: 'douyin:未云' }, 'https://www.douyin.com/video/7707911549709601777', [], '0:1:123:456');
	assert.equal(cards.length, 1, '发了一张卡');
	assert.equal(cards[0].convId, '0:1:123:456', '卡片必须发到本轮这条会话（不能是别的会话）');
	assert.equal(cards[0].friendName, '未云', '收件人名字必须来自本轮会话名');
	ok('卡片收件人绑定：convId 和名字都来自本轮会话');
}

// 🔴 边界①：卡片发失败 → 退回文字，链接不能丢
{
	const { adapter, texts } = spyAdapter({ cardOk: false });
	const link = 'https://www.douyin.com/video/7707911549709601777';
	const r = await adapter.send({ channel_id: 'douyin:未云' }, link, [], '0:1:123:456');
	assert.deepEqual(texts, [link], '卡片失败要退回原链接，不能丢内容');
	assert.equal(r.ok, true, '退回的文字发出去了 ⇒ ok 仍然是 true（内容真的送到了）');
	assert.equal(r.delivered, true, '文字回读到了 ⇒ delivered true');
	assert.equal(r.cardOk, false, '但 cardOk 要是 false');
	assert.ok(String(r.cardFailed).includes('浏览器'), `卡片失败原因要单独报出来，实际：${r.cardFailed}`);
	ok('卡片失败：退回文字、链接不丢，内容送达 ok=true，卡片问题单独报');
}

// 🔴 审查 #2：卡片「提交过但没回读到」⇒ 不能把链接当文字再发一遍
{
	const { adapter, cards, texts } = spyAdapter({ cardSubmitted: true });
	const link = 'https://www.douyin.com/video/7707911549709601777';
	const r = await adapter.send({ channel_id: 'douyin:未云' }, link, [], '0:1:123:456');
	assert.equal(cards.length, 1, '提交过了');
	assert.deepEqual(texts, [], '🔴 提交过就可能已经发出去了 —— 绝不能把链接再当文字发一遍');
	assert.equal(r.ok, true, '内容大概率在那儿了 ⇒ ok=true（不谎报失败）');
	assert.equal(r.delivered, false, '但没回读到 ⇒ delivered=false（不谎报确认）');
	ok('卡片已提交未确认：不重复发链接，ok/delivered 分开报');
}

// 通道没有 shareCard 方法（老打桩）⇒ 不能整条抛，退回文字
{
	const cards = [];
	const texts = [];
	const adapter = new DouyinAdapter({
		db: () => ({}),
		getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
		inbox: () => null,
		channel: () => ({
			async send(name, parts) {
				texts.push(...parts.filter((p) => p.type === 'text').map((p) => p.text));
				return { ok: true, delivered: true, parts: [] };
			}
		}),
		sendText: async () => ({ ok: false }),
		note: () => {}, log: () => {}, diag: () => {}
	});
	const link = 'https://www.douyin.com/video/7707911549709601777';
	const r = await adapter.send({ channel_id: 'douyin:未云' }, link, [], '0:1:123:456');
	assert.deepEqual(texts, [link], '通道不支持卡片 ⇒ 退回文字');
	assert.equal(r.ok, true, '退回的文字发出去了');
	ok('通道没有 shareCard：退回文字，不整条抛');
}

// 🔴 边界②：链接和句子混在一段里 → 整段当文字，不发卡片（否则前面那半句会消失）
{
	const { adapter, cards, texts } = spyAdapter();
	const mixed = '看这个 https://www.douyin.com/video/7707911549709601777 挺好笑';
	await adapter.send({ channel_id: 'douyin:未云' }, mixed, [], '0:1:123:456');
	assert.equal(cards.length, 0, '混在句子里的链接不发卡片');
	assert.deepEqual(texts, [mixed], '整段原样发文字，一个字都不丢');
	ok('混排：整段当文字，不拆（否则前半句会消失）');
}

// 只有卡片、没有文字时不能因为「没有文字段」就报错
{
	const { adapter, cards } = spyAdapter();
	const r = await adapter.send({ channel_id: 'douyin:未云' }, 'https://www.douyin.com/video/7707911549709601777', [], '0:1:123:456');
	assert.equal(cards.length, 1, '纯链接也要发卡片');
	assert.equal(r.ok, true, '只有卡片也要算成功');
	ok('纯链接：只发卡片，不发多余的空文字');
}

// 🔴 顺序：按原顺序交错发（文字、卡、文字、卡），不是「卡片全先发」。
//
//    真机那句话的形态是「文字\n\n链接\n\n文字\n\n链接」。卡片全先发的话，
//    对方看到的是「卡、卡、文字、文字」—— 文字和链接的配对关系没了。
{
	const events = [];
	const adapter = new DouyinAdapter({
		db: () => ({}),
		getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
		inbox: () => null,
		channel: () => ({
			async shareCard(p) { events.push(`card:${p.videoId}`); return { ok: true, verified: true }; },
			async send(name, parts) {
				events.push(`text:${parts.filter((x) => x.type === 'text').map((x) => x.text).join('|')}`);
				return { ok: true, delivered: true, parts: [] };
			}
		}),
		sendText: async () => ({ ok: false }),
		note: () => {}, log: () => {}, diag: () => {}
	});
	const reply = [
		'猫跳舞那个 扭得特别有灵性',
		'https://www.douyin.com/video/7707911549709601777',
		'还有个桌宠小鲸鱼的 结尾直接扭头走人',
		'https://www.douyin.com/video/7680160212863652'
	].join('\n\n');
	await adapter.send({ channel_id: 'douyin:未云' }, reply, [], '0:1:123:456');
	assert.deepEqual(events, [
		'text:猫跳舞那个 扭得特别有灵性',
		'card:7707911549709601777',
		'text:还有个桌宠小鲸鱼的 结尾直接扭头走人',
		'card:7680160212863652'
	], `🔴 必须按原顺序交错发，实际：${JSON.stringify(events)}`);
	ok('顺序：文字、卡、文字、卡（配对关系保住）');
}

// 连续的文字段要合并成一次 send（每张卡都要走分享面板，别在卡之间反复进会话）
{
	const sends = [];
	const adapter = new DouyinAdapter({
		db: () => ({}),
		getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
		inbox: () => null,
		channel: () => ({
			async shareCard() { return { ok: true, verified: true }; },
			async send(name, parts) { sends.push(parts.length); return { ok: true, delivered: true, parts: [] }; }
		}),
		sendText: async () => ({ ok: false }),
		note: () => {}, log: () => {}, diag: () => {}
	});
	await adapter.send({ channel_id: 'douyin:未云' }, '第一段\n\n第二段\n\n第三段', [], '0:1:123:456');
	assert.deepEqual(sends, [3], `连续文字段要合并成一次 send，实际 ${JSON.stringify(sends)}`);
	ok('连续文字段合并成一次 send（不逐段进会话）');
}

console.log('抖音链接自动发卡片：测试全部通过');
