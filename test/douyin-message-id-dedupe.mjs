/**
 * 抖音入库 ID 的稳定性 —— 「同一张图重复入库」与「同一天说两次同样的话被吞」的回归测试。
 *
 * 背景：入库去重键是 `UNIQUE(channel_id, message_id)` + `INSERT OR IGNORE`。
 * 消息没有平台时间时，ID 里会拼一个 `Date.now()` ⇒ 每读一次换一个 ID ⇒ 同一条消息
 * 被入库五六遍（真机 2026-11-13：同一张图连进 5~6 行、每行都触发一轮回复）。
 *
 * 但**只按自然日兜底**会引入更严重的病：同一天说了两次「在」/ 发了两次同一张表情，
 * 算出同一个 ID，第二句被 UNIQUE 直接吞掉 —— 用户看到的是「她没回我」。
 * 重复回复只是烦，漏回复是失联。
 *
 * 所以 ID 分三级（见 lib/channels/douyin.js 的 messageId 组装）：
 *   ① 有 seq（接口路，最准）                → `s<seq>`
 *   ② 有平台时间（DOM 路现在从气泡反解）      → `<指纹>-<timeMs>-<occ>`
 *   ③ 两者都没有（极少）                    → `<指纹>-<自然日>-<occ>`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageFingerprint, occurrenceIndexes, messageIdFor } from '../lib/channels/douyin.js';

const at = (iso) => new Date(iso).getTime();
const DAY = '2026-11-13';

/** 打真实的 messageIdFor（不是复制一份逻辑）—— 复制版测不出「没接进去」。 */
function idOf(print, opts = {}) {
	const m = {};
	if (opts.seq) m.seq = opts.seq;
	if (opts.time) m.time = opts.time;
	return messageIdFor(m, { print, occ: opts.occ ?? 0, dayKey: opts.day ?? DAY, fallbackTime: 0 }).messageId;
}

const said = (text) => messageFingerprint({ type: 'text', text, fromMe: false });
const img = (src) => messageFingerprint({ type: 'image', media: { src }, fromMe: false });

test('① 有 seq 时 ID 只认 seq（接口路，最准）', () => {
	const p = said('在');
	assert.equal(idOf(p, { seq: '12345', time: 1 }), 's12345');
	assert.equal(idOf(p, { seq: '12345', time: 2 }), 's12345', 'seq 相同就是同一条，时间变了也不该换 ID');
});

test('② 同一张图重复读 → ID 必须相同（这是原 bug：每读一次换一个 ID）', () => {
	const p = img('https://x/a.jpg');
	const t = at('2026-11-13T10:00:00+08:00');
	const first = idOf(p, { time: t });
	const second = idOf(p, { time: t });
	assert.equal(first, second, '同一张图、同一个时间 → 同一个 ID，否则每次读都新入库一遍');
});

test('② 同一天说两次同样的话 → ID 必须不同（只按自然日会吞掉第二句）', () => {
	const p = said('在');
	const morning = idOf(p, { time: at('2026-11-13T10:00:00+08:00') });
	const afternoon = idOf(p, { time: at('2026-11-13T15:00:00+08:00') });
	assert.notEqual(morning, afternoon, '下午那句不能因为跟上午同一天同一句就被去重吞掉');
});

test('② 同一次读到连发三句「在」→ 三个 ID 都不同（occ 起作用）', () => {
	const prints = [said('在'), said('在'), said('在')];
	const occ = occurrenceIndexes(prints);
	assert.deepEqual(occ, [0, 1, 2]);
	const t = at('2026-11-13T10:00:00+08:00');
	const ids = occ.map((o) => idOf(prints[0], { time: t, occ: o }));
	assert.equal(new Set(ids).size, 3, '连发的三句必须各是一个 ID，否则后两句被吞');
});

test('② 跨天发同一张图 → ID 不同', () => {
	const p = img('https://x/a.jpg');
	const d1 = idOf(p, { time: at('2026-11-13T10:00:00+08:00') });
	const d2 = idOf(p, { time: at('2026-11-14T10:00:00+08:00') });
	assert.notEqual(d1, d2);
});

test('③ 既无 seq 又无时间 → 退回自然日（保底：同一天重复读不重复入库）', () => {
	const p = img('https://x/a.jpg');
	assert.equal(idOf(p, { day: DAY }), idOf(p, { day: DAY }), '同一天重复读必须同 ID（不重复入库）');
	assert.notEqual(idOf(p, { day: '2026-11-13' }), idOf(p, { day: '2026-11-14' }), '跨天不撞');
});

test('③ 兜底档位下同日同内容仍会被吞 —— 这是已知取舍，不是回归', () => {
	// 钉住语义：兜底档位（连时间都认不出）时，同日同内容会撞。
	// 这条**不是**期望行为，而是让「谁把有时间的路径也降级到兜底」立刻红。
	const p = said('在');
	assert.equal(idOf(p, { day: DAY }), idOf(p, { day: DAY }));
});

test('指纹区分发送者：自己的话和对方的话不会撞 ID', () => {
	const mine = messageFingerprint({ type: 'text', text: '在', fromMe: true });
	const peer = messageFingerprint({ type: 'text', text: '在', fromMe: false });
	assert.notEqual(mine, peer);
});

test('DOM 路的时间反解：能认出的写法都要认出来，认不出的必须是 0', async () => {
	// timeFromMeta 在页面里跑（`String.raw` 模板内），没法 import —— 从源码里抽出来验证。
	// 这条必须存在：DOM 路的时间是「有 time 才走 ② 档」的前提，
	// 反解写坏了会静默退回 ③ 档（同日同内容被吞），而单测看不见。
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../lib/channels/vendor/douyin-bridge/douyin-dm.mjs', import.meta.url), 'utf8');
	const i = src.indexOf('const timeFromMeta =');
	const j = src.indexOf('const out = []', i);
	assert.ok(i > 0 && j > i, '源码里找不到 timeFromMeta（改名了？记得同步这条测试）');
	const fn = new Function('metas', 'now', `${src.slice(i, j)}; return timeFromMeta(metas, now)`);
	const now = new Date('2026-11-13T15:00:00+08:00').getTime();
	const near = (got, want, label) => assert.ok(Math.abs(got - want) < 60_000, `${label}：期望约 ${want}，得到 ${got}`);

	assert.equal(fn(['刚刚'], now), now);
	near(fn(['5分钟前'], now), now - 5 * 60_000, '5分钟前');
	near(fn(['3小时前'], now), now - 3 * 3600_000, '3小时前');
	near(fn(['昨天'], now), now - 86400_000, '昨天');
	near(fn(['前天'], now), now - 2 * 86400_000, '前天');
	// HH:MM 只可能是今天；但「23:50」在当前时刻之后 ⇒ 是昨天
	const hhmm = fn(['14:30'], now);
	assert.equal(new Date(hhmm).getHours(), 14);
	assert.equal(new Date(hhmm).getMinutes(), 30);
	assert.ok(fn(['23:50'], now) < now - 3600_000, '23:50 在当前时刻之后 ⇒ 必须算昨天，不能算未来');
	// 认不出的必须是 0（不能编一个时间，否则又变成「每次读都不同」）
	for (const s of ['已读', '未读', '', '乱码', 'xyz']) assert.equal(fn([s], now), 0, `「${s}」应认不出`);
});
