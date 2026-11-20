// 自己生成视频：把一句描述交给外部视频模型，等它出成品，下载成本地 mp4（抖音发作品用）。
// 生成视频是按次计费的写操作，所以配置默认关；下载环节不重试 ——
// 火山对同一条 video_url 的下载次数有上限（100 次），重试会把次数花光。
// 三家 provider 的提交/轮询形状不一样，但对上只暴露一个 generateVideo。

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

const MB = 1024 * 1024;
const PROVIDERS = new Set(['volc', 'minimax', 'openai-compat']);
const RATIOS = new Set(['16:9', '9:16', '1:1']);
const FREE_MIN = 1024 * MB; // 剩不到 1GB 就不生成：写一半失败比不生成更糟
const DOWNLOAD_TIMEOUT_MIN = 300_000; // 下载比接口慢，100MB 走弱网也要给够时间

const num = (v) => (v === null || v === undefined || v === '') ? NaN : Number(v);
const clampInt = (v, min, max, dflt) => {
	const n = num(v);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(max, Math.max(min, Math.floor(n)));
};
const posInt = (v, dflt) => {
	const n = num(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
const messageOf = (e) => (e && e.message) ? String(e.message) : String(e);

/** 把原始配置收拾成稳定的形状。 */
export function videoGenConfig(raw = {}) {
	return {
		enabled: raw.enabled === true,
		provider: PROVIDERS.has(raw.provider) ? raw.provider : 'volc',
		baseURL: String(raw.baseURL ?? '').trim().replace(/\/+$/, ''),
		apiKey: String(raw.apiKey ?? '').trim(),
		model: String(raw.model ?? '').trim(),
		durationSec: clampInt(raw.durationSec, 2, 12, 5),
		aspectRatio: RATIOS.has(raw.aspectRatio) ? raw.aspectRatio : '9:16',
		perDay: clampInt(raw.perDay, 0, 5, 1),
		timeoutMs: posInt(raw.timeoutMs, 30_000),
		pollIntervalMs: posInt(raw.pollIntervalMs, 5_000),
		pollBudgetMs: posInt(raw.pollBudgetMs, 600_000),
		maxBytes: posInt(raw.maxBytes, 100 * MB)
	};
}

/** 提交生成的请求体（各家形状不一样）。 */
export function buildSubmit(provider, cfg, prompt) {
	const text = String(prompt ?? '');
	const headers = { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' };
	if (provider === 'minimax') {
		return {
			url: `${cfg.baseURL}/v2/video_generation`,
			method: 'POST',
			headers,
			body: { model: cfg.model, duration: cfg.durationSec, resolution: '768P', generate_audio: false, content: [{ type: 'text', text }] }
		};
	}
	if (provider === 'openai-compat') {
		return {
			url: `${cfg.baseURL}/videos`,
			method: 'POST',
			headers,
			body: { model: cfg.model, prompt: text, seconds: cfg.durationSec, size: cfg.aspectRatio }
		};
	}
	return {
		url: `${cfg.baseURL}/contents/generations/tasks`,
		method: 'POST',
		headers,
		body: { model: cfg.model, content: [{ type: 'text', text }], ratio: cfg.aspectRatio, duration: cfg.durationSec, generate_audio: false }
	};
}

/** 查进度的请求（各家查任务的地方不一样）。 */
function buildPoll(provider, cfg, id) {
	const headers = { Authorization: `Bearer ${cfg.apiKey}` };
	if (provider === 'minimax') {
		return { url: `${cfg.baseURL}/v2/query/video_generation?task_id=${encodeURIComponent(id)}`, method: 'GET', headers };
	}
	if (provider === 'openai-compat') {
		return { url: `${cfg.baseURL}/videos/${encodeURIComponent(id)}`, method: 'GET', headers };
	}
	return { url: `${cfg.baseURL}/contents/generations/tasks/${encodeURIComponent(id)}`, method: 'GET', headers };
}

const pickUrl = (v) => {
	const s = typeof v === 'string' ? v.trim() : (v === undefined || v === null ? '' : String(v).trim());
	return s ? s : undefined;
};

/** 失败原因翻成人话（各家失败时给的东西也不一样，都挨个试一遍）。 */
function failText(j) {
	const raw = j.error?.message ?? j.error ?? j.message ?? j.error?.msg;
	if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 200);
	if (raw && typeof raw === 'object') return JSON.stringify(raw).slice(0, 200);
	return '对方没说失败原因';
}

/**
 * 看一次轮询结果。
 * @returns {{state:'queued'|'running'|'succeeded'|'failed'|'expired', url?:string, error?:string}}
 */
export function readPoll(provider, json) {
	const j = json && typeof json === 'object' ? json : {};
	const status = String(j.status ?? '').trim().toLowerCase();
	if (provider === 'minimax') {
		if (status === 'succeeded') { const url = pickUrl(j.content?.url); return url ? { state: 'succeeded', url } : { state: 'succeeded' }; }
		if (status === 'failed') return { state: 'failed', error: failText(j) };
		if (status === 'cancelled') return { state: 'expired' };
		if (status === 'queued') return { state: 'queued' };
		return { state: 'running' };
	}
	if (provider === 'openai-compat') {
		if (status === 'completed' || status === 'succeeded') {
			const url = pickUrl(j.data?.[0]?.url ?? j.url ?? j.output?.url);
			return url ? { state: 'succeeded', url } : { state: 'succeeded' };
		}
		if (status === 'failed') return { state: 'failed', error: failText(j) };
		if (status === 'cancelled') return { state: 'expired' };
		if (status === 'queued') return { state: 'queued' };
		return { state: 'running' };
	}
	if (status === 'succeeded') { const url = pickUrl(j.content?.video_url); return url ? { state: 'succeeded', url } : { state: 'succeeded' }; }
	if (status === 'failed') return { state: 'failed', error: failText(j) };
	if (status === 'expired') return { state: 'expired' };
	if (status === 'queued') return { state: 'queued' };
	return { state: 'running' }; // 没见过的状态当成还在跑：宁可多等一轮，别把在跑的任务判死
}

const ERROR_TEXT = {
	DISABLED: '没开视频生成，所以没生成。',
	NOT_CONFIGURED: '视频生成还没配好（要填接口地址、密钥和模型名），所以没生成。',
	SUBMIT_FAILED: '视频模型那边没能接下这个活，生成没开始。',
	POLL_TIMEOUT: '等太久了，视频模型那边一直没出结果，这次先算了。',
	TASK_FAILED: '视频模型那边做失败了，这次没生成出来。',
	TASK_EXPIRED: '这个视频任务过期了（大概排太久），这次没生成出来。',
	DOWNLOAD_FAILED: '视频生成出来了，但没下载下来。',
	TOO_LARGE: '视频太大了，没存下来。',
	NO_URL: '视频模型说好了，但没给下载地址，这次没生成出来。',
	BAD_VIDEO: '下载回来的不是视频文件，没存下来。',
	NO_SPACE: '硬盘剩的空间不够放视频，这次没生成。',
	UNKNOWN: '视频生成出了点岔子，这次没生成出来。'
};

/** 给用户看的说法（不是代码）。 */
export function videoErrorText(code, detail = '') {
	const base = ERROR_TEXT[code] ?? ERROR_TEXT.UNKNOWN;
	const d = String(detail ?? '').trim();
	return d ? `${base}（${d}）` : base;
}

/** mp4 的头：第 4 个字节起是 'ftyp'。 */
export function isMp4Bytes(buf) {
	if (!buf || buf.length < 8) return false;
	return buf.subarray(4, 8).toString('latin1') === 'ftyp';
}

const headerOf = (res, name) => {
	const h = res?.headers;
	if (!h) return null;
	if (typeof h.get === 'function') return h.get(name);
	const key = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
	return key ? String(h[key]) : null;
};

const timeoutSignal = (ms, signal) => {
	const t = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, t]) : t;
};

