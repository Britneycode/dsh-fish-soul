import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fishSoulDir, getKv, setKv } from '../db.js';
import { BROWSER_KINDS, detectBrowsers, pickBrowser } from '../browsers.js';
import { getBrowser } from './vendor/douyin-bridge/browser.mjs';
import { HOOK_SOURCE, setCacheFile, startCollector } from './vendor/douyin-bridge/douyin-api.mjs';
import { COMMENT_BRIDGE_SOURCE } from './vendor/douyin-bridge/douyin-comment.js';
import { checkLogin } from './vendor/douyin-bridge/douyin-dm.mjs';
import { PARK_LEFT, parkWindow, showWindow, ensurePanel } from './vendor/douyin-bridge/douyin-panel.mjs';
import { DOUYIN_HOME, errText } from './douyin-pure.js';

const DEFAULT_PORT = 47890;
const CRASH_RETRY_MS = 30_000;
const CRASH_MAX = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const LOCK_MAX_MS = 4 * 60_000;

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
	 * @param {(browser: object) => Promise<any>} [deps.openPanel] 打开私信面板（测试里换假的）
	 */
	constructor({ db, getConfig, log, notify, port, profileRoot, detect = detectBrowsers, launch = getBrowser, openPanel = ensurePanel } = {}) {
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.notify = notify ?? (() => {});
		this.port = Number(port ?? process.env.FISH_SOUL_DOUYIN_PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
		this.profileRoot = profileRoot ?? join(fishSoulDir(), 'douyin-browser');
		this.detect = detect;
		this.launch = launch;
		this.openPanel = openPanel;
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
				preloadScripts: [HOOK_SOURCE, COMMENT_BRIDGE_SOURCE],
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
		// 重连本身失败也要吞掉：否则这次 reject 变成未处理拒绝，进程直接退出（连重试都没了）
		this.retryTimer = setTimeout(() => { void this.start().catch((error) => this.log('warn', `[fish-soul] 抖音浏览器重连失败：${String(error instanceof Error ? error.message : error)}`)); }, CRASH_RETRY_MS);
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

	/**
	 * 互斥：同一时间只有一件事在动页面。
	 *
	 * 🔴 超时的语义是「**报错给调用方**」，不是「放锁让别人上」。
	 *    以前超时就 clearTimeout + 清 busy 直接放锁，但 `fn()` 本身没有被取消
	 *    （没有 AbortSignal 传进去），它还在动页面 —— 下一件事（比如发私信）
	 *    立刻开始，两个操作抢同一个 CDP 会话 / 同一个输入框。实测：
	 *    读私信 3 分钟超时后发私信，`read:still-running` 在 `send:end` 之后才打印。
	 *    `sendDM` 的 expectConvId 能兜住「发错人」，但兜不住「输入框被读操作清掉」。
	 *
	 *    现在：超时只让**调用方**拿到错误，锁要等 fn() 真正 settle 才放。
	 *    死锁风险由 maxMs 的报错 + 调用方超时兜底（不会永远挂着）。
	 */
	exclusive(label, fn, { maxMs = LOCK_MAX_MS } = {}) {
		const run = async () => {
			this.busy = label;
			let timer;
			let timedOut = false;
			// 让调用方先拿到超时错误，但 fn() 继续在锁内跑完
			const work = (async () => {
				await this.tidyWindow(); // 动页面之前：被最小化 / 拖回来了就停回屏幕外（后台模式）
				return await fn();
			})();
			// work 的 rejection 必须有接收者：否则超时后它才抛错时会变成未处理拒绝
			const guarded = work.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
			let timeoutError = null;
			const timeout = new Promise((resolve) => {
				timer = setTimeout(() => { timedOut = true; timeoutError = new Error(`${label}超时`); resolve(null); }, maxMs);
				timer.unref?.();
			});
			try {
				const first = await Promise.race([guarded, timeout]);
				if (!timedOut) {
					// fn() 先结束（成功或真失败）：直接交结果
					if (first.ok) return first.v;
					throw first.e;
				}
				// 超时了。注意这里**不能 await work** —— 那会让调用方也一起等，
				// 「超时报错」就失去意义了（POLL_TIMEOUT_MS 就是用来及时脱身的）。
				// 做法：把「放锁」这件事挂到 work 结束之后，run() 立刻带着超时错误返回，
				// 但 this.lock 链上多挂一节，下一件事要等那一节完成才轮到。
				this.busy = `${label}（超时，等它收尾）`;
				const release = work.then(() => {}, () => {});
				throw Object.assign(timeoutError, { __holdLock: release });
			} finally {
				clearTimeout(timer);
			}
		};
		const p = this.lock.then(run, run);
		// 超时的那一次会在错误上挂 `__holdLock`（等 fn 真收尾的 promise）：
		// 把它接到锁链上，下一件事就排在「收尾完成」之后，而不是和它并发。
		this.lock = p.then(
			() => {},
			(error) => {
				const hold = error?.__holdLock;
				if (hold === undefined) return;
				return hold.then(() => { if (this.busy.endsWith('（超时，等它收尾）')) this.busy = ''; });
			},
		);
		return p;
	}

	/**
	 * 刷新抖音页面（#72）。
	 *
	 * 抖音页面放久了会被浏览器「睡」掉 —— 标签页被丢弃 / 渲染进程被冻结，
	 * 表现成页面白屏、选择器一个都命中不了（自检必然不过），手动刷新一下就恢复。
	 * 刷新完把私信面板重新打开：刷新后面板是关着的，
	 * 而自检的关键项之一 conversationItem 只在面板开着时才有。
	 *
	 * ⚠️ 调用方必须已经在 exclusive() 里 —— 这里不再抢锁（自己抢自己的锁会死锁）。
	 * @returns {Promise<boolean>} 刷新 + 面板开回来了没有
	 */
	async refresh() {
		if (!this.running) return false;
		const b = this.browser;
		try {
			const href = String(await b.eval('location.href').catch(() => '') || '');
			if (/^https?:\/\/[^/]*douyin\.com(\/|$)/.test(href)) {
				if (typeof b.reload === 'function') await b.reload({ settleMs: 6000 });
				else await b.goto(href, { settleMs: 6000 });
			} else {
				// 已经跑到 about:blank / 别的站上去了：刷新没意义，直接回抖音
				await b.goto(DOUYIN_HOME, { settleMs: 8000 });
			}
		} catch (error) {
			this.log('warn', `[fish-soul] 刷新抖音页面失败：${errText(error)}`);
			return false;
		}
		// 面板另算：刷新后私信面板是关着的，自检的关键项 conversationItem 只在面板开着时才有。
		// 面板开不成不算刷新失败（自检重跑会自己判），只记一笔。
		try { await this.openPanel(b); } catch (error) {
			this.log('warn', `[fish-soul] 刷新后私信面板没打开：${errText(error)}`);
		}
		this.log('info', '[fish-soul] 抖音页面已刷新');
		return true;
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
