/**
 * routes-douyin.js —— 抖音设置页的路由（routes.js 转进来）：状态、保存设置、启动 / 关闭专用浏览器、
 * 登录用的截图 + 点击转发、页面自检、现在刷一下、窗口显示 / 藏起来。
 */
import { existsSync, statSync } from 'node:fs';
import { sharpReady } from './imageconv.js';

const NAME_MAX = 40;

/**
 * @param {object} deps
 * @param {import('./channels/douyin.js').DouyinChannel} deps.douyin
 * @param {import('./channels/douyin.js').DouyinHost} deps.douyinHost
 * @param {import('./douyin-browse.js').DouyinBrowser} deps.douyinBrowser
 */
export function douyinState({ getConfig, life, clock, douyin, douyinHost, douyinBrowser }) {
	const d = getConfig().douyin ?? {};
	const br = d.browse ?? {};
	let todayCount = 0;
	try { todayCount = life.browseState(clock.getRoleDateParts().dateStr, 'douyin').count; } catch { /* 无 */ }
	if (douyinHost && douyinHost.browsers === null) void douyinHost.rescan();
	return {
		enabled: d.enabled === true,
		autoReply: d.autoReply === true,
		masterName: d.masterName ?? '',
		allowList: Array.isArray(d.allowList) ? d.allowList : [],
		replyAll: d.replyAll === true,
		links: Array.isArray(d.links) ? d.links : [],
		browserPref: { kind: d.browser?.kind ?? 'edge', customPath: d.browser?.customPath ?? '' },
		window: d.window === 'visible' ? 'visible' : 'background',
		windowShown: douyinHost?.windowShown === true,
		browse: {
			enabled: br.enabled === true,
			perDay: br.perDay ?? 3,
			videosPerSession: br.videosPerSession ?? 3,
			like: br.like === true,
			todayCount,
			running: douyinBrowser?.running === true
		},
		host: douyinHost?.status() ?? { state: 'stopped' },
		channel: douyin?.status() ?? { running: false },
		recent: douyinBrowser?.recent(8) ?? [],
		sharp: sharpReady()
	};
}

const names = (list) => (Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean);

