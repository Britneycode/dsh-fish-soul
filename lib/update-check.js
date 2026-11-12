/**
 * update-check.js —— 显示当前版本、自动检查有没有新版本（v0.12）。
 *
 *  - 当前版本直接读自己的 package.json；
 *  - 新版本先问 npm（`dsh plugin add dsh-fish-soul@x` 装的就是 npm 上那份），问不到再看 GitHub 最新 release；
 *    更新说明总是从 GitHub release 拿（npm 上没有）；
 *  - 自动检查：插件启动 30 秒后一次，之后每 12 小时一次（`update.autoCheck`，默认开）；结果存在 kv 里，
 *    设置页打开时直接显示上次的结果，不用等网络；
 *  - 只检查、不自动安装：装插件要动宿主的 profile，交给主人用设置页给的命令去装。
 *  - 只发 GET，不带任何本机信息。
 */
import { readFileSync } from 'node:fs';
import { getKv, setKv } from './db.js';

export const PACKAGE_NAME = 'dsh-fish-soul';
export const REPO = 'Britneycode/dsh-fish-soul';
const NPM_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const GH_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_DELAY_MS = 30_000;
const INTERVAL_MS = 12 * 3600_000;
const TIMEOUT_MS = 8000;
const KV_KEY = 'update.last';

let cachedVersion = null;
/**
 * 插件自己的版本（package.json）。
 * 依赖目录层级：本文件在 <包根>/lib/ 下，`../package.json` 就是包根（npm 发布时 package.json 总会带上）。
 * 以后如果改成打包输出到别的层级，这里要跟着改。
 */
export function pluginVersion() {
	if (cachedVersion !== null) return cachedVersion;
	try {
		cachedVersion = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0');
	} catch {
		cachedVersion = '0.0.0';
	}
	return cachedVersion;
}

/** "v1.2.3-rc.1" → { nums:[1,2,3], pre:['rc',1] }；看不懂返回 null。 */
function parse(v) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim());
	if (!m) return null;
	return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : [] };
}

/** semver 比较：a > b 返回 1，相等 0，小于 -1；看不懂的当作 0。 */
export function compareVersions(a, b) {
	const x = parse(a); const y = parse(b);
	if (x === null || y === null) return 0;
	for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
	// 正式版 > 预发布版
	if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i]; const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		if (typeof p === 'number' && typeof q === 'number') return p > q ? 1 : -1;
		if (typeof p === 'number') return -1;
		if (typeof q === 'number') return 1;
		return p > q ? 1 : -1;
	}
	return 0;
}

export function updateCommand(version, profile = 'desktop') {
	return `dsh plugin --profile ${profile} add ${PACKAGE_NAME}@${version}`;
}

