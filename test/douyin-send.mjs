/**
 * 抖音发送与卡片分享（PR4）：send / shareTarget / deliverShare / sendBlocker。
 *
 * 重点是**接线**：网关上的 sendDouyin / douyinShareTarget / deliverDouyinShare /
 * masterDouyinSendBlocker 必须真的经适配器（不是各写一份）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-send-');
const { openDatabase, setKv } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { DouyinAdapter } = await import('../lib/douyin-adapter.js');

const UID = '7000000000000000001';
// ⚠️ 这里必须是**明显假的** uid：仓库是公开的，真实 uid 提交后不可撤回
//    （check-secrets 会抓，见 docs/engineering-lessons.md）。
const SELF = '1234567890123456789';
const CONV = `0:1:${UID}:${SELF}`;
const NAME = '主人抖音';

/**
 * 造一个带 spy 抖音通道的适配器。
 *
 * ⚠️ 每个实例用**独立的内存库**：`openDatabase()` 在模块加载时固定 DSH_HOME，
 *    同一个文件里的多个实例会共用一个库 ⇒ 前一节写进去的会话 ID 会让后一节
 *    的「没有会话」场景变成「有会话」（跨小节串，见工程经验）。
 */
function makeAdapter(overrides = {}) {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	db.exec('CREATE TABLE IF NOT EXISTS person (canonical_id TEXT PRIMARY KEY, qq_uin TEXT, douyin_uid TEXT, display_name TEXT, aliases TEXT, relation_stage TEXT, interaction_count INTEGER, first_seen_at INTEGER, last_seen_at INTEGER)');
	const sent = [];
	const adapter = new DouyinAdapter({
		db,
		getConfig: () => ({
			masterQqUin: '12345678',
			douyin: { enabled: true, shareCard: true, masterName: NAME, masterUid: `douyin:${UID}`, ...(overrides.config ?? {}) }
		}),
		note: overrides.note ?? (() => {}),
		log: () => {},
		channel: () => ({
			send: async (name, parts, convId) => { sent.push({ name, parts, convId }); return { ok: true, delivered: true, parts }; },
			shareCard: overrides.shareCard ?? (async () => ({ ok: true, verified: true }))
		}),
		sendText: overrides.sendText ?? (async (row, text, images, convId) => {
			sent.push({ via: 'sendText', text, convId });
			return { ok: true, delivered: true, parts: [] };
		})
	});
	return { db, adapter, sent };
}

// ── send：内容拆分 + convId 闸门 ────────────────────────────
test('send：文字按空行拆条、[名字] 变表情、图片最多 2 张', async () => {
	const { db, adapter, sent } = makeAdapter();
	const r = await adapter.send({ channel_id: 'douyin:某人' }, '第一段\n\n第二段\n\n[比心]', [], CONV);
	assert.equal(r.ok, true);
	assert.equal(r.delivered, true);
	const parts = sent[0].parts;
	assert.deepEqual(parts, [
		{ type: 'text', text: '第一段' },
		{ type: 'text', text: '第二段' },
		{ type: 'emoji', name: '比心' }
	]);
	assert.equal(sent[0].convId, CONV, 'convId 原样带给通道');
	assert.equal(sent[0].name, '某人', '会话名从 channel_id 取');
	db.close();
});

test('send：图片最多带 2 张', async () => {
	const { db, adapter, sent } = makeAdapter();
	await adapter.send({ channel_id: 'douyin:某人' }, '看图', [
		{ data: { file: 'a.png' } }, { path: 'b.png' }, { path: 'c.png' }
	], CONV);
	const imgs = sent[0].parts.filter((p) => p.type === 'image');
	assert.equal(imgs.length, 2, '最多 2 张');
	assert.deepEqual(imgs.map((i) => i.path), ['a.png', 'b.png']);
	db.close();
});

test('send：没有 convId / convId 形状不对 → 拒发且通道一次都没被调用', async () => {
	const { db, adapter, sent } = makeAdapter();
	for (const convId of ['', 'abc', '0:2:1:2', '0:1:x:2']) {
		const r = await adapter.send({ channel_id: 'douyin:某人' }, '你好', [], convId);
		assert.equal(r.ok, false, `convId=${JSON.stringify(convId)} 必须拒发`);
		assert.match(r.error, /会话|身份/);
	}
	assert.equal(sent.length, 0, '通道一次都不能被调用');
	db.close();
});

