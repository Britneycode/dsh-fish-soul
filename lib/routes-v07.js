/**
 * routes-v07.js —— v0.7 的路由（routes.js 转进来，契约 25~40）：
 *  - 模型：按功能选模型、用量 / 估算花费（价格主人自己填）、上网查（开关 / 自己的搜索 key / 测一下）；
 *  - 语音：听 QQ 语音、发语音（OpenAI 兼容 STT / TTS）设置与试听；
 *  - 表情包：她收藏的表情（看 / 删）、收藏开关；
 *  - 群里的说法：每个群学到的梗和说话风格（看 / 改 / 现在学一次）；
 *  - 首次引导：检查清单 + 不再显示。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { FEATURES } from './llm.js';
import { voiceConfig } from './voice.js';
import { stickerConfig } from './stickers.js';
import { chatKind, slangConfig } from './slang.js';
import { WEB_PROVIDERS, webSearchConfig, ownSearchReady } from './websearch.js';
import { listChatSessions } from './db.js';

const BODY_MAX = 256 * 1024;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function maskKey(key) {
	if (!key) return '';
	return key.length <= 4 ? '••••' : `sk-••••••••••••••••${key.slice(-4)}`;
}
const isMasked = (s) => typeof s === 'string' && s.includes('••');
const str = (x, max = 200) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** 按功能选的模型：只留合法的 { provider, model }，空 = 跟 DSH 默认。 */
function cleanModels(raw) {
	const out = {};
	for (const [feature] of FEATURES) {
		const v = raw?.[feature];
		if (v === null || v === undefined || v === '') { out[feature] = null; continue; }
		const provider = str(v.provider, 100); const model = str(v.model, 200);
		out[feature] = provider !== '' && model !== '' ? { provider, model } : null;
	}
	return out;
}

function cleanPrices(raw) {
	const out = {};
	for (const [model, p] of Object.entries(raw ?? {}).slice(0, 100)) {
		const m = str(model, 200);
		if (m === '') continue;
		if (p === null) { out[m] = null; continue; }
		const num = (x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : 0; };
		out[m] = { in: num(p?.in), out: num(p?.out) };
	}
	return out;
}

/** 首次引导的检查清单。 */
export function onboardingSteps(deps) {
	const { getConfig, persona, channel, llmRouter, voice, db } = deps;
	const cfg = getConfig();
	const imported = (() => {
		try { return (db.prepare("SELECT COUNT(*) AS n FROM memory WHERE source_session IN ('history-import', 'import')").get()?.n ?? 0) > 0; } catch { return false; }
	})();
	const hasModel = llmRouter ? (llmRouter.hostDefault() !== null || llmRouter.providers().length > 0) : false;
	return [
		{ id: 'persona', title: '选一个人格（换个模板，或导入自己的角色卡；不选就用内置的鱼，只有一句话）', done: persona?.source !== undefined && persona.source !== 'builtin', optional: true, tab: 'persona' },
		{ id: 'model', title: 'DSH 里配好模型（她排日程、整理记忆都要用）', done: hasModel, optional: false, tab: 'models' },
		{ id: 'qq', title: '接上 QQ（SnowLuma）', done: channel?.status?.().connected === true, optional: false, tab: 'qq' },
		{ id: 'master', title: '填主人 QQ 号（她才知道谁是你）', done: String(cfg.masterQqUin ?? '') !== '', optional: false, tab: 'qq' },
		{ id: 'retrieval', title: '配好记忆检索（向量），想起事情更准', done: str(cfg.embedding?.apiKey) !== '', optional: true, tab: 'retrieval' },
		{ id: 'import', title: '导入以前的聊天记录，让她认识老朋友', done: imported, optional: true, tab: 'inspector' },
		{ id: 'voice', title: '打开语音（能听 QQ 语音，偶尔发语音）', done: voice?.ready?.() === true, optional: true, tab: 'models' }
	];
}

/**
 * @returns {Promise<boolean>} 处理了就返回 true
 */
