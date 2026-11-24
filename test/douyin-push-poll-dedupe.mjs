import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { tmpHome } from './_tmp.mjs';

// 🔴 抖音「推送路 + 轮询路」把同一条消息入库两遍（真机 2026-11-23 报障）。
//
// 症状：抖音私信只发了一次，DSH 里却跑了两轮、回了两次（只有抖音那条最终发出去）。
// 根因在入库 ID：唯一键是 UNIQUE(channel_id, message_id)，而两条路各自拼 ID ——
//   · 推送路 print = `push-<convId>-<内容哈希>`
//   · 轮询路 print = messageFingerprint(m)
// 消息**没有平台 seq** 时（DOM 反解出来的轮询消息就是这种），指纹不同 ⇒ ID 不同 ⇒
// INSERT OR IGNORE 放行两行 ⇒ onMessage 被调两次 ⇒ 两轮回复。
// 有 seq 的接口消息走 `s<seq>` 档，两条路本来就对得上，所以这个洞只在无 seq 时露出来。
//
// 判据（打真 DouyinChannel + 真 SQLite，不碰真实账号）：
//   ① 推送先到、轮询后到 ⇒ 只交付一次
//   ② 轮询先到、推送后到 ⇒ 只交付一次
//   ③ 同样两条路，各自入库的 messageId 必须一致
//   ④ 不回归：对方真连发两句一样的话，两句都要收到

process.env.DSH_HOME = tmpHome('douyin-push-poll-dup-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');
const { DouyinInbox } = await import('../lib/douyin-inbox.js');

const db = openDatabase();
new DouyinInbox(db).status(); // 建表（懒创建）

const SELF = '900001';
const PEER = '7000000000000000001';
const CONV = `0:1:${SELF}:${PEER}`;
const NAME = '未云';
const keyOf = (name) => `douyin.conv.${createHash('sha1').update(String(name)).digest('hex').slice(0, 16)}`;

function reset() {
	db.exec("DELETE FROM kv WHERE key LIKE 'douyin.%'");
	db.exec('DELETE FROM douyin_inbox');
	db.exec('DELETE FROM douyin_inbox_gap');
	db.exec('DELETE FROM douyin_inbox_read_intent');
}

// ── 推送帧：和真机同一条路（protobuf → #8 外壳 → base64）───────────────────
function varint(n) {
	let v = BigInt(n); const b = [];
	while (v >= 128n) { b.push(Number(v & 127n) | 128); v >>= 7n; }
	b.push(Number(v));
	return Buffer.from(b);
}
const field = (id, n) => Buffer.concat([varint(id * 8), varint(n)]);
const bytesField = (id, buf) => Buffer.concat([varint(id * 8 + 2), varint(buf.length), buf]);

/** 一条消息的 protobuf。seq 为 null = 不带 #17（真实推送帧里经常没有）。 */
function messageBytes(convId, text, { time = Date.now(), seq = null, senderId = PEER } = {}) {
	const parts = [
		bytesField(1, Buffer.from(convId)),
		field(2, 1),
		field(6, 7), // kind 7 = 文本
		field(7, senderId),
		bytesField(8, Buffer.from(JSON.stringify({ text }))),
		field(10, time),
	];
	if (seq !== null) parts.push(field(17, seq));
	return Buffer.concat(parts);
}

function frameEvent(convId, texts, opts = {}) {
	const list = texts.map((t, i) => messageBytes(convId, t, { ...opts, seq: opts.seq != null ? opts.seq + i : null }));
	const inner = bytesField(6, bytesField(301, Buffer.concat(list)));
	return {
		method: 'Network.webSocketFrameReceived',
		params: { requestId: 'sock', response: { payloadData: Buffer.concat([Buffer.from([0x42]), varint(inner.length), inner]).toString('base64') } },
	};
}

/** 造真 DouyinChannel：只有浏览器 / 驱动是假的。 */
function makeChannel({ read } = {}) {
	const browser = { events: [], eval: async () => [] };
	const delivered = [];
	const ch = new DouyinChannel({
		db,
		host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn(), browser },
		getConfig: () => ({ enabled: true }),
		log: () => {},
		onMessage: async (m) => { delivered.push(m); return { done: true }; },
		driver: {
			checkLogin: async () => true,
			list: async () => ({ ok: true, conversations: [] }),
			read: async () => (read ? read() : { ok: true, convId: CONV, messages: [] }),
		},
		pollRangeMs: [1000, 2000],
	});
	ch.lastCanaryAt = Date.now(); // 跳过自检（自检要开面板，这里是假的）
	ch.delivered = delivered;
	return ch;
}

/** 轮询路读回来的同一条消息。DOM 路会给 `type:'text'`，接口路不给 —— 这里按 DOM 形状造。 */
function polledMessage({ text, at, seq = null }) {
	const m = { fromMe: false, senderId: PEER, convId: CONV, type: 'text', text, time: at };
	if (seq !== null) m.seq = String(seq);
	return m;
}

