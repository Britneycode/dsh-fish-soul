import { sleep } from '../time-util.js';
import { DouyinInbox } from '../douyin-inbox.js';
import {
	parseSingleConversation, isSingleConversation, conversationIdentity,
	senderBelongsToConversation, peerUidFromConversation, isDouyinConversationId
} from '../douyin-conversation.js';
/**
 * douyin.js —— 抖音小号：专用浏览器（Edge / Chrome …，CDP 控制）+ 网页版私信渠道。
 *
 *  - 浏览器用插件自己的 profile（$DSH_HOME/fish-soul/douyin-browser/<浏览器>），和你平时用的浏览器互不影响；
 *    登录就在这个窗口里扫码，登录态留在 profile 里；
 *  - 你自己把窗口 / 标签页关了 = 暂停（不会自己再弹出来），设置页点「启动」才恢复；
 *    浏览器崩了会自动重连，最多 3 次（每次间隔 30 秒），再不行就停下等你点；
 *  - 私信没有推送：每 30–60 秒（随机）看一眼会话列表，有未读 / 有变化的会话进去读最近 20 条，
 *    和上次读到的窗口对比，只把新消息交给网关；第一次见到的会话只记基线（有未读的话补最后几条）；
 *  - 认人只能靠会话里显示的名字（网页版拿不到抖音号）；进会话读消息会把消息标成已读；
 *  - 页面结构自检（canary）：启动时 / 每 6 小时 / 连续失败 3 次后跑一遍，抖音改版认不出页面时
 *    先停掉自动回复，设置页标红，并在 QQ 上提醒主人一次。
 */
import { join } from 'node:path';
import { getKv, setKv } from '../db.js';
import { checkLogin, dmList, readDM, sendDM, sendEmoji, sendImage, drainPushFrames } from './vendor/douyin-bridge/douyin-dm.mjs';
import { knownEmojiNames } from './vendor/douyin-bridge/media.mjs';
import { canary } from './vendor/douyin-bridge/selectors.mjs';
import { shareVideoToFriend } from './vendor/douyin-bridge/douyin-share.mjs';
import {
	DOUYIN_HOME, DOUYIN_IDENTITY_BLOCKED, errText, sha1,
	convTimeMs, messageFingerprint, newFrom, occurrenceIndexes, messageIdFor,
	isGroupConversation, pushFrameVerdict, matchConversationByPreview, groupSender,
	selfUidFromKv, stripQuotes
} from './douyin-pure.js';
import { DouyinHost } from './douyin-host.js';

export {
	DOUYIN_HOME, DOUYIN_IDENTITY_BLOCKED,
	convTimeMs, messageFingerprint, newFrom, occurrenceIndexes, messageIdFor,
	isGroupConversation, pushFrameVerdict, matchConversationByPreview, groupSender,
	DouyinHost
};

const POLL_TIMEOUT_MS = 3 * 60_000;
const CANARY_EVERY_MS = 6 * 3600_000;
/**
 * 推送路「丢了一条消息」的日志节流窗口。
 *
 * 推送帧每轮都会重看同一批（未解决的丢包会一直丢），不节流就是几百行 warn。
 * 计数仍然照实累加，所以「丢了多少」查得到，只是不重复喊。
 */
const PUSH_DROP_LOG_GAP_MS = 10 * 60_000;
/** #72：自检没过 → 刷新页面自救的冷却（页面真改版时别一直刷） */
const REFRESH_COOLDOWN_MS = 10 * 60_000;
const READ_LIMIT = 20;
const MAX_READS_PER_POLL = 5;
const RECENT_MS = 15 * 60_000;
// 🔴 读失败后**多久才重试**：抖音网页版私信只在首次进会话时请求接口，
// 轮询时 hook 常抓不到 → convId 空 → 读失败。如果失败不写进游标，
// 会话会永远「有变化」→ 每轮都读 → 每轮都失败 → gap 死循环。
// 失败后 5 分钟内不再重读（不是不读了，是等窗口过了 / 有真新消息再来）。
const FAIL_RETRY_MS = 5 * 60_000;
// 连续失败到这个次数后，连「有未读」也不再绕过熔断（否则恒有未读 + 恒失败 = gap 无界增长）
const FAIL_HARD_AFTER = 3;
const WINDOW_KEEP = 30;
const INJECT_ON_FIRST_READ = 3;
/**
 * 推送路「缺昵称」的帧最多攒多久。
 *
 * 陌生人第一次发私信时推送路拿不到昵称（`douyin.name.<identity>` / 游标里都没有），
 * 而轮询路要等下一轮才可能读到那个会话。以前这些帧直接丢掉，于是「两边互等 ⇒
 * 消息永远进不来」。现在先攒在内存里，轮询路学到昵称就补入库。
 *
 * 有时限：超时还是学不到就真丢（记账 + 留痕），不能无限攒。
 */
const PARKED_TTL_MS = 10 * 60_000;
/** 攒的会话数上限（陌生人批量发私信时别把进程内存撑爆）。 */
const PARKED_MAX_CONVS = 20;
/** 单个会话最多攒多少条（更早的丢，记账）。 */
const PARKED_MAX_MESSAGES = 50;
/**
 * 「读失败」计数多久没再被碰过就算孤儿。
 *
 * 会话改名 / 老版本 key 格式不同 / 手动清过 kv 之后，`douyin.fails.*` 会留下
 * 没有对应游标的计数，面板于是误报「1 个会话上次读取失败」。
 * 但**不能**只看「有没有游标」：从没读成功过的陌生人会话本来就没有游标，
 * 那正是要重试的对象。所以按时间判 —— 一小时没动静的才算孤儿。
 */
const ORPHAN_FAIL_TTL_MS = 60 * 60_000;

/** 一条抖音私信 → 入站消息（与 QQ 的 normalizeMessageEvent 同形）。不该当消息的返回 null。群聊按发送者分人。 */
export function normalizeDouyinMessage(m, { name, timeMs, messageId, group = false, members = {}, identity = '', convId = '' }) {
	// 🔴 fromMe 是三态：true（我发的）/ false（对方发的）/ null（算不出，拿不到 selfSecUid）。
	//    这个函数是纯函数，输入也可能**没有** fromMe 字段（DOM 路 / 测试构造）——
	//    那种按「对方发的」处理（保持原有契约：不知道就当成要处理的消息）。
	//    只有**明确是自己发的**（true）才拒。注入那侧已收紧（eligible 只认 === false）。
	if (!m || m.fromMe === true || m.system || m.unsupported) return null;
	const media = m.media ?? {};
	const images = [];
	const links = [];
	let text = String(m.text ?? '').trim();
	if (m.type === 'image') {
		const src = String(media.data || media.src || '');
		// 🔴 抖音的「图片表情」（那个柯基狗那种）在协议里就是 type:'image'，
		//    和普通照片分不开（decodeMessageNode 解出的 media 只有 {uri,width,height}，
		//    DOM 路靠 CSS class 区分，而图片表情渲染在 MessageItemImage* 下）。
		//    所以这里用启发式：小图 / gif / webp 大概率是表情包，标成 sticker，
		//    让模型知道「这可能是个表情，想收就写 [收藏表情:名字]」。
		//    阈值 300px 是拍的（真机没有尺寸样本可校准）——宁可多标（模型自己判断收不收），
		//    也不要漏标（漏了它永远不知道能收藏）。
		const w = Number(media.width) || 0;
		const h = Number(media.height) || 0;
		const mime = String(media.mime || media.format || media.type || '').toLowerCase();
		const looksLikeSticker = (w > 0 && h > 0 && Math.max(w, h) <= 300) || /gif|webp/.test(mime);
		if (src) images.push(looksLikeSticker ? { url: src, sticker: true } : { url: src });
		text = looksLikeSticker ? '【表情】' : '【图片】';
	} else if (m.type === 'emoji') {
		const n = String(media.name ?? '').trim();
		// 表情的图**一并推给模型**：她得先"看见"这张表情，才会想着收藏 / 以后发出来。
		// 带名字的（面板里的比心 / 捂脸…）以前只变成一行 [比心] 文本，模型看不到图。
		// 标成表情则是给收藏那条路认 —— 收藏时优先挑表情，面板上也能认出来。
		const src = String(media.data || media.src || '');
		if (src) images.push({ url: src, sticker: true });
		if (n) text = `[${n}]`;
		else text = '【表情】';
	} else if (m.type === 'voice') {
		text = `【语音${media.seconds ? ` ${media.seconds} 秒` : ''}（听不了）】`;
	} else {
		text = text.replace(/【/g, '〔').replace(/】/g, '〕');
	}
	if (m.shareAweme) {
		links.push(`https://www.douyin.com/video/${m.shareAweme}`);
		if (!/分享/.test(text)) text = `【分享视频】${text}`;
	}
	if (text === '' && images.length === 0) return null;
	if (group) {
		const who = groupSender(m, members);
		// 认不出是谁说的（DOM 里的媒体消息、接口没带发送者）：不能把整个群当成一个人，丢掉
		if (who.userId === '') return null;
		const senderUid = String(m?.senderId || m?.secUid || '').trim();
		const groupIdentity = /^\d+$/.test(senderUid) ? `douyin:${senderUid}` : '';
		return {
			channel: 'douyin',
			chatType: 'group',
			channelId: `douyin-group:${name}`,
			targetId: name,
			groupId: name,
			// 🔴 身份键必须是 `douyin:<数字uid>`（2026-11-19 真机修）。
			//    网关的群消息入口按 isIdentityKey(userId) 判身份 —— 昵称 / `uid:<id>`
			//    都过不了 ⇒ 群里每条消息都被「群成员身份未确认」拒掉，一条都回不了。
			//    跟私信对齐（2026-11-10 那次「私信不用昵称」的同一条道理）：
			//    昵称可改名、可同名冒充，认出「是谁」不该靠它；昵称留在 nickname 里。
			//    `groupSender` 的 userId 是**昵称**（它是有契约的纯函数，不动它），
			//    所以身份键在这儿用**消息自己的 senderId** 拼。
			//    认不出数字 uid 的退回昵称 —— 网关会按「身份未确认」拒掉，
			//    但**不猜**：昵称不能当身份（可同名冒充）。
			userId: groupIdentity !== '' ? groupIdentity : who.userId,
			nickname: who.nickname,
			// 群聊的「会话名」是整个群，不是发言的人 —— 跟私信的语义对齐，出口不用改
			peerName: name,
			subType: '',
			messageId,
			mentioned: false,
			replyId: null,
			text: text.slice(0, 1000),
			images,
			links,
			timeMs
		};
	}
	// 🔴 单聊认人：只用**会话身份**（`douyin:<对方uid>`）。
	//
	//    以前这里硬编码 `userId: name`（会话名 = 抖音昵称），于是「主人是谁」靠昵称比对 ——
	//    主人一改昵称就认不出来，别人起个同名就能冒充。
	//
	//    身份键统一是 `douyin:<数字uid>`：入库前由 `normalizeDouyinIdentity` 归一
	//    （`uid:<id>` 群聊老格式、裸数字都折成这一种），所以同一个人在群里和私信里
	//    是同一行 person，不会各记一套记忆。
	//
	//    ⚠️ `channelId` **仍然按会话名**：私信面板是按名字打开会话的，
	//    改成 ID 会导致 sendDM/enterChat 全部找不到人。这两件事必须分开：
	//    认人用 ID，找会话用名字。
	// 昵称、以及单条消息的 senderId 都**不**当作身份：前者可被同名冒充，
	// 后者无法证明属于当前会话（见 docs/douyin-identity-validation.md）。
	// 拿不到会话身份时返回 null —— 上层会把这条当成「身份未验证」隔离，而不是猜一个。
	if (identity === '') return null;
	const sid = String(m?.senderId ?? '').trim();
	return {
		channel: 'douyin',
		chatType: 'private',
		channelId: `douyin:${name}`,
		targetId: name,
		groupId: null,
		userId: identity,
		nickname: name,
		// 会话名单独留一份：出口要靠它找会话，认人不能靠它。
		// 名字只作为展示信息，不能用于身份授权。
		peerName: name,
		// 会话 ID（`0:1:uidA:uidB`）—— 发送前用它校验目标，不用昵称。
		convId,
		senderId: sid,
		subType: '',
		messageId,
		mentioned: true,
		replyId: null,
		text: text.slice(0, 1000),
		images,
		links,
		timeMs
	};
}

