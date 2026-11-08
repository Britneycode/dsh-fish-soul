// 浏览器版点赞改走页面内接口桥（digg），不再点 DOM 按钮。
//
// 为什么改：`btn.click()` 不触发抖音的 React 合成事件（点完不发请求），
// 真实鼠标事件在详情页也常点不上（按钮 getBoundingClientRect() 是 0×0）。
// 库里的证据：douyin_seen 27 条只有 1 条 liked=1。
//
// 桥里用页面自己 fetch —— secSDK 会补 msToken 和签名（纯 Node 拿不到 msToken，
// 一律 status_code 8「用户未登录」）。返回的 user_digged 才是真凭据，不能只看 status_code。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpHome } from './_tmp.mjs';

const keepAlive = setTimeout(() => {}, 120_000);

// ── 1. 桥源码里有 digg，且参数对 ──
{
	const { COMMENT_BRIDGE_SOURCE } = await import('../lib/channels/vendor/douyin-bridge/douyin-comment.js');
	const src = String(COMMENT_BRIDGE_SOURCE);
	assert.ok(/async digg\(/.test(src), '桥里要有 digg 方法');
	assert.ok(src.includes('/aweme/v1/web/commit/item/digg/'), '走点赞端点');
	assert.ok(src.includes('digg_type'), '要带 digg_type');
	assert.ok(('user_digg') || src.includes('user_digged'), '要以 user_digged 为准');
}

// ── 2. browserWatch 的点赞走桥，并按 user_digged 判定 ──
{
	const { DouyinBrowser } = await import('../lib/douyin-browse.js');
	const home = tmpHome('dsh-dyb-');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	process.env.DSH_HOME = prevHome;
	db.exec(`CREATE TABLE IF NOT EXISTS douyin_seen (aweme_id TEXT PRIMARY KEY, title TEXT, author TEXT, impression TEXT, skipped INTEGER, liked INTEGER, memory_id INTEGER, seen_at INTEGER, seen_real_at INTEGER)`);

	// mock 浏览器：eval 收到什么表达式就返回什么（按 method 名分辨）
	const makeBrowser = (bridgeReply, domReply = true) => ({
		eval: async (expr) => {
			const s = String(expr);
			if (/__fishComment\.digg\b/.test(s)) return bridgeReply;
			if (/__fishComment\.version/.test(s)) return 999; // 桥已装
			if (/video-player-digg/.test(s)) return domReply; // DOM 兜底
			return { ok: true };
		},
	});

	const mk = (browser) => new DouyinBrowser({
		db,
		clock: { now: () => Date.now() },
		host: { running: true, loggedIn: true, exclusive: async (_l, fn) => fn() },
		getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: true, share: false, mode: 'browser' } }),
		callLlm: async () => '好看 [点赞]',
		persona: () => ({ name: '鱼', brief: '' }),
		worker: { enqueueRealtime: () => {} },
		log: () => {},
		dwellMs: [1, 2],
		readDetail: async () => ({ ok: true, desc: '文案', author: '作者', tags: [], comments: [] }),
	});
	// 让它拿到指定 browser
	const withBrowser = (browser) => {
		const inst = mk(browser);
		inst.host = { running: true, loggedIn: true, browser, exclusive: async (_l, fn) => fn() };
		return inst;
	};

	// ① 桥说赞上了（user_digged=1）→ liked=true
	{
		const inst = withBrowser(makeBrowser({ ok: true, digged: true, confirmed: true }));
		const w = await inst.browserWatch({ id: '111', title: 't', author: 'a' }, true, false);
		assert.equal(w.liked, true, '桥确认赞上了，liked 要 true');
		const row = db.prepare('SELECT liked FROM douyin_seen WHERE aweme_id = ?').get('111');
		assert.equal(row.liked, 1);
	}
	// ② 桥说没赞上（服务端回 user_digged=0）→ 不能算成功（DOM 点到也不认）
	{
		const inst = withBrowser(makeBrowser({ ok: false, error: '抖音没真的点上赞（user_digged=0）' }));
		const w = await inst.browserWatch({ id: '222', title: 't', author: 'a' }, true, false);
		assert.equal(w.liked, false, '服务端没确认就不能算赞上（这正是以前 27 条只 1 条 liked 的坑）');
	}
	// ③ 桥里没返回 user_digged（旧版抖音）→ 按成功算，但显式标记 confirmed=false
	{
		const inst = withBrowser(makeBrowser({ ok: true, digged: true, confirmed: false }));
		const w = await inst.browserWatch({ id: '333', title: 't', author: 'a' }, true, false);
		assert.equal(w.liked, true, '没回执时按提交成功算');
	}
	// ④ 没开点赞 → 压根不调桥
	{
		let called = false;
		const browser = {
			eval: async (expr) => {
				const s = String(expr);
				if (/__fishComment\.digg\b/.test(s)) { called = true; return { ok: true, digged: true }; }
				if (/__fishComment\.version/.test(s)) return 999;
				return true;
			},
		};
		const inst = withBrowser(browser);
		inst.getConfig = () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'browser' } });
		const w = await inst.browserWatch({ id: '444', title: 't', author: 'a' }, false, false);
		assert.equal(called, false, '没开点赞就不调桥');
		assert.equal(w.liked, false);
	}
	db.close();
}

clearTimeout(keepAlive);
console.log('✓ 浏览器版点赞走页面内桥：以 user_digged 为准，没回执按提交成功算，没开点赞不调');
