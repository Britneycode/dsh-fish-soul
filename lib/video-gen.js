// 自己生成视频：把一句描述交给外部视频模型，等它出成品，下载成本地 mp4（抖音发作品用）。
// 生成视频是按次计费的写操作，所以配置默认关；下载环节不重试 ——
// 火山对同一条 video_url 的下载次数有上限（100 次），重试会把次数花光。
// 轮询是**只读**操作，所以 5xx / 网络抖动要重试（1s/2s/4s）：一次 502 就把已经付费的任务扔掉，
// 等于让用户白花一次钱。4xx（鉴权/参数错）才立刻放弃。
// 三家 provider 的提交/轮询形状不一样，但对上只暴露一个 generateVideo。
//
// 🔴 下载走 lib/safe-download.js：provider 回的地址是**不可信输入**（baseURL 是用户自己填的，
//    返回什么地址由它决定），不校验就是 SSRF —— 会打到本机的 DSH 接口、路由器后台、ollama。
//    逐块下、边下边写盘，不把整条视频收进内存。

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { safeDownloadStream } from './safe-download.js';
import { scrubSecrets } from './voice.js';

const MB = 1024 * 1024;
const PROVIDERS = new Set(['volc', 'minimax', 'openai-compat']);
const RATIOS = new Set(['16:9', '9:16', '1:1']);
const RESOLUTIONS = new Set(['480P', '768P', '2K']); // MiniMax 官方 resolution 枚举
const FREE_MIN = 1024 * MB; // 剩不到 1GB 就不生成：写一半失败比不生成更糟
const DOWNLOAD_TIMEOUT_MIN = 300_000; // 下载比接口慢，100MB 走弱网也要给够时间
const POLL_RETRY_DELAYS = [1000, 2000, 4000]; // 轮询重试的退避（只读操作，重试不花钱）
const DEFAULT_POLL_INTERVAL = 5_000;
const DEFAULT_POLL_BUDGET = 600_000;
const MIN_POLL_INTERVAL = 1_000; // 轮询间隔下限：配 1ms 会让 maxPolls 变成六十万轮，每轮挂一个 30s 超时定时器

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_STREAM_PREMATURE_CLOSE']);
const SPACE_CODES = new Set(['ENOSPC', 'EDQUOT']);
const PERM_CODES = new Set(['EACCES', 'EPERM']);
const PATH_CODES = new Set(['EEXIST', 'ENOTDIR', 'ENOENT']);

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
const pickUrl = (v) => {
	const s = typeof v === 'string' ? v.trim() : (v === undefined || v === null ? '' : String(v).trim());
	return s ? s : undefined;
};
const pickEnum = (v, set, dflt) => {
	const s = String(v ?? '').trim();
	return set.has(s) ? s : dflt;
};

/** 异常里的错误码（fetch 失败时真正的码藏在 cause 里）。 */
const errorCodeOf = (e) => {
	const c = e?.code ?? e?.cause?.code ?? e?.cause?.errors?.[0]?.code;
	return typeof c === 'string' ? c : '';
};

/**
 * 异常归类：只认错误码和错误名。
 * 原始 message 一律不往外带 —— 它可能带本机绝对路径（EEXIST: ... mkdir 'C:\Users\...'）。
 */
function classifyError(e, fallback) {
	const name = String(e?.name ?? '');
	if (name === 'TimeoutError' || name === 'AbortError') return 'TIMEOUT';
	const code = errorCodeOf(e);
	if (code === 'ERR_TOO_LARGE') return 'TOO_LARGE';
	if (SPACE_CODES.has(code)) return 'NO_SPACE';
	if (PERM_CODES.has(code)) return 'NO_PERMISSION';
	if (PATH_CODES.has(code)) return 'NOT_CONFIGURED';
	if (NETWORK_CODES.has(code)) return 'NETWORK';
	return fallback;
}

/**
 * 把原始配置收拾成稳定的形状。
 *
 * ⚠️ video.perDay 的范围（0~5、默认 1）以**本函数**为准（socialCfg 里也归一化了一遍，
 *    两边现在一致，改一处要改另一处）。真正「一天最多几次」在上层执行：发成功的条数记在
 *    douyin.video.day，花掉的次数记在 douyin.video.gen.day（见 douyin-social.js）。
 *    本层不拦 —— 配额计数要跨请求共享，属于上层的状态；这里只管「一次生成」的成败。
 */
