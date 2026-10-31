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
import { existsSync, readFileSync } from 'node:fs';
import { getKv, setKv } from './db.js';

const TIMEOUT_MS = 20_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const UNHEARD = '【语音（暂时听不了）】';

/** 设置里的 voice 段 → 规整后的参数（默认关）。 */
export function voiceConfig(raw, embedding = {}) {
	const v = raw ?? {};
	const str = (x, d = '') => (typeof x === 'string' && x.trim() !== '' ? x.trim() : d);
	const baseURL = str(v.baseURL, str(embedding.baseURL, 'https://api.siliconflow.cn/v1')).replace(/\/+$/, '');
	const sameBase = str(v.baseURL) === '' || str(v.baseURL).replace(/\/+$/, '') === str(embedding.baseURL).replace(/\/+$/, '');
	const num = (x, d, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };
	return {
		enabled: v.enabled === true,
		baseURL,
		apiKey: str(v.apiKey, sameBase ? str(embedding.apiKey) : ''),
		hasOwnKey: str(v.apiKey) !== '',
		sttModel: str(v.sttModel, 'FunAudioLLM/SenseVoiceSmall'),
		ttsModel: str(v.ttsModel, 'FunAudioLLM/CosyVoice2-0.5B'),
		ttsVoice: str(v.ttsVoice, 'FunAudioLLM/CosyVoice2-0.5B:anna'),
		// 她什么时候发语音：never 从不 / mirror 对方发语音时可以 / sometimes 偶尔自己想发
		speak: ['never', 'mirror', 'sometimes'].includes(v.speak) ? v.speak : 'mirror',
		maxChars: num(v.maxChars, 60, 10, 200),
		ttsPerDay: num(v.ttsPerDay, 30, 0, 500),
		sttPerDay: num(v.sttPerDay, 200, 0, 2000)
	};
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
		return c.enabled && c.apiKey !== '';
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

	async post(path, init) {
		const c = this.getConfig();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		timer.unref?.();
		try {
			const res = await this.fetchImpl(`${c.baseURL}${path}`, { ...init, signal: controller.signal, headers: { authorization: `Bearer ${c.apiKey}`, ...(init.headers ?? {}) } });
			if (!res.ok) throw new Error(`HTTP ${res.status}${await res.text().then((t) => `：${t.slice(0, 120)}`).catch(() => '')}`);
			return res;
		} finally {
			clearTimeout(timer);
		}
	}

	/** 音频 → 文字；听不了 / 没开 / 用完了返回 null。 */
	async transcribe(bytes) {
		if (!this.ready() || !bytes || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) return null;
		if (this.quotaLeft('stt') <= 0) { this.lastError = '今天听语音的次数用完了'; return null; }
		const c = this.getConfig();
		const type = mediaTypeOfAudio(bytes);
		try {
			const form = new FormData();
			form.append('model', c.sttModel);
			form.append('file', new Blob([bytes], { type }), `voice.${EXT[type] ?? 'mp3'}`);
			const res = await this.post('/audio/transcriptions', { method: 'POST', body: form });
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
		if (!this.ready() || t === '') return null;
		const c = this.getConfig();
		if ([...t].length > c.maxChars) return null;
		if (this.quotaLeft('tts') <= 0) { this.lastError = '今天发语音的次数用完了'; return null; }
		try {
			const res = await this.post('/audio/speech', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: c.ttsModel, input: t, voice: c.ttsVoice, response_format: 'mp3' })
			});
			const bytes = Buffer.from(await res.arrayBuffer());
			if (bytes.length === 0) throw new Error('返回的音频是空的');
			this.count('tts');
			this.lastError = '';
			return bytes;
		} catch (error) {
			this.lastError = `合成语音失败：${String(error instanceof Error ? error.message : error)}`;
			this.log('warn', `[fish-soul] ${this.lastError}`);
			return null;
		}
	}

	/**
	 * 拿 QQ 语音的音频：先 get_record 转 mp3，再退回消息里的 url / 本地路径。
	 * @param {{call(action: string, params: object): Promise<any>}} channel
	 * @param {{file?: string, url?: string, path?: string}} rec
	 */
	async fetchQqRecord(channel, rec) {
		const fromData = async (d) => {
			if (!d) return null;
			if (typeof d.base64 === 'string' && d.base64 !== '') return Buffer.from(d.base64.replace(/^base64:\/\//, ''), 'base64');
			const p = String(d.file ?? d.path ?? '');
			if (p !== '' && !/^https?:/i.test(p) && existsSync(p)) return readFileSync(p);
			const url = String(d.url ?? (/^https?:/i.test(p) ? p : ''));
			if (url !== '') {
				const res = await this.fetchImpl(url);
				if (res.ok) return Buffer.from(await res.arrayBuffer());
			}
			return null;
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
			sttModel: c.sttModel, ttsModel: c.ttsModel, ttsVoice: c.ttsVoice, speak: c.speak, maxChars: c.maxChars,
			ttsPerDay: c.ttsPerDay, sttPerDay: c.sttPerDay, ttsLeft: Math.max(0, this.quotaLeft('tts')), sttLeft: Math.max(0, this.quotaLeft('stt')),
			lastError: this.lastError
		};
	}
}
