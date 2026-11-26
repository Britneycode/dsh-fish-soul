import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fishSoulDir, findChatSession, insertChatSession, findPersonByQq, findPersonByBili, getKv } from './db.js';
import { sanitizeName } from './channels/onebot.js';
import { platformOf, splitChannelId, normalizeRelayId, service } from './gateway-util.js';
import { adapterOf } from './douyin-adapter.js';

/** QQ 会话里模型能用的全部工具（宿主 PTC 传输 run_code 不算工具本身，单独放行）。 */
export const QQ_SESSION_TOOLS = ['remember', 'recall', 'forget'];
/** 跨平台转达：主人在 QQ 私聊里让她去抖音 / B站 私信自己一条。 */
export const RELAY_TOOL = 'send_elsewhere';
/** 熟人传话：白名单里的人托她给白名单里的另一个人带句话（默认关）。 */
export const RELAY_FRIEND_TOOL = 'relay_to_friend';
/** 抖音发视频：主人在私聊里让她做一条视频并发抖音。 */
export const DOUYIN_VIDEO_TOOL = 'make_douyin_video';
/** 定时任务（#190）：AI 只能看和改已经排好的任务 —— 建与删只走设置页。 */
export const SCHEDULED_TASK_TOOLS = ['scheduled_tasks_list', 'scheduled_tasks_update'];
/** 聊天会话里放行的插件工具（记忆 + 跨平台转达 + 熟人传话 + 抖音发视频 + 定时任务）。 */
export const CHAT_TOOLS = [...QQ_SESSION_TOOLS, RELAY_TOOL, RELAY_FRIEND_TOOL, DOUYIN_VIDEO_TOOL, ...SCHEDULED_TASK_TOOLS];
/** OpenMotion MCP 工具名识别（兼容 mcp__openmotion__* 与 openmotion_*）。 */
export function isOpenMotionTool(name) {
	const s = String(name ?? '');
	return /^(?:mcp__openmotion__|openmotion_)[A-Za-z0-9_.-]+$/.test(s);
}
/** 宿主的联网工具：设置里打开「让她能上网查」才放行（护栏按天限次数）。 */
export const WEB_TOOLS = ['web_search', 'web_fetch'];
/** 自己填 key 的搜索服务（插件注册的工具） */
export const OWN_WEB_TOOL = 'fish_search';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** 发图清单最多给模型多少张。 */
const IMAGE_LIST_LIMIT = 64;
// 撞过「上下文超限」的会话 id（这条会话已经灌满了，再接新消息只会撞同一个错）。
// 存内存 + kv 各一份：内存够快，kv 让重启后也记得（重启前的那条会话恢复回来照样是满的）。
export const OVERFLOW_SESSION_KEY = 'session.overflowed';
/** 换模型被宿主挡了（模型切换压缩失败）—— 这条会话也不能再用了。 */
export const SWITCH_BLOCKED_SESSION_KEY = 'session.switchBlocked';
const MAX_CONSECUTIVE_RECYCLES = 2;
const RECYCLE_BREAKER_TTL_MS = 10 * 60_000;

export function dedicatedWorkspacePath() {
	return join(fishSoulDir(), 'workspace');
}