export function videoGenConfig(raw = {}) {
	const r = (raw && typeof raw === 'object') ? raw : {};
	return {
		enabled: r.enabled === true,
		provider: PROVIDERS.has(r.provider) ? r.provider : 'volc',
		baseURL: String(r.baseURL ?? '').trim().replace(/\/+$/, ''),
		apiKey: String(r.apiKey ?? '').trim(),
		model: String(r.model ?? '').trim(),
		// 时长（秒）。**各 provider 时长限制不同，超出会被对方拒**（表现为 SUBMIT_FAILED，看不出是配置问题）：
		//   火山 Seedance 2.5：4~30（官方默认 -1 自动时长）；Seedance 1.0 pro 只有 2~12 → 这里取 4~12（三代都收得住）
		//   MiniMax H3：4~15，且只收整数；H3-Max 是 5~15（4 秒不支持）
		//   openai 兼容（Sora）：seconds 只认 '4'/'8'/'12'（官方 schema 是字符串枚举）
		// 公共下限取 4：2~3 秒火山和 MiniMax 都直接拒。
		durationSec: clampInt(r.durationSec, 4, 15, 5),
		aspectRatio: RATIOS.has(r.aspectRatio) ? r.aspectRatio : '9:16',
		// 分辨率（MiniMax 官方枚举 480P / 768P / 2K）。
		// 档位跟模型绑着：2K 只有 MiniMax-H3 支持，Highspeed / Lite / Max 只有 480P / 768P。
		// 错配在提交前由 minimaxResolutionOk 拦掉（不白花一次钱）。
		resolution: pickEnum(r.resolution, RESOLUTIONS, '768P'),
		perDay: clampInt(r.perDay, 0, 5, 1),
		timeoutMs: posInt(r.timeoutMs, 30_000),
		// 间隔有下限：配 1ms 会让轮询次数变成六十万轮（每轮一个 30s 超时定时器挂着），把内存吃光
		pollIntervalMs: Math.max(MIN_POLL_INTERVAL, posInt(r.pollIntervalMs, DEFAULT_POLL_INTERVAL)),
		pollBudgetMs: posInt(r.pollBudgetMs, DEFAULT_POLL_BUDGET),
		maxBytes: posInt(r.maxBytes, 100 * MB)
	};
}

/**
 * openai 兼容层的 size 是**像素尺寸**（官方 `POST /v1/videos` 的 string 枚举），
 * 不是比例 —— 直接传 '9:16' 会被对方 400 掉。
 *
 * 官方枚举只有四个：1280x720 / 720x1280（720p 横竖）、1024x1792 / 1792x1024（1080p 横竖）。
 * **没有正方形**，所以 1:1 只能落到 720x1280（离 1:1 更近，也跟本项目竖屏场景和官方默认值一致）。
 */
const OPENAI_SIZES = { '16:9': '1280x720', '9:16': '720x1280', '1:1': '720x1280' };
export function openaiSize(ratio) {
	return OPENAI_SIZES[ratio] ?? '720x1280';
}

/**
 * openai 兼容层的 seconds 只认 '4' / '8' / '12' —— 别的值对方会拒。
 * 我们的时长是 4~15 秒自由配的，提交时按就近吸附过去。
 *
 * ⚠️ 官方 schema 里 seconds 是**字符串**枚举（`'4'`/`'8'`/`'12'`），传数字 4 会被严格校验 400 掉。
 */
export function openaiSeconds(sec) {
	const n = Number(sec);
	if (!Number.isFinite(n) || n <= 4) return '4';
	if (n <= 8) return '8';
	return '12';
}

/**
 * MiniMax 的模型变体（Highspeed / Lite / Max），认不出来返回空串。
 *
 * ⚠️ 品牌名 MiniMax 本身就带 "Max"（Mini + Max），所以**不能**拿 "max" 子串去判 ——
 *    'MiniMax-H3' 会被误杀成不支持 2K。认的是变体后缀：'-Highspeed' / '-Lite' / '-Max'。
 */
