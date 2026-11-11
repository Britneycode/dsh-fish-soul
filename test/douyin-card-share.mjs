// 抖音原生视频卡片分享：收件人锁定 / 原生证据 / 两阶段交付。
//
// 全程内存 SQLite + 假页面 + 假驱动：不碰真实浏览器、不发真实消息。
// 覆盖的红线：
//   · 收件人只能按 data-userid 唯一锁定 —— 缺失 / 重复 / 被遮挡一律不发送
//   · 只有平台自己的原生卡片 itemId 算证据（toast、文字链接都不算）
//   · 卡片没确认，不能用「文字发成功了」结账
//   · 提交后结果未知 → 不自动重发（可能重复分享）
//   · 卡片确认了、说明失败 → 只重试说明，不重发卡片
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { deliverDouyinCards, douyinVideoIds, removeCardLinks } from '../lib/douyin-delivery.js';
import { recipientFromPage, nativeCardsFromPage } from '../lib/channels/vendor/douyin-bridge/douyin-share.mjs';
import { LifeEngine } from '../lib/life.js';
import { openDatabase, getKv, setKv } from '../lib/db.js';
import { mediaMethods } from '../lib/gateway-media.js';
import { ChatGateway } from '../lib/gateway.js';
import { tmpHome } from './_tmp.mjs';

const UID = '3263818752859615';       // 主人的抖音数字 uid（分享面板上的 data-userid）
const OTHER = '123456789';
const SELF = '999888777';            // 她自己的 uid
const VIDEO = '7689317564177976586';  // 要分享的作品 ID
const VIDEO2 = '7700540332518130661';
const NAME = '主人昵称';
const CHANNEL_ID = `douyin:${NAME}`;
const CONV = `0:1:${SELF}:${UID}`;

// ── 假页面 ──────────────────────────────────────────────────────

/** 造一个只有 data-userid 按钮的页面。covered=true 时按钮被别的东西盖住。 */
function fakePanel(buttons, { covered = false } = {}) {
	globalThis.document = {
		querySelectorAll: (selector) => (String(selector).includes('data-userid')
			? buttons.filter((b) => b.getAttribute('data-userid') !== null)
			: buttons),
		// 真实页面：这个点上是什么就是什么。假页面按按钮的位置算。
		elementFromPoint: (x, y) => {
			if (covered) return { notTheButton: true };
			return buttons.find((b) => {
				const r = b.getBoundingClientRect();
				return x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
			}) ?? null;
		},
	};
	globalThis.getComputedStyle = (el) => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible' });
	globalThis.innerWidth = 1900;
	globalThis.innerHeight = 960;
	return () => {
		delete globalThis.document;
		delete globalThis.getComputedStyle;
		delete globalThis.innerWidth;
		delete globalThis.innerHeight;
	};
}

const btn = (uid, { hidden = false, text = '分享', left = 400 } = {}) => ({
	uid, hidden, innerText: text, left,
	getAttribute: (name) => (name === 'data-userid' ? uid : null),
	getBoundingClientRect: () => ({ width: 70, height: 32, left, top: 400 }),
	scrollIntoView() {},
	contains: () => false,
});

/** 造一个「原生卡片气泡」节点：平台消息里带 parsedContent.itemId。 */
function cardNode(itemId, { mine = true, className = 'MessageItemShareAwemecontainer' } = {}) {
	return {
		className,
		__reactProps$x: { children: { props: { message: { isMyMessage: mine, parsedContent: { itemId } } } } },
		parentElement: null,
	};
}

/** 假页面：认得选择器 —— 只有原生分享卡片的类名才算卡片气泡。 */
function fakeCards(nodes) {
	globalThis.document = {
		querySelectorAll: (selector) => (String(selector).includes('MessageItemShareAwemecontainer')
			? nodes.filter((n) => String(n.className ?? '').includes('MessageItemShareAwemecontainer'))
			: nodes),
	};
	return () => { delete globalThis.document; };
}

// ── 交付层用的内存库 ────────────────────────────────────────────

function memory() {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	return db;
}

// ── 收件人锁定 ──────────────────────────────────────────────────

