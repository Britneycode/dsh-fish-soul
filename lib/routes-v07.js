/**
 * routes-v07.js —— v0.7 的路由（routes.js 转进来，契约 25~40）：
 *  - 模型：按功能选模型、用量 / 估算花费（价格主人自己填）、上网查（开关 / 自己的搜索 key / 测一下）；
 *  - 语音：听 QQ 语音、发语音（OpenAI 兼容 STT / TTS）设置与试听；
 *  - 表情包：她收藏的表情（看 / 删）、收藏开关；
 *  - 群里的说法：每个群学到的梗和说话风格（看 / 改 / 现在学一次）；
 *  - 首次引导：检查清单 + 不再显示。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { FEATURES } from './llm.js';
import { voiceConfig } from './voice.js';
import { stickerConfig } from './stickers.js';
import { chatKind, slangConfig, GLOBAL_ID } from './slang.js';
import { WEB_PROVIDERS, webSearchConfig, ownSearchReady } from './websearch.js';
import { listChatSessions } from './db.js';
import { previewMaiBotExtras, importMaiBotExtras, sniffImage } from './maibot-extras.js';
import { maskKey } from './routes.js';

const BODY_MAX = 256 * 1024;
const IMPORT_BODY_MAX = 6 * 1024 * 1024;   // 一张图的 base64 + JSON 兜底上限
const IMPORT_BYTES_MAX = 4 * 1024 * 1024;  // 解码后的图片上限
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MEDIA_TYPES = new Set(Object.values(MIME));

const isMasked = (s) => typeof s === 'string' && s.includes('••');
const str = (x, max = 200) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** base64 严一点：只认标准字母表 + 合法长度，别的编码直接拒。 */
const isBase64 = (s) => s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);

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
		{ id: 'import', title: '导入以前的聊天记录，让她认识老朋友', done: imported, optional: true, tab: 'backups' },
		{ id: 'voice', title: '打开语音（能听 QQ 语音，偶尔发语音）', done: voice?.ready?.() === true, optional: true, tab: 'voice' }
	];
}

/**
 * @returns {Promise<boolean>} 处理了就返回 true
 */