export class UpdateChecker {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => {autoCheck?: boolean}} deps.getConfig
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {typeof fetch} [deps.fetchImpl]
	 * @param {string} [deps.current]
	 * @param {() => number} [deps.now]
	 */
	constructor({ db, getConfig, log, fetchImpl, current, now, random }) {
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.fetchImpl = fetchImpl ?? ((...a) => globalThis.fetch(...a));
		this.current = current ?? pluginVersion();
		this.now = now ?? (() => Date.now());
		this.random = random ?? Math.random;
		this.timer = null;
		this.running = null;
	}

	autoCheck() {
		return this.getConfig()?.autoCheck !== false;
	}

	/**
	 * 下一次自动检查还要等多久：上次检查时间 + 12 小时 ±10% 抖动（多个实例 / 同一出口 IP 不会扎堆）；
	 * 从没查过或早该查了 → 30 秒后（重启频繁时也不会每次启动都去问）。
	 */
	nextDelay() {
		const jitter = INTERVAL_MS * (0.9 + 0.2 * this.random());
		const last = getKv(this.db, KV_KEY, null)?.checkedAt;
		if (typeof last !== 'number') return FIRST_DELAY_MS;
		return Math.max(FIRST_DELAY_MS, Math.min(jitter, last + jitter - this.now()));
	}

	start() {
		this.stop();
		this.stopped = false;
		const tick = async () => {
			try { if (this.autoCheck()) await this.check(); }
			catch (e) { this.log('warn', `[fish-soul] 检查更新出错：${e instanceof Error ? e.message : e}`); }
			if (!this.stopped) {
				try { arm(); }
				catch (e) { this.log('warn', `[fish-soul] 更新检查重新排程失败：${e instanceof Error ? e.message : e}`); }
			}
		};
		const arm = () => {
			let delay;
			try { delay = this.nextDelay(); }
			catch (e) {
				this.log('warn', `[fish-soul] 读取更新检查间隔失败，按默认间隔重试：${e instanceof Error ? e.message : e}`);
				delay = INTERVAL_MS;
			}
			this.timer = setTimeout(() => { void tick(); }, delay);
			this.timer.unref?.();
		};
		arm();
	}

	stop() {
		this.stopped = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	async getJson(url) {
		const res = await this.fetchImpl(url, {
			headers: { accept: 'application/json', 'user-agent': `${PACKAGE_NAME}/${this.current}` },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	}

	/** 去问一次（同一时间只跑一个）。失败不抛，记进 error。 */
	check() {
		this.running ??= this.checkOnce().finally(() => { this.running = null; });
		// 等 finally 清掉 running 之后再取 state，否则返回的 checking 永远是 true（按钮一直「检查中…」）
		return this.running.then(() => this.state());
	}

	async checkOnce() {
		const errors = [];
		let latest = null; let source = '';
		try {
			latest = String((await this.getJson(NPM_URL)).version ?? '') || null;
			if (latest) source = 'npm';
		} catch (e) { errors.push(`npm：${e instanceof Error ? e.message : e}`); }
		let notes = ''; let notesUrl = `https://github.com/${REPO}/releases`; let publishedAt = null;
		try {
			const rel = await this.getJson(GH_URL);
			const tag = String(rel.tag_name ?? '').replace(/^v/, '');
			if (latest === null && tag) { latest = tag; source = 'github'; }
			if (tag && compareVersions(tag, latest) === 0) {
				notes = String(rel.body ?? '').slice(0, 2000);
				notesUrl = String(rel.html_url ?? notesUrl);
				publishedAt = rel.published_at ? Date.parse(rel.published_at) : null;
			}
		} catch (e) { errors.push(`GitHub：${e instanceof Error ? e.message : e}`); }
		const result = {
			checkedAt: this.now(),
			latest, source, notes, notesUrl, publishedAt,
			error: latest === null ? errors.join('；') || '没拿到版本号' : ''
		};
		const prev = getKv(this.db, KV_KEY, null);
		setKv(this.db, KV_KEY, result);
		if (latest !== null && compareVersions(latest, this.current) > 0 && prev?.latest !== latest) {
			this.log('info', `[fish-soul] 有新版本 v${latest}（当前 v${this.current}）：${updateCommand(latest)}`);
		} else if (latest === null) {
			this.log('warn', `[fish-soul] 检查更新失败：${result.error}`);
		}
		return this.state();
	}

	state() {
		const last = getKv(this.db, KV_KEY, null);
		const latest = last?.latest ?? null;
		const hasUpdate = latest !== null && compareVersions(latest, this.current) > 0;
		return {
			ok: true,
			current: this.current,
			latest,
			hasUpdate,
			checkedAt: last?.checkedAt ?? null,
			checking: this.running !== null,
			source: last?.source ?? '',
			notes: hasUpdate ? last?.notes ?? '' : '',
			notesUrl: last?.notesUrl ?? `https://github.com/${REPO}/releases`,
			publishedAt: last?.publishedAt ?? null,
			error: last?.error ?? '',
			autoCheck: this.autoCheck(),
			command: hasUpdate ? updateCommand(latest) : ''
		};
	}
}
