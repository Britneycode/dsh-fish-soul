import assert from 'node:assert/strict';
import { VoiceService, isDashScopeStt, isMinimaxStt, isMinimaxTts, normalizeSttBase, voiceConfig } from '../lib/voice.js';

// MiniMax 与阿里百炼的语音接口形状跟 OpenAI 不一样：
//  - 百炼 Qwen-ASR 没有 /audio/transcriptions，OpenAI 兼容模式走 /chat/completions
//    + messages 里的 input_audio 块（真机验证：/audio/transcriptions 回 404 空 body）；
//  - MiniMax 说的是 /t2a_v2，响应 data.audio 是 **hex** 不是 base64；
//    听的是 /v1/speech_to_text（multipart，模型 asr-1.0）；
//  - MiniMax 鉴权失败也回 **HTTP 200**，错误在 base_resp.status_code（真机：1004）。

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x21, 0x00]);
const db = { prepare() { return { run() {}, get() { return undefined; }, all() { return []; } }; } };
const svc = (cfg, fetchImpl) => new VoiceService({ db, getConfig: () => ({ ...voiceConfig(cfg), enabled: true }), fetchImpl });

// ── 1. 认服务商 ────────────────────────────────────────────────────────────
assert.equal(isDashScopeStt('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-asr-flash'), true, '地址认得出百炼');
assert.equal(isDashScopeStt('https://x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'qwen3-asr-flash'), true, '业务空间专属域名也认');
assert.equal(isDashScopeStt('', 'qwen3-asr-flash'), true, '模型名认得出');
assert.equal(isDashScopeStt('', 'paraformer-v2'), true, 'paraformer 也认');
// 硅基流动的 SenseVoice 不能被误判成百炼（否则会把能用的配置改成走错路径）
assert.equal(isDashScopeStt('https://api.siliconflow.cn/v1', 'FunAudioLLM/SenseVoiceSmall'), false, '硅基流动不是百炼');
assert.equal(isDashScopeStt('https://api.siliconflow.cn/v1', 'XingChenAGI/XingChenASR-V3.2-Ultra'), false, '星尘 ASR 不是百炼');
assert.equal(isDashScopeStt('https://dashscope.aliyuncs.com/compatible-mode/v1', 'x', 'openai'), false, '显式选 openai 就不走百炼');

assert.equal(isMinimaxTts('https://api.minimax.cn/v1', 'speech-02-hd'), true, 'MiniMax 说');
assert.equal(isMinimaxTts('', 'speech-2.8-hd'), true, '按模型名认');
assert.equal(isMinimaxTts('https://api.xiaomimimo.com/v1', 'mimo-v2.5-tts'), false, '小米不是 MiniMax');
assert.equal(isMinimaxStt('https://api.minimax.cn/v1', 'asr-1.0'), true, 'MiniMax 听');
assert.equal(isMinimaxStt('', 'asr-1.0', 'minimax'), true, '显式指定');
assert.equal(isMinimaxStt('https://api.siliconflow.cn/v1', 'FunAudioLLM/SenseVoiceSmall'), false, '硅基流动不是 MiniMax');

// ── 2. 默认模型按服务商走 ──────────────────────────────────────────────────
assert.equal(voiceConfig({ sttBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sttApiKey: 'k' }).sttModel, 'qwen3-asr-flash', '百炼默认 qwen3-asr-flash');
assert.equal(voiceConfig({ sttBaseURL: 'https://api.minimax.cn/v1', sttApiKey: 'k' }).sttModel, 'asr-1.0', 'MiniMax 默认 asr-1.0');
assert.equal(voiceConfig({ sttBaseURL: 'https://api.siliconflow.cn/v1', sttApiKey: 'k' }).sttModel, 'FunAudioLLM/SenseVoiceSmall', '其余沿用 SenseVoice');
assert.equal(voiceConfig({ ttsBaseURL: 'https://api.minimax.cn/v1', ttsApiKey: 'k', ttsModel: 'speech-02-hd' }).ttsVoice, 'male-qn-qingse', 'MiniMax 有默认音色');
assert.equal(voiceConfig({ sttProvider: '瞎填' }).sttProvider, '', '不认识的服务商忽略');

// ── 2b. 地址补全：只填域名也要能用，别的地址一个字符都不动 ────────────────
assert.equal(normalizeSttBase('https://dashscope.aliyuncs.com'), 'https://dashscope.aliyuncs.com/compatible-mode/v1', '百炼只填域名 → 补 compatible-mode/v1');
assert.equal(normalizeSttBase('https://dashscope.aliyuncs.com/'), 'https://dashscope.aliyuncs.com/compatible-mode/v1', '带尾斜杠也补');
assert.equal(normalizeSttBase('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'https://dashscope.aliyuncs.com/compatible-mode/v1', '已经写全就不重复拼');
assert.equal(normalizeSttBase('https://ws-abc.cn-beijing.maas.aliyuncs.com'), 'https://ws-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', '业务空间专属域名也补');
assert.equal(normalizeSttBase('https://api.minimax.cn'), 'https://api.minimax.cn/v1', 'MiniMax 只填域名 → 补 /v1');
assert.equal(normalizeSttBase('https://api.minimax.cn/v1'), 'https://api.minimax.cn/v1', 'MiniMax 写全不动');
// 别的服务商一个字都不能改
assert.equal(normalizeSttBase('https://api.siliconflow.cn/v1'), 'https://api.siliconflow.cn/v1', '硅基流动原样');
assert.equal(normalizeSttBase('https://my-proxy.example.com/asr'), 'https://my-proxy.example.com/asr', '自定义代理原样');
assert.equal(normalizeSttBase(''), '', '空还是空');

// 补全必须真的接进 voiceConfig —— 只测纯函数会漏掉「函数写好了但没调用」。
assert.equal(
	voiceConfig({ sttBaseURL: 'https://dashscope.aliyuncs.com', sttApiKey: 'k' }).sttBaseURL,
	'https://dashscope.aliyuncs.com/compatible-mode/v1',
	'配置里的百炼地址要补全，否则拼出来的 /chat/completions 是 404'
);
assert.equal(
	voiceConfig({ sttBaseURL: 'https://api.minimax.cn', sttApiKey: 'k' }).sttBaseURL,
	'https://api.minimax.cn/v1',
	'配置里的 MiniMax 地址要补 /v1'
);

// 回归：现在正在用的这套（硅基流动听 + 小米说）不能被改坏
const live = voiceConfig({ enabled: true, sttBaseURL: 'https://api.siliconflow.cn/v1', sttModel: 'XingChenAGI/XingChenASR-V3.2-Ultra', sttApiKey: 'a', ttsBaseURL: 'https://api.xiaomimimo.com/v1', ttsModel: 'mimo-v2.5-tts', ttsVoice: '冰糖', ttsApiKey: 'b' });
assert.equal(live.sttModel, 'XingChenAGI/XingChenASR-V3.2-Ultra', '硅基流动的模型原样保留');
assert.equal(live.ttsModel, 'mimo-v2.5-tts');
assert.equal(live.ttsVoice, '冰糖');

// ── 3. 百炼听：必须走 /chat/completions，不能走 /audio/transcriptions ──────
{
	let seenUrl = '';
	let seenBody = null;
	const s = svc(
		{ sttBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sttModel: 'qwen3-asr-flash', sttApiKey: 'k' },
		async (url, init) => {
			seenUrl = url;
			seenBody = JSON.parse(init.body);
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '今天天气不错' } }] }), text: async () => '' };
		}
	);
	const text = await s.transcribe(MP3);
	assert.equal(seenUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', '百炼走 chat/completions');
	assert.ok(!seenUrl.includes('/audio/transcriptions'), '绝不能走 /audio/transcriptions（百炼没这个端点）');
	assert.equal(text, '今天天气不错');
	assert.equal(seenBody.model, 'qwen3-asr-flash');
	const block = seenBody.messages[0].content[0];
	assert.equal(block.type, 'input_audio', '音频放在 input_audio 块里');
	assert.match(block.input_audio.data, /^data:audio\/[a-z0-9.+-]+;base64,/, '音频是 data URI');
	assert.equal(Buffer.from(block.input_audio.data.split(',')[1], 'base64').length, MP3.length, '音频字节完整带过去');
}

