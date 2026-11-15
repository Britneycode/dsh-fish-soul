// 抖音回评论：读不回来 ≠ 读到空 —— 状态不能虚报（巡检 P2，2026-11-16）。
//
// 点了「发送」之后，driver 要读两样东西才敢说「发出去了」：
//   ① 页面上的验证状态（有没有验证码挡着）
//   ② 回复框里还有没有字（字没了 = 提交了）
// 这两样都是 eval。eval 失败（超时 / CDP 断连 / 页面崩了）时读回来的都是空串，
// 和「没有验证码」「框里真没字」分不开 —— 分不开就一路落到 ok: true：
// pollComments 据此记 replied，还给主人发「回了 X 的评论」，
// 可评论其实压根没发出去（状态虚报；markSent 早就标过了，所以不会重复发）。
//
// 真 DouyinSocial + 真 driver + 真 db + 真 host.exclusive，只在最底下假掉 CDP。
// 断言都经公开入口：pollComments 的返回值 + 库里记的状态 + driver.reply 的返回。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const ok = (name) => console.log('✓', name);

// lib/time-util.js 的 sleep 是 unref 的。driver 里全是这种等待，
// 事件循环会以为没事可做直接结束 ⇒ await 永不 resolve（0.1 秒假红）。
// 挂一个非 unref 的定时器把事件循环钉住（2026-11-15 commit 897dd42 同款）。
// ⚠️ 跑完要手动清掉它 —— 它不 unref，不清的话进程不会退出。
const keepAlive = setInterval(() => {}, 1000);

// 隔离：HOME / DSH_HOME / TMP 全指到临时目录 —— 不碰真实用户目录、不连外网。
const base = tmpHome('dy-reply-verify-');
process.env.DSH_HOME = base;
process.env.HOME = base;
process.env.USERPROFILE = base;
process.env.TMP = base;
process.env.TEMP = base;
process.env.TMPDIR = base;

const { openDatabase, setKv } = await import('../lib/db.js');
const db = openDatabase();
const { DouyinSocial, douyinSocialDriver } = await import('../lib/douyin-social.js');

// 第一个轮询只记位置不回 —— 先标成「已播种」，后面每轮才会真去回。
setKv(db, 'douyin.comments.seeded', true);

const WORK = { id: '1234567890', title: '晒猫', kind: 'note' };
// 没有 cid ⇒ 走 DOM 路径（点「回复」→ 找输入框 → 聚焦 → 插字 → 点「发送」）。
const COMMENT = { author: '路人甲', content: '好可爱', cid: '', isAuthor: false, canReply: true };

/** 读页面验证状态的那次 eval（VERIFY_JS 里找验证码 iframe）。 */
const READ_VERIFY = /rc-verifycenter/;
/** 读「框里还有没有字」的那次 eval。 */
const READ_BOX = /ed\.innerText/;

/** ref 着的等待（lib/time-util.js 的 sleep 是 unref 的，测试里不能用）。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 真 driver.reply 的假 CDP：照剧本一步步走
 * （点「回复」→ 找输入框 → 聚焦 → 插字 → 点「发送」→ 读验证状态 → 读框里还有没有字）。
 *
 * timeoutPatterns：命中的表达式按「CDP 超时」报错。
 * disconnectPatterns：命中的表达式按「CDP 断连」报错。
 * tinyTimeoutMs：timeoutMs 不大于它的按「预算耗尽 ⇒ 这次 eval 立刻超时」报错
 *   （真 Browser.eval 拿 1ms 的上限去问 CDP，也是立刻超时）。
 */