/** 真正的页面驱动（测试里换成假的）。 */
function pageDriver(host) {
	const b = () => {
		if (!host.running) throw new Error('抖音浏览器没在运行');
		return host.browser;
	};
	return {
		checkLogin: async () => (await checkLogin(b())).loggedIn === true,
		list: () => dmList({ browser: b(), limit: 30 }),
		read: (name, options = {}) => readDM({ browser: b(), uname: name, limit: READ_LIMIT, ...options }),
		// expectConvId：发送前用它校验「当前打开的会话确实是目标会话」。
		// 昵称只能用来找会话，不能用来确认身份。
		sendText: (name, text, expectConvId) => sendDM({ browser: b(), text, uname: name, expectConvId }),
		sendImage: (name, file, expectConvId) => sendImage({ browser: b(), file, uname: name, expectConvId }),
		sendEmoji: (name, emoji, expectConvId) => sendEmoji({ browser: b(), name: emoji, uname: name, expectConvId }),
		// 已知的表情名（给提示词用）。被动攒的：只有读完私信发现有不认识的表情才会去抓面板，
		// 所以刚起来时可能是空的 —— 调用方按空处理
		emojiNames: (limit) => knownEmojiNames(limit),
		canary: () => canary(b())
	};
}

/**
 * 私信轮询渠道。onMessage(m) 收到的是归一化后的入站消息，回不回由网关决定。
 */
export class DouyinChannel {
	/**
	 * @param {object} deps
	 * @param {DouyinHost} deps.host
	 * @param {ReturnType<typeof pageDriver>} [deps.driver]
	 * @param {(key: string, text: string|null) => void} [deps.notify]
	 * @param {[number, number]} [deps.pollRangeMs]
	 * @param {[number, number]} [deps.typingMs] 打字延迟（基础下限 / 上限）
	 */
	constructor({ host, db, getConfig, log, onMessage, notify, driver, diag, pollRangeMs = [30_000, 60_000], typingMs = [1500, 3000], firstPollMs = 5000 }) {
		this.host = host;
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.onMessage = onMessage;
		this.inbox = new DouyinInbox(db, diag);
		this.drainingInbox = false;
		this.notify = notify ?? (() => {});
		this.driver = driver ?? pageDriver(host);
		this.pollRangeMs = pollRangeMs;
		this.typingMs = typingMs;
		this.firstPollMs = firstPollMs;
		this.timer = null;
		this.running = false;
		this.gen = 0;
		this.polling = false;
		this.lastPollAt = 0;
		this.lastError = '';
		this.failures = 0;
		this.lastCanaryAt = 0;
		this.canaryReport = null;
		/** #72：上一次「刷新页面自救」的时间（冷却用） */
		this.lastRefreshAt = 0;
		/** 抖音改版认不出页面：自动回复先停（只记不回） */
		this.replyPaused = false;
		this.sendChain = Promise.resolve();
	}

	cfg() {
		const d = this.getConfig() ?? {};
		return { enabled: d.enabled === true, autoReply: d.autoReply === true };
	}

	get connected() {
		return this.running && this.host.running && this.host.loggedIn === true;
	}

	status() {
		return {
			running: this.running,
			// 「真的能用」= 轮询循环活着 && 浏览器在跑 && 登录态正常。
			// 🔴 单看 `running` 会误判：`pollOnce` 在 `!this.host.running` 时**直接 return
			//    且不记错误**，所以浏览器崩了/被暂停，轮询循环照样活着、`running` 仍是 true。
			//    `connected` 是那个 getter 的结果，和 QQ 的 `connected`、B站的 `loggedIn`
			//    语义对齐 —— 诊断页判这个才看得出「真的不能用」。
			connected: this.connected,
			// ⚠️ 暂停时 `host.running` 仍是 true（只是停了轮询），所以 `connected` 看不出来 ——
			//    单独给出来，让诊断页能说清「是被暂停了」而不是「没跑」。
			paused: this.host?.paused === true,
			lastPollAt: this.lastPollAt,
			lastError: this.lastError,
			replyPaused: this.replyPaused,
			canary: this.canaryReport,
			bootstrapped: getKv(this.db, 'douyin.bootstrapped', false) === true,
			inbox: this.inbox.status(),
			// 身份是否仍然被阻断。现在**按证据判断**，不是常量：
			//   有会话 ID 才算知道「这是谁的会话」，而会话 ID 要能推出对端，
			//   就得先知道自己是谁（`douyin.selfUid`）。两者缺一，继续按未验证处理。
			// 硬开关 DOUYIN_IDENTITY_BLOCKED 仍然优先 —— 它是一键回退用的保险丝。
			identityBlocked: DOUYIN_IDENTITY_BLOCKED || !this.identityReady(),
			// 给设置页显示「还差什么」，别让用户猜。
			identityState: {
				disabledByFlag: DOUYIN_IDENTITY_BLOCKED,
				knowsSelfUid: this.selfUids().length > 0,
				// 🔴 把学到的 uid **显示出来**。以前只给一个布尔值，用户无从知道
				//    这个抖音号自己是谁。插件能从任意一条私信里学到自己是谁（`learnSelfUid`），
				//    这里把结果交出去 —— 注意这是**机器人自己**的 uid，不是用户的。
				selfUids: this.selfUids(),
				// 🔴 配置错填（填了跟真实 uid 对不上的值，比如账号短号）—— 要显式报出来，
				//    否则「填了但用不上」会静默失效，用户看到的是「她不回我」，
				//    完全想不到是配置。真机踩过：填了短号 → 认领分支比对不上 → 昵称候选永远不弹。
				masterUidMismatch: this.masterUidMismatch(),
				conversationIdSupported: true
			},
			// 推送路的运行计数，用来确认它真的在跑、解出了多少帧。
			pushStats: this.pushStats ?? { runs: 0, frames: 0, stored: 0 }
		};
	}

	/**
	 * 已知的抖音表情名（给提示词用：她知道名字就能写 `[比心]` 发出去）。
	 * 空数组是正常情况——这个表要读完私信发现有不认识的表情才会去抓面板。
	 */
	emojiNames(limit = 40) {
		try { return this.driver.emojiNames?.(limit) ?? []; } catch { return []; }
	}

	start() {
		if (this.running) return;
		this.running = true;
		const gen = ++this.gen;
		void this.host.start();
		const loop = async () => {
			if (!this.running || gen !== this.gen) return;
			await this.pollOnce().catch(() => {});
			if (!this.running || gen !== this.gen) return;
			const [lo, hi] = this.pollRangeMs;
			this.timer = setTimeout(loop, lo + Math.floor(Math.random() * Math.max(0, hi - lo)));
			this.timer.unref?.();
		};
		this.timer = setTimeout(loop, this.firstPollMs);
		this.timer.unref?.();
	}

