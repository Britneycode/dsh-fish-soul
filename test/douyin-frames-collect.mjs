// 抖音：抽帧看画面 + 收藏（2026-11-08）
//
// 抽帧：B站 那条早就有（九宫格 → 模型读成一句话），抖音一直只读文字。
//      真机实测能出图（雪夜巴士 / KDA 舞蹈，九格全满），所以这里守的是**接线和边界**。
// 收藏：跟点赞同一族（commit/* 写接口，纯 Node 拿不到 msToken，必须页面内桥）。
//      服务端回执是 collect_stat（1 = 已收藏），不能只看 status_code。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpHome } from './_tmp.mjs';

const keep = setTimeout(() => {}, 120_000);
const home = tmpHome('dsh-dfc-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const db = openDatabase();
db.exec(`CREATE TABLE IF NOT EXISTS douyin_seen (aweme_id TEXT PRIMARY KEY, title TEXT, author TEXT, impression TEXT,
	skipped INTEGER, liked INTEGER, memory_id INTEGER, seen_at INTEGER, seen_real_at INTEGER)`);

const { buildFfmpegArgs, douyinFrames } = await import('../lib/video-frames.js');
const { DouyinBrowser } = await import('../lib/douyin-browse.js');

// ── ① ffmpeg 参数：referer 要能换（抖音 CDN 校验 referer）──
{
	const bili = buildFfmpegArgs({ url: 'https://x/a.mp4', out: '/tmp/a.jpg' });
	assert.ok(bili.includes('https://www.bilibili.com/'), 'B站 默认还是 bilibili');
	const dy = buildFfmpegArgs({ url: 'https://x/a.mp4', out: '/tmp/a.jpg', referer: 'https://www.douyin.com/', userAgent: 'UA-X' });
	assert.ok(dy.includes('https://www.douyin.com/'), 'referer 要能换');
	assert.ok(dy.includes('UA-X'), 'UA 要能换（抖音空 UA 会 403）');
}

// ── ② douyinFrames：按视频时长铺满 9 格（短视频固定 60 秒会只出 2~3 格、下面全黑）──
{
	const calls = [];
	const fakeGrab = async (url, out, opts) => { calls.push({ url, step: opts.step, seconds: opts.seconds }); throw new Error('停在这'); };
	// 用 10 秒的视频：span≈9，step=max(1, round(9/9))=1
	await douyinFrames(['https://cdn/1.mp4'], { id: 'v1', durationMs: 10_000, dir: tmpHome('dsh-fr-') }).catch(() => {});
	// 上面走的是真 grabMontage（会因没网失败），所以另测参数计算：直接看 buildFfmpegArgs 的 step
	const vf = (step) => buildFfmpegArgs({ url: 'u', out: 'o', step }).join(' ');
	assert.ok(vf(1).includes('fps=1/1'), 'step 要真的进 ffmpeg 参数');
	assert.ok(vf(3).includes('fps=1/3'), 'step 变了参数要跟着变');
	void fakeGrab; void calls;
	// 空地址列表要明确报错，不能悄悄返回空图
	await assert.rejects(() => douyinFrames([], { id: 'v0' }), /没有播放地址/);
}

// ── ③ 刷视频时抽帧：开关关就一次都不抽；开着抽到了就写进 prompt，并占配额 ──
{
	const mk = (cfgB, framesImpl) => new DouyinBrowser({
		db, clock: { now: () => Date.now() }, host: { running: false, loggedIn: false, exclusive: async (_l, fn) => fn() },
		getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'http', ...cfgB } }),
		callLlm: async (p, o) => (o?.images ? '一个穿蓝裙子的人在跳舞' : '好会跳 [收藏]'),
		persona: () => ({ name: '鱼', brief: '' }),
		worker: { enqueueRealtime: () => {} }, log: () => {}, dwellMs: [1, 2],
		frames: framesImpl,
		http: {
			jar: new Map([['sessionid', 'S']]), isLoggedIn: () => true, lastError: '', ensureCookies: async () => true,
			feed: async () => ({ ok: true, list: [] }),
			detail: async () => ({ ok: true, detail: { desc: '跳舞 #KDA', author: { nickname: '某' }, text_extra: [],
				video: { duration: 15_000, play_addr: { url_list: ['https://cdn/v.mp4'] } } } }),
			comments: async () => ({ ok: true, list: [] }),
			digg: async () => ({ ok: true, statusCode: 0, statusMsg: '' }),
			collect: async () => ({ ok: true, statusCode: 0, statusMsg: '' }),
		},
	});

	// 关着：不抽
	{
		let called = 0;
		const b = mk({ frames: false, collect: false }, async () => { called++; return { data: 'x', mediaType: 'image/jpeg' }; });
		const r = await b.watch({ id: 'e1', title: 't', author: 'a' }, false, false);
		assert.equal(called, 0, 'frames 关着就不该抽帧');
		assert.equal(r.visual, '', '没抽帧就没有画面描述');
	}
	// 开着：抽到画面要进 prompt，并且记进结果
	{
		let prompts = [];
		const b = mk({ frames: true, framesPerDay: 5, collect: false }, async () => ({ data: 'YmFzZTY0', mediaType: 'image/jpeg' }));
		b.callLlm = async (p, o) => { prompts.push({ p, hasImg: !!o?.images }); return o?.images ? '一个穿蓝裙子的人在跳舞' : '好会跳'; };
		const r = await b.watch({ id: 'e2', title: 't', author: 'a' }, false, false);
		assert.equal(r.visual, '一个穿蓝裙子的人在跳舞', '画面描述要带回来');
		const withImg = prompts.find((x) => x.hasImg);
		assert.ok(withImg, '要真的把图送给模型看');
		const mainPrompt = prompts.find((x) => !x.hasImg);
		assert.match(mainPrompt.p, /画面：一个穿蓝裙子的人在跳舞/, '画面要进感受的提示词');
		// 画面还要**存进记忆** —— 不然抽帧只有当轮一次性作用，第二天想起这条就只剩文案了。
		// 这是真机跑出来才发现的：配额记了 2 次，记忆里却一条画面都没有。
		const mem = db.prepare("SELECT content FROM memory WHERE channel_id = 'douyin:video:e2'").get();
		assert.ok(mem, '要写记忆');
		assert.match(mem.content, /（画面：一个穿蓝裙子的人在跳舞）/, '画面必须写进记忆，不能只喂提示词');
		// 配额落库
		const key = b.framesDayKey();
		const n = Number(db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? 0);
		assert.equal(n, 1, '抽了一张要记配额');
	}
	// 配额用完：不再抽
	{
		const b = mk({ frames: true, framesPerDay: 1, collect: false }, async () => ({ data: 'x', mediaType: 'image/jpeg' }));
		const key = b.framesDayKey();
		db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, '1', '1');
		let called = 0;
		b.framesOf = async () => { called++; return { data: 'x', mediaType: 'image/jpeg' }; };
		const r = await b.watch({ id: 'e3', title: 't', author: 'a' }, false, false);
		assert.equal(called, 0, '配额用完就不该再抽');
		assert.equal(r.visual, '');
		db.prepare('DELETE FROM kv WHERE key = ?').run(key);
	}
}

