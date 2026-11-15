// 抖音评论写操作：接口结果不明时**不能再发一次**；压根没发出去时**还能退回 DOM**。
//
// 为什么：postComment 进了页面之后，bridge 调用可能超时 / 断连 / 抖音没回评论 id ——
// 这时候评论**可能已经发出去了**，只是结果没回来。以前一律 ok:false，
// pollComments 就退回 DOM 再点一次「发送」→ 同一条评论在真实账号上发两遍。
//
// 反过来，本地校验没过（缺作品 id / 正文图片都空）、前置就断了（桥没装上 /
// 取不到上传授权 / 图片传不上去）—— 这些**根本没发出去**，不能跟「结果不明」
// 混为一谈：混了就白白丢掉 DOM 回退（评论再也回不了）。
//
// DOM 写路径不一样：它有好几步（点「回复」→ 找输入框 → 聚焦 → 插字 → 点「发送」），
// 卡在前几步时 exclusive 超时只把错误交给调用方，回调**还在锁里接着跑** ——
// 它可能随后自己点下「发送」。所以 DOM 路径**进写路径就标记**「可能发出去了」
// （宁可少回一条，也不能把同一条评论发两遍）。
//
// 这里用真对象复现：真 DouyinSocial + 真 driver + 真 callBridge +
// 真页面桥源码（node:vm 里跑）+ 真 db + 真 host.exclusive（只把超时缩短）。
// 只在最底下假掉两样：CDP（浏览器）和页面 fetch。
// DOM 写路径这次是真走（假 CDP 照剧本回话）：它卡住后自己把评论发出去的那一下，
// 就是重复公开评论的根源。
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
const { DouyinHost } = await import('../lib/channels/douyin.js');
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
 * hang：匹配到的表达式永远不返回（页面卡死）—— 返回 release 把它放行。
 */
function makeBrowser(page, { dropAfterCall = false, installWorks = true, hang = null } = {}) {
	let release = null;
	const gate = new Promise((resolve) => { release = resolve; });
	return {
		sessionId: 'S1',
		preloadScripts: [],
		addPreloadScript(s) { this.preloadScripts.push(s); },
		async send() { return {}; },
		async eval(expr) {
			const s = String(expr);
			if (hang && hang.test(s)) { await gate; return null; } // 卡住：调用方永远等不到结果
			if (s === COMMENT_BRIDGE_SOURCE) {
				if (!installWorks) return null; // 页面不是真抖音：装完也验不到桥
				vm.runInContext(s, page);
				return true;
			}
			const r = await vm.runInContext(s, page);
			if (dropAfterCall && s.includes('.postComment(')) throw new Error('CDP 断了');
			return r;
		},
		releaseHang: () => release(),
	};
}

/**
 * 真 DOM 写路径的假 CDP：真 driver.reply 会照剧本一步步走
 * （点「回复」→ 找输入框 → 聚焦 → 插字 → 点「发送」）。
 * 点「回复」那一步第一次调用时挂住（模拟页面卡在点回复 / 输入阶段）；
 * 放行后照常返回值 —— 回调会继续往下走，最后真的点下「发送」。
 */
function makeDomBrowser() {
	let release = null;
	const gate = new Promise((resolve) => { release = resolve; });
	let hung = false;
	let replyCalls = 0; // 进了几次 DOM 写路径（点「回复」）
	let sent = 0;       // 真点下「发送」的次数 = 评论发出去了几次
	return {
		sessionId: 'S1',
		preloadScripts: [],
		addPreloadScript(s) { this.preloadScripts.push(s); },
		async send() { return {}; },
		async eval(expr) {
			const s = String(expr);
			if (/leaf\.click\(\)/.test(s)) {
				replyCalls++;
				if (!hung) { hung = true; await gate; } // 第一次：卡住（页面不响应）
				return true;                             // 放行后照常：点着「回复」了
			}
			if (/ed\.focus\(\)/.test(s)) return true;                    // 回复框聚焦上了
			if (/byText/.test(s)) { sent++; return true; }              // 点「发送」→ 评论发出去了
			if (/rc-verifycenter/.test(s)) return '';                    // 没有验证码
			if (/getBoundingClientRect/.test(s)) return { x: 20, y: 30 };// 输入框位置
			if (/ed\.innerText/.test(s)) return '';                      // 框里没字了 = 发出去了
			if (/removeAttribute/.test(s)) return true;                  // 清理标记
			if (/comment-input-inner-container/.test(s)) return 0;       // 页面上已有的输入框数
			return null;
		},
		releaseHang: () => release(),
		replyCalls: () => replyCalls,
		sentCount: () => sent,
		async waitSent(ms = 10_000) {
			const deadline = Date.now() + ms;
			while (sent === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
			return sent;
		},
	};
}

/** 假抖音接口：记下每次请求，publish 的返回由场景定。 */
function makeFetch({ publish, auth }) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const u = String(url);
		calls.push({ url: u, method: init?.method ?? 'GET' });
		if (u.includes('/comment/publish/')) return publish(u, init);
		if (u.includes('/comment/upload/auth/')) return auth ? auth(u, init) : jsonResponse({ status_code: 0 });
		if (u.includes('/comment/list/')) return jsonResponse({ status_code: 0, comments: [] });
		return jsonResponse({ status_code: 0 });
	};
	return { fetchImpl, calls };
}