test('按 data-userid 锁定收件人；别人排在前面也不能选错', () => {
	const restore = fakePanel([btn(OTHER, { left: 100 }), btn(UID, { left: 400 })]);
	try {
		const hit = recipientFromPage({ uid: UID });
		assert.equal(hit.ok, true);
		assert.equal(hit.uid, UID);
		assert.equal(hit.text, '分享');
		assert.equal(recipientFromPage({ uid: OTHER }).uid, OTHER);
	} finally { restore(); }
});

test('收件人 uid 缺失 → 不发送', () => {
	const restore = fakePanel([btn(OTHER)]);
	try {
		const r = recipientFromPage({ uid: UID });
		assert.equal(r.ok, false);
		assert.equal(r.reason, 'not_found');
	} finally { restore(); }
});

test('两个同 uid 的可见按钮 → 有歧义，不发送', () => {
	const restore = fakePanel([btn(UID), btn(UID)]);
	try {
		const r = recipientFromPage({ uid: UID });
		assert.equal(r.ok, false);
		assert.equal(r.reason, 'ambiguous');
	} finally { restore(); }
});

test('被遮挡的按钮 → 不发送', () => {
	const restore = fakePanel([btn(UID)], { covered: true });
	try {
		const r = recipientFromPage({ uid: UID });
		assert.equal(r.ok, false);
		assert.equal(r.reason, 'covered');
	} finally { restore(); }
});

test('隐藏的副本不算目标（不算歧义，但也选不中）', () => {
	const restore = fakePanel([btn(UID, { hidden: true })]);
	try {
		const r = recipientFromPage({ uid: UID });
		assert.equal(r.ok, false);
		assert.equal(r.reason, 'not_found');
	} finally { restore(); }
});

// ── 证据：只有原生 itemId 算数 ──────────────────────────────────

test('原生卡片气泡里的 itemId 才是证据', () => {
	const restore = fakeCards([cardNode(VIDEO)]);
	try {
		assert.deepEqual(nativeCardsFromPage(), [{ videoId: VIDEO, fromMe: true, native: true }]);
	} finally { restore(); }
});

test('不是自己发的卡片不算证据', () => {
	const restore = fakeCards([cardNode(VIDEO, { mine: false })]);
	try {
		assert.deepEqual(nativeCardsFromPage(), []);
	} finally { restore(); }
});

test('文字链接 / 普通气泡（没有平台 itemId）不算证据', () => {
	// toast、「分享成功」提示、文字链接气泡：既不是原生分享卡片，也没有平台的 itemId
	const restore = fakeCards([
		{ className: 'MessageItemBubble', innerText: `https://www.douyin.com/video/${VIDEO}`, parentElement: null },
		{ className: 'MessageItemShareAwemecontainer', innerText: `https://www.douyin.com/video/${VIDEO}`, parentElement: null },
	]);
	try {
		assert.deepEqual(nativeCardsFromPage(), []);
	} finally { restore(); }
});

// ── 两阶段交付 ──────────────────────────────────────────────────

test('链接去重：只移除已经发成卡片的作品', () => {
	const text = `看看 https://www.douyin.com/video/${VIDEO}\n还有 https://www.douyin.com/video/${VIDEO2}`;
	assert.deepEqual(douyinVideoIds(text), [VIDEO, VIDEO2]);
	assert.match(removeCardLinks(text, [VIDEO]), new RegExp(VIDEO2));
	assert.doesNotMatch(removeCardLinks(text, [VIDEO]), new RegExp(VIDEO));
});

test('卡片和说明都确认，重复调用不重复分享', async () => {
	const db = memory();
	let cards = 0;
	let texts = 0;
	const args = {
		db, deliveryId: 'pending:1', videoIds: [VIDEO], caption: '给你看这个',
		sendCard: async (id, onSubmitted) => { cards++; onSubmitted(); return { ok: true, verified: true }; },
		sendText: async () => { texts++; return { ok: true, delivered: true }; },
	};
	assert.equal((await deliverDouyinCards(args)).ok, true);
	assert.equal((await deliverDouyinCards(args)).ok, true);
	assert.equal(cards, 1, '卡片只发一次');
	assert.equal(texts, 1, '说明只发一次');
	db.close();
});

