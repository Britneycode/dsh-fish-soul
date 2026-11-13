import { sleep } from '../time-util.js';
import { DouyinInbox } from '../douyin-inbox.js';
import {
	parseSingleConversation, isSingleConversation, conversationIdentity,
	senderBelongsToConversation, peerUidFromConversation
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
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fishSoulDir, getKv, setKv } from '../db.js';
import { BROWSER_KINDS, detectBrowsers, pickBrowser } from '../browsers.js';
import { getBrowser } from './vendor/douyin-bridge/browser.mjs';
import { HOOK_SOURCE, setCacheFile, startCollector } from './vendor/douyin-bridge/douyin-api.mjs';
import { COMMENT_BRIDGE_SOURCE } from './vendor/douyin-bridge/douyin-comment.js';
import { checkLogin, dmList, readDM, sendDM, sendEmoji, sendImage, drainPushFrames } from './vendor/douyin-bridge/douyin-dm.mjs';
import { knownEmojiNames } from './vendor/douyin-bridge/media.mjs';
import { canary } from './vendor/douyin-bridge/selectors.mjs';
import { PARK_LEFT, parkWindow, showWindow, ensurePanel } from './vendor/douyin-bridge/douyin-panel.mjs';
import { shareVideoToFriend } from './vendor/douyin-bridge/douyin-share.mjs';
import { parseTime } from './vendor/douyin-bridge/douyin-util.mjs';

export const DOUYIN_HOME = 'https://www.douyin.com/';
const DEFAULT_PORT = 47890;
const CRASH_RETRY_MS = 30_000;
const CRASH_MAX = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const LOCK_MAX_MS = 4 * 60_000;
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
/**
 * 抖音私信/群聊身份：一键回退开关。
 *
 * 现在有真正的身份机制了（会话 ID + 自己的 uid → 推出对端，见 douyin-conversation.js），
 * 所以这里**关闭**。身份是否可用不再靠这个常量，而是按证据判断：
 * 不知道自己的 uid、或某次读取拿不到会话 ID，都会就地拒绝处理/发送（见 identityReady）。
 *
 * 留这个开关是为了出事时能立刻退回「全停」而不用改逻辑 —— 设成 true 就恢复成
 * 之前那种「私信一律隔离、不处理不发送」的保守状态。
 */
export const DOUYIN_IDENTITY_BLOCKED = false;

const errText = (e) => String(e instanceof Error ? e.message : e);
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

/** 会话列表里的时间（"03:27" / "5分钟前" / "昨天" / "10月16日"）→ 毫秒，认不出返回 0。 */
export function convTimeMs(s, now = new Date()) {
	const t = String(s ?? '').trim();
	const m = /^(\d{1,2}):(\d{2})$/.exec(t);
	if (m) {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]));
		if (d.getTime() > now.getTime() + 60_000) d.setDate(d.getDate() - 1);
		return d.getTime();
	}
	return Date.parse(parseTime(t, now) || '') || 0;
}

/** 抖音私信里一条消息的指纹（对比窗口用）：谁发的 + 正文 + 媒体（图片地址去掉会变的签名参数）。 */
export function messageFingerprint(m) {
	const media = m?.media ?? {};
	let src = String(media.data || media.src || '');
	if (src.startsWith('data:')) src = sha1(src).slice(0, 16);
	else {
		const i = src.indexOf('/obj/');
		src = (i >= 0 ? src.slice(i) : src).split('?')[0].slice(-60);
	}
	return sha1([m?.fromMe ? 'me' : 'peer', String(m?.text ?? '').trim().slice(0, 120), m?.type ?? '', src, media.name ?? '', m?.shareAweme ?? ''].join('|')).slice(0, 16);
}

/**
 * 这次读到的消息（旧 → 新）里，哪些是上次窗口之后新来的。
 * 对齐办法：在这次的列表里找上次窗口最后几条（最多 3 条）连续出现的位置，之后的就是新的；
 * 对不上（中间来了 20 条以上，窗口整个滚走了）就把末尾不在上次窗口里的那一段当新的（调用方再限条数）。
 * @param {string[]} prev 上次的指纹窗口
 * @param {string[]} cur 这次的指纹
 * @returns {number} 新消息从 cur 的哪个下标开始（cur.length = 没有新消息）
 */
