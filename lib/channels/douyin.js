/**
 * douyin.js —— 抖音小号：专用浏览器（Edge / Chrome …，CDP 控制）+ 网页版私信渠道。
 *
 *  - 浏览器用插件自己的 profile（$DSH_HOME/fish-soul/douyin-browser/<浏览器>），和你平时用的浏览器互不影响；
 *    登录就在这个窗口里扫码，登录态留在 profile 里；
 *  - 你自己把窗口 / 标签页关了 = 暂停（不会自己再弹出来），设置页点「启动」才恢复；
 *    浏览器崩了会自动重连，最多 3 次（每次间隔 30 秒），再不行就停下等你点；
 *  - 私信没有推送：每 30–60 秒（随机）看一眼会话列表，有未读 / 有变化的会话进去读最近 20 条，
 *    和上次读到的窗口对比，只把新消息交给网关；第一次见到的会话只记基线（有未读的话补最后几条）；
 *  - 认人只能靠会话里显示的名字（网页版拿不到抖音号）；进会话读消息会把消息标成已读；
 *  - 页面结构自检（canary）：启动时 / 每 6 小时 / 连续失败 3 次后跑一遍，抖音改版认不出页面时
 *    先停掉自动回复，设置页标红，并在 QQ 上提醒主人一次。
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fishSoulDir, getKv, setKv } from '../db.js';
import { BROWSER_KINDS, detectBrowsers, pickBrowser } from '../browsers.js';
import { getBrowser } from './vendor/douyin-bridge/browser.mjs';
import { HOOK_SOURCE, setCacheFile, startCollector } from './vendor/douyin-bridge/douyin-api.mjs';
import { checkLogin, dmList, readDM, sendDM, sendEmoji, sendImage } from './vendor/douyin-bridge/douyin-dm.mjs';
import { canary } from './vendor/douyin-bridge/selectors.mjs';
import { PARK_LEFT, parkWindow, showWindow } from './vendor/douyin-bridge/douyin-panel.mjs';
import { parseTime } from './vendor/douyin-bridge/douyin-util.mjs';

export const DOUYIN_HOME = 'https://www.douyin.com/';
const DEFAULT_PORT = 47890;
const CRASH_RETRY_MS = 30_000;
const CRASH_MAX = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const LOCK_MAX_MS = 4 * 60_000;
const POLL_TIMEOUT_MS = 3 * 60_000;
const CANARY_EVERY_MS = 6 * 3600_000;
const READ_LIMIT = 20;
const MAX_READS_PER_POLL = 5;
const RECENT_MS = 15 * 60_000;
const WINDOW_KEEP = 30;
const INJECT_ON_FIRST_READ = 3;

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const errText = (e) => String(e instanceof Error ? e.message : e);
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

/** 会话列表里的时间（"03:27" / "5分钟前" / "昨天" / "10月16日"）→ 毫秒，认不出返回 0。 */
export function convTimeMs(s, now = new Date()) {
	const t = String(s ?? '').trim();
	const m = /^(\d{1,2}):(\d{2})$/.exec(t);
	if (m) {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]));
		if (d.getTime() > now.getTime() + 60_000) d.setDate(d.getDate() - 1);
		return d.getTime();
	}
	return Date.parse(parseTime(t, now) || '') || 0;
}

/** 抖音私信里一条消息的指纹（对比窗口用）：谁发的 + 正文 + 媒体（图片地址去掉会变的签名参数）。 */
export function messageFingerprint(m) {
	const media = m?.media ?? {};
	let src = String(media.data || media.src || '');
	if (src.startsWith('data:')) src = sha1(src).slice(0, 16);
	else {
		const i = src.indexOf('/obj/');
		src = (i >= 0 ? src.slice(i) : src).split('?')[0].slice(-60);
	}
	return sha1([m?.fromMe ? 'me' : 'peer', String(m?.text ?? '').trim().slice(0, 120), m?.type ?? '', src, media.name ?? '', m?.shareAweme ?? ''].join('|')).slice(0, 16);
}

/**
 * 这次读到的消息（旧 → 新）里，哪些是上次窗口之后新来的。
 * 对齐办法：在这次的列表里找上次窗口最后几条（最多 3 条）连续出现的位置，之后的就是新的；
 * 对不上（中间来了 20 条以上，窗口整个滚走了）就把末尾不在上次窗口里的那一段当新的（调用方再限条数）。
 * @param {string[]} prev 上次的指纹窗口
 * @param {string[]} cur 这次的指纹
 * @returns {number} 新消息从 cur 的哪个下标开始（cur.length = 没有新消息）
 */