	stop() {
		this.running = false;
		this.gen++;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	restart() {
		this.stop();
		if (this.cfg().enabled) this.start();
	}

	/**
	 * 推送路丢消息要留痕，但不能刷屏。
	 *
	 * 同一个原因 10 分钟内只写一条 warn —— 推送路每轮都会重看同一批帧，
	 * 一条未解决的丢包会变成几百行日志。计数照常累加（在 `pushStats` 上），
	 * 所以「丢了多少」仍然查得到，只是不重复喊。
	 *
	 * @param {string} reason 原因键（noIdentity / noName）
	 * @param {string} message 人话说明
	 */
	notePushDrop(reason, message) {
		this.pushDropAt = this.pushDropAt ?? {};
		const now = Date.now();
		if (now - Number(this.pushDropAt[reason] ?? 0) < PUSH_DROP_LOG_GAP_MS) return;
		this.pushDropAt[reason] = now;
		this.log('warn', `[fish-soul] ${message}`);
	}

	/**
	 * 消费 WebSocket 推送帧里的新消息。
	 *
	 * 轮询路在「目标会话已经打开」时读不到数据（抖音不发新请求，CDP 无响应可取）。
	 * 推送帧不依赖发请求，每条新消息都会推一帧。这里把帧里的消息直接入库，
	 * 不经过 readDM，所以不受那个限制。
	 *
	 * 昵称从轮询路学来的游标里反查（`douyin.conv.<hash>` 的值带 name 和 identity）。
	 * 查不到就先用 DOM 预览兜底认一次；还认不出就**攒着**（`parkedPush`）等下一轮，
	 * 不猜也不丢 —— 见 `parkPushFrame`。
	 */
	async consumePushFrames() {
		const browser = this.host?.browser;
		if (!browser || !Array.isArray(browser.events)) return;
		// 事件游标。真 Browser 用**单调序号**（`eventCursor()`，只增不减）——
		// 事件缓冲会裁剪头部、导航还会清空，长度 / indexOf 都会跟下标脱钩。
		//
		// ⚠️ 没有 `eventCursor` 的假 browser（测试手造的、只有 `events` 的）必须**原样**
		//    走老的 indexOf 语义，不能换成 `events.length`：老逻辑在「锚点事件被裁掉时
		//    indexOf 返回 -1 ⇒ 从头重扫」这个行为上有契约（`test/douyin-read-cache.mjs`
		//    的「裁剪后仍消费新推送、同一帧不重复消费」守着它）。换成长度就把这条打挂了。
		let since;
		if (typeof browser.eventCursor === 'function') {
			since = Number(this.pushCursor ?? 0);
			this.pushCursor = browser.eventCursor();
		} else {
			const previous = this.pushLastEvent ? browser.events.indexOf(this.pushLastEvent) : -1;
			since = previous + 1;
			this.pushLastEvent = browser.events.at(-1);
		}
		const frames = drainPushFrames(browser, since);
		// droppedNoIdentity / droppedNoName 是「丢了多少」的账 —— 以前这两条
		// 是静默 continue，丢了什么都查不到，只能靠用户报「消息不回复」。
		// `parked` 是「先攒着等昵称」的条数，和「真丢了」分开记。
		this.pushStats = this.pushStats ?? {
			runs: 0, frames: 0, stored: 0,
			droppedNoIdentity: 0, droppedNoName: 0, parked: 0,
		};
		this.pushStats.runs++;
		this.pushStats.frames += frames.length;
		this.parkedPush = this.parkedPush ?? new Map();
		// uid → 昵称：从轮询路存的游标里反查
		const nameByIdentity = this.pushNames();
		if (frames.length) await this.learnPushNames(frames, nameByIdentity);
		for (const { convId, messages } of frames) {
			this.learnSelfUid(convId, messages);
			const identity = conversationIdentity(convId, this.selfUids());
			// 🔴 这两条以前是**静默 continue**：消息在入库之前就没了，
			//    连 unknown / gap 都进不去，日志和界面都看不见 ——
			//    表现就是「uid 和 convId 都解出来了，但就是不回复」。
			//    现在先问纯函数「这一帧能不能处理」，不能就留痕（节流）+ 记账。
			const verdict = pushFrameVerdict({
				identity,
				name: identity === '' ? '' : nameByIdentity.get(identity),
				convId,
				selfUidCount: this.selfUids().length,
			});
			if (!verdict.ok) {
				// 🔴 缺昵称**不丢**：陌生人第一次发私信时这里必然缺（没有游标、
				//    DOM 里也可能还没渲染出那一行），丢了就永远收不到 —— 而轮询路
				//    恰恰要等「推送路认出来」才有昵称，两边互等 = 死锁。
				//    现在先攒着，轮询路读到那个会话（或 DOM 兜底认出来）就补入库。
				//    ⇒ 所以这条**不记在 droppedNoName 上**：攒着不是丢，
				//      真丢是「攒到过期还学不到」（见 flushParkedPush）。
				if (verdict.reason === 'noName') {
					this.parkPushFrame(identity, convId, messages);
					continue;
				}
				this.pushStats[verdict.stat] = (this.pushStats[verdict.stat] ?? 0) + 1;
				this.notePushDrop(verdict.reason, verdict.message);
				continue;
			}
			try {
				this.storePushMessages({ name: verdict.name, convId, identity, messages });
			} catch (error) {
				this.log('warn', `[fish-soul] 推送帧入库失败：${errText(error)}`);
			}
		}
		// 上一轮（或更早）攒下的：这一轮昵称学到了就补入库，学不到就等
		// （过 PARKED_TTL_MS 才真丢）。没有新帧也要跑 —— 昵称是轮询路学的。
		this.flushParkedPush(nameByIdentity);
		this.drainInbox().catch((e) => {
			const msg = errText(e);
			if (msg !== this.lastDrainError || Date.now() - (this.lastDrainErrorAt ?? 0) > 3600_000) {
				this.lastDrainError = msg; this.lastDrainErrorAt = Date.now();
				this.log('warn', `[fish-soul] 抖音收件队列异常（内层消息已单独记录）：${msg}`);
			}
		});
	}

	/** uid → 昵称：轮询路游标里带的 name + 推送路自己学到的 `douyin.name.<identity>`。 */
	pushNames() {
		const nameByIdentity = new Map();
		try {
			// 两个来源：轮询路存的游标（带 name 和 identity），以及推送路自己学到的 douyin.name.<identity>
			const cursors = this.db.prepare("SELECT value FROM kv WHERE key LIKE 'douyin.conv.%' AND key NOT LIKE 'douyin.convId.%'").all();
			for (const r of cursors) {
				const v = JSON.parse(r.value);
				if (v?.identity && v?.name) nameByIdentity.set(String(v.identity), String(v.name));
			}
			const learned = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'douyin.name.%'").all();
			for (const r of learned) {
				const id = r.key.slice('douyin.name.'.length);
				if (id && r.value) nameByIdentity.set(id, JSON.parse(r.value));
			}
		} catch { /* 反查失败就当没有 */ }
		return nameByIdentity;
	}

	/**
	 * 没有昵称映射时，用消息正文匹配会话列表的预览来补。
	 * 只在确实缺映射时才碰页面，平时不读 DOM。
	 *
	 * 🔴 以前这里还要求 `messages.some(m => m.text)` —— 对方只发图片 / 表情 / 语音
	 *    （帧里没有 text）时 `missing` 就是 false，兜底压根不触发，然后
	 *    `!name` 把整帧丢掉。表现是「发文字能收到，发图片永远收不到」。
	 *    现在只要有「不是我自己发的」消息就值得去补昵称。
	 *
	 * 🔴 也不再要求文本 >= 2 个字符：陌生人第一句话经常就是「在」「hi」，
	 *    要求两个字等于把最常见的冷启动场景排除掉。歧义由
	 *    `matchConversationByPreview` 负责（唯一命中才算）。
	 *
	 * @param {Array<{convId: string, messages: Array<object>}>} frames
	 * @param {Map<string,string>} nameByIdentity 就地补
	 */
	async learnPushNames(frames, nameByIdentity) {
		const selfUids = this.selfUids();
		const missing = frames.filter(({ convId, messages }) => {
			const id = conversationIdentity(convId, selfUids);
			return id !== '' && !nameByIdentity.has(id) && messages.some((m) => m.fromMe !== true);
		});
		if (!missing.length) return;
		let rows = [];
		try {
			// 直接读 DOM 里的会话列表，不走 dmList（那要开面板，轮询占用时会失败）。
			// 预览文本里有最后一条消息的内容，用它和帧里的文本匹配出昵称。
			rows = await this.host.browser.eval(`(() => {
				const items = [...document.querySelectorAll('[data-e2e="conversation-item"]')]
				return items.slice(0, 40).map((el) => {
					const lines = (el.innerText || '').trim().split('\\n').map((s) => s.trim()).filter(Boolean)
					return { name: lines[0] || '', preview: lines.slice(1).join(' ') }
				}).filter((r) => r.name)
			})()`).catch(() => []);
		} catch (error) {
			// 兜底失败要留痕：以前是静默吞掉，于是「昵称学不到」这件事
			// 在日志里完全没有痕迹，只能靠用户报「消息不回复」。
			this.notePushDrop('nameFallback', `推送路补昵称失败（${errText(error)}）——消息先攒着，等轮询路读到`);
			rows = [];
		}
		for (const { convId, messages } of missing) {
			const id = conversationIdentity(convId, selfUids);
			const texts = messages
				.filter((m) => m.fromMe !== true)
				.map((m) => String(m.text ?? '').trim())
				.filter((t) => t !== '');
			const name = matchConversationByPreview(Array.isArray(rows) ? rows : [], texts);
			if (name === '') continue;
			nameByIdentity.set(id, name);
			try { setKv(this.db, `douyin.name.${id}`, name); } catch { /* 记不下来不影响 */ }
		}
		// 兜底跑完了还是没补上：这条也要能看见（「跑了但没匹配上」同样是黑的）
		const stillMissing = missing.filter(({ convId }) => !nameByIdentity.has(conversationIdentity(convId, selfUids))).length;
		if (stillMissing > 0) {
			this.notePushDrop('nameUnmatched', `推送路没匹配到昵称（${stillMissing} 个会话）——消息先攒着，轮询路读到会话就补上`);
		}
	}

	/**
	 * 缺昵称的帧先攒起来，等昵称学到了一起入库。
	 *
	 * 为什么不能直接丢：陌生人第一次发私信时，推送路拿不到昵称（没有游标、DOM 也
	 * 可能还没渲染那一行），而轮询路要靠「有变化 / 有未读」才会去读 —— 冷启动时
	 * 两条路互为前提。攒着就把「丢」变成「晚」。
	 *
	 * 攒也有边界（`PARKED_TTL_MS` / `PARKED_MAX_CONVS` / `PARKED_MAX_MESSAGES`）：
	 * 学不到昵称时不能无限占内存，超出上限的按「真丢」记账。
	 *
	 * @param {string} identity 会话身份（`douyin:<对端uid>`）
	 * @param {string} convId
	 * @param {Array<object>} messages 原始帧消息
	 */
	parkPushFrame(identity, convId, messages) {
		if (identity === '') return;
		const selfIds = new Set(this.selfUids());
		const peer = messages.filter((m) => m.fromMe !== true && !selfIds.has(String(m.senderId ?? '').trim()));
		if (!peer.length) return;
		const entry = this.parkedPush.get(identity);
		const merged = [...(entry?.messages ?? []), ...peer];
		const overflow = Math.max(0, merged.length - PARKED_MAX_MESSAGES);
		if (overflow > 0) this.pushStats.droppedNoName += overflow;
		const kept = merged.slice(-PARKED_MAX_MESSAGES);
		this.parkedPush.set(identity, { convId, messages: kept, at: Date.now() });
		this.pushStats.parked += peer.length;
		// 会话数上限：超出就丢最老的（同样记账，不悄悄消失）
		while (this.parkedPush.size > PARKED_MAX_CONVS) {
			const [oldestId, oldest] = [...this.parkedPush].sort((a, b) => a[1].at - b[1].at)[0];
			this.pushStats.droppedNoName += oldest.messages.length;
			this.parkedPush.delete(oldestId);
		}
		this.notePushDrop('noNameWaiting', `推送帧缺昵称映射（identity=${identity}）——先攒着 ${kept.length} 条，轮询路读到这个会话就补收`);
	}

	/**
	 * 把攒下的帧过一遍：学到昵称的补入库，过期的真丢。
	 *
	 * 补入库时按游标的 `readAt` 去重：轮询路在这条消息之后读过这个会话，说明它
	 * 已经在窗口里收过了，不能再收一遍（否则同一条消息会回两次）。
	 *
	 * @param {Map<string,string>} nameByIdentity
	 */
	flushParkedPush(nameByIdentity) {
		if (!this.parkedPush?.size) return;
		const now = Date.now();
		for (const [identity, entry] of [...this.parkedPush]) {
			const name = nameByIdentity.get(identity);
			if (name) {
				const key = `douyin.conv.${sha1(name).slice(0, 16)}`;
				let readAt = 0;
				try { readAt = Number(getKv(this.db, key, null)?.readAt) || 0; } catch { readAt = 0; }
				try {
					this.storePushMessages({ name, convId: entry.convId, identity, messages: entry.messages, skipBefore: readAt });
				} catch (error) {
					this.log('warn', `[fish-soul] 推送帧补入库失败（下一轮再试）：${errText(error)}`);
					continue;
				}
				this.parkedPush.delete(identity);
				continue;
			}
			if (now - entry.at < PARKED_TTL_MS) continue;
			// 超时还是学不到昵称：真丢。留痕 + 记账（不能悄悄没）
			this.pushStats.droppedNoName += entry.messages.length;
			this.parkedPush.delete(identity);
			this.notePushDrop('noName', `推送帧缺昵称超时丢弃（identity=${identity}，${entry.messages.length} 条）——轮询路一直没读到这个会话，这些消息收不到了`);
		}
	}

	/**
	 * 推送路存一批消息。
	 *
	 * 游标只补「这是谁 / 哪个会话」，**不动** `window` / `sig` / `readAt` ——
	 * 那些是轮询路的游标语义（读到哪了）。以前这里整个覆盖成
	 * `{name, convId, identity, readAt}`，窗口和 sig 被清掉，下一轮轮询
	 * 会把同样的消息再收一遍（`newFrom` 没有窗口可用）。
	 *
	 * @param {{name: string, convId: string, identity: string, messages: Array<object>, skipBefore?: number}} p
	 * @returns {number} 入库条数
	 */
	storePushMessages({ name, convId, identity, messages, skipBefore = 0 }) {
		const selfIds = new Set(this.selfUids());
		const fresh = messages.filter((m) => m.fromMe !== true && !selfIds.has(String(m.senderId ?? '').trim()));
		if (!fresh.length) return 0;
		const normalized = [];
		// 推送路的 ID 走和轮询路同一套分级（见 messageIdFor）：seq → 平台时间 → 自然日兜底。
		// 以前这里是「没有时间就用内容指纹」—— 同一天发两次同一张表情会撞键（第二次收不到），
		// 而纯 Date.now() 又会让同一条推送重发时新入库一遍。两头的病都躲不掉。
		const dayKey = new Date().toISOString().slice(0, 10);
		const occurrences = occurrenceIndexes(fresh.map(messageFingerprint));
		for (const [i, m] of fresh.entries()) {
			// 指纹用「内容 + 推送内出现次数」：推送帧重放同一批时 occ 一致 ⇒ ID 一致（去重）；
			// 同一批里真有两张一模一样的图 ⇒ occ 递增 ⇒ ID 不同（都收得到）。
			const contentKey = messageFingerprint(m);
			const { timeMs, messageId } = messageIdFor(m, { occ: occurrences[i], dayKey });
			// 轮询路读的时候这条已经在窗口里了 → 已经收过，别重复收
			if (skipBefore > 0 && timeMs <= skipBefore) continue;
			const norm = normalizeDouyinMessage(m, { name, timeMs, messageId, identity, convId });
			if (norm !== null) { norm.idConfidence = m.seq ? 'platform' : 'heuristic'; normalized.push(norm); }
		}
		if (!normalized.length) return 0;
		const key = `douyin.conv.${sha1(name).slice(0, 16)}`;
		this.inbox.record(key, this.mergeCursor(key, { name, convId, identity }), normalized, null);
		this.markReadOk(key);
		this.pushStats.stored += normalized.length;
		return normalized.length;
	}

	/** 推送路写游标时保留轮询路那一份的窗口 / sig（只补身份字段）。 */
	mergeCursor(key, { name, convId, identity }) {
		let prev = null;
		try { prev = getKv(this.db, key, null); } catch { prev = null; }
		const base = prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
		return { ...base, name, convId, identity };
	}

	/**
	 * 清掉「游标已经不在」的失败计数（孤儿）。
	 *
	 * 会话改名 / 老版本 key 格式不同 / 手动清过 kv 之后，`douyin.fails.*` 会留下
	 * 没有对应游标的计数，面板于是误报「1 个会话上次读取失败」，用户点进去什么也没有。
	 *
	 * 🔴 判据不能只是「有没有游标」：**从没读成功过的会话本来就没有游标**，
	 *    那正是要重试的对象（陌生人冷启动就是这种）。所以按时间判 ——
	 *    一小时没再被碰过的才算孤儿。
	 *
	 * @returns {number} 还活着的失败会话数（面板用）
	 */
	liveReadFailures() {
		const now = Date.now();
		let live = 0;
		let rows = [];
		try { rows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'douyin.fails.douyin.conv.%'").all(); } catch { return 0; }
		for (const row of rows) {
			if (!(Number(row.value) > 0)) continue;
			const key = row.key.slice('douyin.fails.'.length);
			let hasCursor = false;
			let retryAt = 0;
			try {
				hasCursor = getKv(this.db, key, null) !== null;
				retryAt = Number(getKv(this.db, `douyin.retry.${key}`, 0) ?? 0) || 0;
			} catch { hasCursor = true; }
			const touched = Math.max(retryAt, this.lastReadAt(key));
			if (!hasCursor && touched > 0 && now - touched > ORPHAN_FAIL_TTL_MS) {
				try {
					this.db.prepare('DELETE FROM kv WHERE key IN (?, ?, ?)')
						.run(row.key, `douyin.retry.${key}`, `douyin.readAt.${key}`);
				} catch { /* 清不掉就下一轮再清 */ }
				continue;
			}
			live++;
		}
		return live;
	}

	async pollOnce() {
		if (this.polling || !this.cfg().enabled) return;
		// 🔴 收件箱维护要排在**拿锁之前**，也要排在浏览器检查之前：
		//    读私信 hang 住时锁不放（exclusive 超时只把错误交给调用方，锁要等 fn 真收尾），
		//    锁被占着的时候 pollInner 排不上 —— 挂在它里面的回收一轮都跑不到，
		//    卡在 processing 的消息永远回收不回来（真机 2026-11-13：一条卡了 20 分钟）。
		//    浏览器没在跑时同样要维护：队列不会因为浏览器停了就不该自愈。
		this.sweepInbox();
		if (!this.host.running) {
			// 浏览器没在跑：不是用户暂停的就试着拉起来（崩溃重连由 host 自己管）
			if (!this.host.paused && this.host.state === 'stopped') await this.host.start();
			if (!this.host.running) return;
		}
		this.polling = true;
		try {
			// 推送帧先消费，不等 pollInner。pollInner 在「已打开的会话」上会卡住
			// （抖音不发新请求，读取超时），推送路排在它后面就永远跑不到。
			await this.consumePushFrames();
			await this.host.exclusive('读私信', () => this.pollInner(), { maxMs: POLL_TIMEOUT_MS });
			this.lastPollAt = Date.now();
			// 只数「还活着」的失败会话：游标早就不在的孤儿计数会让面板误报
			// 「1 个会话上次读取失败」，点进去什么都没有（见 liveReadFailures）。
			const failedReads = this.liveReadFailures();
			this.lastError = failedReads ? `${failedReads} 个会话上次读取失败，等待重试；历史缺口请另行核对` : '';
			this.failures = 0;
		} catch (error) {
			this.lastError = errText(error);
			this.failures++;
			this.log('warn', `[fish-soul] 抖音私信轮询失败：${this.lastError}`);
			if (this.failures >= 3 && this.host.running && this.host.loggedIn === true) {
				this.failures = 0;
				// 自检没过会先刷新页面自救（#72），刷新 + 开面板要时间，超时给宽一点
				await this.host.exclusive('自检', () => this.runCanary(), { maxMs: 90_000 }).catch(() => {});
			}
		} finally {
			this.polling = false;
		}
	}

	/**
	 * 收件箱维护：回收卡住的 processing、过期待核实、清缺口提示。
	 *
	 * 必须在**不占锁**的地方调（pollOnce 拿锁之前）：锁被焊死时 pollInner 排不上，
	 * 挂在它里面的维护一轮都跑不到 —— 卡住的消息就永远摆在那里。
	 */
	sweepInbox() {
		try { this.inbox.reclaimStuck?.(); } catch { /* 回收失败不影响这一轮轮询 */ }
		// 设置页不再展示「私信待核实」和「私信可能遗漏」两块提示（主人要求去掉噪音），
		// 用户没法再逐条核实 ⇒ 超期的 unknown 只能自动作废，否则它会挡住整个会话；
		// 没人点「已知晓」的缺口记录也定期清掉，免得表单调增长。
		try { this.inbox.expireStaleUnknown?.(); this.inbox.pruneGaps?.(); } catch { /* 过期失败不影响这一轮轮询 */ }
	}

	async pollInner() {
		const loggedIn = await this.driver.checkLogin();
		this.host.loggedIn = loggedIn;
		if (!loggedIn) {
			this.notify('douyin.login', '抖音小号掉登录了（或者还没登录），去设置页「抖音」里扫码登录一下');
			return;
		}
		this.notify('douyin.login', null);
		await this.drainInbox();
		const list = await this.driver.list();
		if (!list?.ok) throw new Error(list?.error || '读不到会话列表');
		if (this.lastCanaryAt === 0 || Date.now() - this.lastCanaryAt > CANARY_EVERY_MS) await this.runCanary();
		const convs = (list.conversations ?? []).filter((c) => c && String(c.name ?? '').trim() !== '');
		const bootstrapped = getKv(this.db, 'douyin.bootstrapped', false) === true;
		const now = Date.now();
		const todo = [];
		for (const c of convs) {
			const name = String(c.name).trim();
			const key = `douyin.conv.${sha1(name).slice(0, 16)}`;
			const st = getKv(this.db, key, null);
			const sig = `${c.time ?? ''}|${String(c.preview ?? '').slice(0, 60)}`;
			// 🔴 基线只补 sig，**不能**把已有的 identity / convId 覆盖掉：
			//    那会让「已经验证过的会话」退回未验证，下一轮又被强制重读。
			if (!bootstrapped) { setKv(this.db, key, { ...(st ?? {}), name, sig, window: st?.window ?? [] }); continue; }
			const unread = Number(c.unread) > 0 || c.unread === true;
			const t = convTimeMs(c.time);
			const changed = st === null || st.sig !== sig;
			const recent = t === 0 ? changed : now - t < RECENT_MS;
			// 🔴 读失败熔断：上一次读失败后，5 分钟内**不再重读**。
			//    没有这行的话，失败的会话永远 changed → 每轮重试 → gap 死循环。
			//    有真新消息（unread）**绕过熔断** —— 熔断只挡「无事硬读」，
			//    不能连真消息都挡掉（那会变成「读失败后永远收不到」）。
			//
			//    ⚠️ 但 unread 绕过必须**有次数上限**：读失败时抖音往往不消未读徽标，
			//    于是「恒有未读 + 恒失败」会每轮重试、每轮插一条 gap（实测 10 轮涨 10 条，
			//    未确认的 gap 永久保留 → 设置页被同一个会话刷满）。
			//    连续失败到 FAIL_HARD_AFTER 次后，连 unread 也一起熔断，等窗口过了再试。
			const failedAt = this.lastReadFailedAt(key);
			const fails = this.readFailCount(key);
			const failedRecently = failedAt > 0 && now - failedAt < FAIL_RETRY_MS;
			const hardFail = fails >= FAIL_HARD_AFTER;
			const bypass = unread && !(hardFail && failedRecently);
			// 🔴 **没验证过的会话必须读一次**，跟预览变没变无关。
			//
			//    陌生人第一次发私信时这里正是死角：基线（bootstrap）只记 sig 不记
			//    identity，所以下一轮 `changed` 是 false → 永远排不进 todo；新会话
			//    如果时间不新鲜（`RECENT_MS` 之外，例如 `11/04` 这种 `convTimeMs`
			//    解不出来的格式，`t` 直接是 0）也一样排不上。排不上就读不到 →
			//    没有游标 → 推送路认不出昵称 → 两边互等，消息永远进不来。
			//
			//    读成功一次就带上 identity，之后自动回到「按变化读」的正常节奏。
			//    ⚠️ 熔断仍然优先：刚失败过的先等窗口；过了窗口再试一次（5 分钟一次），
			//    否则读失败过的陌生人会话会**永远**没有出口（`changed` 也不会再变）。
			//    ⚠️ 但**必须有次数上限**：认不出单聊身份的会话（群聊、页面读不出 convId）
			//    永远验证不了，无上限的话每 5 分钟去开一次会话、插一条 gap。
			//    连续失败到 FAIL_HARD_AFTER 就停手，回到「按变化 / 有未读才读」——
			//    对方真发新消息时 unread 仍然会绕过熔断再试一次，出口不会关死。
			const verified = st !== null && String(st.identity ?? '') !== '';
			const needsVerify = !verified && !failedRecently && fails < FAIL_HARD_AFTER
				&& now - this.lastReadAt(key) > FAIL_RETRY_MS;
			if (bypass || needsVerify || (((changed && recent) || st?.needsPageRead) && !failedRecently)) todo.push({ c, name, key, st, sig, unread });
		}
		if (!bootstrapped) {
			setKv(this.db, 'douyin.bootstrapped', true);
			this.log('info', `[fish-soul] 抖音私信基线已记下（${convs.length} 个会话），之后的新消息才处理`);
			return;
		}
		// 🔴 未读多的优先，但**要轮转**：以前 `sort` 只按 unread 布尔（不稳定），
		//    8 个会话全有未读时每轮都取列表顺序前 5 个，后 3 个永远轮不到
		//    （实测 12 轮后 F/G/H 一次都没被读过）。
		//    现在按「上次读的时间」升序排 —— 最久没读的排前面，天然公平。
		todo.sort((a, b) => {
			const ua = Number(a.unread) > 0 ? 1 : 0;
			const ub = Number(b.unread) > 0 ? 1 : 0;
			if (ua !== ub) return ub - ua;
			return this.lastReadAt(a.key) - this.lastReadAt(b.key);
		});
		for (const item of todo.slice(0, MAX_READS_PER_POLL)) await this.readConversation(item);
	}

	/** 设置页「抖音群聊」：认不出来的群可以手动填会话名。 */
	groupNames() {
		const g = this.getConfig?.()?.groups;
		return Array.isArray(g) ? g.map((x) => String(x).trim()).filter(Boolean) : [];
	}

	/**
	 * 我自己的抖音 uid 候选（用来从会话 ID 里挑出「对方是哪一侧」）。
	 *
	 * 来源：本地学到的数字 uid（见 `learnSelfUid`）+ 页面上能读到的 sec_uid。
	 * 数字 uid 是首选 —— 会话 ID 里存的就是数字 uid，sec_uid 只作补充。
	 * 拿不到任何候选时返回空数组，上层据此拒绝处理（不猜）。
	 */
	selfUids() {
		const out = [];
		const learned = selfUidFromKv(getKv(this.db, 'douyin.selfUid', ''));
		if (learned !== '') out.push(learned);
		// sec_uid 也走 kv：以前读的是 `this.selfSecUid`，而那个字段**从来没有被赋过值**
		// （vendor 里的 selfSecUid 是另一个对象的入参）—— 等于这段永远是空的死分支。
		// 现在用 `douyin.selfSecUid` 这个 kv 键，谁能读到就 `setKv` 进来。
		const sec = stripQuotes(String(this.selfSecUid ?? getKv(this.db, 'douyin.selfSecUid', '') ?? ''));
		if (sec !== '' && sec !== learned) out.push(sec);
		return out;
	}

	/**
	 * 配置里的「主人身份」跟已学到的会话身份对不上时的警告；对得上 / 没填 / 还学不到则返回 null。
	 *
	 * 🔴 为什么需要这条：**短号和真实 uid 都是纯数字**，用户分不出来。
	 *    界面写「填数字 uid 就行」，他就把短号填进去了 —— 之后认领分支比对不上，
	 *    静默什么都不发生（真机踩过：昵称候选永远不弹，用户看到「她不理我」）。
	 *
	 * 判据：`douyin.conv.*` 游标里的 `identity`（真实 uid，从会话 ID 推出来的）。
	 *    已学到的所有身份里都不等于 `masterUid` ⇒ 它是个错值（短号 / 抄错了 / 换号了）。
	 *    一条都没学到 ⇒ 不警告（那时不能证明它错）。
	 *
	 * @returns {{filled: string, learned: string[]}|null}
	 */
	masterUidMismatch() {
		// 直接读 getConfig()，不走 cfg() —— 那个只返回 {enabled, autoReply}，
		// 没 masterUid（在它上面读会得到 undefined，永远判成「没填」）。
		const filled = String(this.getConfig()?.masterUid ?? '').trim();
		if (filled === '') return null;
		const norm = filled.replace(/^douyin:/, '').replace(/^uid:/, '');
		if (!/^\d+$/.test(norm)) return null;
		// 已学到的会话身份（真实 uid）
		const learned = new Set();
		try {
			const rows = this.db.prepare("SELECT value FROM kv WHERE key LIKE 'douyin.conv.%' AND key NOT LIKE 'douyin.convId.%'").all();
			for (const r of rows) {
				const v = JSON.parse(r.value);
				const id = String(v?.identity ?? '').replace(/^douyin:/, '');
				if (/^\d+$/.test(id)) learned.add(id);
			}
		} catch { /* 查不到就当没学到 */ }
		if (learned.size === 0) return null;   // 还没学到 ⇒ 不判
		return learned.has(norm) ? null : { filled: `douyin:${norm}`, learned: [...learned].slice(0, 5) };
	}

	/**
	 * 身份是否已经可用（能可靠回答「这条消息是谁发的、这条回复发给谁」）。
	 *
	 * 判据只有一条：知道自己是谁。因为会话 ID 自带双方 uid，知道了自己就能
	 * 推出对端 —— 这是整个方案的基础，不是「大概能猜」。
	 * 不知道自己的 uid 时一切照旧按未验证处理（读到的消息不入库、不发送）。
	 */
	identityReady() {
		return this.selfUids().length > 0;
	}

	/**
	 * 从这一批消息里学「我自己的数字 uid」。
	 *
	 * 怎么学：单聊会话 ID 是 `0:1:A:B`，而每条消息带 `senderId`。
	 * 只要有一批消息里既有「我发的」又有「对方发的」，并且两个 senderId
	 * 正好等于会话 ID 的两侧，那「我发的那些」的 senderId 就是我的数字 uid。
	 *
	 * 学到一次就存进 kv，之后不用再猜。学不到不报错 —— 只是这一轮处理不了。
	 */
	learnSelfUid(convId, msgs) {
		const pair = parseSingleConversation(convId);
		if (pair === null) return;
		const known = selfUidFromKv(getKv(this.db, 'douyin.selfUid', ''));
		if (known !== '') return;

		// ① 最稳的一条：对方发的消息里，senderId 明确是会话两侧之一 → 另一侧就是我。
		//    这条不需要「我发过消息」，冷启动也能立刻学到。
		//    fromMe 未知（推送帧里没有 sec_uid 可比对，解码出来是 null）也算：
		//    单聊两侧只有我和对方，senderId 落在其中一侧，另一侧就是我。
		const theirs = new Set();
		for (const m of msgs) {
			const sid = String(m?.senderId ?? '').trim();
			if (sid === '' || m?.fromMe === true) continue;
			if (sid === pair.a || sid === pair.b) theirs.add(sid);
		}
		if (theirs.size === 1) {
			const peer = [...theirs][0];
			setKv(this.db, 'douyin.selfUid', peer === pair.a ? pair.b : pair.a);
			this.log('info', '[fish-soul] 从会话 ID 学到自己的抖音 uid（之后靠会话 ID 认人，不靠昵称）');
			return;
		}

		// ② 退一步：用「我发的消息」反推（对方从没说过话时只能这样）
		const mine = new Set();
		for (const m of msgs) {
			const sid = String(m?.senderId ?? '').trim();
			if (sid === '' || m?.fromMe !== true) continue;
			if (sid === pair.a || sid === pair.b) mine.add(sid);
		}
		if (mine.size !== 1) return; // 没有 / 有歧义都不学
		const uid = [...mine][0];
		setKv(this.db, 'douyin.selfUid', uid);
		this.log('info', `[fish-soul] 学到自己的抖音 uid（之后靠会话 ID 认人，不靠昵称）`);
	}

	/**
	 * 记「这个会话读失败了一次」。独立 kv（不碰游标 —— 游标语义是「读到哪了」，
	 * 失败时不该动它，否则会丢「还没读」的信息；失败时间单独记，供熔断用）。
	 */
	markReadFailed(key) {
		try {
			setKv(this.db, `douyin.retry.${key}`, Date.now());
			// 连续失败计数：用来给「unread 绕过熔断」封顶（见 pollInner 注释）
			setKv(this.db, `douyin.fails.${key}`, this.readFailCount(key) + 1);
			// 失败也算「这一轮轮到过它」：不记的话它会一直排在最前面，
			// 每轮都占一个 MAX_READS_PER_POLL 名额，把别的会话挤出去（饿死）。
			setKv(this.db, `douyin.readAt.${key}`, Date.now());
		} catch { /* 记不下来不影响主流程 */ }
	}

	/**
	 * 这个会话上次被读的时间（毫秒）。没有记录 = 0（最久没读，排最前面）。
	 * 用途：`MAX_READS_PER_POLL` 截断时按它轮转，避免会话多时后几个永远饿死。
	 */
	lastReadAt(key) {
		try {
			const v = Number(getKv(this.db, `douyin.readAt.${key}`, 0) ?? 0);
			return Number.isFinite(v) && v > 0 ? v : 0;
		} catch { return 0; }
	}

	/** 这个会话连续读失败了几次（成功一次就清零）。 */
	readFailCount(key) {
		try {
			const v = Number(getKv(this.db, `douyin.fails.${key}`, 0) ?? 0);
			return Number.isFinite(v) && v > 0 ? v : 0;
		} catch { return 0; }
	}

	/** 读成功：清掉失败时间 + 失败计数（熔断解除），并记下这次读的时间（供轮转）。 */
	markReadOk(key) {
		try {
			setKv(this.db, `douyin.retry.${key}`, 0);
			setKv(this.db, `douyin.fails.${key}`, 0);
			setKv(this.db, `douyin.readAt.${key}`, Date.now());
		} catch { /* 清不掉下一轮也会被熔断窗口覆盖 */ }
	}

	/** 这个会话最近一次读失败的时间（毫秒），没有或很久以前返回 0。 */
	lastReadFailedAt(key) {
		try {
			const v = Number(getKv(this.db, `douyin.retry.${key}`, 0) ?? 0);
			return Number.isFinite(v) && v > 0 ? v : 0;
		} catch { return 0; }
	}

	async readConversation({ c, name, key, st, sig, unread }) {
		// 群游标挂着单聊形状的 convId（真机见过：某个群被钉上另一个私聊的 0:1:…），
		// 按它继续读会把私聊内容记进群频道，回复还会按这个 ID 发进人群。
		// 这里只把污染的固定目标清掉，不改游标：读失败时游标与消息一起留在原地（fail-closed），
		// 读到真正的群 ID 才由下面的流程重新捕获并覆盖。
		const stGroup = st?.group === true;
		const pollutedGroupCursor = stGroup && isSingleConversation(st?.convId);
		if (pollutedGroupCursor) {
			this.log('warn', `[fish-soul] 群聊游标「${name}」挂着单聊会话 ID（${st.convId}），已停止沿用，重新捕获会话`);
		}
		this.inbox.beginRead(key, `${stGroup ? 'douyin-group' : 'douyin'}:${name}`);
		let res;
		// 🔴 已固定的会话要钉住，不能被别的会话顶掉（串会话的防线）。
		//    单聊：用「现在还能不能推出同一个身份」来验证游标还有效 ——
		//    换号后推不出身份 ⇒ 旧身份作废 ⇒ 不沿用旧会话 ID
		//    （test/douyin-read-cache.mjs 守着这条契约：换号后不沿用）。
		//    群聊：没有「会话对端」可言，但游标里记着它是哪个群
		//    （identity 字段 = `group:<convId>`）⇒ 记着同一个群就沿用。
		const priorIdentity = conversationIdentity(st?.convId, this.selfUids());
		const priorIsSingle = priorIdentity !== '' && priorIdentity === st?.identity;
		const priorIsGroup = stGroup && !pollutedGroupCursor && st?.identity === `group:${String(st?.convId ?? '').trim()}`;
		const expectConvId = (priorIsSingle || priorIsGroup) ? String(st?.convId ?? '').trim() : '';
		// 🔴 driver.read 内部是一串 browser.eval / captureImBodies / enterChat，**都没有超时**。
		//    CDP 会话 hang 住 / 页面卡住时它会永远等下去 —— 而 exclusive() 的 maxMs 只让
		//    调用方拿到超时错误，fn() 还在锁里跑 ⇒ 锁永不释放 ⇒ host.busy 一直显示「读私信」、
		//    后面所有入站消息全卡在 processing（真机 2026-11-13 复现：两条消息卡 5 分钟）。
		//    这里给驱动读加一道硬超时，超时按「读失败」处理（已有的熔断 / gap 机制接管）。
		const READ_TIMEOUT_MS = 60_000;
		let readTimer;
		try {
			res = await Promise.race([
				this.driver.read(name, { expectConvId, minCacheAt: Number(st?.readAt) || 0 }),
				new Promise((resolve) => {
					readTimer = setTimeout(() => resolve({ ok: false, error: `读「${name}」超时（${READ_TIMEOUT_MS / 1000} 秒）` }), READ_TIMEOUT_MS);
					readTimer.unref?.();
				}),
			]);
		} catch (error) {
			this.inbox.failRead(key, '读取驱动异常或超时');
			this.markReadFailed(key);
			throw error;
		} finally {
			clearTimeout(readTimer);
		}
		if (!res?.ok) {
			this.inbox.failRead(key, '未取得可验证的接口消息');
			this.markReadFailed(key);
			this.log('warn', `[fish-soul] 读「${name}」的私信失败：${res?.error ?? '未知'}（5 分钟内不再重试）`);
			return;
		}
		/**
		 * 🔴 身份关：拿到会话 ID 才继续。
		 *
		 * 昵称不是身份（同名可冒充、改名就断），所以「读到了消息」不等于「知道这是谁的会话」。
		 * 拿不到 convId 就当成读失败：保留读取意图 → 生成缺口提示 → 消息不入库。
		 * 这比「先按昵称信着、以后再修」安全，也是 docs/douyin-identity-validation.md 里
		 * 「缺少验证证据时停止处理」那条的直接实现。
		 *
		 * 🔴 失败要记一下时间（独立 kv，不碰游标）：不记的话这个会话永远 changed →
		 *    每轮重试 → gap 死循环。有真新消息（unread）会绕过熔断重读，不会「卡死收不到」。
		 */
		const convId = String(res.convId ?? '').trim();
		// 🔴 **群会话也要放行**（2026-11-19 真机修）。
		//    这道闸门原来是「必须是单聊形状」—— 群会话 ID 是 `<数字>:<数字>:...`，
		//    于是群里的话一句都过不来（读失败 → 不入库 → 不推进游标）。
		//    群会话的身份靠**会话 ID 本身**（群号），不靠「谁是对端」。
		//    ⚠️ 但「已固定的会话不能被换掉」这条对群同样成立 ——
		//    上面 expectConvId 现在从游标取（不再靠 identity），所以这里统一判。
		// 被污染的群游标只可能重新捕获到群：读回来还是单聊形状，说明拿到的仍不是这个群，
		// 按读失败处理 —— 不能让它顺着单聊频道入库（换个频道串会话）。
		if (pollutedGroupCursor && isSingleConversation(convId)) {
			this.inbox.failRead(key, '读取失败：群聊游标仍指向单聊会话');
			this.markReadFailed(key);
			this.log('warn', `[fish-soul] 读「${name}」仍拿到单聊会话 ID（${convId}），群聊游标未恢复，5 分钟内不再重试`);
			return;
		}
		const groupConv = !isSingleConversation(convId);
		if (convId === '' || (expectConvId && convId !== expectConvId)) {
			this.inbox.failRead(key, '读取失败：会话身份缺失或与已验证目标不符');
			this.markReadFailed(key);
			this.log('warn', `[fish-soul] 读「${name}」拿不到会话 ID（${convId || '空'}），身份无法确认，5 分钟内不再重试`);
			return;
		}
		// 🔴 身份过滤要区分两种消息：
		//    ① 接口路（protobuf）的消息**自带** convId + senderId —— 必须自己证明属于本会话；
		//    ② DOM 路补进来的媒体消息（图片/表情/语音）**没有** convId / senderId ——
		//       它们是按「在当前打开的会话里看到的」抓的，而上面已经确认了 `convId` 就是
		//       这个会话，所以它们属于本会话，只是**继承**这个事实，不该要求自带证据。
		//    以前一律走 ①，结果对方发张图永远收不到（DOM 路白跑）。
		const selfIds = this.selfUids();
		// 分两步走，别在 filter 里带副作用（补 convId 是改数据，不是判断）：
		// ① map：DOM 路补进来的媒体消息（没有 convId / senderId）继承本会话的 convId
		//    —— 它们是「在当前打开的会话里看到的」，上面已确认 convId 就是这个会话；
		// ② filter：自带身份的消息必须自证属于本会话，无身份的媒体消息直接放行
		const inherited = (Array.isArray(res.messages) ? res.messages : []).map((m) => {
			// 推送/新接口可能缺 sec_uid，fromMe=false 不能推翻已知自身数字 uid。
			if (selfIds.includes(String(m?.senderId ?? '').trim())) m = { ...m, fromMe: true };
			const ownConv = String(m?.convId ?? '').trim();
			const hasOwnIdentity = ownConv !== '' || String(m?.senderId ?? '').trim() !== '';
			if (!hasOwnIdentity && m?.type && m.type !== 'text') return { ...m, convId };
			return m;
		});
		const msgs = inherited.filter((m) => {
			const ownConv = String(m?.convId ?? '').trim();
			// 🔴 自带会话 ID 的消息，必须**就是这个会话**。
			//    `senderBelongsToConversation` 只验证「消息内部自洽」（sender 是会话两侧之一），
			//    挡不住「另一个会话的消息混进这一批」—— 那正是串会话 / 冒充的入口。
			if (ownConv !== '' && ownConv !== convId) return false;
			// 上面 map 里继承了 convId 的 DOM 媒体消息没有 senderId：
			// senderBelongsToConversation 会因「没有 sender」拒掉它们 —— 但它们的身份
			// 靠「在当前会话里看到的 + convId 已确认」成立，直接放行
			if (String(m?.senderId ?? '').trim() === '' && m?.type && m.type !== 'text') return true;
			// 单聊的 DOM 纯文本（接口快照陈旧时对方的新话只在这条路上）没有 senderId：
			// 会话 ID 已在上面确认，单聊只有两方，明确是对方发的（fromMe === false）就是对方。
			// 只对单聊放行 —— 群里的发言人必须能对上，不能借这条混进来。
			if (isSingleConversation(convId) && Number(m?.convType) !== 2 && m?.fromMe === false
				&& String(m?.senderId ?? '').trim() === '' && (!m?.type || m.type === 'text')) return true;
			// 🔴 群会话（convType=2 或会话 ID 不是 0:1: 形状）里的发言人是**群成员**，
			//    不在「会话两侧」里 —— 单聊那套判据会把群消息整批丢掉。
			//    群的身份靠「这条消息的 convId 就是当前会话」（上面已经校验过）。
			if (Number(m?.convType) === 2 || !isSingleConversation(convId)) return true;
			return senderBelongsToConversation(m, selfIds);
		});
		const prints = msgs.map(messageFingerprint);
		let fresh = [];
		let freshIndexes = [];
		let truncated = false;
		if (st !== null && Array.isArray(st.window) && st.window.length > 0) {
			const from = newFrom(st.window, prints);
			freshIndexes = msgs.map((_, i) => i).slice(from);
			fresh = freshIndexes.map(i => msgs[i]);
			// 一条都没对上（窗口滚走了 / 两次读法不一样）：最多补最后 3 条，宁少勿重
			if (from === 0 && msgs.length > 0) { truncated = freshIndexes.length > INJECT_ON_FIRST_READ; freshIndexes = freshIndexes.slice(-INJECT_ON_FIRST_READ); fresh = freshIndexes.map(i => msgs[i]); }
		} else if (unread) {
			// 第一次读这个会话、而且有未读：补最后几条对方的消息（自己最后一次说话之后的）
			let lastMine = -1;
			for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].fromMe) { lastMine = i; break; }
			const want = typeof c.unread === 'number' && c.unread > 0 ? Math.min(INJECT_ON_FIRST_READ, c.unread) : INJECT_ON_FIRST_READ;
			// 只认**明确是对方发的**（fromMe === false）。fromMe 是 null 表示「算不出谁发的」，
			// 那种也排除掉 —— 否则她自己的话会被当成对方的新消息再注入一遍。
			const eligible = msgs.map((_, i) => i).slice(lastMine + 1).filter(i => msgs[i].fromMe === false && !msgs[i].system && !msgs[i].unsupported);
			truncated = eligible.length > want || (typeof c.unread === 'number' && (c.unread > want || c.unread > eligible.length));
			freshIndexes = eligible.slice(-want);
			fresh = freshIndexes.map(i => msgs[i]);
		}
		// 群聊：认出来一次就记住（之后读到的消息里没带会话类型也按群处理）；顺便记下"发送者 ID → 昵称"
		const groups = this.groupNames();
		// 当前会话 ID 是单聊形状（0:1:）时，旧游标里的 group 标记不算数。
		// 那个标记是之前某轮误判写进去的，沿用下去会让单聊永远走群聊路径
		// （2026-11-11 真机：未云的 convId 是 0:1:...，游标却是 group:true，
		// 私信被当成群消息入库）。
		const singleNow = isSingleConversation(convId);
		const group = singleNow ? false : (st?.group === true || isGroupConversation(msgs, { name, groups }));
		const members = { ...(st?.members ?? {}) };
		if (group) {
			for (const m of msgs) {
				const id = String(m?.senderId || m?.secUid || '');
				const n = String(m?.senderName ?? '').trim();
				if (id !== '' && n !== '' && m.fromMe === false) members[id] = n;
			}
			const ids = Object.keys(members);
			for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete members[id];
			if (st?.group !== true) this.log('info', `[fish-soul] 抖音会话「${name}」是群聊，之后按发言的人分开认`);
		}
		// 从这批消息里学「我自己的数字 uid」，然后算出这个会话的稳定身份。
		this.learnSelfUid(convId, msgs);
		const identity = conversationIdentity(convId, this.selfUids());
		// 🔴 群聊**不套**单聊的身份闸门（2026-11-19 真机修）。
		//    群会话 ID 不是 0:1:<我>:<对方> 的形状（是 <数字>:<数字>:...），
		//    `conversationIdentity` 必然返回空 —— 以前这里直接 return，
		//    于是群里的话一条都进不了库、也永远不推进游标，
		//    每轮轮询都判「窗口对不齐」⇒ 日志每分钟刷一条「私信可能有遗漏」。
		//    群里认人靠的是**发言人**（`groupSender` + members 昵称表），不靠会话对端，
		//    所以群聊这条路上 identity 本来就用不上。
		if (identity === '' && !group) {
			// 有会话 ID 但推不出对端（不知道自己是谁）：这一轮不处理，也不推进游标。
			this.inbox.failRead(key);
			this.markReadFailed(key);
			this.log('warn', `[fish-soul] 会话 ${convId} 推不出对方身份（还不知道自己的 uid），5 分钟内不再重试`);
			return;
		}
		// 群聊没有「会话对端」可言，identity 用会话 ID 自己当标识（只作游标标记，不作身份）。
		const sessionKey = identity !== '' ? identity : `group:${convId}`;
		// 记下「这个身份对应哪个会话 ID」：转达 / 主动私信要靠它找到目标会话，
		// 不能按昵称猜（昵称会变、会重名）。同名身份只留第一次，避免被后来者覆盖。
		try {
			// 🔴 只有单聊才记「身份 → 会话 ID」（转达 / 主动私信要靠它找目标会话）。
			//    群聊记了也没用：群里没有唯一的「对方」。
			if (identity !== '') {
				const k = `douyin.convId.${identity}`;
				if (String(getKv(this.db, k, '') ?? '') === '') setKv(this.db, k, convId);
			}
		} catch { /* 记不下来不影响这一轮 */ }
		// 判据保持「这次读到的消息一条都不在上次窗口里」= 窗口对不齐。
		// ⚠️ 这条在「正常来新消息」时也会命中（抖音只返回最近几条，旧的滚出去了），
		//    所以会**误报**缺口。曾试着加「窗口变小」条件收紧，但那会把
		//    「上次窗口只有 1 条、这次读到 2 条全新的」这种**真可能漏收**的场景
		//    也一起放过（test/douyin-inbox.mjs 的契约就红在这）。
		//    取舍：宁可误报（只多记一条缺口，7 天后自动清理），不能漏报（真丢消息）。
		const hasWindowGap = st !== null && Array.isArray(st.window) && st.window.length > 0 && prints.length > 0 && !prints.some(p => st.window.includes(p));
		// 游标带上会话身份：以后哪怕昵称变了，也知道这仍是同一个会话。
		const cursor = { name, sig, convId, identity: sessionKey, window: prints.slice(-WINDOW_KEEP), readAt: Date.now(), ...(group ? { group: true, members } : {}) };
		// 缓存只交接接口消息；下一轮仍需读取页面媒体，不能把预览当作完整收取。
		if (res.needsPageRead) cursor.needsPageRead = true;
		const normalized = [];
		const fallbackTime = convTimeMs(c.time) || Date.now();
		// 没有平台时间时，ID 里不能塞 Date.now()：每读一次就变一次，UNIQUE(channel_id,message_id) 形同虚设
		// （真机：同一张图被入库五六遍，既重复回复又烧 token）。
		//
		// 🔴 但也**不能只按自然日兜底**：那样「同一天说了两次『在』」「同一天发了两次同一张表情」
		//    会算出同一个 ID，第二句被 UNIQUE 直接吞掉 —— 用户看到的是「她没回我」，
		//    比重复回复严重得多（重复只是烦，漏回是失联）。
		//
		// 正确的分级：
		//   ① 有 `seq`（接口路，最准）        → `s<seq>`
		//   ② 有平台时间（DOM 路现在会从气泡反解，或接口路本来就有） → `<指纹>-<timeMs>-<occ>`
		//   ③ 两者都没有（极少）              → `<指纹>-<自然日>-<occ>`（保底不重复入库）
		const dayKey = new Date().toISOString().slice(0, 10);
		// 同一指纹在这次读到的列表里是第几次出现：对方连发同一句话时，没 seq 的 ID 也不会撞
		const occ = occurrenceIndexes(msgs.map(messageFingerprint));
		for (const [i, m] of fresh.entries()) {
			const { timeMs, messageId } = messageIdFor(m, {
				occ: occ[freshIndexes[i]], fallbackTime, dayKey,
			});
			const norm = normalizeDouyinMessage(m, { name, timeMs, messageId, group, members, identity, convId });
			if (norm !== null) { norm.idConfidence = m.seq ? 'platform' : 'heuristic'; normalized.push(norm); }
		}
		// 消息与游标一起落盘：任何一项失败都不能前移游标。
		this.inbox.record(key, cursor, normalized, (hasWindowGap || truncated) ? { channelId: `${group ? 'douyin-group' : 'douyin'}:${name}`, reason: '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查' } : null);
		// 读成功了，清掉失败标记 + 失败计数（熔断解除，恢复正常轮询）
		this.markReadOk(key);
		await this.drainInbox();
	}