export function newFrom(prev, cur) {
	if (!Array.isArray(prev) || prev.length === 0) return 0;
	// 🔴 尾部对齐前先处理「同一句话连发」这个坑：
	//    指纹只含（谁 + 文字 + 类型 + 媒体），连发三条一模一样的话 → 三个相同指纹。
	//    纯按位置匹配尾部时，`prev=[在] cur=[在,在]` 会匹配到**最后一个** `在`，
	//    得出「没有新消息」—— 于是对方连发的第二句永远收不到（真机里很常见）。
	//    正确判据是**数量差**：同指纹的条数多了几条，就是新来了几条。
	const prevCount = new Map();
	for (const h of prev) prevCount.set(h, (prevCount.get(h) ?? 0) + 1);
	const curCount = new Map();
	for (const h of cur) curCount.set(h, (curCount.get(h) ?? 0) + 1);
	let grown = 0;
	for (const [h, n] of curCount) grown += Math.max(0, n - (prevCount.get(h) ?? 0));
	// 新增条数 >= 尾部匹配能解释的条数时，按「末尾 grown 条是新的」算：
	// 这样连发场景不会因为对齐到最后一个而漏掉。
	const byPosition = (() => {
		const tail = prev.slice(-3);
		for (let L = tail.length; L >= 1; L--) {
			const want = tail.slice(-L);
			for (let j = cur.length - 1; j >= L - 1; j--) {
				let ok = true;
				for (let k = 0; k < L; k++) if (cur[j - k] !== want[want.length - 1 - k]) { ok = false; break; }
				if (ok) return j + 1;
			}
		}
		return null;
	})();
	if (grown > 0 && (byPosition === null || cur.length - byPosition < grown)) {
		// 位置对齐算出的「新消息条数」少于真实新增条数 → 说明被同指纹吞了，用数量差修正
		return cur.length - grown;
	}
	if (byPosition !== null) return byPosition;
	const known = new Set(prev);
	const i = cur.findIndex((h, idx) => !known.has(h) && cur.slice(idx).every((x) => !known.has(x)));
	return i < 0 ? cur.length : i;
}

/**
 * 每个指纹在列表里是第几次出现（从 0 数）：['a','b','a','a'] → [0,0,1,2]。
 * 拼进没有 seq 的 messageId，让连发的同一句话 ID 不同（否则网关按 ID 去重会吞掉后几条）。
 * @param {string[]} prints
 * @returns {number[]}
 */
export function occurrenceIndexes(prints) {
	const seen = new Map();
	return (prints ?? []).map((p) => {
		const n = seen.get(p) ?? 0;
		seen.set(p, n + 1);
		return n;
	});
}

/**
 * 这个会话是不是群聊：接口里的会话类型 = 2、会话 ID 不是单聊的 0:1:xxx:yyy 形状、
 * 对方的消息来自两个以上不同的人，或者设置页「抖音群聊」里填了这个会话名。
 */
export function isGroupConversation(msgs, { name = '', groups = [] } = {}) {
	if (groups.includes(String(name).trim())) return true;
	const peers = new Set();
	for (const m of msgs ?? []) {
		if (!m) continue;
		if (Number(m.convType) === 2) return true;
		const cid = String(m.convId ?? '');
		if (cid !== '' && /^\d+:\d+:/.test(cid) && !/^0:1:/.test(cid)) return true;
		// 这里用 !== true 而不是 === false：这个函数是纯函数，输入可能没有 fromMe 字段
		// （DOM 路构造的对象 / 测试直接造的）。群聊判定要数「有几个人」，未知按对方算
		// 才安全 —— 少算会把群当单聊（走错路径永远读不到），多算只是多一个 peer。
		if (m.fromMe !== true) {
			// 🔴 只认 ID，**不认昵称**：DOM 路补的媒体消息没有 senderId、只有 senderName，
			//    拿昵称当「一个人」会把「同一个人 + 他的昵称」数成两个 peer → 单聊被误判成群
			//    （真机见过：会话「未云」的游标被写成 group: true，从此走群聊路径读，永远读不到）。
			const who = String(m.senderId || m.secUid || '');
			if (who !== '') peers.add(who);
		}
	}
	return peers.size >= 2;
}

/**
 * 推送帧能不能处理：**这一帧该入库，还是该丢掉**。
 *
 * 抽成纯函数是因为这是「消息凭空消失」的唯一入口 —— 以前它写在
 * `consumePushFrames` 里、两行静默 `continue`，没有任何测试能碰到，
 * 于是 v0.15.34 上线后真机上「uid 和 convId 都解出来了、消息就是不回复」
 * 查了很久才定位到这两行。
 *
 * @param {{identity?: string, name?: string, convId?: string, selfUidCount?: number}} p
 * @returns {{ok: true, name: string} | {ok: false, reason: string, stat: string, message: string}}
 */
export function pushFrameVerdict({ identity = '', name = '', convId = '', selfUidCount = 0 } = {}) {
	if (String(identity).trim() === '') {
		return {
			ok: false,
			reason: 'noIdentity',
			stat: 'droppedNoIdentity',
			message: `推送帧解不出会话身份（convId=${convId || '空'}，已知 selfUid 数=${selfUidCount}）——还不知道自己是谁，这批消息处理不了`,
		};
	}
	if (String(name).trim() === '') {
		// 昵称只用于「按名字打开会话」，不是身份。
		// 轮询路在已打开的会话上会卡住读超时 → 学不到昵称 → 推送路以前就死等，
		// 两边互等 ⇒ 消息永远进不来。所以至少要能看见「在等什么」。
		//
		// ⚠️ `stat` 是「真丢掉时记在哪个账上」，不是「调用方一定记这个账」：
		//    接线层现在**先攒着**（见 `parkPushFrame`），只有攒到过期还学不到昵称
		//    才真的记进 `droppedNoName`。
		return {
			ok: false,
			reason: 'noName',
			stat: 'droppedNoName',
			message: `推送帧缺昵称映射（identity=${identity}）——先攒着等轮询路读到这个会话`,
		};
	}
	return { ok: true, name: String(name) };
}

