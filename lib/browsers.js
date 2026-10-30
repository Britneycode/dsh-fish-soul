/**
 * browsers.js —— 找本机装了哪些 Chromium 系浏览器（Edge / Chrome 各渠道 / Brave / Vivaldi / Chromium），
 * 给抖音专用浏览器用。不认 Firefox（没有 CDP）。
 *
 * Windows：常见安装目录（含 %LOCALAPPDATA% 的按用户安装）+ 注册表 App Paths（HKLM / HKCU）；
 *          版本号取 Application\<版本号>\ 目录名。
 * macOS：/Applications 与 ~/Applications 下的 .app，版本号读 Info.plist。
 * Linux：常见路径 + PATH，版本号跑 `--version`。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** kind → 显示名 + 排序（Edge 在最前，默认用它）。 */
export const BROWSER_KINDS = {
	edge: { name: 'Microsoft Edge', order: 0 },
	'edge-beta': { name: 'Microsoft Edge Beta', order: 1 },
	'edge-dev': { name: 'Microsoft Edge Dev', order: 2 },
	'edge-canary': { name: 'Microsoft Edge Canary', order: 3 },
	chrome: { name: 'Google Chrome', order: 4 },
	'chrome-beta': { name: 'Google Chrome Beta', order: 5 },
	'chrome-dev': { name: 'Google Chrome Dev', order: 6 },
	'chrome-canary': { name: 'Google Chrome Canary', order: 7 },
	brave: { name: 'Brave', order: 8 },
	'brave-beta': { name: 'Brave Beta', order: 9 },
	'brave-nightly': { name: 'Brave Nightly', order: 10 },
	vivaldi: { name: 'Vivaldi', order: 11 },
	chromium: { name: 'Chromium', order: 12 }
};

function winCandidates(env) {
	const pf = env.ProgramFiles || 'C:\\Program Files';
	const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
	const local = env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local');
	const roots = [pf, pf86, local];
	const at = (sub, exe) => roots.map((r) => join(r, sub, 'Application', exe));
	return [
		['edge', at('Microsoft\\Edge', 'msedge.exe')],
		['edge-beta', at('Microsoft\\Edge Beta', 'msedge.exe')],
		['edge-dev', at('Microsoft\\Edge Dev', 'msedge.exe')],
		['edge-canary', at('Microsoft\\Edge SxS', 'msedge.exe')],
		['chrome', at('Google\\Chrome', 'chrome.exe')],
		['chrome-beta', at('Google\\Chrome Beta', 'chrome.exe')],
		['chrome-dev', at('Google\\Chrome Dev', 'chrome.exe')],
		['chrome-canary', at('Google\\Chrome SxS', 'chrome.exe')],
		['brave', at('BraveSoftware\\Brave-Browser', 'brave.exe')],
		['brave-beta', at('BraveSoftware\\Brave-Browser-Beta', 'brave.exe')],
		['brave-nightly', at('BraveSoftware\\Brave-Browser-Nightly', 'brave.exe')],
		['vivaldi', at('Vivaldi', 'vivaldi.exe')],
		['chromium', at('Chromium', 'chrome.exe')]
	];
}

function macCandidates(env) {
	const roots = ['/Applications', join(env.HOME || homedir(), 'Applications')];
	const app = (bundle, bin) => roots.map((r) => join(r, `${bundle}.app`, 'Contents', 'MacOS', bin));
	return [
		['edge', app('Microsoft Edge', 'Microsoft Edge')],
		['edge-beta', app('Microsoft Edge Beta', 'Microsoft Edge Beta')],
		['edge-dev', app('Microsoft Edge Dev', 'Microsoft Edge Dev')],
		['edge-canary', app('Microsoft Edge Canary', 'Microsoft Edge Canary')],
		['chrome', app('Google Chrome', 'Google Chrome')],
		['chrome-beta', app('Google Chrome Beta', 'Google Chrome Beta')],
		['chrome-dev', app('Google Chrome Dev', 'Google Chrome Dev')],
		['chrome-canary', app('Google Chrome Canary', 'Google Chrome Canary')],
		['brave', app('Brave Browser', 'Brave Browser')],
		['brave-beta', app('Brave Browser Beta', 'Brave Browser Beta')],
		['brave-nightly', app('Brave Browser Nightly', 'Brave Browser Nightly')],
		['vivaldi', app('Vivaldi', 'Vivaldi')],
		['chromium', app('Chromium', 'Chromium')]
	];
}

const LINUX_BINS = [
	['edge', ['microsoft-edge', 'microsoft-edge-stable']],
	['edge-beta', ['microsoft-edge-beta']],
	['edge-dev', ['microsoft-edge-dev']],
	['chrome', ['google-chrome', 'google-chrome-stable']],
	['chrome-beta', ['google-chrome-beta']],
	['chrome-dev', ['google-chrome-unstable']],
	['brave', ['brave-browser', 'brave']],
	['brave-beta', ['brave-browser-beta']],
	['brave-nightly', ['brave-browser-nightly']],
	['vivaldi', ['vivaldi', 'vivaldi-stable']],
	['chromium', ['chromium', 'chromium-browser']]
];

function linuxCandidates(env) {
	const dirs = [...new Set(['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome', ...String(env.PATH || '').split(':').filter(Boolean)])];
	return LINUX_BINS.map(([kind, bins]) => [kind, dirs.flatMap((d) => bins.map((b) => join(d, b)))]);
}

