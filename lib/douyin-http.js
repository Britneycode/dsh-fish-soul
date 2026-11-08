/**
 * douyin-http.js —— 抖音网页端的纯 HTTP 客户端（不开浏览器）。
 *
 * 三件事，别的模块都靠它：
 *  1. **登录态**：cookie 落盘在 ~/.dsh/fish-soul/douyin-cookie.json；没有就从**正在跑的抖音浏览器**
 *     用 CDP `Network.getCookies` 抓一次明文（Chrome 的 Cookies 文件是 DPAPI+AES 加密的，
 *     浏览器开着时还锁着文件，copy 不了 —— 只能走 CDP）。抓完落盘，之后浏览器可以关。
 *  2. **签名**：两道，都能本地算：
 *     - `x-secsdk-web-signature` = md5(`${uifid}_${timestamp}_${SALT}_${query}`)
 *       （SALT 是 project 34 = douyin_web 的常量；uifid 取自 cookie，名字是**大写** UIFID / UIFID_TEMP）
 *       —— tab/feed、aweme/detail 这类端点只要这一道。
 *     - `a_bogus`（SM3+RC4，见 vendor/douyin-bogus.js）—— comment/* 这类端点还要它，
 *       光有 secsdk 签名会返回 0 字节 / status_code 8。
 *  3. **公共参数**：网页端那组 device_platform/aid/channel/version_code/… **是整体校验的**，
 *     少一个就报「参数不合法」——整组照抄（来源：douyin-cli 油猴脚本的公共参数块）。
 *
 * 实测（2026-11-08 真机）：tab/feed → 200/status_code 0/12 条；aweme/detail → 200/84KB；
 * comment/list → 0 字节（缺 a_bogus）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dshHome } from './db.js';
import { join } from 'node:path';
import { generateABogus } from './vendor/douyin-bogus.js';
import { sessionHealth } from './session-health.js';

export const DOUYIN_WEB_ORIGIN = 'https://www.douyin.com';

/** x-secsdk-web-signature 的盐（project 34 = douyin_web）。抖音换 project id 就得换这个值。 */
export const SECSDK_SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E';

/** cookie 里 uifid 的可能名字。**注意实际是大写**（UIFID / UIFID_TEMP）。 */
export const UIFID_COOKIE_NAMES = ['uifid', 'uifid_temp', 'uifidtemp', 'UIFID', 'UIFID_TEMP', 'UIFIDTEMP'];

export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/** 屏指纹：a_bogus 会把它编进签名，必须和 User-Agent 对得上（Win 就用 Windows 那组）。 */
export const WIN_SCREEN_FINGERPRINT = '1920|366|1918|1048|1920|1050|1920|1080|Win32';

/**
 * 网页端公共参数（整体校验，少一个就「参数不合法」）。
 * @param {{width?: number, height?: number, chromeVersion?: string}} [opts]
 * @returns {Array<[string, string]>}
 */
export function douyinBaseParams(opts = {}) {
	const chromeVer = opts.chromeVersion ?? '156.0.0.0';
	return [
		['device_platform', 'webapp'],
		['aid', '6383'],
		['channel', 'channel_pc_web'],
		['pc_client_type', '1'],
		['pc_libra_divert', 'Windows'],
		['update_version_code', '170400'],
		['support_h265', '1'],
		['support_dash', '1'],
		['version_code', '170400'],
		['version_name', '17.4.0'],
		['cookie_enabled', 'true'],
		['screen_width', String(opts.width ?? 1536)],
		['screen_height', String(opts.height ?? 864)],
		['browser_language', 'zh-CN'],
		['browser_platform', 'Win32'],
		['browser_name', 'Chrome'],
		['browser_version', chromeVer],
		['browser_online', 'true'],
		['engine_name', 'Blink'],
		['engine_version', chromeVer],
		['os_name', 'Windows'],
		['os_version', '10'],
		['cpu_core_num', '12'],
		['device_memory', '16'],
		['platform', 'PC'],
		['downlink', '10'],
		['effective_type', '4g'],
		['round_trip_time', '100'],
	];
}

/** 秒级时间戳（签名里用）。 */
export const nowStamp = () => String(Math.floor(Date.now() / 1000));

/**
 * 算 x-secsdk-web-signature。
 * @param {{uifid: string, stamp: string, query: string}} args
 * @returns {string} 32 位小写 hex
 */
export function secsdkSignature({ uifid, stamp, query }) {
	return createHash('md5').update(`${uifid}_${stamp}_${SECSDK_SALT}_${query}`).digest('hex');
}