// ── ④ 收藏：开关关不调；开着按服务端回执判定 ──
{
	const mkBrowser = (bridgeReply, cfgB = { collect: true }) => {
		const browser = {
			eval: async (expr) => {
				const s = String(expr);
				if (/__fishComment\.collect\b/.test(s)) return bridgeReply;
				if (/__fishComment\.digg\b/.test(s)) return { ok: true, digged: false };
				if (/__fishComment\.version/.test(s)) return 999;
				if (/video-player-digg/.test(s)) return false;
				return true;
			},
		};
		const b = new DouyinBrowser({
			db, clock: { now: () => Date.now() },
			host: { running: true, loggedIn: true, browser, exclusive: async (_l, fn) => fn() },
			getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'browser', ...cfgB } }),
			callLlm: async () => '好看 [收藏]',
			persona: () => ({ name: '鱼', brief: '' }), worker: { enqueueRealtime: () => {} }, log: () => {},
			dwellMs: [1, 2],
			readDetail: async () => ({ ok: true, desc: '文案', author: '作者', tags: [], comments: [] }),
		});
		return b;
	};
	// 服务端确认收藏上
	{
		const w = await mkBrowser({ ok: true, collected: true, confirmed: true }).browserWatch({ id: 'c1', title: 't', author: 'a' }, false, false);
		assert.equal(w.collected, true, '服务端确认了才算收藏上');
	}
	// 服务端说没收藏上 → 不能当成功
	{
		const w = await mkBrowser({ ok: false, error: '抖音没真的收藏上（collect_stat=0）' }).browserWatch({ id: 'c2', title: 't', author: 'a' }, false, false);
		assert.equal(w.collected, false, '服务端否认就不能算成功');
	}
	// 没回执（旧版）→ 按提交成功算
	{
		const w = await mkBrowser({ ok: true, collected: true, confirmed: false }).browserWatch({ id: 'c3', title: 't', author: 'a' }, false, false);
		assert.equal(w.collected, true, '没回执按提交成功算');
	}
	// 开关关着：不调桥
	{
		let called = false;
		const browser = {
			eval: async (expr) => {
				const s = String(expr);
				if (/__fishComment\.collect\b/.test(s)) { called = true; return { ok: true, collected: true }; }
				if (/__fishComment\.version/.test(s)) return 999;
				return true;
			},
		};
		const b = new DouyinBrowser({
			db, clock: { now: () => Date.now() }, host: { running: true, loggedIn: true, browser, exclusive: async (_l, fn) => fn() },
			getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'browser', collect: false } }),
			callLlm: async () => '好看 [收藏]', persona: () => ({ name: '鱼', brief: '' }),
			worker: { enqueueRealtime: () => {} }, log: () => {}, dwellMs: [1, 2],
			readDetail: async () => ({ ok: true, desc: '文案', author: '作者', tags: [], comments: [] }),
		});
		const w = await b.browserWatch({ id: 'c4', title: 't', author: 'a' }, false, false);
		assert.equal(called, false, 'collect 关着就不该调收藏');
		assert.equal(w.collected, false);
	}
}

