/**
 * 抖音平台机制（PR5）：findDouyinRefs / douyinVideoIds 走适配器。
 *
 * 纯函数本身有别处覆盖（douyin-card-share / smoke-v05）。
 * 这里守的是**接线**：网关的 videoNotes 和 life 的分享确实经适配器拿到这些值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-mechanism-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { DouyinAdapter, douyinVideoIdsOf } = await import('../lib/douyin-adapter.js');

const URL_WITH_ID = '看看这个 https://www.douyin.com/video/7234567890123456789 挺好笑';
const URL_WITH_SHORT = 'https://v.douyin.com/abc123/ 这个';

// ── 适配器的方法就是那两个纯函数 ────────────────────────────
test('适配器的 refs / videoIds 就是纯函数的实现', () => {
	const db = openDatabase();
	const ad = new DouyinAdapter({ db, getConfig: () => ({}) });
	const refs = ad.refs(URL_WITH_ID);
	assert.ok(refs.ids.includes('7234567890123456789'), '要认出作品 ID');
	assert.ok(ad.refs(URL_WITH_SHORT).shorts.length > 0, '要认出短链');
	assert.deepEqual(ad.videoIds(URL_WITH_ID), ['7234567890123456789']);
	assert.deepEqual(douyinVideoIdsOf(URL_WITH_ID), ['7234567890123456789'], '导出的纯函数与适配器方法一致');
});

// ── 接线：网关的 videoNotes 经适配器拿 refs ────────────────
test('网关：videoNotes 经适配器拿抖音引用（接线）', async () => {
	const db = openDatabase();
	const seen = [];
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ masterQqUin: '12345678', douyin: { enabled: true } }),
		log: () => {}, channel: { connected: true },
		douyinBrowser: { describe: async (refs) => { seen.push(refs); return ['这是条测试视频']; } },
		douyin: { connected: true, send: async () => ({ ok: true, delivered: true }) },
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	const notes = await gw.videoNotes([{ m: { text: URL_WITH_ID, chatType: 'private', userId: '12345678' } }]);
	assert.equal(seen.length, 1, '要拿引用去描述视频');
	assert.ok(seen[0].ids.includes('7234567890123456789'), '引用里的作品 ID 要传下去');
	assert.ok(notes.length > 0, '描述结果要回来');
});

// ── 接线：life 的分享经注入拿作品 ID ───────────────────────
test('life：分享的抖音作品 ID 走注入的适配器入口', async () => {
	const { LifeEngine } = await import('../lib/life.js');
	const db = openDatabase();
	// 注入一个假的适配器入口，验证 life 用的是它
	const calls = [];
	const life = new LifeEngine({
		db,
		clock: { now: () => Date.now(), getRoleDateParts: () => ({ dateStr: '2026-11-18' }) },
		getConfig: () => ({ proactive: { enabled: true, shareVideos: true } }),
		callLlm: async () => '{}',
		deliver: async () => ({ ok: true }),
		log: () => {},
		douyinVideoIds: (text) => { calls.push(text); return ['7234567890123456789']; },
		douyinShareTarget: () => ({ channelId: 'douyin:主人', uid: '1', convId: '0:1:1:1', name: '主人' })
	});
	// 直接调内部的作品 ID 入口（enqueueShare 的前半段）
	const ids = life.douyinVideoIds(URL_WITH_ID);
	assert.deepEqual(ids, ['7234567890123456789'], '作品 ID 要从注入的入口来');
	assert.equal(calls.length, 1, '注入的入口要被真的调到');
});

// 🔴 注入依赖的默认值不能是空实现：老代码路径（不传注入）也得真的拿到作品 ID。
//    默认值退化成 `() => []` ⇒ 拿不到作品 ID ⇒ 分享全退回 QQ 文字分享（行为变了）。
test('life：不注入 douyinVideoIds 时，默认实现也要真的提取作品 ID', async () => {
	const { LifeEngine } = await import('../lib/life.js');
	const db = openDatabase();
	const life = new LifeEngine({
		db,
		clock: { now: () => Date.now(), getRoleDateParts: () => ({ dateStr: '2026-11-18' }) },
		getConfig: () => ({}),
		callLlm: async () => '{}',
		deliver: async () => ({ ok: true }),
		log: () => {}
	});
	assert.deepEqual(life.douyinVideoIds(URL_WITH_ID), ['7234567890123456789'],
		'默认实现要真的提取作品 ID（空数组会让分享退回 QQ）');
});
