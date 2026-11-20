/**
 * routes-douyin.js —— 抖音设置页的路由（routes.js 转进来）：状态、保存设置、启动 / 关闭专用浏览器、
 * 登录用的截图 + 点击转发、页面自检、现在刷一下、窗口显示 / 藏起来。
 * ⚠️ 下面 handleDouyinRoute 里的 sameOrigin 总闸必须留在**前 80 行**内（check-route-guard.mjs 认这个窗口）。
 */
import { existsSync, statSync } from 'node:fs';
import { sharpReady } from './imageconv.js';
import { videoGenConfig } from './video-gen.js';
import { clampReplyWindow } from './gateway-util.js';

const NAME_MAX = 40;

/**
 * @param {object} deps
 * @param {import('./channels/douyin.js').DouyinChannel} deps.douyin
 * @param {import('./channels/douyin.js').DouyinHost} deps.douyinHost
 * @param {import('./douyin-browse.js').DouyinBrowser} deps.douyinBrowser
 */
export function douyinState({ getConfig, life, clock, douyin, douyinHost, douyinBrowser, douyinSocial }) {
	const d = getConfig().douyin ?? {};
	const br = d.browse ?? {};
	let todayCount = 0;
	try { todayCount = life.browseState(clock.getRoleDateParts().dateStr, 'douyin').count; } catch { /* 无 */ }
	if (douyinHost && douyinHost.browsers === null) void douyinHost.rescan();
	return {
		enabled: d.enabled === true,
		autoReply: d.autoReply === true,
		masterName: d.masterName ?? '',
		masterUid: d.masterUid ?? '',
		shareCard: d.shareCard === true,
		allowList: Array.isArray(d.allowList) ? d.allowList : [],
		replyAll: d.replyAll === true,
		replyWindowMinutes: clampReplyWindow(d.replyWindowMinutes),
		links: Array.isArray(d.links) ? d.links : [],
		groups: Array.isArray(d.groups) ? d.groups : [],
		groupReply: d.groupReply === true,
		callNames: Array.isArray(d.callNames) ? d.callNames : [],
		browserPref: { kind: d.browser?.kind ?? 'edge', customPath: d.browser?.customPath ?? '' },
		window: d.window === 'visible' ? 'visible' : 'background',
		windowShown: douyinHost?.windowShown === true,
		browse: {
			enabled: br.enabled === true,
			perDay: br.perDay ?? 3,
			videosPerSession: br.videosPerSession ?? 3,
			like: br.like === true,
			likeApi: br.likeApi === true,
			// 收藏 / 抽帧：界面开关要读得到，否则点完刷新又弹回去（「写进去但读不出来」那个形态）
			collect: br.collect === true,
			frames: br.frames === true,
			framesPerDay: br.framesPerDay ?? 6,
			share: br.share !== false,
			shareInDm: br.shareInDm !== false,
			// 回显：界面上的「刷抖音走接口」开关要读得到，否则点完刷新又弹回去
			mode: br.mode === 'browser' ? 'browser' : 'http',
			todayCount,
			running: douyinBrowser?.running === true
		},
		host: douyinHost?.status() ?? { state: 'stopped' },
		channel: douyin?.status() ?? { running: false },
		recent: douyinBrowser?.recent(8) ?? [],
		post: { enabled: d.post?.enabled === true, perDay: d.post?.perDay ?? 1 },
		// 视频块（面板在 PR3，但这块得能回显 —— 存进去读不回来 = 死输入框）。
		video: videoEcho(d),
		comments: { enabled: d.comments?.enabled === true, perHour: d.comments?.perHour ?? 4, emoji: d.comments?.emoji === true },
		social: douyinSocial?.status() ?? null,
		sharp: sharpReady()
	};
}

const names = (list) => (Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean);