/** 真 DouyinSocial + 真 driver；读路径（作品列表/评论列表/打开作品）和 DOM 写路径换成假的。
 *  realReply：DOM 写路径也用真 driver.reply（只有它自己知道「点回复 / 点发送」这些步骤）。 */
function makeSocial({ browser, domWrites, comments = [COMMENT], works = [WORK], host, domReply, realReply = false }) {
	const h = host ?? { running: true, loggedIn: true, browser, exclusive: async (_name, fn) => fn() };
	const social = new DouyinSocial({
		host: h, db,
		getConfig: () => ({ enabled: true, comments: { enabled: true, perHour: 5 } }),
		callLlm: async () => '好的呀～',
		log: () => {}, note: () => {},
	});
	const real = social.driver; // 真 driver：真 callBridge + 真页面桥
	social.driver = {
		...real,
		listWorks: async () => works,
		openWork: async () => ({ ok: true }),
		listComments: async () => comments,
		reply: realReply ? real.reply : (domReply ?? (async (cm, text) => { domWrites.push({ cid: cm?.cid ?? '', text }); return { ok: true }; })),
	};
	return social;
}

const resetDb = () => db.exec('DELETE FROM social_reply');
const publishCalls = (calls) => calls.filter((c) => c.url.includes('/comment/publish/')).length;
/** 这一轮往 social_reply 里记了什么（空数组 = 一条都没记 → 这条评论下一轮还能回）。 */
const recorded = () => db.prepare("SELECT status FROM social_reply WHERE platform = 'douyin'").all().map((x) => x.status);

/**
 * 真 DouyinHost：超时的语义是「报错给调用方，锁等 fn 真收尾才放」。
 * 只把「回抖音评论」的超时缩短（测试等不了 90 秒）—— 语义完全一样。
 * 2 秒：CI 上 4 vCPU 被别的套件抢满时，页面桥的 eval 可能慢几百毫秒，
 * 超时太短会抢在「请求已经发出去」之前 —— 那样就测不到「结果不明」这一段了。
 */
function makeRealHost(browser, maxMs = 2000) {
	const host = new DouyinHost({ db, getConfig: () => ({ window: 'visible' }), log: () => {} });
	host.state = 'running';
	host.browser = browser;
	host.loggedIn = true;
	const realExclusive = host.exclusive.bind(host);
	host.exclusive = (label, fn, opts = {}) => realExclusive(label, fn, label === '回抖音评论' ? { ...opts, maxMs } : opts);
	return host;
}

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

// ── ⑦ 缺作品 id：本地校验没过，请求**根本没发出去** ──────────────────────────
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl });
	const social = makeSocial({ browser: makeBrowser(page), domWrites, works: [{ id: '', title: '晒猫', kind: 'note' }] });
	resetDb();
	await social.pollComments();
	assert.equal(publishCalls(calls), 0, '本地校验没过 = publish 一次都不能调');
	assert.equal(domWrites.length, 1, '没发出去 → 仍要退回 DOM 点击（老路别丢）');
	ok('⑦ 缺作品 id：publish=0，DOM 回退保留');
}

