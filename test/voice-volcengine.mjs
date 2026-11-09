import assert from 'node:assert/strict';
import { VoiceService, isVolcTts, parseVolcStream, volcMode, volcUrl, voiceConfig } from '../lib/voice.js';

// 火山引擎（豆包语音）TTS：两条路
//  - V3（新版控制台，只有 API Key）：/api/v3/tts/unidirectional，头 X-Api-Key，回来是一串拼在一起的
//    JSON，音频分段 base64（最后还有个 {code:20000000,message:"OK"}）；
//  - V1（老版，AppID + Access Token）：/api/v1/tts，头 Bearer; token，整段 base64 回在 data。

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
const db = { prepare() { return { run() {}, get() { return undefined; }, all() { return []; } }; } };

// 1. 认服务商：显式选了听它的，没选才按地址 / 模型猜
assert.equal(isVolcTts('https://openspeech.bytedance.com', 'x'), true, '地址认得出火山');
assert.equal(isVolcTts('', 'volc-tts-1'), true, '模型名 volc 开头也认');
assert.equal(isVolcTts('', 'doubao-tts'), true);
assert.equal(isVolcTts('https://openspeech.bytedance.com', 'x', 'openai'), false, '显式选 OpenAI 就不走火山');
assert.equal(isVolcTts('https://api.siliconflow.cn/v1', 'FunAudioLLM/CosyVoice2-0.5B:anna'), false);

// 2. 模式：有没有 AppID 决定 V1 还是 V3
assert.equal(volcMode(voiceConfig({ ttsProvider: 'volcengine', ttsApiKey: 'ak' })), 'v3', '没 AppID = 新版 API Key');
assert.equal(volcMode(voiceConfig({ ttsProvider: 'volcengine', ttsApiKey: 'tok', volcAppId: 'app1' })), 'v1', '有 AppID = 老版');

// 3. 配置：默认音色按模式走；Resource ID 有默认值
const v3cfg = voiceConfig({ ttsProvider: 'volcengine', ttsApiKey: 'ak' });
assert.equal(v3cfg.ttsVoice, 'zh_female_shuangkuaisisi_uranus_bigtts', 'V3 默认 2.0 音色');
assert.equal(v3cfg.volcResourceId, 'seed-tts-2.0', 'V3 默认 Resource ID');
const v1cfg = voiceConfig({ ttsProvider: 'volcengine', ttsApiKey: 'tok', volcAppId: 'app1', ttsBaseURL: 'https://openspeech.bytedance.com' });
assert.equal(v1cfg.ttsVoice, 'zh_female_qingxin', 'V1 默认音色');
assert.equal(v1cfg.volcCluster, 'volcano_tts', '默认集群');
assert.equal(voiceConfig({ ttsProvider: '瞎填的' }).ttsProvider, '', '不认识的服务商忽略');

