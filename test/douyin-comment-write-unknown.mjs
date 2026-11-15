// 抖音评论写操作：接口结果不明时**不能再发一次**。
//
// 为什么：postComment 进了页面之后，bridge 调用可能超时 / 断连 / 抖音没回评论 id ——
// 这时候评论**可能已经发出去了**，只是结果没回来。以前一律 ok:false，
// pollComments 就退回 DOM 再点一次「发送」→ 同一条评论在真实账号上发两遍。
//
// 这里用真对象复现：真 DouyinSocial + 真 driver + 真 callBridge +
// 真页面桥源码（node:vm 里跑）+ 真 db。只在最底下假掉两样：CDP（浏览器）和页面 fetch。
// DOM 写路径只做「有没有被调用」的观测（它不是这次要改的东西）。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { tmpHome } from './_tmp.mjs';

const ok = (name) => console.log('✓', name);

// 隔离：HOME / DSH_HOME / TMP 全指到临时目录 —— 不碰真实用户目录、不连外网。
const base = tmpHome('dy-write-');
process.env.DSH_HOME = base;
process.env.HOME = base;
process.env.USERPROFILE = base;
process.env.TMP = base;
process.env.TEMP = base;
process.env.TMPDIR = base;

const { openDatabase, setKv } = await import('../lib/db.js');
const db = openDatabase();
const { DouyinSocial } = await import('../lib/douyin-social.js');
// ⚠️ 页面桥源码要用 vm.runInContext 跑：它要的就是「一个浏览器页面」，
//    沙箱里只有假 document / navigator / fetch，不碰真实页面、不发真实请求。
const { COMMENT_BRIDGE_SOURCE } = await import('../lib/channels/vendor/douyin-bridge/douyin-comment.js');

// 第一次轮询只记位置不回 —— 先把它标成「已播种」，后面每轮才会真去回。
setKv(db, 'douyin.comments.seeded', true);

const WORK = { id: '1234567890', title: '晒猫', kind: 'note' };
const COMMENT = { author: '路人甲', content: '好可爱', cid: 'CID1', isAuthor: false, canReply: true };

const jsonResponse = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

/** 假页面：真页面桥源码在这里跑（node:vm）。 */
function makePage({ fetchImpl, install = true }) {
	const page = {
		window: {},
		document: { cookie: 's_v_web_id=web-1; UIFID=ui-1' },
		navigator: {
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
			language: 'zh-CN', hardwareConcurrency: 8, deviceMemory: 8, connection: {},
		},
		screen: { width: 1920, height: 1080 },
		location: { href: `https://www.douyin.com/note/${WORK.id}`, pathname: `/note/${WORK.id}` },
		fetch: fetchImpl,
		URLSearchParams,
		TextEncoder,
		crypto: globalThis.crypto,
	};
	vm.createContext(page);
	if (install) vm.runInContext(COMMENT_BRIDGE_SOURCE, page);
	return page;
}

/**
 * 假 CDP：eval 把表达式丢进假页面里跑 —— 真桥代码 + 真 callBridge 拼出来的表达式。
 * dropAfterCall：页面里跑完了，结果回来之前 CDP 断（最危险的那种：请求发出去了，结果丢了）。
 */
function makeBrowser(page, { dropAfterCall = false, installWorks = true } = {}) {
	return {
		sessionId: 'S1',
		preloadScripts: [],
		addPreloadScript(s) { this.preloadScripts.push(s); },
		async send() { return {}; },
		async eval(expr) {
			const s = String(expr);
			if (s === COMMENT_BRIDGE_SOURCE) {
				if (!installWorks) return null; // 页面不是真抖音：装完也验不到桥
				vm.runInContext(s, page);
				return true;
			}
			const r = await vm.runInContext(s, page);
			if (dropAfterCall && s.includes('.postComment(')) throw new Error('CDP 断了');
			return r;
		},
	};
}

/** 假抖音接口：记下每次请求，publish 的返回由场景定。 */
function makeFetch({ publish }) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const u = String(url);
		calls.push({ url: u, method: init?.method ?? 'GET' });
		if (u.includes('/comment/publish/')) return publish(u, init);
		if (u.includes('/comment/list/')) return jsonResponse({ status_code: 0, comments: [] });
		return jsonResponse({ status_code: 0 });
	};
	return { fetchImpl, calls };
}

/** 真 DouyinSocial + 真 driver；读路径（作品列表/评论列表/打开作品）和 DOM 写路径换成假的。 */
function makeSocial({ browser, domWrites, comments = [COMMENT] }) {
	const host = { running: true, loggedIn: true, browser, exclusive: async (_name, fn) => fn() };
	const social = new DouyinSocial({
		host, db,
		getConfig: () => ({ enabled: true, comments: { enabled: true, perHour: 5 } }),
		callLlm: async () => '好的呀～',
		log: () => {}, note: () => {},
	});
	const real = social.driver; // 真 driver：真 callBridge + 真页面桥
	social.driver = {
		...real,
		listWorks: async () => [WORK],
		openWork: async () => ({ ok: true }),
		listComments: async () => comments,
		reply: async (cm, text) => { domWrites.push({ cid: cm?.cid ?? '', text }); return { ok: true }; },
	};
	return social;
}