test('卡片没确认：不允许用「文字发成功了」结账', async () => {
	const db = memory();
	let texts = 0;
	const r = await deliverDouyinCards({
		db, deliveryId: 'f', videoIds: [VIDEO], caption: '不能代替卡片',
		sendCard: async () => ({ ok: false, submitted: false, error: '收件人 uid 认不出来' }),
		sendText: async () => { texts++; return { ok: true, delivered: true }; },
	});
	assert.equal(r.ok, false);
	assert.equal(r.verified, false);
	assert.equal(texts, 0, '说明根本没发出去');
	db.close();
});

test('提交后没确认（unknown）：不自动重发', async () => {
	const db = memory();
	let cards = 0;
	const args = {
		db, deliveryId: 'unknown', videoIds: [VIDEO],
		sendCard: async (id, onSubmitted) => { cards++; onSubmitted(); return { ok: false, submitted: true, error: '没等到原生卡片' }; },
	};
	const first = await deliverDouyinCards(args);
	assert.equal(first.ok, false);
	assert.equal(first.unknown, true);
	const second = await deliverDouyinCards(args);
	assert.equal(second.unknown, true, '仍然待核实');
	assert.equal(cards, 1, '绝不重发卡片 —— 可能已经发出去了');
	db.close();
});

test('卡片确认了、说明失败：只重试说明，不重发卡片', async () => {
	const db = memory();
	let cards = 0;
	let texts = 0;
	const args = {
		db, deliveryId: 'partial', videoIds: [VIDEO], caption: '说明',
		sendCard: async (id, onSubmitted) => { cards++; onSubmitted(); return { ok: true, verified: true }; },
		sendText: async () => { texts++; return { ok: true, delivered: false }; },
	};
	const first = await deliverDouyinCards(args);
	assert.equal(first.ok, false);
	assert.equal(first.unknown, true);
	assert.equal(first.cardVerified, true, '卡片已经确认了');
	const second = await deliverDouyinCards(args);
	assert.equal(second.unknown, true, '说明没确认前不重发卡片');
	assert.equal(cards, 1, '卡片不重发');
	assert.equal(texts, 1, '说明也不盲重发，等人工核实');
	db.close();
});

test('提交前就失败（没点下去）→ 可以重试', async () => {
	const db = memory();
	let cards = 0;
	const args = {
		db, deliveryId: 'retryable', videoIds: [VIDEO],
		sendCard: async () => { cards++; return { ok: false, submitted: false, error: '面板没打开' }; },
	};
	assert.equal((await deliverDouyinCards(args)).unknown, false, '没提交过 = 不算待核实');
	assert.equal((await deliverDouyinCards(args)).unknown, false);
	assert.equal(cards, 2, '没发出去的可以再来一次');
	db.close();
});

test('说明明确没发出去 → 重试时只发说明，不重发卡片', async () => {
	const db = memory();
	let cards = 0;
	let texts = 0;
	const args = {
		db, deliveryId: 'caption-retry', videoIds: [VIDEO], caption: '说明',
		sendCard: async (id, onSubmitted) => { cards++; onSubmitted(); return { ok: true, verified: true }; },
		sendText: async () => { texts++; return { ok: false, error: '输入框没打开' }; },
	};
	const first = await deliverDouyinCards(args);
	assert.equal(first.ok, false);
	assert.equal(first.unknown, false, '明确没发出去 ≠ 结果待核实');
	assert.equal(first.cardVerified, true, '卡片已经确认了');
	const second = await deliverDouyinCards(args);
	assert.equal(cards, 1, '卡片不重发');
	assert.equal(texts, 2, '只重试说明');
	db.close();
});

// ── 接线：queueShare → 抖音原生卡片 ───────────────────────────────

const CLOCK = { now: () => 1794360000000, getRoleDateParts: () => ({ dateStr: '2026-11-11', hour: 12 }) };

function config(over = {}) {
	return {
		proactive: {
			enabled: true, activeHours: [0, 24], dailyMaxCount: 10, shareMaxPerDay: 5,
			targets: { masterCanonicalId: 'user:master', masterPrivateChannelId: 'private:123', selfGroupChannelIds: [] },
		},
		douyin: { enabled: true, shareCard: true, masterName: NAME, masterUid: `douyin:${UID}`, browse: { enabled: true, share: true } },
		...over,
	};
}

/** 完整库（pending / kv / person 都要）。 */
function fullDb(tag) {
	const prev = process.env.DSH_HOME;
	process.env.DSH_HOME = tmpHome(`dsh-card-${tag}-`);
	const db = openDatabase();
	process.env.DSH_HOME = prev;
	return db;
}