	async drainInbox() {
		if (this.drainingInbox) return;
		this.drainingInbox = true;
		try {
			for (;;) {
				const row = this.inbox.next();
				if (!row || !this.inbox.start(row.id)) break;
				try {
					const m = JSON.parse(row.payload); m.inboxId = row.id;
					const result = await this.onMessage(m);
					if (result?.queued === true) continue; // 完成与发送结果由网关回写
					if (result?.done === true) this.inbox.settle([row.id], true);
					else this.inbox.settle([row.id], false, result?.review || '未取得处理确认，请核实');
				} catch (error) {
					this.inbox.settle([row.id], false, errText(error));
					this.log('error', `[fish-soul] 抖音私信处理结果待核实：${errText(error)}`);
				}
			}
		} finally { this.drainingInbox = false; }
	}

	/** 跑一次页面自检（不含自救）。 */
	async canaryOnce() {
		try { return await this.driver.canary(); } catch (error) { return { ok: false, broken: ['canary'], error: errText(error) }; }
	}

	/**
	 * #72：自检没过 ≠ 改版 —— 抖音页面放久了会被浏览器睡掉（白屏），
	 * 刷新一下就认得回来了。所以先刷新自救一次，再决定要不要报「改版」。
	 * 冷却 10 分钟：页面真的改版时不会一直刷。
	 * @returns {Promise<{refreshed:boolean, skipped?:string, at:number}>} 刷了没有
	 */
	async recoverByRefresh() {
		const now = Date.now();
		if (typeof this.host?.refresh !== 'function') return { refreshed: false, skipped: 'no-refresh', at: now };
		if (now - this.lastRefreshAt < REFRESH_COOLDOWN_MS) return { refreshed: false, skipped: 'cooldown', at: now };
		this.lastRefreshAt = now;
		this.log('info', '[fish-soul] 抖音页面自检没过，刷新一次试试能不能救回来');
		let refreshed = false;
		try { refreshed = await this.host.refresh(); } catch (error) {
			this.log('warn', `[fish-soul] 刷新抖音页面失败：${errText(error)}`);
		}
		return { refreshed, at: now };
	}