/**
 * 用消息正文去会话列表的预览里反查「这是谁的会话」—— 推送路缺昵称时唯一的证据来源。
 *
 * 抽成纯函数是为了把**「什么时候算认出来了」**说清楚：
 *
 *   · 必须**唯一命中**。两行预览都包含这句话时返回 ''（宁可这批消息先不收，
 *     也不能把消息记到别人名下 —— 记错人比晚收严重得多）。
 *   · 先用**最长**的那条文本匹配：对方只发「好」这种单字时，短文本很容易
 *     撞上别的会话的预览（「好的」「好像」…），长文本区分度高。
 *   · 空名字 / 空预览的行不参与匹配。
 *
 * @param {Array<{name?: string, preview?: string}>} rows 会话列表（DOM 里读的）
 * @param {string[]} texts 帧里「对方发的」消息正文
 * @returns {string} 会话名，认不出返回 ''
 */
export function matchConversationByPreview(rows, texts) {
	const want = (texts ?? []).map((t) => String(t ?? '').trim()).filter((t) => t !== '').sort((a, b) => b.length - a.length);
	if (want.length === 0) return '';
	const list = (rows ?? []).filter((r) => String(r?.name ?? '').trim() !== '');
	if (list.length === 0) return '';
	for (const text of want) {
		const hits = list.filter((r) => String(r.preview ?? '').includes(text));
		if (hits.length === 1) return String(hits[0].name).trim();
		// 多行都像 → 歧义，换下一条（更短的更没区分度，所以直接放弃）
		if (hits.length > 1) return '';
	}
	return '';
}

/**
 * 群聊里这条是谁说的：有昵称用昵称（和私信里一样按名字认人，同一个人私信 / 群聊归到一起）；
 * 只有发送者 ID 就查这个群之前对上过的昵称，再不行用「群友 + ID 后四位」。
 */