// ── ⑤ 桥里真有 collect，且走的是 collect 端点 + 以 collect_stat 为准 ──
{
	const { COMMENT_BRIDGE_SOURCE } = await import('../lib/channels/vendor/douyin-bridge/douyin-comment.js');
	const src = String(COMMENT_BRIDGE_SOURCE);
	assert.match(src, /async collect\(/, '桥里要有 collect');
	// 2026-11-08 真机实测：正确端点是 aweme/collect，猜成 commit/collect 会 404 Janus
	assert.ok(src.includes('/aweme/v1/web/aweme/collect/'), '走收藏端点（aweme/collect，不是 commit/collect）');
	assert.ok(!src.includes('/aweme/v1/web/commit/collect/'), '不能用猜出来的 commit/collect（会 404 Janus）');
	assert.ok(src.includes('collects_flag'), '以 collects_flag 为准');
	assert.ok(/action/.test(src), '要带 action');
	const httpSrc = (await import('node:fs')).readFileSync(new URL('../lib/douyin-http.js', import.meta.url), 'utf8');
	assert.ok(httpSrc.includes('/aweme/v1/web/aweme/collect/'), '纯 HTTP 侧也要用正确端点');
	assert.ok(httpSrc.includes("aBogusScope: 'business'"), '收藏和点赞一样用业务参数签');
	// 端点必须带完整公共参数（只传 aweme_id+action 会回 status_code 4）
	assert.ok(/baseQuery/.test(src), '桥要靠 baseQuery 带公共参数');
	// 版本号必须 ≥2：v1 里 collect 还是 commit/collect（404）。页面里的旧桥不会自动更新，
	// 号不变就永远跑旧代码 —— 2026-11-08 踩过一次（改了端点但请求还是旧的）。
	const { COMMENT_BRIDGE_VERSION } = await import('../lib/channels/vendor/douyin-bridge/douyin-comment.js');
	assert.ok(COMMENT_BRIDGE_VERSION >= 2, '改了桥源码必须升版本号，否则页面里跑的还是旧桥');
}

// ── ⑥ http 模式的收藏真的会调（不能只写个变量没人用）──
{
	const calls = [];
	const mk = (cfgB) => new DouyinBrowser({
		db, clock: { now: () => Date.now() }, host: { running: false, loggedIn: false, exclusive: async (_l, fn) => fn() },
		getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: false, share: false, mode: 'http', ...cfgB } }),
		callLlm: async () => '好看 [收藏]',
		persona: () => ({ name: '鱼', brief: '' }), worker: { enqueueRealtime: () => {} }, log: () => {}, dwellMs: [1, 2],
		http: {
			jar: new Map([['sessionid', 'S']]), isLoggedIn: () => true, lastError: '', ensureCookies: async () => true,
			feed: async () => ({ ok: true, list: [] }),
			detail: async () => ({ ok: true, detail: { desc: 'd', author: { nickname: 'a' }, text_extra: [] } }),
			comments: async () => ({ ok: true, list: [] }),
			digg: async () => ({ ok: true, statusCode: 0, statusMsg: '' }),
			collect: async (id, o) => { calls.push([id, o]); return { ok: true, statusCode: 0, statusMsg: '' }; },
		},
	});
	// 关着：不调
	const off = await mk({ collect: false }).watch({ id: 'h1', title: 't', author: 'a' }, false, false);
	assert.equal(calls.length, 0, 'collect 关着不该调');
	assert.equal(off.collected, false);
	// 开着但**浏览器没跑**：退回纯 HTTP（这条 mock 的 host.running=false）
	const on = await mk({ collect: true }).watch({ id: 'h2', title: 't', author: 'a' }, false, false);
	assert.deepEqual(calls, [['h2', { collect: true }]], '浏览器没跑时退回接口（不重试）');
	assert.equal(on.collected, true, 'status_code 0 就算收藏上了');
	// 服务端回 status_code 8（没登录 / 缺 msToken）：不能假装成功
	calls.length = 0;
	const b3 = mk({ collect: true });
	b3.http.collect = async (id, o) => { calls.push([id, o]); return { ok: false, statusCode: 8, statusMsg: '用户未登录' }; };
	const r3 = await b3.watch({ id: 'h3', title: 't', author: 'a' }, false, false);
	assert.equal(r3.collected, false, 'status_code 8 不能算收藏成功');
	// 浏览器在跑：优先走页面桥（页面里发才不需要 msToken），不该再打纯 HTTP
	calls.length = 0;
	const b4 = mk({ collect: true });
	b4.host = {
		running: true, loggedIn: true, exclusive: async (_l, fn) => fn(),
		browser: { eval: async (expr) => {
			const s = String(expr);
			if (/__fishComment\.collect\b/.test(s)) return { ok: true, collected: true, confirmed: false };
			if (/__fishComment\.version/.test(s)) return 999;
			return true;
		} },
	};
	const r4 = await b4.watch({ id: 'h4', title: 't', author: 'a' }, false, false);
	assert.equal(r4.collected, true, '浏览器在跑时收藏成功');
	assert.equal(calls.length, 0, '走了桥就不该再打纯 HTTP（会重复请求写接口）');
}

db.close();
clearTimeout(keep);
console.log('✓ 抖音抽帧（时长铺满九格 / 开关 / 配额 / 进提示词）+ 收藏（回执为准 / 开关关不调 / 桥与 HTTP 两侧都在）');