	async runCanary() {
		this.lastCanaryAt = Date.now();
		let r = await this.canaryOnce();
		let recovered = null;
		if (!r?.ok) {
			// 白屏 / 睡死 → 刷新一次再来；刷新完认回来了就当没发生过
			const rec = await this.recoverByRefresh();
			if (rec.refreshed) {
				const again = await this.canaryOnce();
				recovered = { ...rec, ok: again?.ok === true };
				r = again;
			} else {
				recovered = { ...rec, ok: false };
			}
		}
		this.canaryReport = { ...r, at: Date.now(), recovered };
		if (r?.ok) {
			if (this.replyPaused) this.log('info', '[fish-soul] 抖音页面自检恢复正常，自动回复继续');
			this.replyPaused = false;
			this.notify('douyin.page', null);
		} else {
			this.replyPaused = true;
			this.log('warn', `[fish-soul] 抖音页面自检没过（${(r?.broken ?? []).join('、') || r?.error || '?'}），自动回复先停`);
			this.notify('douyin.page', '抖音网页好像改版了，鱼认不出私信页面，抖音自动回复先停了（设置页「抖音」里有自检报告，可以复制给开发者）');
		}
		return this.canaryReport;
	}

	/** 设置页手动自检（会打开私信面板）。 */
	async selfCheck() {
		if (!this.host.running) return { ok: false, error: '抖音浏览器没在运行' };
		return await this.host.exclusive('自检', async () => {
			const loggedIn = await this.driver.checkLogin();
			const list = loggedIn ? await this.driver.list().catch((e) => ({ ok: false, error: errText(e) })) : { ok: false, error: '没登录' };
			const report = await this.runCanary();
			return { ok: report.ok === true && list.ok === true, loggedIn, list: { ok: list.ok, count: list.conversations?.length ?? 0, error: list.error ?? '' }, canary: report };
		}, { maxMs: 90_000 });
	}