function minimaxVariant(model) {
	const m = String(model ?? '');
	if (/-(?:highspeed)(?![a-z0-9])/i.test(m)) return 'highspeed';
	if (/-(?:lite)(?![a-z0-9])/i.test(m)) return 'lite';
	if (/-(?:max)(?![a-z0-9])/i.test(m)) return 'max';
	return '';
}

/**
 * MiniMax 的分辨率跟模型绑着（官方 schema 原文）：
 *   MiniMax-H3：768P / 2K
 *   Highspeed / Lite / Max：480P / 768P（`2K` is not supported）
 *
 * 只拦「明确是这三个变体却要 2K」这一种确定错配：模型名认不出来（别名 / 自建 endpoint）就放行。
 *
 * @param {string} model
 * @param {string} resolution
 * @returns {boolean} 能不能这么配
 */
export function minimaxResolutionOk(model, resolution) {
	if (String(resolution ?? '').trim().toUpperCase() !== '2K') return true;
	const v = minimaxVariant(model);
	return v !== 'highspeed' && v !== 'lite' && v !== 'max';
}

/**
 * MiniMax 的时长下限：官方 schema 里 MiniMax-H3-Max 是 5–15（4 秒不支持），其余变体是 4–15。
 */
const minimaxMinDuration = (model) => (minimaxVariant(model) === 'max' ? 5 : 4);

/**
 * 各 provider 实际会用的时长：超出各家范围就吸附到最近的合法值，不让对方拒。
 *
 * ⚠️ 各 provider 时长限制不同，超出会被对方拒：
 *   火山 Seedance：4~30（这里收窄到 4~12：Seedance 1.0 pro 的上限就是 12，三代模型都收得住）
 *   MiniMax H3：4~15，只收整数（H3-Max 是 5~15）
 *   openai 兼容（Sora）：只认 4/8/12（字符串枚举，见 openaiSeconds）
 *
 * @param {string} provider
 * @param {object} cfg 归一化后的配置（durationSec 已经是 [4,15] 的整数）
 * @returns {number|string} volc/minimax 给整数秒；openai-compat 给 '4'|'8'|'12' 字符串
 */
export function durationFor(provider, cfg) {
	const raw = Number(cfg?.durationSec);
	// 取整：官方 schema 里 duration 是 integer（5.5 会被严格校验拒掉）
	const sec = Number.isFinite(raw) ? Math.round(raw) : 5;
	if (provider === 'openai-compat') return openaiSeconds(raw);
	if (provider === 'minimax') return Math.min(15, Math.max(minimaxMinDuration(cfg?.model), sec));
	return Math.min(12, Math.max(4, sec)); // volc
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
			// ratio 官方 t2va（content 只有 text）要求给**具体比例**（不能是 adaptive），
			// 官方枚举 adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 —— 我们的三个都在里面。
			body: {
				model: cfg.model,
				duration: durationFor(provider, cfg),
				resolution: cfg.resolution,
				ratio: cfg.aspectRatio,
				generate_audio: false,
				content: [{ type: 'text', text }]
			}
		};
	}
	if (provider === 'openai-compat') {
		return {
			url: `${cfg.baseURL}/videos`,
			method: 'POST',
			headers,
			body: { model: cfg.model, prompt: text, seconds: durationFor(provider, cfg), size: openaiSize(cfg.aspectRatio) }
		};
	}
	return {
		url: `${cfg.baseURL}/contents/generations/tasks`,
		method: 'POST',
		headers,
		body: { model: cfg.model, content: [{ type: 'text', text }], ratio: cfg.aspectRatio, duration: durationFor(provider, cfg), generate_audio: false }
	};
}

/**
 * 查进度的请求（各家查任务的地方不一样）。
 *
 * MiniMax 官方文档里查询接口有两版，形状也不同：
 *  - v2（guides/video-generation）：GET /v2/query/video_generation/{task_id} → { task: { status, content: { url }, error } }
 *  - v1（api-reference）：GET /v1/query/video_generation?task_id= → { status, file_id, base_resp }
 * 两种都认（readPoll 里分开处理）；查的时候先 v2，404 再退 v1 —— 都是只读，重试不花钱。
 *
 * ⚠️ 提交走的是 v2（POST /v2/video_generation），所以轮询也是 v2 优先：不能提交 v2 却只轮询 v1。
 */
