import { randomUUID } from 'node:crypto';
import { findChatSession, listChatSessions, findPersonByQq, findPersonByBili, findPersonByDouyin } from './db.js';
import { normalizeMessageEvent, sanitizeName, sanitizeUserText } from './channels/onebot.js';
import { platformOf, splitChannelId, sessionChannelOf, textOfUserMessage, masterTagOf } from './gateway-util.js';
import { adapterOf } from './douyin-adapter.js';
import { 提取正文, 提取图块 } from './channels/vendor/qq-bridge.js';
import { OVERFLOW_SESSION_KEY, SWITCH_BLOCKED_SESSION_KEY } from './gateway-session.js';

export const SOURCE_QQ = 'fish-soul/qq';
export const SOURCE_PROACTIVE = 'fish-soul/proactive';
export const SOURCE_BILI = 'fish-soul/bili';
export const SOURCE_DOUYIN = 'fish-soul/douyin';
const OUR_SOURCES = new Set([SOURCE_QQ, SOURCE_PROACTIVE, SOURCE_BILI, SOURCE_DOUYIN]);

/** 带通道的出站消息缓存键（channel_id 与 message_id 之间用一个不会出现的分隔符）。 */
export const ownKey = (channelId, messageId) => `${channelId}\u0000${messageId}`;

const PROACTIVE_TURN_TIMEOUT_MS = 5 * 60_000;
export const RETRYABLE_TURN_TTL_MS = 10 * 60_000;
export const RETRYABLE_TURN_LIMIT = 100;

// 给秒级时间戳留 2 秒容差；缺任一边就宁可不取图。
export function sameSelfMessageTime(storedAt, messageTime) {
	const at = Number(storedAt);
	const time = Number(messageTime);
	return Number.isFinite(at) && at > 0 && Number.isFinite(time) && time > 0 && Math.abs(at - time * 1000) <= 2_000;
}

/**
 * 这一轮的结束原因是不是「上下文超限 / 400」。
 *
 * 宿主已经做过分类（dsh-llm 的 CONTEXT_WINDOW_EXCEEDED）：provider 回 400 且文案是
 * 「context length exceeded」这一类时，适配器把它归一成这个 code，turn/end 的
 * reason === {kind:"error", error:{code:"CONTEXT_WINDOW_EXCEEDED"}}。
 * 所以判 code，不猜文案 —— 文案各家不一样，也没法穷举。
 *
 * 兜底再看一眼 error.message / error.type：老版本宿主或自建适配器可能只给文案。
 * 宁可少换（继续哑着），也不能把「限额 / 超时」当成超限换掉 —— 换会话 = 语境全丢。
 *
 * @param {object} reason turn/end 的 data.reason
 * @returns {boolean}
 */
function isContextOverflowReason(reason) {
	if (reason === null || typeof reason !== 'object') return false;
	if (reason.kind !== 'error') return false;
	const err = reason.error ?? {};
	const code = String(err.code ?? '');
	if (code === 'CONTEXT_WINDOW_EXCEEDED') return true;
	if (code === 'HTTP_400' || code === 'HTTP_413') {
		// 400/413 还得看文案：400 也可能是「参数错」「内容被拒」
		return /context|too\s+(long|large)|maximum.{0,20}(token|length)/i.test(String(err.message ?? '') + ' ' + String(err.type ?? ''));
	}
	return false;
}

/**
 * 这一轮是不是「换模型被宿主挡了」。
 *
 * 宿主换模型前要把旧历史压成一段摘要带过去（dsh-compaction-basic 的 agent/request 闸门）。
 * 压不动时会抛 MODEL_SWITCH_COMPACTION_FAILED：摘要算上固定包装，比被替换的那段还大。
 *
 * 这种失败是**粘性**的：模型没换成功，agent.model.current() 还是旧的 ⇒ 下一轮又去换、又失败。
 * 所以这条会话不能继续用了 —— 换一条新会话（新会话直接带目标模型建起来，不用压旧历史）。
 *
 * @param {object} reason turn/end 的 data.reason
 * @returns {boolean}
 */
function isModelSwitchCompactionFailure(reason) {
	if (reason === null || typeof reason !== 'object') return false;
	if (reason.kind !== 'error') return false;
	const err = reason.error ?? {};
	if (String(err.code ?? '') !== 'MODEL_SWITCH_COMPACTION_FAILED') return false;
	// ⚠️ 同一个 code 也可能是「摘要模型临时挂了 / 被限流」这类**可恢复**的失败 ——
	//    那种情况换会话会白丢一段语境，不换：插件每轮本来就会重试一次切换，恢复了就自己好。
	// 只认宿主那几类「确定压不动 / 目标模型上下文配置本身就不够」的失败 ——
	// 对同一段历史它们会一直失败，换会话或预检拦截才是出路（认不出来仍按可恢复处理）。
	return /not smaller than the shadowed content|no safe compaction range|compaction still above threshold|no context capacity for|leaving no (?:message|pressure) budget|retainTokens .* must be less than threshold tokens/i
		.test(String(err.message ?? ''));
}

