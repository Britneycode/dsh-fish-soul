// 抖音刷视频走纯 HTTP（不开浏览器）—— 覆盖签名、参数、过滤、模式切换。
//
// 真机实测（2026-11-08）：tab/feed 与 aweme/detail 只要 secsdk 那道 md5 签名；
// comment/list 还要 a_bogus（vendor/douyin-bogus.js，从 douyin-im@1.1.0 移植，MIT）。
// 这里全部用假 fetch —— 不碰真抖音，只验我们自己的组装逻辑。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpHome } from './_tmp.mjs';

// browse 里的 sleep 是 unref 的（插件里没问题，进程要能退出），这里挂个 ref 住的保活，
// 否则测试脚本会在 await 期间提前退出。
const keepAlive = setTimeout(() => {}, 120_000);

// ── 1. 签名：md5(uifid_timestamp_SALT_query)，query 用 URLSearchParams 序列化 ──
{
	const { secsdkSignature, SECSDK_SALT, douyinBaseParams, UIFID_COOKIE_NAMES } = await import('../lib/douyin-http.js');
	assert.equal(SECSDK_SALT, 'A96D855A08C0A9707F8BEF0D9A527E4E');
	const query = new URLSearchParams([['a', '1'], ['b', 'x y']]).toString();
	const want = createHash('md5').update(`UIFID_1700000000_${SECSDK_SALT}_${query}`).digest('hex');
	assert.equal(secsdkSignature({ uifid: 'UIFID', stamp: '1700000000', query }), want, '签名算法要对得上');
	// 公共参数：少一个抖音就报「参数不合法」，整组都得在
	const keys = douyinBaseParams().map(([k]) => k);
	for (const k of ['device_platform', 'aid', 'channel', 'pc_client_type', 'pc_libra_divert', 'update_version_code', 'version_code', 'version_name', 'screen_width', 'browser_platform', 'browser_name', 'engine_name', 'os_name', 'cpu_core_num', 'device_memory', 'platform', 'update_version_code']) {
		assert.ok(keys.includes(k), `公共参数少了 ${k}`);
	}
	// uifid 的名字实际是大写，别只认小写
	assert.ok(UIFID_COOKIE_NAMES.includes('UIFID') && UIFID_COOKIE_NAMES.includes('UIFID_TEMP'));
}

// ── 2. DouyinHttp：cookie / uifid / query 组装 ──
{
	const home = tmpHome('dsh-dyhttp0-');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home; // 隔离真 cookie 文件（否则会把本机真 cookie 读进来）
	const { DouyinHttp } = await import('../lib/douyin-http.js');
	const http = new DouyinHttp({ cdpPort: 1 });
	http.jar = new Map([['sessionid', 'S'], ['UIFID', 'UF'], ['UIFID_TEMP', 'UFT'], ['other', 'x']]);
	http.loaded = true; // 别让 ensureCookies 去连 CDP（测试里没有浏览器）
	assert.equal(http.isLoggedIn(), true);
	assert.equal(http.uifid(), 'UF', 'uifid 按优先级取第一个非空的（大写 UIFID 在前）');
	assert.ok(http.cookieHeader().includes('sessionid=S'));

	let seen = null;
	http.fetch = async (url, init) => {
		seen = { url, init };
		return { status: 200, ok: true, text: async () => JSON.stringify({ aweme_list: [], status_code: 0 }) };
	};
	const r = await http.request({ path: '/aweme/v1/web/tab/feed/', params: [['count', '10']] });
	assert.equal(r.status, 200);
	assert.ok(seen.url.includes('x-secsdk-web-signature='), 'URL 上要有 secsdk 签名');
	assert.ok(seen.url.includes('uifid=UF'), 'query 里要带 uifid');
	assert.ok(seen.url.includes('timestamp='), 'query 里要带 timestamp');
	assert.ok(seen.url.includes('device_platform=webapp'), 'query 里要带公共参数');
	assert.equal(seen.init.headers['x-secsdk-web-expire'].length, 10, '要带 x-secsdk-web-expire 头');
	process.env.DSH_HOME = prevHome;
	assert.ok(seen.init.headers.Cookie.includes('sessionid=S'));

	// a_bogus 的端点：URL 上要有 a_bogus
	await http.request({ path: '/aweme/v1/web/comment/list/', params: [['aweme_id', '1']], aBogus: true });
	assert.ok(seen.url.includes('a_bogus='), 'comment/* 这类要 a_bogus');
	assert.ok(seen.init.headers['Content-Type']?.includes('application/x-www-form-urlencoded'), '带 a_bogus 时要有表单 Content-Type');
}

