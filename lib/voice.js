/**
 * voice.js —— 语音：听（QQ 语音 → 文字）和说（文字 → QQ 语音）。
 *
 * 走 OpenAI 兼容接口：POST {baseURL}/audio/transcriptions（multipart：model + file）、
 * POST {baseURL}/audio/speech（JSON：model / input / voice / response_format）。
 * 硅基流动这两个都有（SenseVoice 听、CosyVoice 说），没单独填地址 / key 时沿用「记忆检索」的那一套。
 *
 * QQ 语音是 silk：先让 SnowLuma 用 get_record 转成 mp3（它自带转码），拿不到再退回消息里的 url。
 * 发语音：record 段 base64://mp3，SnowLuma 负责转 silk。
 */
import { safeDownload } from './safe-download.js';
import { getKv, setKv } from './db.js';

// 语音接口的等待上限：TTS 念一段长一点的文字经常超过 20 秒，以前写死 20 秒就会白等一次超时。
// 改成可配（设置页「语音」里调），默认 60 秒。
const DEFAULT_TIMEOUT_SEC = 60;
export const MIN_TIMEOUT_SEC = 5;
export const MAX_TIMEOUT_SEC = 300;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const UNHEARD = '【语音（暂时听不了）】';

/**
 * 把错误响应里可能回显的凭据打码。
 *
 * 🔴 为什么需要：服务商的错误 body 有时会把请求头 / 请求体回显出来
 *    （`{"error":{"message":"Incorrect API key provided: sk-abc...xyz"}}`）。
 *    这段文字会进 `lastError` → 设置页显示 → 也可能进日志。
 *    所以凡是要展示 / 记录的错误文本，先把「我们自己知道的那几个 key」擦掉。
 *
 * 除了精确匹配当前用的 key，也兜一类形状（`sk-...` / `Bearer xxx`），
 * 防止「换了 key 但报的是旧 key」这种漏网。
 */
export function scrubSecrets(text, ...known) {
	let out = String(text ?? '');
	for (const k of known) {
		const s = String(k ?? '');
		// 太短的（<8）不处理：容易误伤正常文字，而且真实 key 不会这么短
		if (s.length < 8) continue;
		out = out.split(s).join(`${s.slice(0, 4)}***${s.slice(-4)}`);
	}
	// 形状兜底：sk- 开头的长串、Bearer 后的 token
	out = out.replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}/g, '$1***');
	out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1***');
	return out;
}

/**
 * MiMo（小米）的 TTS 走 /chat/completions + audio 字段，不是 OpenAI 的 /audio/speech。
 * 认这个 hint 是为了不改用户填的模型名就能自动选对调用方式。
 */
function isMimoTts(baseURL, model) {
	const host = String(baseURL ?? '').toLowerCase();
	const m = String(model ?? '').toLowerCase();
	return host.includes('xiaomimimo') || /^mimo-.*tts/.test(m);
}

/** 能填进「说的服务商」的值；空串 = 按地址 / 模型自动认。 */
export const TTS_PROVIDERS = ['openai', 'mimo', 'volcengine', 'minimax'];

/** 能填进「听的服务商」的值；空串 = 按地址 / 模型自动认。 */
export const STT_PROVIDERS = ['openai', 'minimax', 'dashscope'];

/**
 * MiniMax TTS：POST /v1/t2a_v2，请求体是它自己的结构（voice_setting / audio_setting），
 * 🔴 响应里 `data.audio` 是 **hex** 编码，不是 base64 —— 按 base64 解会得到一堆乱码字节，
 * 发出去是一条没人能听的语音。这是最容易踩的一个坑。
 */
export function isMinimaxTts(baseURL, model, provider = '') {
	if (provider === 'minimax') return true;
	if (provider !== '') return false;
	const host = String(baseURL ?? '').toLowerCase();
	const m = String(model ?? '').toLowerCase();
	return host.includes('minimax') || /^(?:speech-\d|t2a_)/.test(m);
}

/**
 * MiniMax STT：POST /v1/speech_to_text，multipart（model + file），响应 `{ text }`。
 * 形状跟 OpenAI 的 /audio/transcriptions 像，但路径不同、模型名是 `asr-1.0`。
 */
export function isMinimaxStt(baseURL, model, provider = '') {
	if (provider === 'minimax') return true;
	if (provider !== '') return false;
	const host = String(baseURL ?? '').toLowerCase();
	const m = String(model ?? '').toLowerCase();
	return host.includes('minimax') || /^asr-/.test(m);
}

/**
 * 阿里百炼（DashScope）的 Qwen-ASR **没有** `/audio/transcriptions`。
 *
 * 它的 OpenAI 兼容模式走的是 `/chat/completions`（音频放在 messages 里的
 * `input_audio` 块），原生模式是 `/api/v1/services/aigc/multimodal-generation/generation`。
 * 把百炼的地址填进「听」却按 /audio/transcriptions 去调 → 404/400，
 * 表现就是「发了语音她一直说听不到」。
 */