test('send：没接上通道 / 没有可发内容 → 拒发', async () => {
	const db = openDatabase();
	const bare = new DouyinAdapter({ db, getConfig: () => ({}) });
	const r1 = await bare.send({ channel_id: 'douyin:x' }, '你好', [], CONV);
	assert.equal(r1.ok, false);
	assert.match(r1.error, /没接上/);
	const r2 = await bare.send({ channel_id: 'douyin:x' }, '', [], CONV);
	assert.equal(r2.ok, false);
	db.close();
});

// ── shareTarget：三道闸 ─────────────────────────────────────
test('shareTarget：三道闸全过才给目标', () => {
	const { db, adapter } = makeAdapter();
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);
	const t = adapter.shareTarget();
	assert.deepEqual(t, { channelId: `douyin:${NAME}`, uid: UID, convId: CONV, name: NAME });
	db.close();
});

test('shareTarget：shareCard 关着 / 认不出身份 / 没有会话 ID → 都给空', () => {
	// ① 开关关着
	const a = makeAdapter({ config: { shareCard: false } });
	setKv(a.db, `douyin.convId.douyin:${UID}`, CONV);
	assert.equal(a.adapter.shareTarget(), '', '开关关着就不给');

	// ② 认不出身份（masterUid 空 + person.master 也没有）
	const b = makeAdapter({ config: { masterUid: '' } });
	assert.equal(b.adapter.shareTarget(), '', '认不出身份就不给');

	// ③ 身份认得出但没确认过会话
	const c = makeAdapter();
	assert.equal(c.adapter.shareTarget(), '', '没有确认过的会话 ID 就不给');

	a.db.close(); b.db.close(); c.db.close();
});

// ── deliverShare：卡片 + 说明两段 ───────────────────────────
test('deliverShare：卡片和说明各走各的，卡片说了算', async () => {
	const calls = [];
	const { db, adapter } = makeAdapter({
		shareCard: async (p, onSubmitted) => { calls.push({ kind: 'card', p }); onSubmitted(); return { ok: true, verified: true }; },
		sendText: async (row, text, images, convId) => { calls.push({ kind: 'text', text, convId }); return { ok: true, delivered: true }; }
	});
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);
	setKv(db, 'share.intent.7', { videoId: '7707528678062858570', caption: '这个看着开心' });

	const ok = await adapter.deliverShare('douyin:主人抖音', '分享', { pendingId: 7 });
	assert.equal(ok, true);
	assert.equal(calls.length, 2, '卡片 + 说明两段');
	assert.equal(calls[0].kind, 'card');
	assert.equal(calls[0].p.videoId, '7707528678062858570');
	assert.equal(calls[0].p.convId, CONV, '卡片也要带 convId');
	assert.equal(calls[1].kind, 'text');
	assert.equal(calls[1].text, '这个看着开心');
	assert.equal(calls[1].convId, CONV, '说明文字也带 convId');
	db.close();
});

test('deliverShare：没有作品 ID → 不发，记 failed', async () => {
	const notes = [];
	const { db, adapter } = makeAdapter({ note: (kind, info) => notes.push({ kind, reason: info.reason }) });
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);
	setKv(db, 'share.intent.8', { caption: '没有 ID' });
	const ok = await adapter.deliverShare('douyin:x', '分享', { pendingId: 8 });
	assert.equal(ok, false);
	assert.ok(notes.some((n) => n.kind === 'failed' && /作品 ID/.test(n.reason)));
	db.close();
});

test('deliverShare：认不出目标 → 不发，记 failed', async () => {
	const notes = [];
	const { db, adapter } = makeAdapter({ note: (kind, info) => notes.push({ kind, reason: info.reason }) });
	setKv(db, 'share.intent.9', { videoId: '7707528678062858570' });
	const ok = await adapter.deliverShare('douyin:x', '分享', { pendingId: 9 });
	assert.equal(ok, false);
	assert.ok(notes.some((n) => n.kind === 'failed' && /认不出主人会话/.test(n.reason)));
	db.close();
});

