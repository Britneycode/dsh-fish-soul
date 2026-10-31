/**
 * dsh-fish-soul —— 人格、按人记忆、日程自走与主动开口（设计方案 v1.1）。
 *
 * 装配：db（soul.db）→ clock（VirtualClock）→ retrieval（召回+Worker）
 *      → channel（SnowLuma WS 直连 QQ）+ bili（B站私信轮询 / 刷视频）+ douyin（抖音专用浏览器：私信 / 刷视频）
 *      → gateway（聊天 ↔ DSH 会话）
 *      → life（tick/主动/Dream）→ routes（契约路由）→ 工具与瞬态上下文。
 *
 * 依赖：零 npm 运行时依赖——node:sqlite 内置驱动、内置 fetch、Intl.Segmenter。
 * schemastery 与 @deepseek-ai/dsh-tools 为宿主常驻依赖（参照 dsh-archive-vault）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadHostDeps } from './hostdeps.mjs';
import {
	openDatabase, configPath, fishSoulDir, resolveOrCreatePerson, resolveOrCreateBiliPerson, resolveOrCreatePlatformPerson,
	findPersonByQq, findPersonByBili, findPersonByDouyin, readVecMeta, getKv, setKv, getProfile
} from './db.js';
import { BackupService } from './backup.js';
import { HistoryImporter } from './history-import.js';
import { LlmRouter } from './llm.js';
import { VoiceService, voiceConfig } from './voice.js';
import { StickerBox, stickerConfig } from './stickers.js';
import { SlangLearner, slangConfig } from './slang.js';
import { webSearchConfig, ownSearchReady, webSearch, formatSearch } from './websearch.js';
import { SnowLumaChannel } from './channels/snowluma.js';
import { BiliClient, BiliChannel } from './channels/bilibili.js';
import { BiliBrowser } from './browse.js';
import { DouyinHost, DouyinChannel } from './channels/douyin.js';
import { DouyinBrowser } from './douyin-browse.js';
import { loadSharp, sharpReady } from './imageconv.js';
import {
	ChatGateway, SOURCE_QQ, SOURCE_PROACTIVE, SOURCE_BILI, SOURCE_DOUYIN, QQ_SESSION_TOOLS, WEB_TOOLS, OWN_WEB_TOOL, splitChannelId, sessionChannelOf
} from './gateway.js';
import { DEFAULT_DAILY_MAX } from './life.js';
import { VirtualClock } from './clock.js';
import { EmbeddingClient, VectorWorker, recall, recallSync, vectorRanks } from './retrieval.js';
import { LifeEngine } from './life.js';
import { registerRoutes, registerAgentHooks } from './routes.js';
import { tokenizeForBm25 } from './segment.js';
import { loadPersona, matchLore, applyMacros } from './persona.js';

// schemastery / dsh-tools 从宿主树解析（hostdeps 模式，fish-memory 同款）：
// 裸 import 在桌面 profile（autoInstallPeers:false）下会让整条插件不激活。
const hostDeps = await loadHostDeps();
const z = hostDeps.z;
const defineTool = hostDeps.defineTool;

export const name = 'dsh-fish-soul';

/** 只给测试用：换掉抖音专用浏览器的启动 / 页面驱动（抖音网页在测试里打不开）。正式运行时是空的。 */
export const testHooks = { douyin: null };
// agents / workspaceRegistry：给每个 QQ 聊天建会话；sessionTitle / attachments / agentPresets /
// agentDefaultModel 是可选的，运行时用 ctx.get 取，缺了就降级（不写进 inject，免得整个插件不激活）。
export const inject = ['webServer', 'tools', 'systemPrompt', 'llm', 'agents', 'workspaceRegistry'];

