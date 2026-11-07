/**
 * snowluma.js —— QQ 渠道：WebSocket 直连 SnowLuma 的 OneBot 11 正向 WS（默认 3001，Universal：
 * 收事件和调接口走同一条连接）。
 *
 *  - 零依赖：用 Node 22+ 内置的全局 WebSocket；
 *  - 鉴权：OneBot 11 标准的 `?access_token=` 查询参数（SnowLuma 默认自动生成令牌）；
 *  - 断线自动重连（1s → 30s 退避），每次连上都回调 onConnected（网关据此补拉历史）；
 *  - 只负责"收事件 / 调接口"，不认人、不建会话、不做门槛——那些在 gateway.js。
 */

import { findSnowlumaToken } from '../snowluma-token.js';

/** 默认的「去 SnowLuma 配置里找令牌」实现。 */
const defaultFindToken = () => findSnowlumaToken();

const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10_000, 30_000];
const CALL_TIMEOUT_MS = 15_000;
const FRIEND_REFRESH_MS = 10 * 60_000;
const GROUP_NAME_TTL_MS = 30 * 60_000;

/**
 * 连接关掉的原因，写成人能看懂的一句话（CN）。
 *
 * 🔴 为什么要有它：Node 的 WebSocket 在 TCP 阶段连不上（端口没人听）或握手被拒时
 *    通常**不触发** onerror 的 message，只有一个 code=1006 的 onclose。
 *    以前 onclose 只在 1008/4001/403 三种码上写 lastError，于是最常发生的那种
 *    「连不上」在设置页上完全没有痕迹 —— 界面永远停在「连接中」。
 * @param {{code?: number, reason?: string}} [ev]
 */
export function closeReason(ev) {
	const code = Number(ev?.code);
	const reason = String(ev?.reason ?? '').trim();
	if (code === 1008 || code === 4001 || code === 403) return `令牌被拒绝，连不上（检查 accessToken${reason ? `：${reason}` : ''}）`;
	if (code === 1006) return '连不上 SnowLuma（没在运行 / 端口不对 / 令牌不对 —— 看一眼 SnowLuma 那边有没有报 unauthorized）';
	if (code === 1000) return '和 SnowLuma 的连接被正常关闭';
	if (code === 1001 || code === 1012 || code === 1013) return `和 SnowLuma 的连接断开（服务端重启或过载，code ${code}），正在重连`;
	if (Number.isFinite(code) && code !== 1005) return `和 SnowLuma 的连接断开（code ${code}${reason ? `：${reason}` : ''}），正在重连`;
	return '连不上 SnowLuma（没在运行 / 地址或令牌不对）';
}