/** 处理 /channels/douyin-config 和 /douyin/*；不是抖音的路由返回 false。 */
export async function handleDouyinRoute({ method, path, req, send, readBody, sameOrigin, deps }) {
	const { getConfig, saveConfig, log, douyin, douyinHost, douyinBrowser } = deps;
	if (path !== '/channels/douyin-config' && !path.startsWith('/douyin/')) return false;
	if (method !== 'POST') { send(405, { ok: false, error: 'method not allowed' }); return true; }
	if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return true; }
	if (!douyin || !douyinHost) { send(200, { ok: false, error: '抖音模块没加载' }); return true; }
	const body = JSON.parse(await readBody(req) || '{}');
	const logger = log ?? (() => {});

	if (path === '/channels/douyin-config') {
		const cur = getConfig().douyin ?? {};
		const masterName = body.masterName === undefined ? String(cur.masterName ?? '') : String(body.masterName).trim();
		const allowList = body.allowList === undefined ? names(cur.allowList) : names(body.allowList);
		const links = body.links === undefined ? names(cur.links) : names(body.links);
		if ([masterName, ...allowList].some((n) => n.length > NAME_MAX)) { send(200, { ok: false, error: `名字最长 ${NAME_MAX} 个字` }); return true; }
		if (!links.every((x) => /^.{1,40}?\s*[=＝]\s*\d{5,12}$/.test(x))) { send(200, { ok: false, error: '对应关系每行写成「抖音名字=QQ号」' }); return true; }
		const cb = cur.browser ?? {};
		const b = body.browser ?? {};
		const customPath = b.customPath === undefined ? String(cb.customPath ?? '') : String(b.customPath).trim();
		if (customPath !== '') {
			let okPath = false;
			try { okPath = existsSync(customPath) && statSync(customPath).isFile(); } catch { okPath = false; }
			if (!okPath) { send(200, { ok: false, error: '这个浏览器路径不存在（要填到 .exe 本身）' }); return true; }
		}
		const kind = b.kind === undefined ? String(cb.kind ?? 'edge') : String(b.kind).trim();
		if (!/^[a-z0-9-]{1,30}$/.test(kind)) { send(200, { ok: false, error: '浏览器类型不对' }); return true; }
		const clamp = (v, def, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(v ?? def)) || 0));
		const br = body.browse ?? {};
		const cbr = cur.browse ?? {};
		const next = {
			enabled: body.enabled === undefined ? cur.enabled === true : body.enabled === true,
			autoReply: body.autoReply === undefined ? cur.autoReply === true : body.autoReply === true,
			masterName,
			allowList,
			replyAll: body.replyAll === undefined ? cur.replyAll === true : body.replyAll === true,
			links,
			browser: { kind, customPath },
			window: body.window === 'visible' || body.window === 'background' ? body.window : (cur.window === 'visible' ? 'visible' : 'background'),
			browse: {
				enabled: br.enabled === undefined ? cbr.enabled === true : br.enabled === true,
				perDay: clamp(br.perDay, cbr.perDay ?? 3, 0, 12),
				videosPerSession: clamp(br.videosPerSession, cbr.videosPerSession ?? 3, 1, 6),
				like: br.like === undefined ? cbr.like === true : br.like === true
			}
		};
		const wasOn = cur.enabled === true;
		const windowChanged = next.window !== (cur.window === 'visible' ? 'visible' : 'background');
		const browserChanged = kind !== String(cb.kind ?? 'edge') || customPath !== String(cb.customPath ?? '');
		saveConfig({ douyin: next });
		if (next.enabled && !wasOn) douyin.start();
		if (!next.enabled && wasOn) {
			douyin.stop();
			await douyinHost.quitBrowser();
		}
		// 换了窗口模式：正在跑的窗口马上挪（后台 = 停到屏幕外；正常显示 = 挪回屏幕里）
		if (windowChanged && douyinHost.running) {
			if (next.window === 'background') await douyinHost.hideWindow();
			else { await douyinHost.showWindow(); douyinHost.windowShown = false; }
		}
		// 换了浏览器：正在跑的关掉，换新的开（暂停中的不动，点「启动」时用新的）
		if (browserChanged && next.enabled && douyinHost.running) {
			await douyinHost.quitBrowser();
			void douyinHost.start();
		}
		send(200, { ok: true });
		return true;
	}
	if (path === '/douyin/browser/start') {
		if ((getConfig().douyin ?? {}).enabled !== true) { send(200, { ok: false, error: '先打开抖音总开关' }); return true; }
		const ok = await douyinHost.start({ resume: true });
		if (ok && !douyin.running) douyin.start();
		send(200, ok ? { ok: true } : { ok: false, error: douyinHost.lastError || '浏览器没启动起来' });
		return true;
	}
	if (path === '/douyin/browser/close') {
		await douyinHost.closeBrowser();
		send(200, { ok: true });
		return true;
	}
	// 后台模式下临时看一眼窗口 / 再藏起来
	if (path === '/douyin/window') {
		if (!douyinHost.running) { send(200, { ok: false, error: '浏览器没在运行' }); return true; }
		const ok = body.show === true ? await douyinHost.showWindow() : (await douyinHost.hideWindow(), true);
		send(200, ok ? { ok: true, windowShown: douyinHost.windowShown } : { ok: false, error: '窗口挪不动' });
		return true;
	}
	if (path === '/douyin/browser/rescan') {
		const list = await douyinHost.rescan();
		send(200, { ok: true, browsers: list.map((x) => ({ kind: x.kind, name: x.name, version: x.version, path: x.path })) });
		return true;
	}
	if (path === '/douyin/screenshot') {
		if (!douyinHost.running) { send(200, { ok: false, error: '浏览器没在运行' }); return true; }
		const shot = await douyinHost.screenshot();
		if (body.checkLogin === true) await douyinHost.checkLogin();
		send(200, shot === null ? { ok: false, error: '截不了图' } : {
			ok: true, image: `data:image/jpeg;base64,${shot.jpeg.toString('base64')}`, width: shot.width, height: shot.height, loggedIn: douyinHost.loggedIn
		});
		return true;
	}
	if (path === '/douyin/click') {
		const x = Number(body.x);
		const y = Number(body.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) { send(200, { ok: false, error: '坐标不对' }); return true; }
		send(200, { ok: await douyinHost.click(x, y) });
		return true;
	}
	if (path === '/douyin/self-check') {
		const r = await douyin.selfCheck().catch((error) => ({ ok: false, error: String(error instanceof Error ? error.message : error) }));
		send(200, { ok: true, report: r });
		return true;
	}
	if (path === '/douyin/browse-now') {
		if ((getConfig().douyin ?? {}).enabled !== true) { send(200, { ok: false, error: '先打开抖音总开关' }); return true; }
		if (!douyinBrowser || douyinBrowser.running) { send(200, { ok: false, error: '正在刷，稍等' }); return true; }
		if (!douyinBrowser.ready) { send(200, { ok: false, error: douyinHost.running ? '抖音还没登录' : '抖音浏览器没在运行' }); return true; }
		void douyinBrowser.run({}).catch((error) => logger('warn', `[fish-soul] 手动刷抖音失败：${String(error instanceof Error ? error.message : error)}`));
		send(200, { ok: true, started: true });
		return true;
	}
	send(404, { ok: false, error: 'not found' });
	return true;
}