test('刷到的分享排进抖音时，作品 ID 和感受直接落盘（不指望模型抄链接）', () => {
	const db = fullDb('queue');
	const life = new LifeEngine({
		db, clock: CLOCK, getConfig: () => config(), log: () => {},
		douyinShareTarget: () => ({ channelId: CHANNEL_ID, uid: UID, convId: CONV, name: NAME }),
	});
	life.armPendingAlarm = () => {};
	const r = life.queueShare({ platform: '抖音', title: '小猫', url: `https://www.douyin.com/video/${VIDEO}`, impression: '这个看着开心' });
	assert.equal(r.ok, true);
	const row = db.prepare('SELECT * FROM pending WHERE id = ?').get(r.id);
	assert.equal(row.channel_id, CHANNEL_ID, '分享要排进抖音私信');
	assert.equal(row.origin, 'share');
	const intent = getKv(db, `share.intent.${r.id}`);
	assert.equal(intent?.videoId, VIDEO, '作品 ID 要落盘');
	assert.equal(intent?.caption, '这个看着开心', '感受要落盘');
	db.close();
});

test('拿不到作品 ID 的分享还是走 QQ（别排一条发不出去的抖音任务）', () => {
	const db = fullDb('nofallback');
	const life = new LifeEngine({
		db, clock: CLOCK, getConfig: () => config(), log: () => {},
		douyinShareTarget: () => ({ channelId: CHANNEL_ID, uid: UID, convId: CONV, name: NAME }),
	});
	life.armPendingAlarm = () => {};
	const r = life.queueShare({ platform: '抖音', title: '小猫', url: 'https://example.com/x', impression: '还行' });
	assert.equal(r.ok, true);
	const row = db.prepare('SELECT * FROM pending WHERE id = ?').get(r.id);
	assert.equal(row.channel_id, 'private:123', '没有作品 ID 就退回 QQ 文字分享');
	db.close();
});

// ── 目标身份：确认了才给真的抖音私信目标 ───────────────────────────

test('身份没确认前不给抖音分享目标；确认了才给 channelId + uid + 会话名', () => {
	const db = fullDb('target');
	const mk = (cfg) => Object.assign(Object.create(mediaMethods), { db, douyinConfig: () => cfg, getConfig: () => ({}) });
	const full = { enabled: true, shareCard: true, masterName: NAME, masterUid: `douyin:${UID}` };

	// 开关关着 → 不给
	assert.equal(mk({ ...full, shareCard: false }).douyinShareTarget(), '', '卡片开关关着就不走抖音');
	// 身份没填 → 不给
	assert.equal(mk({ ...full, masterUid: '' }).douyinShareTarget(), '', '认不出主人身份就不给');
	// 身份认得出，但没聊过（没有会话 ID）→ 不给
	setKv(db, `douyin.convId.douyin:${UID}`, '');
	assert.equal(mk(full).douyinShareTarget(), '', '没有确认过的会话 ID 就不给');
	// 都齐了 → 给真的目标
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);
	assert.deepEqual(mk(full).douyinShareTarget(), { channelId: CHANNEL_ID, uid: UID, convId: CONV, name: NAME });
	db.close();
});

// ── 投递：卡片 / 说明两段，结论由卡片说了算 ─────────────────────────

/** 网关假身：只实现卡片交付这条路上用到的那几个方法。 */
function fakeGw(db, { card, text } = {}) {
	return Object.assign(Object.create(mediaMethods), {
		db,
		getConfig: () => config(),
		douyinConfig: () => ({ enabled: true, shareCard: true, masterName: NAME, masterUid: `douyin:${UID}` }),
		log: () => {},
		note: () => {},
		douyin: { shareCard: card ?? (async () => ({ ok: true, verified: true })) },
		sendDouyin: text ?? (async () => ({ ok: true, delivered: true, parts: [{ ok: true, delivered: true }] })),
	});
}

