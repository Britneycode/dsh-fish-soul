// 抽帧：让 ffmpeg 直接读 B站 的播放地址，只解开头一段，抓 9 张拼成九宫格。
// 不整段下载（一条 20 分钟的视频上百 MB），实测 6.7 秒 / 136KB 出图。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/**
 * 九宫格：每 step 秒一格，每格缩放宽 480，拼 3×3。
 *
 * `referer` / `userAgent` 可覆盖：B站 和抖音 的 CDN 都校验 referer，
 * 写死成 bilibili 会让抖音的直链被 403（2026-11-08 实测）。
 */
export function buildFfmpegArgs({ url, out, seconds = 60, step = 6, cols = 3, rows = 3, skip = 3, referer = 'https://www.bilibili.com/', userAgent = 'Mozilla/5.0' }) {
	return [
		'-hide_banner', '-loglevel', 'error', '-y',
		// 跳过开头几秒（很多视频前 3 秒是台标/黑屏），只解 seconds 秒
		'-ss', String(skip), '-t', String(seconds),
		'-user_agent', userAgent, '-referer', referer,
		'-i', url,
		'-vf', `fps=1/${step},scale=480:-2,tile=${cols}x${rows}`,
		'-frames:v', '1', '-q:v', '4', out
	];
}

/** 找 ffmpeg：环境变量 → PATH → winget 装的那个。找不到返回 ''。 */
export function resolveFfmpeg() {
	const env = String(process.env.FFMPEG_PATH ?? '').trim();
	if (env !== '' && existsSync(env)) return env;
	const win = process.platform === 'win32';
	const name = win ? 'ffmpeg.exe' : 'ffmpeg';
	for (const d of String(process.env.PATH ?? '').split(win ? ';' : ':').filter(Boolean)) {
		const p = join(d, name);
		if (existsSync(p)) return p;
	}
	if (win) {
		const base = join(process.env.LOCALAPPDATA ?? homedir(), 'Microsoft', 'WinGet', 'Packages');
		try {
			for (const dir of readdirSync(base)) {
				if (!/ffmpeg/i.test(dir)) continue;
				const root = join(base, dir);
				for (const sub of readdirSync(root)) {
					const p = join(root, sub, 'bin', name);
					if (existsSync(p)) return p;
				}
			}
		} catch { /* 没有 winget 目录 */ }
		// 装了剪映 / 其它剪辑软件的话，它们自带完整的 ffmpeg —— 比 PATH 里没有强
		// （2026-11-08 实测：这台机器 PATH 和 winget 都没有，只有剪映那份能用）
		for (const p of bundledFfmpegCandidates()) if (existsSync(p)) return p;
	}
	return '';
}

/**
 * 常见软件自带的 ffmpeg（Windows）。只在 PATH / winget 都没有时才用。
 * 剪映的版本号会随更新变，所以按目录扫而不是写死路径。
 */
function bundledFfmpegCandidates() {
	const out = [];
	const roots = [
		join('D:', 'App', 'JianyingPro'),
		join('C:', 'Program Files', 'JianyingPro'),
		join('C:', 'Program Files (x86)', 'JianyingPro'),
		join(process.env.LOCALAPPDATA ?? homedir(), 'JianyingPro'),
		join(process.env.ProgramFiles ?? 'C:\\Program Files', 'CapCut'),
	];
	for (const root of roots) {
		try {
			for (const ver of readdirSync(root)) out.push(join(root, ver, 'ffmpeg.exe'));
		} catch { /* 没装这个软件 */ }
	}
	// 版本越新越可能完整，倒序试
	return out.sort().reverse();
}

/** 取 720p 单文件播放地址（fnval=1 不要 DASH）。client.call 返回整包 { code, data }。 */
export async function playUrl(client, bvid, cid, qn = 80) {
	const json = await client.call('api', '/x/player/playurl', {
		params: { bvid, cid, qn, fnval: 1, platform: 'pc', high_quality: 1 },
		referer: 'https://www.bilibili.com/'
	});
	const durl = (json?.data ?? json)?.durl?.[0];
	if (!durl?.url) throw new Error('没有拿到播放地址');
	return { url: String(durl.url).replace(/&amp;/g, '&'), size: Number(durl.size ?? 0) };
}