/**
 * 混入 ChatGateway.prototype 的调度、主动开口与会话事件分发方法。
 */
export const dispatchMethods = {
	/**
	 * 查一条她自己发过的消息原文（用于群里有人引用她的消息时告诉模型"对方在引用你的哪句话"）。
	 * @param {string} replyId
	 * @param {string} channelId 在哪个聊天里被引用的（消息号只在聊天内唯一，同号在不同聊天是两条消息）
	 * @returns {string} 她说的原文；不是她发的（或查不到）返回 ''
	 */
	ownMessageText(replyId, channelId) {
		const id = String(replyId ?? '');
		if (id === '') return '';
		const ch = String(channelId ?? '');
		// 有通道就只认「这个通道里发的那条」—— message_id 只在聊天内唯一，
		// 拿裸 id 查会把别的聊天的同号消息当成她说的。
		if (ch !== '') {
			const hit = this.ownMessagesByChannel.get(ownKey(ch, id));
			if (hit !== undefined) return hit;
		} else {
			// 没有通道上下文（老调用方）：只能退回裸 id 查 —— 那是原来的行为。
			const mem = this.ownMessages.get(id);
			if (mem !== undefined) return mem;
		}
		try {
			const row = this.db.prepare('SELECT text FROM own_message WHERE channel_id = ? AND message_id = ?').get(ch, id);
			if (row === undefined) return '';
			// 查到了顺手塞回内存：同一条被引用多次时不用反复查库
			this.rememberOwnCacheOnly(id, String(row.text ?? ''), ch);
			return String(row.text ?? '');
		} catch { /* 表还没建出来 / 库忙：退回问 OneBot，别让引用整条挂掉 */ }
		return '';
	},

	/**
	 * 被引用的那条消息：给模型看的一行 + 那条消息里的图。
	 *
	 * 图为什么要单独拿：QQ 的引用消息事件里只有一个 `reply` 段（一个消息号），
	 * 原文得问 OneBot（get_msg）才拿得到。以前只把原文的文字取出来 ——
	 * 被引用的那条是张图时，她只看到「【引用 阿四：【图片】】」，
	 * 图本身没进模型 ⇒ 群里引用一张图问「这啥」她只能瞎猜。
	 *
	 * @returns {{line: string, images: Array<object>}} line 空 = 这条消息没引用谁
	 */
	async quoteOf(replyId, channelId = '') {
		const id = String(replyId ?? '');
		const ch = String(channelId ?? '');
		if (id === '') return { line: '', images: [] };
		const own = this.ownMessageText(id, ch);
		// 库记录只补时间，避免旧版单存的文字把「本地记录」误判成跨天同一条。
		let ownAt = 0;
		if (own !== '' && ch !== '') {
			try { ownAt = Number(this.db.prepare('SELECT at FROM own_message WHERE channel_id = ? AND message_id = ?').get(ch, id)?.at ?? 0); } catch { /* 查库失败时宁可不取图 */ }
		}
		let msg = null;
		try { msg = await this.channel.getMessage?.(id); } catch { msg = null; }
		const n = msg ? normalizeMessageEvent({ post_type: 'message', message_type: msg.message_type ?? 'group', ...msg }, { selfId: this.channel.selfId }) : null;
		const images = (n?.images ?? []).slice(0, 2);
		if (own !== '') {
			// 文字用本地记录。图还要核对发送时间，不能只凭 selfId 判断：同号隔天也可能复用。
			const senderId = String(msg?.sender?.user_id ?? '');
			const isSame = senderId !== '' && senderId === String(this.channel.selfId ?? '') && sameSelfMessageTime(ownAt, msg?.time);
			return { line: `【引用 我自己：${own.slice(0, 40)}】`, images: isSame ? images : [] };
		}
		// 取不到原文就说取不到，别让模型以为引用了句空话然后瞎接
		if (!msg) return { line: '【引用了一条消息（原文没取到）】', images: [] };
		const who = sanitizeName(n?.nickname || msg.sender?.nickname || '', '某人');
		const text = (n?.text ?? '').trim();
		const line = text === '' ? `【引用 ${who}：（不是文字消息）】` : `【引用 ${who}：${text.slice(0, 40)}】`;
		return { line, images };
	},

	async quoteLine(replyId, channelId = '') {
		return (await this.quoteOf(replyId, channelId)).line;
	},

	rememberRetryableTurn(id, entry) {
		const key = String(id ?? '');
		if (key === '') return;
		this.retryableTurns ??= new Map();
		const now = Date.now();
		for (const [k, v] of this.retryableTurns) {
			if (now - v.at > RETRYABLE_TURN_TTL_MS) this.retryableTurns.delete(k);
		}
		// 保持引用一致，让 onSessionEvent 写 retry.dispatched 时 catch 路径立即可见
		entry.at = now;
		this.retryableTurns.set(key, entry);
		while (this.retryableTurns.size > RETRYABLE_TURN_LIMIT) {
			this.retryableTurns.delete(this.retryableTurns.keys().next().value);
		}
	},

	async dispatch(channelId, items, opts = {}) {
		if (this.stopped || items.length === 0) return;
		const first = items[0].m;
		// 🔴 共享会话必须按会话串行：批次是按 channelId 分的，但多个 channelId
		//    可能落到**同一个** session（设置页开了共享会话：QQ 私聊 + B站 私信 + 抖音私信）。
		//    turnState / turnMood / interjectTurns 都是按 sessionId 存**一份**，
		//    两轮并发就会互相覆盖 → A 的回复按 B 的通道发出去（或 convId 用错）。
		//    把锁提到 ensureSession 之前（按 owner channel 串行），换会话期间后到的批次也不会拿到旧句柄。
		const chat = { channelId, chatType: first.chatType, targetId: first.targetId, title: first.chatType === 'private' ? first.nickname : '', userId: first.userId };
		const run = async () => {
			if (typeof this.getConfig !== 'function' || typeof this.sessionOwnerChat !== 'function') {
				const agent = await this.ensureSession(chat);
				await this.runExclusiveForSession(agent.id, () => this.dispatchInner(channelId, items, agent, opts));
				return;
			}
			const ownerKey = this.sessionOwnerChat(chat).channelId;
			await this.runExclusiveForSession(ownerKey, async () => {
				const agent = await this.ensureSession(chat);
				await this.dispatchInner(channelId, items, agent, opts);
			});
		};
		try {
			await run();
		} catch (error) {
			if (error?.__fishSoulRetry === true && opts.retried !== true) {
				this.note('session', { channelId, reason: error.__isSwitchBlocked ? '换模型被挡了，立即换新会话重试本轮' : '上下文满了，立即换新会话重试本轮' });
				return await this.dispatch(channelId, items, { retried: true, savedBacklog: error.__savedBacklog });
			}
			throw error;
		}
	},

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
	},

	async dispatchInner(channelId, items, agent, { retried = false, savedBacklog = null } = {}) {
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
		if (!retried) await this.judgeTurn(channelId, speakers);
		this.turnMood ??= new Map();
		this.turnMood.set(agent.id, this.moodOf(speakers[speakers.length - 1]?.person));
		// 只有插话（没有一条是点名 / 接着听的）才算"她自己想说"
		const interject = chat.chatType === 'group' && items.every((x) => x.interject === true);
		const backlog = savedBacklog ?? (chat.chatType === 'group' ? this.takeBacklog(channelId, new Set(items.map(({ m }) => m.messageId))) : { lines: [], images: [] });
		if (interject) this.interjectTurns.add(agent.id); else this.interjectTurns.delete(agent.id);
		const vecReady = this.soul.beginTurn(agent.id, {
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
		// 只给单人私聊的回复登记本轮真实说话人；群聊或身份未知不推断归属。
		this.turnState(agent.id).journalOwnerId = chat.chatType === 'private' && speakers.length === 1 && speakers[0].person?.canonical_id
			? `user:${speakers[0].person.canonical_id}` : null;
		// 路由信息（convId / inboxIds）由适配器算：字段名与位置不变，宿主重放的旧格式消息照样认得。
		const route = adapterOf(this).routeOf(items, platform);

		const lines = [];
		const quotedImages = [];
		for (const { m } of items) {
			const quote = platform === 'qq'
				? await this.quoteOf(m.replyId, channelId)
				: (platform === 'douyin' && m.refText ? { line: `【引用：${String(m.refText).replace(/\s+/g, ' ').trim().slice(0, 120)}】`, images: [] } : { line: '', images: [] });
			const body = `${quote.line}${m.text || '（空消息）'}`;
			// 群里一行一个人：对方自己打的换行压成 ⏎，免得有人换行伪造「主人：……」（【】是插件生成的块，比如合并转发，对方打不出来，原样留着）
			const flat = body.split(/(【[^】]*】)/).map((part, i) => (i % 2 === 1 ? part : part.replace(/\s*\n\s*/g, ' ⏎ '))).join('');
			const masterId = platform === 'douyin' ? this.masterDouyinIdentity() : this.masterQqSafe();
			lines.push(chat.chatType === 'group' ? `${sanitizeName(m.nickname || m.userId, m.userId)}${masterTagOf(m.userId, masterId)}：${flat}` : body);
			for (const img of quote.images) quotedImages.push({ img, m, quoteId: String(m.replyId ?? ''), quoted: true });
		}
		// 多人群消息合批时不提供任何路径：不让模型把别人的录音当作当前说话人。
		const sameSpeaker = speakers.length === 1 && speakers[0].person?.canonical_id && items.every(({ m, person }) => m.userId === speakers[0].userId && person?.canonical_id === speakers[0].person.canonical_id);
		const voicePaths = platform === 'qq' && sameSpeaker && this.voiceGuardReady && this.getConfig().voice?.saveIncoming === true
			? items.flatMap(({ m }) => m.voicePaths ?? []) : [];
		if (voicePaths.length) lines.push(`【本轮语音文件】可以用 sound_read 分析，路径为内部信息，不要在对外回复中输出：\n${voicePaths.join('\n')}`);
		lines.push(...await this.videoNotes(items));
		const content = await this.admitImages(lines.join('\n'), items, agent.id, { backlog, quotedImages });
		const last = items[items.length - 1].m;
		const mentionItem = [...items].reverse().find(({ m }) => m.mentioned)?.m ?? last;
		// 插话不引用（像自然接话）；戳一戳没有真的消息可引用。replyTo 跟着这条 followup 消息的 source 走，不存共享 Map——并发 dispatch 各带各的，不会张冠李戴
		const replyTo = chat.chatType === 'group' && !interject && !String(mentionItem.messageId).startsWith('poke-') ? mentionItem.messageId : null;
		this.db.prepare('UPDATE chat_session SET last_inbound_at = ? WHERE session_id = ?').run(Date.now(), agent.id);

		const followupId = randomUUID();
		if (voicePaths.length) {
			// 必须等这条消息真正进入会话才授权；不可覆盖正在运行的另一轮。
			this.pendingVoicePaths.set(followupId, { paths: voicePaths, sessionId: String(agent.id), at: Date.now() });
			for (const [id, x] of this.pendingVoicePaths) if (Date.now() - x.at > 300_000) this.pendingVoicePaths.delete(id);
			while (this.pendingVoicePaths.size > 1000) this.pendingVoicePaths.delete(this.pendingVoicePaths.keys().next().value);
		}
		const retryEntry = !retried ? { kind: 'dispatch', channelId, items, backlog, inboxIds: route.inboxIds ?? [], dispatched: false } : null;
		if (retryEntry !== null) this.rememberRetryableTurn(followupId, retryEntry);
		if (vecReady && typeof vecReady.then === 'function') await vecReady;
		try { await agent.followup({
			id: followupId,
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
				// 路由字段（convId / inboxIds）：跟着这一轮的 source 走，出站时校验发给谁（不存共享 Map）。
				// routeOf 自己判断有没有内容 —— 别的平台 inboxIds 本来就是空的，行为与改前一致。
				...route,
				replyTo
			}
		}); } catch (error) {
			this.pendingVoicePaths.delete(followupId);
			this.retryableTurns?.delete(followupId);
			// 若 turn/end 已在 followup reject 前抢先触发重试并接管结算，此处不再抛错给外层重复判失败
			if (retryEntry?.dispatched === true) return;
			const errReason = { kind: 'error', error };
			const isOverflow = isContextOverflowReason(errReason);
			const isSwitchBlocked = isModelSwitchCompactionFailure(errReason);
			if (isOverflow || isSwitchBlocked) {
				this.markUnusable(agent.id, isSwitchBlocked ? SWITCH_BLOCKED_SESSION_KEY : OVERFLOW_SESSION_KEY);
				const ownerKey = this.bound.get(agent.id)?.channel_id ?? (typeof this.getConfig === 'function' && typeof this.sessionOwnerChat === 'function' ? this.sessionOwnerChat(chat).channelId : channelId);
				if (!retried && !this.stopped && !this.isRecycleTripped(ownerKey)) {
					throw Object.assign(new Error('retry-on-fresh-session'), { __fishSoulRetry: true, __savedBacklog: backlog, __isSwitchBlocked: isSwitchBlocked });
				}
			}
			throw error;
		}
		if (isBili && this.bili !== null) void this.bili.ack(chat.targetId, last.messageId);
	},

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
	},

	// ───────────────────────── 主动开口 ─────────────────────────

	/**
	 * 主动开口：往目标会话里递一条 fish-soul/proactive 触发消息，让会话里的模型带着上下文自己写，
	 * 等这一轮结束、真正发到 QQ 后才返回结果（LifeEngine 据此记配额 / 重试待办）。
	 *
	 * 超时（模型 5 分钟没写完）会把 meta.timedOut 置 true 再返回 false：调用方要能分清
	 * 「慢」和「发不出去」，这两种的重试策略不一样（#80）。
	 */
	async triggerProactive(channelId, reason, meta = {}, { retried = false, reuseWaiter = null } = {}) {
		const { origin = 'idle' } = meta;
		const [kind, id] = splitChannelId(channelId);
		const abortReuse = () => {
			if (reuseWaiter) { clearTimeout(reuseWaiter.timer); reuseWaiter.resolve(false); }
			return false;
		};
		if (this.stopped) return abortReuse();
		// 抖音收件人无法核验，暂停所有主动发送。
		if (kind === 'douyin' || kind === 'douyin-group') {
			/**
			 * 抖音默认**不发**主动私信（收件人身份核验不了）。
			 *
			 * 唯一的例外：她自己起意的**视频卡片分享**（origin='share'）。
			 * 那条不走模型 —— 作品 ID 和感受在入队时就落盘了，发送控制面直接投卡片，
			 * 免得模型漏抄链接、或者回个「[不回]」，卡片就发不出去了。
			 */
			if (kind === 'douyin-group' || origin !== 'share') return abortReuse();
			if (this.isPaused(channelId)) { this.note('paused', { channelId, reason: '这个聊天暂停着，不主动开口' }); return abortReuse(); }
			return await this.deliverDouyinShare(channelId, reason, meta) === true;
		} else if (kind === 'bili') {
			// B站默认只回复不主动；设置页打开"主动发私信"后也只发给主人
			const b = this.biliConfig();
			if (!b.enabled || !b.proactive || this.bili === null || !this.bili.connected || id !== b.masterUid) return abortReuse();
		} else {
			if (!this.qqConfig().enabled || !this.channel.connected) return abortReuse();
			if (!id || (kind !== 'private' && kind !== 'group')) return abortReuse();
		}
		if (this.isPaused(channelId)) { this.note('paused', { channelId, reason: '这个聊天暂停着，不主动开口' }); return abortReuse(); }
		const chat = { channelId, chatType: kind === 'group' ? 'group' : 'private', targetId: id, title: '' };
		const ownerKey = typeof this.getConfig === 'function' && typeof this.sessionOwnerChat === 'function'
			? this.sessionOwnerChat(chat).channelId : channelId;
		const msgId = randomUUID();
		let done = null;
		if (reuseWaiter) {
			reuseWaiter.key = msgId;
			this.waiters.set(msgId, reuseWaiter);
		} else {
			done = new Promise((resolveDone) => {
				const waiter = { key: msgId, resolve: resolveDone, timer: null };
				waiter.timer = setTimeout(() => {
					meta.timedOut = true;
					this.waiters.delete(waiter.key);
					resolveDone(false);
				}, PROACTIVE_TURN_TIMEOUT_MS);
				waiter.timer.unref?.();
				this.waiters.set(msgId, waiter);
			});
		}
		let retryEntry = null;
		const runTurn = async () => {
			const agent = await this.ensureSession(chat);
			this.applyChatModelFor(agent, channelId);
			const person = kind === 'private' ? findPersonByQq(this.db, id) : kind === 'bili' ? findPersonByBili(this.db, id) : kind === 'douyin' ? findPersonByDouyin(this.db, id) : null;
			this.turnMood ??= new Map();
			this.turnMood.set(agent.id, this.moodOf(person));
			const vecReady = this.soul.beginTurn(agent.id, {
				channel: sessionChannelOf(channelId),
				channelId,
				replyChannel: this.replyChannelFor(agent, channelId),
				speakers: person !== null ? [{ person, userId: id, displayName: person.display_name, text: reason }] : [],
				proactive: true,
				workspacePath: this.bound.get(agent.id)?.workspace_path ?? this.workspacePath()
			});
			this.turnState(agent.id).channelId = channelId;
			this.turnState(agent.id).journalOwnerId = (kind === 'private' || kind === 'bili') && person?.canonical_id
				? `user:${person.canonical_id}` : null;
			this.interjectTurns.delete(agent.id);
			if (!retried) {
				this.note('proactive', { channelId, reason: sanitizeUserText(reason).slice(0, 60) });
				retryEntry = { kind: 'proactive', channelId, reason, meta, waiterId: msgId, dispatched: false };
				this.rememberRetryableTurn(msgId, retryEntry);
			}
			// 定时任务（#190）：给的是主人自己写的唤醒指示，不是「好久没说话」那套。
			// 其它来源（idle / share / dream）的措辞一个字不改。
			const wakeText = origin === 'scheduled'
				? `【定时任务】${this.soul.nowLabel()}，你安排的「${sanitizeUserText(String(meta.taskName ?? '定时任务')).slice(0, 40)}」到点了。` +
					`指示：${sanitizeUserText(String(meta.prompt ?? reason))}。照这条指示做，把要发出去的那条消息直接写出来。`
				: `【主动开口】${this.soul.nowLabel()}，你想主动找${kind === 'group' ? '群里的大家' : '对方'}说话。` +
					`理由：${sanitizeUserText(reason)}。直接写要发出去的那条消息，像平时聊天一样自然，` +
					'别提"系统""提醒任务""主动开口"这些字眼。';
			if (vecReady && typeof vecReady.then === 'function') await vecReady;
			await agent.followup({
				id: msgId,
				role: 'user',
				content: [{ type: 'text', text: wakeText }],
				source: { kind: SOURCE_PROACTIVE, channelId, reason: String(reason), origin }
			});
		};
		try {
			await this.runExclusiveForSession(ownerKey, runTurn);
		} catch (error) {
			this.retryableTurns?.delete(msgId);
			if (retryEntry?.dispatched === true) return reuseWaiter ? true : await done;
			const errReason = { kind: 'error', error };
			const isOverflow = isContextOverflowReason(errReason);
			const isSwitchBlocked = isModelSwitchCompactionFailure(errReason);
			const sessId = findChatSession(this.db, platformOf(ownerKey), ownerKey)?.session_id;
			if (sessId) {
				if (isOverflow) this.markUnusable(sessId, OVERFLOW_SESSION_KEY);
				else if (isSwitchBlocked) this.markUnusable(sessId, SWITCH_BLOCKED_SESSION_KEY);
			}
			if (!retried && !reuseWaiter && !this.stopped && (isOverflow || isSwitchBlocked) && !this.isRecycleTripped(ownerKey)) {
				const existingWaiter = this.waiters.get(msgId);
				if (existingWaiter !== undefined) {
					this.waiters.delete(msgId);
					this.note('session', { channelId, reason: isSwitchBlocked ? '换模型被挡了，立即换新会话重试本轮' : '上下文满了，立即换新会话重试本轮' });
					await this.triggerProactive(channelId, reason, meta, { retried: true, reuseWaiter: existingWaiter });
					return await done;
				}
			}
			const w = this.waiters.get(msgId);
			if (w !== undefined) {
				this.waiters.delete(msgId);
				clearTimeout(w.timer);
				if (reuseWaiter) w.resolve(false);
			}
			throw error;
		}
		return reuseWaiter ? true : await done;
	},

	/** ctx.on('session/event') 回调。 */
	onSessionEvent(session, event) {
		const sessionId = String(session?.id ?? '');
		if (!this.bound.has(sessionId) || !event) {
			// 会话对不上号 ⇒ 这一轮的结算（settle）没人接 ⇒ 私信会一直卡在 processing。
			// 只记我们自己的会话（别人的会话事件每秒好几条，记了就是刷屏）。
			if (event?.type === 'turn/end' && sessionId.startsWith('fish-soul-')) {
				this.diag?.add('session-event-drop', { sessionId, known: [...this.bound.keys()].slice(0, 3) }, 'warn');
			}
			return;
		}
		const st = this.turnState(sessionId);
		const d = event.data ?? {};
		if (event.type === 'user/message') {
			const msg = d.message ?? d;
			const kind = String(msg?.source?.kind ?? '');
			// 🔴 DSH 每一步都会在我们的消息**后面**再追加几条 user/message：
			//    runtime-context（插件的动态上下文，每轮都变）、model-selection（换模型提示）等。
			//    以前每条都重算 fromUs ⇒ 被它们改成 false ⇒ 回复生成了却不发（DSH 里看得见，QQ / 抖音收不到）。
			//    现在只有我们自己的来源置 true；只有真人在界面里打字（kind 'user'）才置 false；别的宿主上下文不管。
			if (OUR_SOURCES.has(kind)) {
				st.fromUs = true; st.dshTyped = false;
				const pending = this.pendingVoicePaths?.get(String(msg?.id ?? ''));
				st.voicePaths = kind === SOURCE_QQ && pending?.sessionId === sessionId && Date.now() - pending.at <= 300_000 ? pending.paths : [];
				if (pending) this.pendingVoicePaths.delete(String(msg.id));
			} else if (kind === 'user') {
				st.fromUs = false; st.dshTyped = true; st.voicePaths = [];
				// #78：主人自己打的字也记下来。动态页原来只显示她的发言 ⇒ 主人看到
				// 「动态里只有一条 DSH，内容是她的发言，我的发言去哪了」。
				// 记忆整理不受影响（他的发言经 beginTurn 的 speakers 进 journal），
				// 缺的是动态页这一轮的上下文。
				st.userText = textOfUserMessage(msg);
			}
			// 其他宿主上下文（runtime-context / model-selection 等）：不动 fromUs ——
			// 它们不是我们发的消息，但也不是真人打字，重置会把 B站/抖音 的回复憋回去（smoke #13 守着）
			// 共享会话里一个会话对应多个通道（QQ + B站）：这一轮从哪个通道进来的，来源里也带着 ——
			// 开轮时 dispatch 已经登记过，这里兜的是「插件重启后宿主重放消息」那条路（否则会回错平台）
			if (OUR_SOURCES.has(kind) && msg?.source?.channelId) st.channelId = String(msg.source.channelId);
			if (msg?.id !== undefined && OUR_SOURCES.has(kind)) st.messageIds.push(String(msg.id));
			// 路由信息由适配器吸收：convId（出站时校验「打开的还是这个人的会话」，昵称不算证据）+ inboxIds
			if (kind === SOURCE_DOUYIN) adapterOf(this).absorbRoute(st, msg?.source);
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
			const retries = [];
			if (this.retryableTurns) {
				for (const id of st.messageIds) {
					const hit = this.retryableTurns.get(id);
					if (hit !== undefined) retries.push(hit);
					this.retryableTurns.delete(id);
				}
			}
			const ownerKey = this.bound.get(sessionId)?.channel_id ?? st.channelId ?? '';
			if (completed && ownerKey !== '') this.resetRecycleBreaker(ownerKey);
			const settleSubset = (ids, wIds, ok, reason = '') => {
				const list = ids ?? [];
				const why = ok ? '' : String(reason || '这一轮或发送结果不确定，请先核实').slice(0, 200);
				// 结算落「待核实」是冷路径：记下是哪几条私信、为什么。
				// 成功不写 —— 每条私信都写会把 200 条的缓冲刷爆。
				// 只有真牵着私信行时才写：QQ / B站 的轮次失败跟私信没关系，别刷这条。
				if (!ok && list.length) this.diag?.add(`inbox-settle:${st.channelId ?? ''}`, {
					sessionId,
					ids: list,
					ok: false,
					reason: why
				}, 'warn');
				if (list.length) adapterOf(this).settle(list, ok, why);
				for (const id of wIds) {
					const w = this.waiters.get(id);
					if (w === undefined) continue;
					clearTimeout(w.timer);
					this.waiters.delete(id);
					w.resolve(ok);
				}
			};
			const settle = (ok, reason = '') => settleSubset(st.inboxIds ?? [], waiterIds, ok, reason);
			if (!completed || !st.fromUs) {
				// 这一轮为什么没成：结束原因不是 completed（provider 异常 / 被内容过滤 / 被打断），
				// 还是这轮压根不是我们发的。这句话会跟着结算一起记进运行日志。
				const endReason = !completed
					? `这一轮没正常结束（${d.reason?.kind ?? '未知'}）`
					: '这一轮不是我们发的，结果不确定';
				// 冷路径：这一轮没正常结束 —— 记下原因。「私信变待核实」时能看出是哪一类：
				// 结束原因不是 completed（provider 异常 / 被打断），还是这轮压根不是我们发的。
				if (!completed || !st.dshTyped) this.diag?.add(`turn-end-failed:${st.channelId ?? ''}`, {
					sessionId,
					reasonKind: String(d.reason?.kind ?? ''),
					fromUs: st.fromUs === true,
					textLen: String(st.text ?? '').length,
					inboxIds: st.inboxIds ?? []
				}, 'warn');
				// 上下文超限（碰 400 / 上下文满了）：宿主压缩没能救回来，这一轮就是失败了。
				// 把它记成「这条会话不能再用了」，下一条消息进来时换新的 —— 否则那个聊天会永久哑掉。
				const isOverflow = isContextOverflowReason(d.reason);
				const isSwitchBlocked = isModelSwitchCompactionFailure(d.reason);
				if (isOverflow || isSwitchBlocked) {
					// 这两种都是「这条会话不能再用了」：上下文满了（压缩没救回来），
					// 或者换模型被宿主的压缩闸门挡了（换不过去，下一轮还会撞同一个错）。
					const why = isSwitchBlocked ? '换模型被挡了' : '上下文超限';
					this.markUnusable(sessionId, isSwitchBlocked ? SWITCH_BLOCKED_SESSION_KEY : OVERFLOW_SESSION_KEY);
					this.log('warn', `[fish-soul] 会话 ${sessionId} ${why}，下一条消息换新会话`);
					this.diag?.add(isSwitchBlocked ? 'session-model-switch-blocked' : 'session-overflow', { sessionId, channelId: st.channelId ?? '', code: String(d.reason?.error?.code ?? '') }, 'warn');
					if (st.fromUs === true && retries.length > 0 && !this.stopped && !this.isRecycleTripped(ownerKey)) {
						const retriedInbox = new Set();
						const retriedWaiters = new Set();
						let launched = 0;
						for (const retry of retries) {
							if (retry.kind === 'dispatch') {
								retry.dispatched = true;
								launched++;
								for (const id of retry.inboxIds ?? []) retriedInbox.add(id);
								void this.dispatch(retry.channelId, retry.items, { retried: true, savedBacklog: retry.backlog }).catch((error) => {
									const msg = String(error instanceof Error ? error.message : error);
									this.log('error', `[fish-soul] 换新会话重试失败（${retry.channelId}）：${msg}`);
									this.diag?.add('dispatch-failed', { channelId: retry.channelId, reason: msg.slice(0, 200) }, 'warn');
									settleSubset(retry.inboxIds ?? [], [], false, msg);
								});
							} else if (retry.kind === 'proactive') {
								const existingWaiter = this.waiters.get(retry.waiterId);
								if (existingWaiter !== undefined) {
									retry.dispatched = true;
									launched++;
									retriedWaiters.add(retry.waiterId);
									this.waiters.delete(retry.waiterId);
									void this.triggerProactive(retry.channelId, retry.reason, retry.meta, { retried: true, reuseWaiter: existingWaiter }).catch((error) => {
										const msg = String(error instanceof Error ? error.message : error);
										this.log('error', `[fish-soul] 主动开口换新会话重试失败（${retry.channelId}）：${msg}`);
										clearTimeout(existingWaiter.timer);
										existingWaiter.resolve(false);
									});
								}
							}
						}
						if (launched > 0) {
							this.note('session', { channelId: st.channelId || ownerKey, reason: isSwitchBlocked ? '换模型被挡了，立即换新会话重试本轮' : '上下文满了，立即换新会话重试本轮' });
							this.interjectTurns.delete(sessionId);
							const remainingInbox = (st.inboxIds ?? []).filter((id) => !retriedInbox.has(id));
							const remainingWaiters = waiterIds.filter((id) => !retriedWaiters.has(id));
							if (remainingInbox.length > 0 || remainingWaiters.length > 0) {
								settleSubset(remainingInbox, remainingWaiters, false, endReason);
							}
							return;
						}
					}
				}
				const tripped = (isOverflow || isSwitchBlocked) && ownerKey !== '' && this.isRecycleTripped(ownerKey);
				if (st.fromUs) this.note('failed', {
					channelId: st.channelId || ownerKey,
					reason: tripped
						? '连续换新会话仍上下文超限，请换更大窗口模型或手动「换新会话」'
						: isOverflow
							? '上下文满了（下一条消息会换新会话）'
							: isSwitchBlocked
								? '换模型被挡了（下一条消息会换新会话）'
								: `这一轮没正常结束（${d.reason?.kind ?? '未知'}）`
				});
				if (st.dshTyped === true && !completed) {
					this.note('failed', {
						channelId: st.channelId || ownerKey,
						who: String(st.userText ?? '').trim() === '' ? '' : '主人：' + String(st.userText).trim().slice(0, 40),
						reason: isOverflow
							? '上下文满了（DSH 桌面端需手动新开会话，或外部发一条消息自动换）'
							: isSwitchBlocked
								? '换模型被挡了（DSH 桌面端需手动新开会话，或外部发一条消息自动换）'
								: `这一轮没正常结束（${d.reason?.kind ?? '未知'}）`
					});
				}
				// #78：DSH 桌面端正常完成的轮次不外发，但**要记动态** —— 以前在 DSH 里聊，动态页整片空白。
				if (st.dshTyped === true && completed) {
					if (st.text && this.bound.get(sessionId)?.channel_id) {
						try { this.soul.archiveDesktop?.(this.bound.get(sessionId).channel_id, st.text); }
						catch { this.log('warn', '[fish-soul] DSH 回复存档失败，聊天继续'); }
					}
					if (this.getConfig?.()?.voice?.desktopTts === true && this.voice?.readyFor('tts')) void this.saveDesktopVoice(st.text);
					const recall = this.soul.recallInfo?.(sessionId, st) ?? { memories: [], at: 0, unknown: false };
					this.note('dsh', {
						channelId: st.channelId ?? this.bound.get(sessionId)?.channel_id ?? '',
						text: String(st.text ?? '').slice(0, 60),
						// 主人这一轮说了什么也带上（#78）：动态页只显示她的发言，
						// 主人会以为自己的话丢了。带上之后这一轮是完整的一问一答。
						who: String(st.userText ?? '').trim() === '' ? '' : '主人：' + String(st.userText).trim().slice(0, 40),
						reason: '在 DSH 里聊的，不外发',
						memories: recall.memories ?? [],
						recallAt: recall.at ?? 0,
						speakerUnknown: recall.unknown === true,
						recallMiss: recall.miss ?? ''
					});
				}
				this.interjectTurns.delete(sessionId);
				settle(false, endReason);
				return;
			}
			void this.sendReply(sessionId, st).then((ok) => {
				settle(ok === true, ok === true ? '' : '回复没发出去（发送失败）');
			}, (error) => {
				this.log('error', `[fish-soul] 回复发出去失败：${String(error instanceof Error ? error.message : error)}`);
				settle(false, `回复没发出去：${String(error instanceof Error ? error.message : error).slice(0, 150)}`);
			});
		}
	}
};
