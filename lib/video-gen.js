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
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { safeDownloadStream } from './safe-download.js';
import { scrubSecrets } from './voice.js';

const MB = 1024 * 1024;
const PROVIDERS = new Set(['volc', 'minimax', 'openai-compat', 'openmotion']);
const OPENMOTION_DEFAULT_URL = 'http://127.0.0.1:4173';
const OPENMOTION_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const RATIOS = new Set(['16:9', '9:16', '1:1']);
const RESOLUTIONS = new Set(['480P', '768P', '2K']); // MiniMax 官方 resolution 枚举
const FREE_MIN = 1024 * MB; // 剩不到 1GB 就不生成：写一半失败比不生成更糟
const DOWNLOAD_TIMEOUT_MIN = 300_000; // 下载比接口慢，100MB 走弱网也要给够时间
const POLL_RETRY_DELAYS = [1000, 2000, 4000]; // 轮询重试的退避（只读操作，重试不花钱）
const DEFAULT_POLL_INTERVAL = 5_000;
const DEFAULT_POLL_BUDGET = 600_000;
const MIN_POLL_INTERVAL = 1_000; // 轮询间隔下限：配 1ms 会让 maxPolls 变成六十万轮，每轮挂一个 30s 超时定时器
const MAX_TIMEOUT_MS = 2_147_483_647; // Node AbortSignal.timeout / setTimeout 的 32 位上限

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
	return Number.isFinite(n) && n > 0 ? Math.min(MAX_TIMEOUT_MS, Math.floor(n)) : dflt;
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
	if (provider === 'openmotion') return Math.min(15, Math.max(4, sec));
	if (provider === 'minimax') return Math.min(15, Math.max(minimaxMinDuration(cfg?.model), sec));
	return Math.min(12, Math.max(4, sec)); // volc
}

const escapeHtml = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * 校验 OpenMotion 本地服务地址：只允许本机回环 http://127.0.0.1|localhost|[::1]:port。
 */
export function openmotionOrigin(baseURL) {
	const raw = String(baseURL ?? '').trim() || OPENMOTION_DEFAULT_URL;
	let u;
	try { u = new URL(raw); } catch { return ''; }
	if (u.protocol !== 'http:' || !OPENMOTION_HOSTS.has(u.hostname.toLowerCase()) || !u.port || u.username || u.password) return '';
	if (u.pathname !== '/' && u.pathname !== '') return '';
	return u.origin;
}

/**
 * 把一段文案拆成 1~4 幕卡片，生成带 GSAP 暂停时间线的原生 Hyperframes index.html。
 */
