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
 * 唯一**单聊**会话 ID（#169）。
 *
 * 和 soleConversationId 的差别：它只认「明确是单聊」的消息（convId 是 0:1: 形状、
 * 且不是群）。群消息（convType=2，或 convId 不是 0:1: 形状）会被算进「非群消息数」，
 * 从而把「面板里只抓到一个群会话」挡在兜底外 —— 否则读群会话会被误判成
 * 「面板里唯一抓到的单聊」（主人那条），把群消息按主人私聊入库（串会话根源）。
 *
 * @param {Array<{convId?: string, convType?: number}>} messages
 * @returns {{ id: string, nonGroupCount: number, groupLike: boolean }}
 *   id = 唯一单聊 convId（没有/有多个/有非单聊混入时 ''）；
 *   nonGroupCount = 明确是群的消息条数；groupLike = 这批消息里有没有群。
 */
export function soleSingleConversationId(messages) {
	const ids = new Set();
	let nonGroupCount = 0;
	let groupLike = false;
	for (const m of messages ?? []) {
		const id = String(m?.convId ?? '').trim();
		// 🔴 先判群，再看 id 空不空：群消息的 convId 经常解不出来（接口对群会话
		//    不一定回填 0:1: 形状），但它带着 convType=2 —— 若先 `id==='' continue`
		//    就把群漏掉了，groupLike 永远置不上，兜底照样错配。
		const isGroup = Number(m?.convType) === 2 || (id !== '' && !isSingleConversation(id));
		if (isGroup) { groupLike = true; nonGroupCount++; continue; }
		if (id === '') continue; // 既不是群、又没 id：信息不足，不当证据也不算群
		ids.add(id);
	}
	return { id: ids.size === 1 && !groupLike ? [...ids][0] : '', nonGroupCount, groupLike };
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

// ───────────────────────── 会话 ID 形状校验（单聊 + 群聊） ─────────────────────────
//
// 为什么单独抽出来：会话 ID 是**身份**，形状不对的字符串（「abc」「0:1:x:2」）
// 绝不能被当成会话 —— 那是「拿昵称猜人」那类洞的入口。
//
// 单聊：`0:1:<我的uid>:<对方uid>`
// 群聊：`<数字>:<数字>:<数字>...`（抖音平台给的 conversation_id，形状跟单聊不一样）
//
// ⚠️ 群的形状比单聊宽：如果只判「非空」，`'abc'`、`'0:2:1:2'` 这类垃圾会被放进去
//    （2026-11-19 审查发现：test/douyin-send.mjs 的「形状不对必须拒发」契约被打破了）。
//    所以这里两种都认，其余一律拒。

/** 单聊形状：`0:1:<数字>:<数字>`。 */
export const SINGLE_CONV_RE = /^0:1:\d+:\d+$/;

/**
 * 群聊形状：`<数字>:<数字>:<数字>` 起步的会话 ID。
 *
 * 抖音的群 conversation_id 形如 `7512345678901234567:987654321098765432:0`。
 * 段数可能不止三个，所以这里只要求「至少三段、每段都是数字」。
 */
export const GROUP_CONV_RE = /^[1-9]\d+(?::\d+){2,}$/;

/**
 * 这个会话 ID 是不是我们认得的形状（单聊或群聊）。
 *
 * @param {unknown} convId
 * @returns {boolean}
 */
export function isDouyinConversationId(convId) {
	const s = String(convId ?? '').trim();
	if (s === '') return false;
	return SINGLE_CONV_RE.test(s) || GROUP_CONV_RE.test(s);
}
