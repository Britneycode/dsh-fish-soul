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
 * MiMo（小米）的 TTS 走 /chat/completions + audio 字段，不是 OpenAI 的 /audio/speech。
 * 认这个 hint 是为了不改用户填的模型名就能自动选对调用方式。
 */
function isMimoTts(baseURL, model) {
	const host = String(baseURL ?? '').toLowerCase();
	const m = String(model ?? '').toLowerCase();
	return host.includes('xiaomimimo') || /^mimo-.*tts/.test(m);
}

/** 能填进「说的服务商」的值；空串 = 按地址 / 模型自动认。 */
export const TTS_PROVIDERS = ['openai', 'mimo', 'volcengine'];

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

/** 设置里的 voice 段 → 规整后的参数（默认关）。听 / 说可以各用一套地址和 key。 */
export function voiceConfig(raw, embedding = {}) {
	const v = raw ?? {};
	const str = (x, d = '') => (typeof x === 'string' && x.trim() !== '' ? x.trim() : d);
	const num = (x, d, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };
	// 老配置只有 baseURL / apiKey（听说共用）→ 当作两侧的默认值
	const legacyBase = str(v.baseURL, str(embedding.baseURL, 'https://api.siliconflow.cn/v1')).replace(/\/+$/, '');
	const sameBase = str(v.baseURL) === '' || str(v.baseURL).replace(/\/+$/, '') === str(embedding.baseURL).replace(/\/+$/, '');
	const legacyKey = str(v.apiKey, sameBase ? str(embedding.apiKey) : '');
	const sttBase = str(v.sttBaseURL, legacyBase).replace(/\/+$/, '');
	const ttsBase = str(v.ttsBaseURL, legacyBase).replace(/\/+$/, '');
	const sttKey = str(v.sttApiKey, legacyKey);
	const ttsKey = str(v.ttsApiKey, legacyKey);
	const ttsModel = str(v.ttsModel, 'FunAudioLLM/CosyVoice2-0.5B');
	// 说的服务商：空 = 自动认；火山引擎老版要 AppID，新版只要 API Key
	const ttsProvider = TTS_PROVIDERS.includes(str(v.ttsProvider)) ? str(v.ttsProvider) : '';
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
		ttsBaseURL: ttsBase,
		ttsApiKey: ttsKey,
		sttModel: str(v.sttModel, 'FunAudioLLM/SenseVoiceSmall'),
		ttsModel,
		ttsVoice: str(v.ttsVoice, volc ? volcVoice : isMimoTts(ttsBase, ttsModel) ? 'mimo_default' : 'FunAudioLLM/CosyVoice2-0.5B:anna'),
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
			if (!res.ok) throw new Error(`HTTP ${res.status}${await res.text().then((t) => `：${t.slice(0, 120)}`).catch(() => '')}`);
			return res;
		} finally {
			clearTimeout(timer);
		}
	}

	/** 音频 → 文字；听不了 / 没开 / 用完了返回 null。 */
	async transcribe(bytes) {
		if (!this.readyFor('stt') || !bytes || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) return null;
		if (this.quotaLeft('stt') <= 0) { this.lastError = '今天听语音的次数用完了'; return null; }
		const c = this.getConfig();
		const type = mediaTypeOfAudio(bytes);
		try {
			const form = new FormData();
			form.append('model', c.sttModel);
			form.append('file', new Blob([bytes], { type }), `voice.${EXT[type] ?? 'mp3'}`);
			const res = await this.post('/audio/transcriptions', { method: 'POST', body: form }, 'stt');
			const json = await res.json();
			this.count('stt');
			const text = String(json?.text ?? '').replace(/<\|[^|]*\|>/g, '').trim(); // SenseVoice 会带 <|zh|><|NEUTRAL|> 这类标签
			this.lastError = '';
			return text === '' ? null : text.slice(0, 500);
		} catch (error) {
			this.lastError = `听语音失败：${String(error instanceof Error ? error.message : error)}`;
			this.log('warn', `[fish-soul] ${this.lastError}`);
			return null;
		}
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
				: isMimoTts(c.ttsBaseURL, c.ttsModel)
					? await this.mimoSpeech(c, t)
					: await this.openaiSpeech(c, t);
			if (bytes === null || bytes.length === 0) throw new Error('返回的音频是空的');
			this.count('tts');
			this.lastError = '';
			return bytes;
		} catch (error) {
			this.lastError = `合成语音失败：${String(error instanceof Error ? error.message : error)}`;
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
		return Buffer.from(await res.arrayBuffer());
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
		const json = await res.json();
		const data = json?.choices?.[0]?.message?.audio?.data;
		if (typeof data !== 'string' || data === '') throw new Error('接口没回音频数据');
		return Buffer.from(data, 'base64');
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
				const detail = await res.text().then((x) => `：${x.slice(0, 160)}`).catch(() => '');
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
			sttModel: c.sttModel, ttsModel: c.ttsModel, ttsVoice: c.ttsVoice, speak: c.speak, maxChars: c.maxChars,
			ttsPerDay: c.ttsPerDay, sttPerDay: c.sttPerDay, timeoutSec: c.timeoutSec, ttsLeft: Math.max(0, this.quotaLeft('tts')), sttLeft: Math.max(0, this.quotaLeft('stt')),
			lastError: this.lastError
		};
	}
}