export function buildOpenMotionHtml(prompt, cfg) {
	const ratio = cfg?.aspectRatio ?? '9:16';
	const [width, height] = ratio === '16:9' ? [1920, 1080] : ratio === '1:1' ? [1080, 1080] : [1080, 1920];
	const duration = durationFor('openmotion', cfg);
	const rawLines = String(prompt ?? '')
		.split(/[\n。！？!?；;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const scenes = (rawLines.length ? rawLines : [String(prompt ?? '').trim() || '此刻']).slice(0, 4);
	const seg = Number((duration / scenes.length).toFixed(2));
	const cards = scenes.map((line, i) => {
		const isFirst = i === 0;
		return `<div id="card-${i}" class="card${isFirst ? ' lead' : ''}">` +
			`<div class="tag">${String(i + 1).padStart(2, '0')} / ${String(scenes.length).padStart(2, '0')}</div>` +
			`<div class="line">${escapeHtml(line.slice(0, 60))}</div>` +
		`</div>`;
	}).join('\n    ');
	const anims = scenes.map((_, i) => {
		const tIn = Number((i * seg).toFixed(2));
		const tOut = Number(((i + 1) * seg - 0.35).toFixed(2));
		const fadeIn = `tl.fromTo('#card-${i}', { opacity: 0, y: 48, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'power3.out' }, ${tIn});`;
		const fadeOut = i < scenes.length - 1 && tOut > tIn + 0.45
			? `\n  tl.to('#card-${i}', { opacity: 0, y: -32, duration: 0.3, ease: 'power2.in' }, ${tOut});`
			: '';
		return fadeIn + fadeOut;
	}).join('\n  ');
	const fontSize = width >= 1920 ? 64 : 56;
	return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(scenes[0].slice(0, 24))}</title>
  <script src="assets/gsap.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #0b0d13; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; }
    #main { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: radial-gradient(circle at 20% 20%, #1c2541 0%, #0b0d13 70%); color: #f5f7ff; }
    #glow { position: absolute; width: ${Math.round(width * 0.7)}px; height: ${Math.round(width * 0.7)}px; left: 15%; top: 20%; border-radius: 50%; background: radial-gradient(circle, rgba(77,107,254,0.26) 0%, rgba(77,107,254,0) 70%); }
    .card { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: ${Math.round(width * 0.1)}px; text-align: center; opacity: 0; }
    .tag { font-size: 24px; letter-spacing: 0.18em; color: rgba(245,247,255,0.55); margin-bottom: 28px; }
    .line { font-size: ${fontSize}px; font-weight: 700; line-height: 1.42; max-width: ${Math.round(width * 0.82)}px; text-shadow: 0 8px 28px rgba(0,0,0,0.45); word-break: break-word; }
  </style>
</head>
<body>
  <div id="main" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}" data-fps="30">
    <div id="glow"></div>
    ${cards}
  </div>
  <script>
  const tl = gsap.timeline({ paused: true });
  tl.fromTo('#glow', { scale: 0.9, opacity: 0.6 }, { scale: 1.12, opacity: 1, duration: ${duration}, ease: 'sine.inOut' }, 0);
  ${anims}
  window.__timelines = { main: tl };
  </script>
</body>
</html>`;
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

function scrubVideoText(text, apiKey = '') {
	let out = scrubSecrets(String(text ?? ''), apiKey);
	// MiniMax key 是 350~600 字符的 JWT（eyJ...），不在 sk- 兜底规则里；先于截断打码以免露出前缀
	out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, 'eyJ***');
	return out;
}

/** 失败原因翻成人话（各家失败时给的东西也不一样，都挨个试一遍）。 */
function failText(j, baseMsg, apiKey = '') {
	// MiniMax v2 的失败原因在 task.error 里（{ code, message }），v1 才是顶层 error
	const cands = [j?.task?.error?.message, j?.task?.error, j?.error?.message, j?.error?.msg, j?.error, j?.message, baseMsg];
	let picked = '';
	for (const c of cands) {
		if (typeof c === 'string' && c.trim()) { picked = c.trim(); break; }
		if (c && typeof c === 'object' && Object.keys(c).length > 0) { picked = JSON.stringify(c); break; }
	}
	if (!picked) return '对方没说失败原因';
	return scrubVideoText(picked, apiKey).slice(0, 200);
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
			return { state: 'failed', error: scrubVideoText(msg || `对方回了错误码 ${code}`, apiKey) };
		}
		if (status === 'success' || status === 'succeeded') {
			const url = pickUrl(t.content?.url ?? j.content?.url);
			const fileId = pickUrl(t.file_id ?? j.file_id);
			return { state: 'succeeded', url, fileId };
		}
		if (status === 'fail' || status === 'failed') return { state: 'failed', error: failText(j, br?.status_msg, apiKey) };
		if (status === 'cancelled' || status === 'canceled' || status === 'expired') return { state: 'expired' };
		if (status === 'queued') return { state: 'queued' };
		return { state: 'running' }; // Preparing / Queueing / Processing 都还在跑
	}
	if (provider === 'openai-compat') {
		if (status === 'completed' || status === 'succeeded') {
			const url = pickUrl(j.data?.[0]?.url ?? j.url ?? j.output?.url);
			return { state: 'succeeded', url };
		}
		if (status === 'failed') return { state: 'failed', error: failText(j, undefined, apiKey) };
		if (status === 'cancelled' || status === 'canceled' || status === 'expired') return { state: 'expired' };
		if (status === 'queued') return { state: 'queued' };
		return { state: 'running' };
	}
	if (provider === 'openmotion') {
		const job = j.exportJob && typeof j.exportJob === 'object' ? j.exportJob : (j.job && typeof j.job === 'object' ? j.job : j);
		const st = String(job.state ?? job.status ?? '').trim().toLowerCase();
		if (st === 'completed' || st === 'succeeded') {
			const id = pickUrl(job.id);
			const url = pickUrl(job.downloadUrl) ?? (id ? `/api/exports/${encodeURIComponent(id)}/file` : undefined);
			return { state: 'succeeded', url };
		}
		if (st === 'failed') return { state: 'failed', error: failText(job, j.error, apiKey) };
		if (st === 'cancelled' || st === 'canceled' || st === 'expired') return { state: 'expired' };
		if (st === 'pending' || st === 'queued') return { state: 'queued' };
		return { state: 'running' };
	}
	if (status === 'succeeded') { const url = pickUrl(j.content?.video_url); return { state: 'succeeded', url }; }
	if (status === 'failed') return { state: 'failed', error: failText(j, undefined, apiKey) };
	if (status === 'expired' || status === 'cancelled' || status === 'canceled') return { state: 'expired' };
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
	const d = scrubVideoText(String(detail ?? '').trim(), apiKey).slice(0, 120);
	return d ? `${base}（${d}）` : base;
}

/** mp4 的头：第 4 个字节起是 'ftyp'。 */
export function isMp4Bytes(buf) {
	if (!buf || buf.length < 8) return false;
	return buf.subarray(4, 8).toString('latin1') === 'ftyp';
}

const timeoutSignal = (ms, signal) => {
	// AbortSignal.timeout(undefined) 在 Node 会直接抛 TypeError，所以这里先兜一层
	const clamped = (Number.isFinite(ms) && ms > 0) ? Math.min(Math.floor(ms), MAX_TIMEOUT_MS) : 0;
	const t = clamped > 0 ? AbortSignal.timeout(clamped) : null;
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
		let off = 0;
		while (off < b.length) off += writeSync(fd, b, off);
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
 * - 408 / 429 / 5xx / 网络抖动：退避重试（轮询是只读操作，重试不花钱）
 * - 其余 4xx：立刻放弃（鉴权/参数错，重试也没用）
 * - MiniMax 的查询地址有两版，404 就换另一个（state.idx 记住换过的，之后一直用能用的那个，且不消耗重试次数）
 */
async function pollOnce(fetchImpl, cands, cfg, signal, nap, state) {
	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) return { ok: false, status: 0, error: signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }) };
		const c = cands[state.idx];
		let res = null;
		let err = null;
		try {
			res = await fetchImpl(c.url, { method: c.method, headers: c.headers, redirect: 'error', signal: timeoutSignal(cfg.timeoutMs, signal) });
		} catch (e) { err = e; }
		if (res && res.ok) return { ok: true, res };
		try { await res?.body?.cancel?.(); } catch { /* 忽略取消流失败 */ }
		const status = res?.status ?? 0;
		if (status === 404 && state.idx < cands.length - 1) { state.idx++; attempt--; continue; }
		if (signal?.aborted) return { ok: false, status, error: err ?? signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }) };
		const retryable = err !== null || status === 0 || status === 408 || status === 429 || status >= 500;
		if (!retryable || attempt >= POLL_RETRY_DELAYS.length) return { ok: false, status, error: err };
		await nap(POLL_RETRY_DELAYS[attempt]);
	}
}

/**
 * 两个地址是不是同一个源（协议 + 主机 + 端口全同；不透明 'null' 源不算同源）。
 *
 * 🔴 下载地址是 provider 回的（不可信），跟 baseURL 不同源就**不带 key**：
 *    MiniMax 官方的 download_url 挂在别的域名上，把付费 key 带过去等于送人。
 *    跨源下载按「对方是公开签名 URL、不需要鉴权」处理。
 */
function sameOrigin(a, b) {
	try {
		const ua = new URL(a);
		const ub = new URL(b);
		return ua.origin !== 'null' && ua.origin === ub.origin;
	} catch { return false; }
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
/**
 * 通过本机 OpenMotion 服务生成并导出 MP4：
 *   1. 创建独立工程（openmotion_create_project）
 *   2. 写入 Hyperframes HTML+GSAP 时间线（openmotion_edit_project）
 *   3. 提交后台渲染（openmotion_export_request）
 *   4. 轮询完成状态（openmotion_get_project）
 *   5. 从 /api/exports/{jobId}/file 流式落盘并校验 ftyp 头
 */
async function generateOpenMotionVideo(cfg, { prompt, outDir, fetchImpl, nap, clock, signal }) {
	let submitted = false;
	let taskId = '';
	const fail = (code, detail = '') => ({
		ok: false, code, error: videoErrorText(code, detail, ''),
		submitted, ...(taskId ? { taskId } : {})
	});
	const origin = openmotionOrigin(cfg.baseURL);
	if (!origin) return fail('NOT_CONFIGURED', 'OpenMotion 接口地址只允许本机回环（如 http://127.0.0.1:4173）');
	const t0 = clock();
	const headers = { 'Content-Type': 'application/json', Origin: origin };
	const callPhase1 = async (name, args) => {
		const res = await fetchImpl(`${origin}/motion-api/phase1/call`, {
			method: 'POST',
			headers,
			redirect: 'error',
			body: JSON.stringify({ name, arguments: args }),
			signal: timeoutSignal(cfg.timeoutMs, signal)
		});
		let json = null;
		try { json = await res?.json?.(); } catch { json = null; }
		return { res, json };
	};

	const title = String(prompt ?? '').replace(/[\r\n\x00-\x1f]+/g, ' ').trim().slice(0, 32) || '随手拍';
	let created;
	try {
		created = await callPhase1('openmotion_create_project', {
			requestId: randomUUID(),
			projectType: 'natural_language',
			title,
			requirements: String(prompt ?? '').trim().slice(0, 4000)
		});
	} catch (e) {
		return fail(classifyError(e, 'NETWORK'));
	}
	if (!created.res || !created.res.ok) {
		const msg = created.json ? failText(created.json, undefined, '') : '';
		try { await created.res?.body?.cancel?.(); } catch { /* 忽略取消流失败 */ }
		return fail('SUBMIT_FAILED', msg && msg !== '对方没说失败原因' ? msg : `接口返回 ${created.res?.status ?? '未知'}`);
	}
	const projectId = String(created.json?.projectId ?? '').trim();
	const rev0 = String(created.json?.revision ?? '').trim();
	const ver0 = String(created.json?.currentVersionId ?? created.json?.version?.versionId ?? '').trim();
	if (!projectId || !rev0 || !ver0) return fail('SUBMIT_FAILED', 'OpenMotion 未返回工程版本号');

	const html = buildOpenMotionHtml(prompt, cfg);
	let edited;
	try {
		edited = await callPhase1('openmotion_edit_project', {
			projectId,
			requestId: randomUUID(),
			expectedRevision: rev0,
			expectedVersionId: ver0,
			presentation: 'background',
			summary: 'Write video composition',
			files: [{ path: 'index.html', content: html }]
		});
	} catch (e) {
		return fail(classifyError(e, 'NETWORK'));
	}
	if (!edited.res || !edited.res.ok) {
		const msg = edited.json ? failText(edited.json, undefined, '') : '';
		try { await edited.res?.body?.cancel?.(); } catch { /* 忽略取消流失败 */ }
		return fail('SUBMIT_FAILED', msg && msg !== '对方没说失败原因' ? msg : `写工程失败（${edited.res?.status ?? '未知'}）`);
	}
	const rev1 = String(edited.json?.revision ?? '').trim();
	const ver1 = String(edited.json?.version?.versionId ?? edited.json?.currentVersionId ?? '').trim();
	if (!rev1 || !ver1) return fail('SUBMIT_FAILED', 'OpenMotion 写工程后未返回新版本');

	submitted = true;
	let exported;
	try {
		exported = await callPhase1('openmotion_export_request', {
			projectId,
			requestId: randomUUID(),
			expectedRevision: rev1,
			versionId: ver1,
			audio: 'optional'
		});
	} catch (e) {
		return fail(classifyError(e, 'NETWORK'));
	}
	if (!exported.res || !exported.res.ok) {
		const msg = exported.json ? failText(exported.json, undefined, '') : '';
		try { await exported.res?.body?.cancel?.(); } catch { /* 忽略取消流失败 */ }
		return fail('SUBMIT_FAILED', msg && msg !== '对方没说失败原因' ? msg : `提交渲染失败（${exported.res?.status ?? '未知'}）`);
	}
	const jobId = String(exported.json?.job?.id ?? exported.json?.id ?? '').trim();
	if (!jobId || jobId === '.' || jobId === '..' || /[\\/]/.test(jobId)) return fail('SUBMIT_FAILED', '没拿到渲染任务号');
	taskId = jobId;

	const maxPolls = Math.max(1, Math.ceil(cfg.pollBudgetMs / cfg.pollIntervalMs) + 2);
	let downloadPath = '';
	let polls = 0;
	for (;;) {
		if (clock() - t0 > cfg.pollBudgetMs) return fail('POLL_TIMEOUT');
		if (polls >= maxPolls) return fail('POLL_TIMEOUT');
		polls++;
		await nap(cfg.pollIntervalMs);
		if (signal?.aborted) return fail('TIMEOUT');
		let polled = null;
		let pollErr = null;
		for (let attempt = 0; ; attempt++) {
			if (signal?.aborted) return fail('TIMEOUT');
			pollErr = null;
			try {
				polled = await callPhase1('openmotion_get_project', { projectId, exportJobId: jobId });
			} catch (e) { pollErr = e; }
			if (polled?.res?.ok) break;
			try { await polled?.res?.body?.cancel?.(); } catch { /* 忽略 */ }
			const status = polled?.res?.status ?? 0;
			const retryable = pollErr !== null || status === 0 || status === 408 || status === 429 || status >= 500;
			if (!retryable || attempt >= POLL_RETRY_DELAYS.length) {
				if (pollErr) return fail(classifyError(pollErr, 'NETWORK'));
				return fail('UNKNOWN', `查进度失败：接口返回 ${status || '未知'}`);
			}
			await nap(POLL_RETRY_DELAYS[attempt]);
		}
		const st = readPoll('openmotion', polled.json, {});
		if (st.state === 'succeeded') {
			downloadPath = st.url ?? `/api/exports/${encodeURIComponent(jobId)}/file`;
			break;
		}
		if (st.state === 'failed') return fail('TASK_FAILED', st.error);
		if (st.state === 'expired') return fail('TASK_EXPIRED');
	}

	let downloadUrl;
	try {
		const u = new URL(downloadPath, origin);
		if (u.origin !== origin) return fail('DOWNLOAD_FAILED', '导出文件地址非本机同源');
		downloadUrl = u.href;
	} catch {
		return fail('NO_URL');
	}

	const base = `video-${Date.now()}-${randomBytes(4).toString('hex')}`;
	const partPath = join(outDir, `${base}.part`);
	const finalPath = join(outDir, `${base}.mp4`);
	let dlRes = null;
	let fd = null;
	let size = 0;
	try {
		dlRes = await fetchImpl(downloadUrl, {
			method: 'GET',
			redirect: 'error',
			signal: timeoutSignal(Math.max(cfg.timeoutMs, DOWNLOAD_TIMEOUT_MIN), signal)
		});
		if (!dlRes || !dlRes.ok || !dlRes.body) return fail('DOWNLOAD_FAILED', `接口返回 ${dlRes?.status ?? '未知'}`);
		const declared = Number(dlRes.headers?.get?.('content-length') ?? dlRes.headers?.['content-length']);
		if (Number.isFinite(declared) && declared > cfg.maxBytes) return fail('TOO_LARGE', `声明 ${Math.round(declared / MB)}MB`);
		fd = openSync(partPath, 'w');
		size = await writeBody(dlRes.body, fd, cfg.maxBytes);
		closeSync(fd);
		fd = null;
		let head = Buffer.alloc(0);
		const hfd = openSync(partPath, 'r');
		try {
			head = Buffer.alloc(12);
			const got = readSync(hfd, head, 0, 12, 0);
			head = head.subarray(0, got);
		} finally {
			closeSync(hfd);
		}
		if (!isMp4Bytes(head)) return fail('BAD_VIDEO');
		renameSync(partPath, finalPath);
	} catch (e) {
		return fail(classifyError(e, 'DOWNLOAD_FAILED'));
	} finally {
		try { await dlRes?.body?.cancel?.(); } catch { /* 已经关了 */ }
		if (fd !== null) { try { closeSync(fd); } catch { /* 已经关了 */ } }
		if (existsSync(partPath)) { try { unlinkSync(partPath); } catch { /* 删不掉就算了 */ } }
	}
	return { ok: true, file: resolve(finalPath), bytes: size, provider: 'openmotion', elapsedMs: clock() - t0 };
}

export async function generateVideo(rawCfg, { prompt, outDir, fetchImpl = globalThis.fetch, sleep, now, signal, downloadImpl } = {}) {
	const cfg = videoGenConfig(rawCfg); // 归一化必须在这层做：漏了 pollBudgetMs 会让预算判断恒假 → 死循环
	const provider = cfg.provider;
	const nap = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => {
		if (signal?.aborted) { resolve(); return; }
		const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
		const t = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
	// 时钟坏掉（返回 NaN）就退回真实时钟：预算判断恒假的话会一直查到天荒地老
	const clock = typeof now === 'function'
		? () => { const raw = now(); return Number.isFinite(raw) ? raw : Date.now(); }
		: () => Date.now();
	const download = typeof downloadImpl === 'function' ? downloadImpl : safeDownloadStream;
	let submitted = false;
	let taskId = '';
	const fail = (code, detail = '') => ({
		ok: false, code, error: videoErrorText(code, detail, cfg.apiKey),
		submitted, ...(taskId ? { taskId } : {})
	});
	let t0 = 0;
	try {
		if (!cfg.enabled) return fail('DISABLED');
		if (!outDir || !String(prompt ?? '').trim()) return fail('NOT_CONFIGURED');
		if (provider !== 'openmotion' && (!cfg.baseURL || !cfg.apiKey || !cfg.model)) return fail('NOT_CONFIGURED');
		// 分辨率跟模型绑着：2K 只有 MiniMax-H3 支持。错配就别发出去让对方拒（提交是花钱的）
		if (provider === 'minimax' && !minimaxResolutionOk(cfg.model, cfg.resolution)) {
			return fail('NOT_CONFIGURED', `${cfg.model} 不支持 2K（只有 480P / 768P），把分辨率改成 768P`);
		}
		mkdirSync(outDir, { recursive: true });
		const free = statfsSync(outDir);
		if (Number(free.bavail) * Number(free.bsize) < FREE_MIN) return fail('NO_SPACE');
		if (provider === 'openmotion') {
			return await generateOpenMotionVideo(cfg, { prompt, outDir, fetchImpl, nap, clock, signal });
		}
		t0 = clock();

		// 提交
		const submit = buildSubmit(provider, cfg, prompt);
		let submittedRes = null;
		submitted = true;
		try {
			submittedRes = await fetchImpl(submit.url, {
				method: submit.method,
				headers: submit.headers,
				redirect: 'error',
				body: JSON.stringify(submit.body),
				signal: timeoutSignal(cfg.timeoutMs, signal)
			});
		} catch (e) {
			return fail(classifyError(e, 'NETWORK'));
		}
		if (!submittedRes || !submittedRes.ok) {
			let errDetail = '';
			try {
				const ej = typeof submittedRes?.json === 'function' ? await submittedRes.json() : null;
				if (ej && typeof ej === 'object') {
					const msg = failText(ej, undefined, cfg.apiKey);
					if (msg !== '对方没说失败原因') errDetail = msg;
				}
			} catch { /* 忽略无法解析的错误体 */ }
			try { await submittedRes?.body?.cancel?.(); } catch { /* 忽略取消流失败 */ }
			const statusText = `接口返回 ${submittedRes?.status ?? '未知'}`;
			return fail('SUBMIT_FAILED', errDetail ? `${statusText}：${errDetail}` : statusText);
		}
		let sj = null;
		try { sj = await submittedRes.json(); } catch { sj = null; }
		if (provider === 'minimax') {
			const br = sj?.base_resp ?? sj?.task?.base_resp;
			if (br?.status_code !== undefined && br?.status_code !== null && Number(br.status_code) !== 0) {
				const msg = scrubVideoText(String(br?.status_msg ?? '').trim(), cfg.apiKey);
				return fail('SUBMIT_FAILED', msg || `错误码 ${br.status_code}`);
			}
		}
		const rawId = provider === 'minimax' ? (sj?.task_id ?? sj?.task?.task_id ?? sj?.task?.id ?? sj?.id) : sj?.id;
		const id = rawId === undefined || rawId === null || rawId === '' ? '' : String(rawId).trim();
		if (!id || id === '.' || id === '..' || /[\\/]/.test(id)) return fail('SUBMIT_FAILED', '没拿到任务号');
		taskId = id;

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
			if (signal?.aborted) return fail('TIMEOUT');
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

		// MiniMax 成功时给的是 file_id，不是地址：再问一次要下载地址（只读操作，可重试，不花钱）
		if (provider === 'minimax' && !videoURL && fileId) {
			const got = await getJson(fetchImpl, `${cfg.baseURL}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, { Authorization: `Bearer ${cfg.apiKey}` }, cfg, signal, nap);
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

		// openai 官方形状：视频对象里没有地址（只有 id/status/progress），字节在 /videos/{id}/content；同样走 SSRF 防护下载器
		if (provider === 'openai-compat' && !videoURL) {
			videoURL = `${cfg.baseURL}/videos/${encodeURIComponent(id)}/content`;
		}
		if (!videoURL) return fail('NO_URL');

		// 下载：先写 .part，验完文件头再改名（中途挂掉或假货不会以 .mp4 留在盘上）
		const base = `video-${Date.now()}-${randomBytes(4).toString('hex')}`;
		const partPath = join(outDir, `${base}.part`);
		const finalPath = join(outDir, `${base}.mp4`);
		let dl = null;
		let fd = null;
		let size = 0;
		try {
			dl = await download(videoURL, {
				maxBytes: cfg.maxBytes,
				timeoutMs: Math.max(cfg.timeoutMs, DOWNLOAD_TIMEOUT_MIN),
				signal,
				// 只有跟 baseURL 同源才带 key：provider 回的下载地址常常是第三方域名（公开签名 URL，不用鉴权）
				headers: sameOrigin(videoURL, cfg.baseURL) ? { Authorization: `Bearer ${cfg.apiKey}` } : {}
			});
			if (!dl) return fail('DOWNLOAD_FAILED');
			// 不信 Content-Type，只信实际字节；但声明的大小能提前挡住，就先挡一道
			const declared = Number(dl.headers?.['content-length']);
			if (Number.isFinite(declared) && declared > cfg.maxBytes) return fail('TOO_LARGE', `声明 ${Math.round(declared / MB)}MB`);
			fd = openSync(partPath, 'w');
			size = await writeBody(dl.body, fd, cfg.maxBytes);
			closeSync(fd);
			fd = null;
			// 落地的东西得真是视频：先验文件头再改名，不认后缀和 Content-Type
			let head = Buffer.alloc(0);
			const hfd = openSync(partPath, 'r');
			try {
				head = Buffer.alloc(12);
				const got = readSync(hfd, head, 0, 12, 0);
				head = head.subarray(0, got);
			} finally {
				closeSync(hfd);
			}
			if (!isMp4Bytes(head)) return fail('BAD_VIDEO');
			renameSync(partPath, finalPath);
		} catch (e) {
			return fail(classifyError(e, 'DOWNLOAD_FAILED'));
		} finally {
			try { dl?.destroy?.(); } catch { /* 已经关了 */ }
			if (fd !== null) { try { closeSync(fd); } catch { /* 已经关了 */ } }
			// 还没改名成功就删掉半截/假货文件，别把 .part 留在盘上
			if (existsSync(partPath)) { try { unlinkSync(partPath); } catch { /* 删不掉就算了 */ } }
		}
		return { ok: true, file: resolve(finalPath), bytes: size, provider, elapsedMs: clock() - t0 };
	} catch (error) {
		return fail(classifyError(error, 'UNKNOWN'));
	}
}