	/** 模拟打字的停顿：1.5–3 秒 + 每字 80 毫秒，最多 8 秒。 */
	typingDelay(text) {
		const [lo, hi] = this.typingMs;
		if (hi <= 0) return 0;
		return Math.min(8000, lo + Math.floor(Math.random() * Math.max(0, hi - lo)) + 80 * String(text ?? '').length);
	}

	/**
	 * 发一组内容（串行、每段之间模拟打字）。
	 * parts: [{type:'text', text} | {type:'image', path} | {type:'emoji', name}]
	 *
	 * @returns {Promise<{ok: boolean, delivered: boolean, parts: Array<object>}>}
	 *   `ok`        —— 每段的发送动作都执行完、driver 没报错
	 *   `delivered` —— 至少有一段落到了「回读能看见」的证据
	 *
	 * 🔴 为什么要把这两个分开：
	 *   抖音风控会**静默吞消息** —— Enter 按了、UI 没报错，但消息根本没进会话。
	 *   以前 send() 只返回一个 allOk，被吞的时候照样 true，上层以为发出去了。
	 *   现在 driver 的回读结果（sendDM 的 `verified` / sendImage 的 `verified`）
	 *   一路带上来，上层才能说清「动作做了」和「对方真能看见」是两回事。
	 */
	send(name, parts, convId = '') {
		const run = async () => {
			if (!this.host.running) throw new Error('抖音浏览器没在运行');
			/**
			 * 🔴 没有会话 ID 就不发。
			 *
			 * 昵称只能用来「找到会话」，不能证明「打开的就是这个人」。以前只靠名字
			 * 做包含比对，同名或名字互相包含时会把消息发给错的人（而且是静默的）。
			 * 拿不到 convId 说明这条会话的身份没确认过，宁可失败也不猜。
			 */
			// 🔴 群会话的 convId 不是 `0:1:` 形状（`<数字>:<数字>:...`），
			//    以前这里把群全拒了 ⇒ 群里回不了话（2026-11-19 真机修）。
			//    判据改成「必须非空」：有没有会话 ID 是身份确认的关键，
			//    形状不是。驱动的 sendDM 拿 expectConvId 做**字符串相等**比对，
			//    群会话 ID 一样能比。
			if (!isDouyinConversationId(convId)) {
				throw new Error('这个抖音会话没有确认过身份（缺少会话 ID），不发，以免发错人');
			}
			let allOk = true;
			let delivered = false;
			const details = [];
			/** 发一段（表情面板里没这个名字就退回文字）。整条流程都在锁里，直接调驱动。 */
			const sendPart = async (part) => {
				if (part.type === 'image') return await this.driver.sendImage(name, part.path, convId);
				if (part.type === 'emoji') {
					const e = await this.driver.sendEmoji(name, part.name, convId);
					// 表情面板里没有这个名字：当文字发
					return e?.ok ? e : await this.driver.sendText(name, `[${part.name}]`, convId);
				}
				return await this.driver.sendText(name, part.text, convId);
			};
			/**
			 * 🔴 整条发送流程（所有段 + 打字停顿 + 进会话）必须**独占浏览器锁**。
			 *
			 *    以前锁只包住「每一段的发送动作」：段与段之间、以及第一段之前的打字停顿，
			 *    锁都是空着的 —— 轮询（读私信）正好插进来 readDM → enterChat：
			 *    进别的会话，还把会话列表滚到那儿（抖音的会话列表是虚拟滚动的，
			 *    眼下只有几个会话在 DOM 里）。下一段再进目标会话就点不到了 ——
			 *    enterChat 抛「找不到会话「X」」，整条回复被判「回复没发出去（发送失败）」
			 *    （真机 2026-11-12：未云那条和 Re. 那条的发送窗口撞在一起）。
			 *
			 *    锁是 FIFO 的：轮询排在整条发送**之后**，发送中途就插不进来了。
			 *    ⚠️ 这里不能再套一层 exclusive（自己抢自己的锁会死锁）。
			 */
			// 超时预算：一次性的 90 秒（开面板、打字停顿余量）+ 每段 60 秒（进会话 + 发送 + 回读）
			const maxMs = 90_000 + parts.length * 60_000;
			await this.host.exclusive('发私信', async () => {
				for (const part of parts) {
					await sleep(this.typingDelay(part.type === 'text' ? part.text : ''));
					const r = await sendPart(part).catch((error) => ({ ok: false, error: errText(error) }));
					// 回读确认：文字（sendDM）/ 图片（sendImage）/ 表情（sendEmoji）三条都会
					// 在发完之后数一遍气泡，真的多出来才回 verified。所以这里统一认 verified。
					// ⚠️ 表情走文字兜底（面板里没这个名字）时就没有 verified 了 ——
					//    那条是当普通消息发的，`type` 仍是 emoji，只能按「没回读」算。
					const seen = r?.ok === true && r.verified === true;
					if (seen) delivered = true;
					if (!r?.ok) {
						allOk = false;
						this.log('error', `[fish-soul] 发抖音私信给「${name}」失败：${r?.error ?? '未知'}`);
					} else if (part.type !== 'emoji' && r.verified !== true) {
						// 动作做了但回读没看见 —— 大概率被风控吞了，这条要留下来
						this.log('warn', `[fish-soul] 发给「${name}」的${part.type === 'image' ? '图片' : '消息'}没在列表里回读到，可能被风控吞了`);
					}
					details.push({ type: part.type, ok: r?.ok === true, delivered: seen, error: r?.error ?? '' });
				}
			}, { maxMs }).catch((error) => {
				// 整条流程超时（锁的 maxMs 到了）：记失败。⚠️ exclusive 超时不取消 fn，
				// 那一节还在锁里跑完 —— 结果已经交出去了，下面只快照此刻已知的部分。
				allOk = false;
				this.log('error', `[fish-soul] 发抖音私信给「${name}」中断：${errText(error)}`);
			});
			// 自己发出去的消息进窗口，下一轮不当成新消息（下一轮读的时候它们是"我"发的，本来也不会回）
			return { ok: allOk, delivered, parts: details.slice() };
		};
		const p = this.sendChain.then(run, run);
		this.sendChain = p.catch(() => {});
		return p;
	}