// ── ⑧ 正文和图片都空：同样根本没发出去 ──────────────────────────────────────
{
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl });
	const social = makeSocial({ browser: makeBrowser(page), domWrites: [] });
	const x = await social.driver.replyApi({ awemeId: WORK.id, cid: COMMENT.cid, text: '' });
	assert.equal(x.ok, false, '正文和图都空不算发成功');
	assert.equal(x.writeState, 'NOT_ATTEMPTED', '根本没发出去 → NOT_ATTEMPTED（可以退回 DOM）');
	assert.equal(publishCalls(calls), 0, 'publish 一次都不能调');
	ok('⑧ 正文和图片都空：publish=0，状态 NOT_ATTEMPTED');
}

// ── ⑨ 取图片上传授权失败：前置就断了，评论没发出去 ──────────────────────────
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({
		publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }),
		auth: async () => { throw new Error('网络断了'); },
	});
	const page = makePage({ fetchImpl });
	const social = makeSocial({ browser: makeBrowser(page), domWrites });
	social.replyImages = async () => ({ text: '好的呀～', images: [{ bytes: Buffer.from([1, 2, 3]), format: 'jpeg' }] });
	resetDb();
	await social.pollComments();
	assert.equal(publishCalls(calls), 0, '授权没拿到 = publish 一次都不能调');
	assert.equal(domWrites.length, 1, '前置失败 → 仍要退回 DOM 点击');
	const x = await social.driver.replyApi({ awemeId: WORK.id, cid: COMMENT.cid, text: '好的呀～', images: [{ bytes: Buffer.from([1, 2, 3]), format: 'jpeg' }] });
	assert.equal(x.writeState, 'NOT_ATTEMPTED', '授权失败 → NOT_ATTEMPTED');
	ok('⑨ 上传授权失败：状态 NOT_ATTEMPTED，DOM 回退保留');
}

// ── ⑩ 图片上传网络异常（uploadImage 抛错）：前置就断了，评论没发出去 ────────
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({
		publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }),
		auth: async () => jsonResponse({
			status_code: 0, access_key: 'ak', secret_key: 'sk', session_token: 'st',
			service_id: 'sid', upload_domain: 'imagex.example', region: 'cn',
		}),
	});
	const page = makePage({ fetchImpl });
	const social = makeSocial({ browser: makeBrowser(page), domWrites });
	social.replyImages = async () => ({ text: '好的呀～', images: [{ bytes: Buffer.from([1, 2, 3]), format: 'jpeg' }] });
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error('网络断了'); }; // 上传走 globalThis.fetch
	resetDb();
	try {
		await social.pollComments();
		const x = await social.driver.replyApi({ awemeId: WORK.id, cid: COMMENT.cid, text: '好的呀～', images: [{ bytes: Buffer.from([1, 2, 3]), format: 'jpeg' }] });
		assert.equal(x.ok, false, '上传挂了不算发成功');
		assert.equal(x.writeState, 'NOT_ATTEMPTED', '上传异常 → NOT_ATTEMPTED（没发出去，能退回 DOM）');
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.equal(publishCalls(calls), 0, '图没传上去 = publish 一次都不能调');
	assert.equal(domWrites.length, 1, '前置失败 → 仍要退回 DOM 点击');
	ok('⑩ 图片上传网络异常：状态 NOT_ATTEMPTED，DOM 回退保留');
}