const resetDb = () => db.exec('DELETE FROM social_reply');
const publishCalls = (calls) => calls.filter((c) => c.url.includes('/comment/publish/')).length;

// ── ① 抖音没回评论 id：评论**已经发出去了**，只是没拿到 id ──────────────────
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { text: '好的呀～' } }) });
	const page = makePage({ fetchImpl });
	const social = makeSocial({ browser: makeBrowser(page), domWrites });
	resetDb();
	await social.pollComments();
	assert.equal(publishCalls(calls), 1, '接口只发一次');
	assert.deepEqual(domWrites, [], '接口结果不明时不能再走 DOM 写路径（会重复发评论）');
	// 下一轮也不许再发 —— 写操作不自动重试
	await social.pollComments();
	assert.equal(publishCalls(calls), 1, '写操作不自动重试');
	assert.deepEqual(domWrites, [], '下一轮也不该退回 DOM 再发一遍');
	ok('① 抖音没回评论 id：不退回 DOM，不重复发');
}

// ── ② CDP 在结果回来之前断：请求发出去了，结果丢了 ──────────────────────────
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl });
	const social = makeSocial({ browser: makeBrowser(page, { dropAfterCall: true }), domWrites });
	resetDb();
	await social.pollComments();
	assert.equal(publishCalls(calls), 1, '请求确实已经发出去了');
	assert.deepEqual(domWrites, [], '断连后不能再走 DOM 写路径（会重复发评论）');
	ok('② CDP 断连：不退回 DOM，不重复发');
}

// ── ③ 写操作状态要结构化，不能靠错误文本猜 ──────────────────────────────────
{
	const { fetchImpl } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: {} }) });
	const page = makePage({ fetchImpl });
	const social = makeSocial({ browser: makeBrowser(page), domWrites: [] });
	const x = await social.driver.replyApi({ awemeId: WORK.id, cid: COMMENT.cid, text: '好的呀～' });
	assert.equal(x.ok, false, '没拿到 cid 不算发成功');
	assert.equal(x.writeState, 'ATTEMPTED_UNKNOWN', '写操作状态 = ATTEMPTED_UNKNOWN（可能已经发出去了）');
	ok('③ 写操作状态：结构化的 ATTEMPTED_UNKNOWN');
}

// ── ④ 前置失败（桥没装上）：根本没用发出去 → 既有 DOM 回退必须保留 ────────────
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl, install: false });
	const social = makeSocial({ browser: makeBrowser(page, { installWorks: false }), domWrites });
	resetDb();
	await social.pollComments();
	assert.equal(publishCalls(calls), 0, '根本没发出去');
	assert.equal(domWrites.length, 1, '前置失败仍要退回 DOM 点击（老路别丢）');
	const x = await social.driver.replyApi({ awemeId: WORK.id, cid: COMMENT.cid, text: '好的呀～' });
	assert.equal(x.writeState, 'NOT_ATTEMPTED', '写操作状态 = NOT_ATTEMPTED（没发出去，可以退回 DOM）');
	ok('④ 前置失败：DOM 回退保留，状态 NOT_ATTEMPTED');
}

// ── ⑤ 接口成功：不用再点一次 ────────────────────────────────────────────────
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl });
	const social = makeSocial({ browser: makeBrowser(page), domWrites });
	resetDb();
	const r = await social.pollComments();
	assert.equal(r.replied, 1, '接口成功 = 回成功');
	assert.equal(publishCalls(calls), 1, '只发一次');
	assert.deepEqual(domWrites, [], '接口成功了就不用再点一次');
	ok('⑤ 接口成功：不重复发');
}

// ── ⑥ 没有 cid 的评论：照旧走 DOM 点击 ───────────────────────────────────────
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl });
	const social = makeSocial({
		browser: makeBrowser(page), domWrites,
		comments: [{ author: '路人乙', content: '在吗', cid: '', isAuthor: false, canReply: true }],
	});
	resetDb();
	const r = await social.pollComments();
	assert.equal(r.replied, 1, 'DOM 回退照旧能用');
	assert.equal(domWrites.length, 1, '没有 cid 的评论走 DOM 点击');
	assert.equal(publishCalls(calls), 0, '没有 cid 就不走接口');
	ok('⑥ 没有 cid：正常 DOM 回退不变');
}

console.log('douyin-comment-write-unknown ok');
