// 分享额度：失败 / 作废要还回去，成功不退，还在重试的也不退。
//
// 原 bug：`queueShare` 在**入队时**就把 `share.day.count` +1（那时还不知道发不发得出去），
// 而失败/作废**没有任何地方回退** ⇒ 一次失败的分享白占当天额度。
// 真机实测：一条「视频详情页没有可见分享入口」的失败分享占掉 1/3 配额。
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-share-refund-');
const { openDatabase, setKv, getKv } = await import('../lib/db.js');
const { LifeEngine } = await import('../lib/life.js');

const db = openDatabase();

const DATE = '2030-01-01';
/** 虚拟钟：可调，roleDay 固定用 DATE 那天 */
let nowVirtual = Date.UTC(2030, 0, 1, 4, 0, 0); // 12:00 UTC+8
const clock = {
	now: () => nowVirtual,
	getRoleDateParts: () => ({ dateStr: DATE, hour: 12, minute: 0 }),
	toRealIntervalMs: (ms) => ms
};

const cfg = {
	proactive: {
		enabled: true,
		shareVideos: true,
		shareMaxPerDay: 3,
		activeHours: [0, 24],
		dailyMaxCount: 10,
		targets: { masterCanonicalId: 'user:master', masterPrivateChannelId: 'private:10001', selfGroupChannelIds: [] }
	}
};

/** 造一个只够跑 flushDue / deliverOne 的 LifeEngine */
function makeEngine({ deliverOk = false } = {}) {
	const engine = new LifeEngine({
		db, clock,
		getConfig: () => cfg,
		callLlm: async () => null,
		note: () => {},
		log: () => {},
		deliver: async () => deliverOk
	});
	return engine;
}

/** 直接往 pending 里塞一条分享待办（绕开 queueShare 的挑选逻辑），并照 queueShare 的规矩记额度 */
function seedShare({ id = null, dueAt = null, createdAt = null, day = DATE } = {}) {
	const r = db.prepare(`
		INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at, origin)
		VALUES ('feiyu', 'user:master', 'qq-private', 'private:10001', ?, '分享一个视频', 'pending', ?, 'share')
	`).run(dueAt ?? nowVirtual, createdAt ?? nowVirtual);
	const pid = Number(r.lastInsertRowid);
	setKv(db, `share.day`, { date: day, count: 1 });
	setKv(db, `share.dayOf.${pid}`, day);
	setKv(db, `share.platform.${pid}`, 'B站');
	return pid;
}

/**
 * 造一个「真的能读」的 POST 请求。
 *
 * `routes.js` 用 `readBody(req)` 读**事件流**（`req.on('data')`），
 * 不是读 `req.body` —— 手搓 `{ body: {...} }` 会让它永远拿不到内容、
 * 解析成 `{}`，于是 `id 必须是整数` 而静默失败。
 */
function fakePost(payload) {
	const body = Buffer.from(JSON.stringify(payload));
	const req = Readable.from([body]);
	req.method = 'POST';
	req.url = '/api/plugins/fish-soul/inspector/forget';
	req.headers = {};
	return req;
}

const quota = () => Number(getKv(db, 'share.day', null)?.count ?? 0);
const reset = () => {
	db.prepare('DELETE FROM pending').run();
	db.prepare("DELETE FROM kv WHERE key LIKE 'share.%'").run();
};

// ① 判死（重试次数用完）⇒ 额度还回去
{
	reset();
	const pid = seedShare();
	assert.equal(quota(), 1, '前置：入队后额度应为 1');
	// 把 attempts 顶到倒数第二次，下一次投递就是最后一次
	db.prepare('UPDATE pending SET attempts = ? WHERE id = ?').run(4, pid); // PENDING_MAX_ATTEMPTS=6 ⇒ 5 < 6
	const engine = makeEngine({ deliverOk: false });
	const row = db.prepare('SELECT * FROM pending WHERE id = ?').get(pid);
	await engine.deliverOne(row, nowVirtual); // attempt=4 ⇒ 5 < 6 ⇒ 仍 pending，不退
	assert.equal(db.prepare('SELECT status FROM pending WHERE id = ?').get(pid).status, 'pending', '第 5 次失败仍应 pending');
	assert.equal(quota(), 1, '还在重试时不该退额度');

	db.prepare('UPDATE pending SET attempts = ? WHERE id = ?').run(5, pid);
	await engine.deliverOne(db.prepare('SELECT * FROM pending WHERE id = ?').get(pid), nowVirtual); // 6 >= 6 ⇒ failed
	assert.equal(db.prepare('SELECT status FROM pending WHERE id = ?').get(pid).status, 'failed', '第 6 次失败应判死');
	assert.equal(quota(), 0, '判死后额度应退回 0');
}

