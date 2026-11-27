import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpHome } from './_tmp.mjs';

// 面板「N 个会话上次读取失败」的误报回归测试。
//
// 真机症状（2026-11-27）：抖音私信列表里有一个读不出来的会话（昵称是一串
// 数字短号，页面拿不到接口消息），从没读成功过 ⇒ 永远没有游标。
// needsVerify 在 fails 顶到 FAIL_HARD_AFTER 后就不再重试它（重试已停），
// 但 liveReadFailures 只按「没游标 + 一小时没碰」算孤儿 —— 它一小时内有
// 被碰过，于是面板一直显示「1 个会话上次读取失败，等待重试」，
// 而它根本不会再被重试了。假阳性。
//
// 修法：fails 已顶到 FAIL_HARD_AFTER 且仍无游标的会话，不计入面板
// （kv 保留，排查仍查得到）；重试上限的语义不变。

process.env.DSH_HOME = tmpHome('douyin-live-fails-');
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');

const db = openDatabase();
const FAIL_HARD_AFTER = 3;

function makeChannel() {
	return new DouyinChannel({
		db,
		host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
		getConfig: () => ({ enabled: true }),
		log: () => {},
		onMessage: async () => ({ done: true }),
		driver: { read: async () => ({ ok: false, error: 'x' }) },
	});
}

/** 每个测试前清掉上一个留下的失败/重试/游标 kv（共享 db，不隔离会串）。 */
function reset() {
	for (const r of db.prepare("SELECT key FROM kv WHERE key LIKE 'douyin.fails.%' OR key LIKE 'douyin.retry.%' OR key LIKE 'douyin.readAt.%' OR key LIKE 'douyin.conv.%'").all()) {
		db.prepare('DELETE FROM kv WHERE key = ?').run(r.key);
	}
}

test('死会话（fails 顶到上限且无游标）不计入面板', () => {
	reset();
	const ch = makeChannel();
	const now = Date.now();
	// 死会话：失败 3 次（已到硬熔断上限）、仍无游标、最近刚失败过
	setKv(db, 'douyin.fails.douyin.conv.deaddeaddeaddead', FAIL_HARD_AFTER);
	setKv(db, 'douyin.retry.douyin.conv.deaddeaddeaddead', now - 60_000);
	setKv(db, 'douyin.readAt.douyin.conv.deaddeaddeaddead', now - 60_000);
	// 游标不存在 —— 从没读成功过
	assert.equal(getKv(db, 'douyin.conv.deaddeaddeaddead', null), null);

	assert.equal(ch.liveReadFailures(), 0, 'fails 顶到上限且无游标的死会话不该再显示在面板上');

	// kv 不能被删（排查还要查得到）
	assert.equal(Number(getKv(db, 'douyin.fails.douyin.conv.deaddeaddeaddead', 0)), FAIL_HARD_AFTER, '失败计数要留着');
});

test('还在重试窗口内的失败会话仍计入面板', () => {
	reset();
	const ch = makeChannel();
	const now = Date.now();
	// 失败 1 次（还没到上限）、无游标、刚失败 —— 这是还会被重试的，要显示
	setKv(db, 'douyin.fails.douyin.conv.livelivelivelive', 1);
	setKv(db, 'douyin.retry.douyin.conv.livelivelivelive', now - 60_000);
	setKv(db, 'douyin.readAt.douyin.conv.livelivelivelive', now - 60_000);

	assert.equal(ch.liveReadFailures(), 1, '还会被重试的失败会话要照常显示');
});

test('有游标的失败会话不受影响（它读成功过，失败只是临时的）', () => {
	reset();
	const ch = makeChannel();
	const now = Date.now();
	setKv(db, 'douyin.fails.douyin.conv.hascursor1234567', FAIL_HARD_AFTER);
	setKv(db, 'douyin.retry.douyin.conv.hascursor1234567', now - 60_000);
	setKv(db, 'douyin.readAt.douyin.conv.hascursor1234567', now - 60_000);
	// 有游标 ⇒ 读成功过 ⇒ 即使 fails 顶到上限，也可能被 unread 绕过熔断再读
	setKv(db, 'douyin.conv.hascursor1234567', { name: '某人', sig: 'x', identity: 'douyin:1', window: [] });

	assert.equal(ch.liveReadFailures(), 1, '有游标的会话仍要计入（unread 会绕过熔断再读它）');
});