/**
 * 算 a_bogus（comment/* 这类端点要）。
 * @param {{query: string, body?: string, userAgent?: string, screenFingerprint?: string}} args
 * @returns {string}
 */
export function aBogusSignature({ query, body = '', userAgent = CHROME_UA, screenFingerprint = WIN_SCREEN_FINGERPRINT }) {
	return generateABogus({ query, body, userAgent, screenFingerprint });
}

/** cookie 文件位置（和插件其它数据放一起，不进仓库；跟着 DSH_HOME 走，测试才能隔离）。 */
export function douyinCookiePath() {
	return join(dshHome(), 'fish-soul', 'douyin-cookie.json');
}

/**
 * 从落盘的 cookie 文件里读登录态还剩多久（**只读文件，不联网、不抓浏览器**）。
 *
 * 为什么单独开一个：诊断页每 10 秒轮询一次，不能为了看一眼过期时间去连 CDP。
 * 文件里有 `sid_guard` 就够了 —— 它自带签发时间和有效期。
 *
 * @returns {{remainingSec: number, expiresAt: number} | null}
 *          没登录 / 没这个文件 / 没有 sid_guard 都返回 null（诊断页照常显示其它项）
 */
export function douyinSessionHealth() {
	try {
		const p = douyinCookiePath();
		if (!existsSync(p)) return null;
		const data = JSON.parse(readFileSync(p, 'utf8'));
		return sessionHealth(data?.cookies ?? null);
	} catch {
		return null;
	}
}

/**
 * 抖音网页端的纯 HTTP 客户端。
 */
export class DouyinHttp {
	/**
	 * @param {object} deps
	 * @param {() => object} [deps.getConfig] config.douyin（取 browserPort 之类）
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {number} [deps.cdpPort] 抖音浏览器的 CDP 端口（默认 47890）
	 * @param {typeof fetch} [deps.fetchImpl]
	 */
	constructor({ getConfig, log, cdpPort = 47890, fetchImpl } = {}) {
		this.getConfig = getConfig ?? (() => ({}));
		this.log = log ?? (() => {});
		this.cdpPort = cdpPort;
		this.fetch = fetchImpl ?? ((...a) => fetch(...a));
		/** @type {Map<string,string>} name → value（同名取第一个） */
		this.jar = new Map();
		this.loaded = false;
		this.lastError = '';
		// 构造时就读一次落盘的 cookie：这样 isLoggedIn() 立刻准（路由层是同步判断）
		this.loadCookies();
	}

	/** cookie 落盘路径。 */
	cookiePath() {
		return douyinCookiePath();
	}

	/** 从磁盘读 cookie（落盘过一次就用它，浏览器可以关）。 */
	loadCookies() {
		const p = this.cookiePath();
		if (!existsSync(p)) return false;
		try {
			const raw = JSON.parse(readFileSync(p, 'utf8'));
			const map = raw?.cookies ?? {};
			this.jar = new Map(Object.entries(map).filter(([, v]) => typeof v === 'string' && v !== ''));
			this.loaded = this.jar.size > 0;
			return this.loaded;
		} catch (error) {
			this.lastError = `cookie 文件读不了：${error instanceof Error ? error.message : error}`;
			return false;
		}
	}

	/** 把 cookie 落盘（本地目录，不进仓库；含登录态，权限设 0600）。 */
	saveCookies() {
		try {
			const p = this.cookiePath();
			mkdirSync(join(p, '..'), { recursive: true });
			writeFileSync(p, JSON.stringify({ savedAt: Date.now(), cookies: Object.fromEntries(this.jar) }), { mode: 0o600 });
			return true;
		} catch (error) {
			this.lastError = `cookie 存不了：${error instanceof Error ? error.message : error}`;
			return false;
		}
	}

