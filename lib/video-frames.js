// 抽帧：让 ffmpeg 直接读 B站 的播放地址，只解开头一段，抓 9 张拼成九宫格。
// 不整段下载（一条 20 分钟的视频上百 MB），实测 6.7 秒 / 136KB 出图。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** 九宫格：每 step 秒一格，每格缩放宽 480，拼 3×3。 */
export function buildFfmpegArgs({ url, out, seconds = 60, step = 6, cols = 3, rows = 3, skip = 3 }) {
	return [
		'-hide_banner', '-loglevel', 'error', '-y',
		// 跳过开头几秒（很多视频前 3 秒是台标/黑屏），只解 seconds 秒
		'-ss', String(skip), '-t', String(seconds),
		'-user_agent', 'Mozilla/5.0', '-referer', 'https://www.bilibili.com/',
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
	}
	return '';
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
export async function grabMontage(url, out, { ffmpeg = resolveFfmpeg(), seconds, step, signal } = {}) {
	if (ffmpeg === '') throw new Error('找不到 ffmpeg');
	await run(ffmpeg, buildFfmpegArgs({ url, out, seconds, step }), signal);
	if (!existsSync(out)) throw new Error('抽帧没出图');
	return out;
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