// schemastery 彻底拿不到时省略 Config（插件照常加载，fish-memory 同款降级）
export const Config = z === null ? undefined : z.object({
	masterQqUin: z.string().default(''),
	qq: z.object({
		enabled: z.boolean().default(false),
		wsUrl: z.string().default('ws://127.0.0.1:3001'), // SnowLuma OneBot 11 正向 WS（Universal）
		accessToken: z.string().default(''),
		groupAllowList: z.array(z.string()).default([]), // 空 = 所有群（仍然只听点名）
		followUpCount: z.number().default(3),
		followUpSeconds: z.number().default(120),
		batchMs: z.number().default(1500),
		replyWindowMinutes: z.number().default(10),
		callNames: z.array(z.string()).default([]), // 叫这些名字也算点名；空 = 人格卡名字（≥2 个字才算）
		interject: z.object({ // 群里没点名时自己插一句（默认关）
			enabled: z.boolean().default(false),
			chance: z.number().default(0.05),
			cooldownMinutes: z.number().default(15),
			maxPerHour: z.number().default(3),
			keywords: z.array(z.string()).default([])
		}).default({})
	}).default({}),
	backup: z.object({
		auto: z.boolean().default(true), // 每天自动备份 soul.db
		keep: z.number().default(7)
	}).default({}),
	// v0.7：按功能选模型（{ provider, model }，空 = DSH 默认模型）+ 单价（元 / 百万 token，只用来估花费）
	models: z.dict(z.any()).default({}),
	modelPrices: z.dict(z.any()).default({}),
	voice: z.object({ // 语音：听 QQ 语音、偶尔发语音（OpenAI 兼容接口，空 = 沿用记忆检索的地址和 key）
		enabled: z.boolean().default(false),
		baseURL: z.string().default(''),
		apiKey: z.string().default(''),
		sttModel: z.string().default(''),
		ttsModel: z.string().default(''),
		ttsVoice: z.string().default(''),
		speak: z.string().default('mirror'), // never / mirror（对方发语音时可以回语音）/ sometimes
		maxChars: z.number().default(60),
		ttsPerDay: z.number().default(30),
		sttPerDay: z.number().default(200)
	}).default({}),
	stickers: z.object({
		collect: z.boolean().default(true), // 她觉得好玩的表情包存进 _stickers
		perDay: z.number().default(10)
	}).default({}),
	slang: z.object({
		enabled: z.boolean().default(true), // 学群里的梗 / 说话风格
		minLines: z.number().default(60),
		intervalHours: z.number().default(6)
	}).default({}),
	tools: z.object({
		web: z.object({ // 让她能上网查东西（默认关）：DSH 自带的 web_search，或自己填的搜索 API key
			enabled: z.boolean().default(false),
			perDay: z.number().default(20),
			provider: z.string().default('host'), // host | bocha | tavily | brave | searxng
			apiKeys: z.dict(z.string()).default({}), // 每个搜索服务各存一个 key，切换不丢
			baseURL: z.string().default('') // SearXNG 地址
		}).default({})
	}).default({}),
	onboarding: z.object({ dismissed: z.boolean().default(false) }).default({}),
	// B站：登录凭据不在这里（存 $DSH_HOME/fish-soul/bili-auth.json）
	bili: z.object({
		enabled: z.boolean().default(false),
		autoReply: z.boolean().default(false), // 关 = 只记不回（建议先跑一周）
		masterUid: z.string().default(''),
		allowList: z.array(z.string()).default([]),
		replyMutual: z.boolean().default(true), // 互关的人也回
		links: z.array(z.string()).default([]), // "B站UID=QQ号"，同一个人
		proactive: z.boolean().default(false), // 主动给主人发 B站私信
		pollSeconds: z.number().default(20),
		batchMs: z.number().default(3000),
		replyWindowMinutes: z.number().default(10),
		browse: z.object({
			enabled: z.boolean().default(true),
			perDay: z.number().default(3),
			videosPerSession: z.number().default(3),
			like: z.boolean().default(false)
		}).default({})
	}).default({}),
	// 抖音：登录态在专用浏览器的 profile 里（$DSH_HOME/fish-soul/douyin-browser/<浏览器>），不在这里
	douyin: z.object({
		enabled: z.boolean().default(false),
		autoReply: z.boolean().default(false), // 关 = 只记不回
		masterName: z.string().default(''), // 主人在抖音私信里显示的名字
		allowList: z.array(z.string()).default([]), // 会话名
		replyAll: z.boolean().default(false), // 回所有能私信她的人（建议抖音里设"谁可以私信我 = 互关好友"）
		links: z.array(z.string()).default([]), // "抖音名字=QQ号"，同一个人
		batchMs: z.number().default(3000),
		replyWindowMinutes: z.number().default(10),
		browser: z.object({
			kind: z.string().default('edge'),
			customPath: z.string().default('')
		}).default({}),
		window: z.string().default('background'), // background = 窗口停在屏幕外不打扰；visible = 正常显示
		browse: z.object({
			enabled: z.boolean().default(false),
			perDay: z.number().default(3),
			videosPerSession: z.number().default(3),
			like: z.boolean().default(false)
		}).default({})
	}).default({}),
	sessions: z.object({
		workspacePath: z.string().default('') // 空 = $DSH_HOME/fish-soul/workspace（专用工作区"鱼"）
	}).default({}),
	embedding: z.object({
		enabled: z.boolean().default(true),
		baseURL: z.string().default(''),
		apiKey: z.string().default(''),
		model: z.string().default(''),
		timeoutMs: z.number().default(800)
	}).default({}),
	retrieval: z.object({
		fusionMethod: z.string().default('rrf'),
		topK: z.number().default(5),
		tokenBudget: z.number().default(1200)
	}).default({}),
	proactive: z.object({
		enabled: z.boolean().default(true),
		dailyMaxCount: z.number().default(DEFAULT_DAILY_MAX),
		activeHours: z.array(z.number()).default([8, 24]),
		idleTriggerHours: z.number().default(6),
		targets: z.object({
			masterCanonicalId: z.string().default('user:master'),
			masterPrivateChannelId: z.string().default(''),
			selfGroupChannelIds: z.array(z.string()).default([])
		}).default({})
	}).default({})
});

/** 深合并：over 中的普通对象递归合并，其余值（含数组）整体覆盖；undefined 不覆盖。 */
export function deepMerge(base, over) {
	const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
	if (!isObj(base)) return isObj(over) ? { ...over } : (over === undefined ? base : over);
	const out = { ...base };
	if (!isObj(over)) return out;
	for (const [k, v] of Object.entries(over)) {
		if (v === undefined) continue;
		out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
	}
	return out;
}

/** fish-soul-config.json 读写（设置页写这里）。 */
function loadConfigFile() {
	try {
		if (!existsSync(configPath())) return {};
		return JSON.parse(readFileSync(configPath(), 'utf8'));
	} catch {
		return {};
	}
}

function saveConfigFile(patch) {
	const next = deepMerge(loadConfigFile(), patch);
	writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
}

/** 把扁平参数描述转成标准 JSON Schema（宿主 defineTool 校验 additionalProperties）。 */
function objectSchema(props) {
	const properties = {};
	const required = [];
	for (const [k, v] of Object.entries(props)) {
		const { required: req, ...rest } = v;
		properties[k] = rest;
		if (req === true) required.push(k);
	}
	return { type: 'object', properties, required, additionalProperties: false };
}

/** 把"YYYY-MM-DDTHH:mm"这类无时区 ISO 视为角色时区（UTC+8），而不是宿主机本地时区。 */
function parseRoleIso(iso) {
	const s = String(iso).trim();
	const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
	const parsed = Date.parse(hasZone ? s : `${s.length === 10 ? `${s}T09:00:00` : s}+08:00`);
	return Number.isFinite(parsed) ? parsed : null;
}

const UNKNOWN_OWNER = 'user:unknown';