function makeDomBrowser({ timeoutPatterns = [], disconnectPatterns = [], tinyTimeoutMs = 0 } = {}) {
	const seen = [];
	const hit = (pats, s) => pats.some((p) => p.test(s));
	return {
		sessionId: 'S1',
		seen,
		async send() { return {}; },
		async eval(expr, opts = {}) {
			const s = String(expr);
			const ms = Number(opts.timeoutMs) || 0;
			seen.push({ s, timeoutMs: ms });
			if (hit(timeoutPatterns, s) || (tinyTimeoutMs > 0 && ms > 0 && ms <= tinyTimeoutMs)) {
				await wait(Math.min(ms, 50));
				throw new Error(`CDP Runtime.evaluate 超时（${ms}ms）`);
			}
			if (hit(disconnectPatterns, s)) throw new Error('WebSocket 已关闭（CDP 断了）');
			if (/leaf\.click\(\)/.test(s)) return true;                    // 点「回复」
			if (/ed\.focus\(\)/.test(s)) return true;                       // 回复框聚焦上了
			if (/byText/.test(s)) return true;                              // 点「发送」→ 评论发出去了
			if (READ_VERIFY.test(s)) return '';                             // 没有验证码
			if (/getBoundingClientRect/.test(s)) return { x: 20, y: 30 };   // 输入框位置
			if (READ_BOX.test(s)) return '';                                // 框里没字了 = 发出去了
			if (/removeAttribute/.test(s)) return true;                     // 清理标记
			if (/comment-input-inner-container/.test(s)) return 0;          // 页面上已有的输入框数
			return null;
		},
	};
}

/**
 * 真 DouyinSocial + 真 driver；读路径（作品列表 / 评论列表 / 打开作品）换成假的。
 * 写路径走真 driver.reply —— 返回值收进 replies，断言「返回不是 ok: true」用。
 */
function makeSocial({ browser, timing }) {
	const host = { running: true, loggedIn: true, browser, exclusive: async (_name, fn) => fn() };
	const social = new DouyinSocial({
		host,
		driver: douyinSocialDriver(host, timing),
		db,
		getConfig: () => ({ enabled: true, comments: { enabled: true, perHour: 5 } }),
		callLlm: async () => '好的呀～',
		log: () => {}, note: () => {},
	});
	const real = social.driver;
	const replies = [];
	social.driver = {
		...real,
		listWorks: async () => [WORK],
		openWork: async () => ({ ok: true }),
		listComments: async () => [COMMENT],
		listCommentsApi: async () => [],   // 这一组只测 DOM 路径（评论没有 cid）
		reply: async (cm, text) => {
			const r = await real.reply(cm, text);
			replies.push(r);
			return r;
		},
	};
	return { social, replies };
}

const resetDb = () => db.exec('DELETE FROM social_reply');
/** 这一轮往 social_reply 里记了什么（'replied' = 虚报了「回了评论」）。 */
const recorded = () => db.prepare("SELECT status FROM social_reply WHERE platform = 'douyin'").all().map((x) => x.status);

/** 跑一轮真 pollComments（内部会走真 driver.reply），返回这一轮的结果。 */
async function poll({ browser, timing }) {
	resetDb();
	const { social, replies } = makeSocial({ browser, timing });
	const polled = await social.pollComments();
	return { polled, replies, statuses: recorded() };
}

/** 一个场景一个断言组：全跑完再汇总（一次看到哪几条红了）。 */
let failed = 0;
async function scenario(name, fn) {
	try {
		await fn();
		ok(name);
	} catch (error) {
		failed++;
		console.error('✗', name, '\n  ', error?.message ?? error);
	}
}

// ── ① 点了发送之后，读验证状态的那次 eval 超时 ────────────────────────────
//  空串既可能是「没有验证码」，也可能是「没读回来」—— 分不开就等于
//  把「不知道」当成「不用验证」，一路落到 ok: true。
await scenario('① 读验证状态超时：不算成功，不记 replied', async () => {
	const browser = makeDomBrowser({ timeoutPatterns: [READ_VERIFY] });
	const { polled, replies, statuses } = await poll({ browser, timing: { evalTimeoutMs: 300, replyBudgetMs: 1500 } });
	assert.equal(replies.length, 1, '这一轮真的走了 DOM 写路径');
	assert.notEqual(replies[0].ok, true, '读不到验证状态不能算「发出去了」');
	assert.equal(replies[0].code, 'VERIFY_UNKNOWN', '读失败要有明确的结果码');
	assert.ok(String(replies[0].error ?? '').length > 0, '失败要说清原因');
	assert.equal(polled.replied, 0, '这一轮不该算回成功');
	assert.ok(!statuses.includes('replied'), '不能记成 replied（状态虚报）');
	assert.deepEqual(statuses, ['failed'], '发过了但结果不明 → 记 failed（下一轮不再发这条）');
});

