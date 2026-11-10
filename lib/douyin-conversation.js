/**
 * douyin-conversation.js —— 抖音会话身份：把「会话 ID」当成一等公民。
 *
 * 为什么需要这一层
 * ----------------
 * 以前认人靠**昵称**：`cacheKey = uname`，发送前也拿名字做包含比对。
 * 问题是昵称不是身份 —— 两个人可以同名，改名之后又对不上。所以整条私信链路
 * 被保守停用了（见 docs/douyin-identity-validation.md）。
 *
 * 但平台数据里本来就有能独立确认会话的东西：
 *
 *   · 消息 `#1` = 会话 ID，单聊形状 `0:1:<uidA>:<uidB>`
 *   · 消息 `#7` = 发送者 uid
 *
 * 单聊会话 ID 自带双方 uid，所以「这条消息属于哪个会话、对方是谁」可以由
 * 会话 ID 本身推出，不需要昵称。昵称从此只作展示。
 *
 * 这里只放纯函数：不碰浏览器、不碰数据库，方便直接测。
 */

/** 单聊会话 ID 的形状：`0:1:<uid>:<uid>`（群聊是 `0:2:...`，别的形状一律不认）。 */
const SINGLE_RE = /^0:1:(\d+):(\d+)$/;

/**
 * 解析单聊会话 ID。
 *
 * 返回 `{ a, b }` 两个 uid（都是字符串，保精度），或者 null。
 * 群聊 / 畸形 / 空值一律 null —— 调用方必须把 null 当成「不知道对方是谁」。
 *
 * @param {string} convId
 * @returns {{a: string, b: string}|null}
 */
export function parseSingleConversation(convId) {
	const m = SINGLE_RE.exec(String(convId ?? '').trim());
	return m === null ? null : { a: m[1], b: m[2] };
}

/** 会话 ID 是不是单聊形状。 */
export function isSingleConversation(convId) {
	return parseSingleConversation(convId) !== null;
}

/**
 * 从会话 ID + 我自己（任意一侧）推出**对方**的 uid。
 *
 * `selfIds` 允许传多个候选（数字 uid / sec_uid 都可能有用）：
 * 只要会话 ID 里有一侧命中，就返回另一侧。
 *
 * 两侧都命中或都不命中时返回 '' —— 前者说明 `selfIds` 有歧义（比如把自己
 * 两个号都传进来了），后者说明这不是我的会话。两种情况都不该猜。
 *
 * @param {string} convId
 * @param {Iterable<string>} selfIds
 * @returns {string} 对方 uid，确定不了就 ''
 */
export function peerUidFromConversation(convId, selfIds) {
	const pair = parseSingleConversation(convId);
	if (pair === null) return '';
	const mine = new Set([...selfIds].map((x) => String(x ?? '').trim()).filter((x) => x !== ''));
	const aIsMe = mine.has(pair.a);
	const bIsMe = mine.has(pair.b);
	if (aIsMe === bIsMe) return ''; // 都不是 / 都是：不猜
	return aIsMe ? pair.b : pair.a;
}

/**
 * 一组消息里**唯一**的会话 ID。
 *
 * 同一个响应里混进两个会话 = 缓存串了，这时候不能挑一个凑合 —— 返回 ''。
 * 这正是旧 `pickMessages` 的漏洞：它按消息条数挑响应，不看会话。
 *
 * @param {Array<{convId?: string}>} messages
 * @returns {string} 唯一 convId，没有或有多个都返回 ''
 */
export function soleConversationId(messages) {
	const ids = new Set();
	for (const m of messages ?? []) {
		const id = String(m?.convId ?? '').trim();
		if (id !== '') ids.add(id);
	}
	return ids.size === 1 ? [...ids][0] : '';
}

/**
 * 会话的稳定身份键：`douyin:<对方uid>`。
 *
 * 用 uid 而不是昵称 —— 改名、同名都不会串。拿不到 uid 就返回 ''，
 * 调用方必须据此拒绝处理，而不是退回昵称。
 *
 * @param {string} convId
 * @param {Iterable<string>} selfIds
 * @returns {string}
 */
export function conversationIdentity(convId, selfIds) {
	const peer = peerUidFromConversation(convId, selfIds);
	return peer === '' ? '' : `douyin:${peer}`;
}

/**
 * 这个字符串是不是一个「已确认的抖音会话身份」。
 *
 * 只有 `douyin:<数字 uid>` 才算。昵称、裸 senderId、`uid:<id>`（群聊那条老格式）
 * 都不算 —— 它们证明不了「这是谁的会话」。上层据此拒绝处理，而不是猜一个。
 *
 * @param {unknown} userId
 * @returns {boolean}
 */
export function isIdentityKey(userId) {
	return /^douyin:\d+$/.test(String(userId ?? '').trim());
}

/**
 * 这条消息的发送者是不是「对方」。
 *
 * 有 convId 时用 uid 判（稳）；没有 convId 时才退回 fromMe 字段，
 * 而 fromMe 依赖 sec_uid 比对，拿不到就是 null —— 那种情况返回 null 表示未知。
 *
 * @param {{convId?: string, senderId?: string}} message
 * @param {Iterable<string>} selfIds
 * @returns {boolean|null}
 */
export function isPeerMessage(message, selfIds) {
	const peer = peerUidFromConversation(message?.convId, selfIds);
	const sender = String(message?.senderId ?? '').trim();
	if (peer !== '' && sender !== '') return sender === peer;
	const fromMe = message?.fromMe;
	return typeof fromMe === 'boolean' ? !fromMe : null;
}

/**
 * 这条消息的发送者 uid 是否与会话对端一致（即「证据自洽」）。
 *
 * 发送者是自己、或对端，都算自洽；出现第三方 uid 说明这条消息不属于这个会话
 * （串会话 / 缓存污染），必须丢弃。
 *
 * @param {{convId?: string, senderId?: string}} message
 * @param {Iterable<string>} selfIds
 * @returns {boolean}
 */
export function senderBelongsToConversation(message, selfIds) {
	const pair = parseSingleConversation(message?.convId);
	if (pair === null) return false;
	const sender = String(message?.senderId ?? '').trim();
	if (sender === '') return false;
	const mine = new Set([...selfIds].map((x) => String(x ?? '').trim()).filter((x) => x !== ''));
	// 发送者必须是会话两侧之一
	return mine.has(sender) || sender === pair.a || sender === pair.b;
}