export function newFrom(prev, cur) {
	if (!Array.isArray(prev) || prev.length === 0) return 0;
	const tail = prev.slice(-3);
	for (let L = tail.length; L >= 1; L--) {
		const want = tail.slice(-L);
		for (let j = cur.length - 1; j >= L - 1; j--) {
			let ok = true;
			for (let k = 0; k < L; k++) if (cur[j - k] !== want[want.length - 1 - k]) { ok = false; break; }
			if (ok) return j + 1;
		}
	}
	const known = new Set(prev);
	const i = cur.findIndex((h, idx) => !known.has(h) && cur.slice(idx).every((x) => !known.has(x)));
	return i < 0 ? cur.length : i;
}

/**
 * 每个指纹在列表里是第几次出现（从 0 数）：['a','b','a','a'] → [0,0,1,2]。
 * 拼进没有 seq 的 messageId，让连发的同一句话 ID 不同（否则网关按 ID 去重会吞掉后几条）。
 * @param {string[]} prints
 * @returns {number[]}
 */
export function occurrenceIndexes(prints) {
	const seen = new Map();
	return (prints ?? []).map((p) => {
		const n = seen.get(p) ?? 0;
		seen.set(p, n + 1);
		return n;
	});
}

/** 一条抖音私信 → 入站消息（与 QQ 的 normalizeMessageEvent 同形）。不该当消息的返回 null。 */
export function normalizeDouyinMessage(m, { name, timeMs, messageId }) {
	if (!m || m.fromMe || m.system || m.unsupported) return null;
	const media = m.media ?? {};
	const images = [];
	const links = [];
	let text = String(m.text ?? '').trim();
	if (m.type === 'image') {
		const src = String(media.data || media.src || '');
		if (src) images.push({ url: src });
		text = '【图片】';
	} else if (m.type === 'emoji') {
		const n = String(media.name ?? '').trim();
		if (n) text = `[${n}]`;
		else {
			text = '【表情】';
			const src = String(media.data || '');
			if (src) images.push({ url: src });
		}
	} else if (m.type === 'voice') {
		text = `【语音${media.seconds ? ` ${media.seconds} 秒` : ''}（听不了）】`;
	} else {
		text = text.replace(/【/g, '〔').replace(/】/g, '〕');
	}
	if (m.shareAweme) {
		links.push(`https://www.douyin.com/video/${m.shareAweme}`);
		if (!/分享/.test(text)) text = `【分享视频】${text}`;
	}
	if (text === '' && images.length === 0) return null;
	return {
		channel: 'douyin',
		chatType: 'private',
		channelId: `douyin:${name}`,
		targetId: name,
		groupId: null,
		userId: name,
		nickname: name,
		subType: '',
		messageId,
		mentioned: true,
		replyId: null,
		text: text.slice(0, 1000),
		images,
		links,
		timeMs
	};
}

/**
 * 专用浏览器的生命周期。所有会动页面的操作都走 exclusive()（一次只做一件事）。
 */
