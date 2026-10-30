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
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	fishSoulDir, findChatSession, findChatSessionBySessionId, insertChatSession, listChatSessions,
	findPersonByQq, getKv, setKv
} from './db.js';
import { normalizeMessageEvent, sanitizeName, sanitizeUserText } from './channels/onebot.js';
import { 该收这条, 提取正文, 提取图块, 拆成消息段, 抠正文图 } from './channels/vendor/qq-bridge.js';

export const SOURCE_QQ = 'fish-soul/qq';
export const SOURCE_PROACTIVE = 'fish-soul/proactive';
/** QQ 会话里模型能用的全部工具（宿主 PTC 传输 run_code 不算工具本身，单独放行）。 */
export const QQ_SESSION_TOOLS = ['remember', 'recall', 'forget'];
const SILENT_RE = /^\s*\[(不回|沉默|skip)\]\s*$/i;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INBOUND_IMAGES = 4;
const MAX_PARAGRAPHS = 5;
const SEEN_LIMIT = 4000;
const OWN_LIMIT = 500;
const PROACTIVE_TURN_TIMEOUT_MS = 5 * 60_000;

export function dedicatedWorkspacePath() {
	return join(fishSoulDir(), 'workspace');
}

function mediaTypeOf(buf) {
	if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
	if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
	if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
	return 'image/jpeg';
}