// ── 4. MiniMax 听：/speech_to_text，multipart，模型 asr-1.0 ────────────────
{
	let seenUrl = '';
	let seenForm = null;
	const s = svc(
		{ sttBaseURL: 'https://api.minimax.cn/v1', sttApiKey: 'k' },
		async (url, init) => {
			seenUrl = url;
			seenForm = init.body;
			return { ok: true, status: 200, json: async () => ({ text: '你好呀', base_resp: { status_code: 0 } }), text: async () => '' };
		}
	);
	const text = await s.transcribe(MP3);
	assert.equal(seenUrl, 'https://api.minimax.cn/v1/speech_to_text', 'MiniMax 听走 speech_to_text');
	assert.ok(seenForm instanceof FormData, '是 multipart');
	assert.equal(seenForm.get('model'), 'asr-1.0', '默认模型 asr-1.0');
	assert.ok(seenForm.get('file') instanceof Blob, '带 file');
	assert.equal(text, '你好呀');
}

// ── 5. MiniMax 说：hex 解码（按 base64 解不会报错，只会得到乱码） ──────────
{
	const realBytes = Buffer.from([0xff, 0xf3, 0x84, 0xc4, 0x00, 0x11, 0x22, 0x33]);
	const hex = realBytes.toString('hex');
	let seenUrl = '';
	let seenBody = null;
	const s = svc(
		{ ttsBaseURL: 'https://api.minimax.cn/v1', ttsModel: 'speech-02-hd', ttsVoice: 'my-cloned-voice', ttsApiKey: 'k' },
		async (url, init) => {
			seenUrl = url;
			seenBody = JSON.parse(init.body);
			return { ok: true, status: 200, json: async () => ({ data: { audio: hex, status: 2 }, base_resp: { status_code: 0 } }), text: async () => '' };
		}
	);
	const out = await s.synthesize('测试一下');
	assert.equal(seenUrl, 'https://api.minimax.cn/v1/t2a_v2', 'MiniMax 说走 t2a_v2');
	assert.deepEqual([...out], [...realBytes], 'hex 解出来的字节必须和原文一致');
	assert.equal(seenBody.voice_setting.voice_id, 'my-cloned-voice', '音色用用户填的 voice_id');
	assert.equal(seenBody.audio_setting.format, 'mp3');
	assert.equal(seenBody.stream, false);
}