/**
 * 生成一条视频并落盘。
 * 永不抛错：任何异常都变成 { ok:false, code, error }。
 * @returns {Promise<{ok:true, file:string, bytes:number, provider:string, elapsedMs:number}|{ok:false, code:string, error:string}>}
 */
export async function generateVideo(cfg, { prompt, outDir, fetchImpl = globalThis.fetch, sleep, now, signal } = {}) {
	const provider = PROVIDERS.has(cfg?.provider) ? cfg.provider : 'volc';
	const nap = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
	const clock = typeof now === 'function' ? now : () => Date.now();
	const fail = (code, detail = '') => ({ ok: false, code, error: videoErrorText(code, detail) });
	let t0 = 0;
	try {
		if (cfg?.enabled !== true) return fail('DISABLED');
		if (!cfg.baseURL || !cfg.apiKey || !cfg.model || !outDir) return fail('NOT_CONFIGURED');
		mkdirSync(outDir, { recursive: true });
		const free = statfsSync(outDir);
		if (Number(free.bavail) * Number(free.bsize) < FREE_MIN) return fail('NO_SPACE');
		t0 = clock();

		// 提交
		const submit = buildSubmit(provider, cfg, prompt);
		const submitted = await fetchImpl(submit.url, {
			method: submit.method,
			headers: submit.headers,
			body: JSON.stringify(submit.body),
			signal: timeoutSignal(cfg.timeoutMs, signal)
		});
		if (!submitted || !submitted.ok) return fail('SUBMIT_FAILED', `接口返回 ${submitted?.status ?? '未知'}`);
		let sj = null;
		try { sj = await submitted.json(); } catch { sj = null; }
		const rawId = provider === 'minimax' ? sj?.task_id : sj?.id;
		const id = rawId === undefined || rawId === null || rawId === '' ? '' : String(rawId);
		if (!id) return fail('SUBMIT_FAILED', '没拿到任务号');

		// 轮询：预算检查放在循环里（只在开头查一次的话，任务一直不结束就会一直转下去）
		const poll = buildPoll(provider, cfg, id);
		let videoURL = '';
		for (;;) {
			if (clock() - t0 > cfg.pollBudgetMs) return fail('POLL_TIMEOUT');
			await nap(cfg.pollIntervalMs);
			const res = await fetchImpl(poll.url, {
				method: poll.method,
				headers: poll.headers,
				signal: timeoutSignal(cfg.timeoutMs, signal)
			});
			if (!res || !res.ok) return fail('UNKNOWN', `查进度失败：接口返回 ${res?.status ?? '未知'}`);
			let pj = null;
			try { pj = await res.json(); } catch { pj = null; }
			const st = readPoll(provider, pj);
			if (st.state === 'succeeded') { videoURL = st.url ?? ''; break; }
			if (st.state === 'failed') return fail('TASK_FAILED', st.error);
			if (st.state === 'expired') return fail('TASK_EXPIRED');
		}
		if (!videoURL) return fail('NO_URL');

		// 下载：先写 .part，写完再改名（中途挂掉不会留下半个 mp4）
		const base = `video-${Date.now()}-${randomBytes(4).toString('hex')}`;
		const partPath = join(outDir, `${base}.part`);
		const finalPath = join(outDir, `${base}.mp4`);
		let fd = null;
		let size = 0;
		try {
			const dl = await fetchImpl(videoURL, {
				method: 'GET',
				signal: timeoutSignal(Math.max(cfg.timeoutMs, DOWNLOAD_TIMEOUT_MIN), signal)
			});
			if (!dl || !dl.ok) return fail('DOWNLOAD_FAILED', `下载返回 ${dl?.status ?? '未知'}`);
			// 不信 Content-Type，只信实际字节；但声明的大小能提前挡住，就先挡一道
			const declared = Number(headerOf(dl, 'content-length'));
			if (Number.isFinite(declared) && declared > cfg.maxBytes) return fail('TOO_LARGE', `声明 ${Math.round(declared / MB)}MB`);
			fd = openSync(partPath, 'w');
			const stream = dl.body;
			if (stream && typeof stream.getReader === 'function') {
				const reader = stream.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						size += value.byteLength;
						if (size > cfg.maxBytes) {
							try { await reader.cancel(); } catch { /* 已经断了 */ }
							return fail('TOO_LARGE', `超过 ${Math.round(cfg.maxBytes / MB)}MB`);
						}
						writeSync(fd, Buffer.from(value));
					}
				} finally {
					try { await reader.cancel(); } catch { /* 已经结束了 */ }
				}
			} else {
				const buf = Buffer.from(await dl.arrayBuffer());
				size = buf.length;
				if (size > cfg.maxBytes) return fail('TOO_LARGE', `超过 ${Math.round(cfg.maxBytes / MB)}MB`);
				writeSync(fd, buf);
			}
			closeSync(fd);
			fd = null;
			renameSync(partPath, finalPath);
		} catch (e) {
			return fail('DOWNLOAD_FAILED', messageOf(e));
		} finally {
			if (fd !== null) { try { closeSync(fd); } catch { /* 已经关了 */ } }
			// 还没改名成功就删掉半截文件，别把 .part 留在盘上
			if (existsSync(partPath)) { try { unlinkSync(partPath); } catch { /* 删不掉就算了 */ } }
		}

		// 落地的东西得真是视频：只认文件头，不认后缀和 Content-Type
		let head = Buffer.alloc(0);
		const hfd = openSync(finalPath, 'r');
		try {
			head = Buffer.alloc(12);
			const got = readSync(hfd, head, 0, 12, 0);
			head = head.subarray(0, got);
		} finally {
			closeSync(hfd);
		}
		if (!isMp4Bytes(head)) {
			try { unlinkSync(finalPath); } catch { /* 删不掉就算了 */ }
			return fail('BAD_VIDEO');
		}
		return { ok: true, file: resolve(finalPath), bytes: size, provider, elapsedMs: clock() - t0 };
	} catch (error) {
		return { ok: false, code: 'UNKNOWN', error: videoErrorText('UNKNOWN', messageOf(error)) };
	}
}

