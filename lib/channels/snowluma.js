/**
 * snowluma.js —— QQ 渠道：WebSocket 直连 SnowLuma 的 OneBot 11 正向 WS（默认 3001，Universal：
 * 收事件和调接口走同一条连接）。
 *
 *  - 零依赖：用 Node 22+ 内置的全局 WebSocket；
 *  - 鉴权：OneBot 11 标准的 `?access_token=` 查询参数（SnowLuma 默认自动生成令牌）；
 *  - 断线自动重连（1s → 30s 退避），每次连上都回调 onConnected（网关据此补拉历史）；
 *  - 只负责"收事件 / 调接口"，不认人、不建会话、不做门槛——那些在 gateway.js。
 */

const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10_000, 30_000];
const CALL_TIMEOUT_MS = 15_000;
const FRIEND_REFRESH_MS = 10 * 60_000;
const GROUP_NAME_TTL_MS = 30 * 60_000;

export class SnowLumaChannel {
	/**
	 * @param {object} deps
	 * @param {() => {enabled?: boolean, wsUrl?: string, accessToken?: string}} deps.getConfig
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {(event: object) => void} [deps.onEvent] 非响应类的 OneBot 事件（message / notice / request）
	 * @param {() => void} [deps.onConnected]
	 * @param {typeof WebSocket} [deps.WebSocketImpl] 测试注入
	 */
	constructor({ getConfig, log, onEvent, onConnected, WebSocketImpl }) {
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.onEvent = onEvent ?? (() => {});
		this.onConnected = onConnected ?? (() => {});
		this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
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
			friendCount: this.friends.size
		};
	}

	start() {
		this.stopped = false;
		this.connect();
		if (this.friendTimer === null) {
			this.friendTimer = setInterval(() => { if (this.connected) void this.refreshFriends(); }, FRIEND_REFRESH_MS);
			this.friendTimer.unref?.();
		}
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
		if (cfg.accessToken) url.searchParams.set('access_token', String(cfg.accessToken));
		return url.toString();
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
			if (ev?.code === 1008 || ev?.code === 4001 || ev?.code === 403) this.lastError = '令牌被拒绝（检查 accessToken）';
			if (wasConnected) this.log('warn', `[fish-soul] QQ：和 SnowLuma 的连接断开（${ev?.code ?? '?'}），稍后重连`);
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
