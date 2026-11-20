/**
 * 抖音视频的**触发链路**（接线轮）。
 *
 * 守的是四件「写了但不接上就等于没写」的事：
 *   B16 自走层能真的触发视频（prepareVideo 真的被调一次）
 *   B17 图文的一次触发不牵动视频，反之亦然（两套配额 / 两套判定）
 *   B18 浏览器锁的时长从转码预算推导（不是写死的常量）
 *   B19 点「发布」之前先持久化（**时序**，不是「被调过」）
 * 另外守手动触发路由 /douyin/video-now 与视频配置块的存-读。
 *
 * 不启浏览器、不花钱：真 driver + 假浏览器、假 host、假 clock、假视频生成器，配真 SQLite。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-dyvtrigger-');
process.env.DSH_HOME = home;

const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const dy = await import('../lib/douyin-social.js');
const { DouyinSocial, douyinSocialDriver } = dy;
const PAGE_TIMING = dy.PAGE_TIMING;
const VIDEO_LOCK_MARGIN_MS = dy.VIDEO_LOCK_MARGIN_MS;
const { registerRoutes } = await import('../lib/routes.js');

const db = openDatabase();

// ── 假的一整套：driver / host / clock / 视频生成器 ───────────────────────────
const calls = { renderCard: 0, prepareNote: 0, listRecommendedMusic: 0, closeMusicPanel: 0, publishNote: 0, prepareVideo: 0, publishVideo: 0 };
const resetCalls = () => { for (const k of Object.keys(calls)) calls[k] = 0; };
const driver = {
	renderCard: async () => { calls.renderCard++; return Buffer.from('card'); },
	prepareNote: async () => { calls.prepareNote++; return { ok: true }; },
	listRecommendedMusic: async () => { calls.listRecommendedMusic++; return { ok: true, songs: ['歌'] }; },
	closeMusicPanel: async () => { calls.closeMusicPanel++; },
	publishNote: async ({ beforeSubmit }) => { calls.publishNote++; await beforeSubmit(); return { ok: true, musicPicked: true }; },
	prepareVideo: async () => { calls.prepareVideo++; return { ok: true }; },
	publishVideo: async ({ beforeSubmit }) => { calls.publishVideo++; await beforeSubmit(); return { ok: true }; }
};
const locks = [];
const host = {
	running: true,
	loggedIn: true,
	exclusive: async (label, fn, opts) => { locks.push({ label, opts }); return await fn(); }
};
let vt = 100;
let day = '2026-11-09';
const clock = { now: () => vt, getRoleDateParts: () => ({ dateStr: day, hour: 12, minute: 0 }) };
const callLlm = async (prompt) => {
	if (prompt.includes('配个「心情」')) return '{"mood":"warm","reason":"随手"}';
	if (prompt.includes('配背景音乐')) return '歌';
	return prompt.includes('短视频') ? '厨房的蒸汽糊住了窗' : '今天风挺大的';
};
const genCalls = [];
const videoGen = {
	generate: async (cfg, opts) => {
		genCalls.push({ cfg, opts });
		return { ok: true, file: join(home, 'douyin-videos', 'v1.mp4'), bytes: 1024, provider: cfg.provider, elapsedMs: 1000 };
	}
};
const douyinCfg = {
	enabled: true,
	masterName: '主人',
	post: { enabled: true, perDay: 1 },
	video: { enabled: true, perDay: 1, provider: 'volc', baseURL: 'https://example.invalid', apiKey: 'k', model: 'm', durationSec: 5, aspectRatio: '9:16', resolution: '768P' },
	comments: { enabled: false, perHour: 4 }
};
const make = (over = {}) => new DouyinSocial({
	db, clock, host, driver, getConfig: () => douyinCfg, callLlm, persona: () => ({ name: '鱼' }),
	cardDir: join(home, 'cards'), videoGen,
	note: () => {}, notify: () => {},
	random: () => 0, postRealGapMs: 0, ...over
});
/** 等这一轮发布结束（maybePost 是后台跑的，不等就断言早了）。 */
const waitIdle = async (s) => {
	for (let i = 0; i < 500 && s.posting; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(s.posting, false, '发布要能结束');
};
const partsOf = () => ({ dateStr: day, hour: 12, minute: 0 });

// 测试里的配置存档：跟生产同语义（普通对象递归合并、其余值整体覆盖、undefined 不覆盖）。
// 生产那边是 lib/index.js 的 saveConfigFile（写文件 + deepMerge），这里不落盘。
const deepMerge = (base, over) => {
	const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
	if (!isObj(base)) return isObj(over) ? { ...over } : (over === undefined ? base : over);
	const out = { ...base };
	if (!isObj(over)) return out;
	for (const [k, v] of Object.entries(over)) {
		if (v === undefined) continue;
		out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
	}
	return out;
};

try {
	// ── B16：自走层触发视频 → 真的走到 publishVideoWork ───────────────────────
	//
	// 「接线零覆盖」的老坑：maybePost 支持 kind='video'，但没人调它 —— 鱼一次都不会发视频。
	// 这里从**自走层那一层**（maybePost）走一遍，断言真的调到了 prepareVideo。
	{
		const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
		assert.match(src, /douyinSocial\.maybePost\(\{\s*\.\.\.x,\s*kind:\s*'video'\s*\}\)/,
			'自走层要单独触发一次视频（index.js 的 social 钩子）');
		assert.match(src, /douyinSocial\.maybePost\(x\)/,
			'图文照旧走原来那次调用（两套判定不能混成一次）');
	}
	{
		resetCalls();
		genCalls.length = 0;
		locks.length = 0;
		const s = make();
		const fired = s.maybePost({ parts: partsOf(), slot: { availability: 'idle' }, mood: '', kind: 'video' });
		assert.equal(fired, true, '视频的触发判定要能过（random=0）');
		await waitIdle(s);
		assert.equal(calls.prepareVideo, 1, '视频触发要真的走到 prepareVideo（publishVideoWork）');
		assert.equal(calls.publishVideo, 1, '要点一次发布');
		assert.equal(genCalls.length, 1, '生成一次');
		assert.equal(genCalls[0].opts.outDir, s.videoDir, '生成的 mp4 要落在视频目录里（清理的就是这个目录）');
		assert.equal(getKv(db, 'douyin.video.day', null)?.count, 1, '视频额度记在 douyin.video.day');
		assert.equal(getKv(db, 'douyin.post.day', null), null, '发视频不该动图文额度');
	}

	// ── B17：图文的一次触发不牵动视频，反之亦然 ───────────────────────────────
	{
		resetCalls();
		genCalls.length = 0;
		day = '2026-11-10';
		const s = make();
		assert.equal(s.maybePost({ parts: partsOf(), slot: { availability: 'idle' }, mood: '' }), true, '图文要能触发');
		await waitIdle(s);
		assert.equal(calls.renderCard, 1, '图文要画卡片');
		assert.equal(calls.prepareNote, 1, '图文要走 prepareNote');
		assert.equal(calls.prepareVideo, 0, '图文的一次触发不该调 prepareVideo');
		assert.equal(calls.publishVideo, 0, '图文的一次触发不该调 publishVideo');
		assert.equal(genCalls.length, 0, '图文不该触发视频生成（不花钱）');
		assert.equal(s.postState(day, 'video').count, 0, '图文不动视频额度');
		assert.equal(s.postState(day, 'post').count, 1, '图文额度记在 douyin.post.day');
	}
	{
		resetCalls();
		genCalls.length = 0;
		day = '2026-11-11';
		const s = make();
		assert.equal(s.maybePost({ parts: partsOf(), slot: { availability: 'idle' }, mood: '', kind: 'video' }), true, '视频要能触发');
		await waitIdle(s);
		assert.equal(calls.prepareVideo, 1, '视频要走 prepareVideo');
		assert.equal(calls.renderCard, 0, '视频不该画卡片');
		assert.equal(calls.prepareNote, 0, '视频不该走图文那条路');
		assert.equal(calls.publishNote, 0, '视频不该走图文那条路');
		assert.equal(calls.listRecommendedMusic, 0, '视频不配乐');
		assert.equal(s.postState(day, 'post').count, 0, '视频不动图文额度');
		assert.equal(getKv(db, 'douyin.video.day', null)?.count, 1, '视频额度记在 douyin.video.day');
	}

	// ── 视频自己的三道闸：开关 / 概率 / 尝试次数 ─────────────────────────────
	//
	// 这三道是「不乱花钱」的全部闸门，删掉任何一道测试都该红。
	// （图文那套在 smoke-social.mjs 里有六条对照，视频这三条之前一条都没有。）
	{
		day = '2026-11-14';
		// ① 视频开关关着 → 一次都不许试（图文开着也不行）
		{
			const s = make({ getConfig: () => ({ ...douyinCfg, video: { ...douyinCfg.video, enabled: false } }) });
			resetCalls();
			genCalls.length = 0;
			assert.equal(s.maybePost({ parts: partsOf(), slot: { availability: 'idle' }, mood: '', kind: 'video' }), false, '视频开关关着不许触发');
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(calls.prepareVideo, 0, '视频开关关着不许走到发布');
			assert.equal(genCalls.length, 0, '视频开关关着不许花钱');
		}
		// ② 概率没抽中 → 不试（random 0.5 ≫ 1%）
		{
			const s = make({ random: () => 0.5 });
			resetCalls();
			genCalls.length = 0;
			assert.equal(s.maybePost({ parts: partsOf(), slot: { availability: 'idle' }, mood: '', kind: 'video' }), false, '概率没抽中不许触发');
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(genCalls.length, 0, '没抽中不许花钱');
		}
		// ③ 今天的尝试次数用完 → 不再试（生成一次 = 花一次钱）
		{
			setKv(db, 'douyin.video.day', { date: day, count: 0, tries: 1, lastVirtual: 0 });
			const s = make();
			resetCalls();
			genCalls.length = 0;
			assert.equal(s.maybePost({ parts: partsOf(), slot: { availability: 'idle' }, mood: '', kind: 'video' }), false, '今天的尝试次数用完了就不再试');
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(genCalls.length, 0, '尝试次数用完不许再花钱');
		}
	}

	// ── B18：浏览器锁的时长从转码预算推导 ────────────────────────────────────
	//
	// exclusive 超时只报错、锁要等 fn 真结束才放 ⇒ 锁预算必须比转码预算长，
	// 而且不能写死常量（改了转码预算忘了改锁预算 = 锁提前超时，页面一直被占）。
	{
		assert.ok(PAGE_TIMING, 'PAGE_TIMING 要导出（测试要拿它推锁预算）');
		assert.ok(PAGE_TIMING.transcodeBudgetMs >= 300_000, '转码预算至少 5 分钟（实测最坏值 180 秒不能拿来当预算）');
		day = '2026-11-12';
		locks.length = 0;
		const s = make();
		const r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, true, r.error);
		const lock = locks.find((x) => x.label === '发抖音视频');
		assert.ok(lock, '发视频要占浏览器锁');
		assert.equal(lock.opts.maxMs, PAGE_TIMING.transcodeBudgetMs + VIDEO_LOCK_MARGIN_MS, '锁预算要从转码预算推导，不能写死');
		assert.ok(lock.opts.maxMs > PAGE_TIMING.transcodeBudgetMs, '锁预算要比转码预算长（锁要等 fn 真结束才放）');
		assert.ok(lock.opts.maxMs >= PAGE_TIMING.transcodeBudgetMs + 120_000, '锁余量至少 2 分钟（锁里除转码还有探活 / 导航 / 填表 / 发布确认）');
	}

	// ── B19：点「发布」之前先持久化（时序，不是「被调过」） ───────────────────
	//
	// 用真 driver + 假浏览器：beforeSubmit 记录一次，点击记录一次，比顺序。
	// 注释承诺「在可能产生平台副作用之前持久化」—— 把 beforeSubmit 挪到点击之后，测试必须红。
	{
		const order = [];
		const fakeBrowser = {
			eval: async (expr) => {
				const s = String(expr);
				if (s.includes('verifycenter')) return '';                       // 没有验证码
				if (s.includes('button') && s.includes('innerText')) { order.push('click'); return true; }
				if (s.includes('location.href')) return { url: 'https://creator.douyin.com/creator-micro/content/manage', text: '已发布' };
				return true;
			},
			send: async () => {},
			goto: async () => ({})
		};
		const d = douyinSocialDriver({ running: true, browser: fakeBrowser }, { waitBudgetMs: 1000, evalTimeoutMs: 1000 });
		const r = await d.publishVideo({ beforeSubmit: async () => { order.push('beforeSubmit'); } });
		assert.equal(r.ok, true, JSON.stringify(r));
		assert.deepEqual(order, ['beforeSubmit', 'click'], 'beforeSubmit 必须在点击发布之前');
	}

	// ── 手动触发路由 /douyin/video-now + 视频配置块的存-读 ────────────────────
	{
		// 真路由：省得「面板 POST 的字段名」和「路由读的字段名」对不上时没人发现。
		let cfg = {
			qq: {}, bili: {}, masterQqUin: '10001',
			douyin: JSON.parse(JSON.stringify(douyinCfg))
		};
		const getConfig = () => cfg;
		const saveConfig = (patch) => { cfg = deepMerge(cfg, patch); };
		const social = make({ getConfig: () => cfg.douyin });
		const deps = {
			db,
			clock: { now: () => vt, getRoleDateParts: () => ({ dateStr: day }) },
			embedder: {}, worker: {},
			life: { browseState: () => ({ count: 0 }), stateSnapshot: () => ({ today: {} }) },
			getConfig, saveConfig, log: () => {},
			gateway: { workspacePath: () => '/ws', listWorkspaces: () => [], isPaused: () => false },
			channel: { status: () => ({ connected: true }), restart() {} },
			bili: { status: () => ({ loggedIn: false }), restart() {} },
			biliClient: null, browser: null, biliSocial: null,
			douyin: { status: () => ({ running: false }) },
			douyinHost: { browsers: [], status: () => ({ state: 'stopped' }) },
			douyinBrowser: null,
			douyinSocial: social
		};
		const mount = () => {
			let handler = null;
			registerRoutes({ effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } }, deps);
			return handler;
		};
		const call = async (path, method = 'POST', body = null) => {
			const handler = mount();
			let out = '';
			const req = new (await import('node:stream')).Readable({
				read() { this.push(body === null ? null : JSON.stringify(body)); if (body !== null) this.push(null); }
			});
			req.url = `/api/plugins/fish-soul${path}`;
			req.method = method;
			req.headers = {};
			const res = { writeHead: () => {}, end: (text) => { out = text; } };
			await handler(req, res);
			return JSON.parse(out);
		};

		// 总开关关着 → 拦
		cfg.douyin.enabled = false;
		let r = await call('/douyin/video-now');
		assert.equal(r.ok, false, '总开关关着不能发视频');
		assert.match(r.error, /总开关/);
		cfg.douyin.enabled = true;
		// 视频自己的开关关着 → 拦（看的是 video.enabled，不是 post.enabled）
		cfg.douyin.video.enabled = false;
		cfg.douyin.post.enabled = true;
		r = await call('/douyin/video-now');
		assert.equal(r.ok, false, '视频开关关着不能发视频');
		assert.match(r.error, /自己发视频/);
		cfg.douyin.video.enabled = true;

		// 开关都开着 → 真的走到视频发布
		day = '2026-11-13';
		resetCalls();
		r = await call('/douyin/video-now');
		assert.equal(r.ok, true, r.error);
		assert.equal(calls.prepareVideo, 1, '手动触发要走到视频发布');
		assert.equal(typeof r.text, 'string', '成功要回文案');

		// 配置块：存得进去、读得回来、不带字段不冲掉
		cfg.douyin.video = { enabled: false, provider: 'volc', baseURL: '', apiKey: '', model: '', durationSec: 5, aspectRatio: '9:16', resolution: '768P', perDay: 1 };
		r = await call('/channels/douyin-config', 'POST', { video: { enabled: true, perDay: 2, apiKey: 'sk-1', provider: 'minimax' } });
		assert.equal(r.ok, true, '视频配置要能存');
		assert.equal(cfg.douyin.video.enabled, true, '开关要落进配置');
		assert.equal(cfg.douyin.video.perDay, 2, '每天几条要落进配置');
		assert.equal(cfg.douyin.video.apiKey, 'sk-1', 'apiKey 要落进配置');
		assert.equal(cfg.douyin.video.provider, 'minimax', 'provider 要落进配置');
		await call('/channels/douyin-config', 'POST', { post: { enabled: true } });
		assert.equal(cfg.douyin.video.enabled, true, '不带 video 字段不能把已存的开关冲掉');
		assert.equal(cfg.douyin.video.apiKey, 'sk-1', '不带字段不能把 apiKey 冲掉');
		await call('/channels/douyin-config', 'POST', { video: { apiKey: '' } });
		assert.equal(cfg.douyin.video.apiKey, 'sk-1', 'apiKey 传空串不能冲掉（要清空走 clearApiKey）');
		await call('/channels/douyin-config', 'POST', { video: { clearApiKey: true } });
		assert.equal(cfg.douyin.video.apiKey, '', 'clearApiKey 才清空');
		const st = await call('/channels/state', 'GET');
		assert.equal(st.douyin.video.enabled, true, '回显要能读回来（读不回来 = 死输入框）');
		assert.equal(st.douyin.video.perDay, 2);
		assert.equal(st.douyin.video.provider, 'minimax');
		assert.equal(st.douyin.video.hasApiKey, false, 'apiKey 不回显，只给有没有配');
	}

	console.log('✓ 抖音视频触发链路：自走层能触发视频、图文与视频互不牵动、锁预算从转码预算推导、点发布前先持久化、手动触发路由、视频配置存得进读得回');
} finally {
	db.close();
}