// ── 6. MiniMax 鉴权失败回 200：必须靠 base_resp 拦下来 ────────────────────
{
	// 真机抓到的形状：HTTP 200 + status_code 1004
	const s = svc(
		{ ttsBaseURL: 'https://api.minimax.cn/v1', ttsModel: 'speech-02-hd', ttsApiKey: 'bad' },
		async () => ({ ok: true, status: 200, json: async () => ({ base_resp: { status_code: 1004, status_msg: 'login fail' } }), text: async () => '' })
	);
	assert.equal(await s.synthesize('测试'), null, '不能把鉴权失败当成成功');
	assert.match(s.lastError, /1004/, '错误里要带接口的 code，否则用户不知道是 key 的问题');
	assert.match(s.lastError, /login fail/, '带上接口原话');

	const stt = svc(
		{ sttBaseURL: 'https://api.minimax.cn/v1', sttApiKey: 'bad' },
		async () => ({ ok: true, status: 200, json: async () => ({ base_resp: { status_code: 1004, status_msg: 'login fail' } }), text: async () => '' })
	);
	assert.equal(await stt.transcribe(MP3), null);
	assert.match(stt.lastError, /1004/);
}

// ── 7. 音频不是 hex 时要明确报错，别把垃圾发出去 ──────────────────────────
{
	const s = svc(
		{ ttsBaseURL: 'https://api.minimax.cn/v1', ttsModel: 'speech-02-hd', ttsApiKey: 'k' },
		async () => ({ ok: true, status: 200, json: async () => ({ data: { audio: 'not-a-hex-string!!' }, base_resp: { status_code: 0 } }), text: async () => '' })
	);
	assert.equal(await s.synthesize('测试'), null);
	assert.match(s.lastError, /hex/);
}

// ── 7b. 音色填成音色名（不是 voice_id）要当场说清楚，别白跑一次请求 ──────
{
	let called = false;
	const s = svc(
		{ ttsBaseURL: 'https://api.minimax.cn/v1', ttsModel: 'speech-02-hd', ttsVoice: '我的复刻音色', ttsApiKey: 'k' },
		async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; }
	);
	assert.equal(await s.synthesize('测试'), null);
	assert.equal(called, false, '不该发这次请求');
	assert.match(s.lastError, /voice_id/, '要告诉用户该填 voice_id');
}

// ── 8. 百炼的 content 是数组时也能拼出来（两种回法都兼容） ────────────────
{
	const s = svc(
		{ sttBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sttApiKey: 'k' },
		async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: [{ text: '前半句' }, { text: '后半句' }] } }] }), text: async () => '' })
	);
	assert.equal(await s.transcribe(MP3), '前半句后半句');
}

// ── 9. 老路径不受影响：硅基流动仍然走 /audio/transcriptions ────────────────
{
	let seenUrl = '';
	const s = svc(
		{ sttBaseURL: 'https://api.siliconflow.cn/v1', sttModel: 'FunAudioLLM/SenseVoiceSmall', sttApiKey: 'k' },
		async (url) => {
			seenUrl = url;
			return { ok: true, status: 200, json: async () => ({ text: '<|zh|><|NEUTRAL|>你好' }), text: async () => '' };
		}
	);
	assert.equal(await s.transcribe(MP3), '你好', 'SenseVoice 的标签还是要剥掉');
	assert.equal(seenUrl, 'https://api.siliconflow.cn/v1/audio/transcriptions', '硅基流动保持原路径');
}

// ── 10. 空的识别结果当「没听清」，不能塞空串进上下文 ──────────────────────
{
	const s = svc(
		{ sttBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sttApiKey: 'k' },
		async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '   ' } }] }), text: async () => '' })
	);
	assert.equal(await s.transcribe(MP3), null, '空结果返回 null，调用方会显示「没听清」');
}

console.log('voice-minimax-dashscope: 全部通过');