// ② 过期作废 ⇒ 额度还回去
{
	reset();
	const pid = seedShare({ dueAt: nowVirtual - 13 * 3600_000, createdAt: nowVirtual - 13 * 3600_000 }); // 超过 12h TTL
	assert.equal(quota(), 1);
	await makeEngine().flushDue(cfg.proactive);
	assert.equal(db.prepare('SELECT status FROM pending WHERE id = ?').get(pid).status, 'expired', '超 TTL 应置 expired');
	assert.equal(quota(), 0, '作废后额度应退回 0');
}

// ③ 真的发出去 ⇒ **不退**（这条最关键：别把成功的也退掉，否则能无限发）
{
	reset();
	const pid = seedShare();
	assert.equal(quota(), 1);
	const engine = makeEngine({ deliverOk: true });
	await engine.deliverOne(db.prepare('SELECT * FROM pending WHERE id = ?').get(pid), nowVirtual);
	assert.equal(db.prepare('SELECT status FROM pending WHERE id = ?').get(pid).status, 'done', '发送成功应 done');
	assert.equal(quota(), 1, '成功不该退额度');
	assert.ok(getKv(db, 'share.lastAt.B站', 0) > 0, '成功应记 lastAt');
}

// ④ 跨天作废 ⇒ **不退今天的**（额度已自然重置，退了等于凭空多给一次）
{
	reset();
	const yesterday = '2029-12-31';
	const pid = seedShare({ dueAt: nowVirtual - 13 * 3600_000, createdAt: nowVirtual - 13 * 3600_000, day: yesterday });
	// 模拟「昨天入了 1 条，今天又入了 1 条」：今天的计数是 1
	setKv(db, 'share.day', { date: DATE, count: 1 });
	await makeEngine().flushDue(cfg.proactive);
	assert.equal(db.prepare('SELECT status FROM pending WHERE id = ?').get(pid).status, 'expired');
	assert.equal(quota(), 1, '跨天作废不该动今天的计数');
}

// ⑤ 幂等：同一个待办退两次也只退一次
{
	reset();
	const pid = seedShare();
	setKv(db, 'share.day', { date: DATE, count: 2 });
	const engine = makeEngine();
	assert.equal(engine.refundShareQuota(pid), true, '第一次应退');
	assert.equal(quota(), 1);
	assert.equal(engine.refundShareQuota(pid), false, '第二次应被幂等挡住');
	assert.equal(quota(), 1, '不能退两次');
}

// ⑥ 不是分享待办（没有 dayOf 记录）⇒ 不退，别误伤别的待办的额度
{
	reset();
	const engine = makeEngine();
	setKv(db, 'share.day', { date: DATE, count: 2 });
	assert.equal(engine.refundShareQuota(999999), false, '无 dayOf 记录应拒绝');
	assert.equal(quota(), 2, '不该动额度');
}

// ⑦ 接线：queueShare 入队时必须写 dayOf（否则 ①~⑥ 全失效）
{
	reset();
	const engine = makeEngine();
	engine.douyinVideoIds = () => [];
	const r = engine.queueShare({ platform: 'B站', title: '测试视频', author: 'UP主', url: 'https://www.bilibili.com/video/BV1xx411c7mD', impression: '挺好看' });
	assert.equal(r.ok, true, `queueShare 应成功，实际：${JSON.stringify(r)}`);
	assert.equal(quota(), 1, '入队应占 1 次额度');
	assert.equal(String(getKv(db, `share.dayOf.${r.id}`, '')), DATE, '入队必须记下当天日期（回退要靠它判跨天）');
}