export class SnowLumaChannel {
	/**
	 * @param {object} deps
	 * @param {() => {enabled?: boolean, wsUrl?: string, accessToken?: string}} deps.getConfig
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {(event: object) => void} [deps.onEvent] 非响应类的 OneBot 事件（message / notice / request）
	 * @param {() => void} [deps.onConnected]
	 * @param {typeof WebSocket} [deps.WebSocketImpl] 测试注入
	 */
	constructor({ getConfig, log, onEvent, onConnected, WebSocketImpl, findToken }) {
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.onEvent = onEvent ?? (() => {});
		this.onConnected = onConnected ?? (() => {});
		this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
		/** 连不上时自己去 SnowLuma 配置里找令牌（默认实现见 snowluma-token.js；测试里可注入） */
		this.findToken = findToken ?? defaultFindToken;
		/** 连不上时自己去 SnowLuma 配置里找到的令牌（内存里，不落盘；'' = 没找到） */
		this.autoToken = '';
		this.ws = null;
		this.connected = false;
		this.selfId = '';
		this.nickname = '';
		this.lastError = null;
		this.connectedAt = null;
		this.stopped = true;
		this.attempt = 0;
		this.reconnectTimer = null;
		this.friendTimer = null;
		this.seq = 0;
		/** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
		this.pending = new Map();
		this.friends = new Set();
		this.friendsLoaded = false;
		this.groupNames = new Map();
	}

	status() {
		return {
			connected: this.connected,
			selfId: this.selfId,
			nickname: this.nickname,
			lastError: this.lastError,
			connectedAt: this.connectedAt,
			friendCount: this.friends.size,
			/** 现在用的是不是「从 SnowLuma 配置里自动读到的」那份令牌 */
			autoToken: this.autoToken !== ''
		};
	}

	start() {
		this.stopped = false;
		// 先在配置里探一次：没有手填令牌（或手填的已经不新鲜）就先把真令牌拿在手里，
		// 免得启动时先撞一次「连不上」再自愈 —— 正常情况一条 warn 都不该有。
		this.prefetchToken();
		this.connect();
		if (this.friendTimer === null) {
			this.friendTimer = setInterval(() => { if (this.connected) void this.refreshFriends(); }, FRIEND_REFRESH_MS);
			this.friendTimer.unref?.();
		}
	}

	/** 启动前探一次：宁可用 SnowLuma 配置里的真令牌，也不用填的旧值去撞一次墙。 */
	prefetchToken() {
		const mine = String(this.getConfig()?.accessToken ?? '');
		if (mine !== '') return;         // 手填了就先按手填的连（故意的：不猜用户为什么填）；
		                                 // 填错了也不要紧，onclose 那次自愈会兜住
		const found = this.readToken();
		if (found === '' || found === this.autoToken) return;
		this.autoToken = found;
		this.log('info', `[fish-soul] QQ：启动时读到访问令牌（${found.length} 字符，来自 SnowLuma 配置）`);
	}

	stop() {
		this.stopped = true;
		if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		if (this.friendTimer !== null) clearInterval(this.friendTimer);
		this.friendTimer = null;
		this.closeSocket();
	}

	/** 配置（地址/令牌/开关）变了：断开重连。 */
	restart() {
		// 用户在设置页动过配置（多半就是改令牌）：自动取来的那份作废，重新以填的为准
		this.autoToken = '';
		this.stop();
		if (this.getConfig().enabled === true) this.start();
	}

	closeSocket() {
		const ws = this.ws;
		this.ws = null;
		this.connected = false;
		for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('连接已断开')); }
		this.pending.clear();
		if (ws !== null) { try { ws.close(); } catch { /* 已关闭 */ } }
	}

	buildUrl() {
		const cfg = this.getConfig();
		const url = new URL(String(cfg.wsUrl || 'ws://127.0.0.1:3001'));
		// 平时用用户填的；一旦因为鉴权失败去 SnowLuma 配置里取过令牌，那份就优先
		// （能走到那一步就说明填的这份已经不好使了）。用户在设置页一改，restart() 会清掉它。
		const tok = this.autoToken !== '' ? this.autoToken : String(cfg.accessToken ?? '');
		if (tok !== '') url.searchParams.set('access_token', tok);
		return url.toString();
	}

	/** 去 SnowLuma 的配置里读一次令牌（只读）。读不到 / 出错都返回 ''。 */
	readToken() {
		try { return String(this.findToken?.()?.token ?? ''); } catch { return ''; }
	}

	/**
	 * 连不上时去 SnowLuma 自己的配置里问一次令牌（只读）。
	 * 换了令牌才返回 true，让调用方立刻重连一次（不换就按正常退避，别抖）。
	 */
	askSnowLumaToken() {
		const found = this.readToken();
		if (found === '' || found === this.autoToken) return false;
		this.autoToken = found;
		this.log('info', `[fish-soul] QQ：从 SnowLuma 的配置里读到了访问令牌（${found.length} 字符），换个钥匙再连一次`);
		return true;
	}

	connect() {
		if (this.stopped) return;
		if (typeof this.WebSocketImpl !== 'function') {
			this.lastError = '当前 Node 没有内置 WebSocket（需要 Node 22 及以上）';
			this.log('error', `[fish-soul] QQ：${this.lastError}`);
			return;
		}
		let ws;
		try {
			ws = new this.WebSocketImpl(this.buildUrl());
		} catch (error) {
			this.lastError = `地址无效：${String(error instanceof Error ? error.message : error)}`;
			this.log('error', `[fish-soul] QQ：${this.lastError}`);
			return;
		}
		this.ws = ws;
		ws.onopen = () => {
			if (this.ws !== ws) return;
			this.connected = true;
			this.attempt = 0;
			this.lastError = null;
			this.connectedAt = Date.now();
			void this.afterOpen();
		};
		ws.onmessage = (ev) => {
			if (this.ws !== ws) return;
			this.handleFrame(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
		};
		ws.onerror = (ev) => {
			if (this.ws !== ws) return;
			this.lastError = String(ev?.message ?? ev?.error?.message ?? '连接出错（SnowLuma 没开、端口不对或令牌错误）');
		};
		ws.onclose = (ev) => {
			if (this.ws !== ws) return;
			const wasConnected = this.connected;
			this.closeSocket();
			// 🔴 连接失败必须留下可见的 lastError，否则设置页只会一直显示「连接中」。
			//    Node 的 WebSocket 在 TCP 阶段连不上 / 握手被拒时只有 onclose、没有 onerror 的 message，
			//    所以以前这一路是「静默重连」：界面既看不到「连不上」，也看不到「令牌不对」。
			this.lastError = closeReason(ev);
			if (wasConnected) this.log('warn', `[fish-soul] QQ：和 SnowLuma 的连接断开（${ev?.code ?? '?'}），稍后重连`);
			else if (this.attempt === 0) this.log('warn', `[fish-soul] QQ：${this.lastError}`); // 连不上的第一轮记一条，退避期间不刷屏
			// 握手被拒（超额 403 / 令牌不对）或压根连不上：去 SnowLuma 配置里找一次真令牌。
			// SnowLuma 更新/重建配置会重新生成令牌，手填的那份经常是旧的。
			if (!wasConnected && (ev?.code === 1006 || ev?.code === 1008 || ev?.code === 403)) this.askSnowLumaToken();
			this.scheduleReconnect();
		};
	}

	scheduleReconnect() {
		if (this.stopped || this.reconnectTimer !== null) return;
		const delay = RECONNECT_STEPS_MS[Math.min(this.attempt, RECONNECT_STEPS_MS.length - 1)];
		this.attempt++;
		this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
		this.reconnectTimer.unref?.();
	}

	async afterOpen() {
		try {
			const info = await this.call('get_login_info', {});
			this.selfId = String(info?.user_id ?? this.selfId ?? '');
			this.nickname = String(info?.nickname ?? '');
		} catch (error) {
			this.log('warn', `[fish-soul] QQ：get_login_info 失败：${String(error instanceof Error ? error.message : error)}`);
		}
		await this.refreshFriends();
		this.log('info', `[fish-soul] QQ：已连上 SnowLuma（${this.nickname || '?'} / ${this.selfId || '?'}，好友 ${this.friends.size}）`);
		try { await this.onConnected(); } catch (error) {
			this.log('warn', `[fish-soul] QQ：连上后的补拉失败：${String(error instanceof Error ? error.message : error)}`);
		}
	}

	handleFrame(text) {
		let msg;
		try { msg = JSON.parse(text); } catch { return; }
		if (msg === null || typeof msg !== 'object') return;
		if (msg.echo !== undefined && this.pending.has(String(msg.echo))) {
			const p = this.pending.get(String(msg.echo));
			this.pending.delete(String(msg.echo));
			clearTimeout(p.timer);
			if (msg.status === 'ok' || msg.retcode === 0) p.resolve(msg.data ?? null);
			else p.reject(new Error(`${msg.wording || msg.message || msg.msg || 'OneBot 调用失败'}（retcode ${msg.retcode ?? '?'}）`));
			return;
		}
		if (msg.post_type === undefined) return;
		if (msg.post_type === 'meta_event') {
			if (msg.self_id !== undefined && this.selfId === '') this.selfId = String(msg.self_id);
			return;
		}
		if (msg.post_type === 'notice' && msg.notice_type === 'friend_add') this.friends.add(String(msg.user_id));
		try { this.onEvent(msg); } catch (error) {
			this.log('error', `[fish-soul] QQ：处理事件出错：${String(error instanceof Error ? error.message : error)}`);
		}
	}

	/** 调一个 OneBot 接口；未连接直接拒绝。 */
	call(action, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
		const ws = this.ws;
		if (ws === null || !this.connected) return Promise.reject(new Error('QQ 未连接'));
		const echo = `fs-${Date.now().toString(36)}-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(echo);
				reject(new Error(`${action} 超时`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(echo, { resolve, reject, timer });
			try {
				ws.send(JSON.stringify({ action, params, echo }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(echo);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async refreshFriends() {
		try {
			const list = await this.call('get_friend_list', {});
			const rows = Array.isArray(list) ? list : Array.isArray(list?.friends) ? list.friends : [];
			this.friends = new Set(rows.map((f) => String(f?.user_id ?? f?.uin ?? '')).filter((x) => x !== ''));
			this.friendsLoaded = true;
		} catch (error) {
			this.log('warn', `[fish-soul] QQ：拉好友列表失败：${String(error instanceof Error ? error.message : error)}`);
		}
	}

	isFriend(userId) {
		return this.friends.has(String(userId));
	}

	async groupName(groupId) {
		const key = String(groupId);
		const cached = this.groupNames.get(key);
		if (cached !== undefined && Date.now() - cached.at < GROUP_NAME_TTL_MS) return cached.name;
		try {
			const info = await this.call('get_group_info', { group_id: Number(key) });
			const name = String(info?.group_name ?? '');
			this.groupNames.set(key, { name, at: Date.now() });
			return name;
		} catch {
			return cached?.name ?? '';
		}
	}

	/** 取一条消息（引用回复时拿被引用的原文）。 */
	async getMessage(messageId) {
		try {
			return await this.call('get_msg', { message_id: Number(messageId) || messageId });
		} catch {
			return null;
		}
	}

	/** 拉某个聊天最近的消息（断线补齐用）。返回 OneBot message 事件数组（旧 → 新）。 */
	async fetchHistory(channelId, count = 20) {
		const [kind, id] = String(channelId).split(':');
		const data = kind === 'group'
			? await this.call('get_group_msg_history', { group_id: Number(id), count })
			: await this.call('get_friend_msg_history', { user_id: Number(id), count });
		const list = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
		return list
			.map((m) => ({ post_type: 'message', message_type: kind === 'group' ? 'group' : 'private', ...m }))
			.sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0));
	}

	/**
	 * 发一条消息到 `private:<QQ>` / `group:<群号>`。
	 * @returns {Promise<string>} message_id
	 */
	async send(channelId, segments) {
		const [kind, id] = String(channelId).split(':');
		if (!id) throw new Error(`目标无效：${channelId}`);
		const data = kind === 'group'
			? await this.call('send_group_msg', { group_id: Number(id), message: segments })
			: await this.call('send_private_msg', { user_id: Number(id), message: segments });
		return String(data?.message_id ?? '');
	}
}
