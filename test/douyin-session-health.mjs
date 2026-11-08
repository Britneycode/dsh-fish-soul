/**
 * 抖音登录态健康检查：从 sid_guard 读出「还剩多久」，并出现在 /diagnose 里。
 *
 * 为什么要有这个：
 *   抖音掉登录和「签名错了 / 被风控」表现一模一样（status_code 8 / 空 body），
 *   只看请求失败分不清是哪一种。sid_guard 自带签发秒 + 有效期，能提前 24 小时预警。
 *
 * 契约：
 *   ① 解析：URL 编码的值、正常值、坏的 / 缺字段的，各自返回对的东西
 *   ② 判级：>24h 绿 / <24h 黄（带提示）/ 已过期红 / 读不到不算失败
 *   ③ 只读文件：cookie 文件不在、没有 sid_guard，都不能抛、不能联网
 *   ④ /diagnose 里真的多出这一项（不是只写了函数没人调）
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = `${process.env.TEMP || '/tmp'}/fish-soul-test-dyhealth-${process.pid}-${Date.now()}`;
process.env.DSH_HOME = home;
mkdirSync(join(home, 'fish-soul'), { recursive: true });

const { parseSidGuard, sessionHealth, describeHealth, humanizeSeconds } = await import('../lib/session-health.js');
const { douyinSessionHealth, douyinCookiePath } = await import('../lib/douyin-http.js');

const ok = (msg) => console.log(`✓ ${msg}`);
const NOW = Math.floor(Date.now() / 1000);

// ── ① 解析 ──
{
	const issued = NOW - 3600;
	const ttl = 7 * 86400;
	// 正常格式
	const a = parseSidGuard(`${'x'.repeat(32)}|${issued}|${ttl}|Thu,+07-Jan-2027+10:22:35+GMT`);
	assert.ok(a !== null, '正常格式要解得出来');
	assert.equal(a.issuedAt, issued);
	assert.equal(a.ttlSec, ttl);
	// 剩余时间是在 ttl 基础上减去已过的 1 小时
	assert.ok(Math.abs(a.remainingSec - (ttl - 3600)) <= 5, `剩余秒数算错：${a.remainingSec}`);

	// URL 编码的（真实落盘就是这个样子）
	const encoded = `${'x'.repeat(32)}%7C${issued}%7C${ttl}%7CThu%2C+07-Jan-2027+10%3A22%3A35+GMT`;
	const b = parseSidGuard(encoded);
	assert.ok(b !== null, 'URL 编码的值要解得出来');
	assert.equal(b.issuedAt, issued, '解码后签发时间要对');

	// 坏的
	assert.equal(parseSidGuard(''), null, '空值返回 null');
	assert.equal(parseSidGuard('abc'), null, '没分隔符返回 null');
	assert.equal(parseSidGuard('a|b|c'), null, '非数字返回 null');
	assert.equal(parseSidGuard(`a|0|0|d`), null, '0 值返回 null');
	assert.equal(parseSidGuard(null), null, 'null 返回 null');
	ok('sid_guard 解析：正常 / URL 编码 / 各种坏的，结果都对');
}

// ── ② 判级 ──
{
	// 还很久
	const far = describeHealth({ remainingSec: 30 * 86400 }, { warnHours: 24 });
	assert.equal(far.ok, true, '还剩 30 天该是绿的');
	assert.match(far.detail, /30 天/, `要说清还剩多久：${far.detail}`);

	// 快过期（不足 24 小时）
	const soon = describeHealth({ remainingSec: 3 * 3600 }, { warnHours: 24 });
	assert.equal(soon.ok, false, '不足 24 小时该标黄');
	assert.match(soon.detail, /快过期/, `要提示快过期：${soon.detail}`);

	// 已过期
	const dead = describeHealth({ remainingSec: -100 }, { warnHours: 24 });
	assert.equal(dead.ok, false, '过期该标红');
	assert.match(dead.detail, /已过期/, `要说已过期：${dead.detail}`);

	// 读不到 —— 不算失败（没登录过不是错误）
	const none = describeHealth(null, { warnHours: 24 });
	assert.equal(none.ok, true, '读不到过期时间不该标红');
	assert.match(none.detail, /读不到/, `要说清读不到：${none.detail}`);

	assert.equal(humanizeSeconds(0), '已过期');
	assert.equal(humanizeSeconds(90), '1 分钟');
	assert.match(humanizeSeconds(3700), /1 小时/);
	ok('判级：>24h 绿 / 不足 24h 黄带提示 / 过期红 / 读不到不算失败');
}

// ── ③ 只读文件 ──
{
	// 文件不存在
	assert.equal(douyinSessionHealth(), null, '没有 cookie 文件要返回 null，不能抛');

	// 有文件但没 sid_guard
	writeFileSync(douyinCookiePath(), JSON.stringify({ savedAt: Date.now(), cookies: { other: '1' } }));
	assert.equal(douyinSessionHealth(), null, '没有 sid_guard 返回 null');

	// 有 sid_guard（编码过的、还剩 2 天）
	// 签发在 10 分钟前，有效期 1 天零 1 小时 ⇒ 还剩约 1 天，显示成「1 天 X 小时」
	const issued = NOW - 600;
	const ttl = 86400 + 3600;
	writeFileSync(douyinCookiePath(), JSON.stringify({
		savedAt: Date.now(),
		cookies: { sid_guard: `${'y'.repeat(32)}%7C${issued}%7C${ttl}%7Cwhatever` }
	}));
	const h = douyinSessionHealth();
	assert.ok(h !== null, '有 sid_guard 要读出来');
	assert.ok(Math.abs(h.remainingSec - (ttl - 600)) <= 5, `剩余秒数不对：${h.remainingSec}`);
	const desc = describeHealth(h, { warnHours: 24 });
	assert.equal(desc.ok, true, '还剩正好 2 天该是绿的');
	assert.match(desc.detail, /1 天/, `要说还剩 1 天多：${desc.detail}`);

	// 坏 JSON 不能抛
	writeFileSync(douyinCookiePath(), '{not json');
	assert.equal(douyinSessionHealth(), null, '文件坏了返回 null，不能抛');
	ok('只读文件：没文件 / 没字段 / 有值 / 坏 JSON，都不抛');
}

// ── ④ /diagnose 里真的有一项 ──
{
	const { registerRoutes } = await import('../lib/routes.js');
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	let handler = null;
	const ctx = { effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } };
	registerRoutes(ctx, {
		db,
		getConfig: () => ({ douyin: { enabled: true } }),
		saveConfig: () => {},
		gateway: null, life: null, channel: null, bili: null,
		llmRouter: null, voice: null, stickers: null, slang: null,
		embedder: null, webConfig: () => ({}),
		hasWebTools: () => false, webUsedToday: () => 0,
		hostWebAvailable: () => false, hostWebState: () => ({}),
		runWebSearch: async () => null,
		persona: null, worldinfo: null, chatArchive: null,
	});
	assert.ok(handler !== null, '路由要挂上');

	// 跟 issue-59-diagnose.mjs 一样直接调处理器（假宿主）
	let out = null;
	const res = { writeHead: () => {}, end: (text) => { out = JSON.parse(text); } };
	await handler({ method: 'GET', url: '/api/plugins/fish-soul/diagnose', headers: {} }, res);
	assert.ok(out !== null, '/diagnose 要有响应');
	const row = (out.items ?? []).find((x) => x.key === 'douyin-session');
	assert.ok(row !== undefined, '/diagnose 里要有「抖音登录」这一项');
	assert.match(row.detail, /还剩|读不到|已过期/, `这一项要说人话：${row.detail}`);
	ok(`/diagnose 里出现了「抖音登录」：${row.detail}`);
}

console.log('\ndouyin-session-health ok');
