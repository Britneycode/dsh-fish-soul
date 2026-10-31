// v0.7 的冒烟测试（按功能选模型 + 用量、语音 STT / TTS、收藏表情包、学群里的说法、上网查、首次引导），
// 由 smoke.mjs 在同一个插件实例上最后调用；共用的假宿主 / 假服务从参数传进来。
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)]);

export async function run(t) {
	const { assert, ok, call, sleep, waitFor, context, db, host, services, agents, workspaceRegistry, at, tools, guard, sid1, route, mod } = t;
	const { setKv, getKv } = await import('../lib/db.js');
	const llmMod = await import('../lib/llm.js');
	const voiceMod = await import('../lib/voice.js');
	const stMod = await import('../lib/stickers.js');
	const slMod = await import('../lib/slang.js');
	const gwMod = await import('../lib/gateway.js');
	const { segmentsToText } = await import('../lib/channels/onebot.js');
	let p;

	// 50 选模型：按功能指定 → DSH 默认 → 第一个提供方的第一个模型；用量（宿主 usage 块 / 按字数估）
	{
		const streams = [];
		let fail = false;
		const fake = {
			listProviders: () => [{ id: 'ds', name: 'DeepSeek' }, { id: 'sf', name: '硅基流动' }],
			listModels: async (prov) => (prov === 'ds' ? [{ id: 'ds-chat', name: 'V3' }, { id: 'ds-r1', name: 'R1' }] : [{ id: 'qwen', name: 'Qwen' }]),
			async *stream(o) {
				streams.push(o);
				if (fail) throw new Error('boom');
				yield { type: 'text-delta', text: '好' };
				if (o.model === 'ds-chat') yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } };
			}
		};
		let sel = null;
		const svc = { llm: fake, agentDefaultModel: { currentSelection: () => sel } };
		const cfg = { models: {}, modelPrices: { 'ds-chat': { in: 2, out: 8 } } };
		const r = new llmMod.LlmRouter({ ctx: { get: (n) => svc[n] }, db, getConfig: () => cfg });
		assert.deepEqual(await r.resolve('dream'), { provider: 'ds', model: 'ds-chat', from: 'first' }, '没有默认就用第一个');
		sel = { provider: 'sf', model: 'qwen' };
		assert.deepEqual(await r.resolve('dream'), { provider: 'sf', model: 'qwen', from: 'host' }, '跟 DSH 默认');
		cfg.models.dream = { provider: 'ds', model: 'ds-r1' };
		assert.deepEqual(await r.resolve('dream'), { provider: 'ds', model: 'ds-r1', from: 'feature' }, '按功能指定');
		cfg.models.dream = { provider: 'gone', model: 'x' };
		assert.equal((await r.resolve('dream')).from, 'host', '指定的提供方没了就回到默认');
		const before = r.usage(1).byFeature.schedule?.calls ?? 0;
		sel = { provider: 'ds', model: 'ds-chat' };
		assert.equal(await r.bound('schedule')('排一下今天'), '好');
		assert.deepEqual([streams.at(-1).provider, streams.at(-1).model], ['ds', 'ds-chat'], '调用时带上 provider / model（v0.6 的 bug）');
		sel = { provider: 'sf', model: 'qwen' };
		assert.equal(await r.call('一二三四五六七八', { feature: 'schedule' }), '好');
		fail = true;
		assert.equal(await r.call('x', { feature: 'schedule' }), null);
		assert.equal(r.lastError, 'boom');
		const u = r.usage(1);
		assert.equal(u.byFeature.schedule.calls - before, 3);
		assert.ok(u.byFeature.schedule.failed >= 1 && u.byFeature.schedule.estimated >= 2);
		assert.ok(u.byModel['ds-chat'].in >= 100 && u.byModel['ds-chat'].out >= 20, '宿主报的真实用量');
		assert.ok(u.byModel.qwen.in >= 8 && u.byModel.qwen.cost === null, '没 usage 块就按字数估；没填单价不算钱');
		assert.ok(u.byModel['ds-chat'].cost >= (100 * 2 + 20 * 8) / 1e6);
		assert.equal(llmMod.estimateTokens('你好abcd'), 3);
		// 宿主一个都报不出来：不指定模型，交给宿主（老行为）
		const r2 = new llmMod.LlmRouter({ ctx: { get: (n) => (n === 'llm' ? { listProviders: () => [], async *stream(o) { streams.push(o); yield { type: 'text-delta', text: '嗯' }; } } : undefined) }, db, getConfig: () => ({}) });
		assert.equal(await r2.call('x'), '嗯');
		assert.equal('provider' in streams.at(-1), false);
	}
	ok('选模型：按功能 → DSH 默认 → 第一个；调用带 provider / model；用量按天 × 功能 × 模型记（真实 / 估算），按单价算花费');

	// 51 纯函数：语音配置、收藏表情解析、学说法配置、QQ 语音 / 表情消息段
	{
		const v = voiceMod.voiceConfig(undefined, { baseURL: 'https://api.siliconflow.cn/v1/', apiKey: 'sk-emb' });
		assert.deepEqual([v.enabled, v.apiKey, v.speak, v.maxChars, v.hasOwnKey], [false, 'sk-emb', 'mirror', 60, false], '默认关、沿用检索的 key');
		assert.equal(voiceMod.voiceConfig({ baseURL: 'https://other/v1' }, { baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-emb' }).apiKey, '', '换了地址不带检索的 key');
		assert.equal(voiceMod.voiceConfig({ speak: 'loud', maxChars: 5 }).speak, 'mirror');
		assert.equal(voiceMod.voiceConfig({ maxChars: 5 }).maxChars, 10);
		assert.deepEqual(stMod.parseCollect('哈哈\n[收藏表情:狗头]\n[存表情：猫猫/震惊]'), { text: '哈哈', names: ['狗头', '猫猫/震惊'] });
		assert.equal(stMod.stickerName(' ../猫猫/震惊?.png '), '猫猫震惊');
		assert.deepEqual(stMod.stickerConfig(undefined), { collect: true, perDay: 10 });
		assert.deepEqual(slMod.slangConfig(undefined), { enabled: true, minLines: 60, intervalHours: 6 });
		const s = segmentsToText([{ type: 'record', data: { file: 'a.amr', url: 'http://x/a' } }, { type: 'image', data: { file: 'f1', sub_type: 1 } }, { type: 'mface', data: { url: 'u', summary: '[狗头]' } }, { type: 'image', data: { file: 'f2' } }]);
		assert.deepEqual(s.records, [{ file: 'a.amr', url: 'http://x/a', path: undefined }]);
		assert.deepEqual(s.images.map((x) => x.sticker), [true, true, false]);
		assert.match(s.text, /^【语音（暂时听不了）】【表情图】【表情：/);
	}
	ok('v0.7 纯函数：语音默认关（沿用检索 key 的条件）、[收藏表情:名字] 解析、文件名清洗、QQ 语音 / 表情段');

	// 52 学群里的说法：攒话 → 模型提炼 → 进上下文（先放提到的）；主人改的不被覆盖
	{
		const prompts = [];
		let reply = { terms: [{ term: '绷不住了', meaning: '忍不住笑', example: '绷不住了哈哈' }, { term: 'v我50', meaning: '开玩笑要钱' }, { term: '', meaning: 'x' }], style: '短句多，爱用草' };
		const cfg = { enabled: true, minLines: 10, intervalHours: 0 };
		const sl = new slMod.SlangLearner({ db, callLlm: async (pr) => { prompts.push(pr); return `好的\n${JSON.stringify(reply)}`; }, getConfig: () => cfg, personaName: () => '小鱼', titleOf: () => '摸鱼群' });
		sl.observe('private:1', 'a', '私聊不学');
		sl.observe('group:8801', 'a', '【表情图】');
		for (let i = 0; i < 12; i++) sl.observe('group:8801', `u${i % 3}`, `第${i}句 绷不住了`);
		assert.equal(sl.buffer('group:8801').lines.length, 12, '只学群、纯占位符不算');
		assert.equal(sl.buffer('private:1').lines.length, 0);
		await sl.tick();
		assert.equal(prompts.length, 1); assert.match(prompts[0], /QQ 群「摸鱼群」/); assert.match(prompts[0], /u1：第1句/);
		let d = sl.data('group:8801');
		assert.deepEqual(d.terms.map((x) => x.term).sort(), ['v我50', '绷不住了'].sort());
		assert.equal(d.style, '短句多，爱用草');
		await sl.tick();
		assert.equal(prompts.length, 1, '新话不够不再学');
		const lines = sl.contextLines('group:8801', '你v我50');
		assert.equal(lines[0], '[这个群的说话习惯] 短句多，爱用草');
		assert.match(lines[1], /^\[群里的梗（自然用，别硬套）\] v我50：开玩笑要钱；绷不住了/, '这轮提到的放前面');
		sl.edit('group:8801', { style: '主人写的风格', add: { term: '老地方', meaning: '后门烧烤' } });
		reply = { terms: [{ term: '老地方', meaning: '模型乱改' }], style: '模型的新风格', drop: ['老地方', 'v我50'] };
		const r = await sl.learn('group:8801');
		assert.equal(r.ok, true);
		d = sl.data('group:8801');
		assert.equal(d.style, '主人写的风格', '主人改过的风格不覆盖');
		assert.equal(d.terms.find((x) => x.term === '老地方').meaning, '后门烧烤', '主人加的词不被模型改 / 删');
		assert.equal(d.terms.some((x) => x.term === 'v我50'), false, '模型说不用了就删');
		cfg.enabled = false;
		assert.deepEqual(sl.contextLines('group:8801'), []);
		assert.equal((await new slMod.SlangLearner({ db, callLlm: async () => null, getConfig: () => cfg, personaName: () => '', titleOf: () => '' }).learn('group:8801')).ok, false);
	}
	ok('学群里的说法：只学群、攒够才学、提炼梗和风格、提到的梗先给她看、主人改的不被覆盖');

	// 53 独立网关：听语音（转文字）→ 回 [语音] 段（合成）/ 合成不了发文字；[收藏表情:名字] 存表情、这行不发
	const wsDir = mkdtempSync(join(tmpdir(), 'fish-v07-ws-'));
	let collectedFile = '';
	{
		const vcfg = { enabled: true, apiKey: 'sk-v', speak: 'mirror' };
		const vcalls = [];
		const voice = new voiceMod.VoiceService({ db, getConfig: () => voiceMod.voiceConfig(vcfg), fetchImpl: async (url, init) => {
			vcalls.push([url, init?.body instanceof FormData ? 'form' : String(init?.body ?? '')]);
			if (/transcriptions$/.test(url)) return new Response(JSON.stringify({ text: '<|zh|><|NEUTRAL|>今天好累啊' }), { status: 200 });
			if (/speech$/.test(url)) return new Response(MP3, { status: 200 });
			return new Response('', { status: 404 });
		} });
		const stickers = new stMod.StickerBox({ db, getConfig: () => stMod.stickerConfig({}) });
		const seen = [];
		const slang = { observe: (...a) => seen.push(a) };
		const qq = { enabled: true, batchMs: 30, followUpCount: 3, followUpSeconds: 120 };
		const sent = []; const turns = []; const chCalls = [];
		const reg = { create: async (path, title) => ({ path, title, attachSession: async () => {} }), list: () => [{ path: wsDir, title: 'v07', sessionIds: [] }] };
		const ctx4 = { get: (n) => (n === 'workspaceRegistry' ? reg : services[n]), agents, workspaceRegistry: reg, tools: { get: () => ({}) } };
		const gw = new gwMod.ChatGateway({
			ctx: ctx4, db, clock: { now: () => Date.now() }, getConfig: () => ({ qq, masterQqUin: '10001', sessions: { workspacePath: wsDir } }), log: () => {},
			channel: {
				connected: true, selfId: '1000', isFriend: () => true, groupName: async () => '测试群', getMessage: async () => null,
				send: async (cid, segs) => { sent.push([cid, segs]); return String(8800 + sent.length); },
				call: async (action, params) => { chCalls.push([action, params]); return action === 'get_record' ? { base64: MP3.toString('base64') } : null; }
			},
			soul: {
				beginTurn: (id, x) => turns.push({ id, ...x }), nowLabel: () => '现在', resolvePerson: () => null,
				memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => []
			},
			voice, stickers, slang
		});
		gw.random = () => 0.5;
		let mid = 9900;
		const priv = (user, segs) => gw.onEvent({ post_type: 'message', message_type: 'private', user_id: user, message_id: ++mid, sender: { nickname: `p${user}` }, message: segs });
		const fups = (cid) => host.followups.filter((f) => f.msg.source?.channelId === cid);
		const reply = (f, text) => {
			gw.onSessionEvent({ id: f.id }, { type: 'user/message', data: f.msg });
			gw.onSessionEvent({ id: f.id }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } });
			gw.onSessionEvent({ id: f.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
		};

		await priv(70007, [{ type: 'record', data: { file: 'v1.amr' } }]);
		await waitFor(() => fups('private:70007').length === 1);
		const f1 = fups('private:70007')[0];
		assert.match(f1.msg.content[0].text, /【语音】今天好累啊/, '听懂了，标签去掉');
		assert.deepEqual(chCalls[0], ['get_record', { file: 'v1.amr', out_format: 'mp3' }]);
		assert.equal(turns.at(-1).voiceIn, true);
		reply(f1, '[语音] 抱抱你\n\n早点睡哦');
		await waitFor(() => sent.length === 2);
		assert.equal(sent[0][1][0].type, 'record'); assert.match(sent[0][1][0].data.file, /^base64:\/\//);
		assert.deepEqual(sent[1][1], [{ type: 'text', data: { text: '早点睡哦' } }]);
		assert.match(gw.decisions[0].text, /🔊抱抱你 \/ 早点睡哦/);
		assert.match(vcalls.find((c) => /speech$/.test(c[0]))[1], /"input":"抱抱你"/);

		// 语音关着：听不了保持占位；[语音] 段发成文字
		vcfg.enabled = false;
		await priv(70007, [{ type: 'record', data: { file: 'v2.amr' } }]);
		await waitFor(() => fups('private:70007').length === 2);
		const f2 = fups('private:70007')[1];
		assert.match(f2.msg.content[0].text, /【语音（暂时听不了）】/);
		reply(f2, '[语音] 听不清诶');
		await waitFor(() => sent.length === 3);
		assert.deepEqual(sent[2][1], [{ type: 'text', data: { text: '听不清诶' } }]);
		vcfg.enabled = true;

		// 收藏表情：对方发表情 → 她回 [收藏表情:狗头] → 存进工作区 _stickers，这行不发
		await priv(70007, [{ type: 'image', data: { file: `base64://${PNG.toString('base64')}`, sub_type: 1, summary: '[动画表情]' } }, { type: 'text', data: { text: '哈哈哈' } }]);
		await waitFor(() => fups('private:70007').length === 3);
		const f3 = fups('private:70007')[2];
		const n = sent.length;
		reply(f3, '[收藏表情:狗头]');
		await waitFor(() => gw.decisions.some((x) => x.kind === 'sticker'));
		await sleep(50);
		assert.equal(sent.length, n, '只有收藏这一行就什么都不发');
		const ws = gw.bound.get(f3.id).workspace_path;
		assert.equal(existsSync(join(ws, '_stickers', '狗头.png')), true);
		assert.equal(stickers.collected()[0].file, '狗头.png');
		collectedFile = { file: '狗头.png', ws };
		// 同一张再存：去重；带正文的收藏行：正文照发
		await priv(70007, [{ type: 'image', data: { file: `base64://${PNG.toString('base64')}`, sub_type: 1 } }]);
		await waitFor(() => fups('private:70007').length === 4);
		reply(fups('private:70007')[3], '这个也好玩\n[收藏表情:狗头2]');
		await waitFor(() => sent.length === n + 1);
		assert.deepEqual(sent[n][1], [{ type: 'text', data: { text: '这个也好玩' } }]);
		assert.match(gw.decisions.find((x) => x.kind === 'sticker-skip').reason, /已经存过了/);

		// 群里的话交给学说法（点没点名都算）
		await gw.onEvent({ post_type: 'message', message_type: 'group', group_id: 8802, user_id: 30003, message_id: ++mid, sender: { card: '阿三' }, message: [{ type: 'text', data: { text: '今天也绷不住了' } }] });
		assert.deepEqual(seen.at(-1), ['group:8802', '阿三', '今天也绷不住了']);
	}
	ok('网关：QQ 语音转文字给她听；[语音] 段合成语音发（关着就发文字）；[收藏表情:名字] 存表情不发、同图去重；群话交给学说法');

	// 54 上网查：没装 / 关着 / 打开 / 每天上限；会话里允许的工具
	// （v0.6 迁过工作区，主人私聊现在是新会话）
	const sid = db.prepare("SELECT session_id FROM chat_session WHERE channel_id = 'private:10001' AND status = 'active'").get()?.session_id ?? sid1;
	{
		assert.match(guard({ agent: { id: sid }, name: 'web_search' }), /不能上网/);
		tools.web_search = { name: 'web_search' }; tools.web_fetch = { name: 'web_fetch' };
		p = await call('GET', '/models/state');
		assert.deepEqual({ ...p.json.web, providers: undefined }, { enabled: false, perDay: 20, usedToday: 0, available: true, provider: 'host', providers: undefined, hostAvailable: true, hasApiKey: false, apiKeyMasked: '', baseURL: '' });
		assert.deepEqual(p.json.web.providers.map((x) => x.id), ['host', 'bocha', 'tavily', 'brave', 'searxng']);
		assert.match(context.text(at(sid)), /现在不能上网查/);
		p = await call('POST', '/models/config', { web: { enabled: true, perDay: 2 } });
		assert.equal(p.json.web.enabled, true);
		assert.match(context.text(at(sid)), /可以先用 web_search 查/);
		assert.equal(guard({ agent: { id: sid }, name: 'web_search' }), undefined);
		assert.equal(guard({ agent: { id: sid }, name: 'web_fetch' }), undefined);
		assert.match(guard({ agent: { id: sid }, name: 'web_search' }), /次数用完了/);
		assert.equal(guard({ agent: { id: 'main-session' }, name: 'web_search' }), undefined, '不管主会话');
		assert.equal((await call('GET', '/models/state')).json.web.usedToday, 2);
		await call('POST', '/models/config', { web: { enabled: false } });
		delete tools.web_search; delete tools.web_fetch;
	}
	ok('上网查：默认关；打开后聊天会话能用 web_search / web_fetch，按天限次数；主会话不受影响');

	// 54b 上网查 · 自己的搜索 key：博查 / Tavily / Brave / SearXNG；fish_search 只在聊天会话里、跟着开关和次数走
	{
		const calls = [];
		let mode = 'ok';
		mod.testHooks.webFetch = async (url, init = {}) => {
			calls.push({ url: String(url), init });
			const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
			if (mode === 'fail') return json(401, { message: 'Invalid API key' });
			if (String(url).includes('bochaai')) return json(200, { code: 200, data: { webPages: { value: [
				{ name: 'S16 总决赛落幕', url: 'https://www.example.com/a', siteName: '某体育', datePublished: '2026-11-02T10:00:00+08:00', snippet: '短', summary: '某队 3:1 夺冠' },
				{ name: '第二条', url: 'https://b.example.org/x', snippet: '第二条摘要' }] } } });
			if (String(url).includes('tavily')) return json(200, { answer: '一句话概要', results: [{ title: 'T1', url: 'https://t.example/1', content: 'tavily 内容' }] });
			if (String(url).includes('brave')) return json(200, { web: { results: [{ title: 'B1', url: 'https://br.example/1', description: '<strong>brave</strong> 内容' }] } });
			if (String(url).includes('/search?')) return json(200, { results: [{ title: 'S1', url: 'https://s.example/1', content: 'searx 内容' }] });
			return json(404, {});
		};
		const fs = tools.fish_search;
		assert.ok(fs, 'fish_search 注册了');
		const used0 = (await call('GET', '/models/state')).json.web.usedToday;
		// 没配 key：不可用、开关打不开（UI 置灰）、工具直接说没配好
		p = await call('POST', '/models/config', { web: { provider: 'bocha' } });
		assert.equal(p.json.web.provider, 'bocha');
		assert.equal(p.json.web.available, false);
		assert.match(await fs.execute({ query: 'x' }, {}), /没配好/);
		assert.equal((await call('POST', '/web/test', {})).json.ok, false);
		// 填 key：掩码回显；再提交掩码不覆盖
		p = await call('POST', '/models/config', { web: { apiKey: 'sk-bocha-secret-1234', enabled: true, perDay: used0 + 2 } });
		assert.equal(p.json.web.available, true);
		assert.equal(p.json.web.hasApiKey, true);
		assert.match(p.json.web.apiKeyMasked, /1234$/);
		assert.ok(!JSON.stringify(p.json).includes('bocha-secret'), 'key 不回传');
		await call('POST', '/models/config', { web: { apiKey: p.json.web.apiKeyMasked } });
		p = await call('POST', '/web/test', { query: '英雄联盟 总决赛' });
		assert.equal(p.json.ok, true);
		assert.equal(p.json.count, 2);
		assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer sk-bocha-secret-1234', '掩码没覆盖真 key');
		assert.deepEqual(JSON.parse(calls.at(-1).init.body), { query: '英雄联盟 总决赛', summary: true, count: 3, freshness: 'noLimit' });
		assert.equal(p.json.results[0].site, '某体育');
		assert.equal(p.json.results[1].site, 'b.example.org');
		assert.equal((await call('GET', '/models/state')).json.web.usedToday, used0, '测一下不算次数');
		// 会话里：上下文提 fish_search；护栏放行 fish_search、挡宿主的 web_search；主会话不能用 fish_search
		assert.match(context.text(at(sid)), /可以先用 fish_search 查/);
		assert.match(guard({ agent: { id: sid }, name: 'web_search' }), /请用 fish_search/);
		assert.match(guard({ agent: { id: 'main-session' }, name: 'fish_search' }), /只给鱼的聊天会话用/);
		assert.equal(guard({ agent: { id: sid }, name: 'fish_search' }), undefined);
		const out = await fs.execute({ query: '总决赛' }, {});
		assert.match(out, /搜「总决赛」的结果/);
		assert.match(out, /1\. S16 总决赛落幕（某体育 2026-11-02）\n {3}某队 3:1 夺冠/);
		assert.equal(guard({ agent: { id: sid }, name: 'fish_search' }), undefined);
		assert.match(guard({ agent: { id: sid }, name: 'fish_search' }), /次数用完了/);
		// 出错：工具不抛，告诉她没搜成
		mode = 'fail';
		assert.match(await fs.execute({ query: '总决赛' }, {}), /没搜成（博查 返回 401：Invalid API key）/);
		assert.match((await call('POST', '/web/test', {})).json.error, /401/);
		mode = 'ok';
		// 每个服务各存一个 key：换 Tavily 要重新填，换回博查 key 还在
		p = await call('POST', '/models/config', { web: { provider: 'tavily' } });
		assert.equal(p.json.web.hasApiKey, false);
		p = await call('POST', '/models/config', { web: { apiKey: 'tvly-key-9999', perDay: 500 } });
		p = await call('POST', '/web/test', {});
		assert.equal(p.json.answer, '一句话概要');
		assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer tvly-key-9999');
		assert.match(await fs.execute({ query: 'q' }, {}), /概要：一句话概要/);
		p = await call('POST', '/models/config', { web: { provider: 'brave', apiKey: 'brv-1' } });
		assert.equal(p.json.web.available, true);
		p = await call('POST', '/web/test', { query: '猫' });
		assert.equal(p.json.results[0].snippet, 'brave 内容');
		assert.equal(calls.at(-1).init.headers['X-Subscription-Token'], 'brv-1');
		assert.match(calls.at(-1).url, /q=%E7%8C%AB&count=3/);
		p = await call('POST', '/models/config', { web: { provider: 'searxng', baseURL: 'http://127.0.0.1:8888/' } });
		assert.equal(p.json.web.available, true);
		assert.equal(p.json.web.baseURL, 'http://127.0.0.1:8888');
		p = await call('POST', '/web/test', {});
		assert.equal(p.json.results[0].title, 'S1');
		assert.match(calls.at(-1).url, /^http:\/\/127\.0\.0\.1:8888\/search\?q=.+&format=json$/);
		p = await call('POST', '/models/config', { web: { provider: 'bocha' } });
		assert.equal(p.json.web.hasApiKey, true, '博查的 key 还在');
		// 换回 DSH 自带：fish_search 被护栏挡
		await call('POST', '/models/config', { web: { provider: 'host', enabled: false } });
		assert.match(guard({ agent: { id: sid }, name: 'fish_search' }), /不能上网/);
		mod.testHooks.webFetch = null;
	}
	ok('上网查 · 自己的 key：博查 / Tavily / Brave / SearXNG 都能搜；key 掩码、按服务分开存；测一下不算次数；fish_search 只在聊天会话里、跟开关和次数走');

	// 55 路由：模型 / 用量 / 单价、语音、表情包、学说法、首次引导
	{
		const streams = [];
		services.llm = {
			listProviders: () => [{ id: 'ds', name: 'DeepSeek' }],
			listModels: async () => [{ id: 'ds-chat', name: 'V3' }, { id: 'ds-r1', name: 'R1' }],
			async *stream(o) {
				streams.push(o);
				yield { type: 'text-delta', text: JSON.stringify({ terms: [{ term: '开黑', meaning: '一起打游戏' }], style: '爱开玩笑' }) };
				yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 40 } };
			}
		};
		services.agentDefaultModel = { currentSelection: () => ({ provider: 'ds', model: 'ds-chat' }) };
		try {
			p = await call('GET', '/models/state');
			assert.equal(p.json.ok, true);
			assert.deepEqual(p.json.providers, [{ id: 'ds', name: 'DeepSeek', models: [{ id: 'ds-chat', name: 'V3' }, { id: 'ds-r1', name: 'R1' }] }]);
			assert.deepEqual(p.json.features.map((f) => f.id), ['dream', 'extract', 'schedule', 'browse', 'import', 'slang', 'other']);
			assert.deepEqual(p.json.features[5].resolved, { provider: 'ds', model: 'ds-chat', from: 'host' });
			assert.deepEqual(p.json.hostDefault, { provider: 'ds', model: 'ds-chat' });
			p = await call('POST', '/models/config', { models: { slang: { provider: 'ds', model: 'ds-r1' }, dream: { provider: '', model: 'x' } }, prices: { 'ds-r1': { in: 4, out: '16' }, '': { in: 1 } } });
			assert.equal(p.json.ok, true);
			p = await call('GET', '/models/state');
			assert.deepEqual(p.json.features[5].selection, { provider: 'ds', model: 'ds-r1' });
			assert.equal(p.json.features[0].selection, null, '不完整的选择当没选');
			assert.deepEqual(p.json.prices['ds-r1'], { in: 4, out: 16 });
			// 学一次群说法：走 slang 功能指定的模型，用量记进来
			setKv(db, 'slang.lines.group:8803', { lines: Array.from({ length: 8 }, (_, i) => ({ name: `u${i}`, text: `晚上开黑吗${i}`, t: Date.now() })), newCount: 8 });
			p = await call('POST', '/slang/learn', { channelId: 'group:8803' });
			assert.equal(p.json.ok, true, p.json.error);
			assert.equal(p.json.group.terms[0].term, '开黑');
			assert.deepEqual([streams.at(-1).provider, streams.at(-1).model], ['ds', 'ds-r1']);
			p = await call('GET', '/models/state');
			assert.ok(p.json.usage7.byFeature.slang.calls >= 1);
			assert.ok(p.json.usage7.byModel['ds-r1'].in >= 300);
			assert.ok(Math.abs(p.json.usage7.byModel['ds-r1'].cost - (300 * 4 + 40 * 16) / 1e6) < 1e-9);
			assert.equal(p.json.usage30.days, 30);
			p = await call('POST', '/slang/edit', { channelId: 'group:8803', style: '主人改的', add: { term: '老地方', meaning: '后门烧烤' } });
			assert.equal(p.json.group.styleByUser, true); assert.equal(p.json.group.terms[0].term, '老地方');
			p = await call('POST', '/slang/edit', { channelId: 'group:8803', remove: '开黑' });
			assert.equal(p.json.group.terms.some((x) => x.term === '开黑'), false);
			p = await call('GET', '/slang/state');
			assert.ok(p.json.groups.some((g) => g.channelId === 'group:8803'));
			assert.equal((await call('POST', '/slang/learn', { channelId: 'private:1' })).json.ok, false);
			p = await call('POST', '/slang/config', { enabled: false });
			assert.equal(p.json.config.enabled, false);
			assert.equal((await call('GET', '/channels/state')).json.qq.slang.enabled, false);
			await call('POST', '/slang/config', { enabled: true });
		} finally {
			delete services.llm; delete services.agentDefaultModel;
		}

		// 语音：默认关；key 打码、不回传；打码的 key 不覆盖；试听
		p = await call('GET', '/voice/state');
		assert.equal(p.json.enabled, false); assert.equal(p.json.sttModel, 'FunAudioLLM/SenseVoiceSmall');
		assert.equal((await call('POST', '/voice/test', { text: '你好' })).json.ok, false, '没开不能试听');
		p = await call('POST', '/voice/config', { enabled: true, apiKey: 'sk-voice-abcd1234', speak: 'sometimes', ttsPerDay: 5 });
		assert.equal(p.json.ok, true);
		await call('POST', '/voice/config', { apiKey: 'sk-••••••••1234' });
		p = await call('GET', '/voice/state');
		assert.deepEqual([p.json.enabled, p.json.hasOwnKey, p.json.speak, p.json.ttsPerDay], [true, true, 'sometimes', 5]);
		assert.match(p.json.apiKeyMasked, /1234$/); assert.equal(JSON.stringify(p.json).includes('abcd1234'), false);
		const vreq = [];
		mod.testHooks.voiceFetch = async (url, init) => { vreq.push([url, init.headers.authorization, String(init.body)]); return new Response(MP3, { status: 200 }); };
		p = await call('POST', '/voice/test', { text: '试听一下' });
		assert.equal(p.json.ok, true); assert.equal(Buffer.from(p.json.base64, 'base64').subarray(0, 3).toString(), 'ID3');
		assert.equal(vreq[0][1], 'Bearer sk-voice-abcd1234'); assert.match(vreq[0][2], /"input":"试听一下"/);
		assert.match(context.text(at(sid)), /开头写 \[语音\]/, 'sometimes：QQ 会话里告诉她可以发语音');
		await call('POST', '/voice/config', { enabled: false });
		assert.doesNotMatch(context.text(at(sid)), /开头写 \[语音\]/);
		delete mod.testHooks.voiceFetch;

		// 表情包：列出她收藏的、读图（只读收藏过的）、删
		p = await call('GET', '/stickers/state');
		assert.equal(p.json.items[0].file, '狗头.png'); assert.equal(p.json.items[0].exists, true);
		const raw = async (path) => {
			let status = 0; let out = null; let type = '';
			const req = new Readable({ read() { this.push(null); } });
			req.url = `/api/plugins/fish-soul${path}`; req.method = 'GET'; req.headers = {};
			await route.handler(req, { writeHead: (s, h) => { status = s; type = h?.['content-type'] ?? ''; }, end: (s) => { out = s; } });
			return { status, out, type };
		};
		const img = await raw(`/stickers/file?file=${encodeURIComponent(collectedFile.file)}&ws=${encodeURIComponent(collectedFile.ws)}`);
		assert.equal(img.status, 200); assert.equal(img.type, 'image/png'); assert.equal(Buffer.compare(img.out, PNG), 0);
		assert.equal((await raw(`/stickers/file?file=${encodeURIComponent('../../secret.png')}&ws=${encodeURIComponent(collectedFile.ws)}`)).status, 404);
		assert.equal((await call('POST', '/stickers/delete', { file: 'nope.png', workspacePath: collectedFile.ws })).json.ok, false);
		assert.equal((await call('POST', '/stickers/delete', { file: collectedFile.file, workspacePath: collectedFile.ws })).json.ok, true);
		assert.equal(existsSync(join(collectedFile.ws, '_stickers', collectedFile.file)), false);
		p = await call('POST', '/stickers/config', { collect: false, perDay: 3 });
		assert.deepEqual(p.json.config, { collect: false, perDay: 3 });
		assert.equal((await call('GET', '/channels/state')).json.qq.stickers.collect, false);
		await call('POST', '/stickers/config', { collect: true });

		// 首次引导
		p = await call('GET', '/onboarding/state');
		assert.equal(p.json.dismissed, false);
		const step = (id) => p.json.steps.find((s) => s.id === id);
		assert.deepEqual(p.json.steps.map((s) => s.id), ['persona', 'model', 'qq', 'master', 'retrieval', 'import', 'voice']);
		assert.equal(step('persona').done, true, '测试里放了 persona.png');
		assert.equal(step('master').done, true);
		assert.equal(step('import').done, true, '前面导入过');
		assert.equal(step('voice').done, false);
		await call('POST', '/onboarding/dismiss', {});
		assert.equal((await call('GET', '/onboarding/state')).json.dismissed, true);
		await call('POST', '/onboarding/dismiss', { dismissed: false });
		assert.equal(getKv(db, 'nope', 1), 1);
	}
	ok('v0.7 路由：模型状态 / 按功能选 / 单价 / 用量花费、学说法（学 / 改 / 删 / 开关）、语音（打码 / 试听）、表情包（看 / 读图防穿越 / 删）、首次引导');
}