// ── 3. 刷视频：过滤广告 / 直播 / 看过的，走 http 还是浏览器 ──
{
	const { DouyinBrowser } = await import('../lib/douyin-browse.js');
	const { DatabaseSync } = await import('node:sqlite');
	const home = tmpHome('dsh-dyhttp-');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	process.env.DSH_HOME = prevHome;
	db.exec(`CREATE TABLE IF NOT EXISTS douyin_seen (aweme_id TEXT PRIMARY KEY, title TEXT, author TEXT, impression TEXT, skipped INTEGER, liked INTEGER, memory_id INTEGER, seen_at INTEGER, seen_real_at INTEGER)`);

	const feedItems = [
		{ aweme_id: '111', desc: '第一条', author: { nickname: '甲' } },
		{ aweme_id: '222', desc: '广告', author: { nickname: '乙' }, is_ads: true },
		{ aweme_id: '333', desc: '直播间', author: { nickname: '丙' }, is_life_item: true },
		{ aweme_id: '444', desc: '看过的', author: { nickname: '丁' } },
		{ aweme_id: '555', desc: '第五条', author: { nickname: '戊' }, status: { is_prohibited: true } },
		{ aweme_id: '666', desc: '第六条', author: { nickname: '己' } },
	];
	db.prepare('INSERT INTO douyin_seen (aweme_id, title, author, impression, skipped, liked, memory_id, seen_at, seen_real_at) VALUES (?,?,?,?,0,0,NULL,?,?)').run('444', '看过的', '丁', '', 1, 1);

	const http = {
		jar: new Map([['sessionid', 'S']]),
		isLoggedIn: () => true,
		lastError: '',
		ensureCookies: async () => true,
		feed: async () => ({ ok: true, list: feedItems }),
		detail: async (id) => ({ ok: true, detail: { desc: '详情文案', author: { nickname: '作者甲' }, text_extra: [{ hashtag_name: '话题一' }] } }),
		comments: async () => ({ ok: true, list: [{ text: '热评第一条', user: { nickname: '路人' } }] }),
	};
	let browserScrollCalled = 0;
	const browse = new DouyinBrowser({
		db,
		clock: { now: () => Date.now() },
		host: { running: false, loggedIn: false, browser: null, exclusive: async (_l, fn) => fn() },
		getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'http' } }),
		callLlm: async () => '还行',
		persona: () => ({ name: '鱼', brief: '' }),
		worker: { enqueueRealtime: () => {} },
		log: () => {},
		dwellMs: [1, 2],
		http,
	});
	browse.browserScroll = async () => { browserScrollCalled++; return []; };

	const picked = await browse.scroll(3); // 走公开入口：这样"没有 http 分流"的旧实现才会红
	assert.deepEqual(picked.map((p) => p.id), ['111', '666'], '广告 / 直播 / 看过的 / 下架的都要跳过');
	assert.equal(browserScrollCalled, 0, 'http 模式不该动浏览器');

	// 模式开关：配置写 browser 就不走 http
	browse.getConfig = () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'browser' } });
	assert.equal(browse.useHttp(), false, 'mode=browser 时要走老路');

	// http 模式但没登录态 → 这轮退回浏览器（httpBroken）
	browse.getConfig = () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'http' } });
	http.ensureCookies = async () => false;
	browse.host = { running: true, loggedIn: true, browser: null, exclusive: async (_l, fn) => fn() };
	const r2 = await browse.run({ count: 1 });
	assert.equal(browserScrollCalled, 1, '纯 HTTP 拿不到登录态要退回浏览器');
	assert.equal(r2.ok, true, '退回浏览器后照常刷');
	db.close();
}

// ── 4. 细看一条：详情 + 热评 → 感受 → 记忆 ──
{
	const { DouyinBrowser } = await import('../lib/douyin-browse.js');
	const { DatabaseSync } = await import('node:sqlite');
	const home = tmpHome('dsh-dyhttp2-');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	process.env.DSH_HOME = prevHome;
	db.exec(`CREATE TABLE IF NOT EXISTS douyin_seen (aweme_id TEXT PRIMARY KEY, title TEXT, author TEXT, impression TEXT, skipped INTEGER, liked INTEGER, memory_id INTEGER, seen_at INTEGER, seen_real_at INTEGER)`);

	let promptSeen = '';
	const http = {
		jar: new Map([['sessionid', 'S']]), isLoggedIn: () => true, lastError: '', ensureCookies: async () => true,
		feed: async () => ({ ok: true, list: [] }),
		detail: async () => ({ ok: true, detail: { desc: '文案在这', author: { nickname: '作者甲' }, text_extra: [{ hashtag_name: '话题一' }, { hashtag_name: '话题二' }] } }),
		comments: async () => ({ ok: true, list: [{ text: '热评第一条', user: { nickname: '路人' } }] }),
	};
	const browse = new DouyinBrowser({
		db,
		clock: { now: () => Date.now() },
		host: { running: false, loggedIn: false, browser: null, exclusive: async (_l, fn) => fn() },
		getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'http' } }),
		callLlm: async (p) => { promptSeen = p; return '挺有意思，看完想点赞'; },
		persona: () => ({ name: '鱼', brief: '' }),
		worker: { enqueueRealtime: () => {} },
		log: () => {},
		dwellMs: [1, 2],
		http,
	});
	browse.browserWatch = async () => { throw new Error('http 模式不该走浏览器'); };
	const w = await browse.watch({ id: '999', title: '标题', author: '作者甲' }, false, false);
	assert.equal(w.id, '999');
	assert.equal(w.author, '作者甲');
	assert.equal(w.liked, false, '纯 HTTP 这条路还不点赞');
	assert.ok(promptSeen.includes('热评第一条'), '热评要进提示词');
	assert.ok(promptSeen.includes('话题一'), '话题要进提示词');
	const row = db.prepare('SELECT title, author, impression FROM douyin_seen WHERE aweme_id = ?').get('999');
	assert.ok(row !== undefined, '看过的要记进 douyin_seen');
	assert.equal(row.impression, '挺有意思，看完想点赞');
	db.close();
}

clearTimeout(keepAlive);
console.log('✓ 抖音刷视频纯 HTTP：签名 / 公共参数 / 过滤 / 退回浏览器 / 细看一条');
