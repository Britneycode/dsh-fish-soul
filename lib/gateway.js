/**
 * gateway.js —— 外部聊天 ↔ DSH 会话（v0.3：fish-soul 直连 SnowLuma，取代 dsh-qq-bridge）。
 *
 *  - 一个 QQ 聊天（私聊 / 群）对应一个 DSH 会话：首次来消息时 `ctx.agents.create` 自动新建，
 *    映射存 soul.db 的 chat_session，重启后 `ctx.agents.resume` 续上；
 *  - 会话建在用户选的工作区里（默认 $DSH_HOME/fish-soul/workspace，标题"鱼"）；
 *  - 会话只给记忆工具（restrict 白名单 + guard 兜底：就算用户在界面里重新打开会话也拿不到 shell/写文件）；
 *  - 入站：私聊只回 QQ 好友（陌生人临时会话只记人、记一条记忆）；群里只听 @/引用，点名后接着听几条；
 *    1.5s 内的多条合成一轮，带署名和说话人列表；超过 10 分钟的旧消息（断线补拉）只记忆不回复；
 *  - 出站：本轮由 QQ / 主动开口触发、且正常结束（turn/end=completed）时，把最后一条回复整段发回去，
 *    markdown 图片 `![](…)` 换成真图；只输出 [不回] 表示这轮不发。
 *  - v0.4 起同一套会话管理也接 B站私信（channel_id = bili:<UID>）：只回主人 / 白名单 / 互关的人，
 *    自动回复默认关（只记不回）；B站私信只发文字。聊天里出现 B站视频（BV 号 / b23 短链 / 分享卡片）时，
 *    先取一段简介和字幕节选拼进消息，让她"看过"再回。
 *  - v0.5 起接抖音私信（channel_id = douyin:<会话名>，网页版拿不到抖音号，只能按会话里显示的名字认人）：
 *    只回主人 / 白名单，或者打开"回所有能私信她的人"；B站和抖音都能发表情包图片（webp 先转 png / gif），
 *    每次回复最多 2 张。
 *  - v0.6：群里没点名的话先攒着（被叫到时一起给她看"刚才在聊什么"）；叫她名字也算点名；可选"主动插话"
 *    （概率 + 冷却 + 每小时上限，睡觉时不插，插完对方接话就接着听）；戳一戳当成点名；没回复前撤回的消息不回；
 *    连发按字数估打字时间；每个聊天能单独暂停（设置页 / 主人发"/鱼 暂停"）；每一步判定记进"动态"。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	fishSoulDir, findChatSession, findChatSessionBySessionId, insertChatSession, listChatSessions,
	findPersonByQq, findPersonByBili, getKv, setKv
} from './db.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { findVideoRefs } from './browse.js';
import { findDouyinRefs } from './douyin-browse.js';
import { prepareImage } from './imageconv.js';
import { normalizeMessageEvent, sanitizeName, sanitizeUserText } from './channels/onebot.js';
import { 该收这条, 提取正文, 提取图块, 拆成消息段, 抠正文图 } from './channels/vendor/qq-bridge.js';

export const SOURCE_QQ = 'fish-soul/qq';
export const SOURCE_PROACTIVE = 'fish-soul/proactive';
export const SOURCE_BILI = 'fish-soul/bili';
export const SOURCE_DOUYIN = 'fish-soul/douyin';
const OUR_SOURCES = new Set([SOURCE_QQ, SOURCE_PROACTIVE, SOURCE_BILI, SOURCE_DOUYIN]);

/** channel_id → 平台：bili:<UID> 是 B站私信，douyin:<名字> 是抖音私信，其余（private:/group:）是 QQ。 */
export function platformOf(channelId) {
	const s = String(channelId ?? '');
	if (s.startsWith('bili:')) return 'bili';
	if (s.startsWith('douyin:')) return 'douyin';
	return 'qq';
}