/**
 * 清理生成的视频：超龄 → 超数 → 超量，三条闸按顺序走。
 * @returns {number} 删掉的文件数
 */
export function pruneVideos(dir, { keepDays = 3, maxFiles = 20, maxBytes = 500 * 1024 * 1024 } = {}) {
	if (!dir || !existsSync(dir)) return 0;
	let removed = 0;
	const drop = (f) => { try { unlinkSync(f.path); removed++; } catch { /* 删不掉就算了 */ } };
	const scan = () => readdirSync(dir)
		.filter((f) => f.endsWith('.mp4'))
		.map((f) => {
			try { const st = statSync(join(dir, f)); return { path: join(dir, f), name: f, size: st.size, mtime: st.mtimeMs }; }
			catch { return null; }
		})
		.filter(Boolean)
		.sort((a, b) => b.mtime - a.mtime); // 新的在前
	// 1) 超龄
	const cutoff = Date.now() - keepDays * 86400000;
	for (const f of scan()) if (f.mtime < cutoff) drop(f);
	// 2) 超数：留最新的那几个
	let cur = scan();
	if (cur.length > maxFiles) for (const f of cur.slice(maxFiles)) drop(f);
	// 3) 超量：从最旧的开始删
	cur = scan();
	let total = cur.reduce((n, f) => n + f.size, 0);
	for (const f of cur.slice().reverse()) {
		if (total <= maxBytes) break;
		drop(f);
		total -= f.size;
	}
	return removed;
}