export function isDashScopeStt(baseURL, model, provider = '') {
	if (provider === 'dashscope') return true;
	if (provider !== '') return false;
	const host = String(baseURL ?? '').toLowerCase();
	const m = String(model ?? '').toLowerCase();
	return host.includes('dashscope') || host.includes('maas.aliyuncs.com') || /^(?:qwen[\d.]*-asr|paraformer|sensevoice)/.test(m);
}

/**
 * 火山引擎（豆包语音）的 TTS 不是 OpenAI 接口：走 /api/v1/tts，鉴权头是
 * `Authorization: Bearer; <token>`，音频以 base64 回在 data 里。
 * 显式选了服务商就听它的，没选才按地址 / 模型猜。
 */
export function isVolcTts(baseURL, model, provider = '') {
	if (provider === 'volcengine') return true;
	if (provider !== '') return false;
	const host = String(baseURL ?? '').toLowerCase();
	const m = String(model ?? '').toLowerCase();
	// 别用 /^volc|doubao/：`volcano_tts`（火山自己的集群名，不是模型名）也会被命中。
	// 认的是「volc-」「volcengine」「doubao」开头的模型名。
	return host.includes('openspeech.bytedance.com') || /^(?:volc[-_]|volcengine|doubao)/.test(m);
}

/**
 * 火山有两种鉴权，靠有没有 AppID 区分：
 *  - 新版控制台只给 API Key（不给 AppID）→ V3 接口 /api/v3/tts/unidirectional，头是 X-Api-Key；
 *  - 老版控制台是 AppID + Access Token → V1 接口 /api/v1/tts，头是 `Bearer; token`。
 */
export function volcMode(c) {
	return String(c?.volcAppId ?? '') === '' ? 'v3' : 'v1';
}

/**
 * 火山合成的完整地址。填了 volcEndpoint 就照用；接口地址看着像火山就用它；
 * 沿用硅基 / MiMo 那套默认地址的（或者干脆没填）回落到火山官方地址。
 * proxy 这类自定义地址原样保留，按模式补路径。
 */
export function volcUrl(c) {
	const base = String(c?.ttsBaseURL ?? '').replace(/\/+$/, '');
	const borrowed = /siliconflow|xiaomimimo|openai\.com|deepseek/i.test(base);
	const own = base !== '' && !borrowed;
	const configured = String(c?.volcEndpoint ?? '').replace(/\/+$/, '');
	if (configured !== '') return configured;
	const path = volcMode(c) === 'v3' ? '/api/v3/tts/unidirectional' : '/api/v1/tts';
	if (own) return /\/api\/v\d+\//i.test(base) ? base : `${base}${path}`;
	return `https://openspeech.bytedance.com${path}`;
}

/**
 * V3 接口回来的是「拼在一起的 JSON」：一截一截的 {code:0,data:"<base64>"}，最后跟一个
 * {code:20000000,message:"OK"}。按大括号配对切，字符串里的括号和转义先跳过。
 * 有的实现会在前面加 `data: `（SSE 风格），先去掉。
 */
export function parseVolcStream(text) {
	const src = String(text ?? '').replace(/^\s*data:\s*/gm, '').trim();
	const out = [];
	let depth = 0;
	let start = -1;
	let inStr = false;
	let esc = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === '\\') esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') { inStr = true; continue; }
		if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
		if (ch === '}') {
			depth--;
			if (depth === 0 && start >= 0) {
				try { out.push(JSON.parse(src.slice(start, i + 1))); } catch { throw new Error(`返回内容不是合法 JSON：${src.slice(start, start + 80)}`); }
				start = -1;
			}
		}
	}
	return out;
}