/** 问服务商要个 JSON（只读操作，408 / 429 / 5xx / 网络抖动按退避重试）。 */
async function getJson(fetchImpl, url, headers, cfg, signal, nap) {
	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) return { ok: false, status: 0, error: signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }) };
		let res = null;
		let err = null;
		try {
			res = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: timeoutSignal(cfg.timeoutMs, signal) });
		} catch (e) { err = e; }
		if (res && res.ok) {
			let json = null;
			try { json = await res.json(); } catch { json = null; }
			return { ok: true, json };
		}
		try { await res?.body?.cancel?.(); } catch { /* 忽略取消流失败 */ }
		const status = res?.status ?? 0;
		if (signal?.aborted) return { ok: false, status, error: err ?? signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }) };
		const retryable = err !== null || status === 0 || status === 408 || status === 429 || status >= 500;
		if (!retryable || attempt >= POLL_RETRY_DELAYS.length) return { ok: false, status, error: err };
		await nap(POLL_RETRY_DELAYS[attempt]);
	}
}

/**
 * 清理生成的视频：清理过期 .part → 超龄 → 超数 → 超量，按顺序走。
 * @returns {number} 删掉的文件数
 */
export function pruneVideos(dir, { keepDays = 3, maxFiles = 20, maxBytes = 500 * 1024 * 1024 } = {}) {
	if (!dir || !existsSync(dir)) return 0;
	let removed = 0;
	const drop = (f) => { try { unlinkSync(f.path); removed++; return true; } catch { return false; } };
	const now = Date.now();
	// 崩掉 / 强杀遗留的 .part（超过 1 小时未动）顺带清掉，避免无限占盘
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.part')) continue;
		const p = join(dir, f);
		try {
			const st = statSync(p);
			if (now - st.mtimeMs > 3_600_000) drop({ path: p });
		} catch { /* 忽略已不存在的文件 */ }
	}
	const scan = () => readdirSync(dir)
		.filter((f) => f.endsWith('.mp4'))
		.map((f) => {
			try { const st = statSync(join(dir, f)); return { path: join(dir, f), name: f, size: st.size, mtime: st.mtimeMs }; }
			catch { return null; }
		})
		.filter(Boolean)
		.sort((a, b) => b.mtime - a.mtime); // 新的在前
	// 1) 超龄
	const cutoff = now - keepDays * 86400000;
	for (const f of scan()) if (f.mtime < cutoff) drop(f);
	// 2) 超数：留最新的那几个
	let cur = scan();
	if (cur.length > maxFiles) for (const f of cur.slice(maxFiles)) drop(f);
	// 3) 超量：从最旧的开始删
	cur = scan();
	let total = cur.reduce((n, f) => n + f.size, 0);
	for (const f of cur.slice().reverse()) {
		if (total <= maxBytes) break;
		if (drop(f)) total -= f.size;
	}
	return removed;
}