export async function handleV07Route({ method, path, url, req, res, send, readBody, sameOrigin, deps }) {
	const { db, getConfig, saveConfig, llmRouter, voice, stickers, slang, gateway, webConfig, hasWebTools, webUsedToday, hostWebAvailable, runWebSearch } = deps;
	const post = method === 'POST';
	const body = async () => {
		const raw = await readBody(req);
		if (raw.length > BODY_MAX) throw new Error('请求太大');
		return JSON.parse(raw || '{}');
	};
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };
	const webState = () => {
		const w = webConfig?.() ?? webSearchConfig({});
		return {
			enabled: w.enabled, perDay: w.perDay, usedToday: webUsedToday?.() ?? 0, available: hasWebTools?.() === true,
			provider: w.provider, providers: WEB_PROVIDERS, hostAvailable: hostWebAvailable?.() === true,
			hasApiKey: w.apiKey !== '', apiKeyMasked: maskKey(w.apiKey), baseURL: w.baseURL
		};
	};

	// ── 契约 21：模型状态（可选模型 / 每个功能用哪个 / 用量 / 上网查）──
	if (path === '/models/state' && method === 'GET') {
		if (!llmRouter) { send(200, { ok: false, error: '模型路由没起来' }); return true; }
		const cfg = getConfig();
		const providers = [];
		for (const p of llmRouter.providers()) providers.push({ ...p, models: await llmRouter.models(p.id) });
		const features = [];
		for (const [id, label] of FEATURES) {
			const r = await llmRouter.resolve(id);
			const pick = cfg.models?.[id];
			features.push({ id, label, selection: pick && pick.provider && pick.model ? { provider: pick.provider, model: pick.model } : null, resolved: r, });
		}
		send(200, {
			ok: true, providers, features, hostDefault: llmRouter.hostDefault(), prices: cfg.modelPrices ?? {},
			usage7: llmRouter.usage(7), usage30: llmRouter.usage(30), lastError: llmRouter.lastError || '', web: webState()
		});
		return true;
	}
	// ── 契约 22：保存按功能选的模型 / 价格 / 上网查 ──
	if (path === '/models/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const patch = {};
		if (b.models !== undefined) patch.models = cleanModels(b.models);
		if (b.prices !== undefined) patch.modelPrices = cleanPrices(b.prices);
		if (b.web !== undefined) {
			const cur = webConfig?.() ?? webSearchConfig({});
			const n = Number(b.web.perDay);
			const web = { enabled: b.web.enabled === undefined ? cur.enabled : b.web.enabled === true, perDay: Number.isFinite(n) ? Math.min(500, Math.max(0, Math.floor(n))) : cur.perDay };
			if (WEB_PROVIDERS.some((p) => p.id === b.web.provider)) web.provider = b.web.provider;
			const keyFor = web.provider ?? cur.provider;
			if (typeof b.web.apiKey === 'string' && !isMasked(b.web.apiKey) && keyFor !== 'host') web.apiKeys = { [keyFor]: str(b.web.apiKey, 400) };
			if (typeof b.web.baseURL === 'string') web.baseURL = str(b.web.baseURL, 300).replace(/\/+$/, '');
			patch.tools = { web };
		}
		saveConfig(patch);
		send(200, { ok: true, web: webState() });
		return true;
	}

	// ── 契约 32：上网查 · 测一下（用当前选的搜索服务搜一次，不算今天的次数）──
	if (path === '/web/test' && post) {
		if (!guard()) return true;
		const b = await body();
		const w = webConfig?.() ?? webSearchConfig({});
		if (w.provider === 'host') { send(200, { ok: false, error: 'DSH 自带的搜索只能在聊天里用，测不了；想测就换成自己的搜索服务' }); return true; }
		if (!ownSearchReady(w)) { send(200, { ok: false, error: w.provider === 'searxng' ? '先填 SearXNG 地址（http:// 或 https:// 开头）' : '先填 API Key' }); return true; }
		const q = str(b.query, 100) || '今天有什么新闻';
		const t0 = Date.now();
		try {
			const r = await runWebSearch(q, { count: 3 });
			send(200, { ok: true, query: q, count: r.results.length, latencyMs: Date.now() - t0, answer: r.answer, results: r.results.slice(0, 3) });
		} catch (error) {
			send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
		}
		return true;
	}

	// ── 契约 23~25：语音 ──
	if (path === '/voice/state' && method === 'GET') {
		if (!voice) { send(200, { ok: false, error: '语音没起来' }); return true; }
		const cfg = getConfig();
		const c = voiceConfig(cfg.voice, cfg.embedding);
		const raw = cfg.voice ?? {};
		// 听 / 说两组：own = 这一侧自己填的（空 = 沿用公用的地址 / key）；from = 实际用的 key 从哪来
		const side = (k) => {
			const own = str(raw[`${k}ApiKey`]);
			const key = k === 'stt' ? c.sttApiKey : c.ttsApiKey;
			return {
				baseURL: str(raw[`${k}BaseURL`]), effectiveBaseURL: k === 'stt' ? c.sttBaseURL : c.ttsBaseURL,
				hasKey: key !== '', hasOwnKey: own !== '', keyMasked: maskKey(own),
				keyFrom: own !== '' ? 'own' : key === '' ? '' : c.hasOwnKey ? 'shared' : 'embedding',
				ready: voice.readyFor(k)
			};
		};
		send(200, { ok: true, ...voice.state(), apiKeyMasked: maskKey(str(raw.apiKey)), sharesEmbedding: !c.hasOwnKey && c.apiKey !== '', stt: side('stt'), tts: side('tts') });
		return true;
	}
	if (path === '/voice/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const v = {};
		if (b.enabled !== undefined) v.enabled = b.enabled === true;
		for (const k of ['baseURL', 'sttBaseURL', 'ttsBaseURL', 'sttModel', 'ttsModel', 'ttsVoice']) if (typeof b[k] === 'string') v[k] = str(b[k], 300);
		for (const k of ['apiKey', 'sttApiKey', 'ttsApiKey']) if (typeof b[k] === 'string' && !isMasked(b[k])) v[k] = str(b[k], 400);
		if (['never', 'mirror', 'sometimes'].includes(b.speak)) v.speak = b.speak;
		for (const k of ['maxChars', 'ttsPerDay', 'sttPerDay']) if (b[k] !== undefined && Number.isFinite(Number(b[k]))) v[k] = Math.max(0, Math.floor(Number(b[k])));
		saveConfig({ voice: v });
		send(200, { ok: true, ...(voice?.state() ?? {}) });
		return true;
	}
	if (path === '/voice/test' && post) {
		if (!guard()) return true;
		if (!voice?.readyFor('tts')) { send(200, { ok: false, error: '先打开语音并填好「说」那边的 key' }); return true; }
		const b = await body();
		const text = str(b.text, 100) || '你好呀，我是鱼。';
		try {
			const buf = await voice.synthesize(text, { test: true });
			if (!buf) { send(200, { ok: false, error: voice.lastError || '没合成出来（字太多或今天次数用完了）' }); return true; }
			send(200, { ok: true, mediaType: 'audio/mpeg', base64: Buffer.from(buf).toString('base64') });
		} catch (error) {
			send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
		}
		return true;
	}

	// ── 契约 26~28：表情包 ──
	if (path === '/stickers/state' && method === 'GET') {
		if (!stickers) { send(200, { ok: false, error: '表情包没起来' }); return true; }
		const items = stickers.collected().map((x) => ({
			file: x.file, workspacePath: x.workspacePath, from: x.from ?? '', summary: x.summary ?? '', at: x.at,
			exists: existsSync(join(x.workspacePath, '_stickers', x.file))
		}));
		const ws = gateway?.workspacePath?.() ?? '';
		send(200, { ok: true, config: stickerConfig(getConfig().stickers), items, workspacePath: ws, inWorkspace: ws ? (gateway?.listStickers?.(ws) ?? []).length : 0 });
		return true;
	}
	if (path === '/stickers/file' && method === 'GET') {
		const file = basename(String(url.searchParams.get('file') ?? ''));
		const ws = String(url.searchParams.get('ws') ?? '');
		const hit = stickers?.collected().find((x) => x.file === file && x.workspacePath === ws);
		const ext = file.split('.').pop()?.toLowerCase() ?? '';
		const full = hit ? join(ws, '_stickers', file) : '';
		if (!hit || !MIME[ext] || !existsSync(full)) { send(404, { ok: false, error: 'not found' }); return true; }
		res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'private, max-age=300' });
		res.end(readFileSync(full));
		return true;
	}
	if (path === '/stickers/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const s = {};
		if (b.collect !== undefined) s.collect = b.collect === true;
		if (b.perDay !== undefined && Number.isFinite(Number(b.perDay))) s.perDay = Math.min(100, Math.max(0, Math.floor(Number(b.perDay))));
		saveConfig({ stickers: s });
		send(200, { ok: true, config: stickerConfig({ ...(getConfig().stickers ?? {}), ...s }) });
		return true;
	}
	if (path === '/stickers/delete' && post) {
		if (!guard()) return true;
		const b = await body();
		const ok = stickers?.remove(basename(String(b.file ?? '')), String(b.workspacePath ?? '')) === true;
		send(200, ok ? { ok: true } : { ok: false, error: '没有这张（只能删她自己收藏的）' });
		return true;
	}

	// ── 契约 29~30：群里学到的说法 ──
	if (path === '/slang/state' && method === 'GET') {
		if (!slang) { send(200, { ok: false, error: '没起来' }); return true; }
		send(200, { ok: true, config: slangConfig(getConfig().slang), groups: slang.state() });
		return true;
	}
	if (path === '/slang/learn' && post) {
		if (!guard()) return true;
		const b = await body();
		const cid = String(b.channelId ?? '');
		if (chatKind(cid) === null) { send(200, { ok: false, error: '只学 QQ 群聊和私聊' }); return true; }
		const r = await slang.learn(cid);
		send(200, r.ok ? { ok: true, added: r.added, total: r.total, expressionsAdded: r.expressionsAdded, expressionsAgain: r.expressionsAgain, group: slang.state().find((g) => g.channelId === cid) ?? null } : { ok: false, error: r.error });
		return true;
	}
	if (path === '/slang/edit' && post) {
		if (!guard()) return true;
		const b = await body();
		const cid = String(b.channelId ?? '');
		if (chatKind(cid) === null) { send(200, { ok: false, error: '只学 QQ 群聊和私聊' }); return true; }
		const edit = {};
		if (typeof b.style === 'string') edit.style = b.style;
		if (b.add && typeof b.add.term === 'string' && b.add.term.trim() !== '') edit.add = { term: b.add.term, meaning: String(b.add.meaning ?? '') };
		if (typeof b.remove === 'string' && b.remove !== '') edit.remove = b.remove;
		if (b.addExpression && typeof b.addExpression.situation === 'string' && typeof b.addExpression.style === 'string') edit.addExpression = { situation: b.addExpression.situation, style: b.addExpression.style };
		if (typeof b.removeExpression === 'string' && b.removeExpression !== '') edit.removeExpression = b.removeExpression;
		slang.edit(cid, edit);
		send(200, { ok: true, group: slang.state().find((g) => g.channelId === cid) ?? null });
		return true;
	}
	if (path === '/slang/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const s = {};
		for (const k of ['enabled', 'expressions', 'privateChats']) if (b[k] !== undefined) s[k] = b[k] === true;
		for (const k of ['minLines', 'intervalHours']) if (b[k] !== undefined && Number.isFinite(Number(b[k]))) s[k] = Math.max(1, Math.floor(Number(b[k])));
		saveConfig({ slang: s });
		send(200, { ok: true, config: slangConfig({ ...(getConfig().slang ?? {}), ...s }) });
		return true;
	}

	// ── 契约 31：首次引导 ──
	if (path === '/onboarding/state' && method === 'GET') {
		const steps = onboardingSteps(deps);
		const chats = (() => { try { return listChatSessions(db, 'qq').length; } catch { return 0; } })();
		send(200, {
			ok: true, dismissed: getConfig().onboarding?.dismissed === true, steps, chats,
			done: steps.filter((s) => !s.optional).every((s) => s.done)
		});
		return true;
	}
	if (path === '/onboarding/dismiss' && post) {
		if (!guard()) return true;
		const b = await body();
		saveConfig({ onboarding: { dismissed: b.dismissed !== false } });
		send(200, { ok: true });
		return true;
	}
	return false;
}