// ── ② 读「框里还有没有字」超时 ───────────────────────────────────────────
//  「没读回来」不等于「框里没字」—— 读失败时说「字没了 = 发出去了」也是虚报。
await scenario('② 读框里文字超时：不算成功，不记 replied', async () => {
	const browser = makeDomBrowser({ timeoutPatterns: [READ_BOX] });
	const { polled, replies, statuses } = await poll({ browser, timing: { evalTimeoutMs: 300, replyBudgetMs: 1500 } });
	assert.equal(replies.length, 1);
	assert.notEqual(replies[0].ok, true, '读不回回复框不能算「发出去了」');
	assert.equal(replies[0].code, 'SEND_UNKNOWN', '读失败要有明确的结果码');
	assert.ok(String(replies[0].error ?? '').length > 0, '失败要说清原因');
	assert.equal(polled.replied, 0);
	assert.ok(!statuses.includes('replied'), '不能记成 replied（状态虚报）');
	assert.deepEqual(statuses, ['failed']);
});

// ── ③ 不是预算耗尽，是 CDP 断连 / 页面崩 ─────────────────────────────────
//  同一个洞：eval 报错被吞成空串，就分不出「没有验证码」和「没读到」。
await scenario('③ CDP 断连：不算成功，不记 replied', async () => {
	const browser = makeDomBrowser({ disconnectPatterns: [READ_VERIFY] });
	const { polled, replies, statuses } = await poll({ browser, timing: { evalTimeoutMs: 300, replyBudgetMs: 1500 } });
	assert.equal(replies.length, 1);
	assert.notEqual(replies[0].ok, true, 'CDP 断了同样不能算「发出去了」');
	assert.equal(replies[0].code, 'VERIFY_UNKNOWN');
	assert.equal(polled.replied, 0);
	assert.ok(!statuses.includes('replied'), '不能记成 replied（状态虚报）');
});

// ── ④ 预算耗尽：最后一次读拿到 1ms 的上限，CDP 立刻超时 ───────────────────
//  真 Browser.eval 拿 1ms 去问 CDP 也是立刻超时 —— 读不回来，不是「读到空」。
await scenario('④ 预算耗尽读超时：不算成功，不记 replied', async () => {
	const browser = makeDomBrowser({ tinyTimeoutMs: 5 });
	const { polled, replies, statuses } = await poll({ browser, timing: { evalTimeoutMs: 300, replyBudgetMs: 2500 } });
	assert.equal(replies.length, 1);
	assert.notEqual(replies[0].ok, true, '预算耗尽读不回来，不能算「发出去了」');
	assert.equal(polled.replied, 0);
	assert.ok(!statuses.includes('replied'), '不能记成 replied（状态虚报）');
	assert.deepEqual(statuses, ['failed']);
});

// ── ⑤ 回归：一切正常 ⇒ 照旧算回成功、照旧记 replied ───────────────────────
await scenario('⑤ 正常路径：ok:true，记 replied', async () => {
	const browser = makeDomBrowser();
	const { polled, replies, statuses } = await poll({ browser, timing: { evalTimeoutMs: 300, replyBudgetMs: 6000 } });
	assert.equal(replies.length, 1);
	assert.equal(replies[0].ok, true, replies[0].error);
	assert.equal(polled.replied, 1, '正常回评论还是算成功');
	assert.deepEqual(statuses, ['replied'], '正常回评论照旧记 replied');
});

clearInterval(keepAlive);
if (failed) {
	console.error(`\n${failed} 个场景没过`);
	process.exit(1);
}
console.log('douyin-reply-verify-status ok');