export class DouyinHost {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => object} deps.getConfig 返回 config.douyin
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {(key: string, text: string|null) => void} [deps.notify]
	 */
	constructor({ db, getConfig, log, notify, port, profileRoot, detect = detectBrowsers, launch = getBrowser } = {}) {
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.notify = notify ?? (() => {});
		this.port = Number(port ?? process.env.FISH_SOUL_DOUYIN_PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
		this.profileRoot = profileRoot ?? join(fishSoulDir(), 'douyin-browser');
		this.detect = detect;
		this.launch = launch;
		this.browser = null;
		this.info = null;
		this.browsers = null;
		this.state = 'stopped';
		this.lastError = '';
		this.loggedIn = null;
		this.stopCollector = null;
		this.targetGoneAt = 0;
		this.exitZeroAt = 0;
		this.crashes = [];
		this.retryTimer = null;
		this.starting = null;
		this.disposed = false;
		this.lock = Promise.resolve();
		this.busy = '';
		this.cacheReady = false;
		this.windowShown = false; // 后台模式下，设置页点了「显示一下」
	}

	/** 窗口模式：background = 停在屏幕外不打扰（默认），visible = 跟普通窗口一样。 */
	windowMode() {
		return this.getConfig()?.window === 'visible' ? 'visible' : 'background';
	}

	effectiveWindowMode() {
		return this.windowMode() === 'visible' || this.windowShown ? 'visible' : 'background';
	}

	/** 后台模式下把窗口停回屏幕外（已经停好的不动）。 */
	async tidyWindow() {
		if (!this.running || this.effectiveWindowMode() !== 'background') return false;
		try { return await parkWindow(this.browser); } catch { return false; }
	}

	/** 设置页「显示一下」：挪回屏幕里，直到点「藏起来」。 */
	async showWindow() {
		this.windowShown = true;
		if (!this.running) return false;
		try { return await showWindow(this.browser); } catch (error) {
			this.log('warn', `[fish-soul] 抖音浏览器窗口挪不回来：${errText(error)}`);
			return false;
		}
	}

	/** 设置页「藏起来」/ 换回后台模式。 */
	async hideWindow() {
		this.windowShown = false;
		return this.tidyWindow();
	}

	get paused() {
		return getKv(this.db, 'douyin.browser.paused', false) === true;
	}

	setPaused(v, why = '') {
		setKv(this.db, 'douyin.browser.paused', v === true);
		if (v === true) setKv(this.db, 'douyin.browser.pausedWhy', why);
	}

	get running() {
		return this.state === 'running' && this.browser !== null && this.browser.isAlive();
	}

	browserPref() {
		const b = this.getConfig()?.browser ?? {};
		return { kind: String(b.kind ?? 'edge') || 'edge', customPath: String(b.customPath ?? '').trim() };
	}

	async rescan() {
		try { this.browsers = await this.detect(); } catch (error) {
			this.browsers = [];
			this.log('warn', `[fish-soul] 找浏览器失败：${errText(error)}`);
		}
		return this.browsers;
	}

	async listBrowsers() {
		if (this.browsers === null) await this.rescan();
		return this.browsers;
	}

	extraArgs() {
		const args = ['--mute-audio'];
		// 后台模式：一启动就在屏幕外（命令行位置不会被浏览器夹回屏幕里），不闪一下
		if (this.effectiveWindowMode() === 'background') args.push(`--window-position=${PARK_LEFT},0`);
		const env = String(process.env.FISH_SOUL_DOUYIN_ARGS ?? '').trim();
		// 按「空格 + --」切，参数值里可以带空格（例如 --host-resolver-rules=MAP a b）
		if (env !== '') args.push(...env.split(/\s+(?=--)/).map((a) => a.trim()).filter((a) => a.startsWith('--')));
		return args;
	}

	/**
	 * 启动（或连上已经在跑的）专用浏览器。resume=true 表示用户点了「启动」：清掉暂停标记。
	 * 用户关窗口后的暂停状态下，自动流程（插件启动、定时器）不会把窗口再弹出来。
	 */
	async start({ resume = false } = {}) {
		if (this.disposed) return false;
		if (resume) { this.setPaused(false); this.crashes = []; }
		if (this.paused) { this.state = 'paused'; return false; }
		if (this.running) return true;
		this.starting ??= this.doStart().finally(() => { this.starting = null; });
		return await this.starting;
	}

	async doStart() {
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.state = 'starting';
		const list = await this.listBrowsers();
		const info = pickBrowser(list, this.browserPref());
		if (info === null) {
			this.state = 'error';
			this.lastError = this.browserPref().customPath ? '手动指定的浏览器路径不存在' : '没找到 Edge / Chrome 等 Chromium 系浏览器';
			return false;
		}
		// 换了浏览器：先把旧的关掉（两个浏览器不能共用调试端口）
		if (this.browser !== null && this.info !== null && this.info.path !== info.path) await this.quitBrowser();
		this.info = info;
		const userDataDir = join(this.profileRoot, info.kind);
		try {
			mkdirSync(userDataDir, { recursive: true });
			if (!this.cacheReady) { setCacheFile(join(fishSoulDir(), 'douyin-im-cache.json')); this.cacheReady = true; }
			if (this.browser !== null) { try { this.browser.detach(); } catch { /* 已断 */ } this.browser = null; }
			let b = null;
			b = await this.launch({
				exe: info.path,
				userDataDir,
				port: this.port,
				log: (msg) => this.log('info', `[fish-soul] 抖音浏览器：${msg}`),
				reuse: true,
				preloadScripts: [HOOK_SOURCE],
				extraArgs: this.extraArgs(),
				onDead: (code) => { if (b !== null) this.onDead(b, code); }
			});
			if (this.disposed) { try { b.detach(); } catch { /* 已断 */ } return false; }
			b.onDead = (code) => this.onDead(b, code);
			b.onEvent = (msg) => this.onEvent(b, msg);
			b.windowMode = () => this.effectiveWindowMode(); // douyin-panel 的 ensureWindowVisible 看这个
			try { await b.send('Target.setDiscoverTargets', { discover: true }); } catch { /* 老版本没有也不要紧 */ }
			this.browser = b;
			this.targetGoneAt = 0;
			this.exitZeroAt = 0;
			this.state = 'running';
			this.lastError = '';
			this.notify('douyin.browser', null);
			this.stopCollector?.();
			this.stopCollector = startCollector(b);
			await this.tidyWindow(); // 连上的是早就开着的浏览器 / 命令行位置没生效：现在停出去
			const href = await b.eval('location.href').catch(() => '');
			if (!/^https:\/\/[^/]*douyin\.com\//.test(String(href))) {
				await this.exclusive('打开抖音', () => b.goto(DOUYIN_HOME, { settleMs: 6000 })).catch((error) => {
					this.log('warn', `[fish-soul] 抖音首页没打开：${errText(error)}`);
				});
			}
			this.log('info', `[fish-soul] 抖音专用浏览器已就绪（${info.name}${info.version ? ` ${info.version}` : ''}）`);
			return true;
		} catch (error) {
			this.state = 'error';
			this.lastError = errText(error);
			this.log('warn', `[fish-soul] 抖音浏览器启动失败：${this.lastError}`);
			return false;
		}
	}

	/** CDP 事件：我们的标签页被关了（用户关窗口 / 关标签页都会先有这个）。 */
	onEvent(b, msg) {
		if (b !== this.browser) return;
		const p = msg.params ?? {};
		const gone = (msg.method === 'Target.detachedFromTarget' && (p.sessionId === b.sessionId || p.targetId === b.targetId)) ||
			(msg.method === 'Target.targetDestroyed' && p.targetId === b.targetId) ||
			(msg.method === 'Inspector.detached' && msg.sessionId === b.sessionId);
		if (!gone || this.targetGoneAt > 0) return;
		this.targetGoneAt = Date.now();
		// 浏览器还开着（只关了这个标签页）：也算用户自己关的 → 暂停，断开连接但不关浏览器
		// 整个浏览器在关时，标签页事件比 ws 关闭早一两秒到、进程也还没被回收 —— 只看这些会误报成"关了标签页"。
		// 用 CDP 端口确认浏览器是否真的还在：还在才算「只关了标签页」，没了就是浏览器关了。
		setTimeout(async () => {
			if (b !== this.browser || this.disposed) return;
			// 端口探测失败也可能是偶发超时：隔一会儿再探一次，两次都没应答才算浏览器真的关了
			const probe = async () => {
				if (typeof b.probePort !== 'function') return true; // 兜底：没有探测能力的实现按"还开着"处理
				try { return Boolean(await b.probePort()); } catch { return true; }
			};
			if (!(await probe())) {
				await new Promise((r) => setTimeout(r, 800).unref?.());
				if (b !== this.browser || this.disposed) return;
				if (!(await probe())) {
					// 端口已经没了 = 浏览器整个在关（进程可能还在收尾，ws 也可能还挂着）→ 按"浏览器关了"暂停
					this.pauseByUser('你把抖音浏览器关了');
					try { b.detach(); } catch { /* 已断 */ }
					this.browser = null;
					return;
				}
			}
			if (b.ready && b.isAlive()) {
				this.pauseByUser('你把抖音标签页关了');
				try { b.detach(); } catch { /* 已断 */ }
				this.browser = null;
			}
		}, 1500).unref?.();
	}

	onDead(b, code) {
		if (b !== this.browser || this.disposed || this.state === 'closing') return;
		if (code === 0) this.exitZeroAt = Date.now();
		if (this.state !== 'running') return;
		// 连接断了：等一下看看是不是用户关的（关窗口时先有标签页关闭事件 / 进程正常退出）
		this.state = 'checking';
		setTimeout(() => {
			if (b !== this.browser || this.disposed || this.state !== 'checking') return;
			this.stopCollector?.();
			this.stopCollector = null;
			const byUser = (this.targetGoneAt > 0 && Date.now() - this.targetGoneAt < 10_000) || (this.exitZeroAt > 0 && Date.now() - this.exitZeroAt < 10_000);
			this.browser = null;
			if (byUser) { this.pauseByUser('你把抖音浏览器关了'); return; }
			this.onCrash();
		}, 2000).unref?.();
	}

	pauseByUser(why) {
		this.stopCollector?.();
		this.stopCollector = null;
		this.setPaused(true, why);
		this.state = 'paused';
		this.lastError = '';
		this.log('info', `[fish-soul] ${why}：抖音先暂停，去设置页点「启动」恢复`);
	}

	onCrash() {
		const now = Date.now();
		this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
		this.crashes.push(now);
		if (this.crashes.length > CRASH_MAX) {
			this.state = 'error';
			this.lastError = `浏览器 10 分钟内断了 ${this.crashes.length} 次，先停下了；去设置页点「启动」重试`;
			this.log('warn', `[fish-soul] ${this.lastError}`);
			this.notify('douyin.browser', `抖音专用浏览器老是崩（${this.lastError}）`);
			return;
		}
		this.state = 'error';
		this.lastError = `浏览器断开了，${CRASH_RETRY_MS / 1000} 秒后自动重连（第 ${this.crashes.length} 次）`;
		this.log('warn', `[fish-soul] ${this.lastError}`);
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => { void this.start(); }, CRASH_RETRY_MS);
		this.retryTimer.unref?.();
	}

	async quitBrowser() {
		const b = this.browser;
		this.stopCollector?.();
		this.stopCollector = null;
		if (b === null) return;
		this.state = 'closing';
		try { await b.quit(); } catch { /* 已经没了 */ }
		this.browser = null;
		this.state = 'stopped';
	}

	/** 设置页「关闭浏览器」：真的关掉，并暂停（不会自己再开）。 */
	async closeBrowser() {
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.setPaused(true, '你在设置页关掉了抖音浏览器');
		await this.quitBrowser();
		this.state = 'paused';
		this.loggedIn = null;
	}

	/** 插件卸载：只断开连接，浏览器留着（热重载后新实例直接连上）。 */
	dispose() {
		this.disposed = true;
		clearTimeout(this.retryTimer);
		this.stopCollector?.();
		this.stopCollector = null;
		if (this.browser !== null) { try { this.browser.detach(); } catch { /* 已断 */ } }
		this.browser = null;
	}

	/** 互斥：同一时间只有一件事在动页面。超过 4 分钟没做完的放行（防死锁）。 */
	exclusive(label, fn, { maxMs = LOCK_MAX_MS } = {}) {
		const run = async () => {
			this.busy = label;
			let timer;
			try {
				await this.tidyWindow(); // 动页面之前：被最小化 / 拖回来了就停回屏幕外（后台模式）
				return await Promise.race([
					fn(),
					new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}超时`)), maxMs); timer.unref?.(); })
				]);
			} finally {
				clearTimeout(timer);
				this.busy = '';
			}
		};
		const p = this.lock.then(run, run);
		this.lock = p.catch(() => {});
		return p;
	}

	async checkLogin() {
		if (!this.running) return null;
		try {
			const r = await checkLogin(this.browser);
			this.loggedIn = r.loggedIn === true;
		} catch { /* 这次看不了 */ }
		return this.loggedIn;
	}

	/** 登录用的截图（jpeg，小一点）。 */
	async screenshot() {
		if (!this.running) return null;
		const b = this.browser;
		const r = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, b.sessionId);
		const m = await b.send('Page.getLayoutMetrics', {}, b.sessionId).catch(() => null);
		const vp = m?.cssVisualViewport ?? m?.cssLayoutViewport ?? {};
		return { jpeg: Buffer.from(r.data, 'base64'), width: Math.round(vp.clientWidth ?? 0), height: Math.round(vp.clientHeight ?? 0) };
	}

	/** 设置页里点截图 → 转成页面上的一次点击（xr / yr 是 0–1 的相对坐标）。 */
	async click(xr, yr) {
		if (!this.running) return false;
		const b = this.browser;
		const m = await b.send('Page.getLayoutMetrics', {}, b.sessionId);
		const vp = m?.cssVisualViewport ?? m?.cssLayoutViewport ?? {};
		const x = Math.round(Math.min(1, Math.max(0, Number(xr))) * (vp.clientWidth ?? 0));
		const y = Math.round(Math.min(1, Math.max(0, Number(yr))) * (vp.clientHeight ?? 0));
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
			await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }, b.sessionId);
		}
		return true;
	}

	/** 没有 sharp 时的 webp → png（在专用浏览器里用 canvas 画一遍；动图只留第一帧）。 */
	async canvasConvert(bytes) {
		if (!this.running) return null;
		const b64 = Buffer.from(bytes).toString('base64');
		const out = await this.exclusive('转图片', () => this.browser.eval(`(async () => {
			const bin = atob(${JSON.stringify(b64)});
			const arr = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
			const bmp = await createImageBitmap(new Blob([arr], { type: 'image/webp' }));
			const c = new OffscreenCanvas(bmp.width, bmp.height);
			c.getContext('2d').drawImage(bmp, 0, 0);
			const blob = await c.convertToBlob({ type: 'image/png' });
			const u = new Uint8Array(await blob.arrayBuffer());
			let s = '';
			for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
			return btoa(s);
		})()`), { maxMs: 30_000 });
		return typeof out === 'string' && out !== '' ? Buffer.from(out, 'base64') : null;
	}

	status() {
		const pref = this.browserPref();
		return {
			state: this.paused && this.state !== 'running' ? 'paused' : this.state,
			paused: this.paused,
			pausedWhy: this.paused ? String(getKv(this.db, 'douyin.browser.pausedWhy', '') ?? '') : '',
			lastError: this.lastError,
			busy: this.busy,
			loggedIn: this.loggedIn,
			browser: this.info === null ? null : { kind: this.info.kind, name: this.info.name, version: this.info.version, path: this.info.path },
			pref,
			browsers: (this.browsers ?? []).map((b) => ({ kind: b.kind, name: b.name, version: b.version, path: b.path })),
			kinds: Object.keys(BROWSER_KINDS),
			port: this.port,
			window: this.windowMode(),
			windowShown: this.windowShown
		};
	}
}

/** 真正的页面驱动（测试里换成假的）。 */
export function pageDriver(host) {
	const b = () => {
		if (!host.running) throw new Error('抖音浏览器没在运行');
		return host.browser;
	};
	return {
		checkLogin: async () => (await checkLogin(b())).loggedIn === true,
		list: () => dmList({ browser: b(), limit: 30 }),
		read: (name) => readDM({ browser: b(), uname: name, limit: READ_LIMIT }),
		sendText: (name, text) => sendDM({ browser: b(), text, uname: name }),
		sendImage: (name, file) => sendImage({ browser: b(), file, uname: name }),
		sendEmoji: (name, emoji) => sendEmoji({ browser: b(), name: emoji, uname: name }),
		canary: () => canary(b())
	};
}

/**
 * 私信轮询渠道。onMessage(m) 收到的是归一化后的入站消息，回不回由网关决定。
 */
export class DouyinChannel {
	/**
	 * @param {object} deps
	 * @param {DouyinHost} deps.host
	 * @param {ReturnType<typeof pageDriver>} [deps.driver]
	 * @param {(key: string, text: string|null) => void} [deps.notify]
	 * @param {[number, number]} [deps.pollRangeMs]
	 * @param {[number, number]} [deps.typingMs] 打字延迟（基础下限 / 上限）
	 */
	constructor({ host, db, getConfig, log, onMessage, notify, driver, pollRangeMs = [30_000, 60_000], typingMs = [1500, 3000], firstPollMs = 5000 }) {
		this.host = host;
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.onMessage = onMessage;
		this.notify = notify ?? (() => {});
		this.driver = driver ?? pageDriver(host);
		this.pollRangeMs = pollRangeMs;
		this.typingMs = typingMs;
		this.firstPollMs = firstPollMs;
		this.timer = null;
		this.running = false;
		this.gen = 0;
		this.polling = false;
		this.lastPollAt = 0;
		this.lastError = '';
		this.failures = 0;
		this.lastCanaryAt = 0;
		this.canaryReport = null;
		/** 抖音改版认不出页面：自动回复先停（只记不回） */
		this.replyPaused = false;
		this.sendChain = Promise.resolve();
	}

	cfg() {
		const d = this.getConfig() ?? {};
		return { enabled: d.enabled === true, autoReply: d.autoReply === true };
	}

	get connected() {
		return this.running && this.host.running && this.host.loggedIn === true;
	}

	status() {
		return {
			running: this.running,
			lastPollAt: this.lastPollAt,
			lastError: this.lastError,
			replyPaused: this.replyPaused,
			canary: this.canaryReport,
			bootstrapped: getKv(this.db, 'douyin.bootstrapped', false) === true
		};
	}

	start() {
		if (this.running) return;
		this.running = true;
		const gen = ++this.gen;
		void this.host.start();
		const loop = async () => {
			if (!this.running || gen !== this.gen) return;
			await this.pollOnce().catch(() => {});
			if (!this.running || gen !== this.gen) return;
			const [lo, hi] = this.pollRangeMs;
			this.timer = setTimeout(loop, lo + Math.floor(Math.random() * Math.max(0, hi - lo)));
			this.timer.unref?.();
		};
		this.timer = setTimeout(loop, this.firstPollMs);
		this.timer.unref?.();
	}

	stop() {
		this.running = false;
		this.gen++;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	restart() {
		this.stop();
		if (this.cfg().enabled) this.start();
	}

	/** 轮询一次（整轮最多 3 分钟）。 */
	async pollOnce() {
		if (this.polling || !this.cfg().enabled) return;
		if (!this.host.running) {
			// 浏览器没在跑：不是用户暂停的就试着拉起来（崩溃重连由 host 自己管）
			if (!this.host.paused && this.host.state === 'stopped') await this.host.start();
			if (!this.host.running) return;
		}
		this.polling = true;
		try {
			await this.host.exclusive('读私信', () => this.pollInner(), { maxMs: POLL_TIMEOUT_MS });
			this.lastPollAt = Date.now();
			this.lastError = '';
			this.failures = 0;
		} catch (error) {
			this.lastError = errText(error);
			this.failures++;
			this.log('warn', `[fish-soul] 抖音私信轮询失败：${this.lastError}`);
			if (this.failures >= 3 && this.host.running && this.host.loggedIn === true) {
				this.failures = 0;
				await this.host.exclusive('自检', () => this.runCanary(), { maxMs: 60_000 }).catch(() => {});
			}
		} finally {
			this.polling = false;
		}
	}

	async pollInner() {
		const loggedIn = await this.driver.checkLogin();
		this.host.loggedIn = loggedIn;
		if (!loggedIn) {
			this.notify('douyin.login', '抖音小号掉登录了（或者还没登录），去设置页「抖音」里扫码登录一下');
			return;
		}
		this.notify('douyin.login', null);
		const list = await this.driver.list();
		if (!list?.ok) throw new Error(list?.error || '读不到会话列表');
		if (this.lastCanaryAt === 0 || Date.now() - this.lastCanaryAt > CANARY_EVERY_MS) await this.runCanary();
		const convs = (list.conversations ?? []).filter((c) => c && String(c.name ?? '').trim() !== '');
		const bootstrapped = getKv(this.db, 'douyin.bootstrapped', false) === true;
		const now = Date.now();
		const todo = [];
		for (const c of convs) {
			const name = String(c.name).trim();
			const key = `douyin.conv.${sha1(name).slice(0, 16)}`;
			const st = getKv(this.db, key, null);
			const sig = `${c.time ?? ''}|${String(c.preview ?? '').slice(0, 60)}`;
			if (!bootstrapped) { setKv(this.db, key, { name, sig, window: st?.window ?? [] }); continue; }
			const unread = Number(c.unread) > 0 || c.unread === true;
			const t = convTimeMs(c.time);
			const changed = st === null || st.sig !== sig;
			const recent = t === 0 ? changed : now - t < RECENT_MS;
			if (unread || (changed && recent)) todo.push({ c, name, key, st, sig, unread });
		}
		if (!bootstrapped) {
			setKv(this.db, 'douyin.bootstrapped', true);
			this.log('info', `[fish-soul] 抖音私信基线已记下（${convs.length} 个会话），之后的新消息才处理`);
			return;
		}
		todo.sort((a, b) => Number(b.unread) - Number(a.unread));
		for (const item of todo.slice(0, MAX_READS_PER_POLL)) await this.readConversation(item);
	}

	async readConversation({ c, name, key, st, sig, unread }) {
		const res = await this.driver.read(name);
		if (!res?.ok) {
			this.log('warn', `[fish-soul] 读「${name}」的私信失败：${res?.error ?? '未知'}`);
			return;
		}
		const msgs = Array.isArray(res.messages) ? res.messages : [];
		const prints = msgs.map(messageFingerprint);
		let fresh = [];
		if (st !== null && Array.isArray(st.window) && st.window.length > 0) {
			const from = newFrom(st.window, prints);
			fresh = msgs.slice(from);
			// 一条都没对上（窗口滚走了 / 两次读法不一样）：最多补最后 3 条，宁少勿重
			if (from === 0 && msgs.length > 0) fresh = fresh.slice(-INJECT_ON_FIRST_READ);
		} else if (unread) {
			// 第一次读这个会话、而且有未读：补最后几条对方的消息（自己最后一次说话之后的）
			let lastMine = -1;
			for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].fromMe) { lastMine = i; break; }
			const want = typeof c.unread === 'number' && c.unread > 0 ? Math.min(INJECT_ON_FIRST_READ, c.unread) : INJECT_ON_FIRST_READ;
			fresh = msgs.slice(lastMine + 1).filter((m) => !m.fromMe && !m.system && !m.unsupported).slice(-want);
		}
		setKv(this.db, key, { name, sig, window: prints.slice(-WINDOW_KEEP), readAt: Date.now() });
		const fallbackTime = convTimeMs(c.time) || Date.now();
		// 同一指纹在这次读到的列表里是第几次出现：对方连发同一句话时，没 seq 的 ID 也不会撞
		const occ = occurrenceIndexes(prints);
		const base = msgs.length - fresh.length;
		for (const [i, m] of fresh.entries()) {
			const timeMs = Number(m.time) > 1e12 ? Number(m.time) : Number(m.time) > 1e9 ? Number(m.time) * 1000 : fallbackTime;
			const messageId = m.seq ? `s${m.seq}` : `${prints[base + i]}-${timeMs}-${occ[base + i]}`;
			const norm = normalizeDouyinMessage(m, { name, timeMs, messageId });
			if (norm === null) continue;
			try { await this.onMessage(norm); } catch (error) {
				this.log('error', `[fish-soul] 抖音私信处理失败：${errText(error)}`);
			}
		}
	}

	async runCanary() {
		this.lastCanaryAt = Date.now();
		let r;
		try { r = await this.driver.canary(); } catch (error) { r = { ok: false, broken: ['canary'], error: errText(error) }; }
		this.canaryReport = { ...r, at: Date.now() };
		if (r?.ok) {
			if (this.replyPaused) this.log('info', '[fish-soul] 抖音页面自检恢复正常，自动回复继续');
			this.replyPaused = false;
			this.notify('douyin.page', null);
		} else {
			this.replyPaused = true;
			this.log('warn', `[fish-soul] 抖音页面自检没过（${(r?.broken ?? []).join('、') || r?.error || '?'}），自动回复先停`);
			this.notify('douyin.page', '抖音网页好像改版了，鱼认不出私信页面，抖音自动回复先停了（设置页「抖音」里有自检报告，可以复制给开发者）');
		}
		return this.canaryReport;
	}

	/** 设置页手动自检（会打开私信面板）。 */
	async selfCheck() {
		if (!this.host.running) return { ok: false, error: '抖音浏览器没在运行' };
		return await this.host.exclusive('自检', async () => {
			const loggedIn = await this.driver.checkLogin();
			const list = loggedIn ? await this.driver.list().catch((e) => ({ ok: false, error: errText(e) })) : { ok: false, error: '没登录' };
			const report = await this.runCanary();
			return { ok: report.ok === true && list.ok === true, loggedIn, list: { ok: list.ok, count: list.conversations?.length ?? 0, error: list.error ?? '' }, canary: report };
		}, { maxMs: 90_000 });
	}

	/** 模拟打字的停顿：1.5–3 秒 + 每字 80 毫秒，最多 8 秒。 */
	typingDelay(text) {
		const [lo, hi] = this.typingMs;
		if (hi <= 0) return 0;
		return Math.min(8000, lo + Math.floor(Math.random() * Math.max(0, hi - lo)) + 80 * String(text ?? '').length);
	}

	/**
	 * 发一组内容（串行、每段之间模拟打字）。parts: [{type:'text', text} | {type:'image', path} | {type:'emoji', name}]
	 * @returns {Promise<boolean>} 全部发出去了
	 */
	send(name, parts) {
		const run = async () => {
			if (!this.host.running) throw new Error('抖音浏览器没在运行');
			let allOk = true;
			for (const part of parts) {
				await sleep(this.typingDelay(part.type === 'text' ? part.text : ''));
				const r = await this.host.exclusive('发私信', async () => {
					if (part.type === 'image') return await this.driver.sendImage(name, part.path);
					if (part.type === 'emoji') {
						const e = await this.driver.sendEmoji(name, part.name);
						// 表情面板里没有这个名字：当文字发
						return e?.ok ? e : await this.driver.sendText(name, `[${part.name}]`);
					}
					return await this.driver.sendText(name, part.text);
				}, { maxMs: 90_000 }).catch((error) => ({ ok: false, error: errText(error) }));
				if (!r?.ok) {
					allOk = false;
					this.log('error', `[fish-soul] 发抖音私信给「${name}」失败：${r?.error ?? '未知'}`);
				}
			}
			// 自己发出去的消息进窗口，下一轮不当成新消息（下一轮读的时候它们是"我"发的，本来也不会回）
			return allOk;
		};
		const p = this.sendChain.then(run, run);
		this.sendChain = p.catch(() => {});
		return p;
	}
}