/** 处理 /channels/douyin-config 和 /douyin/*；不是抖音的路由返回 false。 */
export async function handleDouyinRoute({ method, path, req, send, readBody, sameOrigin, deps }) {
	const { getConfig, saveConfig, log, douyin, douyinHost, douyinBrowser, douyinSocial, gateway } = deps;
	if (path !== '/channels/douyin-config' && !path.startsWith('/douyin/')) return false;
	if (method !== 'POST') { send(405, { ok: false, error: 'method not allowed' }); return true; }
	if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return true; }
	if (!douyin || !douyinHost) { send(200, { ok: false, error: '抖音模块没加载' }); return true; }
	const body = JSON.parse(await readBody(req) || '{}');
	const logger = log ?? (() => {});

	if (path === '/channels/douyin-config') {
		const cur = getConfig().douyin ?? {};
		const masterName = body.masterName === undefined ? String(cur.masterName ?? '') : String(body.masterName).trim();
		// 主人身份：只接受 `douyin:<数字 uid>`（会话身份）。留空 = 还没指定主人。
		// 昵称 masterName 不参与授权，所以这里必须单独填身份。
		// 🔴 兼容只填数字：用户从会话里拷来的 uid 就是纯数字，让 UI 逼着补前缀是反人类。
		//    填纯数字或 `douyin:<数字uid>` 都行，落库统一带前缀。
		//    ⚠️ 这里**不要**放具体数字做示例：抖音 uid 是 19 位、超过 Number.MAX_SAFE_INTEGER，
		//    一旦被 Number 转过一次，示例本身就带个截断后的假 uid，照抄就等于认错人。
		let masterUid = body.masterUid === undefined ? String(cur.masterUid ?? '') : String(body.masterUid).trim();
		if (masterUid !== '' && !/^douyin:\d+$/.test(masterUid)) {
			if (/^\d+$/.test(masterUid)) masterUid = `douyin:${masterUid}`;
			else { send(200, { ok: false, error: '主人身份填抖音的数字 uid 就行（纯数字，或带 douyin: 前缀）' }); return true; }
		}
		const allowList = body.allowList === undefined ? names(cur.allowList) : names(body.allowList);
		const links = body.links === undefined ? names(cur.links) : names(body.links);
		const groups = body.groups === undefined ? names(cur.groups) : names(body.groups);
		const callNames = body.callNames === undefined ? names(cur.callNames) : names(body.callNames);
		if ([masterName, ...allowList, ...groups, ...callNames].some((n) => n.length > NAME_MAX)) { send(200, { ok: false, error: `名字最长 ${NAME_MAX} 个字` }); return true; }
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
		const bv = body.video ?? {};
		const cv = cur.video ?? {};
		const next = {
			enabled: body.enabled === undefined ? cur.enabled === true : body.enabled === true,
			autoReply: body.autoReply === undefined ? cur.autoReply === true : body.autoReply === true,
			masterName,
			masterUid,
			// 原生视频卡片分享（默认关）：走页面里的「分享给朋友」面板发原生卡片，不发链接
			shareCard: body.shareCard === undefined ? cur.shareCard === true : body.shareCard === true,
			allowList,
			replyAll: body.replyAll === undefined ? cur.replyAll === true : body.replyAll === true,
			// 超过多久的旧消息只记不回（分钟）。1~1440：0 会让窗口变成 0ms，全算旧消息。
			replyWindowMinutes: clampReplyWindow(body.replyWindowMinutes ?? cur.replyWindowMinutes),
			links,
			groups,
			groupReply: body.groupReply === undefined ? cur.groupReply === true : body.groupReply === true,
			callNames,
			browser: { kind, customPath },
			window: body.window === 'visible' || body.window === 'background' ? body.window : (cur.window === 'visible' ? 'visible' : 'background'),
			browse: {
				enabled: br.enabled === undefined ? cbr.enabled === true : br.enabled === true,
				perDay: clamp(br.perDay, cbr.perDay ?? 3, 0, 12),
				videosPerSession: clamp(br.videosPerSession, cbr.videosPerSession ?? 3, 1, 6),
				like: br.like === undefined ? cbr.like === true : br.like === true,
				likeApi: br.likeApi === undefined ? cbr.likeApi === true : br.likeApi === true,
				collect: br.collect === undefined ? cbr.collect === true : br.collect === true,
				frames: br.frames === undefined ? cbr.frames === true : br.frames === true,
				framesPerDay: clamp(br.framesPerDay, cbr.framesPerDay ?? 6, 0, 20),
				share: br.share === undefined ? cbr.share !== false : br.share === true,
				shareInDm: br.shareInDm === undefined ? cbr.shareInDm !== false : br.shareInDm === true,
				// 刷抖音走哪条路：'http' = 纯 HTTP（不开浏览器）；'browser' = 专用浏览器里滑推荐页
				mode: br.mode === undefined ? (cbr.mode === 'browser' ? 'browser' : 'http') : (br.mode === 'browser' ? 'browser' : 'http')
			},
			post: {
				enabled: body.post?.enabled === undefined ? cur.post?.enabled === true : body.post.enabled === true,
				perDay: clamp(body.post?.perDay, cur.post?.perDay ?? 1, 0, 5)
			},
			// 视频块（面板在 PR3，但这块得先能存 —— 否则 provider / apiKey 没地方配，视频永远发不出去）。
			// 「不带字段不冲掉」：body 没带的字段沿用当前值。
			video: {
				enabled: bv.enabled === undefined ? cv.enabled === true : bv.enabled === true,
				provider: bv.provider === undefined ? String(cv.provider ?? 'volc') : String(bv.provider).trim(),
				baseURL: bv.baseURL === undefined ? String(cv.baseURL ?? '') : String(bv.baseURL).trim(),
				// apiKey：空串**也是不冲掉**（和 routes.js 里 accessToken 一样「非空才写」），要清空走 clearApiKey
				apiKey: bv.clearApiKey === true ? '' : (bv.apiKey === undefined || String(bv.apiKey).trim() === '' ? String(cv.apiKey ?? '') : String(bv.apiKey).trim()),
				model: bv.model === undefined ? String(cv.model ?? '') : String(bv.model).trim(),
				durationSec: clamp(bv.durationSec, cv.durationSec ?? 5, 4, 15),
				aspectRatio: bv.aspectRatio === undefined ? String(cv.aspectRatio ?? '9:16') : String(bv.aspectRatio).trim(),
				resolution: bv.resolution === undefined ? String(cv.resolution ?? '768P') : String(bv.resolution).trim(),
				perDay: clamp(bv.perDay, cv.perDay ?? 1, 0, 5)
			},
			comments: {
				enabled: body.comments?.enabled === undefined ? cur.comments?.enabled === true : body.comments.enabled === true,
				perHour: clamp(body.comments?.perHour, cur.comments?.perHour ?? 4, 0, 30),
				emoji: body.comments?.emoji === undefined ? cur.comments?.emoji === true : body.comments.emoji === true
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
	// ── 待确认的抖音身份（昵称配了、uid 拿得到但还没绑）──────────────
	//
	// 这些挂在{douyinUinOf}（不是 DouyinChannel）——身份合并是网关层的事。
	if (path === '/douyin/uin-candidates') {
		send(200, { ok: true, candidates: gateway?.douyinUinCandidates?.() ?? [] });
		return true;
	}
	if (path === '/douyin/uin-confirm') {
		const r = gateway?.confirmDouyinUin?.(body.name);
		send(200, r ?? { ok: false, error: '抖音模块没加载' });
		return true;
	}
	if (path === '/douyin/uin-dismiss') {
		const r = gateway?.dismissDouyinUinCandidate?.(body.name);
		send(200, r ?? { ok: false, error: '抖音模块没加载' });
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
	if (path === '/douyin/inbox-gap-ack') {
		// 不带 id = 一次把全部未确认的缺口提示标成已知晓
		if (body.id === undefined || body.id === null) { douyin.inbox.acknowledgeAllGaps(); send(200, { ok: true }); return true; }
		const id = Number(body.id);
		const ok = Number.isSafeInteger(id) && id > 0 && douyin.inbox.acknowledgeGap(id);
		send(200, ok ? { ok: true } : { ok: false, error: '提示不存在或已处理' }); return true;
	}
	// 一条 unknown 会挡住同会话后面所有待处理消息；身份暂停期间又不能重试，
	// 所以必须给一个「我核实过了，全部忽略」的出口，否则队列永远走不动。
	if (path === '/douyin/inbox-dismiss-all') {
		const n = douyin.inbox.dismissAllUnknown();
		send(200, { ok: true, dismissed: n }); return true;
	}
	// 对无法确认的入站消息，只允许用户核实后选择重试或忽略；重试由下次轮询处理。
	if (path === '/douyin/inbox-resolve') {
		const id = Number(body.id);
		if (!Number.isSafeInteger(id) || id <= 0 || !['retry', 'dismiss'].includes(body.action)) { send(200, { ok: false, error: '参数不正确' }); return true; }
		if (body.action === 'retry' && douyin.status().identityBlocked) { send(200, { ok: false, error: '抖音身份尚未验证，暂不能重试' }); return true; }
		const ok = douyin.inbox.resolve(id, body.action);
		send(200, ok ? { ok: true } : { ok: false, error: '消息已处理或不存在' }); return true;
	}
	// 用户先到创作者中心核实；只记录其选择，绝不由此触发发布。
	if (path === '/douyin/post-resolve') {
		if (!douyinSocial) { send(200, { ok: false, error: '抖音模块没加载' }); return true; }
		const r = douyinSocial.resolvePost(body.jobId, body.outcome);
		send(200, r); return true;
	}
	// v0.10：现在发一条视频作品（生成 → 传片 → 发布；生成要花钱，比图文慢得多）
	if (path === '/douyin/video-now') {
		if ((getConfig().douyin ?? {}).enabled !== true) { send(200, { ok: false, error: '先打开抖音总开关' }); return true; }
		if (!douyinSocial) { send(200, { ok: false, error: '抖音模块没加载' }); return true; }
		// 视频自己的开关（不是图文的那个）
		if (!douyinSocial.cfg().video.enabled) { send(200, { ok: false, error: '先打开「自己发视频」' }); return true; }
		// ⚠️ force 只跳「次数和间隔」，跳不掉每天的条数上限 —— 视频生成是花钱的，
		//    手动点也得受每天上限保护（见 douyin-social.js 的 publishVideoWork）。
		const r = await douyinSocial.post({ force: true, kind: 'video' });
		send(200, r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error ?? '没发成' });
		return true;
	}
	// v0.10：现在发一条图文 / 现在看一眼评论（都要等浏览器跑完，可能要一两分钟）
	if (path === '/douyin/post-now' || path === '/douyin/comments-now') {
		if ((getConfig().douyin ?? {}).enabled !== true) { send(200, { ok: false, error: '先打开抖音总开关' }); return true; }
		if (!douyinSocial) { send(200, { ok: false, error: '抖音模块没加载' }); return true; }
		if (path === '/douyin/post-now') {
			if (!douyinSocial.cfg().post.enabled) { send(200, { ok: false, error: '先打开「自己发图文」' }); return true; }
			const r = await douyinSocial.post({ force: true });
			send(200, r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error ?? '没发成' });
			return true;
		}
		if (!douyinSocial.cfg().comments.enabled) { send(200, { ok: false, error: '先打开「回评论」' }); return true; }
		const r = await douyinSocial.pollComments();
		send(200, r.ok ? { ok: true, replied: r.replied, skipped: r.skipped } : { ok: false, error: r.error ?? '没看成' });
		return true;
	}
	send(404, { ok: false, error: 'not found' });
	return true;
}

/**
 * 视频配置块的回显（面板在 PR3，但这块得能读回来 —— 存进去读不回来 = 死输入框）。
 * apiKey 不回显，只给「有没有配」。
 *
 * ⚠️ 这个函数放在文件**末尾**是故意的：文件顶部的 sameOrigin 总闸只能占前 80 行，
 *    回显块若写进 douyinState 会把它挤出窗口（CSRF 检查会误报）。
 */
function videoEcho(d) {
	// 用 videoGenConfig 归一过再回显：面板上显示的得是**实际生效**的值
	// （存了 provider:'' 生效的是 volc，显示 '' 会让人以为没生效）。
	const v = videoGenConfig(d.video ?? {});
	return {
		enabled: d.video?.enabled === true,
		perDay: v.perDay,
		provider: v.provider,
		baseURL: v.baseURL,
		model: v.model,
		durationSec: v.durationSec,
		aspectRatio: v.aspectRatio,
		resolution: v.resolution,
		hasApiKey: Boolean(d.video?.apiKey)
	};
}