export async function handleV07Route({ method, path, url, req, res, send, readBody, sameOrigin, deps }) {
	const { db, getConfig, saveConfig, llmRouter, voice, stickers, slang, gateway, webConfig, hasWebTools, webUsedToday, hostWebAvailable, hostWebState, runWebSearch } = deps;
	const post = method === 'POST';
	const body = async () => {
		const raw = await readBody(req);
		if (raw.length > BODY_MAX) throw new Error('请求太大');
		return JSON.parse(raw || '{}');
	};
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };
	/** 同一个工作区？路径写法可能不一样（相对 / 绝对），比绝对路径。 */
	const sameWorkspace = (a, b) => {
		const x = String(a ?? ''); const y = String(b ?? '');
		if (x === '' || y === '') return false;
		try { return resolve(x) === resolve(y); } catch { return x === y; }
	};
	/** ws 得是认得的工作区（当前工作区 / 收藏记录里出现过的），不能随便指个目录来读、改、删文件。 */
	const knownWorkspace = (p) => {
		const ws = String(p ?? '');
		if (ws === '') return false;
		if (sameWorkspace(ws, gateway?.workspacePath?.() ?? '')) return true;
		return (stickers?.collected() ?? []).some((x) => sameWorkspace(x.workspacePath, ws));
	};
	const webState = () => {
		const w = webConfig?.() ?? webSearchConfig({});
		return {
			enabled: w.enabled, perDay: w.perDay, usedToday: webUsedToday?.() ?? 0, available: hasWebTools?.() === true,
			provider: w.provider, providers: WEB_PROVIDERS, hostAvailable: hostWebAvailable?.() === true, hostState: hostWebState?.() ?? 'unknown',
			hasApiKey: w.apiKey !== '', apiKeyMasked: maskKey(w.apiKey), baseURL: w.baseURL,
			sessionAllow: gateway?.sessionAllowMode?.() ?? 'memory' // #37 聊天会话工具放行档位
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
	// ── 契约 22：保存按功能选的模型 / 价格 / 上网查 / 会话工具放行档位（#37）──
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
		// #37：聊天会话放行哪些工具（memory / master / all），web 那套要跟着一起带上，别把已有的覆盖丢了
		if (b.sessionAllow !== undefined) {
			const v = String(b.sessionAllow);
			const tools = patch.tools ?? {};
			if (v === 'memory' || v === 'master' || v === 'all') tools.sessionAllow = v;
			patch.tools = tools;
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
		for (const k of ['baseURL', 'sttBaseURL', 'ttsBaseURL', 'sttModel', 'ttsModel', 'ttsVoice', 'volcAppId', 'volcCluster', 'volcResourceId', 'volcEndpoint']) if (typeof b[k] === 'string') v[k] = str(b[k], 400);
		if (typeof b.ttsProvider === 'string' && ['', 'openai', 'mimo', 'volcengine'].includes(b.ttsProvider)) v.ttsProvider = b.ttsProvider;
		for (const k of ['apiKey', 'sttApiKey', 'ttsApiKey']) if (typeof b[k] === 'string' && !isMasked(b[k])) v[k] = str(b[k], 400);
		if (['never', 'mirror', 'sometimes'].includes(b.speak)) v.speak = b.speak;
		for (const k of ['maxChars', 'ttsPerDay', 'sttPerDay']) if (b[k] !== undefined && Number.isFinite(Number(b[k]))) v[k] = Math.max(0, Math.floor(Number(b[k])));
		// 等待上限：夹在 5~300 秒，防止填 0 变成从不等待 / 填太大挂死
		if (b.timeoutSec !== undefined && Number.isFinite(Number(b.timeoutSec))) v.timeoutSec = Math.min(300, Math.max(5, Math.floor(Number(b.timeoutSec))));
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
		const ws = gateway?.workspacePath?.() ?? '';
		const items = stickers.list(ws);
		send(200, { ok: true, config: stickerConfig(getConfig().stickers), items, workspacePath: ws, inWorkspace: ws ? (gateway?.listStickers?.(ws) ?? []).length : 0 });
		return true;
	}
	if (path === '/stickers/file' && method === 'GET') {
		const file = basename(String(url.searchParams.get('file') ?? ''));
		const ws = String(url.searchParams.get('ws') ?? '');
		// 只有清单里真实存在的才给读（收藏的 + 主人自己放进 _stickers 的）
		const hit = knownWorkspace(ws) ? stickers?.list(ws).find((x) => x.file === file && sameWorkspace(x.workspacePath, ws) && x.exists === true) : null;
		const ext = file.split('.').pop()?.toLowerCase() ?? '';
		const full = hit ? join(hit.workspacePath, '_stickers', file) : '';
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
		// B站 私信平台表情面板（默认关）
		if (b.biliPanel !== undefined) s.biliPanel = b.biliPanel === true;
		if (b.biliPanelListed !== undefined && Number.isFinite(Number(b.biliPanelListed))) {
			s.biliPanelListed = Math.min(60, Math.max(0, Math.floor(Number(b.biliPanelListed))));
		}
		saveConfig({ stickers: s });
		send(200, { ok: true, config: stickerConfig({ ...(getConfig().stickers ?? {}), ...s }) });
		return true;
	}
	if (path === '/stickers/rename' && post) {
		if (!guard()) return true;
		const b = await body();
		if (!stickers) { send(200, { ok: false, error: '表情包没起来' }); return true; }
		const ws = String(b.workspacePath ?? '');
		if (!knownWorkspace(ws)) { send(200, { ok: false, error: '没有这张' }); return true; }
		const r = stickers.rename(basename(String(b.file ?? '')), String(b.name ?? ''), ws);
		send(200, r.ok ? { ok: true, file: r.file } : { ok: false, error: r.reason ?? '改名失败' });
		return true;
	}
	if (path === '/stickers/delete' && post) {
		if (!guard()) return true;
		const b = await body();
		const ws = String(b.workspacePath ?? '');
		const ok = knownWorkspace(ws) && stickers?.remove(basename(String(b.file ?? '')), ws) === true;
		send(200, ok ? { ok: true } : { ok: false, error: '没有这张' });
		return true;
	}
	// 主人从面板导入本地图片：只进当前工作区，不占每天收藏的额度
	if (path === '/stickers/import' && post) {
		if (!guard()) return true;
		if (!stickers) { send(200, { ok: false, error: '表情包没起来' }); return true; }
		const ws = gateway?.workspacePath?.() ?? '';
		if (ws === '') { send(200, { ok: false, error: 'QQ 工作区还没准备好（先连一次 QQ）' }); return true; }
		let raw = '';
		try { raw = await readBody(req); } catch { send(200, { ok: false, error: '请求没读完' }); return true; }
		if (raw.length > IMPORT_BODY_MAX) { send(200, { ok: false, error: '图片太大了（超过 4MB）' }); return true; }
		let b;
		try { b = JSON.parse(raw || '{}'); } catch { send(200, { ok: false, error: '请求格式不对' }); return true; }
		const b64 = String(b.base64 ?? '');
		if (!isBase64(b64)) { send(200, { ok: false, error: '图片编码不对' }); return true; }
		const bytes = Buffer.from(b64, 'base64');
		if (bytes.length === 0) { send(200, { ok: false, error: '没有图片内容' }); return true; }
		if (bytes.length > IMPORT_BYTES_MAX) { send(200, { ok: false, error: '图片太大了（超过 4MB）' }); return true; }
		if (b.mediaType !== undefined && b.mediaType !== '' && !MEDIA_TYPES.has(String(b.mediaType))) { send(200, { ok: false, error: '图片类型不对' }); return true; }
		const mediaType = sniffImage(bytes);
		if (mediaType === null) { send(200, { ok: false, error: '不是支持的图片格式' }); return true; }
		const r = stickers.importImage({ bytes, mediaType, name: String(b.name ?? ''), workspacePath: ws, from: '主人' });
		send(200, r.ok ? { ok: true, file: r.file } : { ok: false, error: r.reason ?? '导入失败', full: r.full === true, dup: r.dup === true });
		return true;
	}

	// ── 麦麦的表情包 / 表达方式 / 黑话 ──
	if (path === '/import/maibot-extras/preview' && post) {
		if (!guard()) return true;
		const b = await body();
		send(200, { ok: true, ...previewMaiBotExtras(String(b.dbPath ?? ''), { titleOf: (c) => gateway?.titleOf?.(c) ?? c }) });
		return true;
	}
	if (path === '/import/maibot-extras/apply' && post) {
		if (!guard()) return true;
		const b = await body();
		if (!slang) { send(200, { ok: false, error: '学说法没起来' }); return true; }
		const r = importMaiBotExtras({
			dbPath: String(b.dbPath ?? ''), slang, stickers, workspacePath: gateway?.workspacePath?.() ?? null,
			emojis: b.emojis !== false, expressions: b.expressions !== false, jargons: b.jargons !== false, maxEmojis: b.maxEmojis
		});
		send(200, { ok: true, ...r });
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
		if (chatKind(cid) === null && cid !== GLOBAL_ID) { send(200, { ok: false, error: '只学 QQ 群聊和私聊' }); return true; }
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