function run(ffmpeg, args, signal) {
	return new Promise((resolve, reject) => {
		const p = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
		const onAbort = () => { try { p.kill(); } catch { /* 已经退了 */ } };
		signal?.addEventListener?.('abort', onAbort, { once: true });
		p.on('error', (e) => { signal?.removeEventListener?.('abort', onAbort); reject(e); });
		p.on('close', (code) => {
			signal?.removeEventListener?.('abort', onAbort);
			if (signal?.aborted) return reject(new Error('已取消'));
			code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`));
		});
	});
}

/** 拼一张九宫格写到 out。 */
export async function grabMontage(url, out, { ffmpeg = resolveFfmpeg(), seconds, step, referer, userAgent, signal } = {}) {
	if (ffmpeg === '') throw new Error('找不到 ffmpeg');
	await run(ffmpeg, buildFfmpegArgs({ url, out, seconds, step, referer, userAgent }), signal);
	if (!existsSync(out)) throw new Error('抽帧没出图');
	return out;
}

// 抖音的 CDN 校验 referer，而且 UA 要求是完整浏览器串（实测空 UA 会被 403）
const DOUYIN_REFERER = 'https://www.douyin.com/';
const DOUYIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/**
 * 抖音抽帧：play_addr 直链 → ffmpeg 远程抽帧 → base64。
 *
 * play_addr.url_list 里常有多个备份域名，逐个试（有的是 403 有的是超时）。
 * 和 B站 那条一样：任何一步失败都抛错，调用方自己决定要不要退回纯文字。
 *
 * @param {string[]} urls play_addr.url_list
 * @param {{dir?:string, seconds?:number, step?:number, signal?:AbortSignal, id?:string}} o
 * @returns {Promise<{data:string, mediaType:string, name:string, bytes:number}>}
 */
export async function douyinFrames(urls, { dir, seconds, step, durationMs = 0, signal, id = 'video' } = {}) {
	const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && u !== '');
	if (list.length === 0) throw new Error('没有播放地址');
	const work = dir ?? join(tmpdir(), 'fish-soul-frames');
	mkdirSync(work, { recursive: true });
	const out = join(work, `dy-${id}-${Date.now()}.jpg`);
	// 抖音的视频普遍很短（15~60 秒）。固定按 60 秒取 9 格，短视频会只出 2~3 格、
	// 下面全黑（2026-11-08 实测：30 秒的视频只出 3 格）。按真实时长铺满 9 格。
	const span = durationMs > 0 ? Math.max(3, Math.floor(durationMs / 1000) - 1) : (seconds ?? 60);
	const gap = Math.max(1, Math.round(span / 9));
	const secs = seconds ?? span;
	let lastError = null;
	try {
		for (const url of list) {
			try {
				await grabMontage(url, out, { seconds: secs, step: step ?? gap, referer: DOUYIN_REFERER, userAgent: DOUYIN_UA, signal });
				const bytes = readFileSync(out);
				return { data: bytes.toString('base64'), mediaType: 'image/jpeg', name: `douyin-${id}-frames.jpg`, bytes: bytes.length };
			} catch (error) {
				lastError = error;
				// 换下一个备份域名再试；signal 取消就别继续了
				if (signal?.aborted) break;
			}
		}
		throw lastError ?? new Error('抽帧失败');
	} finally {
		try { rmSync(out, { force: true }); } catch { /* 删不掉就留着 */ }
	}
}

/**
 * 一步到位：取地址 → ffmpeg 远程抽帧 → 读成 base64 → 删临时文件。
 * 返回 { data, mediaType, name, bytes }；任何一步失败都抛错，调用方自己决定要不要重试。
 */
export async function videoFrames(client, { bvid, cid, dir, seconds = 60, step = 6, signal } = {}) {
	if (!bvid || !cid) throw new Error('缺 bvid / cid');
	const work = dir ?? join(tmpdir(), 'fish-soul-frames');
	mkdirSync(work, { recursive: true });
	const out = join(work, `${bvid}-${Date.now()}.jpg`);
	try {
		const { url } = await playUrl(client, bvid, cid);
		await grabMontage(url, out, { seconds, step, signal });
		const bytes = readFileSync(out);
		return { data: bytes.toString('base64'), mediaType: 'image/jpeg', name: `${bvid}-frames.jpg`, bytes: bytes.length };
	} finally {
		try { rmSync(out, { force: true }); } catch { /* 删不掉就留着 */ }
	}
}
