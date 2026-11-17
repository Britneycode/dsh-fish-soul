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
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome, getKv, setKv } from './db.js';

export const PACKAGE_NAME = 'dsh-fish-soul';
export const REPO = 'Britneycode/dsh-fish-soul';
const NPM_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const GH_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_DELAY_MS = 30_000;
const INTERVAL_MS = 12 * 3600_000;
const TIMEOUT_MS = 8000;
// 面板上的「上次检查结果」超过这个时长就算旧（会误导人），进程刚启动时补查一次。
const STALE_MS = 3600_000;
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

/**
/**
 * 这个插件是怎么装的：
 *   'dev'      —— 开发目录软链（link）。宿主 profile 里 `node_modules/dsh-fish-soul`
 *                是个指向开发仓的符号链接。**npm 上的新版本不会覆盖它**
 *                （覆盖 = 把主人正在改的代码冲掉），所以一键更新在这台机器上不存在 ——
 *                宿主会明确拒绝，面板要提前说清楚，不能让人以为「点了没反应」。
 *   'registry' —— 宿主自己装的（npm / pnpm），落在 DSH 的目录下面，一键更新才有意义。
 *
 * ⚠️ 判据不能用「路径里有没有 node_modules」：主人把开发仓 clone 进某个项目的
 *    `node_modules/` 里开发时，那条路径也含 node_modules ⇒ 会被误判成 registry ⇒
 *    面板对 dev 装的用户说「已是最���」，症状原样复发。
 *    「在不在 DSH 目录里」才是真的分界：宿主装的必然在 `~/.dsh/profiles/<profile>/node_modules/…`，
 *    开发仓在别处。pnpm 的虚拟 store（`.pnpm/xxx/node_modules/…`）也在 profiles 下 ⇒ 判成 registry，对。
 *
 * @param {string} dir 插件自己的真实目录
 * @param {string} home DSH 的 home（`~/.dsh`）
 * @returns {'dev'|'registry'|'unknown'}
 */
export function modeFromPath(dir, home) {
	try {
		const rel = relative(resolve(home), resolve(dir));
		// 在 home 之下（rel 不是以 .. 开头、也不是绝对路径）⇒ 宿主装的
		if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return 'registry';
		if (rel === '') return 'unknown'; // 就是 home 本身，判断不了
		return 'dev';
	} catch {
		return 'unknown';
	}
}

/**
 * @returns {{mode: 'dev'|'registry'|'unknown', path: string}}
 */
export function installInfo() {
	try {
		const self = realpathSync(fileURLToPath(new URL('../package.json', import.meta.url)));
		const dir = dirname(self);
		return { mode: modeFromPath(dir, dshHome()), path: dir };
	} catch {
		return { mode: 'unknown', path: '' };
	}
}

export function installMode() {
	return installInfo().mode;
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
		// 「本进程还没查过」—— 放构造函数而不是 start()：
		// start(); stop(); start()（插件热重载）不该把它又置回 true 而多问一次。
		this.freshProcess = true;
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

	/**
	 * 上次查到的结果是不是已经旧到会误导人（超过 STALE_MS）。
	 * 从没查过 ⇒ 算旧（要查）。
	 */
	staleResult() {
		const last = getKv(this.db, KV_KEY, null)?.checkedAt;
		return typeof last !== 'number' || (this.now() - last) > STALE_MS;
	}

	start() {
		this.stop();
		this.stopped = false;
		// 🔴 **进程刚启动、且上次的结果已经旧到会误导人时，补查一次**（30 秒后）。
		//    以前 nextDelay() 只看 kv 里的 checkedAt ⇒ 宿主重启后可能要再等好几个小时
		//    才重查，面板于是显示着**上一次**的结果（这次就显示 latest=0.18.5，
		//    而 npm 上早就是 0.18.7 了）—— 「已是最新」是假的，主人根本不知道出了新版。
		//
		//    ⚠️ 但**不能每次启动都问**：GitHub 未认证 API 是 60 次/小时/IP，
		//    崩溃重启循环会直接吃满；而且 nextDelay() 的文档写着
		//    「重启频繁时也不会每次启动都去问」—— 那是一条被代码主动推翻的承诺。
		//    所以加了 STALE_MS 门槛：结果超过 1 小时才算「旧到会误导人」。
		const tick = async () => {
			try {
				// 自动检查开着才真的查。查过了才把「本进程已问过」记上 ——
				// 否则自动检查关着时，那 30 秒的机会会被白白烧掉，之后又是十几个小时不查。
				if (this.autoCheck()) { await this.check(); this.freshProcess = false; }
			}
			catch (e) { this.log('warn', `[fish-soul] 检查更新出错：${e instanceof Error ? e.message : e}`); }
			if (!this.stopped) {
				try { arm(); }
				catch (e) { this.log('warn', `[fish-soul] 更新检查重新排程失败：${e instanceof Error ? e.message : e}`); }
			}
		};
		const arm = () => {
			let delay;
			try {
				delay = (this.freshProcess && this.staleResult()) ? FIRST_DELAY_MS : this.nextDelay();
			} catch (e) {
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
		const info = installInfo(); // 一次取值就够（realpathSync 是同步的，面板每 60 秒轮询一次）
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
			command: hasUpdate ? updateCommand(latest) : '',
			// dev（link）安装：npm 版不会覆盖开发目录 ⇒ 一键更新在这台机器上不存在。
			// 带上真实路径：面板给的更新命令要用它，不能给占位符（复制过去直接报错）。
			installMode: info.mode,
			installPath: info.path
		};
	}
}