function isInside(root, target) {
	const rel = relative(resolve(root), resolve(target));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 读消息里的图片（url / file:// / base64:// / 本地路径），失败返回 null。 */
async function fetchImageBytes(img) {
	const url = typeof img?.url === 'string' ? img.url.trim() : '';
	try {
		if (/^https?:\/\//i.test(url)) {
			const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
			if (res.ok) {
				const buf = Buffer.from(await res.arrayBuffer());
				return buf.length <= MAX_IMAGE_BYTES ? buf : null;
			}
		} else if (url.startsWith('file://')) {
			return readFileSync(fileURLToPath(url));
		}
	} catch { /* 换 file 字段再试 */ }
	const file = typeof img?.file === 'string' ? img.file.trim() : '';
	try {
		if (file.startsWith('base64://')) return Buffer.from(file.slice(9), 'base64');
		if (/^https?:\/\//i.test(file)) {
			const res = await fetch(file, { signal: AbortSignal.timeout(8000) });
			if (res.ok) return Buffer.from(await res.arrayBuffer());
		}
	} catch { /* 放弃 */ }
	return null;
}

/** 可选宿主服务：先 ctx.get（不触发未声明 inject 的告警），再退回属性访问。 */
function service(ctx, name) {
	try {
		const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
		if (v !== undefined && v !== null) return v;
	} catch { /* 往下 */ }
	try { return ctx[name] ?? null; } catch { return null; }
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
	 * @param {object} deps.soul index.js 提供的人格/记忆回调
	 */
	constructor({ ctx, db, clock, getConfig, log, channel, soul }) {
		this.ctx = ctx;
		this.db = db;
		this.clock = clock;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.channel = channel;
		this.soul = soul;
		/** sessionId → chat_session 行（只存我们建的会话） */
		this.bound = new Map();
		/** channelId → Promise<Agent>（同一聊天并发来消息时只建一个会话） */
		this.inflight = new Map();
		/** channelId → {items, timer} */
		this.batches = new Map();
		/** channelId → {剩, 到}（群里点名后的接着听） */
		this.follow = new Map();
		/** sessionId → 本轮出站状态 */
		this.turns = new Map();
		/** sessionId → 下一轮回复时要引用的消息 id（群） */
		this.replyTo = new Map();
		/** 用户消息 id → 主动开口等待者 */
		this.waiters = new Map();
		this.seen = new Set();
		/** 她自己发出的消息 id → 正文摘要（识别"引用我"、给引用补原文） */
		this.ownMessages = new Map();
		this.stopped = false;
		for (const row of listChatSessions(db, 'qq')) this.bound.set(row.session_id, row);
	}

	qqConfig() {
		const q = this.getConfig().qq ?? {};
		return {
			enabled: q.enabled === true,
			groupAllowList: Array.isArray(q.groupAllowList) ? q.groupAllowList.map(String) : [],
			followUpCount: Number.isFinite(Number(q.followUpCount)) ? Number(q.followUpCount) : 3,
			followUpSeconds: Number.isFinite(Number(q.followUpSeconds)) ? Number(q.followUpSeconds) : 120,
			batchMs: Number.isFinite(Number(q.batchMs)) ? Number(q.batchMs) : 1500,
			replyWindowMinutes: Number.isFinite(Number(q.replyWindowMinutes)) ? Number(q.replyWindowMinutes) : 10
		};
	}

	masterQq() {
		return String(this.getConfig().masterQqUin ?? '');
	}

	stop() {
		this.stopped = true;
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
			return readdirSync(dir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).slice(0, 40);
		} catch {
			return [];
		}
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

	allowedTools() {
		const tools = this.ctx.tools;
		return QQ_SESSION_TOOLS.filter((n) => {
			try { return typeof tools?.get !== 'function' || tools.get(n) !== undefined; } catch { return false; }
		});
	}

	/** 新建/恢复会话时的 setup：挂默认预设，然后把全局工具收窄到记忆工具（失败就整个建会话失败，宁可不回也不放开 shell）。 */
	async setupAgent(agentCtx) {
		const presets = service(this.ctx, 'agentPresets');
		if (presets && typeof presets.mount === 'function') {
			try { await presets.mount(agentCtx); } catch (error) {
				this.log('warn', `[fish-soul] 挂默认预设失败（按无预设继续）：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		const allow = this.allowedTools();
		if (typeof agentCtx?.tools?.restrict === 'function' && allow.length > 0) {
			agentCtx.tools.restrict({ allow });
		}
	}

	async defaultPresetId() {
		try {
			const presets = service(this.ctx, 'agentPresets');
			if (!presets || typeof presets.resolve !== 'function') return undefined;
			const p = await presets.resolve();
			return p?.broken ? undefined : p?.id;
		} catch {
			return undefined;
		}
	}

	/** 拿到某个聊天对应的活会话（没有就恢复或新建）。 */
	async ensureSession(chat) {
		const key = chat.channelId;
		if (this.inflight.has(key)) return this.inflight.get(key);
		const p = (async () => {
			const agents = this.agentsService();
			if (agents === null) throw new Error('宿主没有 agents 服务');
			const row = findChatSession(this.db, 'qq', key);
			if (row !== null) {
				this.bound.set(row.session_id, row);
				const live = agents.get?.(row.session_id);
				if (live !== undefined && live !== null) return live;
				try {
					const handle = await agents.resume({
						resumeSessionId: row.session_id,
						setup: (agentCtx) => this.setupAgent(agentCtx)
					});
					this.log('info', `[fish-soul] 已恢复会话 ${row.title || key}`);
					return handle.agent;
				} catch (error) {
					this.log('warn', `[fish-soul] 恢复会话 ${row.session_id} 失败，改为新建：${String(error instanceof Error ? error.message : error)}`);
					this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
					this.bound.delete(row.session_id);
				}
			}
			return await this.createSession(chat);
		})();
		this.inflight.set(key, p);
		try {
			return await p;
		} finally {
			this.inflight.delete(key);
		}
	}

	async chatTitle(chat) {
		if (chat.chatType === 'group') {
			const name = chat.title || await this.channel.groupName(chat.targetId).catch(() => '');
			return `QQ群·${sanitizeName(name || chat.targetId, chat.targetId)}`;
		}
		const person = findPersonByQq(this.db, chat.targetId);
		const name = chat.title || person?.display_name || chat.targetId;
		return `QQ·${sanitizeName(name, chat.targetId)}${chat.targetId === this.masterQq() ? '（主人）' : ''}`;
	}

	async createSession(chat, workspacePath = this.workspacePath()) {
		const agents = this.agentsService();
		const ws = await this.ensureWorkspace(workspacePath);
		const sessionId = `fish-soul-${randomUUID()}`;
		const presetId = await this.defaultPresetId();
		const agentOptions = this.modelSelection();
		const handle = await agents.create({
			sessionId,
			meta: { cwd: ws.path ?? workspacePath, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
			...(agentOptions !== undefined ? { agentOptions } : {}),
			setup: (agentCtx) => this.setupAgent(agentCtx)
		});
		const title = await this.chatTitle(chat);
		try { await ws.attachSession?.(sessionId); } catch (error) {
			this.log('warn', `[fish-soul] 会话挂到工作区失败：${String(error instanceof Error ? error.message : error)}`);
		}
		try {
			const titles = service(this.ctx, 'sessionTitle');
			titles?.rename?.(handle.agent.session ?? handle.agent, title);
		} catch { /* 标题不影响功能 */ }
		const row = insertChatSession(this.db, {
			channel: 'qq', channelId: chat.channelId, sessionId, workspacePath: ws.path ?? workspacePath, title, nowMs: Date.now()
		});
		this.bound.set(sessionId, row);
		this.log('info', `[fish-soul] 已为 ${title} 新建会话 ${sessionId}`);
		return handle.agent;
	}

	/** "全部迁到新工作区"：每个聊天在当前选中的工作区里重建一个空会话（记忆在 soul.db，不受影响）。 */
	async migrateAll() {
		const target = this.workspacePath();
		const rows = listChatSessions(this.db, 'qq').filter((r) => resolve(r.workspace_path) !== resolve(target));
		let migrated = 0;
		const failed = [];
		for (const row of rows) {
			const [kind, id] = row.channel_id.split(':');
			try {
				await this.createSession({ channelId: row.channel_id, chatType: kind === 'group' ? 'group' : 'private', targetId: id, title: '' }, target);
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

	groupAllowed(groupId, cfg) {
		return cfg.groupAllowList.length === 0 || cfg.groupAllowList.includes(String(groupId));
	}

	/** OneBot 事件入口（实时推送和断线补拉共用）。 */
	async onEvent(event, { backfill = false } = {}) {
		if (this.stopped) return;
		const cfg = this.qqConfig();
		if (!cfg.enabled) return;
		const m = normalizeMessageEvent(event, { selfId: this.channel.selfId, ownMessageIds: this.ownMessages });
		if (m === null || m.userId === '' || m.userId === String(this.channel.selfId)) return;
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return;
		if (backfill) {
			const cur = this.cursorOf(m.channelId);
			if (cur !== null && (m.timeMs < Number(cur.timeMs) || (m.timeMs === Number(cur.timeMs) && m.messageId === cur.messageId))) return;
		}
		this.advanceCursor(m.channelId, m.timeMs, m.messageId);
		if (m.chatType === 'group' && !this.groupAllowed(m.groupId, cfg)) return;

		const person = this.soul.resolvePerson(m);
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;

		let decision;
		if (m.chatType === 'private') {
			const friend = m.subType === 'friend' || this.channel.isFriend(m.userId) || m.userId === this.masterQq();
			decision = friend ? 'reply' : 'memorize';
		} else {
			const gate = 该收这条({
				全听: false, 点名: m.mentioned, 接听: this.follow.get(m.channelId) ?? null,
				条: cfg.followUpCount, 秒: cfg.followUpSeconds, 现在: Date.now()
			});
			if (!stale) {
				if (gate.接听 === null) this.follow.delete(m.channelId);
				else this.follow.set(m.channelId, gate.接听);
			}
			decision = gate.收 ? 'reply' : 'ignore';
		}
		if (decision === 'reply' && stale) decision = 'memorize';
		if (decision === 'ignore') return;
		if (decision === 'memorize') {
			this.soul.memorizeUnanswered(person, m);
			return;
		}
		this.enqueue(m, person, cfg);
	}

	enqueue(m, person, cfg) {
		let batch = this.batches.get(m.channelId);
		if (batch === undefined) {
			batch = { items: [], timer: null };
			this.batches.set(m.channelId, batch);
		}
		batch.items.push({ m, person });
		if (batch.timer !== null) clearTimeout(batch.timer);
		const flush = () => {
			this.batches.delete(m.channelId);
			void this.dispatch(m.channelId, batch.items).catch((error) => {
				this.log('error', `[fish-soul] 转入会话失败（${m.channelId}）：${String(error instanceof Error ? error.message : error)}`);
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
		if (!msg) return '【引用了一条消息】';
		const n = normalizeMessageEvent({ post_type: 'message', message_type: msg.message_type ?? 'group', ...msg }, { selfId: this.channel.selfId });
		const who = sanitizeName(n?.nickname || msg.sender?.nickname || '', '某人');
		return `【引用 ${who}：${(n?.text ?? '').slice(0, 40)}】`;
	}

	async admitImages(text, items) {
		const imgs = [];
		for (const { m } of items) for (const img of m.images) if (imgs.length < MAX_INBOUND_IMAGES) imgs.push({ img, m });
		const base = [{ type: 'text', text }];
		if (imgs.length === 0) return base;
		const attachments = service(this.ctx, 'attachments');
		if (!attachments || typeof attachments.admitPromptContent !== 'function') return base;
		const parts = [...base];
		for (const [i, { img, m }] of imgs.entries()) {
			const bytes = await fetchImageBytes(img);
			if (bytes === null) continue;
			const mediaType = mediaTypeOf(bytes);
			parts.push({ type: 'image', data: bytes.toString('base64'), mediaType, name: `qq-${m.messageId || 'x'}-${i + 1}.${mediaType.split('/')[1]}` });
		}
		if (parts.length === 1) return base;
		try {
			return await attachments.admitPromptContent(parts);
		} catch (error) {
			this.log('warn', `[fish-soul] 图片交给 DSH 失败（这轮只转文字）：${String(error instanceof Error ? error.message : error)}`);
			return base;
		}
	}

	async dispatch(channelId, items) {
		if (this.stopped || items.length === 0) return;
		const first = items[0].m;
		const chat = { channelId, chatType: first.chatType, targetId: first.targetId, title: first.chatType === 'private' ? first.nickname : '' };
		const agent = await this.ensureSession(chat);

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
		this.soul.beginTurn(agent.id, {
			channel: chat.chatType === 'group' ? 'qq-group' : 'qq-private',
			channelId,
			speakers,
			workspacePath: this.bound.get(agent.id)?.workspace_path ?? this.workspacePath()
		});

		const lines = [];
		for (const { m } of items) {
			const quote = await this.quoteLine(m.replyId);
			const body = `${quote}${m.text || '（空消息）'}`;
			lines.push(chat.chatType === 'group' ? `${sanitizeName(m.nickname || m.userId, m.userId)}：${body}` : body);
		}
		const content = await this.admitImages(lines.join('\n'), items);
		const last = items[items.length - 1].m;
		const mentionItem = [...items].reverse().find(({ m }) => m.mentioned)?.m ?? last;
		if (chat.chatType === 'group') this.replyTo.set(agent.id, mentionItem.messageId);
		else this.replyTo.delete(agent.id);
		this.db.prepare('UPDATE chat_session SET last_inbound_at = ? WHERE session_id = ?').run(Date.now(), agent.id);

		await agent.followup({
			id: randomUUID(),
			role: 'user',
			content,
			source: {
				kind: SOURCE_QQ,
				channelId,
				chatType: chat.chatType,
				...(chat.chatType === 'group' ? { groupId: chat.targetId } : {}),
				userId: last.userId,
				messageId: last.messageId,
				mentioned: items.some(({ m }) => m.mentioned),
				speakers: speakers.map((s) => ({ userId: s.userId, nickname: s.displayName })),
				batch: items.length
			}
		});
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
	 */
	async triggerProactive(channelId, reason, { origin = 'idle' } = {}) {
		if (!this.qqConfig().enabled || !this.channel.connected) return false;
		const [kind, id] = String(channelId).split(':');
		if (!id || (kind !== 'private' && kind !== 'group')) return false;
		const chat = { channelId, chatType: kind, targetId: id, title: '' };
		const agent = await this.ensureSession(chat);
		const person = kind === 'private' ? findPersonByQq(this.db, id) : null;
		this.soul.beginTurn(agent.id, {
			channel: kind === 'group' ? 'qq-group' : 'qq-private',
			channelId,
			speakers: person !== null ? [{ person, userId: id, displayName: person.display_name, text: reason }] : [],
			workspacePath: this.bound.get(agent.id)?.workspace_path ?? this.workspacePath()
		});
		this.replyTo.delete(agent.id);
		const msgId = randomUUID();
		const done = new Promise((resolveDone) => {
			const timer = setTimeout(() => { this.waiters.delete(msgId); resolveDone(false); }, PROACTIVE_TURN_TIMEOUT_MS);
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
			st = { text: '', images: [], fromUs: false, messageIds: [] };
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
			st.fromUs = kind === SOURCE_QQ || kind === SOURCE_PROACTIVE;
			if (msg?.id !== undefined) st.messageIds.push(String(msg.id));
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
				for (const id of waiterIds) {
					const w = this.waiters.get(id);
					if (w === undefined) continue;
					clearTimeout(w.timer);
					this.waiters.delete(id);
					w.resolve(ok);
				}
			};
			if (!completed || !st.fromUs) { settle(false); return; }
			void this.sendReply(sessionId, st).then(settle, (error) => {
				this.log('error', `[fish-soul] 回复发到 QQ 失败：${String(error instanceof Error ? error.message : error)}`);
				settle(false);
			});
		}
	}

	resolveImageFile(p, workspacePath) {
		let raw = String(p ?? '').trim();
		if (raw === '') return null;
		if (/^https?:\/\//i.test(raw)) return { type: 'image', data: { file: raw } };
		try { if (raw.startsWith('file://')) raw = fileURLToPath(raw); } catch { return null; }
		const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspacePath, raw);
		// 只允许工作区和 fish-soul 数据目录里的图：模型写个 ![](~/.ssh/id_rsa) 不能把文件发出去
		if (!isInside(workspacePath, abs) && !isInside(fishSoulDir(), abs)) {
			this.log('warn', `[fish-soul] 拒绝发送工作区外的图片：${raw}`);
			return null;
		}
		if (!IMAGE_EXT.has(extname(abs).toLowerCase())) return null;
		try {
			if (!existsSync(abs) || statSync(abs).size > MAX_IMAGE_BYTES) return null;
			return { type: 'image', data: { file: `base64://${readFileSync(abs).toString('base64')}` } };
		} catch {
			return null;
		}
	}

	async attachmentSegment(block) {
		const attachments = service(this.ctx, 'attachments');
		try {
			if (typeof attachments?.readImage === 'function') {
				const stored = await attachments.readImage(block.attachment);
				const bytes = stored?.bytes ?? stored?.data;
				if (bytes) return { type: 'image', data: { file: `base64://${Buffer.from(bytes).toString('base64')}` } };
			}
			const p = attachments?.imageHostPath?.(block.attachment);
			if (p) return { type: 'image', data: { file: `base64://${readFileSync(p).toString('base64')}` } };
		} catch { /* 这张发不出去 */ }
		return null;
	}

	rememberOwn(messageId, text) {
		if (!messageId) return;
		this.ownMessages.set(String(messageId), text);
		if (this.ownMessages.size > OWN_LIMIT) this.ownMessages.delete(this.ownMessages.keys().next().value);
	}

	/** 把一轮的最终回复发回 QQ：按空行拆成几条连发，图片跟在最后。 */
	async sendReply(sessionId, st) {
		const row = this.bound.get(sessionId);
		if (row === undefined) return false;
		const raw = String(st.text ?? '').trim();
		if (SILENT_RE.test(raw)) return true;
		const { 净文字, 图 } = 抠正文图(raw.replace(/\s*\[(不回|沉默)\]\s*$/g, ''));
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
		let paragraphs = 净文字.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
		if (paragraphs.length > MAX_PARAGRAPHS) {
			paragraphs = [...paragraphs.slice(0, MAX_PARAGRAPHS - 1), paragraphs.slice(MAX_PARAGRAPHS - 1).join('\n\n')];
		}
		if (paragraphs.length === 0 && images.length === 0) return true;
		const isGroup = row.channel_id.startsWith('group:');
		const replyTo = isGroup ? this.replyTo.get(sessionId) : undefined;
		this.replyTo.delete(sessionId);
		const messages = paragraphs.map((p) => (isGroup ? 拆成消息段(p) : [{ type: 'text', data: { text: p } }]));
		if (images.length > 0) {
			if (messages.length > 0) messages[messages.length - 1].push(...images);
			else messages.push(images);
		}
		if (replyTo) messages[0].unshift({ type: 'reply', data: { id: String(replyTo) } });
		let allOk = true;
		for (const [i, segs] of messages.entries()) {
			if (i > 0) await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 600)));
			try {
				const id = await this.channel.send(row.channel_id, segs);
				this.rememberOwn(id, paragraphs[i] ?? '[图片]');
			} catch (error) {
				allOk = false;
				this.log('error', `[fish-soul] 发到 ${row.title || row.channel_id} 失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		return allOk;
	}
}