// ── sendBlocker：两种原因给两句不同的话 ─────────────────────
test('sendBlocker：认不出身份 / 认得出身份但没会话 → 两句不同的话', async () => {
	const a = makeAdapter({ config: { masterUid: '' } });
	const b1 = await a.adapter.sendBlocker();
	assert.match(b1, /还没认出你的抖音身份/, '身份都没认出来');
	assert.doesNotMatch(b1, /先在抖音里给我发一条/);

	const b = makeAdapter();
	const b2 = await b.adapter.sendBlocker();
	assert.match(b2, /先在抖音里给我发一条/, '身份认出了但没聊过');
	assert.doesNotMatch(b2, /还没认出你的抖音身份/);

	// 身份 + 会话都齐 → 空串（能发）
	const c = makeAdapter();
	setKv(c.db, `douyin.convId.douyin:${UID}`, CONV);
	assert.equal(await c.adapter.sendBlocker(), '');

	a.db.close(); b.db.close(); c.db.close();
});

// ── 接线：网关上的同名方法真的经适配器 ───────────────────────
test('接线：网关的四个方法都经适配器（拆掉转发就红）', async () => {
	const db = openDatabase();
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ masterQqUin: '12345678', douyin: { enabled: true, shareCard: true, masterName: NAME, masterUid: `douyin:${UID}` } }),
		log: () => {}, channel: { connected: true },
		douyin: { connected: true, send: async () => ({ ok: true, delivered: true, parts: [] }), shareCard: async () => ({ ok: true, verified: true }) },
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	assert.ok(gw.douyinAdapter instanceof DouyinAdapter, '构造时就建好了适配器');
	setKv(db, `douyin.convId.douyin:${UID}`, CONV);

	// 目标计算：网关 → 适配器 → 同一份 kv
	assert.deepEqual(gw.douyinShareTarget(), { channelId: `douyin:${NAME}`, uid: UID, convId: CONV, name: NAME });

	// 发送：网关 → 适配器 → 通道
	const r = await gw.sendDouyin({ channel_id: `douyin:${NAME}` }, '接线测试', [], CONV);
	assert.equal(r.ok, true);
	assert.equal(r.delivered, true);

	// 闸门：没 convId 就不发
	const r2 = await gw.sendDouyin({ channel_id: `douyin:${NAME}` }, '不该发出去', [], '');
	assert.equal(r2.ok, false);

	// blocker：走适配器的身份判断。**必须有非空结果** ——
	// 拆掉转发后它会返回空串（= 能发），这条断言才抓得住。
	const blocker = await gw.masterDouyinSendBlocker();
	assert.equal(blocker, '', '身份和会话都齐 → 没有阻塞原因');
	// 换个身份（主人 uid 换掉）→ 适配器应给「还认不出会话」那句
	const gw2 = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ masterQqUin: '12345678', douyin: { enabled: true, shareCard: true, masterName: NAME, masterUid: 'douyin:9999999999999999999' } }),
		log: () => {}, channel: { connected: true },
		douyin: { connected: true, send: async () => ({ ok: true, delivered: true, parts: [] }), shareCard: async () => ({ ok: true, verified: true }) },
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	assert.match(await gw2.masterDouyinSendBlocker(), /先在抖音里给我发一条/,
		'换个没聊过的身份 → 适配器要给「先给我发一条」那句（拆掉转发就会返回空串）');

	// deliverDouyinShare：走适配器 ⇒ 认得出目标时才会去发卡片
	setKv(db, 'share.intent.31', { videoId: '7707528678062858570', caption: '接线用的' });
	const cards = [];
	gw.douyin.shareCard = async (p, onSubmitted) => { cards.push(p); onSubmitted(); return { ok: true, verified: true }; };
	const shared = await gw.deliverDouyinShare(`douyin:${NAME}`, '分享', { pendingId: 31 });
	assert.equal(shared, true, '卡片交付要走适配器（拆掉转发就返回 false）');
	assert.equal(cards.length, 1, '卡片确实发出去了');
	assert.equal(cards[0].convId, CONV, '卡片带 convId');

	db.close();
});
