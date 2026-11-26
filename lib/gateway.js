// @ts-check
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
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
	fishSoulDir, findChatSession, findChatSessionBySessionId, listChatSessions,
	findPersonByQq, findPersonByBili, getKv, setKv
} from './db.js';
import { normalizeMessageEvent, sanitizeName, sanitizeUserText } from './channels/onebot.js';
import { applyAttachments, attachmentConfig } from './attachments.js';
import { parseCollect } from './stickers.js';
import { UNHEARD } from './voice.js';
import { stripForSpeech } from './tts-text.js';
import { saveVoiceFile, voiceIncomingEpoch, audioExt } from './voice-files.js';
import { typingDelayMs, interjectScore, interjectConfig, platformOf, splitChannelId, sessionChannelOf, isGroupChannelId, parseClosing, clampReplyWindow, masterTagOf } from './gateway-util.js';
import { mediaMethods } from './gateway-media.js';
import { Outbox, classifySendError } from './outbox.js';
import { safeDownload } from './safe-download.js';
import { behaviorMethods } from './gateway-behavior.js';
import {
	sessionMethods, QQ_SESSION_TOOLS, RELAY_TOOL, RELAY_FRIEND_TOOL, DOUYIN_VIDEO_TOOL,
	SCHEDULED_TASK_TOOLS, CHAT_TOOLS, isOpenMotionTool, WEB_TOOLS, OWN_WEB_TOOL,
	IMAGE_EXT, OVERFLOW_SESSION_KEY, SWITCH_BLOCKED_SESSION_KEY, dedicatedWorkspacePath
} from './gateway-session.js';
import {
	dispatchMethods, SOURCE_QQ, SOURCE_PROACTIVE, SOURCE_BILI, SOURCE_DOUYIN,
	ownKey, RETRYABLE_TURN_TTL_MS, RETRYABLE_TURN_LIMIT, sameSelfMessageTime
} from './gateway-dispatch.js';
import { adapterOf, DouyinAdapter } from './douyin-adapter.js';
import { findRepeatedParagraphs, normSentText, normalizeVoiceParagraphs } from './behavior.js';
import { 该收这条, 拆成消息段, 抠正文图, 兜底表情包 } from './channels/vendor/qq-bridge.js';

/** 抖音 uid 绑定表的 kv key（`douyin.uin.<纯数字uid>`）；uid 不合法返回 ''。 */
const normUidKey = (uid) => {
	const s = String(uid ?? '').trim().replace(/^uid:/, '').replace(/^douyin:/, '');
	return /^\d+$/.test(s) ? `douyin.uin.${s}` : '';
};

export {
	typingDelayMs, interjectScore, interjectConfig, platformOf, splitChannelId, sessionChannelOf, clampReplyWindow,
	SOURCE_QQ, SOURCE_PROACTIVE, SOURCE_BILI, SOURCE_DOUYIN,
	QQ_SESSION_TOOLS, RELAY_TOOL, RELAY_FRIEND_TOOL, DOUYIN_VIDEO_TOOL, SCHEDULED_TASK_TOOLS, CHAT_TOOLS,
	isOpenMotionTool, WEB_TOOLS, OWN_WEB_TOOL, dedicatedWorkspacePath
};

/** 回复里想用语音说的那段：单独一段、以 [语音] 开头。 */
const VOICE_RE = /^\s*\[语音\]\s*/;
const SILENT_RE = /^\s*\[(不回|沉默|skip)\]/i; // 开头就是 [不回]：这轮不发（后面跟的解释也不发）
const MAX_PARAGRAPHS = 5;
const SEEN_LIMIT = 4000;
const OWN_LIMIT = 500;
/** 戳一戳的冷却表上限（无界 Map 会随「不同人 × 不同群」长期累积）。 */
const POKE_LIMIT = 500;
/** 群里没点名的话最多攒多少条 / 多久以内的（被叫到时给她看"刚才在聊什么"） */
const BACKLOG_LIMIT = 12;
const BACKLOG_MAX_AGE_MS = 15 * 60_000;
const DECISION_LIMIT = 300;
const POKE_GAP_MS = 60_000;
const PAUSE_KEY = 'chat.paused';
/** 主人在 QQ 里发的控制命令：/鱼 暂停 [30分钟|2小时]、/鱼 继续、/鱼 同意、/鱼 拒绝、/鱼 新会话 */
const COMMAND_RE = /^\s*[\/／]鱼\s*(暂停|安静|闭嘴|继续|恢复|说话|同意|通过|允许|拒绝|不准|新会话|换会话|重置会话)\s*(?:(\d{1,4})\s*(分钟|分|小时|h|m)?)?\s*$/i;

/** @returns {new () => typeof mediaMethods & typeof behaviorMethods & typeof sessionMethods & typeof dispatchMethods} */
function gatewayMixins() {
	return /** @type {any} */ (class {});
}

