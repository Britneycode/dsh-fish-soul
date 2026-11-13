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
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
	fishSoulDir, findChatSession, findChatSessionBySessionId, insertChatSession, listChatSessions,
	findPersonByQq, findPersonByBili, findPersonByDouyin, getKv, setKv
} from './db.js';
import { normalizeMessageEvent, sanitizeName, sanitizeUserText } from './channels/onebot.js';
import { applyAttachments, attachmentConfig } from './attachments.js';
import { parseCollect } from './stickers.js';
import { UNHEARD } from './voice.js';
import { typingDelayMs, interjectScore, interjectConfig, platformOf, splitChannelId, sessionChannelOf, isGroupChannelId, service, parseClosing } from './gateway-util.js';
import { mediaMethods } from './gateway-media.js';
import { Outbox, classifySendError } from './outbox.js';
import { safeDownload } from './safe-download.js';
import { behaviorMethods } from './gateway-behavior.js';
import { findRepeatedParagraphs, normSentText } from './behavior.js';
import { 该收这条, 提取正文, 提取图块, 拆成消息段, 抠正文图 } from './channels/vendor/qq-bridge.js';

export { typingDelayMs, interjectScore, interjectConfig, platformOf, splitChannelId, sessionChannelOf };
export const SOURCE_QQ = 'fish-soul/qq';
export const SOURCE_PROACTIVE = 'fish-soul/proactive';
export const SOURCE_BILI = 'fish-soul/bili';
export const SOURCE_DOUYIN = 'fish-soul/douyin';
const OUR_SOURCES = new Set([SOURCE_QQ, SOURCE_PROACTIVE, SOURCE_BILI, SOURCE_DOUYIN]);

/** QQ 会话里模型能用的全部工具（宿主 PTC 传输 run_code 不算工具本身，单独放行）。 */
export const QQ_SESSION_TOOLS = ['remember', 'recall', 'forget'];
/** 跨平台转达：主人在 QQ 私聊里让她去抖音 / B站 私信自己一条。 */
export const RELAY_TOOL = 'send_elsewhere';
/** 聊天会话里放行的插件工具（记忆 + 跨平台转达）。 */
export const CHAT_TOOLS = [...QQ_SESSION_TOOLS, RELAY_TOOL];
/** 宿主的联网工具：设置里打开「让她能上网查」才放行（护栏按天限次数）。 */
export const WEB_TOOLS = ['web_search', 'web_fetch'];
/** 自己填 key 的搜索服务（插件注册的工具） */
export const OWN_WEB_TOOL = 'fish_search';
/** 回复里想用语音说的那段：单独一段、以 [语音] 开头。 */
const VOICE_RE = /^\s*\[语音\]\s*/;
const SILENT_RE = /^\s*\[(不回|沉默|skip)\]/i; // 开头就是 [不回]：这轮不发（后面跟的解释也不发）
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** 发图清单最多给模型多少张。 */
const IMAGE_LIST_LIMIT = 64;
const MAX_PARAGRAPHS = 5;
const SEEN_LIMIT = 4000;
const OWN_LIMIT = 500;
/** 戳一戳的冷却表上限（无界 Map 会随「不同人 × 不同群」长期累积）。 */
const POKE_LIMIT = 500;
const PROACTIVE_TURN_TIMEOUT_MS = 5 * 60_000;
/** 群里没点名的话最多攒多少条 / 多久以内的（被叫到时给她看"刚才在聊什么"） */
const BACKLOG_LIMIT = 12;
const BACKLOG_MAX_AGE_MS = 15 * 60_000;
const DECISION_LIMIT = 300;
const POKE_GAP_MS = 60_000;
const PAUSE_KEY = 'chat.paused';
/** 主人在 QQ 里发的控制命令：/鱼 暂停 [30分钟|2小时]、/鱼 继续、/鱼 同意、/鱼 拒绝 */
const COMMAND_RE = /^\s*[\/／]鱼\s*(暂停|安静|闭嘴|继续|恢复|说话|同意|通过|允许|拒绝|不准)\s*(?:(\d{1,4})\s*(分钟|分|小时|h|m)?)?\s*$/i;

export function dedicatedWorkspacePath() {
	return join(fishSoulDir(), 'workspace');
}