	/**
	 * 把一个视频以**原生卡片**分享给主人（走页面里的「分享给朋友」面板）。
	 *
	 * 不是发链接、也不是下载文件再上传 —— 是抖音私信里那条点开就播的原生卡片。
	 *
	 * 🔴 收件人只认**会话身份确认过的对端**（`0:1:<我的uid>:<对端uid>`，对端从会话 ID 推出来）。
	 *    以前这里还额外要求「对端必须是设置页填的主人」—— 现在不要求了：
	 *    主人要求「聊天里发抖音链接对所有会话都发原生卡片」。
	 *
	 *    为什么放开仍然安全：
	 *      ① 收件人 uid **只**来自会话 ID，而会话 ID 来自抖音自己的帧，不是用户输入；
	 *      ② 卡片按 **uid** 分享（分享面板里 `data-userid` 唯一可见才点），不按昵称；
	 *      ③ 面板里没有这个人 ⇒ 分享失败 ⇒ 调用方退回文字，不会发错人。
	 *    ⚠️ 调用方传了 peerUid 就必须和会话推出的对端一致 —— 不一致说明它认错了人，宁可不发。
	 *
	 * @param {{videoId: string, peerUid: string, convId: string, friendName: string}} p 收件人身份与作品
	 * @param {() => void} [onSubmitted] 点击**之前**落盘用（提交了就可能已经发出去了）
	 * @returns {Promise<{ok: boolean, verified: boolean, submitted: boolean, error?: string}>}
	 */
	async shareCard({ videoId, peerUid, convId, friendName }, onSubmitted = () => {}) {
		const run = async () => {
			if (!this.host.running) return { ok: false, verified: false, submitted: false, error: '抖音浏览器没在运行' };
			const cfg = this.getConfig() ?? {};
			if (cfg.enabled !== true) return { ok: false, verified: false, submitted: false, error: '抖音通道关着' };
			// 会话 ID 的对端 = 收件人；自己不在会话里、或会话 ID 不认识，都不发。
			const peer = peerUidFromConversation(convId, this.selfUids());
			if (peer === '') return { ok: false, verified: false, submitted: false, error: '缺少明确收件人会话身份，未分享' };
			// 传了 peerUid 就必须和会话 ID 推出的对端一致 —— 不一致说明调用方认错了人，宁可不发。
			// 不传（普通私信里发链接）就以会话 ID 为准：能推出对端就说明身份是确认过的。
			// ⚠️ 以前这里还要求 peer === masterUid，于是**只给主人发得出卡片**；
			//    现在所有会话都发卡片，主人这道限制去掉，但「对端必须能从 convId 推出来」留着。
			if (peerUid !== undefined && peerUid !== null && String(peerUid).trim() !== '' && peer !== String(peerUid).trim()) {
				return { ok: false, verified: false, submitted: false, error: '收件人和会话身份对不上，未分享' };
			}
			const browser = this.host.browser;
			if (browser === null || browser === undefined) return { ok: false, verified: false, submitted: false, error: '抖音浏览器没在运行' };
			return await this.host.exclusive('分享视频卡片', () => shareVideoToFriend({
				browser,
				videoId: String(videoId ?? ''),
				peerUid: peer,
				friendName: String(friendName ?? ''),
				onSubmitted,
				log: (stage, info) => this.log('info', `[fish-soul] ${stage} ${JSON.stringify(info)}`),
				// 分享用的是另开的标签页；窗口要不要留在屏幕外，沿用宿主当前的显示模式
				windowMode: typeof browser.windowMode === 'function' ? browser.windowMode() : 'background',
			}), { maxMs: 120_000 }).catch((error) => ({ ok: false, verified: false, submitted: false, error: errText(error) }));
		};
		const task = this.sendChain.then(run, run);
		this.sendChain = task.catch(() => {});
		return task;
	}
}