test('接口形状的轮询消息也不能与推送重复入库', async () => {
	reset();
	seedCursor();
	const at = Date.now() - 5_000;
	const text = '接口路也只回一次';
	const ch = makeChannel({ read: async () => ({ ok: true, convId: CONV, messages: [{ fromMe: false, senderId: PEER, convId: CONV, kind: 7, text, time: at }] }) });
	ch.host.browser.events = [frameEvent(CONV, [text], { time: at })];
	await ch.consumePushFrames();
	await ch.drainInbox();
	await readOnce(ch);
	assert.equal(inboxIds().length, 1, '接口形状与推送形状必须命中同一个唯一键');
	assert.deepEqual(ch.delivered.map((m) => m.text), [text]);
});

const inboxIds = () => db.prepare('SELECT message_id FROM douyin_inbox ORDER BY id').all().map((r) => r.message_id);
const inboxTexts = () => db.prepare('SELECT payload FROM douyin_inbox ORDER BY id').all().map((r) => JSON.parse(r.payload).text);

/** 让推送路认得出这个会话（轮询路早就学过游标）。readAt=0 ⇒ 推送先入库。 */
function seedCursor() {
	db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run(keyOf(NAME), JSON.stringify({
		name: NAME, sig: 'x', convId: CONV, identity: `douyin:${PEER}`, window: [], readAt: 0,
	}));
}

const readOnce = (ch) => ch.readConversation({ c: {}, name: NAME, key: keyOf(NAME), st: null, sig: 'x', unread: true });

// ── ① 推送先到、轮询后到 ────────────────────────────────────────────────────
test('推送先到、轮询后到：只入库一次、只交付一次（双回的原症状）', async () => {
	reset();
	seedCursor();
	const at = Date.now() - 5_000;
	const text = '你发过抖音吗';
	const ch = makeChannel({ read: async () => ({ ok: true, convId: CONV, messages: [polledMessage({ text, at })] }) });

	ch.host.browser.events = [frameEvent(CONV, [text], { time: at })];
	await ch.consumePushFrames();
	await ch.drainInbox();

	ch.host.browser.events = [];
	await readOnce(ch);
	await ch.drainInbox();

	assert.equal(inboxIds().length, 1, `同一条消息只能入库一行，实际 ${inboxIds().length}：${inboxIds().join(' | ')}`);
	assert.deepEqual(ch.delivered.map((m) => m.text), [text], `一条消息只能交付一次，实际交付 ${ch.delivered.length} 次`);
});

// ── ② 轮询先到、推送后到 ────────────────────────────────────────────────────
test('轮询先到、推送后到：只入库一次、只交付一次', async () => {
	reset();
	seedCursor();
	const at = Date.now() - 5_000;
	const text = '这条只在抖音发了一次';
	const ch = makeChannel({ read: async () => ({ ok: true, convId: CONV, messages: [polledMessage({ text, at })] }) });

	await readOnce(ch);
	await ch.drainInbox();

	ch.host.browser.events = [frameEvent(CONV, [text], { time: at })];
	await ch.consumePushFrames();
	await ch.drainInbox();

	assert.equal(inboxIds().length, 1, `同一条消息只能入库一行，实际 ${inboxIds().length}：${inboxIds().join(' | ')}`);
	assert.deepEqual(ch.delivered.map((m) => m.text), [text], `一条消息只能交付一次，实际交付 ${ch.delivered.length} 次`);
});

// ── ③ 两条路算出的 ID 必须一致（机制本身，不是症状）────────────────────────
test('同一条无 seq 消息：推送路与轮询路入库的 messageId 必须一致', async () => {
	reset();
	seedCursor();
	const at = Date.now() - 5_000;
	const text = '同一条消息';
	const ch = makeChannel({ read: async () => ({ ok: true, convId: CONV, messages: [polledMessage({ text, at })] }) });

	ch.host.browser.events = [frameEvent(CONV, [text], { time: at })];
	await ch.consumePushFrames();
	await ch.drainInbox();
	const pushId = inboxIds()[0];

	db.exec('DELETE FROM douyin_inbox'); // 只清收件箱、保留游标：让轮询路把它当新消息再算一次 ID
	ch.host.browser.events = [];
	await readOnce(ch);
	const pollId = inboxIds()[0];

	assert.equal(pushId, pollId, `两条路必须算出同一个 ID，否则唯一键形同虚设：push=${pushId} poll=${pollId}`);
});

// ── ④ 不回归：连发两句一样的话都要收到 ─────────────────────────────────────
test('对方连发两句一样的话：两条都要入库（不能按内容一刀切去重）', async () => {
	reset();
	seedCursor();
	const at = Date.now() - 5_000;
	const ch = makeChannel();

	ch.pushStats = { stored: 0 };
	ch.storePushMessages({ name: NAME, convId: CONV, identity: `douyin:${PEER}`, messages: [
		{ fromMe: false, senderId: PEER, convId: CONV, type: 'text', text: '在', time: at },
		{ fromMe: false, senderId: PEER, convId: CONV, type: 'text', text: '在', time: at },
	] });
	await ch.drainInbox();

	assert.deepEqual(inboxTexts(), ['在', '在'], `连发的两句必须都收到，实际 ${JSON.stringify(inboxTexts())}`);
});

test.after(() => db.close());
console.log('douyin-push-poll-dedupe ok');