/** 文件修改时间（拿不到就当最旧，排序时沉底）。 */
function fileMtime(p) {
	try { return statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * 扫工作区根目录 + 一级子目录里的图片：隐藏目录不看，_stickers 归表情包管不重复收。
 * 返回 [{ rel, mtimeMs }]，rel 是相对工作区根的路径（模型照着写就能发出去）。
 */
function scanWorkspaceImages(workspacePath) {
	const out = [];
	const walk = (dir, prefix, depth) => {
		let entries = [];
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const name = e.name;
			if (name.startsWith('.')) continue;
			const full = join(dir, name);
			if (e.isDirectory()) {
				if (depth <= 0) continue;
				if (prefix === '' && name === '_stickers') continue;
				walk(full, `${prefix}${name}/`, depth - 1);
				continue;
			}
			if (!e.isFile()) continue;
			if (!IMAGE_EXT.has(extname(name).toLowerCase())) continue;
			// 文件名带空格/括号发不出去（markdown ![](...) 解析不了），不进清单
			if (/[\s()#]/.test(name)) continue;
			out.push({ rel: `${prefix}${name}`, mtimeMs: fileMtime(full) });
		}
	};
	walk(workspacePath, '', 1);
	return out;
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
	 * @param {(agentCtx: object) => void} [deps.agentSections] 给单个 agent 挂人格卡 / 瞬态块（index.js 传入 registerAgentSections）
	 */
	constructor({ ctx, db, clock, getConfig, log, channel, bili = null, browser = null, douyin = null, douyinBrowser = null, canvasConvert = null, soul, voice = null, stickers = null, slang = null, agentSections = null, groupAdmin = null, embedder = null, embeddingCfg = null, diag = null }) {
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
		/** v0.11.1：QQ 没发出去的回复排队重发（落在 soul.db，重启也不丢） */
		this.outbox = new Outbox({
			db, channel, log: this.log,
			windowMs: () => (Number(this.qqConfig().replyWindowMinutes) || 10) * 60_000,
			onSent: (id, item) => {
				this.rememberOwn(id, item.text);
				this.note('sent', { channelId: item.channel_id, title: item.title, text: item.text || '[图片]', reason: `重发成功（第 ${item.attempts + 1} 次）` });
			},
			onGiveUp: (item, reason) => {
				this.note('failed', { channelId: item.channel_id, title: item.title, text: item.text || '[图片]', reason });
				this.log('warn', `[fish-soul] 放弃重发到 ${item.title || item.channel_id}：${reason}`);
			}
		});
		if (this.outbox.size() > 0) this.outbox.schedule(3000);
		/** v0.7：语音（听 / 说）、收藏表情包、学群里的说法（都可以没有） */
		this.voice = voice;
		this.stickers = stickers;
		// 按感觉挑表情用的嵌入模型（和记忆同一套）；没有就整条路自动降级成按文件名
		this.embedder = embedder;
		this.embeddingCfg = embeddingCfg;
		this.slang = slang;
		/** 群管理（入群申请）：主人回"/鱼 同意/拒绝"时用它（可能没有） */
		this.groupAdmin = groupAdmin;
		/** 给单个 agent 挂人格卡 / 瞬态块：`(agentCtx) => void`（在 setup 里调，只对那个 agent 生效） */
		this.agentSections = agentSections;
		this.diag = diag;
		/** sessionId → chat_session 行（只存我们建的会话） */
		this.bound = new Map();
		/** channelId → Promise<Agent>（同一聊天并发来消息时只建一个会话） */
		this.inflight = new Map();
		/** channelId → {items, timer} */
		this.batches = new Map();
		/** channelId → {剩, 到}（群里点名后的接着听） */
		this.follow = new Map();
		/** sessionId → 本轮出站状态（replyTo 也在这里面，跟着轮次走） */
		this.turns = new Map();
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
		/** #59 主人最近一次跟她说话的时间（主人在聊时不在群里抢话） */
		this.masterActiveAt = 0;
		/** #59 channelId → 收尾冷却到什么时候（她说过"这轮聊完了"，软唤醒压到四分之一） */
		this.closedUntil = new Map();
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
			allGroups: q.allGroups === true,
			followUpCount: Number.isFinite(Number(q.followUpCount)) ? Number(q.followUpCount) : 3,
			followUpSeconds: Number.isFinite(Number(q.followUpSeconds)) ? Number(q.followUpSeconds) : 120,
			followUpSmart: q.followUpSmart === true, // #59 她说"这轮聊完了"就不接着听（默认关）
			batchMs: Number.isFinite(Number(q.batchMs)) ? Number(q.batchMs) : 3000,
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
		const map = getKv(this.db, PAUSE_KEY, {}) ?? {};
		const out = {};
		const now = Date.now();
		let dirty = false;
		for (const [id, until] of Object.entries(map)) {
			if (Number(until) === 0 || Number(until) > now) { out[id] = until; continue; }
			delete map[id]; dirty = true;
		}
		if (dirty) setKv(this.db, PAUSE_KEY, map);
		return out;
	}

	titleOf(channelId, fallback = '') {
		const row = findChatSession(this.db, platformOf(channelId), channelId);
		return row?.title || fallback || channelId;
	}

	/** 记一条"动态"：kind = reply / memorize / interject / sent / silent / failed / paused / recalled / command … */
	note(kind, { channelId = '', who = '', text = '', reason = '', title = '', memories, recallAt = 0, speakerUnknown = false, recallMiss = '' } = {}) {
		this.decisions.unshift({
			at: Date.now(), kind, channelId, title: title || this.titleOf(channelId),
			who: String(who ?? '').slice(0, 24), text: String(text ?? '').replace(/\s+/g, ' ').slice(0, 80), reason,
			// #78：以前写死 5 条，用户把「召回条数」调到 10 后动态页永远只显示 5 条，
			// 看起来像「设置没生效」。上限跟 topK 走（再留个 20 的硬顶，别让一条动态撑爆）。
			...(Array.isArray(memories) && memories.length > 0 ? { memories: memories.slice(0, Math.min(20, Math.max(5, Number(this.getConfig?.()?.retrieval?.topK) || 5))) } : {}),
			// #78：这一轮记忆到底有没有参与。没跑 / 认不出人 / 跑了没召回到，界面要分得开 ——
			// 以前三种都是"什么都不显示"，看不出问题在哪儿
			...(Number(recallAt) > 0 ? { recallAt: Number(recallAt), speakerUnknown: speakerUnknown === true } : {}),
			// 没跑时带上原因（notMounted = 瞬态块压根没挂上；noSession = 挂了但找不到会话登记）
			...(Number(recallAt) > 0 || recallMiss === '' ? {} : { recallMiss: String(recallMiss) })
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
			// 主人身份：只认会话身份（`douyin:<uid>`）。昵称 `masterName` 只用于显示，
			// 不再授予任何权限 —— 同名可冒充，改名又会对不上。
			masterUid: String(d.masterUid ?? '').trim(),
			// 原生视频卡片分享（默认关）：走页面里的「分享给朋友」面板，不下载、不发链接
			shareCard: d.shareCard === true,
			allowList: Array.isArray(d.allowList) ? d.allowList.map((x) => String(x).trim()).filter(Boolean) : [],
			replyAll: d.replyAll === true,
			groups: Array.isArray(d.groups) ? d.groups.map((x) => String(x).trim()).filter(Boolean) : [],
			groupReply: d.groupReply === true,
			callNames: Array.isArray(d.callNames) ? d.callNames.map((x) => String(x).trim()).filter(Boolean) : [],
			batchMs: num(d.batchMs, 3000),
			replyWindowMinutes: num(d.replyWindowMinutes, 10)
		};
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

	/**
	 * 这个聊天背后是同一个人吗（#78 第 2 步）：能算出 QQ 号就返回 `user:<QQ号>`，算不出返回 ''。
	 * 只有私聊算 —— 群跟群、群跟私聊之间一律不共享。
	 */
	personKeyOf(chat) {
		if (chat?.chatType === 'group' || isGroupChannelId(chat?.channelId)) return '';
		const [kind, id] = splitChannelId(chat?.channelId);
		let uin = '';
		if (kind === 'private') uin = id;
		// B站主人 UID 可按现有配置关联主人 QQ。
		else if (kind === 'bili') uin = this.biliLinks().get(id) ?? (id === this.biliConfig().masterUid ? this.masterQq() : '');
		// 抖音：只有能明确对上主人时才并会话（见 douyinUinOf）。
		else if (kind === 'douyin') uin = this.douyinUinOf(chat);
		uin = String(uin).trim();
		// 身份可以查询记忆里挂着的既有 QQ 关联。
		if (!/^\d{5,12}$/.test(uin)) uin = this.linkedQqOf(chat);
		return /^\d{5,12}$/.test(uin) ? `user:${uin}` : '';
	}

	/**
	 * 抖音会话对应的 QQ 号：只认两处显式配置——`douyin.masterUid`（可带 `douyin:` 前缀）
	 * 和设置页的「昵称 = QQ 号」对应表。昵称相近、记忆里查到的关联都不算（抖音昵称可改，没验过）。
	 * 算不出返回 ''（不共享会话）。
	 */
	douyinUinOf(chat) {
		const [kind, id] = splitChannelId(chat?.channelId);
		if (kind !== 'douyin') return '';
		const cfg = this.douyinConfig();
		const raw = this.getConfig().douyin ?? {};
		const links = Array.isArray(raw.links) ? raw.links : [];
		const norm = (v) => String(v ?? '').trim().replace(/^uid:/, '').replace(/^douyin:/, '');
		const keys = [norm(chat?.userId), norm(id)].filter((k) => k !== '');
		const master = norm(cfg.masterUid);
		if (master !== '' && keys.includes(master)) return this.masterQq();
		for (const line of links) {
			const m = String(line).match(/^\s*(.+?)\s*[=:：]\s*(\d{5,12})\s*$/);
			if (m && keys.includes(norm(m[1]))) return m[2];
		}
		return '';
	}

	/** 记忆里这个人挂着的 QQ 号（认人用的是真实 ID，改昵称也不丢）；没有就返回 ''。 */
	linkedQqOf(chat) {
		const [kind, id] = splitChannelId(chat?.channelId);
		const keys = [String(chat?.userId ?? ''), id].filter((k) => k !== '');
		try {
			for (const key of keys) {
				const person = kind === 'bili' ? findPersonByBili(this.db, key)
					: null;
				const uin = String(person?.qq_uin ?? '').trim();
				if (/^\d{5,12}$/.test(uin)) return uin;
			}
		} catch { /* 查不到就当没关联 */ }
		return '';
	}

	/**
	 * 这个聊天的会话由谁开（#78 第 2 步）：B站 / 抖音 私聊并进同一个人的 QQ 私聊会话，
	 * 这样两边说的话在同一个会话里（她自然记得刚才在别处聊过什么），标题 / 模型 / 暂停也统一跟 QQ 走。
	 * 并的条件是「能算出 QQ 号」+「QQ 开着」：QQ 关着就还是各平台各聊各的。
	 */
	sessionOwnerChat(chat) {
		if (chat?.chatType === 'group' || isGroupChannelId(chat?.channelId)) return chat;
		if (platformOf(chat?.channelId) === 'qq') return chat;
		const personKey = this.personKeyOf(chat);
		if (personKey === '' || !this.qqConfig().enabled) return chat;
		const uin = personKey.slice('user:'.length);
		return { channelId: `private:${uin}`, chatType: 'private', targetId: uin, title: '' };
	}

	/** 会话的主通道（共享会话就是 QQ 那个）：模型 / 标题 / 暂停都按它算。 */
	ownerChannelOf(agent) {
		return this.chatForSession(agent?.id)?.channel_id ?? '';
	}

	/**
	 * 回复发到哪（#78 第 3 步，设置页「会话 · 回复发到哪」）：
	 *  - 'source'（默认）：这一轮从哪个通道进来就回哪，B站 问的就在 B站 答；
	 *  - 'qq'：一律回会话的主通道（共享会话里就是 QQ），B站 / 抖音 只当"听到的地方"。
	 * 没有共享会话的聊天两种设置都一样（主通道就是它自己）。
	 */
	replyTarget() {
		return String(this.getConfig().sessions?.replyTarget ?? 'source') === 'qq' ? 'qq' : 'source';
	}

	/** 这一轮的回复该发到哪个通道（提示词里的回复规则也按它给，见 index.js）。 */
	replyChannelFor(agent, channelId) {
		if (this.replyTarget() !== 'qq') return channelId;
		return this.ownerChannelOf(agent) || channelId;
	}

	stop() {
		this.stopped = true;
		this.outbox?.stop();
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
			const all = readdirSync(dir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));
			// 超过 40 张就随机抽 40：固定取前 40 个会让后面加的表情永远进不了提示词
			if (all.length <= 40) return all;
			for (let i = 0; i < 40; i++) {
				const j = i + Math.floor(Math.random() * (all.length - i));
				const t = all[i]; all[i] = all[j]; all[j] = t;
			}
			return all.slice(0, 40);
		} catch {
			return [];
		}
	}

	/** 当前嵌入模型 id（换模型后老的向量就不算数了，得重打）。 */
	embeddingModel() {
		try {
			const cfg = typeof this.embeddingCfg === 'function' ? this.embeddingCfg() : this.embeddingCfg;
			return String(cfg?.model ?? '');
		} catch { return ''; }
	}

	/**
	 * 给模型看的表情清单：文件名带上标签，`兔子OK.gif（可以可以、认同）`。
	 * 没标签的照旧只给文件名 —— 老记录 / 主人手放的图都走这条降级路，不报错。
	 * @returns {Array<{file: string, tags: string[]}>}
	 */
	stickerManifest(workspacePath) {
		const files = new Set(this.listStickers(workspacePath));
		if (files.size === 0) return [];
		const tagged = new Map();
		try {
			for (const x of this.stickers?.list(workspacePath) ?? []) {
				if (x.tags.length > 0 && files.has(x.file)) tagged.set(x.file, x.tags);
			}
		} catch { /* 拿不到标签就当全没标签 */ }
		return [...files].map((file) => ({ file, tags: tagged.get(file) ?? [] }));
	}

	/**
	 * 发图清单（给模型看的）：_stickers/ 里的表情包 + （images.sendAny 打开时）工作区里任意图片。
	 * 都是相对工作区根的路径，模型照着写 ![说明](相对路径) 就能发出去。
	 */
	listImages(workspacePath) {
		const ws = String(workspacePath ?? '').trim();
		const stickers = this.listStickers(ws).map((f) => ({ rel: `_stickers/${f}`, mtimeMs: fileMtime(join(ws, '_stickers', f)) }));
		const sendAny = this.getConfig?.()?.images?.sendAny === true;
		if (!sendAny || ws === '') return stickers.map((x) => x.rel);
		let extra = [];
		try { extra = scanWorkspaceImages(ws); } catch { return stickers.map((x) => x.rel); }
		// 表情包保底收录：它们和新图赛 mtime 会被挤出去（老逻辑保证表情包一直在清单里）
		const keep = Math.min(stickers.length, IMAGE_LIST_LIMIT);
		const rest = [...extra].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, IMAGE_LIST_LIMIT - keep);
		return [...stickers.slice(0, keep), ...rest].map((x) => x.rel);
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

	/**
	 * 会话里放行哪些工具。插件自己的工具按全局表筛；DSH 的联网工具（web_search / web_fetch）是按会话挂的，
	 * 全局表里经常查不到（#26），不筛——真没有时模型调不到而已。agentCtx 有自己的工具表时也认它。
	 * #37：tools.sessionAllow = 'master' / 'all' 时放开宿主全部工具（restrict 都不调，让会话拿到默认组合）。
	 */
	allowedTools(agentCtx) {
		const has = (reg, n) => { try { return typeof reg?.get === 'function' && reg.get(n) !== undefined; } catch { return false; } };
		const tools = this.ctx.tools;
		return [...CHAT_TOOLS, ...WEB_TOOLS, OWN_WEB_TOOL].filter((n) =>
			WEB_TOOLS.includes(n) || typeof tools?.get !== 'function' || has(tools, n) || has(agentCtx?.tools, n));
	}

	/** #37 聊天会话的工具放行档位：memory（默认，只放记忆 + 联网）| master（主人私聊全放开）| all（所有会话全放开）。 */
	sessionAllowMode() {
		const v = String(this.getConfig().tools?.sessionAllow ?? 'memory').trim().toLowerCase();
		return v === 'master' || v === 'all' ? v : 'memory';
	}

	/** #37 这个 channel 是不是主人的私聊会话（QQ 主人号 / B站 masterUid / 抖音 masterName）。 */
	isMasterChannel(channelId) {
		const [kind, id] = splitChannelId(channelId);
		if (kind === 'group' || kind === 'douyin-group') return false;
		if (kind === 'bili') return id === String(this.biliConfig().masterUid ?? '');
		if (kind === 'douyin') return false; // 昵称不是授权身份
		return id === this.masterQq();
	}

	/** #37 当前放行档位下，这个聊天建/恢复的会话要不要放开宿主全部工具。 */
	sessionOpenFor(channelId) {
		if (platformOf(channelId) === 'douyin') return false;
		const mode = this.sessionAllowMode();
		return mode === 'all' || (mode === 'master' && this.isMasterChannel(channelId));
	}

	/** 新建/恢复会话时的 setup：挂人格卡 + 瞬态块（只挂这个 agent），挂默认预设，然后把工具收窄到记忆工具。 */
	async setupAgent(agentCtx, channelId) {
		// 人格卡 + 此刻状态只挂在这个 agent 的 scope 上，不注册全局段 —— 宿主自己的会话根本看不到（#41 架构方案）
		try {
			this.agentSections?.(agentCtx);
		} catch (error) {
			// 注不上不拦着建会话：宁可她少一张人格卡，也别整个聊天哑掉（人格卡是真身份，但比「不回」轻）
			this.log('error', `[fish-soul] 人格注入挂不上：${String(error instanceof Error ? error.message : error)}`);
		}
		const presets = service(this.ctx, 'agentPresets');
		if (presets && typeof presets.mount === 'function') {
			const presetId = await this.chatPresetId();
			try {
				await presets.mount(agentCtx, presetId);
			} catch (error) {
				this.log('warn', `[fish-soul] 挂预设失败（按默认预设重试）：${String(error instanceof Error ? error.message : error)}`);
				try { await presets.mount(agentCtx); } catch (error2) {
					this.log('warn', `[fish-soul] 挂默认预设失败（按无预设继续）：${String(error2 instanceof Error ? error2.message : error2)}`);
				}
			}
		}
		if (channelId !== undefined && this.sessionOpenFor(channelId)) return; // #37 主人/全部放开：不 restrict，会话用宿主默认工具组合
		const allow = this.allowedTools(agentCtx);
		if (typeof agentCtx?.tools?.restrict === 'function' && allow.length > 0) {
			try {
				agentCtx.tools.restrict({ allow });
			} catch (error) {
				// 宿主要是不认没注册的工具名：去掉联网工具再收窄一次（收不窄就让建会话失败，宁可不回也不放开 shell）
				this.log('warn', `[fish-soul] 收窄工具失败，去掉联网工具重试：${String(error instanceof Error ? error.message : error)}`);
				agentCtx.tools.restrict({ allow: allow.filter((n) => !WEB_TOOLS.includes(n)) });
			}
		}
	}

	/**
	 * QQ 会话用哪个预设（#73）。
	 *
	 * PTC 预设（Programmatic Tool Calling）里模型**只能直接调 run_code**，
	 * 别的工具全变成 run_code 程序里的 SDK 绑定。而这个插件的护栏不放行 run_code
	 * （它能跑任意程序），于是宿主默认预设在 PTC 模式时，QQ 会话：
	 *   · 记忆工具调不到 —— 模型的唯一出口被堵死，整个会话是哑的；
	 *   · 压缩也落地不了 —— 宿主的压缩是一次独立的模型调用，它会带上这个会话的工具表，
	 *     表里只有 run_code，护栏一拦就失败重试（报错刷屏、上下文继续涨）。
	 *
	 * 所以 QQ 会话改用非 PTC 预设（宿主默认本来就是 standard）：工具直接暴露，
	 * 「只放记忆工具 + 上网查、run_code 始终不放行」这条约定才成立。
	 * 只影响插件自己建的聊天会话 —— 主人在 DSH 里自己开的会话不受影响。
	 *
	 * @returns {Promise<string|undefined>} 预设 id；undefined = 用宿主默认
	 */
	async chatPresetId() {
		const presets = service(this.ctx, 'agentPresets');
		if (!presets || typeof presets.resolve !== 'function') return undefined;
		let cur = null;
		try { cur = await presets.resolve(); } catch { return undefined; }
		const id = typeof cur?.id === 'string' ? cur.id : '';
		if (id === '' || cur?.broken) return undefined; // 读不到 / 坏了 → 照旧（挂载时宿主自己会兜底）
		if (!await this.isPtcPreset(presets, id)) return id;
		const alt = await this.nonPtcPreset(presets, id);
		if (alt === undefined) {
			this.log('warn', '[fish-soul] 宿主默认预设在 PTC 模式，又找不到别的预设：QQ 会话可能调不动工具（去 DSH 里换一个预设）');
			return id;
		}
		this.log('info', `[fish-soul] 宿主默认预设在 PTC 模式，QQ 会话改用 ${alt}（PTC 下只能直接调 run_code，护栏不放行）`);
		return alt;
	}

	/** 这个预设是不是 PTC（模型只能直接调 run_code 的那种）。 */
	async isPtcPreset(presets, id) {
		if (typeof presets.readDocument === 'function') {
			try {
				const doc = await presets.readDocument(id);
				if (typeof doc === 'string' && doc.trim() !== '') return /tool-executor-ptc/.test(doc);
			} catch { /* 读不到就按 id 猜 */ }
		}
		return /(^|[-_])ptc($|[-_])/i.test(String(id));
	}

	/** 找一个不是 PTC 的预设（优先 standard）。 */
	async nonPtcPreset(presets, current) {
		if (typeof presets.list !== 'function') return undefined;
		let rows = [];
		try { rows = await presets.list(); } catch { return undefined; }
		const cands = (Array.isArray(rows) ? rows : [])
			.filter((r) => r && typeof r.id === 'string' && r.id !== current && !r.broken);
		const std = cands.find((r) => r.id === 'standard');
		if (std !== undefined) return std.id;
		for (const r of cands) if (!await this.isPtcPreset(presets, r.id)) return r.id;
		return undefined;
	}

	/** 拿到某个聊天对应的活会话（没有就恢复或新建）。 */
	async ensureSession(chat) {
		// #78 第 2 步：B站 / 抖音 私聊用的是同一个人的 QQ 私聊会话（见 sessionOwnerChat）
		const owner = this.sessionOwnerChat(chat);
		const key = owner.channelId;
		const mergeFrom = key === chat.channelId ? '' : chat.channelId;
		if (this.inflight.has(key)) return this.inflight.get(key);
		const p = (async () => {
			const agents = this.agentsService();
			if (agents === null) throw new Error('宿主没有 agents 服务');
			const row = findChatSession(this.db, platformOf(key), key);
			// 设置页换了人格、选了「正在聊的也换」：这之前建的会话不再用，开个新的（旧会话的口吻不带过来，记忆在 soul.db 不受影响）
			const freshAfter = Number(getKv(this.db, 'persona.freshAfter', 0)) || 0;
			if (row !== null && freshAfter > 0 && Number(row.created_at) < freshAfter) {
				this.log('info', `[fish-soul] 换了人格，${row.title || key} 开新会话`);
				// 旧会话 retired 了，bound 里那一份也要摘掉：留着的话旧 sessionId 仍被当成
				// 「我们的会话」，它的 session/event 会走 sendReply 用已 retired 的 channel_id 发消息。
				this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
				this.bound.delete(row.session_id);
				return await this.createSession(owner, row.workspace_path || undefined, mergeFrom);
			}
			if (row !== null) {
				this.bound.set(row.session_id, row);
				// 🔴 DSH 的系统提示里 {{model}} 取自 agent.options.model（建 / 恢复会话时传的 agentOptions）。
				//    以前恢复会话不传 ⇒ 每轮都报 prompt variable "{{model}}" has no value，回复一条都出不来。
				const agentOptions = this.chatModelFor(key) ?? this.modelSelection();
				const live = agents.get?.(row.session_id);
				if (live !== undefined && live !== null) {
					// 已经开着、但当初没带模型恢复的会话：救不回来（options 只读），换个新会话
					const broken = live.options !== undefined && !live.options?.model && agentOptions !== undefined;
					if (!broken) return live;
					this.log('warn', `[fish-soul] ${row.title || key} 的会话没有模型（旧版恢复留下的），改为新建`);
					this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
					this.bound.delete(row.session_id);
					return await this.createSession(owner, undefined, mergeFrom);
				}
				try {
					const handle = await agents.resume({
						resumeSessionId: row.session_id,
						...(agentOptions !== undefined ? { agentOptions } : {}),
						setup: (agentCtx) => this.setupAgent(agentCtx, key)
					});
					this.log('info', `[fish-soul] 已恢复会话 ${row.title || key}`);
					this.diag?.add('session-resume', { sessionId: row.session_id, channelId: key });
					return handle.agent;
				} catch (error) {
					const msg = String(error instanceof Error ? error.message : error);
					this.log('warn', `[fish-soul] 恢复会话 ${row.session_id} 失败，改为新建：${msg}`);
					this.diag?.add('resume-failed', { sessionId: row.session_id, channelId: key, reason: msg }, 'warn');
					this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
					this.bound.delete(row.session_id);
				}
			}
			return await this.createSession(owner, undefined, mergeFrom);
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
			if (chat.chatType === 'group') return `抖音群·${sanitizeName(name, '抖音群')}`;
			return `抖音·${sanitizeName(name, '抖音用户')}`;
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

	async createSession(chat, workspacePath = this.workspacePath(), mergeFrom = '') {
		const agents = this.agentsService();
		const ws = await this.ensureWorkspace(workspacePath);
		const sessionId = `fish-soul-${randomUUID()}`;
		const presetId = await this.chatPresetId();
		const agentOptions = this.chatModelFor(chat.channelId) ?? this.modelSelection();
		if (agentOptions === undefined) this.log('warn', '[fish-soul] 找不到可用的模型（DSH 默认模型 / 模型服务都读不到），新会话可能跑不起来');
		const handle = await agents.create({
			sessionId,
			meta: { cwd: ws.path ?? workspacePath, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
			...(agentOptions !== undefined ? { agentOptions } : {}),
			setup: (agentCtx) => this.setupAgent(agentCtx, chat.channelId)
		});
		const title = await this.chatTitle(chat);
		this.diag?.add('session-create', { sessionId, channelId: chat.channelId, reason: title });
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
		// #78：这条通道（B站 / 抖音 私聊）并进 QQ 会话了。它自己以前那个会话留着（聊天记录还在），
		// 只是标成 retired + 记下并到了哪儿，之后查会话不会再查到它
		if (mergeFrom !== '' && mergeFrom !== chat.channelId) {
			this.db.prepare("UPDATE chat_session SET status = 'retired', merged_into = ? WHERE channel_id = ? AND status = 'active'")
				.run(sessionId, mergeFrom);
		}
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
				await this.createSession({ channelId: row.channel_id, chatType: kind === 'group' || kind === 'douyin-group' ? 'group' : 'private', targetId: id, title: '' }, target);
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

	// 默认拒绝：白名单为空、也没显式打开 allGroups 时，任何群都不放行。
	groupAllowed(groupId, cfg) {
		if (cfg.allGroups === true) return true;
		return cfg.groupAllowList.includes(String(groupId));
	}

	/** OneBot 事件入口（实时推送和断线补拉共用）。 */
	async onEvent(event, { backfill = false } = {}) {
		if (this.stopped) return;
		const cfg = this.qqConfig();
		if (!cfg.enabled) return;
		if (event?.post_type === 'notice') { await this.onNotice(event, cfg); return; }
		const m = normalizeMessageEvent(event, { selfId: this.channel.selfId, ownMessageIds: this.ownMessages });
		if (m === null || m.userId === '' || m.userId === String(this.channel.selfId)) return;
		// 引用了我 → 算点名。ownMessages 只在内存里，宿主重启后是空的，认不出「引用的是我自己」，
		// 群里引用她说话就没人理了。这会儿问一次 QQ：被引用的那条是不是她发的。
		if (m.chatType === 'group' && !m.mentioned && m.replyId) {
			const src = await this.channel.getMessage?.(m.replyId);
			if (String(src?.sender?.user_id ?? '') === String(this.channel.selfId)) m.mentioned = true;
		}
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return;
		if (backfill) {
			const cur = this.cursorOf(m.channelId);
			if (cur !== null && (m.timeMs < Number(cur.timeMs) || (m.timeMs === Number(cur.timeMs) && m.messageId === cur.messageId))) return;
		}
		this.advanceCursor(m.channelId, m.timeMs, m.messageId);
		// 对方开口了：这个频道「刚发过的话」清空——跨条复读守卫只拦模型自己没输入时重发，
		// 用户又问一遍、她再答一遍同样的话是正常的，不能拦
		this.recentSent?.delete(m.channelId);
		if (m.chatType === 'group' && !this.groupAllowed(m.groupId, cfg)) return;
		if (m.chatType === 'group' && !backfill) {
			this.slang?.observe(m.channelId, m.nickname || m.userId, m.text);
			this.heatTracker().observe(m.channelId, m.userId);
		} else if (m.chatType === 'private' && !backfill && (m.subType === 'friend' || this.channel.isFriend(m.userId) || m.userId === this.masterQq())) {
			this.slang?.observe(m.channelId, m.nickname || m.userId, m.text); // 好友私聊也学说话方式（只在这个私聊里用）
		}

		const person = this.soul.resolvePerson(m);
		await this.decide(m, person, cfg);
	}

	/** QQ 入站消息（真消息和戳一戳共用）：回 / 只记 / 不理 / 插话。 */
	async decide(m, person, cfg) {
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;
		const who = m.nickname || person?.display_name || m.userId;
		// #59 记下主人最近一次跟她说话：她在群里插话前先看这个（用消息自己的时间，补拉的旧消息不算"在聊"）
		if (this.masterQq() !== '' && m.userId === this.masterQq()) {
			const at = Number(m.timeMs);
			if (Number.isFinite(at) && at > 0) this.masterActiveAt = Math.max(this.masterActiveAt, at);
		}
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
						const heat = this.heatOf(m.channelId);
						reason = `自己想插一句（${Math.round(score * 100)}%）${heat.state === 'hot' || heat.state === 'cooling' ? ` · ${heat.label}` : ''}`;
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
		if ((m.records ?? []).length > 0) await this.hearVoice(m);
		if ((m.files ?? []).length > 0) await this.readAttachments(m);
		if ((m.forwards ?? []).length > 0) await this.expandForwards(m);
		// 点表情 / 戳回去是「顺手做的事」，出错不能影响这一轮主流程（也没有全局拒绝兜底）
		if (!interject) void this.reactTo(m, person).catch(() => {});
		this.note(interject ? 'interject' : 'reply', { channelId: m.channelId, who, text: m.text, reason });
		this.enqueue(m, person, cfg, { interject });
	}

	/** QQ 语音 → 文字（语音没开 / 听不了就保持"暂时听不了"）。 */
	async hearVoice(m) {
		m.voice = true;
		// 这里以前是静默 return：语音没开 / key 没填全时，消息里只剩「听不了」占位，
		// 从日志完全看不出是被配置挡掉的还是接口挂了。留一行，别让用户瞎猜。
		if (this.voice === null) { this.log('warn', '[fish-soul] 收到语音但语音服务没起来，按「听不到」处理'); return; }
		if (!this.voice.readyFor('stt')) { this.log('warn', '[fish-soul] 收到语音但「听」没就绪（语音开关 / key / 模型），按「听不到」处理'); return; }
		const parts = [];
		for (const rec of m.records.slice(0, 2)) {
			const bytes = await this.voice.fetchQqRecord(this.channel, rec);
			// 「听不到」有两种完全不同的原因，日志里要分得开，否则只能靠猜：
			// 拿不到音频（get_record 失败 / 地址被拒）vs 音频拿到了但识别失败（接口 / key / 模型）
			if (bytes === null) {
				this.log('warn', `[fish-soul] 语音取不到音频（get_record 和 url 都没拿到），这条按「听不到」处理；file=${String(rec?.file ?? '').slice(0, 40)}`);
			}
			const text = bytes ? await this.voice.transcribe(bytes) : null;
			if (bytes && text === null) {
				this.log('warn', `[fish-soul] 音频拿到了（${bytes.length} 字节）但识别失败：${this.voice.lastError || '接口没回文字'}`);
			}
			parts.push(text === null ? '【语音（没听清）】' : `【语音】${sanitizeUserText(text)}`);
		}
		let i = 0;
		m.text = String(m.text ?? '').split(UNHEARD).map((seg, idx, arr) => (idx < arr.length - 1 ? seg + (parts[i++] ?? UNHEARD) : seg)).join('');
	}

	/**
	 * QQ 附件 → 正文：txt/md 这类直接读内容，pdf/docx 存到插件数据目录再报路径。
	 * SnowLuma 这类不给本地 path 的，用 file_id 走 get_private_file_url 换链接下载。
	 * 读不了 / 下载失败 / 路径不在白名单目录里的，保留原来的【文件：名字】占位。
	 */
	async readAttachments(m) {
		const cfg = attachmentConfig(this.getConfig());
		const { text } = await applyAttachments(m.text, m.files, {
			readText: cfg.readText,
			saveBinary: cfg.saveBinary,
			roots: [this.workspacePath(), fishSoulDir()],
			dataDir: join(fishSoulDir(), 'files'),
			messageId: m.messageId,
			log: this.log,
			fetchFile: ({ fileId, fileHash, url, maxBytes }) => this.fetchQqFile(m, { fileId, fileHash, url, maxBytes })
		});
		m.text = text;
	}

	/** 用 OneBot API 把 QQ 文件拉下来（SnowLuma：get_private_file_url → 直链下载）。 */
	async fetchQqFile(m, { fileId, fileHash, url, maxBytes = 32 * 1024 * 1024 }) {
		if (typeof this.channel?.call !== 'function') return null;
		// d.url 有就直接用（有些实现会带）
		let link = String(url ?? '').trim();
		if (link === '' && fileId !== '') {
			try {
				const isGroup = m.chatType === 'group';
				const res = await this.channel.call(isGroup ? 'get_group_file_url' : 'get_private_file_url', {
					user_id: Number(m.userId) || m.userId,
					group_id: Number(m.channelId.replace(/^group:/, '')) || undefined,
					file_id: fileId,
					file_hash: fileHash ?? ''
				});
				link = String(res?.url ?? res?.data?.url ?? '').trim();
			} catch {
				return null;
			}
		}
		if (link === '' || !/^https?:/i.test(link)) return null;
		try {
			const limit = Number.isFinite(maxBytes) ? Math.min(32 * 1024 * 1024, Math.max(0, maxBytes)) : 32 * 1024 * 1024;
			// QQ 文件的直链同样不可信：走安全下载（只连公网 IPv4、逐跳校验、按实际字节限额）。
			return await (this.attachmentDownload ?? safeDownload)(link, { maxBytes: limit, timeoutMs: 20000 });
		} catch {
			return null;
		}
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
		let score = interjectScore({
			text: m.text, base: ij.chance, keywords: ij.keywords, relation: person?.relation_stage ?? 'stranger',
			isMaster: m.userId === this.masterQq(), busyCount
		});
		// #59 主人在跟她聊：主人刚说过话就少在群里抢话。乘 0.2 而不是直接归零 —— 归零会让她在群里突然消失，
		// 主人只是顺口一句、群里正好聊到点上的话，她还是可以接。
		if (ij.masterQuiet && this.masterActiveAt > 0 && now - this.masterActiveAt < ij.masterQuietMinutes * 60_000) score *= 0.2;
		// #59 对话收尾冷却：她刚说过"这轮聊完了"，群里的软唤醒压到四分之一
		//（点名 / 私聊 / 戳一戳走别的路径，照常醒）
		const closed = this.closedUntil.get(m.channelId) ?? 0;
		if (closed > 0) {
			if (closed <= now) this.closedUntil.delete(m.channelId);
			else score *= 0.25;
		}
		// v0.9：群里热闹 / 刚说完话冷却、她现在的心情
		return Math.min(1, score * this.heatOf(m.channelId).factor * this.moodOf(person).interject);
	}

	/** 主人发的 "/鱼 暂停 30分钟" / "/鱼 继续"：只对发命令的这个聊天生效，回一句确认（不经过模型）。 */
	async handleCommand(m) {
		const c = COMMAND_RE.exec(String(m.text ?? ''));
		if (c === null) return false;
		const verb = String(c[1] ?? '');
		// 入群申请：主人拍板（群管理没开就不算这条命令，交给模型回）
		if (/同意|通过|允许|拒绝|不准/.test(verb)) {
			if (this.groupAdmin === null) return false;
			const approve = !/拒绝|不准/.test(verb);
			const text = await this.groupAdmin.decide(approve);
			this.note('command', { channelId: m.channelId, who: m.nickname || '主人', text: m.text, reason: approve ? '同意入群' : '拒绝入群' });
			try { await this.channel.send(m.channelId, [{ type: 'text', data: { text } }]); } catch { /* 发不出去也算生效 */ }
			return true;
		}
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
			// 和旁边 seen / ownMessages 一致：无界 Map 要淘汰最老的（长期运行按「谁戳过她」累积）
			if (this.pokeAt.size > POKE_LIMIT) this.pokeAt.delete(this.pokeAt.keys().next().value);
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
			void this.pokeBack(groupId, userId).catch(() => {});
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
				this.douyin?.inbox?.settle(batch.items.map(x => x.m.inboxId).filter(Boolean), false, String(error));
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
		// 取不到原文就说取不到，别让模型以为引用了句空话然后瞎接
		if (!msg) return '【引用了一条消息（原文没取到）】';
		const n = normalizeMessageEvent({ post_type: 'message', message_type: msg.message_type ?? 'group', ...msg }, { selfId: this.channel.selfId });
		const who = sanitizeName(n?.nickname || msg.sender?.nickname || '', '某人');
		const text = (n?.text ?? '').trim();
		return text === '' ? `【引用 ${who}：（不是文字消息）】` : `【引用 ${who}：${text.slice(0, 40)}】`;
	}

	async dispatch(channelId, items) {
		if (this.stopped || items.length === 0) return;
		const first = items[0].m;
		// 🔴 共享会话必须按会话串行：批次是按 channelId 分的，但多个 channelId
		//    可能落到**同一个** session（设置页开了共享会话：QQ 私聊 + B站 私信 + 抖音私信）。
		//    turnState / turnMood / interjectTurns 都是按 sessionId 存**一份**，
		//    两轮并发就会互相覆盖 → A 的回复按 B 的通道发出去（或 convId 用错）。
		//    这里拿到 agent 之后排个队：同一会话同时只跑一轮，其余按到达顺序等。
		const agent = await this.ensureSession({ channelId, chatType: first.chatType, targetId: first.targetId, title: first.chatType === 'private' ? first.nickname : '', userId: first.userId });
		await this.runExclusiveForSession(agent.id, () => this.dispatchInner(channelId, items, agent));
	}

	/**
	 * 同一会话内的 dispatch 串行执行（按到达顺序排队）。
	 * 不同会话之间完全并行 —— 不能用一个全局锁，那会把所有聊天卡成一条线。
	 */
	async runExclusiveForSession(sessionId, fn) {
		this.sessionChains ??= new Map();
		const prev = this.sessionChains.get(sessionId) ?? Promise.resolve();
		// 前一轮失败也要继续（否则一次错误就把这个会话永久堵死）
		const run = prev.then(() => fn(), () => fn());
		// 链上存「已 settle」的哨兵：后来的只关心「前一轮结束了没」，不关心结果
		const tail = run.then(() => {}, () => {});
		this.sessionChains.set(sessionId, tail);
		try {
			return await run;
		} finally {
			// 自己就是队尾才清掉，防止 Map 随会话数无限长（会话多时这是真的泄漏）
			if (this.sessionChains.get(sessionId) === tail) this.sessionChains.delete(sessionId);
		}
	}

	async dispatchInner(channelId, items, agent) {
		const first = items[0].m;
		const platform = platformOf(channelId);
		const isBili = platform === 'bili';
		// userId 一起带上：B站 是 UID、抖音 是 `uid:<id>`（会话名会被改，认人靠它，见 personKeyOf）
		const chat = { channelId, chatType: first.chatType, targetId: first.targetId, title: first.chatType === 'private' ? first.nickname : '', userId: first.userId };
		this.applyChatModelFor(agent, channelId);
		this.typing(first);

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
		await this.judgeTurn(channelId, speakers);
		this.turnMood ??= new Map();
		this.turnMood.set(agent.id, this.moodOf(speakers[speakers.length - 1]?.person));
		// 只有插话（没有一条是点名 / 接着听的）才算"她自己想说"
		const interject = chat.chatType === 'group' && items.every((x) => x.interject === true);
		const backlog = chat.chatType === 'group' ? this.takeBacklog(channelId, new Set(items.map(({ m }) => m.messageId))) : [];
		if (interject) this.interjectTurns.add(agent.id); else this.interjectTurns.delete(agent.id);
		this.soul.beginTurn(agent.id, {
			channel: sessionChannelOf(channelId),
			channelId,
			replyChannel: this.replyChannelFor(agent, channelId),
			speakers,
			backlog,
			interject,
			voiceIn: items.some(({ m }) => m.voice === true),
			workspacePath: this.bound.get(agent.id)?.workspace_path ?? this.workspacePath()
		});
		// #78：回复发到「这一轮从哪个通道进来的」，不再只认会话绑定的那个通道。
		// 共享会话之后一个会话可能对应多个通道（QQ 私聊 + B站 私信），row.channel_id 只代表绑定的那一个。
		this.turnState(agent.id).channelId = channelId;
		const inboxIds = items.map(x => x.m.inboxId).filter(Boolean);

		const lines = [];
		for (const { m } of items) {
			const quote = platform === 'qq' ? await this.quoteLine(m.replyId) : '';
			const body = `${quote}${m.text || '（空消息）'}`;
			// 群里一行一个人：对方自己打的换行压成 ⏎，免得有人换行伪造「主人：……」（【】是插件生成的块，比如合并转发，对方打不出来，原样留着）
			const flat = body.split(/(【[^】]*】)/).map((part, i) => (i % 2 === 1 ? part : part.replace(/\s*\n\s*/g, ' ⏎ '))).join('');
			lines.push(chat.chatType === 'group' ? `${sanitizeName(m.nickname || m.userId, m.userId)}：${flat}` : body);
		}
		lines.push(...await this.videoNotes(items));
		const content = await this.admitImages(lines.join('\n'), items, agent.id);
		const last = items[items.length - 1].m;
		const mentionItem = [...items].reverse().find(({ m }) => m.mentioned)?.m ?? last;
		// 插话不引用（像自然接话）；戳一戳没有真的消息可引用。replyTo 跟着这条 followup 消息的 source 走，不存共享 Map——并发 dispatch 各带各的，不会张冠李戴
		const replyTo = chat.chatType === 'group' && !interject && !String(mentionItem.messageId).startsWith('poke-') ? mentionItem.messageId : null;
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
				batch: items.length,
				...(inboxIds.length ? { inboxIds } : {}),
				// 抖音目标会话 ID：跟着这一轮的 source 走，出站时校验发给谁（不存共享 Map）。
				...(platform === 'douyin' && last.convId ? { convId: String(last.convId) } : {}),
				replyTo
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
	 *
	 * 超时（模型 5 分钟没写完）会把 meta.timedOut 置 true 再返回 false：调用方要能分清
	 * 「慢」和「发不出去」，这两种的重试策略不一样（#80）。
	 */
	async triggerProactive(channelId, reason, meta = {}) {
		const { origin = 'idle' } = meta;
		const [kind, id] = splitChannelId(channelId);
		// 抖音收件人无法核验，暂停所有主动发送。
		if (kind === 'douyin' || kind === 'douyin-group') {
			/**
			 * 抖音默认**不发**主动私信（收件人身份核验不了）。
			 *
			 * 唯一的例外：她自己起意的**视频卡片分享**（origin='share'）。
			 * 那条不走模型 —— 作品 ID 和感受在入队时就落盘了，发送控制面直接投卡片，
			 * 免得模型漏抄链接、或者回个「[不回]」，卡片就发不出去了。
			 */
			if (kind === 'douyin-group' || origin !== 'share') return false;
			if (this.isPaused(channelId)) { this.note('paused', { channelId, reason: '这个聊天暂停着，不主动开口' }); return false; }
			return await this.deliverDouyinShare(channelId, reason, meta) === true;
		} else if (kind === 'bili') {
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
		this.applyChatModelFor(agent, channelId);
		const person = kind === 'private' ? findPersonByQq(this.db, id) : kind === 'bili' ? findPersonByBili(this.db, id) : kind === 'douyin' ? findPersonByDouyin(this.db, id) : null;
		this.turnMood ??= new Map();
		this.turnMood.set(agent.id, this.moodOf(person));
		this.soul.beginTurn(agent.id, {
			channel: sessionChannelOf(channelId),
			channelId,
			replyChannel: this.replyChannelFor(agent, channelId),
			speakers: person !== null ? [{ person, userId: id, displayName: person.display_name, text: reason }] : [],
			proactive: true,
			workspacePath: this.bound.get(agent.id)?.workspace_path ?? this.workspacePath()
		});
		this.turnState(agent.id).channelId = channelId;
		this.interjectTurns.delete(agent.id);
		this.note('proactive', { channelId, reason: sanitizeUserText(reason).slice(0, 60) });
		const msgId = randomUUID();
		const done = new Promise((resolveDone) => {
			const timer = setTimeout(() => {
				meta.timedOut = true;
				this.waiters.delete(msgId);
				resolveDone(false);
			}, PROACTIVE_TURN_TIMEOUT_MS);
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
			// convId：抖音会话 ID，开轮时从入站消息登记，出站时用来校验「发给谁」。
			st = { text: '', images: [], fromUs: false, messageIds: [], replyTo: null, proactive: false, channelId: null, convId: '' };
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
			// 🔴 DSH 每一步都会在我们的消息**后面**再追加几条 user/message：
			//    runtime-context（插件的动态上下文，每轮都变）、model-selection（换模型提示）等。
			//    以前每条都重算 fromUs ⇒ 被它们改成 false ⇒ 回复生成了却不发（DSH 里看得见，QQ / 抖音收不到）。
			//    现在只有我们自己的来源置 true；只有真人在界面里打字（kind 'user'）才置 false；别的宿主上下文不管。
			if (OUR_SOURCES.has(kind)) st.fromUs = true;
			else if (kind === 'user') { st.fromUs = false; st.dshTyped = true; } // #78：DSH 桌面端打字，不外发但要记动态
			// 其他宿主上下文（runtime-context / model-selection 等）：不动 fromUs ——
			// 它们不是我们发的消息，但也不是真人打字，重置会把 B站/抖音 的回复憋回去（smoke #13 守着）
			// 共享会话里一个会话对应多个通道（QQ + B站）：这一轮从哪个通道进来的，来源里也带着 ——
			// 开轮时 dispatch 已经登记过，这里兜的是「插件重启后宿主重放消息」那条路（否则会回错平台）
			if (OUR_SOURCES.has(kind) && msg?.source?.channelId) st.channelId = String(msg.source.channelId);
			if (msg?.id !== undefined && OUR_SOURCES.has(kind)) st.messageIds.push(String(msg.id));
			if (kind === SOURCE_DOUYIN && Array.isArray(msg?.source?.inboxIds)) st.inboxIds = [...new Set([...(st.inboxIds ?? []), ...msg.source.inboxIds])];
			// 抖音目标会话 ID：出站时靠它校验「打开的还是这个人的会话」，昵称不算证据。
			if (kind === SOURCE_DOUYIN && msg?.source?.convId) st.convId = String(msg.source.convId);
			// 这一轮要引用哪条跟着消息走：我们自己的消息带 replyTo 就记，主动开口/真人打字不带就清
			if (OUR_SOURCES.has(kind)) st.replyTo = msg.source.replyTo ?? null;
			// #75：这一轮是她主动开口（触发消息的来源是 proactive）——记下来，
			// 聊天整理时别把主动开口里随口说的（尤其日程带出来的）当成既成事实记进长期记忆。
			if (kind === SOURCE_PROACTIVE) st.proactive = true;
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
				this.douyin?.inbox?.settle(st.inboxIds ?? [], ok, '这一轮或发送结果不确定，请先核实');
				for (const id of waiterIds) {
					const w = this.waiters.get(id);
					if (w === undefined) continue;
					clearTimeout(w.timer);
					this.waiters.delete(id);
					w.resolve(ok);
				}
			};
			if (!completed || !st.fromUs) {
				if (st.fromUs) this.note('failed', { channelId: st.channelId ?? this.bound.get(sessionId)?.channel_id ?? '', reason: `这一轮没正常结束（${d.reason?.kind ?? '未知'}）` });
				// #78：DSH 桌面端打字的轮次不外发，但**要记动态** —— 以前在 DSH 里聊，动态页整片空白。
				if (st.dshTyped === true) {
					const recall = this.soul.recallInfo?.(sessionId, st) ?? { memories: [], at: 0, unknown: false };
					this.note('dsh', {
						channelId: st.channelId ?? this.bound.get(sessionId)?.channel_id ?? '',
						text: String(st.text ?? '').slice(0, 60),
						reason: '在 DSH 里聊的，不外发',
						memories: recall.memories ?? [],
						recallAt: recall.at ?? 0,
						speakerUnknown: recall.unknown === true,
						recallMiss: recall.miss ?? ''
					});
				}
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

	rememberOwn(messageId, text) {
		if (!messageId) return;
		this.ownMessages.set(String(messageId), text);
		if (this.ownMessages.size > OWN_LIMIT) this.ownMessages.delete(this.ownMessages.keys().next().value);
	}

	/**
	 * 跨条复读守卫：同一频道 2 分钟内跟刚发过的内容一字不差（规整化后）的段落，拦掉不发。
	 * 模型遇到相近输入时偶尔把自己上一条消息原样再发一遍（QQ 上真实发生过：同一句隔 17 秒发两次）。
	 * 只拦「没新输入时模型自己又发一遍」：收到对方新消息时 onEvent 会清掉该频道的记录，
	 * 用户再问一遍不会被拦。短句（规整化后 <12 字）允许重复。
	 */
	dropRepeats(row, paragraphs) {
		const store = (this.recentSent ??= new Map());
		const now = Date.now();
		const hist = (store.get(row.channel_id) ?? []).filter((h) => now - h.at <= 120000);
		const dups = new Set(findRepeatedParagraphs(hist, paragraphs, { now }));
		if (dups.size > 0) {
			this.note('filtered', { channelId: row.channel_id, title: row.title, text: paragraphs.filter((_, i) => dups.has(i)).join(' / ').slice(0, 120), reason: '跟刚发的消息一字不差，跨条复读没再发' });
		}
		return paragraphs.filter((_, i) => !dups.has(i));
	}

	/** 发送成功后把这轮发出去的段落记进「最近发过的」，给下一轮跨条复读比对用。 */
	noteSent(row, paragraphs) {
		const store = (this.recentSent ??= new Map());
		const now = Date.now();
		const hist = (store.get(row.channel_id) ?? []).filter((h) => now - h.at <= 120000);
		for (const p of paragraphs) {
			const n = normSentText(p);
			if (n !== '') hist.push({ at: now, norm: n });
		}
		while (hist.length > 50) hist.shift();
		store.set(row.channel_id, hist);
	}

	/** 把一轮的最终回复发回 QQ：按空行拆成几条连发，图片跟在最后。 */
	async sendReply(sessionId, st) {
		const bound = this.bound.get(sessionId);
		if (bound === undefined) return false;
		// 抖音的目标会话 ID（`0:1:uidA:uidB`）。发送前要拿它确认「打开的还是这个人的会话」——
		// 昵称只能用来找会话，撞名或改名时会静默发给错的人。入队时也带着它，重发才不会发错。
		// 🔴 必须声明在**所有使用点之前**：原来它在函数后半段才 `const`，
		//    抖音分支提前用它就是 TDZ（`Cannot access 'convId' before initialization`）。
		const convId = String(st?.convId ?? '');
		// 本轮的通道优先（st.channelId 在开轮时登记），没有就退回会话绑定的那个 ——
		// 没登记的路径（老会话、重启后重建）行为跟以前一模一样。
		// 设置页选了「一律回 QQ」就反过来：始终用会话绑定的那个（共享会话里就是 QQ）。
		const row = this.replyTarget() === 'qq' ? bound : st?.channelId ? { ...bound, channel_id: st.channelId } : bound;
		// 🔴 只有「这一轮是从抖音来的、但回复要发去别的平台」才拦 —— 那是隔离未验证流程时
		//    防止抖音内容借 QQ 通道泄露用的闸。**不能无条件拦抖音**：那会让抖音回复
		//    永远发不出去（`platformOf('douyin:x')` 恒为 'douyin'），等于「解除了读、没解除写」。
		//    判据看的是**目标通道** row.channel_id，不是来源 st.channelId。
		if (platformOf(st?.channelId) === 'douyin' && platformOf(row.channel_id) !== 'douyin') return false;
		const interject = this.interjectTurns.delete(sessionId);
		const profile = this.turnMood?.get(sessionId) ?? this.moodOf(null);
		this.turnMood?.delete(sessionId);
		// 把这一轮的 turn state 传进去：turn/end 已经把它从 turns 里删了，只有这里还拿着（#78 间歇性）
		const recall = this.soul.recallInfo?.(sessionId, st) ?? { memories: [], at: 0, unknown: false };
		const memories = recall.memories ?? [];
		// miss：没组装记忆是哪一种（notMounted / noSession），透给动态页 —— 以前只给 at:0，
		// 界面上那句「会话没登记 / 认人失败 / 没走我们的上下文」三种可能全靠猜（#78）
		const recallNote = { recallAt: recall.at ?? 0, speakerUnknown: recall.unknown === true, recallMiss: recall.miss ?? '' };
		// [收藏表情:名字]：把对方刚发的表情存进 _stickers（这行不发出去）
		const collected = parseCollect(String(st.text ?? '').trim());
		// #59 对话收尾：她标了【收尾】说明这轮聊完了。标记是内部控制符，发出去之前先剥掉
		const parsed = parseClosing(collected.text);
		const raw = parsed.text;
		const closing = parsed.closing;
		for (const one of collected.items.slice(0, 2)) {
			const r = this.stickers?.collect(sessionId, one.name, row.workspace_path, { from: row.title, tags: one.tags }) ?? { ok: false, reason: '没有收藏功能' };
			const tagged = r.ok && (r.tags ?? []).length > 0 ? `，标签：${r.tags.join('、')}` : '';
			this.note(r.ok ? 'sticker' : 'sticker-skip', { channelId: row.channel_id, title: row.title, text: r.file ?? one.name, reason: r.ok ? `存了一张表情包${tagged}` : r.reason });
		}
		if (raw === '' && collected.items.length > 0) return true;
		if (SILENT_RE.test(raw)) {
			this.note('silent', { channelId: row.channel_id, title: row.title, reason: interject ? '想了想，没插话' : '她选择不回', memories, ...recallNote });
			return true;
		}
		// 按感觉挑表情：`![得意](_stickers/@得意)` → 换成库里最像的那张真文件名。
		// 嵌入模型没配 / 库里没标签 / 算失败，都原样往下走（`@xxx` 那份会被丢掉，不会漏进她的话）。
		let feelText = raw.replace(/\s*\[(不回|沉默)\]\s*$/g, '');
		if (feelText.includes('_stickers/@') || feelText.includes('_stickers\\@')) {
			try {
				const r = await this.stickers?.resolveFeelRefs(feelText, row.workspace_path, this.embedder, { model: this.embeddingModel() }) ?? { text: feelText, resolved: [] };
				feelText = r.text;
				for (const one of r.resolved) {
					this.note(one.file ? 'sent' : 'sticker-skip', {
						channelId: row.channel_id, title: row.title, text: one.feel,
						reason: one.file ? `按感觉挑中了 ${one.file}` : `没有像「${one.feel}」的表情，这段没发`
					});
				}
			} catch (error) {
				this.log('warn', `[fish-soul] 按感觉挑表情失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		const picked = 抠正文图(feelText);
		const 图 = this.moodPick(profile, picked.图, row);
		const 净文字 = this.cleanOut(picked.净文字, row);
		if (净文字.trim() === '' && picked.净文字.trim() !== '' && 图.length === 0) return true;
		const platform = platformOf(row.channel_id);
		if (platform === 'bili' || platform === 'douyin') {
			const images = await this.dmImages(row, 图, st);
			// [语音] 段：主人的话转成语音发到 QQ 私聊，其余去掉标记当文字发
			const dmText = (await this.relayDmVoice(row, 净文字)).split(/\n{2,}/).map((p) => p.replace(VOICE_RE, '')).filter((p) => p.trim() !== '').join('\n\n');
			if (dmText === '' && images.length === 0) return true;
			let ok;
			let delivered;
			let detail = '';
			if (platform === 'bili') {
				ok = await this.sendBili(row, dmText, images);
				delivered = ok; // B站 那条是直连接口，onMessage 就带 message_id，没有「静默被吞」这回事
			} else {
				// convId 是目标会话 ID：sendDouyin 拿它确认收件人，拿不到就拒绝发送。
				const r = await this.sendDouyin(row, dmText, images, convId);
				ok = r.ok === true;
				delivered = r.delivered === true;
				// 具体原因要留下来。以前写死「发送失败」，真机上分不清是身份校验拒的、
				// 进不去会话，还是风控吞的（2026-11-11 连着三轮都只看到这四个字）。
				detail = r?.error || '';
			}
			// 🔴 「动作做了」和「对方真能看见」分开记：
			//    抖音风控会静默吞消息（Enter 按了、UI 没报错、消息没进会话）。
			//    只记 sent 会让动态页/日记看起来一切正常，实际上对方什么都没收到。
			const kind = !ok ? 'failed' : (delivered ? 'sent' : 'unconfirmed');
			const reason = !ok ? (detail || '发送失败') : (delivered ? '' : '发出去了但回读没看到，可能被风控吞了');
			this.note(kind, { channelId: row.channel_id, title: row.title, text: dmText || '[图片]', reason, memories, ...recallNote });
			if (ok && dmText) this.soul.journalOut?.(row.channel_id, dmText);
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
		let paragraphs = 净文字.split(/\n{2,}/).map((s) => s.trim()).filter((s) => s.replace(VOICE_RE, '').trim() !== '');
		// 跨条复读守卫：短时间内同一频道又要发一模一样的内容 → 直接拦掉
		paragraphs = this.dropRepeats(row, paragraphs);
		if (paragraphs.length > MAX_PARAGRAPHS) {
			paragraphs = [...paragraphs.slice(0, MAX_PARAGRAPHS - 1), paragraphs.slice(MAX_PARAGRAPHS - 1).join('\n\n')];
		}
		if (paragraphs.length === 0 && images.length === 0) return true;
		const isGroup = row.channel_id.startsWith('group:');
		const replyTo = isGroup ? st.replyTo ?? undefined : undefined;
		st.replyTo = null;
		// [语音] 开头的段：合成语音发（没开 / 太长 / 失败就发文字）
		const voiced = [];
		for (const [i, p] of paragraphs.entries()) {
			if (!VOICE_RE.test(p)) continue;
			paragraphs[i] = p.replace(VOICE_RE, '').trim();
			const moodOk = this.moodVoice(profile);
			const bytes = paragraphs[i] !== '' && moodOk ? await this.voice?.synthesize(paragraphs[i]) ?? null : null;
			if (bytes) voiced[i] = { type: 'record', data: { file: `base64://${bytes.toString('base64')}` } };
			else if (paragraphs[i] !== '') {
				this.note('filtered', { channelId: row.channel_id, title: row.title, text: paragraphs[i], reason: `语音没发成（${moodOk ? this.voiceFailReason(paragraphs[i]) : `${profile.mood || profile.tone || '心情'}，不想说话`}），改成打字` });
			}
		}
		const messages = paragraphs.map((p, i) => (voiced[i] ? [voiced[i]] : isGroup ? 拆成消息段(p) : [{ type: 'text', data: { text: p } }]));
		if (images.length > 0) {
			if (messages.length > 0) messages[messages.length - 1].push(...images);
			else messages.push(images);
		}
		// 语音消息不能带引用
		if (replyTo && messages[0][0]?.type !== 'record') messages[0].unshift({ type: 'reply', data: { id: String(replyTo) } });
		let allOk = true;
		// convId 已在函数开头声明（抖音分支要用，声明晚了就是 TDZ）。
		// 这个聊天里还有没重发完的：新回复排到后面，顺序不乱
		let queued = this.outbox.hasQueued(row.channel_id);
		let queuedCount = 0;
		await this.sleep(this.firstDelay(profile));
		for (const [i, segs] of messages.entries()) {
			const text = voiced[i] ? `[语音] ${paragraphs[i]}` : paragraphs[i] ?? '[图片]';
			if (queued) {
				this.outbox.enqueue({ channelId: row.channel_id, title: row.title, segs, text, convId });
				queuedCount++;
				continue;
			}
			if (i > 0) await this.sleep(Math.min(6000, typingDelayMs(paragraphs[i] ?? '', this.random) * profile.delay));
			try {
				const id = await this.channel.send(row.channel_id, segs, convId);
				this.rememberOwn(id, text);
			} catch (error) {
				const msg = String(error instanceof Error ? error.message : error);
				if (classifySendError(error) === 'retry') {
					// 肯定没发出去：这条和后面的都排队重发
					this.outbox.enqueue({ channelId: row.channel_id, title: row.title, segs, text, error: msg, convId });
					queued = true;
					queuedCount++;
					this.log('warn', `[fish-soul] 发到 ${row.title || row.channel_id} 没成功（${msg}），排队重发`);
				} else {
					allOk = false;
					this.log('error', `[fish-soul] 发到 ${row.title || row.channel_id} 失败（${msg}），可能已经发出去了，不重发`);
				}
			}
		}
		if (isGroup) {
			this.lastSpoke.set(row.channel_id, Date.now());
			// 插完话有人接：接着听几条（和被点名一样）
			const cfg = this.qqConfig();
			if (interject && cfg.followUpCount > 0 && !this.follow.has(row.channel_id)) {
				this.follow.set(row.channel_id, { 剩: cfg.followUpCount, 到: Date.now() + cfg.followUpSeconds * 1000 });
			}
			// #59 对话收尾：她说这轮聊完了 → 这个群不再"接着听"，插嘴的软唤醒也压下去
			//（冷却时长沿用"接着听多少秒"：那段时间本来就是她愿意继续聊的窗口）
			if (closing && cfg.followUpSmart) {
				this.follow.delete(row.channel_id);
				this.closedUntil.set(row.channel_id, Date.now() + cfg.followUpSeconds * 1000);
			}
		}
		if (paragraphs.length > 0) {
			this.soul.journalOut?.(row.channel_id, paragraphs.join('\n'), { proactive: st.proactive === true });
			this.slang?.observe(row.channel_id, '', paragraphs.join(' '), { self: true }); // 学说法时当上下文，不从她自己的话里学
			// 真发出去了才记进「最近发过的」：发送失败的内容没到对方手里，不该被跨条守卫拦。
			// 排队重发的也一样——重发成功时 Outbox 的 onSent 回调再记。
			if (allOk && queuedCount === 0) this.noteSent(row, paragraphs);
		}
		const reason = !allOk ? '有消息没发出去' : queuedCount > 0 ? `${queuedCount} 条暂时没发出去，排队重发中` : interject ? '插了一句' : '';
		this.note(allOk && queuedCount === 0 ? 'sent' : 'failed', { channelId: row.channel_id, title: row.title, text: paragraphs.map((p, i) => (voiced[i] ? `🔊${p}` : p)).join(' / ') || '[图片]', reason, memories, ...recallNote });
		return allOk;
	}
}

Object.assign(ChatGateway.prototype, mediaMethods, behaviorMethods);