/** channel_id → [种类, id]（抖音名字里可能有冒号，只切第一个）。 */
export function splitChannelId(channelId) {
	const s = String(channelId ?? '');
	const i = s.indexOf(':');
	return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/** 内部 channel 名（memory.channel / 会话上下文用）。 */
export function sessionChannelOf(channelId) {
	const [kind] = splitChannelId(channelId);
	if (kind === 'bili') return 'bili-private';
	if (kind === 'douyin') return 'douyin-private';
	return kind === 'group' ? 'qq-group' : 'qq-private';
}
/** QQ 会话里模型能用的全部工具（宿主 PTC 传输 run_code 不算工具本身，单独放行）。 */
export const QQ_SESSION_TOOLS = ['remember', 'recall', 'forget'];
const SILENT_RE = /^\s*\[(不回|沉默|skip)\]\s*$/i;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INBOUND_IMAGES = 4;
const MAX_PARAGRAPHS = 5;
/** B站 / 抖音每次回复最多发几张图 */
const MAX_DM_IMAGES = 2;
/** 抖音自带的小表情：一段只有 [名字] */
const DOUYIN_EMOJI_RE = /^\[([\u4e00-\u9fa5A-Za-z0-9]{1,8})\]$/;
const SEEN_LIMIT = 4000;
const OWN_LIMIT = 500;
const PROACTIVE_TURN_TIMEOUT_MS = 5 * 60_000;
/** 群里没点名的话最多攒多少条 / 多久以内的（被叫到时给她看"刚才在聊什么"） */
const BACKLOG_LIMIT = 12;
const BACKLOG_MAX_AGE_MS = 15 * 60_000;
const DECISION_LIMIT = 300;
const POKE_GAP_MS = 60_000;
const PAUSE_KEY = 'chat.paused';
/** 主人在 QQ 里发的控制命令：/鱼 暂停 [30分钟|2小时]、/鱼 继续 */
const COMMAND_RE = /^\s*[\/／]鱼\s*(暂停|安静|闭嘴|继续|恢复|说话)\s*(?:(\d{1,4})\s*(分钟|分|小时|h|m)?)?\s*$/i;

/** 连发时下一条之前的停顿：按字数估打字时间（±20%），600ms–4.5s。 */
export function typingDelayMs(text, random = Math.random) {
	const n = [...String(text ?? '')].length;
	const base = 500 + n * 55;
	return Math.round(Math.min(4500, Math.max(600, base * (0.8 + random() * 0.4))));
}

/**
 * 群里没被点名时，想不想插一句（0..1）：基础概率，聊到她感兴趣的话题 +0.35，说话的是熟人 +0.1，
 * 在提问 +0.05；群里刷屏（一分钟 ≥ 8 条）减半，太短的 / 只有图的再打三折。
 */
export function interjectScore({ text, base = 0.05, keywords = [], relation = 'stranger', isMaster = false, busyCount = 0 }) {
	const t = String(text ?? '');
	let score = Math.max(0, Math.min(1, Number(base) || 0));
	if (keywords.some((k) => k !== '' && t.includes(k))) score += 0.35;
	if (isMaster || relation === 'friend' || relation === 'close') score += 0.1;
	if (/[?？]\s*$|[吗呢嘛]\s*$/.test(t)) score += 0.05;
	if (busyCount >= 8) score *= 0.5;
	const plain = t.replace(/【[^】]*】/g, '').trim();
	if ([...plain].length < 4) score *= 0.3;
	return Math.max(0, Math.min(1, score));
}

export function dedicatedWorkspacePath() {
	return join(fishSoulDir(), 'workspace');
}

function mediaTypeOf(buf) {
	if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
	if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
	if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
	return 'image/jpeg';
}

function isInside(root, target) {
	const rel = relative(resolve(root), resolve(target));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 读消息里的图片（url / file:// / base64:// / 本地路径），失败返回 null。 */
async function fetchImageBytes(img) {
	const url = typeof img?.url === 'string' ? img.url.trim() : '';
	try {
		if (url.startsWith('data:')) {
			const m = /^data:[^;,]*;base64,/.exec(url);
			const buf = m ? Buffer.from(url.slice(m[0].length), 'base64') : null;
			return buf !== null && buf.length > 0 && buf.length <= MAX_IMAGE_BYTES ? buf : null;
		}
		if (/^https?:\/\//i.test(url)) {
			const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
			if (res.ok) {
				const buf = Buffer.from(await res.arrayBuffer());
				return buf.length <= MAX_IMAGE_BYTES ? buf : null;
			}
		} else if (url.startsWith('file://')) {
			return readFileSync(fileURLToPath(url));
		}
	} catch { /* 换 file 字段再试 */ }
	const file = typeof img?.file === 'string' ? img.file.trim() : '';
	try {
		if (file.startsWith('base64://')) return Buffer.from(file.slice(9), 'base64');
		if (/^https?:\/\//i.test(file)) {
			const res = await fetch(file, { signal: AbortSignal.timeout(8000) });
			if (res.ok) return Buffer.from(await res.arrayBuffer());
		}
	} catch { /* 放弃 */ }
	return null;
}

/** 可选宿主服务：先 ctx.get（不触发未声明 inject 的告警），再退回属性访问。 */
function service(ctx, name) {
	try {
		const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
		if (v !== undefined && v !== null) return v;
	} catch { /* 往下 */ }
	try { return ctx[name] ?? null; } catch { return null; }
}

export class ChatGateway {
	/**
	 * @param {object} deps
	 * @param {object} deps.ctx 插件 Cordis 上下文
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {import('./clock.js').VirtualClock} deps.clock
	 * @param {() => object} deps.getConfig
	 * @param {(level: string, msg: string) => void} deps.log
	 * @param {import('./channels/snowluma.js').SnowLumaChannel} deps.channel
	 * @param {import('./channels/bilibili.js').BiliChannel|null} [deps.bili]
	 * @param {import('./browse.js').BiliBrowser|null} [deps.browser]
	 * @param {import('./channels/douyin.js').DouyinChannel|null} [deps.douyin]
	 * @param {import('./douyin-browse.js').DouyinBrowser|null} [deps.douyinBrowser]
	 * @param {((bytes: Buffer) => Promise<Buffer|null>)|null} [deps.canvasConvert] 没有 sharp 时转 webp
	 * @param {object} deps.soul index.js 提供的人格/记忆回调
	 */
	constructor({ ctx, db, clock, getConfig, log, channel, bili = null, browser = null, douyin = null, douyinBrowser = null, canvasConvert = null, soul }) {
		this.ctx = ctx;
		this.db = db;
		this.clock = clock;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.channel = channel;
		this.bili = bili;
		this.browser = browser;
		this.douyin = douyin;
		this.douyinBrowser = douyinBrowser;
		this.canvasConvert = canvasConvert;
		this.soul = soul;
		/** sessionId → chat_session 行（只存我们建的会话） */
		this.bound = new Map();
		/** channelId → Promise<Agent>（同一聊天并发来消息时只建一个会话） */
		this.inflight = new Map();
		/** channelId → {items, timer} */
		this.batches = new Map();
		/** channelId → {剩, 到}（群里点名后的接着听） */
		this.follow = new Map();
		/** sessionId → 本轮出站状态 */
		this.turns = new Map();
		/** sessionId → 下一轮回复时要引用的消息 id（群） */
		this.replyTo = new Map();
		/** 用户消息 id → 主动开口等待者 */
		this.waiters = new Map();
		this.seen = new Set();
		/** 她自己发出的消息 id → 正文摘要（识别"引用我"、给引用补原文） */
		this.ownMessages = new Map();
		/** channelId → [{name, text, timeMs, messageId}]（群里没点名的话） */
		this.backlog = new Map();
		/** channelId → 插话的时间戳（每小时上限 / 冷却） */
		this.interjects = new Map();
		/** channelId → 她上次在这个群里说话的时间 */
		this.lastSpoke = new Map();
		/** 本轮是她自己插话的会话 */
		this.interjectTurns = new Set();
		/** "动态"：最近的判定 / 发送记录（新的在前） */
		this.decisions = [];
		this.pokeAt = new Map();
		this.random = Math.random;
		this.stopped = false;
		for (const row of this.allSessions()) this.bound.set(row.session_id, row);
	}

	allSessions() {
		return [...listChatSessions(this.db, 'qq'), ...listChatSessions(this.db, 'bili'), ...listChatSessions(this.db, 'douyin')];
	}

	qqConfig() {
		const q = this.getConfig().qq ?? {};
		return {
			enabled: q.enabled === true,
			groupAllowList: Array.isArray(q.groupAllowList) ? q.groupAllowList.map(String) : [],
			followUpCount: Number.isFinite(Number(q.followUpCount)) ? Number(q.followUpCount) : 3,
			followUpSeconds: Number.isFinite(Number(q.followUpSeconds)) ? Number(q.followUpSeconds) : 120,
			batchMs: Number.isFinite(Number(q.batchMs)) ? Number(q.batchMs) : 1500,
			replyWindowMinutes: Number.isFinite(Number(q.replyWindowMinutes)) ? Number(q.replyWindowMinutes) : 10,
			callNames: Array.isArray(q.callNames) ? q.callNames.map((x) => String(x).trim()).filter(Boolean) : [],
			interject: interjectConfig(q.interject)
		};
	}

	/** 叫她的名字：设置页填的称呼；没填就用人格卡的名字（一个字的名字太容易误伤，比如"鱼"，不算）。 */
	callNames(cfg = this.qqConfig()) {
		if (cfg.callNames.length > 0) return cfg.callNames;
		const name = String(this.soul.personaName?.() ?? '').trim();
		return [...name].length >= 2 ? [name] : [];
	}

	// ───────────────────────── 暂停 / 动态 ─────────────────────────

	/** 这个聊天现在是不是暂停着（暂停 = 只记不回、不主动）。 */
	isPaused(channelId) {
		const map = getKv(this.db, PAUSE_KEY, {}) ?? {};
		if (!(channelId in map)) return false;
		const until = Number(map[channelId]);
		if (until === 0 || until > Date.now()) return true;
		delete map[channelId];
		setKv(this.db, PAUSE_KEY, map);
		return false;
	}

	/** minutes > 0 暂停这么久；-1 一直暂停；0 恢复。返回暂停到什么时候（0 = 一直，null = 没暂停）。 */
	setPaused(channelId, minutes) {
		const map = getKv(this.db, PAUSE_KEY, {}) ?? {};
		const n = Number(minutes);
		if (!Number.isFinite(n) || n === 0) delete map[channelId];
		else map[channelId] = n < 0 ? 0 : Date.now() + Math.min(n, 30 * 24 * 60) * 60_000;
		setKv(this.db, PAUSE_KEY, map);
		return channelId in map ? map[channelId] : null;
	}

	pausedMap() {
		const out = {};
		for (const [id, until] of Object.entries(getKv(this.db, PAUSE_KEY, {}) ?? {})) if (this.isPaused(id)) out[id] = until;
		return out;
	}

	titleOf(channelId, fallback = '') {
		const row = findChatSession(this.db, platformOf(channelId), channelId);
		return row?.title || fallback || channelId;
	}

	/** 记一条"动态"：kind = reply / memorize / interject / sent / silent / failed / paused / recalled / command … */
	note(kind, { channelId = '', who = '', text = '', reason = '', title = '', memories } = {}) {
		this.decisions.unshift({
			at: Date.now(), kind, channelId, title: title || this.titleOf(channelId),
			who: String(who ?? '').slice(0, 24), text: String(text ?? '').replace(/\s+/g, ' ').slice(0, 80), reason,
			...(Array.isArray(memories) && memories.length > 0 ? { memories: memories.slice(0, 5) } : {})
		});
		if (this.decisions.length > DECISION_LIMIT) this.decisions.length = DECISION_LIMIT;
	}

	masterQq() {
		return String(this.getConfig().masterQqUin ?? '');
	}

	biliConfig() {
		const b = this.getConfig().bili ?? {};
		const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
		return {
			enabled: b.enabled === true,
			autoReply: b.autoReply === true,
			masterUid: String(b.masterUid ?? '').trim(),
			allowList: Array.isArray(b.allowList) ? b.allowList.map((x) => String(x).trim()).filter(Boolean) : [],
			replyMutual: b.replyMutual !== false,
			proactive: b.proactive === true,
			batchMs: num(b.batchMs, 3000),
			replyWindowMinutes: num(b.replyWindowMinutes, 10)
		};
	}

	douyinConfig() {
		const d = this.getConfig().douyin ?? {};
		const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
		return {
			enabled: d.enabled === true,
			autoReply: d.autoReply === true,
			masterName: String(d.masterName ?? '').trim(),
			allowList: Array.isArray(d.allowList) ? d.allowList.map((x) => String(x).trim()).filter(Boolean) : [],
			replyAll: d.replyAll === true,
			batchMs: num(d.batchMs, 3000),
			replyWindowMinutes: num(d.replyWindowMinutes, 10)
		};
	}

	/** 设置页"抖音名字 = QQ 号"对应表（名字里可能有等号，按最后一个切）。 */
	douyinLinks() {
		const out = new Map();
		for (const line of Array.isArray(this.getConfig().douyin?.links) ? this.getConfig().douyin.links : []) {
			const m = String(line).match(/^\s*(.+?)\s*[=＝]\s*(\d{5,12})\s*$/);
			if (m) out.set(m[1], m[2]);
		}
		return out;
	}

	/** 设置页"B站 UID = QQ 号"对应表。 */
	biliLinks() {
		const out = new Map();
		for (const line of Array.isArray(this.getConfig().bili?.links) ? this.getConfig().bili.links : []) {
			const m = String(line).match(/^\s*(\d{1,20})\s*[=:：]\s*(\d{5,12})\s*$/);
			if (m) out.set(m[1], m[2]);
		}
		return out;
	}

	stop() {
		this.stopped = true;
		for (const b of this.batches.values()) clearTimeout(b.timer);
		this.batches.clear();
		for (const w of this.waiters.values()) { clearTimeout(w.timer); w.resolve(false); }
		this.waiters.clear();
	}

	isOurSession(sessionId) {
		return sessionId !== undefined && sessionId !== null && this.bound.has(String(sessionId));
	}

	/** 会话 id → 聊天信息（插件重启后 index.js 用它重建"当前说话人"）。 */
	chatForSession(sessionId) {
		const row = this.bound.get(String(sessionId)) ?? findChatSessionBySessionId(this.db, sessionId);
		return row === null || row === undefined ? null : row;
	}

	// ───────────────────────── 工作区 ─────────────────────────

	workspacePath() {
		const configured = String(this.getConfig().sessions?.workspacePath ?? '').trim();
		return configured !== '' ? resolve(configured) : dedicatedWorkspacePath();
	}

	registry() {
		return service(this.ctx, 'workspaceRegistry');
	}

	listWorkspaces() {
		try {
			const reg = this.registry();
			const rows = typeof reg?.list === 'function' ? reg.list() : [];
			return (rows ?? []).map((w) => ({ path: w.path, title: w.title ?? '', sessionCount: w.sessionIds?.length ?? 0 }));
		} catch {
			return [];
		}
	}

	async ensureWorkspace(path = this.workspacePath()) {
		mkdirSync(path, { recursive: true });
		mkdirSync(join(path, '_stickers'), { recursive: true });
		const reg = this.registry();
		if (reg === null || typeof reg.create !== 'function') return { path, attachSession: async () => {} };
		const title = resolve(path) === resolve(dedicatedWorkspacePath()) ? '鱼' : undefined;
		return await reg.create(path, title);
	}

	/** 工作区 _stickers/ 下的表情包文件名（给模型看的清单）。 */
	listStickers(workspacePath) {
		try {
			const dir = join(workspacePath, '_stickers');
			if (!existsSync(dir)) return [];
			return readdirSync(dir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).slice(0, 40);
		} catch {
			return [];
		}
	}

	// ───────────────────────── 会话 ─────────────────────────

	agentsService() {
		return service(this.ctx, 'agents');
	}

	modelSelection() {
		try {
			const dm = service(this.ctx, 'agentDefaultModel');
			const sel = dm?.currentSelection?.();
			if (sel && sel.provider && sel.model) return { ...sel };
		} catch { /* 往下兜底 */ }
		try {
			const llm = service(this.ctx, 'llm');
			const first = (llm?.listProviders?.() ?? [])[0];
			const model = first?.models?.[0]?.id ?? first?.models?.[0];
			if (first !== undefined && typeof model === 'string') return { provider: first.id ?? first.name, model };
		} catch { /* 让宿主用默认 */ }
		return undefined;
	}

	allowedTools() {
		const tools = this.ctx.tools;
		return QQ_SESSION_TOOLS.filter((n) => {
			try { return typeof tools?.get !== 'function' || tools.get(n) !== undefined; } catch { return false; }
		});
	}

	/** 新建/恢复会话时的 setup：挂默认预设，然后把全局工具收窄到记忆工具（失败就整个建会话失败，宁可不回也不放开 shell）。 */
	async setupAgent(agentCtx) {
		const presets = service(this.ctx, 'agentPresets');
		if (presets && typeof presets.mount === 'function') {
			try { await presets.mount(agentCtx); } catch (error) {
				this.log('warn', `[fish-soul] 挂默认预设失败（按无预设继续）：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		const allow = this.allowedTools();
		if (typeof agentCtx?.tools?.restrict === 'function' && allow.length > 0) {
			agentCtx.tools.restrict({ allow });
		}
	}

	async defaultPresetId() {
		try {
			const presets = service(this.ctx, 'agentPresets');
			if (!presets || typeof presets.resolve !== 'function') return undefined;
			const p = await presets.resolve();
			return p?.broken ? undefined : p?.id;
		} catch {
			return undefined;
		}
	}

	/** 拿到某个聊天对应的活会话（没有就恢复或新建）。 */
	async ensureSession(chat) {
		const key = chat.channelId;
		if (this.inflight.has(key)) return this.inflight.get(key);
		const p = (async () => {
			const agents = this.agentsService();
			if (agents === null) throw new Error('宿主没有 agents 服务');
			const row = findChatSession(this.db, platformOf(key), key);
			if (row !== null) {
				this.bound.set(row.session_id, row);
				const live = agents.get?.(row.session_id);
				if (live !== undefined && live !== null) return live;
				try {
					const handle = await agents.resume({
						resumeSessionId: row.session_id,
						setup: (agentCtx) => this.setupAgent(agentCtx)
					});
					this.log('info', `[fish-soul] 已恢复会话 ${row.title || key}`);
					return handle.agent;
				} catch (error) {
					this.log('warn', `[fish-soul] 恢复会话 ${row.session_id} 失败，改为新建：${String(error instanceof Error ? error.message : error)}`);
					this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
					this.bound.delete(row.session_id);
				}
			}
			return await this.createSession(chat);
		})();
		this.inflight.set(key, p);
		try {
			return await p;
		} finally {
			this.inflight.delete(key);
		}
	}

	async chatTitle(chat) {
		if (platformOf(chat.channelId) === 'douyin') {
			const name = chat.targetId;
			return `抖音·${sanitizeName(name, '抖音用户')}${name === this.douyinConfig().masterName ? '（主人）' : ''}`;
		}
		if (platformOf(chat.channelId) === 'bili') {
			const person = findPersonByBili(this.db, chat.targetId);
			const name = chat.title || (person?.bili_uid === chat.targetId && !person?.qq_uin ? person.display_name : '') || chat.targetId;
			return `B站·${sanitizeName(name, chat.targetId)}${chat.targetId === this.biliConfig().masterUid ? '（主人）' : ''}`;
		}
		if (chat.chatType === 'group') {
			const name = chat.title || await this.channel.groupName(chat.targetId).catch(() => '');
			return `QQ群·${sanitizeName(name || chat.targetId, chat.targetId)}`;
		}
		const person = findPersonByQq(this.db, chat.targetId);
		const name = chat.title || person?.display_name || chat.targetId;
		return `QQ·${sanitizeName(name, chat.targetId)}${chat.targetId === this.masterQq() ? '（主人）' : ''}`;
	}

	async createSession(chat, workspacePath = this.workspacePath()) {
		const agents = this.agentsService();
		const ws = await this.ensureWorkspace(workspacePath);
		const sessionId = `fish-soul-${randomUUID()}`;
		const presetId = await this.defaultPresetId();
		const agentOptions = this.modelSelection();
		const handle = await agents.create({
			sessionId,
			meta: { cwd: ws.path ?? workspacePath, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
			...(agentOptions !== undefined ? { agentOptions } : {}),
			setup: (agentCtx) => this.setupAgent(agentCtx)
		});
		const title = await this.chatTitle(chat);
		try { await ws.attachSession?.(sessionId); } catch (error) {
			this.log('warn', `[fish-soul] 会话挂到工作区失败：${String(error instanceof Error ? error.message : error)}`);
		}
		try {
			const titles = service(this.ctx, 'sessionTitle');
			titles?.rename?.(handle.agent.session ?? handle.agent, title);
		} catch { /* 标题不影响功能 */ }
		const row = insertChatSession(this.db, {
			channel: platformOf(chat.channelId), channelId: chat.channelId, sessionId, workspacePath: ws.path ?? workspacePath, title, nowMs: Date.now()
		});
		this.bound.set(sessionId, row);
		this.log('info', `[fish-soul] 已为 ${title} 新建会话 ${sessionId}`);
		return handle.agent;
	}

	/** "全部迁到新工作区"：每个聊天在当前选中的工作区里重建一个空会话（记忆在 soul.db，不受影响）。 */
	async migrateAll() {
		const target = this.workspacePath();
		const rows = this.allSessions().filter((r) => resolve(r.workspace_path) !== resolve(target));
		let migrated = 0;
		const failed = [];
		for (const row of rows) {
			const [kind, id] = splitChannelId(row.channel_id);
			try {
				await this.createSession({ channelId: row.channel_id, chatType: kind === 'group' ? 'group' : 'private', targetId: id, title: '' }, target);
				this.bound.delete(row.session_id);
				migrated++;
			} catch (error) {
				failed.push({ channelId: row.channel_id, error: String(error instanceof Error ? error.message : error) });
			}
		}
		return { migrated, failed, workspacePath: target };
	}

	// ───────────────────────── 入站 ─────────────────────────

	markSeen(key) {
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value);
		return true;
	}

	cursorOf(channelId) {
		return getKv(this.db, `qq.cursor.${channelId}`, null);
	}

	advanceCursor(channelId, timeMs, messageId) {
		const cur = this.cursorOf(channelId);
		if (cur !== null && Number(cur.timeMs) > timeMs) return;
		setKv(this.db, `qq.cursor.${channelId}`, { timeMs, messageId });
	}

	groupAllowed(groupId, cfg) {
		return cfg.groupAllowList.length === 0 || cfg.groupAllowList.includes(String(groupId));
	}

	/** OneBot 事件入口（实时推送和断线补拉共用）。 */
	async onEvent(event, { backfill = false } = {}) {
		if (this.stopped) return;
		const cfg = this.qqConfig();
		if (!cfg.enabled) return;
		if (event?.post_type === 'notice') { await this.onNotice(event, cfg); return; }
		const m = normalizeMessageEvent(event, { selfId: this.channel.selfId, ownMessageIds: this.ownMessages });
		if (m === null || m.userId === '' || m.userId === String(this.channel.selfId)) return;
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return;
		if (backfill) {
			const cur = this.cursorOf(m.channelId);
			if (cur !== null && (m.timeMs < Number(cur.timeMs) || (m.timeMs === Number(cur.timeMs) && m.messageId === cur.messageId))) return;
		}
		this.advanceCursor(m.channelId, m.timeMs, m.messageId);
		if (m.chatType === 'group' && !this.groupAllowed(m.groupId, cfg)) return;

		const person = this.soul.resolvePerson(m);
		await this.decide(m, person, cfg);
	}

	/** QQ 入站消息（真消息和戳一戳共用）：回 / 只记 / 不理 / 插话。 */
	async decide(m, person, cfg) {
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;
		const who = m.nickname || person?.display_name || m.userId;
		if (!stale && m.userId === this.masterQq() && await this.handleCommand(m)) return;
		const paused = this.isPaused(m.channelId);

		let decision;
		let reason = '';
		let interject = false;
		if (m.chatType === 'private') {
			const friend = m.subType === 'friend' || this.channel.isFriend(m.userId) || m.userId === this.masterQq();
			decision = friend ? 'reply' : 'memorize';
			if (!friend) reason = '不是好友';
		} else {
			const called = !m.mentioned && this.callNames(cfg).some((n) => m.text.includes(n));
			const gate = 该收这条({
				全听: false, 点名: m.mentioned || called, 接听: this.follow.get(m.channelId) ?? null,
				条: cfg.followUpCount, 秒: cfg.followUpSeconds, 现在: Date.now()
			});
			if (!stale && !paused) {
				if (gate.接听 === null) this.follow.delete(m.channelId);
				else this.follow.set(m.channelId, gate.接听);
			}
			if (gate.收) {
				decision = 'reply';
				reason = m.mentioned ? '点名' : called ? '叫了她的名字' : '接着听';
				if (called) m.mentioned = true;
			} else {
				decision = 'ignore';
				if (!stale && !paused) {
					const score = this.interjectChance(m, person, cfg);
					if (score > 0 && this.random() < score) {
						this.interjects.get(m.channelId)?.push(Date.now());
						decision = 'reply';
						interject = true;
						reason = `自己想插一句（${Math.round(score * 100)}%）`;
					}
				}
				if (!interject) this.pushBacklog(m);
			}
		}
		if (decision === 'reply' && stale) { decision = 'memorize'; reason = '超过回复时限的旧消息'; }
		if (decision === 'reply' && paused) { decision = 'memorize'; reason = '这个聊天暂停着'; }
		if (decision === 'ignore') return;
		if (decision === 'memorize') {
			this.soul.memorizeUnanswered(person, m);
			this.note(paused && reason === '这个聊天暂停着' ? 'paused' : 'memorize', { channelId: m.channelId, who, text: m.text, reason, title: m.chatType === 'private' ? `QQ·${sanitizeName(who, m.userId)}` : '' });
			return;
		}
		this.note(interject ? 'interject' : 'reply', { channelId: m.channelId, who, text: m.text, reason });
		this.enqueue(m, person, cfg, { interject });
	}

	/** 群里没点名的话攒起来（被叫到时一起给她看）；同时数一分钟内的条数（判断是不是在刷屏）。 */
	pushBacklog(m) {
		const list = (this.backlog.get(m.channelId) ?? []).filter((x) => Date.now() - x.timeMs < BACKLOG_MAX_AGE_MS);
		list.push({ name: sanitizeName(m.nickname || m.userId, m.userId), text: String(m.text ?? '').slice(0, 120), timeMs: m.timeMs, messageId: m.messageId });
		this.backlog.set(m.channelId, list.slice(-BACKLOG_LIMIT));
	}

	takeBacklog(channelId, exclude) {
		const list = (this.backlog.get(channelId) ?? []).filter((x) => Date.now() - x.timeMs < BACKLOG_MAX_AGE_MS && !exclude.has(x.messageId));
		this.backlog.delete(channelId);
		return list.slice(-10).map((x) => `${x.name}：${x.text}`);
	}

	/** 这条没点名的群消息，她插一句的概率（插话关着 / 睡觉 / 冷却中 / 到了每小时上限 → 0）。 */
	interjectChance(m, person, cfg) {
		const ij = cfg.interject;
		if (!ij.enabled) return 0;
		const availability = this.soul.availability?.() ?? null;
		if (availability !== null && availability !== 'idle') return 0;
		const now = Date.now();
		const last = this.lastSpoke.get(m.channelId) ?? 0;
		if (now - last < ij.cooldownMinutes * 60_000) return 0;
		const times = (this.interjects.get(m.channelId) ?? []).filter((t) => now - t < 3600_000);
		this.interjects.set(m.channelId, times);
		if (times.length >= ij.maxPerHour) return 0;
		const busyCount = (this.backlog.get(m.channelId) ?? []).filter((x) => now - x.timeMs < 60_000).length;
		const score = interjectScore({
			text: m.text, base: ij.chance, keywords: ij.keywords, relation: person?.relation_stage ?? 'stranger',
			isMaster: m.userId === this.masterQq(), busyCount
		});
		return score;
	}

	/** 主人发的 "/鱼 暂停 30分钟" / "/鱼 继续"：只对发命令的这个聊天生效，回一句确认（不经过模型）。 */
	async handleCommand(m) {
		const c = COMMAND_RE.exec(String(m.text ?? ''));
		if (c === null) return false;
		const resume = /继续|恢复|说话/.test(c[1]);
		let minutes = -1;
		if (!resume && c[2] !== undefined) minutes = Number(c[2]) * (/小时|h/i.test(c[3] ?? '') ? 60 : 1);
		this.setPaused(m.channelId, resume ? 0 : minutes);
		const text = resume ? '好，我回来了' : minutes > 0 ? `好，我先安静 ${c[2]}${/小时|h/i.test(c[3] ?? '') ? ' 小时' : ' 分钟'}` : '好，我先不说话了（发"/鱼 继续"叫我回来）';
		this.note('command', { channelId: m.channelId, who: m.nickname || '主人', text: m.text, reason: resume ? '恢复' : '暂停' });
		try { await this.channel.send(m.channelId, [{ type: 'text', data: { text } }]); } catch { /* 发不出去也算生效 */ }
		return true;
	}

	/** OneBot 通知：戳一戳（戳的是她）→ 当成一条点名消息；撤回 → 还没回复的那条就不回了。 */
	async onNotice(ev, cfg) {
		const selfId = String(this.channel.selfId ?? ev.self_id ?? '');
		const userId = String(ev.user_id ?? ev.sender_id ?? '');
		if (ev.notice_type === 'notify' && ev.sub_type === 'poke') {
			if (String(ev.target_id ?? '') !== selfId || userId === '' || userId === selfId) return;
			const groupId = ev.group_id !== undefined && ev.group_id !== null ? String(ev.group_id) : null;
			if (groupId !== null && !this.groupAllowed(groupId, cfg)) return;
			const channelId = groupId !== null ? `group:${groupId}` : `private:${userId}`;
			const key = `${channelId}#${userId}`;
			if (Date.now() - (this.pokeAt.get(key) ?? 0) < POKE_GAP_MS) return;
			this.pokeAt.set(key, Date.now());
			const known = findPersonByQq(this.db, userId);
			let nickname = known?.display_name ?? '';
			const m = {
				channel: 'qq', chatType: groupId !== null ? 'group' : 'private', channelId, targetId: groupId ?? userId, groupId,
				userId, nickname, subType: this.channel.isFriend(userId) ? 'friend' : '', messageId: `poke-${userId}-${Number(ev.time) || Date.now()}`,
				mentioned: true, replyId: null, text: '【戳了戳你】', images: [], links: [],
				timeMs: Number(ev.time) > 0 ? Number(ev.time) * 1000 : Date.now()
			};
			const person = this.soul.resolvePerson(m);
			if (!nickname) m.nickname = person?.display_name ?? '';
			await this.decide(m, person, cfg);
			return;
		}
		if (ev.notice_type === 'group_recall' || ev.notice_type === 'friend_recall') {
			const channelId = ev.notice_type === 'group_recall' ? `group:${ev.group_id}` : `private:${userId}`;
			const messageId = String(ev.message_id ?? '');
			const backlog = this.backlog.get(channelId);
			if (backlog) this.backlog.set(channelId, backlog.filter((x) => x.messageId !== messageId));
			const batch = this.batches.get(channelId);
			if (!batch) return;
			const before = batch.items.length;
			batch.items = batch.items.filter(({ m }) => m.messageId !== messageId);
			if (batch.items.length === before) return;
			this.note('recalled', { channelId, who: userId, reason: '对方撤回了，这条不回了' });
			if (batch.items.length === 0) { clearTimeout(batch.timer); this.batches.delete(channelId); }
		}
	}

	/**
	 * B站私信入口（BiliChannel 轮询到的每条新消息）。
	 * 回：自动回复打开 + 对方是主人 / 白名单 / 互关 + 不是 10 分钟前的旧消息；其余只记不回。
	 */
	async onBiliMessage(m) {
		if (this.stopped || this.bili === null) return;
		const cfg = this.biliConfig();
		if (!cfg.enabled || m.userId === '' || m.userId === this.bili.client.uid) return;
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return;
		const person = this.soul.resolveBiliPerson(m, { masterUid: cfg.masterUid, linkedQq: this.biliLinks().get(m.userId) ?? '' });
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;
		const paused = this.isPaused(m.channelId);
		// 只读阶段 / 旧消息不查关注关系（省一次接口调用）
		const trusted = cfg.autoReply && !stale && !paused && (m.userId === cfg.masterUid || cfg.allowList.includes(m.userId) ||
			(cfg.replyMutual && await this.bili.isMutual(m.userId)));
		const who = m.nickname || person?.display_name || m.userId;
		if (!trusted) {
			this.soul.memorizeUnanswered(person, m);
			this.note(paused ? 'paused' : 'memorize', { channelId: m.channelId, who, text: m.text, title: `B站·${sanitizeName(who, m.userId)}`,
				reason: paused ? '这个聊天暂停着' : !cfg.autoReply ? '自动回复关着' : stale ? '超过回复时限的旧消息' : '不是主人 / 白名单 / 互关' });
			return;
		}
		this.note('reply', { channelId: m.channelId, who, text: m.text });
		this.enqueue(m, person, cfg);
	}

	/**
	 * 抖音私信入口（DouyinChannel 轮询到的每条新消息）。
	 * 回：自动回复打开 + 页面自检正常 + 对方是主人 / 白名单（或打开了"回所有能私信她的人"）+ 不是 10 分钟前的旧消息。
	 */
	async onDouyinMessage(m) {
		if (this.stopped || this.douyin === null) return;
		const cfg = this.douyinConfig();
		if (!cfg.enabled || m.userId === '') return;
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return;
		const person = this.soul.resolveDouyinPerson(m, { masterName: cfg.masterName, linkedQq: this.douyinLinks().get(m.userId) ?? '' });
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;
		const paused = this.isPaused(m.channelId);
		const trusted = cfg.autoReply && !stale && !paused && !this.douyin.replyPaused &&
			(m.userId === cfg.masterName || cfg.allowList.includes(m.userId) || cfg.replyAll);
		if (!trusted) {
			this.soul.memorizeUnanswered(person, m);
			this.note(paused ? 'paused' : 'memorize', { channelId: m.channelId, who: m.userId, text: m.text, title: `抖音·${sanitizeName(m.userId, '抖音用户')}`,
				reason: paused ? '这个聊天暂停着' : !cfg.autoReply ? '自动回复关着' : stale ? '超过回复时限的旧消息' : this.douyin.replyPaused ? '页面自检没过，先不回' : '不是主人 / 白名单' });
			return;
		}
		this.note('reply', { channelId: m.channelId, who: m.userId, text: m.text });
		this.enqueue(m, person, cfg);
	}

	/** 消息里的 B站 / 抖音视频 → 简短介绍（没开或取不到就什么都不加）。 */
	async videoNotes(items) {
		const text = items.map(({ m }) => [m.text, ...(m.links ?? [])].join(' ')).join(' ');
		const jobs = [];
		if (this.browser !== null && this.biliConfig().enabled) {
			const refs = findVideoRefs(text);
			if (refs.bvids.length > 0 || refs.shorts.length > 0) jobs.push(this.withTimeout(this.browser.describe(refs), 8000));
		}
		if (this.douyinBrowser !== null && this.douyinConfig().enabled) {
			const refs = findDouyinRefs(text);
			// 抖音得真的打开视频页（十几秒），最多等 30 秒
			if (refs.ids.length > 0 || refs.shorts.length > 0) jobs.push(this.withTimeout(this.douyinBrowser.describe(refs), 30_000));
		}
		if (jobs.length === 0) return [];
		return (await Promise.all(jobs)).flat();
	}

	async withTimeout(p, ms) {
		try {
			return await Promise.race([p, new Promise((r) => { const t = setTimeout(() => r([]), ms); t.unref?.(); })]);
		} catch {
			return [];
		}
	}

	enqueue(m, person, cfg, { interject = false } = {}) {
		let batch = this.batches.get(m.channelId);
		if (batch === undefined) {
			batch = { items: [], timer: null };
			this.batches.set(m.channelId, batch);
		}
		batch.items.push({ m, person, interject });
		if (batch.timer !== null) clearTimeout(batch.timer);
		const flush = () => {
			this.batches.delete(m.channelId);
			void this.dispatch(m.channelId, batch.items).catch((error) => {
				this.log('error', `[fish-soul] 转入会话失败（${m.channelId}）：${String(error instanceof Error ? error.message : error)}`);
			});
		};
		if (batch.items.length >= 20 || cfg.batchMs <= 0) { flush(); return; }
		batch.timer = setTimeout(flush, cfg.batchMs);
		batch.timer.unref?.();
	}

	async quoteLine(replyId) {
		if (!replyId) return '';
		const own = this.ownMessages.get(replyId);
		if (own !== undefined) return `【引用 我自己：${own.slice(0, 40)}】`;
		const msg = await this.channel.getMessage(replyId);
		if (!msg) return '【引用了一条消息】';
		const n = normalizeMessageEvent({ post_type: 'message', message_type: msg.message_type ?? 'group', ...msg }, { selfId: this.channel.selfId });
		const who = sanitizeName(n?.nickname || msg.sender?.nickname || '', '某人');
		return `【引用 ${who}：${(n?.text ?? '').slice(0, 40)}】`;
	}

	async admitImages(text, items) {
		const imgs = [];
		for (const { m } of items) for (const img of m.images) if (imgs.length < MAX_INBOUND_IMAGES) imgs.push({ img, m });
		const base = [{ type: 'text', text }];
		if (imgs.length === 0) return base;
		const attachments = service(this.ctx, 'attachments');
		if (!attachments || typeof attachments.admitPromptContent !== 'function') return base;
		const parts = [...base];
		for (const [i, { img, m }] of imgs.entries()) {
			const bytes = await fetchImageBytes(img);
			if (bytes === null) continue;
			const mediaType = mediaTypeOf(bytes);
			parts.push({ type: 'image', data: bytes.toString('base64'), mediaType, name: `qq-${m.messageId || 'x'}-${i + 1}.${mediaType.split('/')[1]}` });
		}
		if (parts.length === 1) return base;
		try {
			return await attachments.admitPromptContent(parts);
		} catch (error) {
			this.log('warn', `[fish-soul] 图片交给 DSH 失败（这轮只转文字）：${String(error instanceof Error ? error.message : error)}`);
			return base;
		}
	}

	async dispatch(channelId, items) {
		if (this.stopped || items.length === 0) return;
		const first = items[0].m;
		const platform = platformOf(channelId);
		const isBili = platform === 'bili';
		const chat = { channelId, chatType: first.chatType, targetId: first.targetId, title: first.chatType === 'private' ? first.nickname : '' };
		const agent = await this.ensureSession(chat);

		// 说话人：按人合并本批文字，保留"最后开口"的顺序
		const byUser = new Map();
		for (const { m, person } of items) {
			const prev = byUser.get(m.userId);
			byUser.delete(m.userId);
			byUser.set(m.userId, {
				person, userId: m.userId,
				displayName: sanitizeName(m.nickname || person?.display_name || m.userId, m.userId),
				text: [prev?.text, m.text].filter(Boolean).join('\n')
			});
		}
		const speakers = [...byUser.values()];
		// 只有插话（没有一条是点名 / 接着听的）才算"她自己想说"
		const interject = chat.chatType === 'group' && items.every((x) => x.interject === true);
		const backlog = chat.chatType === 'group' ? this.takeBacklog(channelId, new Set(items.map(({ m }) => m.messageId))) : [];
		if (interject) this.interjectTurns.add(agent.id); else this.interjectTurns.delete(agent.id);
		this.soul.beginTurn(agent.id, {
			channel: sessionChannelOf(channelId),
			channelId,
			speakers,
			backlog,
			interject,
			workspacePath: this.bound.get(agent.id)?.workspace_path ?? this.workspacePath()
		});

		const lines = [];
		for (const { m } of items) {
			const quote = platform === 'qq' ? await this.quoteLine(m.replyId) : '';
			const body = `${quote}${m.text || '（空消息）'}`;
			lines.push(chat.chatType === 'group' ? `${sanitizeName(m.nickname || m.userId, m.userId)}：${body}` : body);
		}
		lines.push(...await this.videoNotes(items));
		const content = await this.admitImages(lines.join('\n'), items);
		const last = items[items.length - 1].m;
		const mentionItem = [...items].reverse().find(({ m }) => m.mentioned)?.m ?? last;
		// 插话不引用（像自然接话）；戳一戳没有真的消息可引用
		if (chat.chatType === 'group' && !interject && !String(mentionItem.messageId).startsWith('poke-')) this.replyTo.set(agent.id, mentionItem.messageId);
		else this.replyTo.delete(agent.id);
		this.db.prepare('UPDATE chat_session SET last_inbound_at = ? WHERE session_id = ?').run(Date.now(), agent.id);

		await agent.followup({
			id: randomUUID(),
			role: 'user',
			content,
			source: {
				kind: isBili ? SOURCE_BILI : platform === 'douyin' ? SOURCE_DOUYIN : SOURCE_QQ,
				channelId,
				chatType: chat.chatType,
				...(chat.chatType === 'group' ? { groupId: chat.targetId } : {}),
				userId: last.userId,
				messageId: last.messageId,
				mentioned: items.some(({ m }) => m.mentioned),
				speakers: speakers.map((s) => ({ userId: s.userId, nickname: s.displayName })),
				batch: items.length
			}
		});
		if (isBili && this.bili !== null) void this.bili.ack(chat.targetId, last.messageId);
	}

	/** 断线重连 / 启动后：补拉每个已建会话的聊天最近 20 条，交给 onEvent 按 10 分钟规则处理。 */
	async backfill() {
		if (!this.qqConfig().enabled) return;
		for (const row of listChatSessions(this.db, 'qq')) {
			try {
				const list = await this.channel.fetchHistory(row.channel_id, 20);
				for (const ev of list) await this.onEvent(ev, { backfill: true });
			} catch (error) {
				this.log('warn', `[fish-soul] 补拉 ${row.channel_id} 历史失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
	}

	// ───────────────────────── 主动开口 ─────────────────────────

	/**
	 * 主动开口：往目标会话里递一条 fish-soul/proactive 触发消息，让会话里的模型带着上下文自己写，
	 * 等这一轮结束、真正发到 QQ 后才返回结果（LifeEngine 据此记配额 / 重试待办）。
	 */
	async triggerProactive(channelId, reason, { origin = 'idle' } = {}) {
		const [kind, id] = splitChannelId(channelId);
		// 抖音只回复、不主动（网页版主动发私信太像机器人）
		if (kind === 'douyin') return false;
		if (kind === 'bili') {
			// B站默认只回复不主动；设置页打开"主动发私信"后也只发给主人
			const b = this.biliConfig();
			if (!b.enabled || !b.proactive || this.bili === null || !this.bili.connected || id !== b.masterUid) return false;
		} else {
			if (!this.qqConfig().enabled || !this.channel.connected) return false;
			if (!id || (kind !== 'private' && kind !== 'group')) return false;
		}
		if (this.isPaused(channelId)) { this.note('paused', { channelId, reason: '这个聊天暂停着，不主动开口' }); return false; }
		const chat = { channelId, chatType: kind === 'group' ? 'group' : 'private', targetId: id, title: '' };
		const agent = await this.ensureSession(chat);
		const person = kind === 'private' ? findPersonByQq(this.db, id) : kind === 'bili' ? findPersonByBili(this.db, id) : null;
		this.soul.beginTurn(agent.id, {
			channel: kind === 'bili' ? 'bili-private' : kind === 'group' ? 'qq-group' : 'qq-private',
			channelId,
			speakers: person !== null ? [{ person, userId: id, displayName: person.display_name, text: reason }] : [],
			workspacePath: this.bound.get(agent.id)?.workspace_path ?? this.workspacePath()
		});
		this.replyTo.delete(agent.id);
		this.interjectTurns.delete(agent.id);
		this.note('proactive', { channelId, reason: sanitizeUserText(reason).slice(0, 60) });
		const msgId = randomUUID();
		const done = new Promise((resolveDone) => {
			const timer = setTimeout(() => { this.waiters.delete(msgId); resolveDone(false); }, PROACTIVE_TURN_TIMEOUT_MS);
			timer.unref?.();
			this.waiters.set(msgId, { resolve: resolveDone, timer });
		});
		try {
			await agent.followup({
				id: msgId,
				role: 'user',
				content: [{
					type: 'text',
					text: `【主动开口】${this.soul.nowLabel()}，你想主动找${kind === 'group' ? '群里的大家' : '对方'}说话。` +
						`理由：${sanitizeUserText(reason)}。直接写要发出去的那条消息，像平时聊天一样自然，` +
						'别提"系统""提醒任务""主动开口"这些字眼。'
				}],
				source: { kind: SOURCE_PROACTIVE, channelId, reason: String(reason), origin }
			});
		} catch (error) {
			const w = this.waiters.get(msgId);
			if (w !== undefined) { clearTimeout(w.timer); this.waiters.delete(msgId); }
			throw error;
		}
		return await done;
	}

	// ───────────────────────── 出站 ─────────────────────────

	turnState(sessionId) {
		let st = this.turns.get(sessionId);
		if (st === undefined) {
			st = { text: '', images: [], fromUs: false, messageIds: [] };
			this.turns.set(sessionId, st);
		}
		return st;
	}

	/** ctx.on('session/event') 回调。 */
	onSessionEvent(session, event) {
		const sessionId = String(session?.id ?? '');
		if (!this.bound.has(sessionId) || !event) return;
		const st = this.turnState(sessionId);
		const d = event.data ?? {};
		if (event.type === 'user/message') {
			const msg = d.message ?? d;
			const kind = String(msg?.source?.kind ?? '');
			st.fromUs = OUR_SOURCES.has(kind);
			if (msg?.id !== undefined) st.messageIds.push(String(msg.id));
			return;
		}
		if (event.type === 'assistant/message') {
			if (d.interrupted) { st.text = ''; st.images = []; return; }
			const text = 提取正文(d.message);
			const images = 提取图块(d.message);
			if (text !== '') { st.text = text; st.images = images; } else if (images.length > 0) st.images = st.images.concat(images).slice(0, 10);
			return;
		}
		if (event.type === 'turn/end') {
			this.turns.delete(sessionId);
			const completed = d.reason?.kind === 'completed';
			const waiterIds = st.messageIds.filter((id) => this.waiters.has(id));
			const settle = (ok) => {
				for (const id of waiterIds) {
					const w = this.waiters.get(id);
					if (w === undefined) continue;
					clearTimeout(w.timer);
					this.waiters.delete(id);
					w.resolve(ok);
				}
			};
			if (!completed || !st.fromUs) {
				if (st.fromUs) this.note('failed', { channelId: this.bound.get(sessionId)?.channel_id ?? '', reason: `这一轮没正常结束（${d.reason?.kind ?? '未知'}）` });
				this.interjectTurns.delete(sessionId);
				settle(false);
				return;
			}
			void this.sendReply(sessionId, st).then(settle, (error) => {
				this.log('error', `[fish-soul] 回复发出去失败：${String(error instanceof Error ? error.message : error)}`);
				settle(false);
			});
		}
	}

	resolveImageFile(p, workspacePath) {
		let raw = String(p ?? '').trim();
		if (raw === '') return null;
		if (/^https?:\/\//i.test(raw)) return { type: 'image', data: { file: raw } };
		try { if (raw.startsWith('file://')) raw = fileURLToPath(raw); } catch { return null; }
		const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspacePath, raw);
		// 只允许工作区和 fish-soul 数据目录里的图：模型写个 ![](~/.ssh/id_rsa) 不能把文件发出去
		if (!isInside(workspacePath, abs) && !isInside(fishSoulDir(), abs)) {
			this.log('warn', `[fish-soul] 拒绝发送工作区外的图片：${raw}`);
			return null;
		}
		if (!IMAGE_EXT.has(extname(abs).toLowerCase())) return null;
		try {
			if (!existsSync(abs) || statSync(abs).size > MAX_IMAGE_BYTES) return null;
			return { type: 'image', data: { file: `base64://${readFileSync(abs).toString('base64')}` } };
		} catch {
			return null;
		}
	}

	async attachmentSegment(block) {
		const attachments = service(this.ctx, 'attachments');
		try {
			if (typeof attachments?.readImage === 'function') {
				const stored = await attachments.readImage(block.attachment);
				const bytes = stored?.bytes ?? stored?.data;
				if (bytes) return { type: 'image', data: { file: `base64://${Buffer.from(bytes).toString('base64')}` } };
			}
			const p = attachments?.imageHostPath?.(block.attachment);
			if (p) return { type: 'image', data: { file: `base64://${readFileSync(p).toString('base64')}` } };
		} catch { /* 这张发不出去 */ }
		return null;
	}

	rememberOwn(messageId, text) {
		if (!messageId) return;
		this.ownMessages.set(String(messageId), text);
		if (this.ownMessages.size > OWN_LIMIT) this.ownMessages.delete(this.ownMessages.keys().next().value);
	}

	/** 私信（B站 / 抖音）的文字：按空行拆条（每条 ≤ 500 字），最多 5 条。 */
	dmParagraphs(text) {
		let paragraphs = String(text ?? '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 500));
		if (paragraphs.length > MAX_PARAGRAPHS) {
			paragraphs = [...paragraphs.slice(0, MAX_PARAGRAPHS - 1), paragraphs.slice(MAX_PARAGRAPHS - 1).join('\n').slice(0, 500)];
		}
		return paragraphs;
	}

	/** 本地图片路径（工作区 / 插件数据目录里的）；网址、越界的、不是图的返回 null。 */
	localImagePath(p, workspacePath) {
		let raw = String(p ?? '').trim();
		if (raw === '' || /^https?:\/\//i.test(raw)) return null;
		try { if (raw.startsWith('file://')) raw = fileURLToPath(raw); } catch { return null; }
		const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspacePath, raw);
		if (!isInside(workspacePath, abs) && !isInside(fishSoulDir(), abs)) {
			this.log('warn', `[fish-soul] 拒绝发送工作区外的图片：${raw}`);
			return null;
		}
		if (!IMAGE_EXT.has(extname(abs).toLowerCase())) return null;
		return abs;
	}

	/** 私信要发的图（表情包 / 模型生成的图）→ 能直接发的 {path, bytes, type, width, height}（webp 先转），最多 2 张。 */
	async dmImages(row, 图, st) {
		const files = [];
		for (const g of 图) {
			const p = this.localImagePath(g.value, row.workspace_path);
			if (p !== null) files.push(p);
		}
		const cacheDir = join(fishSoulDir(), 'img-cache');
		for (const block of st.images ?? []) {
			if (files.length >= MAX_DM_IMAGES) break;
			const bytes = await this.attachmentBytes(block);
			if (bytes === null) continue;
			try {
				mkdirSync(cacheDir, { recursive: true });
				const ext = mediaTypeOf(bytes).split('/')[1];
				const f = join(cacheDir, `att-${createHash('sha1').update(bytes).digest('hex').slice(0, 20)}.${ext}`);
				if (!existsSync(f)) writeFileSync(f, bytes);
				files.push(f);
			} catch { /* 这张发不出去 */ }
		}
		const out = [];
		for (const f of files.slice(0, MAX_DM_IMAGES)) {
			const img = await prepareImage(f, { cacheDir, canvasConvert: this.canvasConvert, log: this.log });
			if (img !== null) out.push(img);
			else this.log('warn', `[fish-soul] 这张图发不了（格式不支持或者太大）：${f}`);
		}
		return out;
	}

	async attachmentBytes(block) {
		const attachments = service(this.ctx, 'attachments');
		try {
			if (typeof attachments?.readImage === 'function') {
				const stored = await attachments.readImage(block.attachment);
				const bytes = stored?.bytes ?? stored?.data;
				if (bytes) return Buffer.from(bytes);
			}
			const p = attachments?.imageHostPath?.(block.attachment);
			if (p) return readFileSync(p);
		} catch { /* 这张发不出去 */ }
		return null;
	}

	/** B站私信：文字按空行拆条，图片（≤2 张）跟在最后。 */
	async sendBili(row, text, images = []) {
		if (this.bili === null) return false;
		const mid = row.channel_id.slice('bili:'.length);
		let allOk = true;
		const fail = (error) => {
			allOk = false;
			this.log('error', `[fish-soul] 发到 ${row.title || row.channel_id} 失败：${String(error instanceof Error ? error.message : error)}`);
		};
		for (const p of this.dmParagraphs(text)) {
			try { await this.bili.send(mid, p); } catch (error) { fail(error); }
		}
		for (const img of images) {
			try { await this.bili.sendImage(mid, img); } catch (error) { fail(error); }
		}
		return allOk;
	}

	/** 抖音私信：文字按空行拆条；单独一段 [名字] 发成抖音自带表情；图片（≤2 张）跟在最后。 */
	async sendDouyin(row, text, images = []) {
		if (this.douyin === null) return false;
		const name = splitChannelId(row.channel_id)[1];
		const parts = this.dmParagraphs(text).map((p) => {
			const e = p.match(DOUYIN_EMOJI_RE);
			return e ? { type: 'emoji', name: e[1] } : { type: 'text', text: p };
		});
		for (const img of images) parts.push({ type: 'image', path: img.path });
		if (parts.length === 0) return true;
		try {
			return await this.douyin.send(name, parts);
		} catch (error) {
			this.log('error', `[fish-soul] 发到 ${row.title || row.channel_id} 失败：${String(error instanceof Error ? error.message : error)}`);
			return false;
		}
	}

	/** 把一轮的最终回复发回 QQ：按空行拆成几条连发，图片跟在最后。 */
	async sendReply(sessionId, st) {
		const row = this.bound.get(sessionId);
		if (row === undefined) return false;
		const raw = String(st.text ?? '').trim();
		const interject = this.interjectTurns.delete(sessionId);
		const memories = this.soul.recallInfo?.(sessionId) ?? [];
		if (SILENT_RE.test(raw)) {
			this.note('silent', { channelId: row.channel_id, title: row.title, reason: interject ? '想了想，没插话' : '她选择不回', memories });
			return true;
		}
		const { 净文字, 图 } = 抠正文图(raw.replace(/\s*\[(不回|沉默)\]\s*$/g, ''));
		const platform = platformOf(row.channel_id);
		if (platform === 'bili' || platform === 'douyin') {
			const images = await this.dmImages(row, 图, st);
			const ok = platform === 'bili' ? await this.sendBili(row, 净文字, images) : await this.sendDouyin(row, 净文字, images);
			this.note(ok ? 'sent' : 'failed', { channelId: row.channel_id, title: row.title, text: 净文字 || '[图片]', reason: ok ? '' : '发送失败', memories });
			return ok;
		}
		const workspacePath = row.workspace_path;
		const images = [];
		for (const g of 图) {
			const seg = this.resolveImageFile(g.value, workspacePath);
			if (seg !== null) images.push(seg);
		}
		for (const block of st.images ?? []) {
			const seg = await this.attachmentSegment(block);
			if (seg !== null) images.push(seg);
		}
		let paragraphs = 净文字.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
		if (paragraphs.length > MAX_PARAGRAPHS) {
			paragraphs = [...paragraphs.slice(0, MAX_PARAGRAPHS - 1), paragraphs.slice(MAX_PARAGRAPHS - 1).join('\n\n')];
		}
		if (paragraphs.length === 0 && images.length === 0) return true;
		const isGroup = row.channel_id.startsWith('group:');
		const replyTo = isGroup ? this.replyTo.get(sessionId) : undefined;
		this.replyTo.delete(sessionId);
		const messages = paragraphs.map((p) => (isGroup ? 拆成消息段(p) : [{ type: 'text', data: { text: p } }]));
		if (images.length > 0) {
			if (messages.length > 0) messages[messages.length - 1].push(...images);
			else messages.push(images);
		}
		if (replyTo) messages[0].unshift({ type: 'reply', data: { id: String(replyTo) } });
		let allOk = true;
		for (const [i, segs] of messages.entries()) {
			if (i > 0) await new Promise((r) => setTimeout(r, typingDelayMs(paragraphs[i] ?? '', this.random)));
			try {
				const id = await this.channel.send(row.channel_id, segs);
				this.rememberOwn(id, paragraphs[i] ?? '[图片]');
			} catch (error) {
				allOk = false;
				this.log('error', `[fish-soul] 发到 ${row.title || row.channel_id} 失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		if (isGroup) {
			this.lastSpoke.set(row.channel_id, Date.now());
			// 插完话有人接：接着听几条（和被点名一样）
			const cfg = this.qqConfig();
			if (interject && cfg.followUpCount > 0 && !this.follow.has(row.channel_id)) {
				this.follow.set(row.channel_id, { 剩: cfg.followUpCount, 到: Date.now() + cfg.followUpSeconds * 1000 });
			}
		}
		this.note(allOk ? 'sent' : 'failed', { channelId: row.channel_id, title: row.title, text: paragraphs.join(' / ') || '[图片]', reason: allOk ? (interject ? '插了一句' : '') : '有消息没发出去', memories });
		return allOk;
	}
}

/** 设置里的 qq.interject → 规整后的插话参数（默认关）。 */
export function interjectConfig(raw) {
	const v = raw ?? {};
	const num = (x, d, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
	return {
		enabled: v.enabled === true,
		chance: num(v.chance, 0.05, 0, 1),
		cooldownMinutes: num(v.cooldownMinutes, 15, 0, 1440),
		maxPerHour: Math.floor(num(v.maxPerHour, 3, 0, 30)),
		keywords: Array.isArray(v.keywords) ? v.keywords.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : []
	};
}