	/**
	 * 从正在跑的抖音浏览器 CDP 抓一次明文 cookie（只读）。
	 * Chrome 的 Cookies 文件是 DPAPI+AES 加密的，浏览器开着时还锁着 —— 只能走 CDP。
	 * @returns {Promise<boolean>} 有没有抓到
	 */
	async captureFromBrowser() {
		if (!(this.cdpPort > 0)) {
			this.lastError = '没配 CDP 端口，抓不了 cookie';
			return false;
		}
		try {
			const listRes = await this.fetch(`http://127.0.0.1:${this.cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) });
			const targets = await listRes.json();
			const page = targets.find((t) => t.type === 'page' && String(t.url).includes('douyin.com'));
			if (page === undefined) {
				this.lastError = `CDP ${this.cdpPort} 上没有抖音页面`;
				return false;
			}
			const cookies = await new Promise((resolve, reject) => {
				const ws = new WebSocket(page.webSocketDebuggerUrl);
				const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 超时')); }, 10_000);
				ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: ['https://www.douyin.com/'] } })));
				ws.addEventListener('message', (ev) => {
					const msg = JSON.parse(String(ev.data));
					if (msg.id !== 1) return;
					clearTimeout(timer);
					ws.close();
					if (msg.error) { reject(new Error(`CDP 报错：${JSON.stringify(msg.error)}`)); return; }
					resolve(msg.result?.cookies ?? []);
				});
				ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`WS 出错：${e.message ?? e}`)); });
			});
			const jar = new Map();
			for (const c of cookies) {
				if (!String(c.domain ?? '').includes('douyin.com')) continue;
				if (!jar.has(c.name)) jar.set(c.name, String(c.value ?? '')); // 同名取第一个
			}
			if (jar.size === 0) {
				this.lastError = 'CDP 拿到的 cookie 是空的';
				return false;
			}
			this.jar = jar;
			this.loaded = true;
			this.saveCookies();
			return true;
		} catch (error) {
			this.lastError = `从浏览器抓 cookie 失败：${error instanceof Error ? error.message : error}`;
			return false;
		}
	}

	/** 有 cookie 就用；没有就先去浏览器抓一次（抓不到就返回 false）。 */
	async ensureCookies() {
		if (this.loaded && this.jar.size > 0) return true;
		if (this.loadCookies()) return true;
		return this.captureFromBrowser();
	}

	/** 登录态：有没有 sessionid。 */
	isLoggedIn() {
		return (this.jar.get('sessionid') ?? '') !== '' || (this.jar.get('sessionid_ss') ?? '') !== '';
	}

	/** uifid（secsdk 签名要用；cookie 里是大写名字）。 */
	uifid() {
		for (const n of UIFID_COOKIE_NAMES) {
			const v = this.jar.get(n);
			if (v !== undefined && v !== '') return v;
		}
		return '';
	}

	/** Cookie 头。 */
	cookieHeader() {
		return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	/**
	 * 发一个网页端请求（GET / POST）。
	 * @param {object} args
	 * @param {string} args.path 例如 '/aweme/v1/web/tab/feed/'
	 * @param {Array<[string,string]>} [args.params] 端点自己的参数
	 * @param {string} [args.body] POST 的表单体（会自动算 a_bogus 的 body 摘要）
	 * @param {boolean} [args.aBogus] 是否要 a_bogus（comment/* 要）
	 * @param {boolean} [args.post] 用 POST
	 * @param {string} [args.referer]
	 * @returns {Promise<{status: number, ok: boolean, json: any, text: string}>}
	 */
	async request({ path, params = [], body = '', aBogus = false, aBogusScope = 'full', post = false, referer = `${DOUYIN_WEB_ORIGIN}/`, timeoutMs = 20_000 }) {
		if (!(await this.ensureCookies())) {
			return { status: 0, ok: false, json: null, text: '', error: this.lastError || '没有抖音登录态' };
		}
		const stamp = nowStamp();
		const uifid = this.uifid();
		const pairs = [...douyinBaseParams(), ...params];
		if (uifid !== '') pairs.push(['uifid', uifid]);
		pairs.push(['timestamp', stamp]);
		const query = new URLSearchParams(pairs).toString();
		const headers = {
			'User-Agent': CHROME_UA,
			Referer: referer,
			Accept: 'application/json, text/plain, */*',
			...(uifid !== '' ? { uifid } : {}),
			'x-secsdk-web-expire': stamp,
			Cookie: this.cookieHeader(),
		};
		let url = `${DOUYIN_WEB_ORIGIN}${path}?${query}&x-secsdk-web-signature=${secsdkSignature({ uifid, stamp, query })}`;
		if (aBogus) {
			// ⚠️ 不同端点要的 a_bogus preimage 不一样（抖音网页端不同接口用不同版本的 a_bogus）：
			//   'full'    = 完整 query（含公共参数）—— comment/list 用这个；
			//   'business'= 只有业务参数 —— commit/*（点赞等）用这个，含公共参数会被拒（403 Sign Invalid）。
			const preimage = aBogusScope === 'business' ? new URLSearchParams(params).toString() : query;
			const ab = aBogusSignature({ query: preimage, body });
			url += `&a_bogus=${encodeURIComponent(ab)}`;
			headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
		}
		const init = { method: post ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(timeoutMs) };
		if (post) init.body = body;
		let res;
		try {
			res = await this.fetch(url, init);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastError = message;
			return { status: 0, ok: false, json: null, text: '', error: message };
		}
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* 不是 JSON 就原样返回 */ }
		return { status: res.status, ok: res.ok, json, text, url };
	}

	/** 首页推荐流。实测每次请求都是全新的一批（0 条重复），所以要更多就多请求几次。 */
	async feed(count = 12) {
		const r = await this.request({ path: '/aweme/v1/web/tab/feed/', params: [['count', String(count)], ['refresh_index', '1'], ['video_type_select', '1'], ['aweme_type', '0'], ['disable_group_auto_play', '1'], ['is_home_taken_down', 'false'], ['need_time_list', '0']] });
		const list = r.json?.aweme_list ?? r.json?.data?.aweme_list ?? [];
		return { ok: r.ok && Array.isArray(list) && list.length > 0, list, raw: r };
	}

	/** 单个视频详情（要 a_bogus 的端点用 aBogus: true）。 */
	async detail(awemeId) {
		const r = await this.request({ path: '/aweme/v1/web/aweme/detail/', params: [['aweme_id', String(awemeId)]] });
		const d = r.json?.aweme_detail ?? r.json?.data?.aweme_detail ?? null;
		return { ok: r.ok && d !== null, detail: d, raw: r };
	}

	/** 评论列表（**要 a_bogus**，否则返回 0 字节）。 */
	async comments(awemeId, { cursor = '0', count = 20 } = {}) {
		const r = await this.request({
			path: '/aweme/v1/web/comment/list/',
			params: [['aweme_id', String(awemeId)], ['cursor', String(cursor)], ['count', String(count)], ['item_type', '0'], ['insert_ids', '']],
			aBogus: true,
		});
		const list = r.json?.comments ?? r.json?.data?.comments ?? [];
		return { ok: r.ok && Array.isArray(list) && list.length > 0, list, raw: r };
	}

	/**
	 * 点赞（写操作）。
	 *
	 * ⚠️ 两处和读接口不一样：
	 *  - **a_bogus 的 preimage 只含业务参数**（含公共参数会被拒：403 Sign Invalid）；
	 *  - 必须 POST，body 是业务参数的表单。
	 *
	 * 抖音对写接口一律要求有效登录态：登录态没了会回 `status_code: 8`（文案是「用户未登录」）。
	 * 那不是签名错 —— 签名错是 403。
	 *
	 * @param {string} awemeId
	 * @param {{diggType?: 1|0}} opts diggType=1 点赞、=0 取消
	 */
	async digg(awemeId, { diggType = 1 } = {}) {
		const pairs = [['aweme_id', String(awemeId)], ['digg_type', String(diggType)]];
		const body = new URLSearchParams(pairs).toString();
		const r = await this.request({
			path: '/aweme/v1/web/commit/item/digg/',
			params: pairs,
			body,
			aBogus: true,
			aBogusScope: 'business',
			post: true,
			referer: `${DOUYIN_WEB_ORIGIN}/video/${awemeId}`,
		});
		const code = r.json?.status_code;
		return {
			ok: r.ok && code === 0,
			statusCode: code ?? null,
			statusMsg: String(r.json?.status_msg ?? r.error ?? ''),
			raw: r,
		};
	}

	/**
	 * 收藏 / 取消收藏（纯 HTTP 版）。
	 *
	 * ⚠️ 端点是 aweme/collect（完整路径见下面的 path），不是 commit/collect —— 后者
	 * 会回「404 Unsupported path(Janus)」，2026-11-08 实测。而且必须带完整公共参数。
	 *
	 * 纯 Node 这条路要 msToken（页面里发不需要，secSDK 自己补），所以它排在
	 * 页面桥之后当兜底 —— 见 douyin-browse 的 httpWatch。
	 */
	async collect(awemeId, { collect = true } = {}) {
		const pairs = [['aweme_id', String(awemeId)], ['action', collect ? '1' : '0']];
		const body = new URLSearchParams(pairs).toString();
		const r = await this.request({
			path: '/aweme/v1/web/aweme/collect/',
			params: pairs,
			body,
			aBogus: true,
			aBogusScope: 'business',
			post: true,
			referer: `${DOUYIN_WEB_ORIGIN}/video/${awemeId}`,
		});
		const code = r.json?.status_code;
		return {
			ok: r.ok && code === 0,
			statusCode: code ?? null,
			statusMsg: String(r.json?.status_msg ?? r.error ?? ''),
			raw: r,
		};
	}
}