// ── ⑪ 真实 host.exclusive：请求挂住 → 独占锁超时 → 下一轮不 DOM / 不重发 ──────
//  这里用**真** DouyinHost.exclusive（不是假锁）：超时的语义是「报错给调用方，
//  锁等 fn 真收尾才放」—— 挂住的那次写操作到底发出去了没有，只有真锁才说得清。
{
	const keepAlive = setInterval(() => {}, 1000); // 钉住事件循环（挂住的 promise 不算活）
	try {
		const domWrites = [];
		let releaseHang;
		const hung = new Promise((_resolve, reject) => { releaseHang = reject; });
		const { fetchImpl, calls } = makeFetch({ publish: () => hung });
		const page = makePage({ fetchImpl });
		const browser = makeBrowser(page);
		browser.isAlive = () => true;
		const host = makeRealHost(browser);
		const social = makeSocial({ browser, domWrites, host });
		resetDb();
		const r1 = await social.pollComments();
		assert.equal(r1.ok, false, '挂住超时 → 这一轮没发成');
		assert.equal(publishCalls(calls), 1, '请求已经发出去了（只是结果没回来）');
		assert.deepEqual(domWrites, [], '挂住超时也不能退回 DOM 再点一次');
		assert.deepEqual(recorded(), ['failed'], '写操作挂住 = 可能已经发出去了 → 记 failed（下一轮不再发这条）');
		// 请求最终死了 → 桥报「结果不明」→ 锁放掉
		releaseHang(new Error('连接断了'));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const r2 = await social.pollComments();
		assert.equal(r2.ok, true, '下一轮正常跑完');
		assert.equal(publishCalls(calls), 1, '下一轮不许再发一次（可能已经发出去了）');
		assert.deepEqual(domWrites, [], '下一轮也不许退回 DOM');
		ok('⑪ 请求挂住超时（真 exclusive）：下一轮不 DOM、不重发');
	} finally {
		clearInterval(keepAlive);
	}
}

// ── ⑫ 本地校验没过 → 退回 DOM；DOM 挂住 + 独占锁超时 → 记 failed ────────────────
//  缺作品 id → 接口路径的本地校验就拒了（publish 一次都没调）→ 退回 DOM；
//  DOM 这边页面卡住挂住 → 独占锁超时。
//  ⚠️ DOM 路径是**保守标记**：进了写路径就算「可能发出去了」（回调卡住时它还在锁里
//  接着跑，可能随后自己点下「发送」）→ 记 failed，下一轮不再进 DOM 回退。
//  宁可少回一条，也不能把同一条评论在真实账号上发两遍。
{
	const keepAlive = setInterval(() => {}, 1000); // 钉住事件循环（挂住的 promise 不算活）
	let releaseDom;
	const domHang = new Promise((resolve) => { releaseDom = resolve; });
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl });
	const browser = makeBrowser(page);
	browser.isAlive = () => true;
	const host = makeRealHost(browser);
	const social = makeSocial({
		browser, domWrites, host,
		works: [{ id: '', title: '晒猫', kind: 'note' }], // 缺作品 id → 本地校验拒
		domReply: async (cm, text) => { domWrites.push({ cid: cm?.cid ?? '', text }); await domHang; return { ok: true }; },
	});
	resetDb();
	try {
		const r = await social.pollComments();
		assert.equal(r.ok, false, '独占锁超时 → 这一轮没发成');
		assert.equal(publishCalls(calls), 0, '本地校验没过 = publish 一次都不能调');
		assert.equal(domWrites.length, 1, '没发出去 → 仍要退回 DOM 点击（老路别丢）');
		assert.deepEqual(recorded(), ['failed'], 'DOM 回退进去了 = 可能已经发出去了 → 记 failed（下一轮不再进 DOM 回退）');
	} finally {
		releaseDom();
		clearInterval(keepAlive);
	}
	ok('⑫ 本地校验失败 → 退回 DOM；DOM 挂住超时：记 failed');
}

// ── ⑬ 前置阶段挂住（取上传授权不返回）+ 独占锁超时 → 同样不该记 failed ────────
//  前置阶段没过 = 图还没传上去 = 评论**根本没发出去**。这时候超时，
//  不能当成「可能已经发出去了」—— 记 failed 就把这条评论永久丢了。
{
	const keepAlive = setInterval(() => {}, 1000); // 钉住事件循环（挂住的 promise 不算活）
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl });
	// 页面卡死：取上传授权的 CDP 调用永远不返回
	const browser = makeBrowser(page, { hang: /__fishComment\.uploadAuth/ });
	browser.isAlive = () => true;
	const host = makeRealHost(browser);
	const social = makeSocial({ browser, domWrites, host });
	social.replyImages = async () => ({ text: '好的呀～', images: [{ bytes: Buffer.from([1, 2, 3]), format: 'jpeg' }] });
	resetDb();
	try {
		const r = await social.pollComments();
		assert.equal(r.ok, false, '独占锁超时 → 这一轮没发成');
		assert.equal(publishCalls(calls), 0, '前置就断了 = publish 一次都不能调');
		assert.deepEqual(domWrites, [], '接口还没写就卡住 → 这次没轮到 DOM');
		assert.deepEqual(recorded(), [], '压根没发出去 → 不该记 failed（下一轮还能回）');
	} finally {
		browser.releaseHang();
		clearInterval(keepAlive);
	}
	ok('⑬ 前置阶段挂住 + 超时：不记 failed，可回退');
}