export function groupSender(m, members = {}) {
	const id = String(m?.senderId || m?.secUid || '');
	const name = String(m?.senderName ?? '').trim() || (id !== '' ? String(members[id] ?? '').trim() : '');
	if (name !== '') return { userId: name, nickname: name };
	if (id !== '') return { userId: `uid:${id}`, nickname: `群友${id.slice(-4)}` };
	return { userId: '', nickname: '' };
}

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
		if (src) images.push({ url: src });
		text = '【图片】';
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
		return {
			channel: 'douyin',
			chatType: 'group',
			channelId: `douyin-group:${name}`,
			targetId: name,
			groupId: name,
			userId: who.userId,
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
	// 🔴 单聊认人：优先用**接口给的 senderId**（真实数字 ID，改名也不变），
	//    拿不到才退回会话名。
	//
	//    以前这里硬编码 `userId: name`（会话名 = 抖音昵称），于是「主人是谁」靠昵称比对 ——
	//    主人一改昵称就认不出来，别人起个同名就能冒充。实测（2026-11-08）接口路**是给
	//    senderId 的**（如 7702399256389125000），只有 DOM 路没有。所以能稳就稳。
	//
	//    ⚠️ 必须是 `uid:<id>` 这个格式，**不能是裸 id** —— 群聊那条路
	//       （groupSender）早就用 `uid:<id>` 存 douyin_uid 了。格式不一致的话，
	//       同一个人在群里是 `uid:7702399256389125000`、在私信里是 `7702399256389125000`，
	//       会被当成两个人，各记一套记忆。
	//
	//    ⚠️ `channelId` **仍然按会话名**：私信面板是按名字打开会话的，
	//    改成 ID 会导致 sendDM/enterChat 全部找不到人。这两件事必须分开：
	//    认人用 ID，找会话用名字。
	// 认人只认会话身份（`douyin:<对方uid>`）。昵称、以及单条消息的 senderId 都**不再**
	// 当作身份：前者可被同名冒充，后者无法证明属于当前会话（见 docs/douyin-identity-validation.md）。
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

/**
 * 专用浏览器的生命周期。所有会动页面的操作都走 exclusive()（一次只做一件事）。
 */
export class DouyinHost {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => object} deps.getConfig 返回 config.douyin
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {(key: string, text: string|null) => void} [deps.notify]
	 * @param {(browser: object) => Promise<any>} [deps.openPanel] 打开私信面板（测试里换假的）
	 */
	constructor({ db, getConfig, log, notify, port, profileRoot, detect = detectBrowsers, launch = getBrowser, openPanel = ensurePanel } = {}) {
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.notify = notify ?? (() => {});
		this.port = Number(port ?? process.env.FISH_SOUL_DOUYIN_PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
		this.profileRoot = profileRoot ?? join(fishSoulDir(), 'douyin-browser');
		this.detect = detect;
		this.launch = launch;
		this.openPanel = openPanel;
		this.browser = null;
		this.info = null;
		this.browsers = null;
		this.state = 'stopped';
		this.lastError = '';
		this.loggedIn = null;
		this.stopCollector = null;
		this.targetGoneAt = 0;
		this.exitZeroAt = 0;
		this.crashes = [];
		this.retryTimer = null;
		this.starting = null;
		this.disposed = false;
		this.lock = Promise.resolve();
		this.busy = '';
		this.cacheReady = false;
		this.windowShown = false; // 后台模式下，设置页点了「显示一下」
	}

	/** 窗口模式：background = 停在屏幕外不打扰（默认），visible = 跟普通窗口一样。 */
	windowMode() {
		return this.getConfig()?.window === 'visible' ? 'visible' : 'background';
	}

	effectiveWindowMode() {
		return this.windowMode() === 'visible' || this.windowShown ? 'visible' : 'background';
	}

	/** 后台模式下把窗口停回屏幕外（已经停好的不动）。 */
	async tidyWindow() {
		if (!this.running || this.effectiveWindowMode() !== 'background') return false;
		try { return await parkWindow(this.browser); } catch { return false; }
	}

	/** 设置页「显示一下」：挪回屏幕里，直到点「藏起来」。 */
	async showWindow() {
		this.windowShown = true;
		if (!this.running) return false;
		try { return await showWindow(this.browser); } catch (error) {
			this.log('warn', `[fish-soul] 抖音浏览器窗口挪不回来：${errText(error)}`);
			return false;
		}
	}

	/** 设置页「藏起来」/ 换回后台模式。 */
	async hideWindow() {
		this.windowShown = false;
		return this.tidyWindow();
	}

	get paused() {
		return getKv(this.db, 'douyin.browser.paused', false) === true;
	}

	setPaused(v, why = '') {
		setKv(this.db, 'douyin.browser.paused', v === true);
		if (v === true) setKv(this.db, 'douyin.browser.pausedWhy', why);
	}

	get running() {
		return this.state === 'running' && this.browser !== null && this.browser.isAlive();
	}

	browserPref() {
		const b = this.getConfig()?.browser ?? {};
		return { kind: String(b.kind ?? 'edge') || 'edge', customPath: String(b.customPath ?? '').trim() };
	}

	async rescan() {
		try { this.browsers = await this.detect(); } catch (error) {
			this.browsers = [];
			this.log('warn', `[fish-soul] 找浏览器失败：${errText(error)}`);
		}
		return this.browsers;
	}

	async listBrowsers() {
		if (this.browsers === null) await this.rescan();
		return this.browsers;
	}

	extraArgs() {
		const args = ['--mute-audio'];
		// 后台模式：一启动就在屏幕外（命令行位置不会被浏览器夹回屏幕里），不闪一下
		if (this.effectiveWindowMode() === 'background') args.push(`--window-position=${PARK_LEFT},0`);
		const env = String(process.env.FISH_SOUL_DOUYIN_ARGS ?? '').trim();
		// 按「空格 + --」切，参数值里可以带空格（例如 --host-resolver-rules=MAP a b）
		if (env !== '') args.push(...env.split(/\s+(?=--)/).map((a) => a.trim()).filter((a) => a.startsWith('--')));
		return args;
	}

	/**
	 * 启动（或连上已经在跑的）专用浏览器。resume=true 表示用户点了「启动」：清掉暂停标记。
	 * 用户关窗口后的暂停状态下，自动流程（插件启动、定时器）不会把窗口再弹出来。
	 */
	async start({ resume = false } = {}) {
		if (this.disposed) return false;
		if (resume) { this.setPaused(false); this.crashes = []; }
		if (this.paused) { this.state = 'paused'; return false; }
		if (this.running) return true;
		this.starting ??= this.doStart().finally(() => { this.starting = null; });
		return await this.starting;
	}

	async doStart() {
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.state = 'starting';
		const list = await this.listBrowsers();
		const info = pickBrowser(list, this.browserPref());
		if (info === null) {
			this.state = 'error';
			this.lastError = this.browserPref().customPath ? '手动指定的浏览器路径不存在' : '没找到 Edge / Chrome 等 Chromium 系浏览器';
			return false;
		}
		// 换了浏览器：先把旧的关掉（两个浏览器不能共用调试端口）
		if (this.browser !== null && this.info !== null && this.info.path !== info.path) await this.quitBrowser();
		this.info = info;
		const userDataDir = join(this.profileRoot, info.kind);
		try {
			mkdirSync(userDataDir, { recursive: true });
			if (!this.cacheReady) { setCacheFile(join(fishSoulDir(), 'douyin-im-cache.json')); this.cacheReady = true; }
			if (this.browser !== null) { try { this.browser.detach(); } catch { /* 已断 */ } this.browser = null; }
			let b = null;
			b = await this.launch({
				exe: info.path,
				userDataDir,
				port: this.port,
				log: (msg) => this.log('info', `[fish-soul] 抖音浏览器：${msg}`),
				reuse: true,
				preloadScripts: [HOOK_SOURCE, COMMENT_BRIDGE_SOURCE],
				extraArgs: this.extraArgs(),
				onDead: (code) => { if (b !== null) this.onDead(b, code); }
			});
			if (this.disposed) { try { b.detach(); } catch { /* 已断 */ } return false; }
			b.onDead = (code) => this.onDead(b, code);
			b.onEvent = (msg) => this.onEvent(b, msg);
			b.windowMode = () => this.effectiveWindowMode(); // douyin-panel 的 ensureWindowVisible 看这个
			try { await b.send('Target.setDiscoverTargets', { discover: true }); } catch { /* 老版本没有也不要紧 */ }
			this.browser = b;
			this.targetGoneAt = 0;
			this.exitZeroAt = 0;
			this.state = 'running';
			this.lastError = '';
			this.notify('douyin.browser', null);
			this.stopCollector?.();
			this.stopCollector = startCollector(b);
			await this.tidyWindow(); // 连上的是早就开着的浏览器 / 命令行位置没生效：现在停出去
			const href = await b.eval('location.href').catch(() => '');
			if (!/^https:\/\/[^/]*douyin\.com\//.test(String(href))) {
				await this.exclusive('打开抖音', () => b.goto(DOUYIN_HOME, { settleMs: 6000 })).catch((error) => {
					this.log('warn', `[fish-soul] 抖音首页没打开：${errText(error)}`);
				});
			}
			this.log('info', `[fish-soul] 抖音专用浏览器已就绪（${info.name}${info.version ? ` ${info.version}` : ''}）`);
			return true;
		} catch (error) {
			this.state = 'error';
			this.lastError = errText(error);
			this.log('warn', `[fish-soul] 抖音浏览器启动失败：${this.lastError}`);
			return false;
		}
	}

	/** CDP 事件：我们的标签页被关了（用户关窗口 / 关标签页都会先有这个）。 */
	onEvent(b, msg) {
		if (b !== this.browser) return;
		const p = msg.params ?? {};
		const gone = (msg.method === 'Target.detachedFromTarget' && (p.sessionId === b.sessionId || p.targetId === b.targetId)) ||
			(msg.method === 'Target.targetDestroyed' && p.targetId === b.targetId) ||
			(msg.method === 'Inspector.detached' && msg.sessionId === b.sessionId);
		if (!gone || this.targetGoneAt > 0) return;
		this.targetGoneAt = Date.now();
		// 浏览器还开着（只关了这个标签页）：也算用户自己关的 → 暂停，断开连接但不关浏览器
		// 整个浏览器在关时，标签页事件比 ws 关闭早一两秒到、进程也还没被回收 —— 只看这些会误报成"关了标签页"。
		// 用 CDP 端口确认浏览器是否真的还在：还在才算「只关了标签页」，没了就是浏览器关了。
		setTimeout(async () => {
			if (b !== this.browser || this.disposed) return;
			// 端口探测失败也可能是偶发超时：隔一会儿再探一次，两次都没应答才算浏览器真的关了
			const probe = async () => {
				if (typeof b.probePort !== 'function') return true; // 兜底：没有探测能力的实现按"还开着"处理
				try { return Boolean(await b.probePort()); } catch { return true; }
			};
			if (!(await probe())) {
				await new Promise((r) => setTimeout(r, 800).unref?.());
				if (b !== this.browser || this.disposed) return;
				if (!(await probe())) {
					// 端口已经没了 = 浏览器整个在关（进程可能还在收尾，ws 也可能还挂着）→ 按"浏览器关了"暂停
					this.pauseByUser('你把抖音浏览器关了');
					try { b.detach(); } catch { /* 已断 */ }
					this.browser = null;
					return;
				}
			}
			if (b.ready && b.isAlive()) {
				this.pauseByUser('你把抖音标签页关了');
				try { b.detach(); } catch { /* 已断 */ }
				this.browser = null;
			}
		}, 1500).unref?.();
	}

	onDead(b, code) {
		if (b !== this.browser || this.disposed || this.state === 'closing') return;
		if (code === 0) this.exitZeroAt = Date.now();
		if (this.state !== 'running') return;
		// 连接断了：等一下看看是不是用户关的（关窗口时先有标签页关闭事件 / 进程正常退出）
		this.state = 'checking';
		setTimeout(() => {
			if (b !== this.browser || this.disposed || this.state !== 'checking') return;
			this.stopCollector?.();
			this.stopCollector = null;
			const byUser = (this.targetGoneAt > 0 && Date.now() - this.targetGoneAt < 10_000) || (this.exitZeroAt > 0 && Date.now() - this.exitZeroAt < 10_000);
			this.browser = null;
			if (byUser) { this.pauseByUser('你把抖音浏览器关了'); return; }
			this.onCrash();
		}, 2000).unref?.();
	}

	pauseByUser(why) {
		this.stopCollector?.();
		this.stopCollector = null;
		this.setPaused(true, why);
		this.state = 'paused';
		this.lastError = '';
		this.log('info', `[fish-soul] ${why}：抖音先暂停，去设置页点「启动」恢复`);
	}

	onCrash() {
		const now = Date.now();
		this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
		this.crashes.push(now);
		if (this.crashes.length > CRASH_MAX) {
			this.state = 'error';
			this.lastError = `浏览器 10 分钟内断了 ${this.crashes.length} 次，先停下了；去设置页点「启动」重试`;
			this.log('warn', `[fish-soul] ${this.lastError}`);
			this.notify('douyin.browser', `抖音专用浏览器老是崩（${this.lastError}）`);
			return;
		}
		this.state = 'error';
		this.lastError = `浏览器断开了，${CRASH_RETRY_MS / 1000} 秒后自动重连（第 ${this.crashes.length} 次）`;
		this.log('warn', `[fish-soul] ${this.lastError}`);
		clearTimeout(this.retryTimer);
		// 重连本身失败也要吞掉：否则这次 reject 变成未处理拒绝，进程直接退出（连重试都没了）
		this.retryTimer = setTimeout(() => { void this.start().catch((error) => this.log('warn', `[fish-soul] 抖音浏览器重连失败：${String(error instanceof Error ? error.message : error)}`)); }, CRASH_RETRY_MS);
		this.retryTimer.unref?.();
	}

	async quitBrowser() {
		const b = this.browser;
		this.stopCollector?.();
		this.stopCollector = null;
		if (b === null) return;
		this.state = 'closing';
		try { await b.quit(); } catch { /* 已经没了 */ }
		this.browser = null;
		this.state = 'stopped';
	}

	/** 设置页「关闭浏览器」：真的关掉，并暂停（不会自己再开）。 */
	async closeBrowser() {
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.setPaused(true, '你在设置页关掉了抖音浏览器');
		await this.quitBrowser();
		this.state = 'paused';
		this.loggedIn = null;
	}

	/** 插件卸载：只断开连接，浏览器留着（热重载后新实例直接连上）。 */
	dispose() {
		this.disposed = true;
		clearTimeout(this.retryTimer);
		this.stopCollector?.();
		this.stopCollector = null;
		if (this.browser !== null) { try { this.browser.detach(); } catch { /* 已断 */ } }
		this.browser = null;
	}

	/**
	 * 互斥：同一时间只有一件事在动页面。
	 *
	 * 🔴 超时的语义是「**报错给调用方**」，不是「放锁让别人上」。
	 *    以前超时就 clearTimeout + 清 busy 直接放锁，但 `fn()` 本身没有被取消
	 *    （没有 AbortSignal 传进去），它还在动页面 —— 下一件事（比如发私信）
	 *    立刻开始，两个操作抢同一个 CDP 会话 / 同一个输入框。实测：
	 *    读私信 3 分钟超时后发私信，`read:still-running` 在 `send:end` 之后才打印。
	 *    `sendDM` 的 expectConvId 能兜住「发错人」，但兜不住「输入框被读操作清掉」。
	 *
	 *    现在：超时只让**调用方**拿到错误，锁要等 fn() 真正 settle 才放。
	 *    死锁风险由 maxMs 的报错 + 调用方超时兜底（不会永远挂着）。
	 */
	exclusive(label, fn, { maxMs = LOCK_MAX_MS } = {}) {
		const run = async () => {
			this.busy = label;
			let timer;
			let timedOut = false;
			// 让调用方先拿到超时错误，但 fn() 继续在锁内跑完
			const work = (async () => {
				await this.tidyWindow(); // 动页面之前：被最小化 / 拖回来了就停回屏幕外（后台模式）
				return await fn();
			})();
			// work 的 rejection 必须有接收者：否则超时后它才抛错时会变成未处理拒绝
			const guarded = work.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
			let timeoutError = null;
			const timeout = new Promise((resolve) => {
				timer = setTimeout(() => { timedOut = true; timeoutError = new Error(`${label}超时`); resolve(null); }, maxMs);
				timer.unref?.();
			});
			try {
				const first = await Promise.race([guarded, timeout]);
				if (!timedOut) {
					// fn() 先结束（成功或真失败）：直接交结果
					if (first.ok) return first.v;
					throw first.e;
				}
				// 超时了。注意这里**不能 await work** —— 那会让调用方也一起等，
				// 「超时报错」就失去意义了（POLL_TIMEOUT_MS 就是用来及时脱身的）。
				// 做法：把「放锁」这件事挂到 work 结束之后，run() 立刻带着超时错误返回，
				// 但 this.lock 链上多挂一节，下一件事要等那一节完成才轮到。
				this.busy = `${label}（超时，等它收尾）`;
				const release = work.then(() => {}, () => {});
				throw Object.assign(timeoutError, { __holdLock: release });
			} finally {
				clearTimeout(timer);
			}
		};
		const p = this.lock.then(run, run);
		// 超时的那一次会在错误上挂 `__holdLock`（等 fn 真收尾的 promise）：
		// 把它接到锁链上，下一件事就排在「收尾完成」之后，而不是和它并发。
		this.lock = p.then(
			() => {},
			(error) => {
				const hold = error?.__holdLock;
				if (hold === undefined) return;
				return hold.then(() => { if (this.busy.endsWith('（超时，等它收尾）')) this.busy = ''; });
			},
		);
		return p;
	}

	/**
	 * 刷新抖音页面（#72）。
	 *
	 * 抖音页面放久了会被浏览器「睡」掉 —— 标签页被丢弃 / 渲染进程被冻结，
	 * 表现成页面白屏、选择器一个都命中不了（自检必然不过），手动刷新一下就恢复。
	 * 刷新完把私信面板重新打开：刷新后面板是关着的，
	 * 而自检的关键项之一 conversationItem 只在面板开着时才有。
	 *
	 * ⚠️ 调用方必须已经在 exclusive() 里 —— 这里不再抢锁（自己抢自己的锁会死锁）。
	 * @returns {Promise<boolean>} 刷新 + 面板开回来了没有
	 */
	async refresh() {
		if (!this.running) return false;
		const b = this.browser;
		try {
			const href = String(await b.eval('location.href').catch(() => '') || '');
			if (/^https?:\/\/[^/]*douyin\.com(\/|$)/.test(href)) {
				if (typeof b.reload === 'function') await b.reload({ settleMs: 6000 });
				else await b.goto(href, { settleMs: 6000 });
			} else {
				// 已经跑到 about:blank / 别的站上去了：刷新没意义，直接回抖音
				await b.goto(DOUYIN_HOME, { settleMs: 8000 });
			}
		} catch (error) {
			this.log('warn', `[fish-soul] 刷新抖音页面失败：${errText(error)}`);
			return false;
		}
		// 面板另算：刷新后私信面板是关着的，自检的关键项 conversationItem 只在面板开着时才有。
		// 面板开不成不算刷新失败（自检重跑会自己判），只记一笔。
		try { await this.openPanel(b); } catch (error) {
			this.log('warn', `[fish-soul] 刷新后私信面板没打开：${errText(error)}`);
		}
		this.log('info', '[fish-soul] 抖音页面已刷新');
		return true;
	}

	async checkLogin() {
		if (!this.running) return null;
		try {
			const r = await checkLogin(this.browser);
			this.loggedIn = r.loggedIn === true;
		} catch { /* 这次看不了 */ }
		return this.loggedIn;
	}

	/** 登录用的截图（jpeg，小一点）。 */
	async screenshot() {
		if (!this.running) return null;
		const b = this.browser;
		const r = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, b.sessionId);
		const m = await b.send('Page.getLayoutMetrics', {}, b.sessionId).catch(() => null);
		const vp = m?.cssVisualViewport ?? m?.cssLayoutViewport ?? {};
		return { jpeg: Buffer.from(r.data, 'base64'), width: Math.round(vp.clientWidth ?? 0), height: Math.round(vp.clientHeight ?? 0) };
	}

	/** 设置页里点截图 → 转成页面上的一次点击（xr / yr 是 0–1 的相对坐标）。 */
	async click(xr, yr) {
		if (!this.running) return false;
		const b = this.browser;
		const m = await b.send('Page.getLayoutMetrics', {}, b.sessionId);
		const vp = m?.cssVisualViewport ?? m?.cssLayoutViewport ?? {};
		const x = Math.round(Math.min(1, Math.max(0, Number(xr))) * (vp.clientWidth ?? 0));
		const y = Math.round(Math.min(1, Math.max(0, Number(yr))) * (vp.clientHeight ?? 0));
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
			await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }, b.sessionId);
		}
		return true;
	}

	/** 没有 sharp 时的 webp → png（在专用浏览器里用 canvas 画一遍；动图只留第一帧）。 */
	async canvasConvert(bytes) {
		if (!this.running) return null;
		const b64 = Buffer.from(bytes).toString('base64');
		const out = await this.exclusive('转图片', () => this.browser.eval(`(async () => {
			const bin = atob(${JSON.stringify(b64)});
			const arr = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
			const bmp = await createImageBitmap(new Blob([arr], { type: 'image/webp' }));
			const c = new OffscreenCanvas(bmp.width, bmp.height);
			c.getContext('2d').drawImage(bmp, 0, 0);
			const blob = await c.convertToBlob({ type: 'image/png' });
			const u = new Uint8Array(await blob.arrayBuffer());
			let s = '';
			for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
			return btoa(s);
		})()`), { maxMs: 30_000 });
		return typeof out === 'string' && out !== '' ? Buffer.from(out, 'base64') : null;
	}

	status() {
		const pref = this.browserPref();
		return {
			state: this.paused && this.state !== 'running' ? 'paused' : this.state,
			paused: this.paused,
			pausedWhy: this.paused ? String(getKv(this.db, 'douyin.browser.pausedWhy', '') ?? '') : '',
			lastError: this.lastError,
			busy: this.busy,
			loggedIn: this.loggedIn,
			browser: this.info === null ? null : { kind: this.info.kind, name: this.info.name, version: this.info.version, path: this.info.path },
			pref,
			browsers: (this.browsers ?? []).map((b) => ({ kind: b.kind, name: b.name, version: b.version, path: b.path })),
			kinds: Object.keys(BROWSER_KINDS),
			port: this.port,
			window: this.windowMode(),
			windowShown: this.windowShown
		};
	}
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
	constructor({ host, db, getConfig, log, onMessage, notify, driver, pollRangeMs = [30_000, 60_000], typingMs = [1500, 3000], firstPollMs = 5000 }) {
		this.host = host;
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.onMessage = onMessage;
		this.inbox = new DouyinInbox(db);
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
				// 🔴 把学到的 uid **显示出来**。以前只给一个布尔值，于是
				//    「主人身份」要填的数字 uid，新用户根本无从得知 ——
				//    设置页那句「从私信待核实里能看到」在还没收到过私信时是空话。
				//    插件其实能从任意一条私信里学到自己是谁（`learnSelfUid`），
				//    这里把结果交出去，用户照着复制进「主人身份」就行。
				selfUids: this.selfUids(),
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
		// 事件缓冲会裁剪头部，导航也会清空；数组长度不能作为持久游标。
		const previous = this.pushLastEvent ? browser.events.indexOf(this.pushLastEvent) : -1;
		const since = previous + 1;
		this.pushLastEvent = browser.events.at(-1);
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
		for (const m of fresh) {
			const timeMs = Number(m.time) > 1e12 ? Number(m.time) : Date.now();
			// 轮询路读的时候这条已经在窗口里了 → 已经收过，别重复收
			if (skipBefore > 0 && timeMs <= skipBefore) continue;
			const messageId = m.seq ? `s${m.seq}` : `push-${convId}-${timeMs}`;
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
		const learned = String(getKv(this.db, 'douyin.selfUid', '') ?? '').trim();
		if (learned !== '') out.push(learned);
		// sec_uid 也走 kv：以前读的是 `this.selfSecUid`，而那个字段**从来没有被赋过值**
		// （vendor 里的 selfSecUid 是另一个对象的入参）—— 等于这段永远是空的死分支。
		// 现在用 `douyin.selfSecUid` 这个 kv 键，谁能读到就 `setKv` 进来。
		const sec = String(this.selfSecUid ?? getKv(this.db, 'douyin.selfSecUid', '') ?? '').trim();
		if (sec !== '' && sec !== learned) out.push(sec);
		return out;
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
		const known = String(getKv(this.db, 'douyin.selfUid', '') ?? '').trim();
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
		this.inbox.beginRead(key, `${st?.group === true ? 'douyin-group' : 'douyin'}:${name}`);
		let res;
		const priorIdentity = conversationIdentity(st?.convId, this.selfUids());
		const expectConvId = priorIdentity && priorIdentity === st?.identity ? st.convId : '';
		try { res = await this.driver.read(name, { expectConvId, minCacheAt: Number(st?.readAt) || 0 }); }
		catch (error) {
			this.inbox.failRead(key, '读取驱动异常或超时');
			this.markReadFailed(key);
			throw error;
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
		if (!isSingleConversation(convId) || (expectConvId && convId !== expectConvId)) {
			this.inbox.failRead(key, '读取失败：会话身份缺失或与已验证目标不符');
			this.markReadFailed(key);
			this.log('warn', `[fish-soul] 读「${name}」拿不到单聊会话 ID（${convId || '空'}），身份无法确认，5 分钟内不再重试`);
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
		if (identity === '') {
			// 有会话 ID 但推不出对端（不知道自己是谁）：这一轮不处理，也不推进游标。
			this.inbox.failRead(key);
			this.markReadFailed(key);
			this.log('warn', `[fish-soul] 会话 ${convId} 推不出对方身份（还不知道自己的 uid），5 分钟内不再重试`);
			return;
		}
		// 记下「这个身份对应哪个会话 ID」：转达 / 主动私信要靠它找到目标会话，
		// 不能按昵称猜（昵称会变、会重名）。同名身份只留第一次，避免被后来者覆盖。
		try {
			const k = `douyin.convId.${identity}`;
			if (String(getKv(this.db, k, '') ?? '') === '') setKv(this.db, k, convId);
		} catch { /* 记不下来不影响这一轮 */ }
		const hasWindowGap = st !== null && Array.isArray(st.window) && st.window.length > 0 && prints.length > 0 && !prints.some(p => st.window.includes(p));
		// 游标带上会话身份：以后哪怕昵称变了，也知道这仍是同一个会话。
		const cursor = { name, sig, convId, identity, window: prints.slice(-WINDOW_KEEP), readAt: Date.now(), ...(group ? { group: true, members } : {}) };
		// 缓存只交接接口消息；下一轮仍需读取页面媒体，不能把预览当作完整收取。
		if (res.needsPageRead) cursor.needsPageRead = true;
		const normalized = [];
		const fallbackTime = convTimeMs(c.time) || Date.now();
		// 同一指纹在这次读到的列表里是第几次出现：对方连发同一句话时，没 seq 的 ID 也不会撞
		const occ = occurrenceIndexes(prints);
		for (const [i, m] of fresh.entries()) {
			const timeMs = Number(m.time) > 1e12 ? Number(m.time) : Number(m.time) > 1e9 ? Number(m.time) * 1000 : fallbackTime;
			const messageId = m.seq ? `s${m.seq}` : `${prints[freshIndexes[i]]}-${timeMs}-${occ[freshIndexes[i]]}`;
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
			if (!isSingleConversation(convId)) {
				throw new Error('这个抖音会话没有确认过身份（缺少会话 ID），不发，以免发错人');
			}
			let allOk = true;
			let delivered = false;
			const details = [];
			for (const part of parts) {
				await sleep(this.typingDelay(part.type === 'text' ? part.text : ''));
				const r = await this.host.exclusive('发私信', async () => {
					if (part.type === 'image') return await this.driver.sendImage(name, part.path, convId);
					if (part.type === 'emoji') {
						const e = await this.driver.sendEmoji(name, part.name, convId);
						// 表情面板里没有这个名字：当文字发
						return e?.ok ? e : await this.driver.sendText(name, `[${part.name}]`, convId);
					}
					return await this.driver.sendText(name, part.text, convId);
				}, { maxMs: 90_000 }).catch((error) => ({ ok: false, error: errText(error) }));
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
			// 自己发出去的消息进窗口，下一轮不当成新消息（下一轮读的时候它们是"我"发的，本来也不会回）
			return { ok: allOk, delivered, parts: details };
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
	 * 🔴 收件人只认**已确认身份的主人**：会话 ID 的对端 uid 必须和设置页填的
	 *    身份键一致。对不上就不发 —— 分享面板里每个按钮都叫「分享」，发错人没有第二次。
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
			const masterUid = String(cfg.masterUid ?? '').trim();
			if (peer !== String(peerUid ?? '').trim() || (masterUid !== '' && masterUid !== `douyin:${peer}`)) {
				return { ok: false, verified: false, submitted: false, error: '收件人不是已确认的主人，未分享' };
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