function buildPoll(provider, cfg, id) {
	const headers = { Authorization: `Bearer ${cfg.apiKey}` };
	if (provider === 'minimax') {
		return [
			{ url: `${cfg.baseURL}/v2/query/video_generation/${encodeURIComponent(id)}`, method: 'GET', headers },
			{ url: `${cfg.baseURL}/v1/query/video_generation?task_id=${encodeURIComponent(id)}`, method: 'GET', headers }
		];
	}
	if (provider === 'openai-compat') {
		return [{ url: `${cfg.baseURL}/videos/${encodeURIComponent(id)}`, method: 'GET', headers }];
	}
	return [{ url: `${cfg.baseURL}/contents/generations/tasks/${encodeURIComponent(id)}`, method: 'GET', headers }];
}

/** 失败原因翻成人话（各家失败时给的东西也不一样，都挨个试一遍）。 */
function failText(j, baseMsg) {
	// MiniMax v2 的失败原因在 task.error 里（{ code, message }），v1 才是顶层 error
	const raw = j.task?.error?.message ?? j.task?.error ?? j.error?.message ?? j.error ?? j.message ?? j.error?.msg ?? baseMsg;
	if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 200);
	if (raw && typeof raw === 'object') return JSON.stringify(raw).slice(0, 200);
	return '对方没说失败原因';
}

/**
 * 看一次轮询结果。
 *
 * MiniMax 的状态枚举（官方 v1）：Preparing / Queueing / Processing / Success / Fail
 * —— 转小写后是 preparing / queueing / processing / success / fail，
 * 所以认 success（不是 succeeded），失败是 fail（不是 failed）。
 * 它鉴权失败也回 HTTP 200，错误在 base_resp.status_code（真机：1004）。
 *
 * @param {string} provider
 * @param {object} json
 * @param {{apiKey?:string}} [opt]
 * @returns {{state:'queued'|'running'|'succeeded'|'failed'|'expired', url?:string, fileId?:string, error?:string}}
 */
export function readPoll(provider, json, { apiKey = '' } = {}) {
	const j = json && typeof json === 'object' ? json : {};
	// v1 平铺（{ status, file_id }），v2 套一层（{ task: { status, content: { url } } }）
	const t = (provider === 'minimax' && j.task && typeof j.task === 'object') ? j.task : j;
	const status = String(t.status ?? j.status ?? '').trim().toLowerCase();
	if (provider === 'minimax') {
		const br = j.base_resp ?? t.base_resp;
		const code = br?.status_code;
		if (code !== undefined && code !== null && Number(code) !== 0) {
			const msg = String(br?.status_msg ?? '').trim();
			return { state: 'failed', error: scrubSecrets(msg || `对方回了错误码 ${code}`, apiKey) };
		}
		if (status === 'success' || status === 'succeeded') {
			const url = pickUrl(t.content?.url ?? j.content?.url);
			const fileId = pickUrl(t.file_id ?? j.file_id);
			return { state: 'succeeded', url, fileId };
		}
		if (status === 'fail' || status === 'failed') return { state: 'failed', error: scrubSecrets(failText(j, br?.status_msg), apiKey) };
		if (status === 'cancelled' || status === 'canceled' || status === 'expired') return { state: 'expired' };
		if (status === 'queued') return { state: 'queued' };
		return { state: 'running' }; // Preparing / Queueing / Processing 都还在跑
	}
	if (provider === 'openai-compat') {
		if (status === 'completed' || status === 'succeeded') {
			const url = pickUrl(j.data?.[0]?.url ?? j.url ?? j.output?.url);
			return { state: 'succeeded', url };
		}
		if (status === 'failed') return { state: 'failed', error: scrubSecrets(failText(j), apiKey) };
		if (status === 'cancelled' || status === 'canceled' || status === 'expired') return { state: 'expired' };
		if (status === 'queued') return { state: 'queued' };
		return { state: 'running' };
	}
	if (status === 'succeeded') { const url = pickUrl(j.content?.video_url); return { state: 'succeeded', url }; }
	if (status === 'failed') return { state: 'failed', error: scrubSecrets(failText(j), apiKey) };
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
	NETWORK: '连不上视频模型的接口，这次没生成出来。',
	NO_PERMISSION: '没权限写视频目录（或密钥没权限），这次没生成出来。',
	TIMEOUT: '等太久了，这次没生成出来。',
	QUOTA: '今天的次数用完了，明天再来。', // 接线 PR 用：每日配额由上层执行
	UNKNOWN: '视频生成出了点岔子，这次没生成出来。'
};