// ── ⑭ 排队就超时了（回调根本没跑）→ 更不该记 failed ──────────────────────────
//  真 exclusive 的计时器是从回调开始跑的，所以「排队超时」用假 exclusive 模拟：
//  回调压根没开始 → 什么都没发出去 → 一条都不该记。
{
	const domWrites = [];
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const page = makePage({ fetchImpl });
	const browser = makeBrowser(page);
	const host = {
		running: true, loggedIn: true, browser,
		exclusive: async (label, fn) => {
			if (label === '回抖音评论') throw new Error('回抖音评论超时'); // 排队没排上：回调没跑
			return fn();
		},
	};
	const social = makeSocial({ browser, domWrites, host, works: [{ id: '', title: '晒猫', kind: 'note' }] });
	resetDb();
	const r = await social.pollComments();
	assert.equal(r.ok, false, '排队超时 → 这一轮没发成');
	assert.equal(publishCalls(calls), 0, '回调没跑 = publish 一次都不能调');
	assert.deepEqual(domWrites, [], '回调没跑 = DOM 也没点');
	assert.deepEqual(recorded(), [], '压根没跑 → 不该记 failed');
	ok('⑭ 排队超时（回调没跑）：不记 failed');
}

// ── ⑮ DOM 写路径卡在「点回复」阶段 + 独占锁超时 → 下一轮不许再走 DOM 写路径 ──────
//  DOM 写路径有好几步：点「回复」→ 找输入框 → 聚焦 → 插字 → 点「发送」。
//  卡在前几步时，exclusive 超时只把错误交给调用方，回调**还在锁里接着跑** ——
//  它可能随后自己点下「发送」，评论**已经发出去了**。
//  这时候只有「进了写路径就标记」才能保证下一轮不再发一遍（重复公开评论）。
{
	const keepAlive = setInterval(() => {}, 1000); // 钉住事件循环（挂住的 promise 不算活）
	const { fetchImpl, calls } = makeFetch({ publish: async () => jsonResponse({ status_code: 0, comment: { cid: '999' } }) });
	const browser = makeDomBrowser();
	browser.isAlive = () => true;
	const host = makeRealHost(browser);
	const social = makeSocial({
		browser, domWrites: [], host,
		comments: [{ ...COMMENT, cid: '' }], // 没有 cid → 只能走 DOM 写路径
		realReply: true,                     // DOM 写路径走真 driver.reply
	});
	social.driver.listCommentsApi = async () => []; // 这一条只测 DOM 路径
	resetDb();
	try {
		try {
			const r1 = await social.pollComments();
			assert.equal(r1.ok, false, '独占锁超时 → 这一轮没发成');
			assert.equal(browser.replyCalls(), 1, 'DOM 写路径被调用了（卡在点「回复」阶段）');
			assert.equal(publishCalls(calls), 0, '没有 cid = 没走接口');
			assert.deepEqual(recorded(), ['failed'], 'DOM 路径进了写路径就算「可能发出去了」→ 记 failed（下一轮不再发这条）');
		} finally {
			browser.releaseHang(); // 放行 → 回调接着往下走，最后自己点下「发送」
		}
		await browser.waitSent();
		assert.equal(browser.sentCount(), 1, '卡住的回调放行后自己发出去了（这个窗口是真的）');
		// 下一轮：这条已经记了 failed → 不再回 → 不会再走 DOM 写路径（否则就是重复公开评论）
		const r2 = await social.pollComments();
		assert.equal(r2.ok, true, '下一轮正常跑完');
		assert.equal(browser.replyCalls(), 1, '下一轮不许再走 DOM 写路径（会重复发评论）');
		assert.equal(browser.sentCount(), 1, '下一轮不许再发一次');
		ok('⑮ DOM 路径卡住 + 超时：下一轮不再走 DOM 写路径');
	} finally {
		clearInterval(keepAlive);
	}
}

console.log('douyin-comment-write-unknown ok');