export async function apply(ctx, config) {
	const log = (level, msg) => ctx.logger?.[level]?.(msg);
	// 配置来源：宿主 Config（schema 默认值）为底，设置页写的文件覆盖其上——
	// 旧实现 {...file, ...host} 浅合并会让 schema 的空默认值把文件里的 Key/BaseURL 清空。
	const hostConfig = config ?? {};
	let currentConfig = deepMerge(hostConfig, loadConfigFile());
	const getConfig = () => currentConfig;
	const saveConfig = (patch) => {
		saveConfigFile(patch);
		currentConfig = deepMerge(hostConfig, loadConfigFile());
	};
	const embeddingCfg = () => ({
		enabled: currentConfig.embedding?.enabled !== false,
		baseURL: currentConfig.embedding?.baseURL ?? '',
		apiKey: currentConfig.embedding?.apiKey ?? '',
		model: currentConfig.embedding?.model ?? '',
		timeoutMs: currentConfig.embedding?.timeoutMs ?? 800,
		writeTimeoutMs: currentConfig.embedding?.writeTimeoutMs ?? 10_000
	});

	// ── 底座 ──
	const db = openDatabase();
	ctx.effect(() => () => { try { db.close(); } catch { /* 已关闭 */ } }, 'dsh-fish-soul: db');
	// 虚拟钟从上次快照续走（加速验收中途重启不倒退）
	const clock = new VirtualClock(undefined, Number(getKv(db, 'clock.virtualMs', 0)) || 0);

	// ── 检索 ──
	const embedder = new EmbeddingClient(embeddingCfg);
	embedder.probeWith = async (probeCfg) => new EmbeddingClient(() => probeCfg).probe();
	const worker = new VectorWorker({ db, embedder, clock, getEmbeddingConfig: embeddingCfg });
	worker.start();
	ctx.effect(() => () => worker.stop(), 'dsh-fish-soul: vector worker');

	/** LLM 调用（日程 / Dream / 刷视频 / 导入 / 学说法）：按功能选模型、记用量；支持 AbortSignal。 */
	const llmRouter = new LlmRouter({ ctx, db, getConfig, log });
	const callLlm = (prompt, opts) => llmRouter.call(prompt, opts);

	// ── QQ 渠道（SnowLuma WS 直连）与会话网关 ──
	const qqCfg = () => currentConfig.qq ?? {};
	/** @type {ChatGateway|null} */
	let gateway = null;
	const channel = new SnowLumaChannel({
		getConfig: qqCfg,
		log,
		onEvent: (event) => { void gateway?.onEvent(event).catch((error) => log('error', `[fish-soul] QQ 消息处理失败：${String(error instanceof Error ? error.message : error)}`)); },
		onConnected: () => gateway?.backfill()
	});

	// ── 人格（JSON / PNG 卡，宏替换，世界书）──
	const persona = loadPersona(fishSoulDir(), log);
	log('info', `[fish-soul] 人格来源 ${persona.source}：${persona.name}，世界书关键词条目 ${persona.lore.length}`);

	// ── B站：私信轮询渠道 + 自己刷视频 ──
	const biliCfg = () => currentConfig.bili ?? {};
	const biliClient = new BiliClient({ log });
	const bili = new BiliChannel({
		client: biliClient, db, getConfig: biliCfg, log,
		onMessage: (m) => gateway?.onBiliMessage(m)
	});
	const browser = new BiliBrowser({
		db, clock, client: biliClient, getConfig: biliCfg, callLlm: llmRouter.bound('browse'), worker, log,
		persona: () => ({ name: persona.name, brief: String(persona.staticText ?? '').replace(/\s+/g, ' ').slice(0, 300) })
	});

	// ── 给主人的提醒（掉登录 / 页面改版 / 续期失败…）：同一件事只在 QQ 私聊里说一次，好了以后才会再提醒 ──
	function notifyMaster(key, text) {
		const sent = getKv(db, 'notice.sent', {}) ?? {};
		if (text === null || text === undefined) {
			if (key in sent) { delete sent[key]; setKv(db, 'notice.sent', sent); }
			return;
		}
		if (key in sent) return;
		const master = String(currentConfig.masterQqUin ?? '').trim();
		if (master === '' || qqCfg().enabled !== true || !channel.connected) return;
		sent[key] = Date.now();
		setKv(db, 'notice.sent', sent);
		void channel.send(`private:${master}`, [{ type: 'text', data: { text: `【鱼的提醒】${text}` } }]).catch((error) => {
			log('warn', `[fish-soul] 给主人发提醒失败：${String(error instanceof Error ? error.message : error)}`);
			const again = getKv(db, 'notice.sent', {}) ?? {};
			delete again[key];
			setKv(db, 'notice.sent', again);
		});
	}
	bili.notify = notifyMaster;

	// ── 抖音：专用浏览器 + 私信轮询 + 自己刷视频 ──
	const douyinCfg = () => currentConfig.douyin ?? {};
	const hook = testHooks.douyin ?? {};
	const douyinHost = new DouyinHost({ db, getConfig: douyinCfg, log, notify: notifyMaster, detect: hook.detect, launch: hook.launch });
	const douyin = new DouyinChannel({
		host: douyinHost, db, getConfig: douyinCfg, log, notify: notifyMaster,
		onMessage: (m) => gateway?.onDouyinMessage(m),
		driver: hook.driver?.(douyinHost), pollRangeMs: hook.pollRangeMs, typingMs: hook.typingMs, firstPollMs: hook.firstPollMs
	});
	const douyinBrowser = new DouyinBrowser({
		db, clock, host: douyinHost, getConfig: douyinCfg, callLlm: llmRouter.bound('browse'), worker, log,
		dwellMs: hook.dwellMs, settleMs: hook.settleMs, readDetail: hook.readDetail, fetchImpl: hook.fetch,
		persona: () => ({ name: persona.name, brief: String(persona.staticText ?? '').replace(/\s+/g, ' ').slice(0, 300) })
	});
	// 表情包里的 webp：宿主自带的 sharp 优先，没有就用抖音浏览器里的 canvas
	void loadSharp().then((s) => log('info', s ? '[fish-soul] 找到 sharp，webp 表情包可以转给 B站 / 抖音' : '[fish-soul] 没找到 sharp，webp 表情包要靠抖音浏览器转（浏览器没开就不发 webp）'));
	const canvasConvert = (bytes) => douyinHost.canvasConvert(bytes);
	const canConvertWebp = () => sharpReady() || douyinHost.running;

	// ── 自走层：主动开口 = 往目标聊天的会话里递一条触发消息，由会话里的模型带着上下文写 ──
	const deliver = async (channelId, reason, meta = {}) => (gateway === null ? false : gateway.triggerProactive(channelId, reason, meta));
	const life = new LifeEngine({
		db, clock, getConfig, callLlm, deliver, log,
		browse: (opts) => browser.run(opts),
		douyinBrowse: (opts) => douyinBrowser.run(opts),
		douyinReady: () => douyinBrowser.ready
	});

	// ── 上网查：宿主的 web_search / web_fetch，或自己填 key 的搜索服务（fish_search）；默认关，按天限次数 ──
	function webConfig() {
		return webSearchConfig(currentConfig.tools?.web ?? {});
	}
	function hostWebAvailable() {
		try { return typeof ctx.tools?.get === 'function' && ctx.tools.get('web_search') !== undefined; } catch { return false; }
	}
	/** 选中的搜索服务能不能用（不看开关和次数）。 */
	function hasWebTools() {
		const w = webConfig();
		return w.provider === 'host' ? hostWebAvailable() : ownSearchReady(w);
	}
	const webToolName = () => (webConfig().provider === 'host' ? 'web_search' : OWN_WEB_TOOL);
	async function runWebSearch(query, { signal, count } = {}) {
		return webSearch(webConfig(), query, { fetchImpl: (...args) => (testHooks.webFetch ?? globalThis.fetch)(...args), signal, count });
	}
	function webToolsReady() {
		const w = webConfig();
		return w.enabled && hasWebTools() && webUsedToday() < w.perDay;
	}
	function webDayKey() {
		return `web.count.${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)}`;
	}
	function webUsedToday() {
		return Number(getKv(db, webDayKey(), 0)) || 0;
	}
	function countWebUse(sessionId, name) {
		setKv(db, webDayKey(), webUsedToday() + 1);
		gateway?.note('web', { channelId: gateway.bound.get(String(sessionId))?.channel_id ?? '', reason: name === 'web_fetch' ? '打开了一个网页' : '上网查了一下' });
	}

	// ── 会话上下文：按 DSH 会话 id 隔离，禁止"认不出就当主人" ──
	/**
	 * sessionId → 本轮上下文。speakers 是本轮（可能多人合批）的说话人，各自带召回 query。
	 * @type {Map<string, {channel:string, channelId:string, speakers:Array<{ownerId:string, person:object|null, userId:string, displayName:string, query:string, vec:object|null, vecQuery:string}>, dueReasons:string[], workspacePath:string, atReal:number}>}
	 */
	const sessions = new Map();

	const ownerOf = (person) => (person ? `user:${person.canonical_id}` : UNKNOWN_OWNER);

	function prefetchVec(sp) {
		if (sp.ownerId === UNKNOWN_OWNER || sp.query === '') return;
		const query = sp.query;
		void vectorRanks({
			db, embedder, characterId: 'feiyu', ownerId: sp.ownerId, query, embeddingCfg: embeddingCfg()
		}).then((vec) => {
			if (sp.query === query) { sp.vec = vec; sp.vecQuery = query; }
		}).catch(() => { /* fail-open */ });
	}

	/** 网关在把一批 QQ 消息 / 主动触发递进会话之前调用：登记本轮说话人、预取向量、取到期约定。 */
	function beginTurn(sessionId, { channel: ch, channelId, speakers, workspacePath, backlog = [], interject = false, voiceIn = false }) {
		const sp = (speakers ?? []).map((s) => ({
			ownerId: ownerOf(s.person), person: s.person ?? null, userId: String(s.userId ?? ''),
			displayName: s.displayName || s.person?.display_name || '对方',
			query: String(s.text ?? ''), vec: null, vecQuery: ''
		}));
		const dueReasons = [];
		for (const one of sp) {
			if (one.ownerId === UNKNOWN_OWNER) continue;
			// 每轮只取一次到期约定（text() 可能被多次调用，不能在那里做有副作用的操作）
			dueReasons.push(...life.surfacePendingFor(one.ownerId));
			prefetchVec(one);
		}
		sessions.delete(String(sessionId));
		sessions.set(String(sessionId), { channel: ch, channelId, speakers: sp, dueReasons, workspacePath: workspacePath ?? '', atReal: Date.now(), backlog, interject, voiceIn, recalled: [] });
		if (sessions.size > 500) sessions.delete(sessions.keys().next().value);
	}

	/** 插件重启后会话 Map 是空的：从 chat_session 映射重建（私聊能认出人，群里只知道是哪个群）。 */
	function sessionFor(sessionId) {
		if (sessionId === undefined || sessionId === null || sessionId === '') return undefined;
		const key = String(sessionId);
		const hit = sessions.get(key);
		if (hit !== undefined) return hit;
		const row = gateway?.chatForSession(key);
		if (!row) return undefined;
		const [kind, id] = splitChannelId(row.channel_id);
		const person = kind === 'private' ? findPersonByQq(db, id) : kind === 'bili' ? findPersonByBili(db, id) : kind === 'douyin' ? findPersonByDouyin(db, id) : null;
		const rebuilt = {
			channel: sessionChannelOf(row.channel_id), channelId: row.channel_id,
			speakers: person !== null ? [{ ownerId: ownerOf(person), person, userId: id, displayName: person.display_name, query: '', vec: null, vecQuery: '' }] : [],
			dueReasons: [], workspacePath: row.workspace_path, atReal: Date.now()
		};
		sessions.set(key, rebuilt);
		return rebuilt;
	}

	/** 单个说话人视图（工具用）。多人合批时按 speaker（署名）挑，挑不到就取最后开口的人。 */
	function speakerView(session, speakerName) {
		const list = session?.speakers ?? [];
		let sp = list[list.length - 1];
		const want = String(speakerName ?? '').trim();
		if (want !== '' && list.length > 0) {
			sp = list.find((x) => x.displayName === want || x.userId === want) ??
				list.find((x) => x.displayName.includes(want) || want.includes(x.displayName)) ?? sp;
		}
		return {
			ownerId: sp?.ownerId ?? UNKNOWN_OWNER,
			person: sp?.person ?? null,
			query: sp?.query ?? '',
			displayName: sp?.displayName ?? '对方',
			channel: session?.channel ?? 'dsh',
			channelId: session?.channelId ?? ''
		};
	}

	const UNKNOWN_VIEW = { ownerId: UNKNOWN_OWNER, person: null, displayName: '对方', channel: 'dsh', channelId: '' };

	/** 工具调用：按调用所在会话（toolCtx.agent.id）认人；认不出就是 unknown（不读写任何人的记忆）。 */
	function sessionForTool(toolCtx, speakerName) {
		const session = sessionFor(toolCtx?.agent?.id ?? toolCtx?.sessionId);
		return session === undefined ? UNKNOWN_VIEW : speakerView(session, speakerName);
	}

	const retrievalCfg = () => ({
		fusionMethod: currentConfig.retrieval?.fusionMethod ?? 'rrf',
		topK: currentConfig.retrieval?.topK ?? 5
	});

	function nowLabel() {
		return `现在是 ${life.stateSnapshot().clock.virtualIsoLocal.slice(0, 16)}`;
	}

	function stateLine() {
		const snap = life.stateSnapshot();
		return `[此刻状态] 虚拟时间 ${snap.clock.virtualIsoLocal}；` +
			`基调 ${snap.today.dailyMoodTone ?? '未生成'}；` +
			`时段 ${snap.today.currentSlot?.activity ?? '未知'}（${snap.today.currentSlot?.availability ?? '?'}）`;
	}

	function memoryLines(ownerId, query, vec, budget, used = null) {
		const out = [];
		try {
			const memories = recallSync({ db, clock, config: retrievalCfg(), characterId: 'feiyu', ownerId, query, vec });
			let spent = 0;
			for (const m of memories) {
				const line = `- （${m.kind}）${m.content}`;
				spent += line.length; // 中文约 1 字 ≈ 1 token，按字符保守估算
				if (spent > budget) break;
				out.push(line);
				used?.push(`#${m.id} ${m.content.slice(0, 40)}`);
			}
		} catch { /* fail-open */ }
		return out;
	}

	/**
	 * 同步组装本轮瞬态块：BM25 当场算（本轮消息，零滞后），向量排名若已为同一 query 预取完成则一起融合。
	 * 多人合批时按人分别召回，token 预算平分。宿主传入 { agent, scope }，按 agent.id 取本会话的上下文。
	 */
	function buildContextBlock(arg) {
		const session = sessionFor(arg?.agent?.id ?? arg?.scope?.id ?? arg?.sessionId);
		const lines = [stateLine()];
		if (session === undefined) return lines.join('\n');
		const isQq = session.channel === 'qq-group' || session.channel === 'qq-private';
		const isBili = session.channel === 'bili-private';
		const isDouyin = session.channel === 'douyin-private';
		const speakers = session.speakers ?? [];
		if (speakers.length > 0) {
			lines.push(`[当前说话人] ${speakers.map((s) => `${s.displayName}（${s.ownerId === UNKNOWN_OWNER ? '身份未识别' : s.person?.relation_stage ?? 'stranger'}）`).join('、')}`);
		}
		// 人物印象（Dream 写的 / 主人改的）：比零散记忆更稳定的"她怎么看这个人"
		for (const sp of speakers.filter((s) => s.ownerId !== UNKNOWN_OWNER).slice(-3)) {
			const profile = getProfile(db, sp.ownerId);
			if (profile !== null) lines.push(`[你对 ${sp.displayName} 的印象] ${profile.text.slice(0, 200)}`);
		}
		const budget = currentConfig.retrieval?.tokenBudget ?? 1200;
		const withQuery = speakers.filter((s) => s.ownerId !== UNKNOWN_OWNER && s.query !== '').slice(-3);
		const used = [];
		for (const sp of withQuery) {
			const memLines = memoryLines(sp.ownerId, sp.query, sp.vecQuery === sp.query ? sp.vec : null, Math.floor(budget / withQuery.length), used);
			if (memLines.length > 0) lines.push(speakers.length > 1 ? `[关于 ${sp.displayName} 的记忆]` : '[相关记忆]', ...memLines);
		}
		session.recalled = used;
		const due = session.dueReasons ?? [];
		if (due.length > 0) lines.push('[到期的约定，可自然提起]', ...due.map((r) => `- ${r}`));
		if (session.channel === 'qq-group' && session.channelId !== '') {
			const recent = db.prepare(`
				SELECT content FROM memory
				WHERE character_id = 'feiyu' AND channel = 'qq-group' AND channel_id = ?
				  AND status = 'active' AND valid_to IS NULL
				ORDER BY created_at DESC LIMIT 5
			`).all(session.channelId);
			if (recent.length > 0) lines.push(`[本群近期]`, ...recent.map((r) => `- ${r.content}`));
			if ((session.backlog ?? []).length > 0) lines.push('[刚才群里在聊（没叫你，只作参考）]', ...session.backlog.map((x) => `- ${x}`));
			if (session.interject === true) lines.push('[这轮没人叫你] 是你自己看到群里的话想插一句；插得自然点、短一点，接不上或者不合适就只输出 [不回]。');
			lines.push(...slang.contextLines(session.channelId, [...speakers.map((s) => s.query), ...(session.backlog ?? [])].join('\n')));
		}
		const userName = speakers[speakers.length - 1]?.displayName ?? '对方';
		const lore = matchLore(persona.lore, speakers.map((s) => s.query).join('\n'));
		if (lore.length > 0) lines.push('[设定补充]', ...lore.map((e) => `- ${applyMacros(e.content, { charName: persona.name, userName })}`));
		if (isQq) {
			const stickers = gateway?.listStickers(session.workspacePath) ?? [];
			lines.push('[QQ 回复规则] 你的最后一条回复会原样发到 QQ' +
				(session.channel === 'qq-group'
					? '群里（群消息格式是"昵称：内容"；记的是谁的事，remember 时 speaker 就填谁的署名）'
					: '私聊') +
				'；空一行会拆成多条消息；不想接话就只输出 [不回]。' +
				(stickers.length > 0 ? `发表情包写 ![名字](_stickers/文件名)，可用：${stickers.join('、')}` : ''));
			const v = voiceConfig(currentConfig.voice, currentConfig.embedding);
			if (voice.ready() && (v.speak === 'sometimes' || (v.speak === 'mirror' && session.voiceIn === true))) {
				lines.push(`[语音] ${session.voiceIn === true ? '对方发的是语音，' : ''}想用语音说的话单独一段、开头写 [语音]（≤${v.maxChars} 字，口语，别带表情和链接；大多数时候还是打字）。`);
			}
		}
		if (isQq || isBili || isDouyin) {
			if (stickerConfig(currentConfig.stickers).collect && /【表情|【图片】/.test(speakers.map((s) => s.query).join(''))) {
				lines.push('[收藏表情] 对方发的表情包你觉得好玩、以后想用，可以在回复里单独写一行 [收藏表情:给它起的名字]（这行不会发出去）。');
			}
			if (webToolsReady()) {
				lines.push(`[上网] 遇到你不知道或者可能过时的事（新闻、比赛、新出的东西、没听过的梗），可以先用 ${webToolName()} 查；回复里别贴链接、别用 markdown，像聊天一样用自己的话说。`);
			} else if (hasWebTools()) {
				lines.push('[上网] 现在不能上网查，不知道的就直说不知道。');
			}
		}
		if (isBili || isDouyin) {
			// webp 表情包要转格式才能发：没有转换器（sharp / 抖音浏览器）就不给模型看
			const stickers = (gateway?.listStickers(session.workspacePath) ?? []).filter((f) => !/\.webp$/i.test(f) || canConvertWebp());
			const stickerRule = stickers.length > 0 ? `发表情包写 ![名字](_stickers/文件名)（一次最多 2 张），可用：${stickers.join('、')}；` : '';
			lines.push(isBili
				? '[B站私信回复规则] 你的最后一条回复会原样发到 B站私信；空一行会拆成多条消息；' + stickerRule +
					'也可以用 [doge][笑哭][妙啊] 这类 B站小表情；不想接话就只输出 [不回]。'
				: '[抖音私信回复规则] 你的最后一条回复会原样发到抖音私信；空一行会拆成多条消息；' + stickerRule +
					'单独一段只写 [比心] [捂脸] 这类抖音自带表情名会发成表情；不想接话就只输出 [不回]。');
		}
		if ((isQq || isBili || isDouyin) && biliCfg().enabled === true) {
			const seen = browser.contextLines(2);
			if (seen.length > 0) lines.push('[你最近在 B站刷到的（想聊再提，别硬塞）]', ...seen);
		}
		if ((isQq || isBili || isDouyin) && douyinCfg().enabled === true) {
			const seen = douyinBrowser.contextLines(2);
			if (seen.length > 0) lines.push('[你最近在抖音刷到的（想聊再提，别硬塞）]', ...seen);
		}
		if (persona.postHistory !== '') lines.push(applyMacros(persona.postHistory, { charName: persona.name, userName }));
		return lines.join('\n');
	}

	/** 宿主消息正文（content 是块数组）。 */
	function messageText(message) {
		const content = message?.content;
		if (typeof content === 'string') return content;
		if (!Array.isArray(content)) return '';
		return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
	}

	/**
	 * agent/inbox/inserted（payload = { agent, message }）：
	 *  - 我们自己递进去的 QQ / 主动消息：网关已在 beginTurn 里登记过，这里不重复计数；
	 *  - 其他会话（用户自己在 DSH 里聊天、别的插件转进来的消息）：source 里带了 QQ 号才认人，否则按 unknown。
	 */
	function noteInteraction(payload) {
		const agentId = payload?.agent?.id;
		const message = payload?.message ?? {};
		const source = message?.source ?? {};
		if (source.kind === SOURCE_QQ || source.kind === SOURCE_PROACTIVE || source.kind === SOURCE_BILI || source.kind === SOURCE_DOUYIN) return;
		if (gateway?.isOurSession(agentId)) return;
		if (agentId === undefined || agentId === null) return;
		const qqUin = String(source.userId ?? source.qqUin ?? source.user_id ?? '');
		const person = qqUin === '' ? null : resolveOrCreatePerson(db, {
			qqUin, nickname: String(source.nickname ?? ''), nowMs: clock.now(), masterQqUin: currentConfig.masterQqUin ?? ''
		});
		if (person !== null) life.noteInteraction(ownerOf(person));
		const groupId = source.groupId ?? source.group_id ?? null;
		beginTurn(agentId, {
			channel: person === null ? 'dsh' : (groupId != null ? 'qq-group' : 'qq-private'),
			channelId: person === null ? '' : (groupId != null ? `group:${groupId}` : `private:${qqUin}`),
			speakers: person !== null ? [{ person, userId: qqUin, displayName: person.display_name, text: messageText(message) }] : [],
			workspacePath: ''
		});
	}

	// ── v0.7：语音 / 收藏表情包 / 学群里的说法 ──
	const voice = new VoiceService({ db, getConfig: () => voiceConfig(currentConfig.voice, currentConfig.embedding), fetchImpl: (...args) => (testHooks.voiceFetch ?? globalThis.fetch)(...args), log });
	const stickers = new StickerBox({ db, getConfig: () => stickerConfig(currentConfig.stickers), log });
	const slang = new SlangLearner({
		db, callLlm: llmRouter.bound('slang'), getConfig: () => slangConfig(currentConfig.slang), log,
		personaName: () => persona.name, titleOf: (c) => gateway?.titleOf(c) ?? c
	});
	slang.start();
	ctx.effect(() => () => slang.stop(), 'dsh-fish-soul: slang');

	gateway = new ChatGateway({
		ctx, db, clock, getConfig, log, channel, bili, browser, douyin, douyinBrowser, canvasConvert, voice, stickers, slang,
		soul: {
			beginTurn,
			nowLabel,
			personaName: () => persona.name,
			availability: () => life.availability(),
			/** 这一轮瞬态块里召回了哪些记忆（"动态"里显示"她想起了什么"）。 */
			recallInfo: (sessionId) => sessions.get(String(sessionId))?.recalled ?? [],
			/** 入站消息认人：每条消息自增一次 interaction_count，并打断这个人的 Dream。 */
			resolvePerson(m) {
				const person = resolveOrCreatePerson(db, {
					qqUin: m.userId, nickname: m.nickname, nowMs: clock.now(), masterQqUin: currentConfig.masterQqUin ?? ''
				});
				life.noteInteraction(ownerOf(person));
				return person;
			},
			/** B站私信认人：主人 / "B站UID=QQ号"对应上的归到同一个人。 */
			resolveBiliPerson(m, { masterUid, linkedQq }) {
				const person = resolveOrCreateBiliPerson(db, {
					biliUid: m.userId, nickname: m.nickname, nowMs: clock.now(), masterBiliUid: masterUid, linkedQq
				});
				life.noteInteraction(ownerOf(person));
				return person;
			},
			/** 抖音私信认人：按会话里显示的名字；主人 / "抖音名字=QQ号"对应上的归到同一个人。 */
			resolveDouyinPerson(m, { masterName, linkedQq }) {
				const person = resolveOrCreatePlatformPerson(db, {
					platform: 'douyin', platformId: m.userId, nickname: m.nickname, nowMs: clock.now(), masterId: masterName, linkedQq
				});
				life.noteInteraction(ownerOf(person));
				return person;
			},
			/** 不回复的消息（陌生人临时会话、超过 10 分钟的旧消息、B站 / 抖音只读阶段）：只记一条低重要度记忆。 */
			memorizeUnanswered(person, m) {
				const text = String(m.text ?? '').trim();
				if (person === null || text === '') return;
				const where = m.channel === 'bili' ? 'B站私信里' : m.channel === 'douyin' ? '抖音私信里' : `QQ${m.chatType === 'group' ? '群里' : '私聊'}`;
				const content = `${person.display_name || m.nickname || m.userId}在${where}说（当时没回）：${text.slice(0, 200)}`;
				const nowVirtual = clock.now();
				const result = db.prepare(`
					INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
					                    importance, emotion, source_session, created_at, updated_at, status)
					VALUES ('feiyu', ?, ?, ?, 'event', ?, ?, 1, 0, '', ?, ?, 'active')
				`).run(ownerOf(person), sessionChannelOf(m.channelId), m.channelId, content,
					tokenizeForBm25(content), nowVirtual, nowVirtual);
				worker.enqueueRealtime(Number(result.lastInsertRowid), content);
			}
		}
	});
	ctx.effect(() => () => gateway?.stop(), 'dsh-fish-soul: gateway');

	life.start();
	ctx.effect(() => () => life.stop(), 'dsh-fish-soul: life');

	// ── 备份（每天一次 VACUUM INTO，留最近几份）+ 聊天记录导入 ──
	const backup = new BackupService({ db, getConfig: () => currentConfig.backup ?? {}, log });
	backup.start();
	ctx.effect(() => () => backup.stop(), 'dsh-fish-soul: backup');
	const historyImporter = new HistoryImporter({
		db, clock, worker, callLlm: llmRouter.bound('import'), life, log,
		personaName: () => persona.name,
		masterQq: () => String(currentConfig.masterQqUin ?? ''),
		selfQq: () => String(channel.selfId ?? '')
	});
	ctx.effect(() => () => historyImporter.cancel(), 'dsh-fish-soul: history import');

	registerRoutes(ctx, {
		db, clock, embedder, worker, life, getConfig, saveConfig, log, gateway, channel, bili, biliClient, browser,
		douyin, douyinHost, douyinBrowser, backup, historyImporter,
		llmRouter, voice, stickers, slang, persona, webConfig, hasWebTools, webUsedToday, hostWebAvailable, runWebSearch
	});

	registerAgentHooks(ctx, {
		personaText: persona.staticText,
		buildContextBlock,
		noteInteraction,
		log
	});

	// 出站：盯我们建的会话，轮次结束把最后一条回复发回 QQ
	try {
		ctx.effect(() => {
			const off = ctx.on('session/event', (session, event) => {
				try { gateway?.onSessionEvent(session, event); } catch (error) {
					log('error', `[fish-soul] 处理会话事件出错：${String(error instanceof Error ? error.message : error)}`);
				}
			});
			return () => { try { off?.(); } catch { /* 已摘 */ } };
		}, 'dsh-fish-soul: session events');
	} catch (error) {
		log('error', `[fish-soul] session/event 监听挂不上：${String(error instanceof Error ? error.message : error)}`);
	}

	// 兜底护栏：就算用户在界面里重新打开 QQ 会话（宿主按默认组合恢复、没走我们的 restrict），
	// 这些会话里也只能调记忆工具。不放行 run_code：PTC 模式下它能跑任意程序，代价是 PTC 模式里记忆工具不可用。
	try {
		if (typeof ctx.tools.guard === 'function') {
			const allowed = new Set(QQ_SESSION_TOOLS);
			ctx.effect(() => ctx.tools.guard((exec) => {
				const id = exec?.agent?.id;
				const ours = id !== undefined && id !== null && gateway?.isOurSession(id) === true;
				if (!ours) return exec?.name === OWN_WEB_TOOL ? `${OWN_WEB_TOOL} 只给鱼的聊天会话用（DSH 自己的会话请用 web_search）` : undefined;
				if (WEB_TOOLS.includes(exec.name) || exec.name === OWN_WEB_TOOL) {
					const w = webConfig();
					if (!w.enabled) return `聊天会话里现在不能上网（设置页「模型」里打开「聊天时可以上网查」）`;
					if (exec.name === OWN_WEB_TOOL && w.provider === 'host') return `现在用的是 DSH 自带的搜索，请用 web_search`;
					if (exec.name !== OWN_WEB_TOOL && w.provider !== 'host') return `现在用的是自己配的搜索服务，请用 ${OWN_WEB_TOOL}`;
					if (webUsedToday() >= w.perDay) return `今天上网查的次数用完了（每天 ${w.perDay} 次）`;
					countWebUse(id, exec.name);
					return undefined;
				}
				return allowed.has(exec.name) ? undefined : `聊天会话（QQ / B站 / 抖音）里不能用 ${exec.name}（只开放记忆工具和上网查）`;
			}), 'dsh-fish-soul: qq tool guard');
		} else {
			log('warn', '[fish-soul] 宿主没有 tools.guard：QQ 会话的工具限制只靠建会话时的 restrict');
		}
	} catch (error) {
		log('error', `[fish-soul] 工具护栏挂不上：${String(error instanceof Error ? error.message : error)}`);
	}

	if (qqCfg().enabled === true) channel.start();
	ctx.effect(() => () => channel.stop(), 'dsh-fish-soul: qq channel');
	if (biliCfg().enabled === true) bili.start();
	ctx.effect(() => () => bili.stop(), 'dsh-fish-soul: bili channel');
	if (douyinCfg().enabled === true) douyin.start();
	// 卸载（含热重载）只断开浏览器连接，不关浏览器：新实例直接连上，窗口不会闪
	ctx.effect(() => () => { douyin.stop(); douyinHost.dispose(); }, 'dsh-fish-soul: douyin channel');

	// ── 工具：remember / recall / forget ──
	const textOutput = {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: String(value) }]
	};

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'remember',
		description: '把用户刚说的事实 / 事件 / 感受写入长期记忆。用户提及未来约定或提醒时，' +
			'同时填 dueInMinutes（相对分钟，优先）或 dueAtIso + proactiveReason，会在同一事务内' +
			'登记到期主动提醒（pending）。',
		parameters: objectSchema({
			content: { type: 'string', required: true, description: '要记住的内容（一句完整的话）' },
			kind: { type: 'string', enum: ['fact', 'event', 'feeling'], required: true, description: "'fact' | 'event' | 'feeling'" },
			importance: { type: 'number', description: '1..5，>=3 豁免时间衰减' },
			emotion: { type: 'number', description: '-2..+2' },
			dueInMinutes: { type: 'number', description: '相对当前虚拟时间的分钟数（到期提醒，优先）' },
			dueAtIso: { type: 'string', description: '或绝对时间，如 2026-11-02T09:00（按 UTC+8 角色时区理解）' },
			proactiveReason: { type: 'string', description: '到期主动开口的理由' },
			speaker: { type: 'string', description: '群里多人说话时，这条记忆属于谁（填消息里的署名）；私聊不用填' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const content = String(args.content ?? '').trim();
			const kind = ['fact', 'event', 'feeling'].includes(args.kind) ? args.kind : 'fact';
			if (content === '') return '内容为空，未写入。';
			const session = sessionForTool(toolCtx, args.speaker);
			if (session.ownerId === UNKNOWN_OWNER) return '没识别出说话人是谁，这条先不记（避免记到别人名下）。';
			const nowVirtual = clock.now();
			const importance = Math.min(5, Math.max(1, Number(args.importance ?? 1) || 1));
			const emotion = Math.min(2, Math.max(-2, Number(args.emotion ?? 0) || 0));

			let dueAt = null;
			const minutes = Number(args.dueInMinutes);
			if (args.dueInMinutes !== undefined && args.dueInMinutes !== null && Number.isFinite(minutes) && minutes > 0) {
				dueAt = nowVirtual + minutes * 60_000;
			} else if (typeof args.dueAtIso === 'string' && args.dueAtIso !== '') {
				// 模型看到的是瞬态块里的虚拟时间，所以绝对时间就是虚拟时间轴上的点
				dueAt = parseRoleIso(args.dueAtIso);
				if (dueAt !== null && dueAt <= nowVirtual) dueAt = null;
			}

			// 去重：同一人同一句已记过就只刷新时间
			const dup = db.prepare(`
				SELECT id FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND content = ? AND status = 'active' LIMIT 1
			`).get(session.ownerId, content);

			let memoryId = 0;
			db.exec('BEGIN');
			try {
				if (dup !== undefined) {
					memoryId = dup.id;
					db.prepare('UPDATE memory SET updated_at = ?, importance = MAX(importance, ?) WHERE id = ?')
						.run(nowVirtual, importance, memoryId);
				} else {
					const result = db.prepare(`
						INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
						                    importance, emotion, source_session, created_at, updated_at, status, evidence)
						VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
					`).run(session.ownerId, session.channel, session.channelId, kind, content,
						tokenizeForBm25(content), importance, emotion,
						String(toolCtx?.sessionId ?? toolCtx?.agent?.id ?? ''), nowVirtual, nowVirtual,
						session.query ? `${session.displayName}：${session.query.slice(0, 200)}` : '');
					memoryId = Number(result.lastInsertRowid);
				}
				if (dueAt !== null) {
					db.prepare(`
						INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at)
						VALUES ('feiyu', ?, ?, ?, ?, ?, 'pending', ?)
					`).run(session.ownerId, session.channel, session.channelId, dueAt,
						String(args.proactiveReason ?? content.slice(0, 60)), nowVirtual);
				}
				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
			if (dup === undefined) worker.enqueueRealtime(memoryId, content);
			const tail = dueAt !== null ? `，并登记到期提醒（${new Date(dueAt + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}）` : '';
			return `${dup !== undefined ? '已经记过了，已刷新' : '已记住'} #${memoryId}${tail}。`;
		}
	})), 'dsh-fish-soul: remember');

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'recall',
		description: '按当前对话内容主动检索当前说话人的长期记忆（BM25 + 语义向量 RRF 融合）。',
		parameters: objectSchema({
			query: { type: 'string', required: true, description: '检索词或问题' },
			speaker: { type: 'string', description: '群里多人说话时，查谁的记忆（填消息里的署名）；私聊不用填' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const session = sessionForTool(toolCtx, args.speaker);
			if (session.ownerId === UNKNOWN_OWNER) return '没识别出说话人，不检索。';
			const memories = await recall({
				db, embedder, clock, config: retrievalCfg(), characterId: 'feiyu',
				ownerId: session.ownerId, query: String(args.query ?? ''), embeddingCfg: embeddingCfg()
			});
			if (memories.length === 0) return '没有检索到相关记忆。';
			return memories.map((m) => `#${m.id}（${m.kind}${m.owner_id === 'self' ? ' / 自己' : ''}）${m.content}`).join('\n');
		}
	})), 'dsh-fish-soul: recall');

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'forget',
		description: '删除当前说话人自己的一条长期记忆（id 来自 remember/recall 输出）。不能删除别人的记忆。',
		parameters: objectSchema({
			id: { type: 'number', required: true, description: '记忆 id' },
			speaker: { type: 'string', description: '群里多人说话时，是谁要删（填消息里的署名）' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const id = Number(args.id);
			if (!Number.isInteger(id)) return 'id 必须是整数。';
			const session = sessionForTool(toolCtx, args.speaker);
			const row = db.prepare("SELECT owner_id FROM memory WHERE id = ? AND status = 'active'").get(id);
			if (row === undefined) return `没有找到记忆 #${id}。`;
			// 归属校验：只能删自己的；主人可删任何人（含 self）
			const isMaster = session.ownerId === 'user:master';
			if (!isMaster && row.owner_id !== session.ownerId) return `记忆 #${id} 不属于当前说话人，不能删除。`;
			const nowVirtual = clock.now();
			db.exec('BEGIN');
			try {
				db.prepare("UPDATE memory SET status = 'archived', valid_to = ?, updated_at = ? WHERE id = ?")
					.run(nowVirtual, nowVirtual, id);
				db.prepare('DELETE FROM vec WHERE memory_id = ?').run(id);
				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
			return `已删除记忆 #${id}。`;
		}
	})), 'dsh-fish-soul: forget');

	// ── 工具：fish_search（自己填 key 的搜索服务；只在鱼的聊天会话里能用，开关 / 次数由上面的护栏管）──
	ctx.effect(() => ctx.tools.register(defineTool({
		name: OWN_WEB_TOOL,
		description: '上网搜一下（新闻、比赛、新出的东西、没听过的梗等你不知道或可能过时的事），返回几条标题和摘要。',
		parameters: objectSchema({
			query: { type: 'string', required: true, description: '搜索词，简短具体，比如「2026 英雄联盟 全球总决赛 冠军」' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const w = webConfig();
			if (!ownSearchReady(w)) return '搜索服务没配好（设置页「模型」→ 上网查），这次查不了，不知道就直说。';
			const q = String(args.query ?? '').trim();
			try {
				return formatSearch(q, await runWebSearch(q, { signal: toolCtx?.signal }));
			} catch (error) {
				const msg = String(error instanceof Error ? error.message : error);
				log('warn', `[fish-soul] 上网查失败：${msg}`);
				return `这次没搜成（${msg.slice(0, 120)}），不知道就直说。`;
			}
		}
	})), 'dsh-fish-soul: fish_search');

	log('info', '[fish-soul] 插件启动：soul.db 就绪，VirtualClock ×' + clock.scale +
		`，Worker 运行中，世代 gen #${readVecMeta(db)?.generation_id ?? 1}`);
}