/**
 * 给用户看的说法（不是代码）。
 * detail 只放白名单里的短信息（HTTP 状态码、对方说的失败原因）；
 * 原始异常消息不进这句话 —— 它可能带本机绝对路径。
 */
export function videoErrorText(code, detail = '', apiKey = '') {
	const base = ERROR_TEXT[code] ?? ERROR_TEXT.UNKNOWN;
	const d = scrubSecrets(String(detail ?? '').trim(), apiKey).slice(0, 120);
	return d ? `${base}（${d}）` : base;
}

/** mp4 的头：第 4 个字节起是 'ftyp'。 */
export function isMp4Bytes(buf) {
	if (!buf || buf.length < 8) return false;
	return buf.subarray(4, 8).toString('latin1') === 'ftyp';
}

const timeoutSignal = (ms, signal) => {
	// AbortSignal.timeout(undefined) 在 Node 会直接抛 TypeError，所以这里先兜一层
	const t = (Number.isFinite(ms) && ms > 0) ? AbortSignal.timeout(ms) : null;
	if (!t) return signal ?? new AbortController().signal;
	return signal ? AbortSignal.any([signal, t]) : t;
};

/** 把字节流写进 fd；超过上限就抛（上限按实际字节算，不信 Content-Length）。 */
async function writeBody(body, fd, maxBytes) {
	let size = 0;
	const put = (chunk) => {
		const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += b.length;
		if (size > maxBytes) {
			const err = new Error('超过下载大小上限');
			err.code = 'ERR_TOO_LARGE';
			throw err;
		}
		writeSync(fd, b);
	};
	if (body && typeof body.getReader === 'function') {
		const reader = body.getReader();
		try {
			for (;;) { const { done, value } = await reader.read(); if (done) break; put(value); }
		} finally {
			try { await reader.cancel(); } catch { /* 已经结束了 */ }
		}
	} else if (body && typeof body[Symbol.asyncIterator] === 'function') {
		for await (const chunk of body) put(chunk);
	} else if (body) {
		put(Buffer.from(await body.arrayBuffer()));
	}
	return size;
}

/**
 * 查一次进度。
 * - 5xx / 网络抖动：退避重试（轮询是只读操作，重试不花钱）
 * - 4xx：立刻放弃（鉴权/参数错，重试也没用）
 * - MiniMax 的查询地址有两版，404 就换另一个（state.idx 记住换过的，之后一直用能用的那个）
 */
async function pollOnce(fetchImpl, cands, cfg, signal, nap, state) {
	for (let attempt = 0; ; attempt++) {
		const c = cands[state.idx];
		let res = null;
		let err = null;
		try {
			res = await fetchImpl(c.url, { method: c.method, headers: c.headers, signal: timeoutSignal(cfg.timeoutMs, signal) });
		} catch (e) { err = e; }
		if (res && res.ok) return { ok: true, res };
		const status = res?.status ?? 0;
		if (status === 404 && state.idx < cands.length - 1) { state.idx++; continue; }
		const retryable = err !== null || status === 0 || status >= 500;
		if (!retryable || attempt >= POLL_RETRY_DELAYS.length) return { ok: false, status, error: err };
		await nap(POLL_RETRY_DELAYS[attempt]);
	}
}

/**
 * 两个地址是不是同一个源（协议 + 主机 + 端口全同）。
 *
 * 🔴 下载地址是 provider 回的（不可信），跟 baseURL 不同源就**不带 key**：
 *    MiniMax 官方的 download_url 挂在别的域名上，把付费 key 带过去等于送人。
 *    跨源下载按「对方是公开签名 URL、不需要鉴权」处理。
 */