/** 配置里的秒数 → 毫秒（单独拎出来，测试不用真等）。 */
export function timeoutMs(config) {
	return (config?.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
}

/**
 * 把百炼 / MiniMax 的地址补成能直接拼 `/chat/completions`、`/speech_to_text` 的形状。
 *
 * 用户按习惯常只填域名（`https://dashscope.aliyuncs.com`），少个 `/compatible-mode/v1`，
 * 拼出来的就是 `https://dashscope.aliyuncs.com/chat/completions` → 404 → 「一直听不到」。
 * 只在「明确是这两家、且路径没写全」时补，别的地址一个字符都不动。
 */
export function normalizeSttBase(base) {
	const b = String(base ?? '').replace(/\/+$/, '');
	if (b === '') return b;
	if (/dashscope\.aliyuncs\.com$/i.test(b)) return `${b}/compatible-mode/v1`;
	if (/maas\.aliyuncs\.com$/i.test(b)) return `${b}/compatible-mode/v1`;
	if (/^https?:\/\/api\.minimax\.(?:cn|com|ac\.cn)$/i.test(b)) return `${b}/v1`;
	return b;
}

/** 设置里的 voice 段 → 规整后的参数（默认关）。听 / 说可以各用一套地址和 key。 */
export function voiceConfig(raw, embedding = {}) {
	const v = raw ?? {};
	const str = (x, d = '') => (typeof x === 'string' && x.trim() !== '' ? x.trim() : d);
	const num = (x, d, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };
	// 老配置只有 baseURL / apiKey（听说共用）→ 当作两侧的默认值
	const legacyBase = str(v.baseURL, str(embedding.baseURL, 'https://api.siliconflow.cn/v1')).replace(/\/+$/, '');
	const sameBase = str(v.baseURL) === '' || str(v.baseURL).replace(/\/+$/, '') === str(embedding.baseURL).replace(/\/+$/, '');
	const legacyKey = str(v.apiKey, sameBase ? str(embedding.apiKey) : '');
	const sttBase = normalizeSttBase(str(v.sttBaseURL, legacyBase).replace(/\/+$/, ''));
	const ttsBase = str(v.ttsBaseURL, legacyBase).replace(/\/+$/, '');
	const sttKey = str(v.sttApiKey, legacyKey);
	const ttsKey = str(v.ttsApiKey, legacyKey);
	const ttsModel = str(v.ttsModel, 'FunAudioLLM/CosyVoice2-0.5B');
	// 说的服务商：空 = 自动认；火山引擎老版要 AppID，新版只要 API Key
	const ttsProvider = TTS_PROVIDERS.includes(str(v.ttsProvider)) ? str(v.ttsProvider) : '';
	// 听的服务商：空 = 自动认（百炼 / MiniMax 的路径和 OpenAI 不一样，猜错就静默听不到）
	const sttProvider = STT_PROVIDERS.includes(str(v.sttProvider)) ? str(v.sttProvider) : '';
	const volc = isVolcTts(ttsBase, ttsModel, ttsProvider);
	const volcAppId = str(v.volcAppId);
	// 火山默认音色：老版（V1）用 qingxin；新版（V3）只认 2.0 音色（*_uranus_bigtts）
	const volcVoice = volcAppId === '' ? 'zh_female_shuangkuaisisi_uranus_bigtts' : 'zh_female_qingxin';
	return {
		enabled: v.enabled === true,
		// 兼容旧字段：仍然是「说」那一侧
		baseURL: ttsBase,
		apiKey: ttsKey,
		hasOwnKey: str(v.apiKey) !== '',
		sttBaseURL: sttBase,
		sttApiKey: sttKey,
		sttProvider,
		ttsBaseURL: ttsBase,
		ttsApiKey: ttsKey,
		// 百炼默认 qwen3-asr-flash；MiniMax 默认 asr-1.0；其余沿用硅基流动的 SenseVoice
		sttModel: str(v.sttModel, isDashScopeStt(sttBase, '', sttProvider) ? 'qwen3-asr-flash'
			: isMinimaxStt(sttBase, '', sttProvider) ? 'asr-1.0' : 'FunAudioLLM/SenseVoiceSmall'),
		ttsModel,
		// MiniMax 的音色是控制台给的 voice_id（系统音色或复刻 ID），这里不给默认值 ——
		// 填错 ID 接口会明确报错，比悄悄用一个别人的音色好。
		ttsVoice: str(v.ttsVoice, volc ? volcVoice : isMimoTts(ttsBase, ttsModel) ? 'mimo_default'
			: isMinimaxTts(ttsBase, ttsModel, ttsProvider) ? 'male-qn-qingse' : 'FunAudioLLM/CosyVoice2-0.5B:anna'),
		// 火山引擎：AppID 空 = 新版控制台的 API Key 模式（token 填在 ttsApiKey），
		// 填了 = 老版 AppID + Access Token 模式；集群只有 V1 用（声音复刻填 volcano_icl）
		ttsProvider,
		volcAppId,
		volcCluster: str(v.volcCluster, 'volcano_tts'),
		volcResourceId: str(v.volcResourceId, 'seed-tts-2.0'),
		volcEndpoint: str(v.volcEndpoint),
		// 她什么时候发语音：never 从不 / mirror 对方发语音时可以 / sometimes 偶尔自己想发
		speak: ['never', 'mirror', 'sometimes'].includes(v.speak) ? v.speak : 'mirror',
		maxChars: num(v.maxChars, 60, 10, 200),
		ttsPerDay: num(v.ttsPerDay, 30, 0, 500),
		sttPerDay: num(v.sttPerDay, 200, 0, 2000),
		// 单次请求最多等多久（秒）；听和说共用一个上限
		timeoutSec: num(v.timeoutSec, DEFAULT_TIMEOUT_SEC, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC)
	};
}

/** 这一轮里有人点名要她发语音（"发条语音""语音说""说给我听""想听你声音"）。 */
const ASK_VOICE_RE = /(?:发|来|整|录)(?:一?[条个段句]|点)?(?:语音|声音)|语音(?:说|讲|发|回|聊)|用语音|说给我听|唱给我听|听听你的?声音|想听你的?(?:声音|说话)|[能会]不?[能会]?发语音|发不了语音/;
export function askedForVoice(speakers = []) {
	return speakers.some((s) => ASK_VOICE_RE.test(String(s?.query ?? s?.text ?? '')));
}

/**
 * 上下文里的 [语音] 提示。
 *  - QQ：能发（「偶尔自己想发」/ 对方发了语音 / 对方点名要）就教她怎么写；点名要了却发不了就让她直说；
 *  - B站 / 抖音私信发不了语音：对方要语音（或发了语音）时，能转到主人 QQ（relay）就教她写 [语音]，不能就让她直说发不了。
 * 不说清楚的话，模型只能凭人设编理由（"在打游戏"）。
 */
export function voiceLines({ v, ttsReady = false, session = {}, speakers = [], where = 'QQ', relay = false }) {
	const asked = askedForVoice(speakers);
	const voiceIn = session.voiceIn === true;
	const how = `想用语音说的话单独一段、开头写 [语音]（≤${v.maxChars} 字，口语，别带表情和链接`;
	if (where === 'QQ') {
		if (ttsReady && v.speak !== 'never' && (v.speak === 'sometimes' || voiceIn || asked)) {
			return [`[语音] ${voiceIn ? '对方发的是语音，' : asked ? '对方想听你的语音，' : ''}${how}；${asked ? '这次可以发' : '大多数时候还是打字'}）。`];
		}
		return asked ? ['[语音] 你现在发不了语音（没开 / 没配好 / 设成了不发），只能打字；ta 要语音就直说发不了，别编别的理由。'] : [];
	}
	if (!asked && !voiceIn) return [];
	return [relay
		? `[语音] ${where}私信发不了语音。${how}），这段会发到 ta 的 QQ 私聊；再另起一段用你自己的话跟 ta 说一声去 QQ 听。`
		: `[语音] ${where}私信发不了语音，只能打字；ta 要语音就直说这边发不了，别编别的理由。`];
}

function mediaTypeOfAudio(bytes) {
	if (bytes.length >= 3 && bytes.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF') return 'audio/wav';
	if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
	if (bytes.length >= 10 && bytes.subarray(0, 10).toString('latin1').includes('SILK')) return 'audio/silk';
	if (bytes.length >= 6 && bytes.subarray(0, 6).toString('latin1') === '#!AMR\n') return 'audio/amr';
	return 'application/octet-stream';
}
const EXT = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/silk': 'silk', 'audio/amr': 'amr' };

export class VoiceService {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => ReturnType<typeof voiceConfig>} deps.getConfig
	 * @param {typeof fetch} [deps.fetchImpl]
	 * @param {(level: string, msg: string) => void} [deps.log]
	 */
	constructor({ db, getConfig, fetchImpl = globalThis.fetch, log }) {
		Object.assign(this, { db, getConfig, fetchImpl });
		this.log = log ?? (() => {});
		this.lastError = '';
	}

	ready() {
		const c = this.getConfig();
		return c.enabled && (c.sttApiKey !== '' || c.ttsApiKey !== '');
	}

	/** 听 / 说各自的接口能用吗。 */
	readyFor(kind) {
		const c = this.getConfig();
		const volc = isVolcTts(c.ttsBaseURL, c.ttsModel, c.ttsProvider);
		// 火山新版（没填 AppID）只要 API Key；老版（V1）还要 AppID 才能签 app 段
		const ttsReady = c.ttsApiKey !== '' && (!volc || volcMode(c) !== 'v1' || c.volcAppId !== '');
		return c.enabled && (kind === 'tts' ? ttsReady : c.sttApiKey !== '');
	}

	/** 今天还能用几次（kind = stt / tts）。 */
	quotaLeft(kind) {
		const c = this.getConfig();
		const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
		const used = getKv(this.db, `voice.count.${day}`, {}) ?? {};
		return (kind === 'tts' ? c.ttsPerDay : c.sttPerDay) - (Number(used[kind]) || 0);
	}

	count(kind) {
		const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
		const used = getKv(this.db, `voice.count.${day}`, {}) ?? {};
		used[kind] = (Number(used[kind]) || 0) + 1;
		setKv(this.db, `voice.count.${day}`, used);
		this.db.prepare("DELETE FROM kv WHERE key LIKE 'voice.count.%' AND key < ?").run(`voice.count.${new Date(Date.now() - 7 * 86400_000 + 8 * 3600_000).toISOString().slice(0, 10)}`);
	}

	/** 发一个请求；kind = 'stt' | 'tts'，两侧各用自己的地址和 key。 */
	async post(path, init, kind = 'tts') {
		const c = this.getConfig();
		const baseURL = kind === 'stt' ? c.sttBaseURL : c.ttsBaseURL;
		const apiKey = kind === 'stt' ? c.sttApiKey : c.ttsApiKey;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs(c));
		timer.unref?.();
		try {
			const res = await this.fetchImpl(`${baseURL}${path}`, { ...init, signal: controller.signal, headers: { authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) } });
			if (!res.ok) throw new Error(`HTTP ${res.status}${await res.text().then((t) => `：${scrubSecrets(t.slice(0, 120), apiKey)}`).catch(() => '')}`);
			return res;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 读响应体并限大小。
	 *
	 * 🔴 为什么不能直接 `res.arrayBuffer()`：
	 *    ① **没有大小上限** —— 服务商返回一个超大 body（配错地址指到一个大文件、
	 *       或者服务端异常）会先把整个 body 读进内存，`MAX_AUDIO_BYTES` 的检查在之后，
	 *       那时内存已经吃进去了。
	 *    ② **超时保护覆盖不到这里** —— `post()` 的 timer 在 `finally` 里就 clear 了，
	 *       返回 res 之后没有任何超时；服务端慢慢吐字节就能把这一轮永久挂住
	 *       （语音配额、`isTickRunning` 之类的锁跟着一起卡）。
	 *    所以：自己按块读，边读边累计，超上限立刻 abort；总耗时也自己掐。
	 */
	async readBodyLimited(res, { maxBytes = MAX_AUDIO_BYTES, timeoutMs: ms = 30_000 } = {}) {
		// 服务端给了 content-length 就先拦一道（省掉白读）
		const declared = Number(res.headers?.get?.('content-length') ?? 0);
		if (Number.isFinite(declared) && declared > maxBytes) {
			try { res.body?.cancel?.(); } catch { /* 已结束 */ }
			throw new Error(`响应太大（${Math.round(declared / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）`);
		}
		if (res.body === null || res.body === undefined) {
			// 没有流式 body：退回一次性读，读完再查大小。
			// （真实 fetch 一定给 body 流，但自定义 fetchImpl / 测试替身可能只给
			//  arrayBuffer 或 text —— 这几种都要能走通，否则等于把可注入的 fetch 打挂。）
			if (typeof res.arrayBuffer === 'function') {
				const buf = Buffer.from(await res.arrayBuffer());
				if (buf.length > maxBytes) throw new Error(`响应太大（${Math.round(buf.length / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）`);
				return buf;
			}
			if (typeof res.text === 'function') {
				const buf = Buffer.from(String(await res.text()), 'utf8');
				if (buf.length > maxBytes) throw new Error(`响应太大（${Math.round(buf.length / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）`);
				return buf;
			}
			// 只有 json()：序列化回来（大小同样查一遍）
			if (typeof res.json === 'function') {
				const buf = Buffer.from(JSON.stringify(await res.json()), 'utf8');
				if (buf.length > maxBytes) throw new Error(`响应太大（${Math.round(buf.length / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）`);
				return buf;
			}
			throw new Error('响应读不出来（既没有 body 流，也没有 arrayBuffer / text / json）');
		}
		const chunks = [];
		let size = 0;
		let timer;
		const reader = res.body.getReader();
		// ⚠️ 取消要统一走 reader.cancel()：直接调 res.body.cancel() 会和 reader 抢锁
		//    （ReadableStream is locked），抛出来的错会变成未处理拒绝。
		let abortReason = '';
		const guard = new Promise((_, reject) => {
			timer = setTimeout(() => {
				abortReason = `读音频超时（${Math.round(ms / 1000)}s）`;
				reject(new Error(abortReason));
			}, ms);
			timer.unref?.();
		});
		try {
			for (;;) {
				const { done, value } = await Promise.race([reader.read(), guard]);
				if (done) break;
				size += value.byteLength;
				if (size > maxBytes) {
					abortReason = `响应太大（超过 ${Math.round(maxBytes / 1024)}KB）`;
					throw new Error(abortReason);
				}
				chunks.push(Buffer.from(value));
			}
		} catch (error) {
			// 不管是超时还是超大小，都要把流关掉：不关的话底层连接会一直占着
			try { await reader.cancel(); } catch { /* 已结束 / 已关 */ }
			throw error;
		} finally {
			clearTimeout(timer);
		}
		return Buffer.concat(chunks);
	}

	/**
	 * 读 JSON 响应并限大小（同样的理由：`res.json()` 无上限、且 `post()` 的超时管不到这里）。
	 * JSON 响应正常只有几 KB，上限给 1MB 很宽松。
	 */
	async readJsonLimited(res, { maxBytes = 1024 * 1024, timeoutMs: ms = 30_000 } = {}) {
		// 没有流式 body 时优先用 res.json()：那是最贴近「拿 JSON」的原语，
		// 而且自定义 fetchImpl / 测试替身常常只实现 json()（text() 返回空串）。
		// 有 body 流时走统一的分块读取（能限大小、能超时）。
		if ((res.body === null || res.body === undefined) && typeof res.json === 'function') {
			const json = await res.json();
			// 序列化回来量一次大小（防止一个巨大的 JSON 悄悄进内存）
			const size = Buffer.byteLength(JSON.stringify(json), 'utf8');
			if (size > maxBytes) throw new Error(`响应太大（${Math.round(size / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）`);
			return json;
		}
		const buf = await this.readBodyLimited(res, { maxBytes, timeoutMs: ms });
		const text = buf.toString('utf8');
		try { return JSON.parse(text); }
		catch { throw new Error(`返回内容不是合法 JSON：${text.slice(0, 120)}`); }
	}

	/** 音频 → 文字；听不了 / 没开 / 用完了返回 null。 */
	async transcribe(bytes) {
		if (!this.readyFor('stt') || !bytes || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) return null;
		if (this.quotaLeft('stt') <= 0) { this.lastError = '今天听语音的次数用完了'; return null; }
		const c = this.getConfig();
		const type = mediaTypeOfAudio(bytes);
		try {
			// 三家接口形状不同，猜错就是「一直听不到」：
			//   · 百炼 Qwen-ASR → /chat/completions + messages 里的 input_audio 块
			//   · MiniMax      → /v1/speech_to_text（multipart，模型 asr-1.0）
			//   · 其余（硅基流动 / OpenAI）→ /audio/transcriptions（multipart）
			const text = isDashScopeStt(c.sttBaseURL, c.sttModel, c.sttProvider)
				? await this.dashscopeTranscribe(c, bytes, type)
				: isMinimaxStt(c.sttBaseURL, c.sttModel, c.sttProvider)
					? await this.minimaxTranscribe(c, bytes, type)
					: await this.openaiTranscribe(c, bytes, type);
			this.count('stt');
			this.lastError = '';
			return text === '' ? null : text.slice(0, 500);
		} catch (error) {
			this.lastError = `听语音失败：${scrubSecrets(String(error instanceof Error ? error.message : error), c.sttApiKey)}`;
			this.log('warn', `[fish-soul] ${this.lastError}`);
			return null;
		}
	}

	/** OpenAI 兼容：multipart，POST /audio/transcriptions。 */
	async openaiTranscribe(c, bytes, type) {
		const form = new FormData();
		form.append('model', c.sttModel);
		form.append('file', new Blob([bytes], { type }), `voice.${EXT[type] ?? 'mp3'}`);
		const res = await this.post('/audio/transcriptions', { method: 'POST', body: form }, 'stt');
		const json = await this.readJsonLimited(res);
		// SenseVoice 会带 <|zh|><|NEUTRAL|> 这类标签
		return String(json?.text ?? '').replace(/<\|[^|]*\|>/g, '').trim();
	}

	/** MiniMax：multipart，POST /v1/speech_to_text，返回 { text }。 */
	async minimaxTranscribe(c, bytes, type) {
		const form = new FormData();
		form.append('model', c.sttModel || 'asr-1.0');
		form.append('file', new Blob([bytes], { type }), `voice.${EXT[type] ?? 'mp3'}`);
		const res = await this.post('/speech_to_text', { method: 'POST', body: form }, 'stt');
		const json = await this.readJsonLimited(res);
		const code = json?.base_resp?.status_code;
		if (code !== undefined && Number(code) !== 0) {
			throw new Error(`接口返回 ${code}${json.base_resp.status_msg ? `：${json.base_resp.status_msg}` : ''}`);
		}
		return String(json?.text ?? '').trim();
	}

	/**
	 * 阿里百炼：走 OpenAI 兼容的 /chat/completions，音频以 data URI 放进 input_audio。
	 *
	 * 🔴 不能走 /audio/transcriptions —— 百炼没有那个端点。这是「填了百炼却一直听不到」
	 *    的唯一原因（请求 404，catch 成「听语音失败」，界面上只剩一句听不到）。
	 */
	async dashscopeTranscribe(c, bytes, type) {
		const mime = type === 'unknown' ? 'audio/mpeg' : type;
		const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
		const res = await this.post('/chat/completions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: c.sttModel || 'qwen3-asr-flash',
				messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
				stream: false
			})
		}, 'stt');
		const json = await this.readJsonLimited(res);
		// 兼容两种回法：chat/completions 的 content，或万一走了别的形状的 text
		const content = json?.choices?.[0]?.message?.content;
		if (typeof content === 'string') return content.trim();
		if (Array.isArray(content)) {
			return content.map((x) => String(x?.text ?? '')).join('').trim();
		}
		return String(json?.text ?? '').trim();
	}

	/** 文字 → mp3（Buffer）；失败 / 没开 / 用完了返回 null（调用方改发文字）。 */
	async synthesize(text) {
		const t = String(text ?? '').trim();
		if (!this.readyFor('tts') || t === '') return null;
		const c = this.getConfig();
		if ([...t].length > c.maxChars) return null;
		if (this.quotaLeft('tts') <= 0) { this.lastError = '今天发语音的次数用完了'; return null; }
		try {
			const bytes = isVolcTts(c.ttsBaseURL, c.ttsModel, c.ttsProvider)
				? await this.volcSpeech(c, t)
				: isMinimaxTts(c.ttsBaseURL, c.ttsModel, c.ttsProvider)
					? await this.minimaxSpeech(c, t)
					: isMimoTts(c.ttsBaseURL, c.ttsModel)
						? await this.mimoSpeech(c, t)
						: await this.openaiSpeech(c, t);
			if (bytes === null || bytes.length === 0) throw new Error('返回的音频是空的');
			this.count('tts');
			this.lastError = '';
			return bytes;
		} catch (error) {
			this.lastError = `合成语音失败：${scrubSecrets(String(error instanceof Error ? error.message : error), c.ttsApiKey)}`;
			this.log('warn', `[fish-soul] ${this.lastError}`);
			return null;
		}
	}

	/** OpenAI 兼容：POST /audio/speech，返回音频字节。 */
	async openaiSpeech(c, t) {
		const res = await this.post('/audio/speech', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: c.ttsModel, input: t, voice: c.ttsVoice, response_format: 'mp3' })
		}, 'tts');
		return await this.readBodyLimited(res);
	}

	/**
	 * MiMo（小米）TTS：走 /chat/completions，要念的文本放在一条 assistant 消息里，
	 * 音频以 base64 回在 choices[0].message.audio.data。
	 */
	async mimoSpeech(c, t) {
		const res = await this.post('/chat/completions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: c.ttsModel,
				messages: [
					{ role: 'user', content: '请用自然口语的方式朗读下面这句话' },
					{ role: 'assistant', content: t }
				],
				audio: { format: 'mp3', voice: c.ttsVoice || 'mimo_default' },
				stream: false
			})
		}, 'tts');
		const json = await this.readJsonLimited(res);
		const data = json?.choices?.[0]?.message?.audio?.data;
		if (typeof data !== 'string' || data === '') throw new Error('接口没回音频数据');
		return Buffer.from(data, 'base64');
	}

	/**
	 * MiniMax TTS：POST /t2a_v2，请求体是它自己的结构。
	 *
	 * 🔴 `data.audio` 是 **hex**，不是 base64。按 base64 解不会报错，只会得到一堆乱码字节，
	 *    发出去是一条没人能听的语音 —— 所以这里必须 hex 解。
	 * `voice_id` 就是控制台里看到的音色 ID（系统音色或复刻出来的 ID）。
	 */
	async minimaxSpeech(c, t) {
		// 控制台里看到的音色名（「青年男声」「我的复刻音色」）不是 voice_id，填进去只会拿到
		// 一次 200 + base_resp 报错。在这里先说清楚，省掉一次白跑的请求。
		if (!/^[A-Za-z0-9_.:-]+$/.test(c.ttsVoice)) {
			throw new Error(`音色要填 MiniMax 控制台的 voice_id（英文/数字，如 male-qn-qingse 或复刻出来的 ID），不能填音色名「${c.ttsVoice}」`);
		}
		const res = await this.post('/t2a_v2', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: c.ttsModel || 'speech-02-hd',
				text: t,
				stream: false,
				voice_setting: { voice_id: c.ttsVoice, speed: 1, vol: 1, pitch: 0 },
				audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 }
			})
		}, 'tts');
		const json = await this.readJsonLimited(res);
		const code = json?.base_resp?.status_code;
		if (code !== undefined && Number(code) !== 0) {
			throw new Error(`接口返回 ${code}${json.base_resp.status_msg ? `：${json.base_resp.status_msg}` : ''}`);
		}
		const hex = json?.data?.audio;
		if (typeof hex !== 'string' || hex === '') throw new Error('接口没回音频数据');
		if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new Error('返回的音频不是 hex');
		return Buffer.from(hex, 'hex');
	}

	/**
	 * 火山引擎（豆包语音）：两条路。
	 *  - V3（新版控制台，只有 API Key）：POST /api/v3/tts/unidirectional，头 X-Api-Key /
	 *    X-Api-Resource-Id，回来是一串拼在一起的 JSON，音频分段 base64。
	 *  - V1（老版，AppID + Access Token）：POST /api/v1/tts，头 `Bearer; token`，整段 base64 回在 data。
	 * 鉴权头和 OpenAI 都不一样，所以不走 post()。
	 */
	async volcSpeech(c, t) {
		const url = volcUrl(c);
		const mode = volcMode(c);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs(c));
		timer.unref?.();
		let text;
		try {
			const headers = mode === 'v3'
				? {
					'content-type': 'application/json; charset=utf-8',
					'X-Api-Key': c.ttsApiKey,
					'X-Api-Resource-Id': c.volcResourceId || 'seed-tts-2.0',
					'X-Api-Request-Id': `fish-soul-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
				}
				: { 'content-type': 'application/json', authorization: `Bearer; ${c.ttsApiKey}` };
			const body = mode === 'v3'
				? {
					user: { uid: 'fish-soul' },
					req_params: { text: t, speaker: c.ttsVoice, audio_params: { format: 'mp3', sample_rate: 24000 } }
				}
				: {
					app: { appid: c.volcAppId, token: c.ttsApiKey, cluster: c.volcCluster || 'volcano_tts' },
					user: { uid: 'fish-soul' },
					audio: { voice_type: c.ttsVoice, encoding: 'mp3', speed_ratio: 1.0, volume_ratio: 1.0, pitch_ratio: 1.0 },
					request: { reqid: `fish-soul-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`, text: t, text_type: 'plain', operation: 'query' }
				};
			const res = await this.fetchImpl(url, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(body) });
			if (!res.ok) {
				const detail = await res.text().then((x) => `：${scrubSecrets(x.slice(0, 160), c.ttsApiKey)}`).catch(() => '');
				// 老版控制台的人容易只填 Access Token、忘填 AppID ⇒ 会被当成 V3 发出去，
				// 服务端只回 401/403。这时要指名道姓地提示该填什么，否则用户无从下手。
				const hint = mode === 'v3' && (res.status === 401 || res.status === 403)
					? '（如果你用的是老版控制台的 Access Token，请把「AppID」也填上；新版 API Key 则确认 Resource ID 与开通的音色）'
					: '';
				throw new Error(`HTTP ${res.status}${detail}${hint}`);
			}
			text = await res.text();
		} finally {
			clearTimeout(timer);
		}
		if (mode === 'v3') {
			const chunks = parseVolcStream(text);
			const failed = chunks.find((j) => Number(j?.code) !== 0 && Number(j?.code) !== 20000000);
			if (failed) throw new Error(`接口返回 code ${failed.code ?? '空'}${failed.message ? `：${String(failed.message).slice(0, 80)}` : ''}`);
			const parts = chunks
				.filter((j) => Number(j?.code) === 0 && typeof j.data === 'string' && j.data !== '')
				.map((j) => Buffer.from(j.data, 'base64'))
				.filter((b) => b.length > 0);
			if (parts.length === 0) throw new Error('接口没回音频数据');
			return Buffer.concat(parts);
		}
		let json;
		try { json = JSON.parse(text); } catch { throw new Error('返回内容不是合法 JSON'); }
		if (Number(json?.code) !== 3000) throw new Error(`接口返回 code ${json?.code ?? '空'}${json?.message ? `：${String(json.message).slice(0, 80)}` : ''}`);
		if (typeof json?.data !== 'string' || json.data === '') throw new Error('接口没回音频数据');
		return Buffer.from(json.data, 'base64');
	}

	/**
	 * 拿 QQ 语音的音频：先 get_record 转 mp3，再退回消息里的 url / 本地路径。
	 * @param {{call(action: string, params: object): Promise<any>}} channel
	 * @param {{file?: string, url?: string, path?: string}} rec
	 */
	async fetchQqRecord(channel, rec) {
		const fromData = async (d) => {
			if (!d) return null;
			const encoded = typeof d.base64 === 'string' ? d.base64.replace(/^base64:\/\//, '') : '';
			if (encoded && encoded.length <= Math.ceil(MAX_AUDIO_BYTES / 3) * 4) {
				const bytes = Buffer.from(encoded, 'base64');
				if (bytes.length && bytes.length <= MAX_AUDIO_BYTES) return bytes;
			}
			const p = String(d.file ?? d.path ?? '');
			const url = String(d.url ?? (/^https?:/i.test(p) ? p : ''));
			return url ? await safeDownload(url, { maxBytes: MAX_AUDIO_BYTES, timeoutMs: 8000 }) : null;
		};
		try {
			if (rec.file && typeof channel?.call === 'function') {
				const bytes = await fromData(await channel.call('get_record', { file: rec.file, out_format: 'mp3' }));
				if (bytes) return bytes;
			}
		} catch { /* 退回 url */ }
		try { return await fromData(rec); } catch { return null; }
	}

	state() {
		const c = this.getConfig();
		return {
			enabled: c.enabled, baseURL: c.baseURL, hasApiKey: c.apiKey !== '', hasOwnKey: c.hasOwnKey,
			ttsProvider: c.ttsProvider, volcAppId: c.volcAppId, volcCluster: c.volcCluster, volcResourceId: c.volcResourceId,
			volcMode: volcMode(c), hasVolcAppId: c.volcAppId !== '',
			sttProvider: c.sttProvider, sttModel: c.sttModel, ttsModel: c.ttsModel, ttsVoice: c.ttsVoice, speak: c.speak, maxChars: c.maxChars,
			ttsPerDay: c.ttsPerDay, sttPerDay: c.sttPerDay, timeoutSec: c.timeoutSec, ttsLeft: Math.max(0, this.quotaLeft('tts')), sttLeft: Math.max(0, this.quotaLeft('stt')),
			lastError: this.lastError
		};
	}
}