// ⑧ 端到端：queueShare → 判死 → 额度归 0
//
// 🔴 ①~⑦ 全是 seedShare 手搓状态，**对接线零覆盖**（独立审查实测：
//    把 queueShare 的 dayOf 写入拆掉，只跑 ①~⑥ 仍然全绿）。
//    这条从真入口进、走真出口出，才算真的证明「入队占的额度能被退回来」。
{
	reset();
	const engine = makeEngine({ deliverOk: false });
	engine.douyinVideoIds = () => [];
	const r = engine.queueShare({ platform: 'B站', title: '端到端', author: 'UP', url: 'https://www.bilibili.com/video/BV1xx411c7mD', impression: 'x' });
	assert.equal(r.ok, true);
	assert.equal(quota(), 1, '入队应占 1 次');
	// 一路顶到判死
	for (let i = 0; i < 6; i++) {
		const row = db.prepare('SELECT * FROM pending WHERE id = ?').get(r.id);
		if (row.status !== 'pending') break;
		await engine.deliverOne(row, nowVirtual);
	}
	assert.equal(db.prepare('SELECT status FROM pending WHERE id = ?').get(r.id).status, 'failed', '应判死');
	assert.equal(quota(), 0, '端到端：判死后额度应归 0');
}

// ⑨ 手动删掉分享待办（面板的删除按钮 ⇒ status='dropped'）⇒ 额度也要还
//
// 独立审查抓到的漏口：`lib/routes.js` 的 `/inspector/forget` 把待办置 dropped
// 但没退额度 ⇒ 用户手动取消一条分享，当天次数白占。走**真实路由**验。
{
	reset();
	const { registerRoutes } = await import('../lib/routes.js');
	let handler = null;
	const ctx = { effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } };
	const engine = makeEngine();
	engine.douyinVideoIds = () => [];
	registerRoutes(ctx, {
		db, clock, life: engine, getConfig: () => cfg, saveConfig: () => {}, log: () => {},
		gateway: { decisions: [] }, channel: null, bili: null, douyin: null, douyinHost: null
	});
	const r = engine.queueShare({ platform: 'B站', title: '要被删掉', author: 'UP', url: 'https://www.bilibili.com/video/BV1xx411c7mD', impression: 'x' });
	assert.equal(quota(), 1, '入队应占 1 次');
	let out = null;
	await handler(fakePost({ targetType: 'pending', id: r.id }), { writeHead: () => {}, end: (t) => { out = JSON.parse(t); } });
	assert.equal(out?.ok, true, `删除应成功，实际：${JSON.stringify(out)}`);
	assert.equal(db.prepare('SELECT status FROM pending WHERE id = ?').get(r.id).status, 'dropped', '应置 dropped');
	assert.equal(quota(), 0, '手动删掉分享待办后额度应退回 0');
}

// ⑩ 删掉的是**用户交代的提醒**（origin='user'）⇒ 不该动分享额度
{
	reset();
	const { registerRoutes } = await import('../lib/routes.js');
	let handler = null;
	const ctx = { effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } };
	const engine = makeEngine();
	registerRoutes(ctx, {
		db, clock, life: engine, getConfig: () => cfg, saveConfig: () => {}, log: () => {},
		gateway: { decisions: [] }, channel: null, bili: null, douyin: null, douyinHost: null
	});
	// 一条普通提醒 + 一条分享（分享占额度）
	const remind = db.prepare(`
		INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at, origin)
		VALUES ('feiyu', 'user:master', 'qq-private', 'private:10001', ?, '提醒喝水', 'pending', ?, 'user')
	`).run(nowVirtual, nowVirtual);
	setKv(db, 'share.day', { date: DATE, count: 1 }); // 模拟「另有一条分享占着 1 次」
	let out2 = null;
	await handler(fakePost({ targetType: 'pending', id: Number(remind.lastInsertRowid) }), { writeHead: () => {}, end: (t) => { out2 = JSON.parse(t); } });
	assert.equal(out2?.ok, true, `删除普通提醒应成功，实际：${JSON.stringify(out2)}`);
	assert.equal(quota(), 1, '删普通提醒不该动分享额度');
}

console.log('✓ 分享额度回退（10 组）全部通过');
db.close();