function sameOrigin(a, b) {
	try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

/**
 * 生成一条视频并落盘。
 * 永不抛错：任何异常都变成 { ok:false, code, error }。
 *
 * ⚠️ 每日配额（video.perDay）由上层（接线 PR）负责执行，本层不拦 ——
 *    配额计数要跨请求共享，属于上层的状态。
 *
 * @param {object} rawCfg 原始配置（内部会过一遍 videoGenConfig 归一化）
 * @param {object} [opt]
 * @param {string} [opt.prompt]
 * @param {string} [opt.outDir]
 * @param {Function} [opt.fetchImpl]
 * @param {Function} [opt.sleep]
 * @param {Function} [opt.now]
 * @param {AbortSignal} [opt.signal]
 * @param {Function} [opt.downloadImpl] 下载器（默认 safeDownloadStream：逐跳校验、只连公网）
 * @returns {Promise<{ok:true, file:string, bytes:number, provider:string, elapsedMs:number}|{ok:false, code:string, error:string}>}
 */
export async function generateVideo(rawCfg, { prompt, outDir, fetchImpl = globalThis.fetch, sleep, now, signal, downloadImpl } = {}) {
	const cfg = videoGenConfig(rawCfg); // 归一化必须在这层做：漏了 pollBudgetMs 会让预算判断恒假 → 死循环
	const provider = cfg.provider;
	const nap = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
	// 时钟坏掉（返回 NaN）就退回真实时钟：预算判断恒假的话会一直查到天荒地老
	const clock = typeof now === 'function'
		? () => { const raw = now(); return Number.isFinite(raw) ? raw : Date.now(); }
		: () => Date.now();
	const download = typeof downloadImpl === 'function' ? downloadImpl : safeDownloadStream;
	const fail = (code, detail = '') => ({ ok: false, code, error: videoErrorText(code, detail, cfg.apiKey) });
	let t0 = 0;
	try {
		if (!cfg.enabled) return fail('DISABLED');
		if (!cfg.baseURL || !cfg.apiKey || !cfg.model || !outDir) return fail('NOT_CONFIGURED');
		// 分辨率跟模型绑着：2K 只有 MiniMax-H3 支持。错配就别发出去让对方拒（提交是花钱的）
		if (provider === 'minimax' && !minimaxResolutionOk(cfg.model, cfg.resolution)) {
			return fail('NOT_CONFIGURED', `${cfg.model} 不支持 2K（只有 480P / 768P），把分辨率改成 768P`);
		}
		mkdirSync(outDir, { recursive: true });
		const free = statfsSync(outDir);
		if (Number(free.bavail) * Number(free.bsize) < FREE_MIN) return fail('NO_SPACE');
		t0 = clock();

		// 提交
		const submit = buildSubmit(provider, cfg, prompt);
		let submitted = null;
		try {
			submitted = await fetchImpl(submit.url, {
				method: submit.method,
				headers: submit.headers,
				body: JSON.stringify(submit.body),
				signal: timeoutSignal(cfg.timeoutMs, signal)
			});
		} catch (e) {
			return fail(classifyError(e, 'NETWORK'));
		}
		if (!submitted || !submitted.ok) return fail('SUBMIT_FAILED', `接口返回 ${submitted?.status ?? '未知'}`);
		let sj = null;
		try { sj = await submitted.json(); } catch { sj = null; }
		const rawId = provider === 'minimax' ? sj?.task_id : sj?.id;
		const id = rawId === undefined || rawId === null || rawId === '' ? '' : String(rawId);
		if (!id) return fail('SUBMIT_FAILED', '没拿到任务号');

		// 轮询：预算检查放在循环里（只在开头查一次的话，任务一直不结束就会一直转下去）；
		// 轮询次数另有硬上限（时钟坏了也不能把任务查一辈子）
		const cands = buildPoll(provider, cfg, id);
		const state = { idx: 0 };
		const maxPolls = Math.max(1, Math.ceil(cfg.pollBudgetMs / cfg.pollIntervalMs) + 2);
		let videoURL = '';
		let fileId = '';
		let polls = 0;
		for (;;) {
			if (clock() - t0 > cfg.pollBudgetMs) return fail('POLL_TIMEOUT');
			if (polls >= maxPolls) return fail('POLL_TIMEOUT');
			polls++;
			await nap(cfg.pollIntervalMs);
			const got = await pollOnce(fetchImpl, cands, cfg, signal, nap, state);
			if (!got.ok) {
				if (got.error) return fail(classifyError(got.error, 'NETWORK'));
				return fail('UNKNOWN', `查进度失败：接口返回 ${got.status || '未知'}`);
			}
			let pj = null;
			try { pj = await got.res.json(); } catch { pj = null; }
			const st = readPoll(provider, pj, { apiKey: cfg.apiKey });
			if (st.state === 'succeeded') { videoURL = st.url ?? ''; fileId = st.fileId ?? ''; break; }
			if (st.state === 'failed') return fail('TASK_FAILED', st.error);
			if (st.state === 'expired') return fail('TASK_EXPIRED');
		}

		// MiniMax 成功时给的是 file_id，不是地址：再问一次要下载地址（只读操作，不花钱）
		if (provider === 'minimax' && !videoURL && fileId) {
			const got = await getJson(fetchImpl, `${cfg.baseURL}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, { Authorization: `Bearer ${cfg.apiKey}` }, cfg, signal);
			if (!got.ok) {
				if (got.error) return fail(classifyError(got.error, 'NETWORK'));
				return fail('DOWNLOAD_FAILED', `接口返回 ${got.status || '未知'}`);
			}
			const br = got.json?.base_resp;
			if (br?.status_code !== undefined && Number(br.status_code) !== 0) {
				return fail('DOWNLOAD_FAILED', `对方回了错误码 ${br.status_code}`);
			}
			videoURL = pickUrl(got.json?.file?.download_url) ?? '';
		}

		// 下载：先写 .part，写完再改名（中途挂掉不会留下半个 mp4）
		const base = `video-${Date.now()}-${randomBytes(4).toString('hex')}`;
		const partPath = join(outDir, `${base}.part`);
		const finalPath = join(outDir, `${base}.mp4`);
		let fd = null;
		let size = 0;
		try {
			if (provider === 'openai-compat' && !videoURL) {
				// openai 官方形状：视频对象里没有地址（只有 id/status/progress），字节在 /videos/{id}/content
				const res = await fetchImpl(`${cfg.baseURL}/videos/${encodeURIComponent(id)}/content`, {
					method: 'GET',
					headers: { Authorization: `Bearer ${cfg.apiKey}` },
					signal: timeoutSignal(Math.max(cfg.timeoutMs, DOWNLOAD_TIMEOUT_MIN), signal)
				});
				if (!res || !res.ok) return fail('DOWNLOAD_FAILED', `接口返回 ${res?.status ?? '未知'}`);
				fd = openSync(partPath, 'w');
				size = await writeBody(res.body, fd, cfg.maxBytes);
			} else {
				if (!videoURL) return fail('NO_URL');
				const dl = await download(videoURL, {
					maxBytes: cfg.maxBytes,
					timeoutMs: Math.max(cfg.timeoutMs, DOWNLOAD_TIMEOUT_MIN),
					// 只有跟 baseURL 同源才带 key：provider 回的下载地址常常是第三方域名（公开签名 URL，不用鉴权）
					headers: sameOrigin(videoURL, cfg.baseURL) ? { Authorization: `Bearer ${cfg.apiKey}` } : {}
				});
				if (!dl) return fail('DOWNLOAD_FAILED');
				// 不信 Content-Type，只信实际字节；但声明的大小能提前挡住，就先挡一道
				const declared = Number(dl.headers?.['content-length']);
				if (Number.isFinite(declared) && declared > cfg.maxBytes) return fail('TOO_LARGE', `声明 ${Math.round(declared / MB)}MB`);
				fd = openSync(partPath, 'w');
				size = await writeBody(dl.body, fd, cfg.maxBytes);
			}
			closeSync(fd);
			fd = null;
			renameSync(partPath, finalPath);
		} catch (e) {
			return fail(classifyError(e, 'DOWNLOAD_FAILED'));
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
		return fail(classifyError(error, 'UNKNOWN'));
	}
}

/** 问服务商要个 JSON（只读操作，失败不重试）。 */
async function getJson(fetchImpl, url, headers, cfg, signal) {
	try {
		const res = await fetchImpl(url, { method: 'GET', headers, signal: timeoutSignal(cfg.timeoutMs, signal) });
		if (!res || !res.ok) return { ok: false, status: res?.status ?? 0 };
		let json = null;
		try { json = await res.json(); } catch { json = null; }
		return { ok: true, json };
	} catch (e) {
		return { ok: false, error: e };
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