/** 注册表 App Paths：exe 名 → 路径（查不到返回 ''）。 */
function regAppPath(exe, hive) {
	return new Promise((resolve) => {
		try {
			execFile('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'],
				{ windowsHide: true, timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
					if (err) return resolve('');
					const m = String(stdout).match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
					resolve(m ? m[1].replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`) : '');
				});
		} catch { resolve(''); }
	});
}

/** 按路径猜 kind（注册表 / 手动指定的路径用）。 */
export function kindOfPath(p) {
	const s = String(p).replace(/\\/g, '/').toLowerCase();
	if (s.includes('edge sxs') || s.includes('edge canary')) return 'edge-canary';
	if (s.includes('edge beta')) return 'edge-beta';
	if (s.includes('edge dev')) return 'edge-dev';
	if (s.includes('msedge') || s.includes('microsoft edge') || s.includes('microsoft-edge')) return 'edge';
	if (s.includes('chrome sxs') || s.includes('chrome canary')) return 'chrome-canary';
	if (s.includes('chrome beta') || s.includes('chrome-beta')) return 'chrome-beta';
	if (s.includes('chrome dev') || s.includes('chrome-unstable')) return 'chrome-dev';
	if (s.includes('brave') && s.includes('nightly')) return 'brave-nightly';
	if (s.includes('brave') && s.includes('beta')) return 'brave-beta';
	if (s.includes('brave')) return 'brave';
	if (s.includes('vivaldi')) return 'vivaldi';
	if (s.includes('google/chrome') || s.includes('google chrome') || s.includes('google-chrome')) return 'chrome';
	if (s.includes('chromium')) return 'chromium';
	return '';
}

/** 版本号比较（"130.0.2849.68" 这种）。 */
function cmpVersion(a, b) {
	const pa = String(a).split('.').map(Number);
	const pb = String(b).split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d;
	}
	return 0;
}

function versionOf(exe, platform) {
	try {
		if (platform === 'win32') {
			const vs = readdirSync(dirname(exe)).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n)).sort(cmpVersion);
			return vs.length > 0 ? vs[vs.length - 1] : '';
		}
		if (platform === 'darwin') {
			const plist = readFileSync(join(dirname(dirname(exe)), 'Info.plist'), 'utf8');
			return (plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/) ?? ['', ''])[1];
		}
	} catch { /* 取不到版本也能用 */ }
	return '';
}

function versionByRun(exe) {
	return new Promise((resolve) => {
		try {
			execFile(exe, ['--version'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
				resolve(err ? '' : (String(stdout).match(/(\d+\.\d+\.\d+(?:\.\d+)?)/) ?? ['', ''])[1]);
			});
		} catch { resolve(''); }
	});
}

function realpath(p) {
	try { return realpathSync(p); } catch { return p; }
}

/** 手动指定路径的浏览器：profile 目录用路径哈希区分。 */
export function customKind(path) {
	return `custom-${createHash('sha1').update(String(path)).digest('hex').slice(0, 8)}`;
}

/**
 * 找本机的 Chromium 系浏览器。
 * @param {{platform?: string, env?: object, useRegistry?: boolean}} [opts]
 * @returns {Promise<Array<{kind: string, name: string, path: string, version: string}>>}
 */
export async function detectBrowsers({ platform = process.platform, env = process.env, useRegistry = true } = {}) {
	const lists = platform === 'win32' ? winCandidates(env) : platform === 'darwin' ? macCandidates(env) : linuxCandidates(env);
	const found = new Map();
	const add = (kind, path) => {
		if (!kind || !path || !existsSync(path)) return;
		const key = realpath(path).toLowerCase();
		for (const v of found.values()) if (v.key === key) return;
		if (found.has(kind)) return;
		found.set(kind, { kind, name: BROWSER_KINDS[kind]?.name ?? basename(path), path, key });
	};
	for (const [kind, paths] of lists) for (const p of paths) add(kind, p);
	if (platform === 'win32' && useRegistry) {
		for (const exe of ['msedge.exe', 'chrome.exe', 'brave.exe', 'vivaldi.exe']) {
			for (const hive of ['HKLM', 'HKCU']) {
				const p = await regAppPath(exe, hive);
				if (p) add(kindOfPath(p) || (exe === 'msedge.exe' ? 'edge' : exe.replace('.exe', '')), p);
			}
		}
	}
	const out = [];
	for (const v of found.values()) {
		let version = versionOf(v.path, platform);
		if (version === '' && platform !== 'win32' && platform !== 'darwin') version = await versionByRun(v.path);
		out.push({ kind: v.kind, name: v.name, path: v.path, version });
	}
	return out.sort((a, b) => (BROWSER_KINDS[a.kind]?.order ?? 99) - (BROWSER_KINDS[b.kind]?.order ?? 99));
}

/**
 * 按设置挑浏览器：手动路径优先，其次指定的 kind，再其次 Edge，最后随便一个。
 * @param {Array} list detectBrowsers() 的结果
 * @param {{kind?: string, customPath?: string}} pref
 */
export function pickBrowser(list, { kind = '', customPath = '' } = {}) {
	const p = String(customPath ?? '').trim();
	if (p !== '') {
		if (!existsSync(p)) return null;
		const k = kindOfPath(p);
		return { kind: customKind(p), name: k ? `${BROWSER_KINDS[k].name}（手动指定）` : basename(p), path: p, version: '', custom: true };
	}
	return list.find((b) => b.kind === kind) ?? list.find((b) => b.kind === 'edge') ?? list[0] ?? null;
}