/** 文件修改时间（拿不到就当最旧，排序时沉底）。 */
function fileMtime(p) {
	try { return statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * 扫工作区根目录 + 一级子目录里的图片：隐藏目录不看，_stickers 归表情包管不重复收。
 * 返回 [{ rel, mtimeMs }]，rel 是相对工作区根的路径（模型照着写就能发出去）。
 */
function scanWorkspaceImages(workspacePath) {
	const out = [];
	const walk = (dir, prefix, depth) => {
		let entries = [];
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const name = e.name;
			if (name.startsWith('.')) continue;
			const full = join(dir, name);
			if (e.isDirectory()) {
				if (depth <= 0) continue;
				if (prefix === '' && name === '_stickers') continue;
				walk(full, `${prefix}${name}/`, depth - 1);
				continue;
			}
			if (!e.isFile()) continue;
			if (!IMAGE_EXT.has(extname(name).toLowerCase())) continue;
			// 文件名带空格/括号发不出去（markdown ![](...) 解析不了），不进清单
			if (/[\s()#]/.test(name)) continue;
			out.push({ rel: `${prefix}${name}`, mtimeMs: fileMtime(full) });
		}
	};
	walk(workspacePath, '', 1);
	return out;
}

/**
 * 混入 ChatGateway.prototype 的工作区与会话生命周期方法。
 * 通过 Object.assign 挂到原型上，保持所有对外方法签名不变。
 */
export const sessionMethods = {
	// ───────────────────────── 工作区 ─────────────────────────

	workspacePath() {
		const configured = String(this.getConfig().sessions?.workspacePath ?? '').trim();
		return configured !== '' ? resolve(configured) : dedicatedWorkspacePath();
	},

	registry() {
		return service(this.ctx, 'workspaceRegistry');
	},

	listWorkspaces() {
		try {
			const reg = this.registry();
			const rows = typeof reg?.list === 'function' ? reg.list() : [];
			return (rows ?? []).map((w) => ({ path: w.path, title: w.title ?? '', sessionCount: w.sessionIds?.length ?? 0 }));
		} catch {
			return [];
		}
	},

	async ensureWorkspace(path = this.workspacePath()) {
		mkdirSync(path, { recursive: true });
		mkdirSync(join(path, '_stickers'), { recursive: true });
		const reg = this.registry();
		if (reg === null || typeof reg.create !== 'function') return { path, attachSession: async () => {} };
		const title = resolve(path) === resolve(dedicatedWorkspacePath()) ? '鱼' : undefined;
		return await reg.create(path, title);
	},

	/** 工作区 _stickers/ 下的表情包文件名（给模型看的清单）。 */
	listStickers(workspacePath) {
		try {
			const dir = join(workspacePath, '_stickers');
			if (!existsSync(dir)) return [];
			const all = readdirSync(dir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));
			// 超过 40 张就随机抽 40：固定取前 40 个会让后面加的表情永远进不了提示词
			if (all.length <= 40) return all;
			for (let i = 0; i < 40; i++) {
				const j = i + Math.floor(Math.random() * (all.length - i));
				const t = all[i]; all[i] = all[j]; all[j] = t;
			}
			return all.slice(0, 40);
		} catch {
			return [];
		}
	},

	/** 当前嵌入模型 id（换模型后老的向量就不算数了，得重打）。 */
	embeddingModel() {
		try {
			const cfg = typeof this.embeddingCfg === 'function' ? this.embeddingCfg() : this.embeddingCfg;
			return String(cfg?.model ?? '');
		} catch { return ''; }
	},

	/**
	 * 给模型看的表情清单：文件名带上标签，`兔子OK.gif（可以可以、认同）`。
	 * 没标签的照旧只给文件名 —— 老记录 / 主人手放的图都走这条降级路，不报错。
	 * @returns {Array<{file: string, tags: string[]}>}
	 */
	stickerManifest(workspacePath) {
		const files = new Set(this.listStickers(workspacePath));
		if (files.size === 0) return [];
		const tagged = new Map();
		try {
			for (const x of this.stickers?.list(workspacePath) ?? []) {
				if (x.tags.length > 0 && files.has(x.file)) tagged.set(x.file, x.tags);
			}
		} catch { /* 拿不到标签就当全没标签 */ }
		return [...files].map((file) => ({ file, tags: tagged.get(file) ?? [] }));
	},

	/**
	 * 发图清单（给模型看的）：_stickers/ 里的表情包 + （images.sendAny 打开时）工作区里任意图片。
	 * 都是相对工作区根的路径，模型照着写 ![说明](相对路径) 就能发出去。
	 */
	listImages(workspacePath) {
		const ws = String(workspacePath ?? '').trim();
		const stickers = this.listStickers(ws).map((f) => ({ rel: `_stickers/${f}`, mtimeMs: fileMtime(join(ws, '_stickers', f)) }));
		const sendAny = this.getConfig?.()?.images?.sendAny === true;
		if (!sendAny || ws === '') return stickers.map((x) => x.rel);
		let extra = [];
		try { extra = scanWorkspaceImages(ws); } catch { return stickers.map((x) => x.rel); }
		// 表情包保底收录：它们和新图赛 mtime 会被挤出去（老逻辑保证表情包一直在清单里）
		const keep = Math.min(stickers.length, IMAGE_LIST_LIMIT);
		const rest = [...extra].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, IMAGE_LIST_LIMIT - keep);
		return [...stickers.slice(0, keep), ...rest].map((x) => x.rel);
	},

	// ───────────────────────── 会话 ─────────────────────────

	agentsService() {
		return service(this.ctx, 'agents');
	},

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
	},

	/**
	 * 会话里放行哪些工具。插件自己的工具按全局表筛；DSH 的联网工具（web_search / web_fetch）是按会话挂的，
	 * 全局表里经常查不到（#26），不筛——真没有时模型调不到而已。agentCtx 有自己的工具表时也认它。
	 * 主人私聊会话额外放行已挂载的 OpenMotion MCP 工具（由 tools.guard 再兜底校验主人身份）。
	 * #37：tools.sessionAllow = 'master' / 'all' 时放开宿主全部工具（restrict 都不调，让会话拿到默认组合）。
	 */
	allowedTools(agentCtx, channelId) {
		const has = (reg, n) => { try { return typeof reg?.get === 'function' && reg.get(n) !== undefined; } catch { return false; } };
		const tools = this.ctx?.tools;
		const listNames = (reg) => {
			try {
				if (typeof reg?.definitions === 'function') return (reg.definitions() ?? []).map((t) => t?.name).filter(Boolean);
				if (typeof reg?.list === 'function') return (reg.list() ?? []).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
			} catch { /* 忽略 */ }
			return [];
		};
		const isMaster = channelId !== undefined && typeof this.isMasterChannel === 'function' && this.isMasterChannel(channelId);
		const omTools = isMaster
			? [...new Set([...listNames(tools), ...listNames(agentCtx?.tools)].filter(isOpenMotionTool))]
			: [];
		const base = [...CHAT_TOOLS, ...WEB_TOOLS, OWN_WEB_TOOL, ...(this.voiceGuardReady ? ['sound_read'] : [])].filter((n) =>
			WEB_TOOLS.includes(n) || typeof tools?.get !== 'function' || has(tools, n) || has(agentCtx?.tools, n));
		return [...new Set([...base, ...omTools])];
	},

	/** 抖音会话要不要让模型「看得见」宿主工具（只影响可见性，授权仍在 guard 里逐轮判）。 */
	douyinHostVisible() {
		// guard 没装上就不能只靠 restrict 一层兜宿主工具，宁可继续只给记忆工具
		return this.voiceGuardReady === true && this.sessionAllowMode() !== 'memory';
	},

	/** 宿主工具名（不含插件自己的聊天工具、联网工具、OpenMotion 和 run_code）。 */
	hostToolNames(agentCtx) {
		const names = [];
		for (const reg of [this.ctx?.tools, agentCtx?.tools]) {
			try {
				if (typeof reg?.definitions === 'function') names.push(...(reg.definitions() ?? []).map((t) => t?.name));
				else if (typeof reg?.list === 'function') names.push(...(reg.list() ?? []).map((t) => (typeof t === 'string' ? t : t?.name)));
			} catch { /* 读不到就少给几个，不影响授权 */ }
		}
		const mine = new Set([...CHAT_TOOLS, ...WEB_TOOLS, OWN_WEB_TOOL, 'sound_read', 'run_code']);
		return [...new Set(names.filter((n) => typeof n === 'string' && n !== '' && !mine.has(n) && !isOpenMotionTool(n)))];
	},

	/** 传话配置：熟人托她给另一个人带句话（默认关，白名单按平台 uid 精确匹配）。 */
	relayConfig() {
		const r = this.getConfig().relay ?? {};
		return {
			enabled: r.enabled === true,
			// 手改配置文件可能写成裸数字（`10001`）—— 归一成 `qq:10001` 再比，
			// 不然形式对不上就静默失效（主人以为配了，实际一条也发不出去）。
			allowList: Array.isArray(r.allowList) ? r.allowList.map((x) => normalizeRelayId(x)).filter((x) => x !== null) : [],
			perDay: Number.isFinite(Number(r.perDay)) ? Math.max(1, Math.min(50, Math.floor(Number(r.perDay)))) : 5
		};
	},

	/** #37 聊天会话的工具放行档位：memory（默认，只放记忆 + 联网）| master（主人私聊全放开）| all（所有会话全放开）。 */
	sessionAllowMode() {
		const v = String(this.getConfig().tools?.sessionAllow ?? 'memory').trim().toLowerCase();
		return v === 'master' || v === 'all' ? v : 'memory';
	},

	/** #37 这个 channel 是不是主人的私聊会话（QQ 主人号 / B站 masterUid / 抖音 masterName）。 */
	isMasterChannel(channelId) {
		const [kind, id] = splitChannelId(channelId);
		if (kind === 'group' || kind === 'douyin-group') return false;
		if (kind === 'bili') return id === String(this.biliConfig().masterUid ?? '');
		if (kind === 'douyin') return false; // 昵称不是授权身份
		return id === this.masterQq();
	},

	/** #37 当前放行档位下，这个聊天建/恢复的会话要不要放开宿主全部工具。 */
	sessionOpenFor(channelId) {
		if (platformOf(channelId) === 'douyin') return false;
		const mode = this.sessionAllowMode();
		return mode === 'all' || (mode === 'master' && this.isMasterChannel(channelId));
	},

	/** 新建/恢复会话时的 setup：挂人格卡 + 瞬态块（只挂这个 agent），挂默认预设，然后把工具收窄到记忆工具。 */
	async setupAgent(agentCtx, channelId) {
		// 人格卡 + 此刻状态只挂在这个 agent 的 scope 上，不注册全局段 —— 宿主自己的会话根本看不到（#41 架构方案）
		try {
			this.agentSections?.(agentCtx);
		} catch (error) {
			// 注不上不拦着建会话：宁可她少一张人格卡，也别整个聊天哑掉（人格卡是真身份，但比「不回」轻）
			this.log('error', `[fish-soul] 人格注入挂不上：${String(error instanceof Error ? error.message : error)}`);
		}
		const presets = service(this.ctx, 'agentPresets');
		if (presets && typeof presets.mount === 'function') {
			const presetId = await this.chatPresetId();
			try {
				await presets.mount(agentCtx, presetId);
			} catch (error) {
				this.log('warn', `[fish-soul] 挂预设失败（按默认预设重试）：${String(error instanceof Error ? error.message : error)}`);
				try { await presets.mount(agentCtx); } catch (error2) {
					this.log('warn', `[fish-soul] 挂默认预设失败（按无预设继续）：${String(error2 instanceof Error ? error2.message : error2)}`);
				}
			}
		}
		if (channelId !== undefined && this.sessionOpenFor(channelId)) return; // #37 主人/全部放开：不 restrict，会话用宿主默认工具组合
		const allow = this.allowedTools(agentCtx, channelId);
		// #169 抖音：档位放开的只是「可见性」，真正放不放由 guard 每轮按身份当场判（见 lib/index.js）。
		// 这里不判身份 —— 身份证据会变，restrict 是一次性的，判错就收不回来。guard 没装就不放宽。
		if (platformOf(channelId) === 'douyin' && this.douyinHostVisible()) {
			for (const name of this.hostToolNames(agentCtx)) if (!allow.includes(name)) allow.push(name);
		}
		if (typeof agentCtx?.tools?.restrict === 'function' && allow.length > 0) {
			try {
				agentCtx.tools.restrict({ allow });
			} catch (error) {
				// 宿主要是不认没注册的工具名：去掉联网工具再收窄一次（收不窄就让建会话失败，宁可不回也不放开 shell）
				this.log('warn', `[fish-soul] 收窄工具失败，去掉联网工具重试：${String(error instanceof Error ? error.message : error)}`);
				agentCtx.tools.restrict({ allow: allow.filter((n) => !WEB_TOOLS.includes(n)) });
			}
		}
	},

	/**
	 * QQ 会话用哪个预设（#73）。
	 *
	 * PTC 预设（Programmatic Tool Calling）里模型**只能直接调 run_code**，
	 * 别的工具全变成 run_code 程序里的 SDK 绑定。而这个插件的护栏不放行 run_code
	 * （它能跑任意程序），于是宿主默认预设在 PTC 模式时，QQ 会话：
	 *   · 记忆工具调不到 —— 模型的唯一出口被堵死，整个会话是哑的；
	 *   · 压缩也落地不了 —— 宿主的压缩是一次独立的模型调用，它会带上这个会话的工具表，
	 *     表里只有 run_code，护栏一拦就失败重试（报错刷屏、上下文继续涨）。
	 *
	 * 所以 QQ 会话改用非 PTC 预设（宿主默认本来就是 standard）：工具直接暴露，
	 * 「只放记忆工具 + 上网查、run_code 始终不放行」这条约定才成立。
	 * 只影响插件自己建的聊天会话 —— 主人在 DSH 里自己开的会话不受影响。
	 *
	 * @returns {Promise<string|undefined>} 预设 id；undefined = 用宿主默认
	 */
	async chatPresetId() {
		const presets = service(this.ctx, 'agentPresets');
		if (!presets || typeof presets.resolve !== 'function') return undefined;
		let cur = null;
		try { cur = await presets.resolve(); } catch { return undefined; }
		const id = typeof cur?.id === 'string' ? cur.id : '';
		if (id === '' || cur?.broken) return undefined; // 读不到 / 坏了 → 照旧（挂载时宿主自己会兜底）
		if (!await this.isPtcPreset(presets, id)) return id;
		const alt = await this.nonPtcPreset(presets, id);
		if (alt === undefined) {
			this.log('warn', '[fish-soul] 宿主默认预设在 PTC 模式，又找不到别的预设：QQ 会话可能调不动工具（去 DSH 里换一个预设）');
			return id;
		}
		this.log('info', `[fish-soul] 宿主默认预设在 PTC 模式，QQ 会话改用 ${alt}（PTC 下只能直接调 run_code，护栏不放行）`);
		return alt;
	},

	/** 这个预设是不是 PTC（模型只能直接调 run_code 的那种）。 */
	async isPtcPreset(presets, id) {
		if (typeof presets.readDocument === 'function') {
			try {
				const doc = await presets.readDocument(id);
				if (typeof doc === 'string' && doc.trim() !== '') return /tool-executor-ptc/.test(doc);
			} catch { /* 读不到就按 id 猜 */ }
		}
		return /(^|[-_])ptc($|[-_])/i.test(String(id));
	},

	/** 找一个不是 PTC 的预设（优先 standard）。 */
	async nonPtcPreset(presets, current) {
		if (typeof presets.list !== 'function') return undefined;
		let rows = [];
		try { rows = await presets.list(); } catch { return undefined; }
		const cands = (Array.isArray(rows) ? rows : [])
			.filter((r) => r && typeof r.id === 'string' && r.id !== current && !r.broken);
		const std = cands.find((r) => r.id === 'standard');
		if (std !== undefined) return std.id;
		for (const r of cands) if (!await this.isPtcPreset(presets, r.id)) return r.id;
		return undefined;
	},

	targetModelKey(channelId) {
		try {
			const own = typeof this.getConfig === 'function' && typeof this.chatModelFor === 'function' ? this.chatModelFor(channelId) : null;
			const m = own ?? this.modelSelection?.() ?? null;
			return m ? `${m.provider}/${m.model}` : '';
		} catch { return ''; }
	},

	recycleBreakerEntry(channelId) {
		this.recycleBreaker ??= new Map();
		const key = String(channelId ?? '');
		const modelKey = this.targetModelKey(key);
		const cur = this.recycleBreaker.get(key);
		if (cur === undefined || Date.now() - cur.lastAt > RECYCLE_BREAKER_TTL_MS || cur.modelKey !== modelKey) {
			if (cur !== undefined) this.recycleBreaker.delete(key);
			return { count: 0, modelKey, lastAt: 0 };
		}
		return cur;
	},

	isRecycleTripped(channelId) {
		if (!channelId) return false;
		return this.recycleBreakerEntry(channelId).count >= MAX_CONSECUTIVE_RECYCLES;
	},

	recordRecycleAttempt(channelId) {
		if (!channelId) return;
		const key = String(channelId);
		const cur = this.recycleBreakerEntry(key);
		this.recycleBreaker.set(key, { count: cur.count + 1, modelKey: cur.modelKey, lastAt: Date.now() });
	},

	resetRecycleBreaker(channelId) {
		if (!channelId) return;
		this.recycleBreaker?.delete(String(channelId));
	},

	/**
	 * 换模型前先拿宿主 tokenMeter 测一下新模型窗口：明确超窗或新模型没配 contextWindow 时，
	 * 直接换新会话而不是等 agent.model.select 撞 MODEL_SWITCH_COMPACTION_FAILED 再白赔一轮。
	 */
	async shouldRotateBeforeModelSwitch(agent, channelId) {
		const desired = typeof this.desiredModelFor === 'function' ? this.desiredModelFor(agent, channelId) : null;
		if (desired === null) return null;
		const want = desired.selection;
		let cur;
		try { cur = agent?.model?.current?.(); } catch { return null; }
		if (!cur || (cur.provider === want.provider && cur.model === want.model)) return null;
		let previous;
		try { previous = agent?.session?.requestHeader?.(); } catch { return null; }
		if (!previous) return null;
		const llm = service(this.ctx, 'llm');
		if (typeof llm?.resolveModelInfo !== 'function') return null;
		let info;
		try { info = await llm.resolveModelInfo(want.provider, want.model); } catch { return null; }
		if (!info) return null;
		const cw = Number(info.context?.contextWindow ?? 0);
		if (!(cw > 0)) return { reason: 'no-context-window', want };
		const reserved = Math.max(0, Number(previous?.config?.maxTokens ?? info.defaultMaxTokens ?? 0) || 0);
		if (cw - reserved <= 0) return { reason: 'no-budget', want, cw, reserved };
		const meter = service(this.ctx, 'tokenMeter');
		if (typeof meter?.measure !== 'function') return null;
		let measured;
		try {
			measured = meter.measure(agent.session, {
				...previous,
				config: { ...(previous.config ?? {}), provider: want.provider, model: want.model }
			});
		} catch { return null; }
		const totalTokens = Number(measured?.totalTokens ?? 0);
		const threshold = Math.floor(Math.min(cw * 0.8, cw - reserved));
		if (totalTokens >= threshold) return { reason: 'over-threshold', want, totalTokens, threshold };
		return null;
	},

	/** 拿到某个聊天对应的活会话（没有就恢复或新建）。 */
	async ensureSession(chat) {
		// #78 第 2 步：B站 / 抖音 私聊用的是同一个人的 QQ 私聊会话（见 sessionOwnerChat）
		const owner = this.sessionOwnerChat(chat);
		const key = owner.channelId;
		const mergeFrom = key === chat.channelId ? '' : chat.channelId;
		if (this.inflight.has(key)) return this.inflight.get(key);
		const p = (async () => {
			const agents = this.agentsService();
			if (agents === null) throw new Error('宿主没有 agents 服务');
			const row = findChatSession(this.db, platformOf(key), key);
			// 设置页换了人格、选了「正在聊的也换」：这之前建的会话不再用，开个新的（旧会话的口吻不带过来，记忆在 soul.db 不受影响）
			const freshAfter = Number(getKv(this.db, 'persona.freshAfter', 0)) || 0;
			if (row !== null && freshAfter > 0 && Number(row.created_at) < freshAfter) {
				this.log('info', `[fish-soul] 换了人格，${row.title || key} 开新会话`);
				// 旧会话 retired 了，bound 里那一份也要摘掉：留着的话旧 sessionId 仍被当成
				// 「我们的会话」，它的 session/event 会走 sendReply 用已 retired 的 channel_id 发消息。
				this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
				this.bound.delete(row.session_id);
				this._modelApplied?.delete(row.session_id);
				return await this.createSession(owner, row.workspace_path || undefined, mergeFrom);
			}
			const unusableKind = row !== null ? this.unusableKindOf(row.session_id) : '';
			if (unusableKind !== '') {
				if (this.isRecycleTripped(key)) {
					this.log('warn', `[fish-soul] ${row.title || key} 连续换新会话仍上下文超限，已停止自动重建`);
					this.diag?.add('session-recycle-breaker', { sessionId: row.session_id, channelId: key, reason: '连续换新会话后仍上下文超限，请换更大上下文模型或调小预算' }, 'warn');
					this.note('failed', { channelId: key, reason: '连续换新会话后仍上下文超限，当前模型窗口可能太小，请换更大窗口模型、调低预算或手动「换新会话」' });
					throw new Error('连续换新会话后仍然上下文超限，已暂停自动重建');
				}
				this.recordRecycleAttempt(key);
				// 这条会话已经不能用了：上下文满了（压缩也没救回来），或者换模型被宿主的压缩闸门挡了。
				// 再接新消息只会撞同一个错 ⇒ 那个聊天会一直不回话。直接换新的 ——
				// 记忆在 soul.db，不受影响，丢的只是这段对话的语境。
				// 新会话直接带目标模型建起来，不会再撞「换模型要压旧历史」那道闸门。
				const why = unusableKind === 'switch' ? '换模型被挡了' : '上下文满了';
				this.log('warn', `[fish-soul] ${row.title || key} 的会话${why}，换一条新会话`);
				this.diag?.add(unusableKind === 'switch' ? 'session-switch-recycle' : 'session-overflow-recycle', { sessionId: row.session_id, channelId: key }, 'warn');
				this.note('session', { channelId: key, reason: `${why}，换了一条新会话（旧会话不再用）` });
				this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
				this.bound.delete(row.session_id);
				this._modelApplied?.delete(row.session_id);
				// 两个名单都摘：同一会话可能先踩了「上下文超限」、后又「换模型被挡」，只摘一个会漏。
				this.forgetUnusable(row.session_id, OVERFLOW_SESSION_KEY);
				this.forgetUnusable(row.session_id, SWITCH_BLOCKED_SESSION_KEY);
				return await this.createSession(owner, row.workspace_path || undefined, mergeFrom);
			}
			const rotateForPreflight = async (preflight) => {
				this.log('warn', `[fish-soul] ${row.title || key} 换模型前预检未通过（${preflight.reason}），直接换新会话`);
				this.diag?.add('session-switch-preflight', { sessionId: row.session_id, channelId: key, reason: preflight.reason }, 'warn');
				this.note('session', { channelId: key, reason: '换模型前预检目标模型上下文装不下旧历史，直接换了一条新会话' });
				this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
				this.bound.delete(row.session_id);
				this._modelApplied?.delete(row.session_id);
				this.forgetUnusable(row.session_id, OVERFLOW_SESSION_KEY);
				this.forgetUnusable(row.session_id, SWITCH_BLOCKED_SESSION_KEY);
				return await this.createSession(owner, row.workspace_path || undefined, mergeFrom);
			};
			if (row !== null) {
				this.bound.set(row.session_id, row);
				// 🔴 DSH 的系统提示里 {{model}} 取自 agent.options.model（建 / 恢复会话时传的 agentOptions）。
				//    以前恢复会话不传 ⇒ 每轮都报 prompt variable "{{model}}" has no value，回复一条都出不来。
				const agentOptions = this.chatModelFor(key) ?? this.modelSelection();
				const live = agents.get?.(row.session_id);
				if (live !== undefined && live !== null) {
					// 已经开着、但当初没带模型恢复的会话：救不回来（options 只读），换个新会话
					const broken = live.options !== undefined && !live.options?.model && agentOptions !== undefined;
					if (!broken) {
						const preflight = await this.shouldRotateBeforeModelSwitch(live, key);
						if (preflight !== null) return await rotateForPreflight(preflight);
						return live;
					}
					this.log('warn', `[fish-soul] ${row.title || key} 的会话没有模型（旧版恢复留下的），改为新建`);
					this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
					this.bound.delete(row.session_id);
					this._modelApplied?.delete(row.session_id);
					return await this.createSession(owner, undefined, mergeFrom);
				}
				try {
					const handle = await agents.resume({
						resumeSessionId: row.session_id,
						...(agentOptions !== undefined ? { agentOptions } : {}),
						setup: (agentCtx) => this.setupAgent(agentCtx, key)
					});
					this.log('info', `[fish-soul] 已恢复会话 ${row.title || key}`);
					this.diag?.add('session-resume', { sessionId: row.session_id, channelId: key });
					const preflight = await this.shouldRotateBeforeModelSwitch(handle.agent, key);
					if (preflight !== null) return await rotateForPreflight(preflight);
					return handle.agent;
				} catch (error) {
					const msg = String(error instanceof Error ? error.message : error);
					this.log('warn', `[fish-soul] 恢复会话 ${row.session_id} 失败，改为新建：${msg}`);
					this.diag?.add('resume-failed', { sessionId: row.session_id, channelId: key, reason: msg }, 'warn');
					this.db.prepare("UPDATE chat_session SET status = 'retired' WHERE id = ?").run(row.id);
					this.bound.delete(row.session_id);
					this._modelApplied?.delete(row.session_id);
				}
			}
			return await this.createSession(owner, undefined, mergeFrom);
		})();
		this.inflight.set(key, p);
		try {
			return await p;
		} finally {
			this.inflight.delete(key);
		}
	},

	/** 手动为一个聊天换一条新会话（记忆仍在 soul.db，只清空当前对话历史）。 */
	async resetSession(channelId, reason = '手动换新会话') {
		const [kind, id] = splitChannelId(channelId);
		const chat = { channelId, chatType: kind === 'group' || kind === 'douyin-group' ? 'group' : 'private', targetId: id, title: '' };
		const owner = typeof this.getConfig === 'function' && typeof this.sessionOwnerChat === 'function'
			? this.sessionOwnerChat(chat)
			: chat;
		const key = owner.channelId;
		const mergeFrom = key === channelId ? '' : channelId;
		return await this.runExclusiveForSession(key, async () => {
			if (this.agentsService() === null) throw new Error('宿主没有 agents 服务');
			const row = findChatSession(this.db, platformOf(key), key);
			// 先建新会话成功（insertChatSession 会原子退役旧行），再清旧状态 —— 避免失败时丢原会话和 workspace_path。
			const agent = await this.createSession(owner, row?.workspace_path || undefined, mergeFrom, { keepTitle: row?.title ?? '' });
			this.resetRecycleBreaker(key);
			if (row !== null) {
				this.bound.delete(row.session_id);
				this._modelApplied?.delete(row.session_id);
				this.forgetUnusable(row.session_id, OVERFLOW_SESSION_KEY);
				this.forgetUnusable(row.session_id, SWITCH_BLOCKED_SESSION_KEY);
			}
			this.diag?.add('session-manual-reset', { sessionId: agent.id, prevSessionId: row?.session_id ?? '', channelId: key, reason });
			this.note('session', { channelId: key, reason: `${reason}，已新建会话` });
			return { channelId: key, sessionId: agent.id, prevSessionId: row?.session_id ?? '' };
		});
	},

	async chatTitle(chat) {
		if (platformOf(chat.channelId) === 'douyin') return adapterOf(this).title(chat);
		if (platformOf(chat.channelId) === 'bili') {
			const person = findPersonByBili(this.db, chat.targetId);
			const name = chat.title || (person?.bili_uid === chat.targetId && !person?.qq_uin ? person.display_name : '') || chat.targetId;
			return `B站·${sanitizeName(name, chat.targetId)}${chat.targetId === this.biliConfig().masterUid ? '（主人）' : ''}`;
		}
		if (chat.chatType === 'group') {
			const name = chat.title || await this.channel.groupName(chat.targetId).catch(() => '');
			return `QQ群·${sanitizeName(name || chat.targetId, chat.targetId)}`;
		}
		const person = findPersonByQq(this.db, chat.targetId);
		const name = chat.title || person?.display_name || chat.targetId;
		return `QQ·${sanitizeName(name, chat.targetId)}${chat.targetId === this.masterQq() ? '（主人）' : ''}`;
	},

	async createSession(chat, workspacePath = this.workspacePath(), mergeFrom = '', { keepTitle = '' } = {}) {
		const agents = this.agentsService();
		const ws = await this.ensureWorkspace(workspacePath);
		const sessionId = `fish-soul-${randomUUID()}`;
		const presetId = await this.chatPresetId();
		const agentOptions = this.chatModelFor(chat.channelId) ?? this.modelSelection();
		if (agentOptions === undefined) this.log('warn', '[fish-soul] 找不到可用的模型（DSH 默认模型 / 模型服务都读不到），新会话可能跑不起来');
		const handle = await agents.create({
			sessionId,
			meta: { cwd: ws.path ?? workspacePath, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
			...(agentOptions !== undefined ? { agentOptions } : {}),
			setup: (agentCtx) => this.setupAgent(agentCtx, chat.channelId)
		});
		// 换新会话（resetSession）沿用旧标题：chatTitle 依赖人物库的当前状态，
		// 对方改了昵称 / person 行被合并过，重算出来的题头就变了 —— 用户眼里是
		// 「我只是换了个新会话，题头怎么变了」（2026-11-23 用户反馈）。
		const title = keepTitle !== '' ? keepTitle : await this.chatTitle(chat);
		this.diag?.add('session-create', { sessionId, channelId: chat.channelId, reason: title });
		try { await ws.attachSession?.(sessionId); } catch (error) {
			this.log('warn', `[fish-soul] 会话挂到工作区失败：${String(error instanceof Error ? error.message : error)}`);
		}
		try {
			const titles = service(this.ctx, 'sessionTitle');
			titles?.rename?.(handle.agent.session ?? handle.agent, title);
		} catch { /* 标题不影响功能 */ }
		const row = insertChatSession(this.db, {
			channel: platformOf(chat.channelId), channelId: chat.channelId, sessionId, workspacePath: ws.path ?? workspacePath, title, nowMs: Date.now()
		});
		// #78：这条通道（B站 / 抖音 私聊）并进 QQ 会话了。它自己以前那个会话留着（聊天记录还在），
		// 只是标成 retired + 记下并到了哪儿，之后查会话不会再查到它
		if (mergeFrom !== '' && mergeFrom !== chat.channelId) {
			this.db.prepare("UPDATE chat_session SET status = 'retired', merged_into = ? WHERE channel_id = ? AND status = 'active'")
				.run(sessionId, mergeFrom);
		}
		this.bound.set(sessionId, row);
		this.log('info', `[fish-soul] 已为 ${title} 新建会话 ${sessionId}`);
		return handle.agent;
	},

	/** "全部迁到新工作区"：每个聊天在当前选中的工作区里重建一个空会话（记忆在 soul.db，不受影响）。 */
	async migrateAll() {
		const target = this.workspacePath();
		const rows = this.allSessions().filter((r) => resolve(r.workspace_path) !== resolve(target));
		let migrated = 0;
		const failed = [];
		for (const row of rows) {
			const [kind, id] = splitChannelId(row.channel_id);
			try {
				await this.createSession({ channelId: row.channel_id, chatType: kind === 'group' || kind === 'douyin-group' ? 'group' : 'private', targetId: id, title: '' }, target);
				this.bound.delete(row.session_id);
				migrated++;
			} catch (error) {
				failed.push({ channelId: row.channel_id, error: String(error instanceof Error ? error.message : error) });
			}
		}
		return { migrated, failed, workspacePath: target };
	}
};