export class ChatGateway extends gatewayMixins() {
	/**
	 * @param {object} deps
	 * @param {any} deps.ctx 插件 Cordis 上下文
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {import('./clock.js').VirtualClock} deps.clock
	 * @param {() => Record<string, any>} deps.getConfig
	 * @param {(level: string, msg: string) => void} deps.log
	 * @param {import('./channels/snowluma.js').SnowLumaChannel} deps.channel
	 * @param {import('./channels/bilibili.js').BiliChannel|null} [deps.bili]
	 * @param {import('./browse.js').BiliBrowser|null} [deps.browser]
	 * @param {import('./channels/douyin.js').DouyinChannel|null} [deps.douyin]
	 * @param {import('./douyin-browse.js').DouyinBrowser|null} [deps.douyinBrowser]
	 * @param {((bytes: Buffer) => Promise<Buffer|null>)|null} [deps.canvasConvert] 没有 sharp 时转 webp
	 * @param {Record<string, any>} deps.soul index.js 提供的人格/记忆回调
	 * @param {any} [deps.voice]
	 * @param {any} [deps.stickers]
	 * @param {any} [deps.slang]
	 * @param {((agentCtx: object) => void)|null} [deps.agentSections] 给单个 agent 挂人格卡 / 瞬态块（index.js 传入 registerAgentSections）
	 * @param {any} [deps.groupAdmin]
	 * @param {any} [deps.embedder]
	 * @param {any} [deps.embeddingCfg]
	 * @param {any} [deps.diag]
	 * @param {any} [deps.vision]
	 */
	constructor({ ctx, db, clock, getConfig, log, channel, bili = null, browser = null, douyin = null, douyinBrowser = null, canvasConvert = null, soul, voice = null, stickers = null, slang = null, agentSections = null, groupAdmin = null, embedder = null, embeddingCfg = null, diag = null, vision = null }) {
		super();
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
			windowMs: () => clampReplyWindow(this.qqConfig().replyWindowMinutes) * 60_000,
			onSent: (id, /** @type {any} */ item) => {
				this.rememberOwn(id, item.text, item.channel_id);
				this.note('sent', { channelId: item.channel_id, title: item.title, text: item.text || '[图片]', reason: `重发成功（第 ${item.attempts + 1} 次）` });
			},
			onGiveUp: (/** @type {any} */ item, reason) => {
				this.note('failed', { channelId: item.channel_id, title: item.title, text: item.text || '[图片]', reason });
				this.log('warn', `[fish-soul] 放弃重发到 ${item.title || item.channel_id}：${reason}`);
			}
		});
		if (this.outbox.size() > 0) this.outbox.schedule(3000);
		/** @type {typeof safeDownload | null} */
		this.attachmentDownload = null;
		/** v0.7：语音（听 / 说）、收藏表情包、学群里的说法（都可以没有） */
		this.voice = voice;
		this.voiceGuardReady = false;
		this.pendingVoicePaths = new Map();
		this.stickers = stickers;
		// 按感觉挑表情用的嵌入模型（和记忆同一套）；没有就整条路自动降级成按文件名
		this.embedder = embedder;
		this.embeddingCfg = embeddingCfg;
		this.slang = slang;
		// 识图模型（设置页「模型 · 识图」）：配了就把用户发的图先描述成文字再喂会话模型 —— 会话模型没视觉也能"看见"。
		this.vision = vision;
		/** 群管理（入群申请）：主人回"/鱼 同意/拒绝"时用它（可能没有） */
		this.groupAdmin = groupAdmin;
		/** 给单个 agent 挂人格卡 / 瞬态块：`(agentCtx) => void`（在 setup 里调，只对那个 agent 生效） */
		this.agentSections = agentSections;
		this.diag = diag;
		/**
		 * 抖音适配器（PR2）：身份解析 / 配置归一 / 认人 / 会话标题。
		 * 授权判定仍在网关（onDouyinMessage），适配器只回答「身份键是什么、对应谁」。
		 */
		this.douyinAdapter = new DouyinAdapter({
			// 传函数：`gw.db = 新库` 的用法要跟着换（老测试这么干）
			db: () => this.db,
			getConfig,
			note: (kind, info) => this.note(kind, info),
			log: this.log,
			diag: (kind, info, level) => this.diag?.add?.(kind, info, level),
			// 抖音收件箱（结算私信用）。传函数：通道实例可能被换掉
			inbox: () => this.douyin?.inbox ?? null,
			// 抖音通道（发送 / 分享卡片用）。传函数同上
			channel: () => this.douyin ?? null,
			// 卡片分享的说明文字走网关上的 sendDouyin（和普通私信同一条路）
			sendText: (row, text, images, convId) => this.sendDouyin(row, text, images, convId)
		});
		/** sessionId → chat_session 行（只存我们建的会话） */
		/** @type {Map<string, any>} */
		this.bound = new Map();
		/** @type {Map<string, any>} */
		this.retryableTurns = new Map();
		/** @type {Map<string, Set<string>>} */
		this.unusable = new Map();
		/** @type {Map<string, any>} */
		this.turnMood = new Map();
		/** @type {Map<string, Array<{at: number, norm: string}>>} */
		this.recentSent = new Map();
		/** @type {Map<string, {at: number, norm: string}>} */
		this.lastInbound = new Map();
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
		// #160：引用查询专用的缓存，键是 (channel_id, message_id)。
		// ownMessages 不能改键形状 —— normalizeMessageEvent 用它的 .has(id) 判断
		// 「这条引用的是不是我」（那条路没有 channelId 上下文，只有裸 id）。
		// 但引用查询**有** channelId，而 message_id 只在聊天内唯一 ——
		// 用裸 id 查，A 聊天缓存过的号会被 B 聊天命中 ⇒ 引用到别人聊天里的话。
		this.ownMessagesByChannel = new Map();
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
			privateAllowList: Array.isArray(q.privateAllowList) ? q.privateAllowList.map((v) => String(v).trim()).filter(Boolean) : [],
			allFriends: q.allFriends === true, // 私聊白名单配套开关：true = 所有好友都回（旧默认行为）
			followUpCount: Number.isFinite(Number(q.followUpCount)) ? Number(q.followUpCount) : 3,
			followUpSeconds: Number.isFinite(Number(q.followUpSeconds)) ? Number(q.followUpSeconds) : 120,
			followUpSmart: q.followUpSmart === true, // #59 她说"这轮聊完了"就不接着听（默认关）
			mentionOnly: q.mentionOnly === true, // 群里只回点名：关掉接听和插话（默认关，老行为不变）
			batchMs: Number.isFinite(Number(q.batchMs)) ? Number(q.batchMs) : 3000, batchMaxWaitMs: Number.isFinite(Number(q.batchMaxWaitMs)) ? Number(q.batchMaxWaitMs) : 8000,
			replyWindowMinutes: clampReplyWindow(q.replyWindowMinutes),
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

	/**
	 * 记一条"动态"：kind = reply / memorize / interject / sent / silent / failed / paused / recalled / command …
	 * @param {string} kind
	 * @param {{ channelId?: string, who?: string, text?: string, reason?: string, title?: string, memories?: any[], recallAt?: any, speakerUnknown?: boolean, recallMiss?: string }} [opts]
	 */
	note(kind, { channelId = '', who = '', text = '', reason = '', title = '', memories, recallAt = null, speakerUnknown = false, recallMiss = '' } = {}) {
		this.decisions.unshift({
			at: Date.now(), kind, channelId, title: title || this.titleOf(channelId),
			who: String(who ?? '').slice(0, 24), text: String(text ?? '').replace(/\s+/g, ' ').slice(0, 80), reason,
			// #78：以前写死 5 条，用户把「召回条数」调到 10 后动态页永远只显示 5 条，
			// 看起来像「设置没生效」。上限跟 topK 走（再留个 20 的硬顶，别让一条动态撑爆）。
			...(Array.isArray(memories) && memories.length > 0 ? { memories: memories.slice(0, Math.min(20, Math.max(5, Number(this.getConfig?.()?.retrieval?.topK) || 5))) } : {}),
			// #78：这一轮记忆到底有没有参与。没跑 / 认不出人 / 跑了没召回到，界面要分得开 ——
			// 以前三种都是"什么都不显示"，看不出问题在哪儿
			...(recallAt !== null ? { recallChecked: true } : {}),
			...(Number(recallAt) > 0 ? { recallAt: Number(recallAt), speakerUnknown: speakerUnknown === true } : {}),
			// 没跑时带上原因（notMounted = 瞬态块压根没挂上；noSession = 挂了但找不到会话登记）
			...(Number(recallAt) > 0 || recallMiss === '' ? {} : { recallMiss: String(recallMiss) })
		});
		if (this.decisions.length > DECISION_LIMIT) this.decisions.length = DECISION_LIMIT;
	}

	masterQq() {
		return String(this.getConfig().masterQqUin ?? '');
	}

	/** 手搓 this 的老测试没给 getConfig 时返回 ''（不标主人，也不炸）。 */
	masterQqSafe() {
		try { return this.masterQq(); } catch { return ''; }
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
			batchMs: num(b.batchMs, 3000), batchMaxWaitMs: num(b.batchMaxWaitMs, 8000),
			replyWindowMinutes: clampReplyWindow(b.replyWindowMinutes)
		};
	}

	/** 抖音通道配置（PR2 起由适配器持有；网关保留同名转发，调用方不改）。 */
	douyinConfig() {
		return adapterOf(this).douyinConfig();
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

	// ───────────── 以下方法 PR2 起由 lib/douyin-adapter.js 持有；网关保留同名转发 ─────────────

	/** 抖音会话对应的 QQ 号（见适配器同名方法）。算不出返回 ''。 */
	douyinUinOf(chat) {
		return adapterOf(this).douyinUinOf(chat);
	}

	noteDouyinUinCandidate(c) {
		return adapterOf(this).noteDouyinUinCandidate(c);
	}

	douyinPersonQq(uid) {
		return adapterOf(this).douyinPersonQq(uid);
	}

	confirmDouyinUin(name) {
		return adapterOf(this).confirmDouyinUin(name);
	}

	dismissDouyinUinCandidate(name) {
		return adapterOf(this).dismissDouyinUinCandidate(name);
	}

	douyinUinCandidates() {
		return adapterOf(this).douyinUinCandidates();
	}

	douyinUinBinding(uid) {
		return adapterOf(this).douyinUinBinding(uid);
	}

	bindDouyinUin(uid, qq) {
		return adapterOf(this).bindDouyinUin(uid, qq);
	}

	douyinIdentityOfChannel(channelId) {
		return adapterOf(this).douyinIdentityOfChannel(channelId);
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
		this.retryableTurns?.clear();
	}

	/**
	 * 这个会话是不是我们自己建的（人格卡 / 瞬态块只挂在这种会话上）。
	 *
	 * 🔴 内存 `bound` 优先，查不到再问库 —— 和 {@link chatForSession} 的语义对齐。
	 *    只查内存的版本有两个漏点：
	 *      ① 宿主重启后 `bound` 在构造函数里重建，但如果会话是在那之后被**别的路径**
	 *         恢复的（不是我们的 ensureSession），内存里就没有它；
	 *      ② 判定用在「要不要注入人格」这种**放行**场景上，漏判 = 该注入的没注入
	 *         （记忆进不了提示词），比多判一次更隐蔽。
	 *    反过来多判（把用户自己的会话认成我们的）才是 #40 那个漏人格的病 ——
	 *    所以这里必须**严格按 chat_session 表的登记**认，不能用工作区 / 标题这类弱信号。
	 */
	isOurSession(sessionId) {
		if (sessionId === undefined || sessionId === null) return false;
		const id = String(sessionId);
		if (this.bound.has(id)) return true;
		return findChatSessionBySessionId(this.db, id) !== null;
	}

	/** 会话 id → 聊天信息（插件重启后 index.js 用它重建"当前说话人"）。 */
	chatForSession(sessionId) {
		const row = this.bound.get(String(sessionId)) ?? findChatSessionBySessionId(this.db, sessionId);
		return row === null || row === undefined ? null : row;
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
		// 只有真正新的实质入站消息才清掉「刚发过的话」：极短敷衍语（如"嗯""好"）或短时重复输入不清除，避免冲掉跨条复读守卫
		if (this.shouldClearRecentSent(m.channelId, m.text)) this.recentSent?.delete(m.channelId);
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
			/**
			 * 私聊白名单（`qq.privateAllowList` / `qq.allFriends`）。
			 *
			 * 为什么要这个开关：群的准入靠 `groupAllowList` 管，私聊这一支原来只判「是不是好友」，
			 * 好友申请一通过就等于放进来一个能一直触发她的人，没有任何按人收口的地方。
			 * 语义跟群对齐：名单空 = 谁都不放行（主人永远放行），要放开所有好友得显式开 `qq.allFriends`
			 * （等价于旧的默认行为，升级的人照着打开即可）。被挡下的照存记忆，日志能看出被挡的是谁。
			 */
			const listed = cfg.allFriends === true || (cfg.privateAllowList ?? []).includes(String(m.userId)) || String(m.userId) === this.masterQq();
			decision = friend && listed ? 'reply' : 'memorize';
			if (!friend) reason = '不是好友';
			else if (!listed) reason = '不在私聊白名单';
		} else {
			const called = !m.mentioned && this.callNames(cfg).some((n) => m.text.includes(n));
			/**
			 * 群里只回点名（`qq.mentionOnly`，默认关）。
			 *
			 * 为什么要这个开关：几个机器人待在同一个群，一个点名、另一个接听 → 互相触发，
			 * 每轮都算「被点名」⇒ 无限来回刷屏。闸门（白名单 / 插话概率 / 每小时上限）
			 * 全是按群和按时间的，没有一条能识别「对面也是机器人」。
			 *
			 * 打开后：接听和插话整个关掉，只在她真被 @ 或叫名字时开口。
			 * 默认关 ⇒ 老行为不变（既有测试守着「默认会接着听」）。
			 */
			const mentionOnly = cfg.mentionOnly === true;
			const gate = 该收这条({
				全听: false, 点名: m.mentioned || called,
				接听: mentionOnly ? null : this.follow.get(m.channelId) ?? null,
				条: mentionOnly ? 0 : cfg.followUpCount, 秒: cfg.followUpSeconds, 现在: Date.now()
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
				if (!stale && !paused && !mentionOnly) {
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
		// 保存额外限制：只允许已确认说话人的好友私聊或显式白名单群；全群放开不等于同意录音落盘。
		const voiceSaveAllowed = !!person?.canonical_id && !!m.userId && (m.chatType === 'private'
			? (m.subType === 'friend' || this.channel.isFriend(m.userId) || m.userId === this.masterQq())
			: m.chatType === 'group' && cfg.groupAllowList.includes(String(m.groupId)));
		if ((m.records ?? []).length > 0) await this.hearVoice(m, { saveAllowed: voiceSaveAllowed });
		if ((m.files ?? []).length > 0) await this.readAttachments(m);
		if ((m.forwards ?? []).length > 0) await this.expandForwards(m);
		// 点表情 / 戳回去是「顺手做的事」，出错不能影响这一轮主流程（也没有全局拒绝兜底）
		if (!interject) void this.reactTo(m, person).catch(() => {});
		this.note(interject ? 'interject' : 'reply', { channelId: m.channelId, who, text: m.text, reason });
		this.enqueue(m, person, cfg, { interject });
	}

	/** QQ 语音 → 文字（语音没开 / 听不了就保持"暂时听不了"）。 */
	async hearVoice(m, { saveAllowed = false } = {}) {
		m.voice = true;
		if (this.voice === null) { this.log('warn', '[fish-soul] 收到语音但语音服务没起来，按「听不到」处理'); return; }
		const saving = saveAllowed && this.getConfig().voice?.saveIncoming === true && this.getConfig().voice?.enabled === true;
		const listening = this.voice.readyFor('stt');
		if (!listening) this.log('warn', '[fish-soul] 收到语音但「听」没就绪（语音开关 / key / 模型），按「听不到」处理');
		if (!saving && !listening) return;
		const parts = [];
		const saveEpoch = voiceIncomingEpoch();
		for (const [idx, rec] of m.records.slice(0, saving ? 30 : 2).entries()) {
			if (saving && voiceIncomingEpoch() === saveEpoch && this.getConfig().voice?.enabled === true && this.getConfig().voice?.saveIncoming === true) {
				try {
					const original = await this.voice.fetchQqRecord(this.channel, rec, { preferOriginal: true, withSource: true });
					let analysisBytes;
					if (original?.bytes && ['silk', 'bin'].includes(audioExt(original.bytes)) && !original.converted) {
						const normalized = await this.voice.fetchQqRecord(this.channel, rec, { withSource: true });
						if (normalized?.converted && normalized.bytes && ['mp3', 'wav', 'ogg', 'amr'].includes(audioExt(normalized.bytes))) analysisBytes = normalized.bytes;
					}
					if (original?.bytes && voiceIncomingEpoch() === saveEpoch && this.getConfig().voice?.enabled === true && this.getConfig().voice?.saveIncoming === true) (m.voicePaths ??= []).push(saveVoiceFile('in', original.bytes, { converted: original.converted, analysisBytes }));
					else if (!original?.bytes) this.log('warn', '[fish-soul] QQ 语音没取到，未保存');
				} catch (error) { this.log('warn', `[fish-soul] QQ 语音保存失败：${String(error instanceof Error ? error.message : error)}`); }
			}
			if (listening && idx < 2) {
				const bytes = await this.voice.fetchQqRecord(this.channel, rec);
				if (bytes === null) this.log('warn', '[fish-soul] 语音取不到音频，按「听不到」处理');
				const text = bytes ? await this.voice.transcribe(bytes) : null;
				if (bytes && text === null) this.log('warn', `[fish-soul] 音频拿到了（${bytes.length} 字节）但识别失败：${this.voice.lastError || '接口没回文字'}`);
				parts.push(text === null ? '【语音（没听清）】' : `【语音】${sanitizeUserText(text)}`);
			}
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
		// #151：留住图。以前只存 text，「先发图再@我」时图在进 backlog 这一刻就丢了，
			// 她只能看到「【图片】」三个字。
		const masterId = platformOf(m.channelId) === 'douyin' ? this.masterDouyinIdentity() : this.masterQqSafe();
		list.push({ name: sanitizeName(m.nickname || m.userId, m.userId) + masterTagOf(m.userId, masterId), text: String(m.text ?? '').slice(0, 120), timeMs: m.timeMs, messageId: m.messageId, images: (m.images ?? []).slice(0, 4) });
		this.backlog.set(m.channelId, list.slice(-BACKLOG_LIMIT));
	}

	/**
	 * #151：交出 { lines, images }。
	 * lines 里带图的消息把「【图片】」改成「【图N在下面】」（N 从 1 编，标清是谁的），
	 * images 取窗口内最近 2 张（别无限累积），label 带发送者+序号，让模型能把图和后一句对上。
	 */
	takeBacklog(channelId, exclude) {
		const list = (this.backlog.get(channelId) ?? []).filter((x) => Date.now() - x.timeMs < BACKLOG_MAX_AGE_MS && !exclude.has(x.messageId));
		this.backlog.delete(channelId);
		const recent = list.slice(-10);
		// 图按时间倒序取最近 2 张，编号按正序重排（图1 = 取到的里面较早的那张）。
		const picked = [];
		for (let i = recent.length - 1; i >= 0 && picked.length < 2; i--) {
			const b = recent[i];
			for (let j = (b.images?.length ?? 0) - 1; j >= 0 && picked.length < 2; j--) {
				picked.unshift({ img: b.images[j], m: { messageId: b.messageId, nickname: b.name, userId: b.name }, backlog: true });
			}
		}
		const images = picked.map((x, i) => ({ ...x, label: `${x.m.nickname}的图${i + 1}` }));
		// 给「有图且取到了」的消息改标注。一张消息可能有多张图，只标第一张取到的。
		const labeled = new Map();
		for (const [i, x] of images.entries()) if (!labeled.has(x.m.messageId)) labeled.set(x.m.messageId, i + 1);
		const lines = recent.map((x) => {
			const n = labeled.get(x.messageId);
			if (n !== undefined && x.text === '【图片】') return `${x.name}：【图${n}在下面】`;
			return `${x.name}：${x.text}`;
		});
		return { lines, images };
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

	/** 主人发的 "/鱼 暂停 30分钟" / "/鱼 继续" / "/鱼 新会话"：只对发命令的这个聊天生效，回一句确认（不经过模型）。 */
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
		if (/新会话|换会话|重置会话/.test(verb)) {
			try {
				await this.resetSession(m.channelId, '主人命令换新会话');
				const text = '好，换了一条新会话（记忆都在，只是刚才那段对话重新开始）';
				this.note('command', { channelId: m.channelId, who: m.nickname || '主人', text: m.text, reason: '换新会话' });
				try { await this.channel.send(m.channelId, [{ type: 'text', data: { text } }]); } catch { /* 发不出去也算生效 */ }
			} catch (error) {
				this.log('warn', `[fish-soul] 主人命令换新会话失败：${String(error instanceof Error ? error.message : error)}`);
				this.note('command', { channelId: m.channelId, who: m.nickname || '主人', text: m.text, reason: '换新会话失败' });
				try { await this.channel.send(m.channelId, [{ type: 'text', data: { text: '换新会话失败，请稍后再试或到设置页看运行日志' } }]); } catch { /* 发不出去也不抛 */ }
			}
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
				// 冷路径：这一批私信的处理结果不确定（结算落 unknown）。记一条，排查时看得到为什么。
				this.diag?.add('dispatch-failed', { channelId: m.channelId, reason: String(error instanceof Error ? error.message : error).slice(0, 200) }, 'warn');
				adapterOf(this).settle(batch.items.map(x => x.m.inboxId).filter(Boolean), false, String(error));
			});
		};
		if (batch.items.length >= 20 || cfg.batchMs <= 0) { flush(); return; }
		// 🔴 #169：光有静默窗口会被「每条间隔都小于 batchMs」的持续说话无限推迟
		//    （只能靠 20 条硬顶兜底）。加「从第一条进队算起的最长等待 batchMaxWaitMs」：
		//    到点必发，窗口内继续安静合并。0 = 不限（旧行为）。
		if (batch.firstAt === undefined) batch.firstAt = Date.now();
		const maxWaitMs = Number(cfg.batchMaxWaitMs) > 0 ? Number(cfg.batchMaxWaitMs) : 0;
		const elapsed = Date.now() - batch.firstAt;
		const delay = maxWaitMs > 0
			? Math.max(0, Math.min(cfg.batchMs, maxWaitMs - elapsed))
			: cfg.batchMs;
		batch.timer = setTimeout(flush, delay);
		batch.timer.unref?.();
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

	/** 某类「这条会话不能再用」的会话 id 集合（内存 + kv）。key 区分两类原因。 */
	unusableSessions(key) {
		this.unusable ??= new Map();
		let set = this.unusable.get(key);
		if (set === undefined) {
			let saved = [];
			try { saved = JSON.parse(String(getKv(this.db, key, '[]') ?? '[]')); } catch { saved = []; }
			set = new Set(Array.isArray(saved) ? saved.map(String) : []);
			this.unusable.set(key, set);
		}
		return set;
	}

	/** 这条会话不能再用的原因：'overflow'（上下文满了）/ 'switch'（换模型被挡）/ ''（还能用）。 */
	unusableKindOf(sessionId) {
		const id = String(sessionId ?? '');
		if (id === '') return '';
		if (this.unusableSessions(OVERFLOW_SESSION_KEY).has(id)) return 'overflow';
		if (this.unusableSessions(SWITCH_BLOCKED_SESSION_KEY).has(id)) return 'switch';
		return '';
	}

	/** 记下「这条会话不能再用」（内存 + kv，重启后照样认得）。 */
	markUnusable(sessionId, key) {
		const id = String(sessionId ?? '');
		if (id === '') return;
		const set = this.unusableSessions(key);
		set.add(id);
		// 只留最近 50 条：这是个兜底名单，不该无限长
		const keep = [...set].slice(-50);
		this.unusable.set(key, new Set(keep));
		try { setKv(this.db, key, JSON.stringify(keep)); } catch { /* 写不进去也不影响这一轮 */ }
	}

	/** 这条会话已经换掉了：从名单里摘掉。 */
	forgetUnusable(sessionId, key) {
		const set = this.unusableSessions(key);
		if (!set.delete(String(sessionId ?? ''))) return;
		try { setKv(this.db, key, JSON.stringify([...set])); } catch { /* 同上 */ }
	}

	/** DSH 内只合成独立的 [语音] 段，不经 QQ 出站。 */
	async saveDesktopVoice(text) {
		try {
			// #210：DSH 桌面端不经过 cleanOut，模型同样会用单换行把 [语音] 粘在前文后面，
			// 这里自己按空行拆段找 [语音]，所以入口必须先提纯。
			const raw = normalizeVoiceParagraphs(String(text ?? '').trim());
			if (!raw || SILENT_RE.test(raw)) return;
			for (const p of raw.split(/\n{2,}/)) {
				if (!VOICE_RE.test(p)) continue;
				// 和 QQ 那条同理：念之前剥掉表情码（文字路上它有用，语音路上会被念出来）
				const plain = stripForSpeech(抠正文图(p.replace(VOICE_RE, '')).净文字).text.trim();
				if (!plain || this.getConfig?.()?.voice?.desktopTts !== true || this.getConfig?.()?.voice?.enabled !== true) continue;
				const bytes = await this.voice.synthesize(plain);
				if (bytes && this.getConfig?.()?.voice?.desktopTts === true && this.getConfig?.()?.voice?.enabled === true) saveVoiceFile('out', bytes);
				else this.log('warn', `[fish-soul] DSH 语音未生成：${this.voice.lastError || '文字超长、配额不足或配置未就绪'}`);
			}
		} catch (error) { this.log('warn', `[fish-soul] DSH 语音保存失败：${String(error instanceof Error ? error.message : error)}`); }
	}

	/** 只进内存、不写库：给「从库里读出来之后回填」用。 */
	rememberOwnCacheOnly(messageId, text, channelId = '') {
		if (!messageId) return;
		const id = String(messageId);
		this.ownMessages.set(id, text);
		if (this.ownMessages.size > OWN_LIMIT) this.ownMessages.delete(this.ownMessages.keys().next().value);
		const ch = String(channelId ?? '');
		if (ch === '') return;
		this.ownMessagesByChannel.set(ownKey(ch, id), text);
		if (this.ownMessagesByChannel.size > OWN_LIMIT) this.ownMessagesByChannel.delete(this.ownMessagesByChannel.keys().next().value);
	}

	/**
	 * 记下她自己刚发出去的一条消息（#160）。
	 *
	 * 内存 + 库都写：内存给这次运行用（快），库给重启后 / 跨天复用消息号时用。
	 * 写库失败只记 warn —— 这是引用回复的兜底，不能因为它把发送流程打挂
	 * （本项目踩过：定时器路径上抛错 = 进程退出）。
	 */
	rememberOwn(messageId, text, channelId = '') {
		if (!messageId) return;
		this.rememberOwnCacheOnly(messageId, text, channelId);
		const ch = String(channelId ?? '');
		// 没给 channelId 就只进内存 —— 宁可在库里留个空，也不要写进错的聊天
		// （消息号只在聊天内唯一，写错聊天 = 引用到别人的话）。
		if (ch === '') return;
		try {
			this.db.prepare('INSERT OR REPLACE INTO own_message(channel_id, message_id, text, at) VALUES(?,?,?,?)')
				.run(ch, String(messageId), String(text ?? '').slice(0, 500), Date.now());
			this.pruneOwnMessages();
		} catch (error) {
			this.log('warn', `[fish-soul] 出站消息落库失败（重启后引用她会退化成问 OneBot）：${String(error instanceof Error ? error.message : error)}`);
		}
	}

	/**
	 * 清掉太老的 own_message（默认留 7 天）。
	 * 一天最多跑一次：每发一条消息都 DELETE 全表不值得。
	 */
	pruneOwnMessages() {
		const today = new Date().toISOString().slice(0, 10);
		try {
			if (getKv(this.db, 'own_message.pruned', '') === today) return;
			setKv(this.db, 'own_message.pruned', today);
			this.db.prepare('DELETE FROM own_message WHERE at < ?').run(Date.now() - 7 * 86_400_000);
		} catch { /* 清理失败不影响发送 */ }
	}

	/**
	 * 判定这条入站消息是否应该清掉该频道的「最近刚发过的话」：
	 * - 规整化后 ≤ 2 字（空消息 / 纯图 / "嗯""好""哦哦" 等敷衍短语）不清除；
	 * - 同一频道 3 分钟内（180s）跟上一条入站内容规整化后完全一致（断线重推 / 重复发送）不清除；
	 * - 其余实质性新消息记下 `{ norm, at }` 并返回 true。
	 */
	shouldClearRecentSent(channelId, text, now = Date.now()) {
		const inNorm = normSentText(text);
		if ([...inNorm].length <= 2) return false;
		const store = (this.lastInbound ??= new Map());
		const prev = store.get(channelId);
		if (prev && prev.norm === inNorm && now - prev.at <= 180_000) return false;
		store.set(channelId, { norm: inNorm, at: now });
		return true;
	}

	/**
	 * 跨条复读守卫：同一频道 5 分钟内跟刚发过的内容（规整化后）一字不差或高相似换说法的段落，拦掉不发。
	 * 模型遇到相近输入或重推时偶尔把自己上一条消息原样再发一遍或换句近义词复读。
	 * 只拦无实质新输入（或短时重复输入）时模型复读；收到实质新消息时会由 shouldClearRecentSent 清掉记录。
	 * 短句（规整化后 <12 字）允许重复。
	 */
	dropRepeats(row, paragraphs) {
		const store = (this.recentSent ??= new Map());
		const now = Date.now();
		const hist = (store.get(row.channel_id) ?? []).filter((h) => now - h.at <= 300_000);
		const dups = new Set(findRepeatedParagraphs(hist, paragraphs, { now, windowMs: 300_000 }));
		if (dups.size > 0) {
			this.note('filtered', { channelId: row.channel_id, title: row.title, text: paragraphs.filter((_, i) => dups.has(i)).join(' / ').slice(0, 120), reason: '跟刚发的消息重复或近义换说法，跨条复读没再发' });
		}
		return paragraphs.filter((_, i) => !dups.has(i));
	}

	/** 发送成功后把这轮发出去的段落记进「最近发过的」，给下一轮跨条复读比对用。 */
	noteSent(row, paragraphs) {
		const store = (this.recentSent ??= new Map());
		const now = Date.now();
		const hist = (store.get(row.channel_id) ?? []).filter((h) => now - h.at <= 300_000);
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
		// 兜底：模型自己造的 [表情:名字] 格式 —— 库里有的换成真图发，没有的原样保留（#189）
		feelText = 兜底表情包(feelText, this.listStickers(row.workspace_path));
		const picked = 抠正文图(feelText);
		const 图 = this.moodPick(profile, picked.图, row);
		const 净文字 = this.cleanOut(picked.净文字, row);
		if (净文字.trim() === '' && picked.净文字.trim() !== '' && 图.length === 0) return true;
		const platform = platformOf(row.channel_id);
		if (platform === 'bili' || platform === 'douyin') {
			const images = await this.dmImages(row, 图, st);
			// [语音] 段：主人的话转成语音发到 QQ 私聊，其余去掉标记当文字发
			const relayed = (await this.relayDmVoice(row, 净文字)).split(/\n{2,}/).map((p) => p.replace(VOICE_RE, '')).filter((p) => p.trim() !== '');
			const keptParas = this.dropRepeats(row, relayed);
			const dmText = keptParas.join('\n\n');
			if (dmText === '' && images.length === 0) return true;
			let ok;
			let delivered;
			let detail = '';
			// 卡片没发出去的原因（只有抖音那条路有）。QQ / B站 没有这个概念。
			let cardFailed = '';
			if (platform === 'bili') {
				ok = await this.sendBili(row, dmText, images);
				delivered = ok; // B站 那条是直连接口，onMessage 就带 message_id，没有「静默被吞」这回事
			} else {
				// convId 是目标会话 ID：sendDouyin 拿它确认收件人，拿不到就拒绝发送。
				// deliveryScope = 本轮的 sessionId：同一轮重试账本认得出（不重复发卡），
				// 下一轮是新 id（她再说一次同一个视频能发出第二张）。
				const r = await this.sendDouyin(row, dmText, images, convId, sessionId);
				ok = r.ok === true;
				delivered = r.delivered === true;
				// 具体原因要留下来。以前写死「发送失败」，真机上分不清是身份校验拒的、
				// 进不去会话，还是风控吞的（2026-11-11 连着三轮都只看到这四个字）。
				detail = r?.error || '';
				// 卡片失败（浏览器没跑 / 收件人核验不过）：内容退回文字发出去了，但卡片没发。
				// 这两件事要分开：ok 说的是「内容送到没有」，卡片的问题单独记。
				cardFailed = String(r?.cardFailed ?? '');
			}
			// 🔴 「动作做了」和「对方真能看见」分开记：
			//    抖音风控会静默吞消息（Enter 按了、UI 没报错、消息没进会话）。
			//    只记 sent 会让动态页/日记看起来一切正常，实际上对方什么都没收到。
			// 🔴 卡片没发出去但**退回的链接已经发过去了**：内容是收到了的，不能记「发送失败」
			//    （那会让收件箱推进到「待核实」，主人被提示回复没发出去，其实对方收到了链接）。
			//    卡片的问题单独写进 reason，不影响 sent / unconfirmed 的判定。
			const cardNote = cardFailed ? `（原生卡片没发出去：${cardFailed.slice(0, 40)}）` : '';
			const kind = !ok ? 'failed' : (delivered ? 'sent' : 'unconfirmed');
			const reason = !ok ? (detail || '发送失败') : (delivered ? cardNote : ('发出去了但回读没看到，可能被风控吞了' + cardNote));
			this.note(kind, { channelId: row.channel_id, title: row.title, text: dmText || '[图片]', reason, memories, ...recallNote });
			if (ok && dmText) {
				this.noteSent(row, keptParas);
				this.soul.journalOut?.(row.channel_id, dmText, { ownerId: st.journalOwnerId ?? null });
			}
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
			// 表情码在文字那条路上有意义（抖音单独一段写 [比心] 会发成表情图），
			// 但语音没有「表情段」，原样念出来就是「方括号比心方括号」。念之前剥掉。
			const spoken = stripForSpeech(paragraphs[i]);
			if (spoken.removed.length > 0) {
				this.note('filtered', { channelId: row.channel_id, title: row.title, text: paragraphs[i], reason: `念之前剥掉了 ${spoken.removed.join('')}` });
			}
			const moodOk = this.moodVoice(profile);
			const bytes = spoken.text !== '' && moodOk ? await this.voice?.synthesize(spoken.text) ?? null : null;
			if (bytes) voiced[i] = { type: 'record', data: { file: `base64://${bytes.toString('base64')}` } };
			else if (paragraphs[i] !== '') {
				this.note('filtered', { channelId: row.channel_id, title: row.title, text: paragraphs[i], reason: `语音没发成（${moodOk ? this.voiceFailReason(paragraphs[i]) : `${profile.mood || profile.tone || '心情'}，不想说话`}），改成打字` });
			}
		}
		const messages = paragraphs.map((p, i) => (voiced[i] ? [voiced[i]] : isGroup ? 拆成消息段(p) : [{ type: 'text', data: { text: p } }]));
		// #161：图片一张一条，不并进最后那条文字。
		// 以前 push 进最后一条的段数组 ⇒ OneBot 收到一个 message 里 [text, image] 两段
		// ⇒ QQ 渲染成「文字带着图」一个气泡，用户没法单独转发那张图，排布也挤。
		for (const one of images) messages.push([one]);
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
				this.rememberOwn(id, text, row.channel_id);
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
			this.soul.journalOut?.(row.channel_id, paragraphs.join('\n'), { proactive: st.proactive === true, ownerId: st.journalOwnerId ?? null });
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

Object.assign(ChatGateway.prototype, mediaMethods, behaviorMethods, sessionMethods, dispatchMethods);