test('投递走原生卡片：卡片 + 说明各走各的，模型不参与', async () => {
	const db = fullDb('deliver');
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);
	const calls = [];
	const gw = fakeGw(db, {
		card: async (p, onSubmitted) => { calls.push({ kind: 'card', p }); onSubmitted(); return { ok: true, verified: true }; },
		text: async (row, text, imgs, convId) => { calls.push({ kind: 'text', text, convId }); return { ok: true, delivered: true, parts: [{ ok: true, delivered: true }] }; },
	});
	setKv(db, 'share.intent.7', { videoId: VIDEO, caption: '这个看着开心' });
	const ok = await mediaMethods.deliverDouyinShare.call(gw, CHANNEL_ID, '分享', { pendingId: 7 });
	assert.equal(ok, true);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].kind, 'card');
	assert.equal(calls[0].p.videoId, VIDEO);
	assert.equal(calls[0].p.peerUid, UID);
	assert.equal(calls[0].p.convId, CONV);
	assert.equal(calls[0].p.friendName, NAME);
	assert.equal(calls[1].kind, 'text');
	assert.equal(calls[1].text, '这个看着开心');
	assert.equal(calls[1].convId, CONV);
	db.close();
});

test('卡片没确认：说明发成功也不许结账（不能拿文字冒充卡片）', async () => {
	const db = fullDb('nocard');
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);
	let texts = 0;
	const gw = fakeGw(db, {
		card: async () => ({ ok: false, submitted: false, error: '收件人 uid 认不出来' }),
		text: async () => { texts++; return { ok: true, delivered: true, parts: [{ ok: true, delivered: true }] }; },
	});
	setKv(db, 'share.intent.8', { videoId: VIDEO, caption: '这个看着开心' });
	const ok = await mediaMethods.deliverDouyinShare.call(gw, CHANNEL_ID, '分享', { pendingId: 8 });
	assert.equal(ok, false, '卡片没确认就不算发出去');
	assert.equal(texts, 0, '说明根本不该发');
	db.close();
});

test('提交后没确认（unknown）：重试也不重发卡片', async () => {
	const db = fullDb('unknown');
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);
	let cards = 0;
	const gw = fakeGw(db, {
		card: async (p, onSubmitted) => { cards++; onSubmitted(); return { ok: false, submitted: true, error: '没等到原生卡片' }; },
	});
	setKv(db, 'share.intent.9', { videoId: VIDEO, caption: '这个看着开心' });
	assert.equal(await mediaMethods.deliverDouyinShare.call(gw, CHANNEL_ID, '分享', { pendingId: 9 }), false);
	assert.equal(await mediaMethods.deliverDouyinShare.call(gw, CHANNEL_ID, '分享', { pendingId: 9 }), false);
	assert.equal(cards, 1, '绝不重发卡片 —— 可能已经发出去了');
	db.close();
});

test('卡片确认了、说明失败：只重试说明，不重发卡片', async () => {
	const db = fullDb('partial');
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);
	let cards = 0;
	let texts = 0;
	const gw = fakeGw(db, {
		card: async (p, onSubmitted) => { cards++; onSubmitted(); return { ok: true, verified: true }; },
		text: async () => { texts++; return { ok: false, error: '输入框没打开' }; },
	});
	setKv(db, 'share.intent.10', { videoId: VIDEO, caption: '这个看着开心' });
	assert.equal(await mediaMethods.deliverDouyinShare.call(gw, CHANNEL_ID, '分享', { pendingId: 10 }), false);
	assert.equal(cards, 1);
	assert.equal(texts, 1);
	assert.equal(await mediaMethods.deliverDouyinShare.call(gw, CHANNEL_ID, '分享', { pendingId: 10 }), false);
	assert.equal(cards, 1, '卡片不重发');
	assert.equal(texts, 2, '只重试说明');
	db.close();
});

// ── 主动开口：抖音分享走卡片这条路，不经过模型 ───────────────────────

test('主动开口的抖音分享走卡片；不是分享的抖音主动消息仍然一律不发', async () => {
	const calls = [];
	const fake = {
		isPaused: () => false,
		note: () => {},
		deliverDouyinShare: async (...args) => { calls.push(args); return true; },
	};
	assert.equal(await ChatGateway.prototype.triggerProactive.call(fake, CHANNEL_ID, '分享', { origin: 'share' }), true);
	assert.equal(calls.length, 1);
	assert.equal(await ChatGateway.prototype.triggerProactive.call(fake, CHANNEL_ID, '随便聊聊', { origin: 'idle' }), false);
	assert.equal(calls.length, 1, '不是分享的抖音主动消息还是不发');
});