// 4. 地址：按模式补路径；沿用硅基那套默认地址时回落到火山官方；自定义 proxy / 完整路径原样保留
assert.equal(volcUrl(voiceConfig({ ttsProvider: 'volcengine' })), 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', '没填地址用火山 V3 官方');
assert.equal(volcUrl(voiceConfig({ ttsProducer: 'x', ttsBaseURL: 'https://openspeech.bytedance.com' })), 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', 'V3 补全路径');
assert.equal(volcUrl(voiceConfig({ ttsBaseURL: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional' })), 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', 'V3 完整路径不重复拼');
assert.equal(volcUrl(voiceConfig({ ttsProvider: 'volcengine', ttsBaseURL: 'https://my-proxy.example.com/volc' })), 'https://my-proxy.example.com/volc/api/v3/tts/unidirectional', '自定义地址保留');
assert.equal(volcUrl(v1cfg), 'https://openspeech.bytedance.com/api/v1/tts', 'V1 地址');
assert.equal(volcUrl(voiceConfig({ ttsProvider: 'volcengine', volcEndpoint: 'https://other.example.com/api/v1/tts' })), 'https://other.example.com/api/v1/tts', 'volcEndpoint 能覆盖');

// 5. readyFor：V3 只要 API Key；V1 还得有 AppID
const noApp = new VoiceService({ db, getConfig: () => voiceConfig({ enabled: true, ttsProvider: 'volcengine', ttsApiKey: 'ak' }), fetchImpl: async () => { throw new Error('不该发请求'); } });
assert.equal(noApp.readyFor('tts'), true, '新版只填 API Key 就绪');
const noKey = new VoiceService({ db, getConfig: () => voiceConfig({ enabled: true, ttsProvider: 'volcengine', volcAppId: 'app1' }) });
assert.equal(noKey.readyFor('tts'), false, '没 key 不就绪');
const full = v1cfg;
full.enabled = true;
assert.equal(new VoiceService({ db, getConfig: () => full }).readyFor('tts'), true);

// 6. 流式 JSON 解析：几个拼在一起的、SSE 前缀、字符串里的括号都不能弄错
assert.deepEqual(parseVolcStream('{"code":0,"data":"AA=="}{"code":20000000,"message":"OK"}').map((j) => j.code), [0, 20000000], '连着的两个对象');
assert.equal(parseVolcStream('data: {"code":0,"data":"AA=="}\ndata: {"code":20000000}\n').length, 2, 'SSE 前缀');
assert.deepEqual(parseVolcStream('{"code":0,"message":"a}b{c","data":"AA=="}')[0].message, 'a}b{c', '字符串里的括号');
assert.deepEqual(parseVolcStream('{"code":0,"data":"A\\"B"}')[0].data, 'A"B', '字符串里的转义引号');

// 7. V3 请求形状：地址、三个头、body
const calls = [];
const v3 = new VoiceService({
	db,
	getConfig: () => voiceConfig({ enabled: true, ttsProvider: 'volcengine', ttsApiKey: 'ak' }),
	fetchImpl: async (url, init) => {
		calls.push([url, init]);
		return new Response(JSON.stringify({ code: 0, data: MP3.toString('base64') }) + JSON.stringify({ code: 20000000, message: 'OK' }), { status: 200 });
	}
});
assert.deepEqual(await v3.synthesize('你好呀'), MP3, 'V3 解回音频');
assert.equal(calls[0][0], 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', 'V3 地址');
assert.equal(calls[0][1].headers['X-Api-Key'], 'ak', 'X-Api-Key 带 key');
assert.equal(calls[0][1].headers['X-Api-Resource-Id'], 'seed-tts-2.0', '默认资源 id');
assert.ok(String(calls[0][1].headers['X-Api-Request-Id'] ?? '').length > 0, '带请求 id');
assert.equal(calls[0][1].headers.authorization, undefined, 'V3 不用 Bearer 头');
const v3body = JSON.parse(calls[0][1].body);
assert.equal(v3body.req_params.text, '你好呀');
assert.equal(v3body.req_params.speaker, 'zh_female_shuangkuaisisi_uranus_bigtts');
assert.equal(v3body.req_params.audio_params.format, 'mp3');

// 8. V3 多段音频要按顺序拼起来
const part2 = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const multi = new VoiceService({
	db,
	getConfig: () => voiceConfig({ enabled: true, ttsProvider: 'volcengine', ttsApiKey: 'ak' }),
	fetchImpl: async () => new Response(
		JSON.stringify({ code: 0, data: MP3.toString('base64') }) + JSON.stringify({ code: 0, data: part2.toString('base64') }) + JSON.stringify({ code: 20000000, message: 'OK' }),
		{ status: 200 })
});
assert.deepEqual(await multi.synthesize('分段'), Buffer.concat([MP3, part2]), '分段按顺序拼');

// 9. V3 失败：中间夹错误码 / HTTP 403（资源没授权就是 403）
const v3bad = new VoiceService({
	db,
	getConfig: () => voiceConfig({ enabled: true, ttsProvider: 'volcengine', ttsApiKey: 'ak' }),
	fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: MP3.toString('base64') }) + JSON.stringify({ code: 55000000, message: 'resource ID is mismatched with speaker related resource' }), { status: 200 })
});
assert.equal(await v3bad.synthesize('你好'), null);
assert.match(v3bad.lastError, /55000000/);
assert.match(v3bad.lastError, /mismatched/);
const v3http = new VoiceService({
	db,
	getConfig: () => voiceConfig({ enabled: true, ttsProvider: 'volcengine', ttsApiKey: 'ak' }),
	fetchImpl: async () => new Response('{"header":{"code":45000030,"message":"requested resource not granted"}}', { status: 403 })
});
assert.equal(await v3http.synthesize('你好'), null);
assert.match(v3http.lastError, /403/);
assert.match(v3http.lastError, /not granted/);

// 10. V1 请求形状（老版 AppID + Token）
const v1calls = [];
const v1 = new VoiceService({
	db,
	getConfig: () => full,
	fetchImpl: async (url, init) => {
		v1calls.push([url, init]);
		return new Response(JSON.stringify({ code: 3000, data: MP3.toString('base64') }), { status: 200 });
	}
});
assert.deepEqual(await v1.synthesize('你好呀'), MP3, 'V1 解回音频');
assert.equal(v1calls[0][0], 'https://openspeech.bytedance.com/api/v1/tts', 'V1 地址');
assert.equal(v1calls[0][1].headers.authorization, 'Bearer; tok', 'V1 是 Bearer; 分号');
const v1body = JSON.parse(v1calls[0][1].body);
assert.equal(v1body.app.appid, 'app1');
assert.equal(v1body.app.token, 'tok');
assert.equal(v1body.app.cluster, 'volcano_tts');
assert.equal(v1body.audio.voice_type, 'zh_female_qingxin');
assert.equal(v1body.request.operation, 'query');

// 11. V1 失败码
const v1bad = new VoiceService({
	db,
	getConfig: () => full,
	fetchImpl: async () => new Response(JSON.stringify({ code: 3050, message: 'quota exceeded' }), { status: 200 })
});
assert.equal(await v1bad.synthesize('你好'), null);
assert.match(v1bad.lastError, /3050/);
assert.match(v1bad.lastError, /quota exceeded/);

// 12. 普通 OpenAI 兼容那边没被改坏
const plain = [];
const openai = new VoiceService({
	db,
	getConfig: () => voiceConfig({ enabled: true, ttsApiKey: 'sk', ttsBaseURL: 'https://api.siliconflow.cn/v1' }),
	fetchImpl: async (url, init) => { plain.push([url, init]); return new Response(MP3, { status: 200 }); }
});
assert.deepEqual(await openai.synthesize('嗨'), MP3);
assert.equal(plain[0][0], 'https://api.siliconflow.cn/v1/audio/speech');
assert.equal(plain[0][1].headers.authorization, 'Bearer sk', 'OpenAI 那边还是 Bearer 空格');

console.log('voice-volcengine ok');
