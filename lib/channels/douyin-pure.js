import { createHash } from 'node:crypto';
import { parseTime } from './vendor/douyin-bridge/douyin-util.mjs';

export const DOUYIN_HOME = 'https://www.douyin.com/';
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

export const errText = (e) => String(e instanceof Error ? e.message : e);
export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

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
	// 分享卡片按平台作品 ID 认：DOM 路只拿得到作者名，同作者的两张不同卡片会撞成同一个指纹。
	// 保留 me/peer 这一维（null 与 false 同按对方算，和下面的规则一致）。
	const card = String(m?.shareAweme ?? '').trim();
	if (card !== '') return sha1(`card|${m?.fromMe === true ? 'me' : 'peer'}|${card}`).slice(0, 16);
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
 * 一条入站消息的「时间 + 去重 ID」。
 *
 * 入库去重键是 `UNIQUE(channel_id, message_id)` + `INSERT OR IGNORE`，所以 ID 必须满足
 * 两个互相拉扯的要求：
 *
 *   · **同一条消息重复读** ⇒ 同一个 ID（否则每次轮询都新入库一遍，重复回复 + 烧 token）
 *   · **同一个人后来又说了同样的话 / 又发了同一张图** ⇒ 不同的 ID（否则第二句被吞，等于失联）
 *
 * 所以分三级，越靠前越准：
 *   ① 有 `seq`（接口路，平台序号）        → `s<seq>`
 *   ② 有平台时间（接口路本来有；DOM 路现在从气泡文字反解） → `<指纹>-<timeMs>-<occ>`
 *   ③ 两者都没有（极少）                  → `<指纹>-<自然日>-<occ>`
 *
 * ⚠️ ③ 是**已知取舍**：同一天内、既没 seq 又认不出时间的同内容消息仍会撞。
 *    别为了省事把 ② 也降级到 ③ —— 那会让「同一天说两次『在』」第二句收不到。
 *
 * @param {object} m 入站消息（可能带 `time` / `seq`）
 * @param {{occ?: number, fallbackTime?: number, dayKey?: string}} ctx
 * @returns {{timeMs: number, messageId: string}}
 */
export function messageIdFor(m, { occ = 0, fallbackTime = Date.now(), dayKey = '' } = {}) {
	const print = messageFingerprint((m?.type || m?.isText || m?.kind === 7) ? { ...m, type: m.type ?? 'text' } : m);
	const rawTime = Number(m?.time);
	const hasTime = rawTime > 1e12 || rawTime > 1e9;
	const timeMs = rawTime > 1e12 ? rawTime : rawTime > 1e9 ? rawTime * 1000 : fallbackTime;
	const seq = String(m?.seq ?? '').trim();
	const day = dayKey || new Date().toISOString().slice(0, 10);
	// 分享卡片提到最前：DOM 路的「时间」是从「刚刚 / N 分钟前」反解出来的，每轮询一次就变一个值，
	// 拿它当 ID 等于 UNIQUE(channel_id, message_id) 完全失效（真机：一张卡入库 13 次、回了 13 遍）。
	// 作品 ID 跨轮询稳定、跨卡片唯一，比 seq 还准（DOM 路本来就没有 seq）。
	const card = String(m?.shareAweme ?? '').trim();
	const messageId = card !== ''
		? `c${card}-${occ}`
		: seq !== ''
			? `s${seq}`
			: hasTime
				? `${print}-${timeMs}-${occ}`
				: `${print}-${day}-${occ}`;
	return { timeMs, messageId };
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

/**
 * 历史上的 `douyin.selfUid` 曾被存成 JSON 字符串本身（kv 里是带引号的 "\"123\""），
 * 而消息的 senderId 是裸数字 —— 不剥引号就永远比对不上，自己的消息被当成对方发的。
 * 剥完引号还必须是纯数字：不是的（手填的昵称 / 截断值）视为没学到，走未验证路径，不拿脏值去比对。
 */
export function selfUidFromKv(raw) {
	const s = stripQuotes(String(raw ?? ''));
	return /^\d+$/.test(s) ? s : '';
}

/** 去掉首尾空白与一层成对的引号。 */
export function stripQuotes(raw) {
	return String(raw ?? '').trim().replace(/^["'](.*)["']$/, '$1').trim();
}
