/**
 * life.js —— 自走层：15m tick、每日日程、主动投递、3h Dream 整理（设计方案 §10，审查 #02/#03/#08）。
 *
 * 时钟绑定（§10.5）：
 *  - day/pending 时间戳、空闲判定、due_at 比对 → 虚拟钟；
 *  - 主动消息 >=15s 风控冷却、Dream 最小间隔 30s（加速模式）、tick 定时器换算 → 物理钟。
 *
 * 投递安全（审查 #01）：只发 config.proactive.targets 白名单内的
 * 主人私聊（masterPrivateChannelId，缺省由 masterQqUin 推出）/ selfGroupChannelIds，严禁凭 owner_id 盲发。
 * B站私信默认不主动；设置页打开 bili.proactive 后，主人的 B站私信（bili:<masterUid>）才进白名单。
 * 15 秒风控冷却按平台分开算（QQ 与 B站互不占用），每日自发配额两边共用。
 *
 * 刷 B站（v0.4）：空闲时段、每天 ≤ perDay 次、两次至少隔 90 虚拟分钟且 ≥ 20 真实分钟，后台跑，不卡 tick。
 *
 * 到点提醒（#80）：tick 是 15 分钟一轮，光靠它到点的提醒平均晚 7.5 分钟。所以另挂一个闹钟
 * （armPendingAlarm），按最近一条 due_at 精确醒来，只跑到点投递那一段，不重跑日程 / Dream。
 */
import { VirtualClock } from './clock.js';
import { getKv, setKv, getProfile, setProfile } from './db.js';
import { PROFILE_FIELDS, mergeProfileFields, settleAffinity, ensureBirthdayPending, stageBase } from './soul-memory.js';
import { pad2 } from './time-util.js';

/** channel_id → 平台（和 gateway.platformOf 一致；这里不 import gateway，免得循环依赖）。 */
const platformOf = (channelId) => (String(channelId ?? '').startsWith('bili:') ? 'bili' : 'qq');

const TICK_VIRTUAL_MS = 15 * 60_000;
const DREAM_IDLE_VIRTUAL_MS = 3 * 3600_000;
const DREAM_MIN_REAL_GAP_MS = 30_000;
const PROACTIVE_REAL_COOLDOWN_MS = 15_000;
const PROACTIVE_MIN_GAP_VIRTUAL_MS = 60 * 60_000;
/** 空闲兜底的真实时间护栏：主人刚说过话就别立刻主动开口（#75）。0 = 关掉这道护栏。 */
export const DEFAULT_IDLE_REAL_GAP_MIN = 30;
export const DEFAULT_DAILY_MAX = 10;
/** 两轮刷视频之间的最短虚拟间隔。perDay 是上限，真正卡轮数的是这个间隔 ÷ idle 窗口长度。 */
const BROWSE_MIN_GAP_VIRTUAL_MS = 30 * 60_000;
const BROWSE_MIN_GAP_REAL_MS = 20 * 60_000;
/**
 * 待办投不出去时的重试阶梯（虚拟分钟）。#80 之前是固定 10 分钟、3 次判死——
 * 也就是断线半小时，一句「明天考试」的提醒就永远没了。现在退避拉长到 6 次，总窗口约 1 小时 48 分。
 */
const PENDING_RETRY_STEPS_VIRTUAL_MS = [1, 2, 5, 10, 30, 60].map((m) => m * 60_000);
const PENDING_MAX_ATTEMPTS = PENDING_RETRY_STEPS_VIRTUAL_MS.length;
/** 待办被「顺口提起」过、但对方没接着聊：过这么久退回 pending 重来（#80）。 */
const SURFACED_RECYCLE_VIRTUAL_MS = 6 * 3600_000;
const RESTORE_INTERACTION_WINDOW_MS = 7 * 86_400_000;
/** 刷到想分享的：排进待办，过了这么久（虚拟）还没发出去就算了（隔天再分享像翻旧账） */
const SHARE_TTL_VIRTUAL_MS = 4 * 3600_000;
const SHARE_DEFAULT_PER_DAY = 2;
/** 她自己起意的待办（占每日主动配额） */
const BOT_ORIGINS = new Set(['dream', 'share']);

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {VirtualClock} deps.clock
 * @param {() => object} deps.getConfig 读取完整配置（含 proactive 白名单）
 * @param {(prompt: string) => Promise<string|null>} deps.callLlm 日程/Dream 归纳用的 LLM 调用（fail-open 返回 null）
 * @param {(channelId: string, reason: string, meta: {origin: string}) => Promise<boolean>} deps.deliver
 *        主动开口：把理由递进目标聊天的会话，由会话里的模型带着上下文写，真正发到 QQ 后才返回 true
 * @param {(level: string, msg: string) => void} [deps.log]
 * @param {(opts: {count?: number}) => Promise<unknown>} [deps.browse] 刷一轮 B站
 * @param {number} [deps.browseRealGapMs] 两轮刷视频之间的最短真实间隔（测试用）
 * @param {(opts: {count?: number}) => Promise<unknown>} [deps.douyinBrowse] 刷一轮抖音
 * @param {() => boolean} [deps.douyinReady] 抖音浏览器在跑、已登录（不然这轮让给 B站）
 */
/**
 * 排日程的提示词：带上人格（是谁、平时的作息）和星期几，别每个人格都过成同一个大学生。
 * #75：日程写成"她这会儿**打算**做什么"的大方向，别写成已经发生过的事——
 * 过去式的虚构日程（"煮了碗面""点了外卖"）会被她当成自己的经历说出去，
 * 再被聊天整理记成长期记忆，越滚越假（人格卡本来就写着"别现编具体的"）。
 */
export function dayPlanPrompt(dateStr, p = {}) {
	const [y, m, d] = String(dateStr).split('-').map(Number);
	const wd = Number.isFinite(y) ? '日一二三四五六'[new Date(y, m - 1, d).getDay()] : '';
	const name = String(p?.name ?? '').trim() || 'feiyu';
	return `为人格 ${name} 生成 ${dateStr}${wd ? `（周${wd}）` : ''} 的一天作息。` +
		(p?.brief ? `\n人物设定：${String(p.brief).slice(0, 300)}` : '') +
		(p?.routine ? `\n平时的作息：${String(p.routine).slice(0, 300)}` : '') +
		'\n照这个人真实的一天来排：工作日和周末不一样，偶尔有点意外。' +
		'每段 activity 只写她**这会儿打算做什么的大方向**（20 字以内，如"在忙点正事""有点闲，想找人说说话""准备睡了"），' +
		'不要写成已经发生过的事，也不要写具体到吃了什么、去了哪、买了什么——具体的事留到聊天里随口说。' +
		'只输出 JSON：';
}

export class LifeEngine {
	constructor(opts) {
		const { db, clock, getConfig, callLlm, deliver, log, browse, browseRealGapMs = BROWSE_MIN_GAP_REAL_MS, douyinBrowse, douyinReady, persona, note, social, douyinShareTarget } = opts;
		// transcripts：可选的只读取样子（chat-archive 的 sample）—— 让 Dream 能拿原始对话核对记忆。
		// 不传就退化成原来的行为（只看记忆）。见 memory.transcriptReview。
		// ⚠️ 不能解构：index.js 那边传的是 getter（chatArchive 建得比 LifeEngine 晚），
		//    解构会当场把值取走（那时还是 undefined）。
		Object.defineProperty(this, 'transcripts', { get: () => opts.transcripts ?? null, enumerable: true });
		this.note = note ?? (() => {});
		this.douyinShareTarget = douyinShareTarget ?? (() => ''); // 抖音刷到的分享发到抖音私信（主人）；'' = 发不了，走 QQ
		this.social = social ?? null; // 自己发动态（social.js / douyin-social.js）：每 tick 问一次要不要发
		this.persona = persona ?? (() => ({}));
		this.db = db;
		this.clock = clock;
		this.getConfig = getConfig;
		this.callLlm = callLlm;
		this.deliver = deliver;
		this.log = log ?? (() => {});
		this.isTickRunning = false;
		this.isDreamRunning = false;
		/** @type {Map<string, AbortController>} owner_id → 进行中的 Dream（审查 #08） */
		this.dreamControllers = new Map();
		/** 平台（qq / bili）→ 上次主动投递的真实时间 */
		this.lastProactiveReal = new Map();
		this.browse = browse ?? null;
		this.douyinBrowse = douyinBrowse ?? null;
		this.douyinReady = douyinReady ?? (() => true);
		this.browseRealGapMs = browseRealGapMs;
		this.isBrowsing = false;
		this.lastBrowseRealMs = 0;
		this.lastDreamRealMs = 0;
		this.lastInteractionVirtualMs = new Map(); // owner_id → 虚拟时间
		/** 最后一次"有人跟她说话"的虚拟/真实时间（不区分人、不区分通道）。#75：主人换通道聊天时，空闲兜底也认。 */
		this.lastAnyInteractionVirtualMs = 0;
		this.lastAnyInteractionRealMs = 0;
		this.timer = null;
		/** 到点提醒的闹钟（#80）。和 15 分钟 tick 并存，不是替换。 */
		this.alarm = null;
	}

	/** 重启恢复：从 person.last_seen_at 重建"最近互动"表（否则重启后 Dream/空闲兜底全部失忆）。 */
	restoreInteractions() {
		try {
			const since = this.clock.now() - RESTORE_INTERACTION_WINDOW_MS;
			for (const p of this.db.prepare('SELECT canonical_id, last_seen_at FROM person WHERE last_seen_at >= ?').all(since)) {
				const ownerId = `user:${p.canonical_id}`;
				if (!this.lastInteractionVirtualMs.has(ownerId)) this.lastInteractionVirtualMs.set(ownerId, p.last_seen_at);
				if (p.last_seen_at > this.lastAnyInteractionVirtualMs) this.lastAnyInteractionVirtualMs = p.last_seen_at;
			}
		} catch { /* 空库 */ }
	}

	start() {
		if (this.timer !== null) return;
		this.restoreInteractions();
		const realDelay = this.clock.toRealIntervalMs(TICK_VIRTUAL_MS, 1000);
		this.timer = setInterval(() => { void this.tick(); }, realDelay);
		this.timer.unref?.();
		// 重启后第一轮别等满 15 分钟（#80）：先把到点的待办补一遍再挂闹钟。
		// 不直接跑整轮 tick——那里面串着生成日程和 Dream 的 LLM 调用，开机时正忙。
		const kick = setTimeout(() => {
			void this.flushDue(this.getConfig().proactive ?? {})
				.catch((error) => { this.log('error', `[fish-soul] 开机补投待办出错：${String(error instanceof Error ? error.message : error)}`); })
				.finally(() => { this.armPendingAlarm(); });
		}, 0);
		kick.unref?.();
	}

	stop() {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		if (this.alarm !== null) clearTimeout(this.alarm);
		this.alarm = null;
		for (const c of this.dreamControllers.values()) c.abort();
		this.dreamControllers.clear();
	}

	/** 实时消息到达（pre-step 调用）：更新互动时间，并中断该用户的 Dream（审查 #08）。 */
	noteInteraction(ownerId) {
		const nowVirtual = this.clock.now();
		this.lastInteractionVirtualMs.set(ownerId, nowVirtual);
		// #75：不区分人/通道的"最近一次有人说话"——主人换通道（桌面端 / QQ / B站）时，空闲兜底也得认。
		if (nowVirtual > this.lastAnyInteractionVirtualMs) this.lastAnyInteractionVirtualMs = nowVirtual;
		this.lastAnyInteractionRealMs = Date.now();
		const controller = this.dreamControllers.get(ownerId);
		if (controller !== undefined) {
			controller.abort();
			this.dreamControllers.delete(ownerId);
			this.log('info', `[fish-soul] ${ownerId} 来消息，已 abort 进行中的 Dream 整理`);
		}
	}

	/** 15 分钟 tick（互斥锁：上轮未返回直接跳过，审查 #03）。 */
	async tick() {
		if (this.isTickRunning) return;
		this.isTickRunning = true;
		try {
			const characterId = 'feiyu';
			const parts = this.clock.getRoleDateParts();
			// 虚拟钟快照：重启后从此处续走，不倒退
			setKv(this.db, 'clock.virtualMs', this.clock.now());

			// 1. 每日日程：当天无记录则调 LLM 生成一次（#75：开关关掉就不生成，也不注入）
			let day = this.db.prepare(
				'SELECT * FROM day WHERE character_id = ? AND date = ?'
			).get(characterId, parts.dateStr);
			if (day === undefined) {
				const plan = this.scheduleEnabled()
					? await this.generateDayPlan(parts.dateStr)
					: { date: parts.dateStr, dailyMoodTone: '平静', schedule: [] };
				this.db.prepare(`
					INSERT INTO day (date, character_id, plan_json, proactive_count, last_proactive_at, generated_at)
					VALUES (?, ?, ?, 0, NULL, ?)
				`).run(parts.dateStr, characterId, JSON.stringify(plan), this.clock.now());
				day = this.db.prepare('SELECT * FROM day WHERE character_id = ? AND date = ?').get(characterId, parts.dateStr);
			}

			// 2. 主动开口：事件驱动优先，空闲兜底
			await this.maybeProactive(day, parts);

			// 3. Dream 空闲整理：距上次互动 >=3h（虚拟钟）的用户
			await this.maybeDream();

			// 4. 空闲时自己刷会儿 B站（后台跑）
			this.maybeBrowse(day, parts);

			// 5. 想发动态就发一条（后台跑）
			if (this.social !== null) {
				let mood = '';
				try { mood = JSON.parse(day.plan_json)?.dailyMoodTone ?? ''; } catch { /* 无 */ }
				try { this.social({ parts, slot: this.currentSlot(day, parts), mood, activeHours: this.getConfig().proactive?.activeHours ?? [8, 24] }); } catch (error) {
					this.log('warn', `[fish-soul] 发动态检查出错：${String(error instanceof Error ? error.message : error)}`);
				}
			}
		} catch (error) {
			this.log('error', `[fish-soul] tick 异常：${String(error instanceof Error ? error.message : error)}`);
		} finally {
			this.isTickRunning = false;
		}
	}

	/** 自走日程开关（#75）：关掉 = 不生成日程、不注入时段、不用忙/闲卡住主动与刷视频。 */
	scheduleEnabled() {
		return this.getConfig().proactive?.scheduleEnabled !== false;
	}

	/** 每日日程 LLM 生成（按人格卡的设定和作息）；失败时给保底默认（fail-open，不阻塞 tick）。 */
	async generateDayPlan(dateStr) {
		const fallback = {
			date: dateStr,
			dailyMoodTone: '平静',
			schedule: [
				{ range: '08:30 - 12:00', activity: '上课 / 处理正事', availability: 'busy' },
				{ range: '14:00 - 17:00', activity: '自由摸鱼，在线回消息', availability: 'idle' },
				{ range: '19:30 - 23:30', activity: '打游戏 / 水群', availability: 'idle' },
				{ range: '23:30 - 08:30', activity: '睡了勿扰', availability: 'sleeping' }
			]
		};
		try {
			const text = await this.callLlm(
				dayPlanPrompt(dateStr, this.persona()) +
				`{"dailyMoodTone":"元气|慵懒|平静","schedule":[{"range":"HH:MM - HH:MM","activity":"...","availability":"busy|idle|sleeping"},...4 段]}`,
				{ feature: 'schedule' }
			);
			if (text === null) return fallback;
			const match = text.match(/\{[\s\S]*\}/);
			if (match === null) return fallback;
			const parsed = JSON.parse(match[0]);
			if (!Array.isArray(parsed.schedule)) return fallback;
			return { date: dateStr, dailyMoodTone: parsed.dailyMoodTone ?? '平静', schedule: parsed.schedule };
		} catch {
			return fallback;
		}
	}

	/** 当前虚拟时刻落在 plan_json 的哪个时段。日程开关关掉 = 没有时段（#75）。 */
	currentSlot(day, parts) {
		if (!this.scheduleEnabled()) return null;
		try {
			const plan = JSON.parse(day.plan_json);
			const minutes = parts.hour * 60 + parts.minute;
			for (const slot of plan.schedule ?? []) {
				const [start, end] = String(slot.range).split('-').map((s) => {
					const [h, m] = s.trim().split(':').map(Number);
					return h * 60 + m;
				});
				const inSlot = start <= end
					? minutes >= start && minutes < end
					: minutes >= start || minutes < end; // 跨午夜段
				if (inSlot) return slot;
			}
		} catch { /* plan_json 损坏视为无日程 */ }
		return null;
	}

	/** 每日主动上限（只算她自发的：空闲找人聊 + Dream 补登记的约定；你亲口交代的提醒不算）。 */
	dailyMax() {
		const n = Number(this.getConfig().proactive?.dailyMaxCount ?? DEFAULT_DAILY_MAX);
		return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DEFAULT_DAILY_MAX;
	}

	/**
	 * 主动开口判定与投递。硬约束：
	 *  - 活跃时段（虚拟钟，默认 08:00–24:00）—— 所有主动消息都受限；
	 *  - 物理钟 15s 风控冷却 —— 所有主动消息都受限；
	 *  - 白名单（主人私聊 + 自建群）—— 所有主动消息都受限；
	 *  - 每日上限（默认 10）与两条之间至少隔 60 虚拟分钟 —— 只限她自发的，用户交代的提醒不占配额、按时发。
	 */
	async maybeProactive(day, parts) {
		if (!this.proactiveAllowedNow()) return;
		const p = this.getConfig().proactive ?? {};
		// 到点的待办优先：有得发就不走空闲兜底，不然提醒和"随便聊聊"会同时开口
		if (await this.flushDue(p)) return;
		await this.idleProactive(day, parts, p);
	}

	/** 现在（虚拟钟）允许主动开口吗：总开关 + 活跃时段。tick 和到点闹钟走同一道门。 */
	proactiveAllowedNow() {
		const p = this.getConfig().proactive ?? {};
		if (p.enabled === false) return false;
		const [activeStart, activeEnd] = p.activeHours ?? [8, 24];
		const hour = this.clock.getRoleDateParts().hour;
		return hour >= activeStart && hour < activeEnd;
	}

	/** 15 秒物理冷却，按平台分开算（QQ 和 B站互不占用）。 */
	cooledFor(channelId) {
		return Date.now() - (this.lastProactiveReal.get(platformOf(channelId)) ?? 0) >= PROACTIVE_REAL_COOLDOWN_MS;
	}

	/**
	 * 把到点的待办发掉。
	 *
	 * #80：以前一轮只取一条，而 tick 是 15 分钟一轮——三条同时到点就要分别等 15/30/45 分钟。
	 * 现在用户交代的提醒一次全发；她自己起意的（dream / share）占每日配额，仍然一轮一条。
	 * @returns {Promise<boolean>} 这一轮有没有尝试投递（有就不再走空闲兜底）
	 */
	async flushDue(p) {
		const nowVirtual = this.clock.now();
		// 分享过了时效就不发了（下午刷到的视频晚上再发像翻旧账）
		this.db.prepare("UPDATE pending SET status = 'expired' WHERE character_id = 'feiyu' AND status = 'pending' AND origin = 'share' AND due_at < ?").run(nowVirtual - SHARE_TTL_VIRTUAL_MS);
		// 顺口提起过、对方没接着聊：过一阵退回 pending 重来，别让提醒就这么没了（#80）
		this.db.prepare(`
			UPDATE pending SET status = 'pending', due_at = ?, surfaced_at = NULL
			WHERE character_id = 'feiyu' AND status = 'surfaced' AND surfaced_at IS NOT NULL AND surfaced_at < ?
		`).run(nowVirtual, nowVirtual - SURFACED_RECYCLE_VIRTUAL_MS);
		// 只在白名单目标里挑：非白名单待办（陌生人/他人私聊）保持 pending，
		// 等对方下次开口时由瞬态块"顺口提起"（surfacePendingFor）。
		const rows = this.db.prepare(`
			SELECT * FROM pending
			WHERE character_id = 'feiyu' AND status = 'pending' AND due_at <= ?
			ORDER BY due_at ASC LIMIT 50
		`).all(nowVirtual).filter((d) => this.isWhitelisted(d.channel_id, p, d.origin) && this.cooledFor(d.channel_id));
		if (rows.length === 0) return false;

		let attempted = false;
		for (const d of rows) {
			if (BOT_ORIGINS.has(d.origin ?? 'user')) continue;
			attempted = true;
			await this.deliverOne(d, nowVirtual);
		}
		if (attempted) return true;

		// 她自发的待办：占每日配额、两条之间至少隔 60 虚拟分钟，一轮只发一条
		const day = this.db.prepare('SELECT * FROM day WHERE character_id = ? AND date = ?').get('feiyu', this.clock.getRoleDateParts().dateStr);
		const botAllowed = day !== undefined && (day.proactive_count ?? 0) < this.dailyMax() &&
			(day.last_proactive_at === null || day.last_proactive_at === undefined ||
			 nowVirtual - day.last_proactive_at >= PROACTIVE_MIN_GAP_VIRTUAL_MS);
		if (!botAllowed) return false;
		const bot = rows.find((d) => BOT_ORIGINS.has(d.origin) && !(d.origin === 'share' && d.due_at < nowVirtual - SHARE_TTL_VIRTUAL_MS));
		if (bot === undefined) return false;
		await this.deliverOne(bot, nowVirtual);
		return true;
	}

	/**
	 * 投递一条待办。
	 *
	 * 失败不再「3 次判死」（#80）：间隔按阶梯退避，6 次都发不出去才置 failed（总窗口约 1 小时 48 分）。
	 * 模型 5 分钟没写完算超时，日志单独记一笔——那多半是慢，不是断线；但同样要退避，
	 * 否则模型卡住时每分钟重叫一次，白烧额度。
	 * @returns {Promise<boolean>} 真的发出去了
	 */
	async deliverOne(d, nowVirtual) {
		const botInitiated = BOT_ORIGINS.has(d.origin ?? 'user');
		const platform = platformOf(d.channel_id);
		const meta = { origin: d.origin === 'share' ? 'share' : botInitiated ? 'dream' : 'user' };
		// 无论成败都计物理冷却，防止加速模式连发封号
		this.lastProactiveReal.set(platform, Date.now());
		let ok = false;
		try {
			ok = (await this.deliver(d.channel_id, d.reason, meta)) === true;
		} catch (error) {
			this.log('error', `[fish-soul] 主动开口失败（${d.channel_id}）：${String(error instanceof Error ? error.message : error)}`);
		}
		this.lastProactiveReal.set(platform, Date.now());
		if (ok) {
			this.db.prepare("UPDATE pending SET status = 'done' WHERE id = ?").run(d.id);
			if (botInitiated) {
				this.db.prepare(`
					UPDATE day SET proactive_count = proactive_count + 1, last_proactive_at = ?
					WHERE character_id = 'feiyu' AND date = ?
				`).run(nowVirtual, this.clock.getRoleDateParts().dateStr);
			}
			this.log('info', `[fish-soul] 主动消息已发到 ${d.channel_id}` +
				(botInitiated ? '（她自己起意的，占今日配额）' : '（用户交代的提醒，不占配额）'));
			return true;
		}
		const attempt = Number(d.attempts ?? 0);
		const step = PENDING_RETRY_STEPS_VIRTUAL_MS[Math.min(attempt, PENDING_RETRY_STEPS_VIRTUAL_MS.length - 1)];
		this.db.prepare(`
			UPDATE pending SET attempts = attempts + 1, due_at = due_at + ?,
			  status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
			WHERE id = ?
		`).run(step, PENDING_MAX_ATTEMPTS, d.id);
		if (attempt + 1 >= PENDING_MAX_ATTEMPTS) {
			this.log('warn', `[fish-soul] 待办 #${d.id} 重试 ${PENDING_MAX_ATTEMPTS} 次都没发出去，放弃：${d.reason}`);
		} else {
			this.log('warn', `[fish-soul] ${meta.timedOut === true ? '主动开口超时' : '主动开口失败'}（${d.channel_id}），${Math.round(step / 60_000)} 分钟后重试`);
		}
		return false;
	}

	/** 空闲兜底：好久没人说话，主动找主人聊一句。 */
	async idleProactive(day, parts, p) {
		const nowVirtual = this.clock.now();
		const botAllowed = (day.proactive_count ?? 0) < this.dailyMax() &&
			(day.last_proactive_at === null || day.last_proactive_at === undefined ||
			 nowVirtual - day.last_proactive_at >= PROACTIVE_MIN_GAP_VIRTUAL_MS);
		if (!botAllowed) return;
		// 时间驱动兜底：处在 idle 时段且主人距上次互动 > idleTriggerHours（虚拟钟）
		const slot = this.currentSlot(day, parts);
		// 没有日程（开关关掉）= 没有"忙"的时段，按随时可主动处理
		if (slot !== null && slot.availability !== 'idle') return;
		const masterOwner = p.targets?.masterCanonicalId ?? 'user:master';
		// #75：主人最近一次互动取「主人这一路」和「任何通道有人说她」里较新的那个——
		// 桌面端消息以前不登记互动，主人刚说完话她却按"好久没说话"开口（#75）。
		const lastSeen = Math.max(this.lastInteractionVirtualMs.get(masterOwner) ?? 0, this.lastAnyInteractionVirtualMs);
		const idleHours = p.idleTriggerHours ?? 6;
		if (nowVirtual - lastSeen < idleHours * 3600_000) return;
		// 真实时间护栏：刚聊完（默认 30 分钟内）不主动开口——虚拟钟加速时也挡得住
		const realGapMin = Number(p.idleRealGapMinutes ?? DEFAULT_IDLE_REAL_GAP_MIN);
		if (Number.isFinite(realGapMin) && realGapMin > 0 && this.lastAnyInteractionRealMs > 0 &&
			Date.now() - this.lastAnyInteractionRealMs < realGapMin * 60_000) return;
		const target = this.masterChannel(p);
		if (target === '' || !this.isWhitelisted(target, p) || !this.cooledFor(target)) return;

		const platform = platformOf(target);
		this.lastProactiveReal.set(platform, Date.now());
		let ok = false;
		try {
			ok = (await this.deliver(target, '好久没说话了，随便聊聊', { origin: 'idle' })) === true;
		} catch (error) {
			this.log('error', `[fish-soul] 主动开口失败（${target}）：${String(error instanceof Error ? error.message : error)}`);
		}
		this.lastProactiveReal.set(platform, Date.now());
		if (!ok) return;
		this.db.prepare(`
			UPDATE day SET proactive_count = proactive_count + 1, last_proactive_at = ?
			WHERE character_id = 'feiyu' AND date = ?
		`).run(nowVirtual, day.date);
		this.log('info', `[fish-soul] 主动消息已发到 ${target}（今日自发第 ${(day.proactive_count ?? 0) + 1} 条）`);
	}

	/**
	 * 下一条「能主动投递」的待办离现在还有多久（虚拟 ms），没有就 null。
	 * 非白名单的待办本来就不会被主动投递（等对方开口时顺口提），拿它定闹钟只会白醒一轮。
	 */
	nextPendingVirtualDelay() {
		const p = this.getConfig().proactive ?? {};
		const nowVirtual = this.clock.now();
		const rows = this.db.prepare(`
			SELECT due_at, channel_id, origin FROM pending
			WHERE character_id = 'feiyu' AND status = 'pending'
			ORDER BY due_at ASC LIMIT 50
		`).all();
		for (const r of rows) {
			if (!this.isWhitelisted(r.channel_id, p, r.origin)) continue;
			if (r.origin === 'share' && r.due_at < nowVirtual - SHARE_TTL_VIRTUAL_MS) continue;
			return Math.max(0, r.due_at - nowVirtual);
		}
		return null;
	}

	/**
	 * 给最近一条到点待办单独挂个闹钟（#80）。
	 *
	 * tick 是 15 分钟一轮，到点提醒只能跟着这个粒度走——平均晚 7.5 分钟、最坏 15 分钟。
	 * 这里按 due_at 精确醒来，只跑到点投递那一段。封顶 15 分钟：新登记 / 改配置这些信号
	 * 没接进来的时候，最坏也就退回 tick 的老精度，不会更差。
	 */
	armPendingAlarm() {
		if (this.alarm !== null) { clearTimeout(this.alarm); this.alarm = null; }
		if (!this.proactiveAllowedNow()) return;
		const delay = this.nextPendingVirtualDelay();
		if (delay === null) return;
		// 已经到点的（delay 0）多半是卡在 15s 风控上：等冷却过再来，别 1 秒一次空转
		const real = delay === 0
			? PROACTIVE_REAL_COOLDOWN_MS
			: this.clock.toRealIntervalMs(Math.min(delay, TICK_VIRTUAL_MS), 1000);
		this.alarm = setTimeout(() => {
			this.alarm = null;
			void this.flushDue(this.getConfig().proactive ?? {})
				.catch((error) => { this.log('error', `[fish-soul] 到点提醒投递出错：${String(error instanceof Error ? error.message : error)}`); })
				.finally(() => { this.armPendingAlarm(); });
		}, real);
		this.alarm.unref?.();
	}

	/** 主人私聊：显式配置优先，否则由 masterQqUin 推出 private:<QQ>。 */	masterChannel(proactiveCfg) {
		const explicit = String(proactiveCfg?.targets?.masterPrivateChannelId ?? '');
		if (explicit !== '') return explicit;
		const qq = String(this.getConfig().masterQqUin ?? '');
		return qq !== '' ? `private:${qq}` : '';
	}

	/**
	 * 取出某人已到期、但无法主动投递的待办，标记为 surfaced 后返回（注入瞬态块，让她在对方开口时自然提起）。
	 * @returns {string[]} reason 列表
	 */
	surfacePendingFor(ownerId, limit = 2) {
		if (!ownerId || ownerId === 'user:unknown') return [];
		const rows = this.db.prepare(`
			SELECT id, reason FROM pending
			WHERE character_id = 'feiyu' AND owner_id = ? AND status = 'pending' AND due_at <= ?
			ORDER BY due_at ASC LIMIT ?
		`).all(ownerId, this.clock.now(), limit);
		// surfaced_at 用来兜底回收：提起不等于说到，那轮她没提，这条过一阵要能回到 pending（#80）
		const now = this.clock.now();
		const mark = this.db.prepare("UPDATE pending SET status = 'surfaced', surfaced_at = ? WHERE id = ?");
		for (const r of rows) mark.run(now, r.id);
		return rows.map((r) => r.reason);
	}

	/** 白名单校验（审查 #01）：仅 masterPrivateChannelId 与 selfGroupChannelIds。 */
	isWhitelisted(channelId, proactiveCfg, origin = '') {
		const t = proactiveCfg.targets ?? {};
		// 抖音私信只放行分享（而且只发给主人）
		if (channelId.startsWith('douyin:')) return origin === 'share' && channelId === this.douyinShareTarget();
		if (channelId !== '' && channelId === this.masterChannel(proactiveCfg)) return true;
		const b = this.getConfig().bili ?? {};
		if (b.enabled === true && b.proactive === true && String(b.masterUid ?? '') !== '' && channelId === `bili:${b.masterUid}`) return true;
		return Array.isArray(t.selfGroupChannelIds) && t.selfGroupChannelIds.includes(channelId);
	}

	/** 今天刷了几轮（虚拟日）。key：'bili' | 'douyin'。 */
	browseState(dateStr, key = 'bili') {
		const st = getKv(this.db, `${key}.browse.day`, null);
		return st !== null && st.date === dateStr ? st : { date: dateStr, count: 0, lastVirtual: 0 };
	}

	/** 今天还能刷的来源（B站 / 抖音），按今天刷得少的排在前面。 */
	browseSources(dateStr) {
		const cfg = this.getConfig();
		const out = [];
		const perDayOf = (br) => Math.min(12, Math.max(0, Math.floor(Number(br?.perDay ?? 3)) || 0));
		const b = cfg.bili ?? {};
		if (this.browse !== null && b.enabled === true && b.browse?.enabled !== false) {
			out.push({ key: 'bili', label: 'B站', run: this.browse, perDay: perDayOf(b.browse) });
		}
		const d = cfg.douyin ?? {};
		if (this.douyinBrowse !== null && d.enabled === true && d.browse?.enabled === true && this.douyinReady()) {
			out.push({ key: 'douyin', label: '抖音', run: this.douyinBrowse, perDay: perDayOf(d.browse) });
		}
		// 今天刷得少的先；一样多就换着来（以前一样多时总是 B站 先，抖音老轮不上）
		const last = getKv(this.db, 'browse.lastKey', '');
		return out
			.map((src) => ({ ...src, st: this.browseState(dateStr, src.key) }))
			.filter((src) => src.st.count < src.perDay)
			.sort((x, y) => x.st.count - y.st.count || (x.key === last ? 1 : 0) - (y.key === last ? 1 : 0));
	}

	/** 抖音开了刷视频、但浏览器没开 / 没登录：这轮只能刷 B站，在动态里说一声（一天一次）。 */
	noteDouyinWaiting(dateStr, sources) {
		const d = this.getConfig().douyin ?? {};
		if (this.douyinBrowse === null || d.enabled !== true || d.browse?.enabled !== true || this.douyinReady()) return;
		if (sources.some((s) => s.key === 'douyin')) return;
		if (getKv(this.db, 'douyin.browse.waitNoted', '') === dateStr) return;
		setKv(this.db, 'douyin.browse.waitNoted', dateStr);
		this.note('browse', { title: '抖音', reason: '想刷抖音，但抖音浏览器没开或没登录，这次先刷 B站' });
	}

	/**
	 * 刷到特别想分享的视频：排一条给主人的主动消息（带链接 + 感受）。
	 * 走主动开口的所有限制（活跃时段、白名单、每日配额、两条之间的间隔），一天最多 proactive.shareMaxPerDay 条（默认 2）。
	 * @returns {{ok: boolean, error?: string, id?: number}}
	 */
	queueShare({ platform, title, author, url, impression }) {
		const p = this.getConfig().proactive ?? {};
		if (p.enabled === false) return { ok: false, error: '主动开口关着' };
		if (p.shareVideos === false) return { ok: false, error: '分享视频关着' };
		// 抖音刷到的：能发抖音私信就在抖音里分享给主人，不然发 QQ
		const dy = platform === '抖音' ? this.douyinShareTarget() : '';
		const target = dy !== '' ? dy : this.masterChannel(p);
		if (target === '' || !this.isWhitelisted(target, p, 'share')) return { ok: false, error: '没设主人 QQ，不知道发给谁' };
		const now = this.clock.now();
		const dateStr = this.clock.getRoleDateParts().dateStr;
		const max = Math.max(0, Math.floor(Number(p.shareMaxPerDay ?? SHARE_DEFAULT_PER_DAY)) || 0);
		const st = getKv(this.db, 'share.day', null);
		const count = st?.date === dateStr ? Number(st.count) || 0 : 0;
		if (count >= max) return { ok: false, error: `今天已经分享过 ${count} 条了` };
		const waiting = this.db.prepare("SELECT 1 FROM pending WHERE character_id = 'feiyu' AND status = 'pending' AND origin = 'share' LIMIT 1").get();
		if (waiting) return { ok: false, error: '上一条分享还没发出去' };
		const clean = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
		const reason = `你刚在${platform}刷到一个视频《${clean(title, 60) || '没写标题'}》${author ? `（${clean(author, 20)}）` : ''}，链接 ${url} 。` +
			`你看完觉得：${clean(impression, 120)}。很想发给对方看看：把链接原样发出去，再用一两句话说说你为什么想给 ta 看（像随手转给朋友，别写成推荐语、别复述标题）`;
		const owner = p.targets?.masterCanonicalId ?? 'user:master';
		const r = this.db.prepare(`
			INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at, origin)
			VALUES ('feiyu', ?, ?, ?, ?, ?, 'pending', ?, 'share')
		`).run(owner, target.startsWith('douyin:') ? 'douyin-private' : target.startsWith('group:') ? 'qq-group' : 'qq-private', target, now, reason, now);
		setKv(this.db, 'share.day', { date: dateStr, count: count + 1 });
		this.armPendingAlarm();
		return { ok: true, id: Number(r.lastInsertRowid) };
	}

	/** 空闲时段自己刷 B站 / 抖音（一次只刷一个）：后台跑，不阻塞 tick；失败只记日志。 */
	maybeBrowse(day, parts) {
		if ((this.browse === null && this.douyinBrowse === null) || this.isBrowsing) return;
		const [activeStart, activeEnd] = this.getConfig().proactive?.activeHours ?? [8, 24];
		if (parts.hour < activeStart || parts.hour >= activeEnd) return;
		// 没有日程（开关关掉）= 没有"忙"的时段，按随时可刷处理
		const slot = this.currentSlot(day, parts);
		if (slot !== null && slot.availability !== 'idle') return;
		const sources = this.browseSources(parts.dateStr);
		if (sources.length === 0) return;
		const nowVirtual = this.clock.now();
		const lastVirtual = Math.max(this.browseState(parts.dateStr, 'bili').lastVirtual, this.browseState(parts.dateStr, 'douyin').lastVirtual);
		if (lastVirtual > 0 && nowVirtual - lastVirtual < BROWSE_MIN_GAP_VIRTUAL_MS) return;
		if (Date.now() - this.lastBrowseRealMs < this.browseRealGapMs) return;
		this.noteDouyinWaiting(parts.dateStr, sources);
		const src = sources[0];
		this.lastBrowseRealMs = Date.now();
		setKv(this.db, `${src.key}.browse.day`, { date: parts.dateStr, count: src.st.count + 1, lastVirtual: nowVirtual });
		setKv(this.db, 'browse.lastKey', src.key);
		this.isBrowsing = true;
		// 没刷成（浏览器没开 / 没登录 / 正在刷）就把这次还回去，别白占当天的次数
		const refund = (why) => {
			const st = this.browseState(parts.dateStr, src.key);
			// 次数和间隔一起还：否则这一次白占一个间隔，下一轮得干等
			if (st.count > 0) setKv(this.db, `${src.key}.browse.day`, { ...st, count: st.count - 1, lastVirtual: 0 });
			this.note('browse', { title: src.label, reason: `刷${src.label}没刷成：${why}` });
		};
		void Promise.resolve()
			.then(() => src.run({}))
			.then((r) => { if (r && r.ok === false) refund(String(r.error ?? '没刷成')); })
			.catch((error) => {
				this.log('warn', `[fish-soul] 刷${src.label}失败：${String(error instanceof Error ? error.message : error)}`);
				refund(String(error instanceof Error ? error.message : error).slice(0, 60));
			})
			.finally(() => { this.isBrowsing = false; });
	}

	/** Dream 触发扫描：找空闲 >=3h（虚拟钟）的 owner。 */
	async maybeDream() {
		if (this.isDreamRunning) return;
		// 加速模式下两次 Dream 至少间隔真实物理 30s（审查 #03）
		if (Date.now() - this.lastDreamRealMs < DREAM_MIN_REAL_GAP_MS) return;
		const nowVirtual = this.clock.now();
		for (const [ownerId, lastSeen] of this.lastInteractionVirtualMs) {
			if (ownerId === 'self') continue;
			if (nowVirtual - lastSeen < DREAM_IDLE_VIRTUAL_MS) continue;
			if (this.dreamControllers.has(ownerId)) continue;
			// 水位：自上次整理以来没有新记忆就跳过（旧实现每空闲 3h 重复整理同一批，重复补写提醒）
			const watermark = Number(getKv(this.db, `dream.watermark.${ownerId}`, 0)) || 0;
			const newest = this.db.prepare(
				"SELECT MAX(id) AS m FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND status = 'active'"
			).get(ownerId)?.m ?? 0;
			if (newest <= watermark) continue;
			await this.runDream(ownerId);
			break; // 串行：每 tick 最多整理一个用户
		}
	}

	/**
	 * 给 Dream 取一段「原文」当参照（默认关，见 memory.transcriptReview）。
	 *
	 * 只读、有上限、任何失败都返回空串（退回只看记忆）—— 复核是锦上添花，
	 * 不能因为它把 Dream 卡住或者让整理失败。
	 *
	 * 时间窗取「这批记忆里最早那条到现在」，太长没意义，所以夹到 14 天。
	 * 会话名对不上就退化成**不带 channel 过滤**的取样（宁可给宽一点，也别什么都拿不到）。
	 *
	 * @param {string} ownerId 这轮整理谁的记忆
	 * @param {Array<{created_at:number}>} recent 这批记忆（用来定时间窗）
	 * @param {object|null} person 这个人（用来判断会话名）
	 * @returns {string} 拼好的原文行；没开 / 拿不到 = ''
	 */
	transcriptSample(ownerId, recent, person) {
		if (this.transcripts === null || typeof this.transcripts.sample !== 'function') return '';
		try {
			const cfg = this.getConfig()?.memory ?? {};
			if (cfg.transcriptReview !== true) return '';
			const until = Date.now();
			const earliest = Math.min(...recent.map((m) => Number(m.created_at) || until));
			// ⚠️ 往前多留一点：记忆是**整理出来的**，原文一定比它早。
			//    只从「最早那条记忆的时间」开始取，会把当时对话的原文整段漏掉
			//    （实测：记忆 created_at 和原文 at 是同一毫秒时，at >= since 直接不成立 → 一条都取不到）。
			//    留 1 小时缓冲，够覆盖「一轮聊完才整理」的间隔。
			const since = Math.max(earliest - 3600_000, until - 14 * 86_400_000);
			const limit = Math.min(200, Math.max(1, Math.floor(Number(cfg.transcriptMaxLines) || 40)));
			// 先按这个人最近的会话取；取不到就放宽到全部会话
			const channels = [person?.qq_uin ? `qq:${person.qq_uin}` : '', String(ownerId).replace(/^user:/, '')].filter((x) => x !== '');
			let rows = [];
			for (const ch of channels) {
				rows = this.transcripts.sample({ channel: ch, since, until, limit });
				if (rows.length > 0) break;
			}
			if (rows.length === 0) rows = this.transcripts.sample({ since, until, limit });
			if (rows.length === 0) return '';
			// 时间正序（取样是倒序的），太长就截断单条
			return rows
				.slice()
				.reverse()
				.map((r) => `[${new Date(r.at).toISOString().slice(5, 16).replace('T', ' ')}] ${r.self ? '我' : (person?.display_name ?? '对方')}：${String(r.content).slice(0, 200)}`)
				.join('\n');
		} catch { return ''; }
	}

	/**
	 * 3h Dream 空闲整理（审查 #05/#08；v0.6 加人物印象与过时记忆）：
	 *  - 补写漏登记的 pending、评估 relation_stage 晋升；
	 *  - 重写这个人的「印象」（称呼 / 身份 / 喜好 / 近况 / 雷区，≤150 字），主人手动改过就不动；
	 *  - 找出被新记忆推翻的旧记忆（搬家了、分手了、换工作了）：标成 outdated（不删，设置页能恢复），每次最多 3 条，
	 *    重要度 5 的不动；
	 *  - AbortController 绑定 owner_id，实时消息到达即 abort 并放弃未提交结果。
	 */
	async runDream(ownerId) {
		this.isDreamRunning = true;
		this.lastDreamRealMs = Date.now();
		const controller = new AbortController();
		this.dreamControllers.set(ownerId, controller);
		try {
			const recent = this.db.prepare(`
				SELECT id, kind, content, emotion, importance, created_at FROM memory
				WHERE character_id = 'feiyu' AND owner_id = ? AND status = 'active' AND valid_to IS NULL
				ORDER BY created_at DESC LIMIT 50
			`).all(ownerId);
			if (recent.length === 0) return;


			const person = this.db.prepare(
				'SELECT * FROM person WHERE canonical_id = ?'
			).get(ownerId.replace(/^user:/, ''));
			const profile = getProfile(this.db, ownerId);
			// 原文抽样（默认关）：拿这段时间的真实对话给模型核对记忆有没有记错。
			// 只在开了 memory.transcriptReview、且确实拿到了 transcripts 时才做——
			// 取不到（没开聊天存档 / 读失败）就照旧只看记忆，不阻塞 Dream。
			const transcriptLines = this.transcriptSample(ownerId, recent, person ?? null);

			const writeProfile = profile?.locked !== true;
			const day = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
			const name = person?.display_name ?? ownerId;

			const text = await this.callLlm(
				`整理「${name}」（${ownerId}）的近期记忆（共 ${recent.length} 条，新的在前）。只输出 JSON：` +
				`{"missedPending":[{"dueInHours":数字,"reason":"..."}],` +
				`"suggestedRelationStage":"stranger|acquaintance|friend|close|null"` +
				(writeProfile ? `,"profileFields":{${PROFILE_FIELDS.map(([k, l]) => `"${k}":"${l}（≤30 字，不知道就空）"`).join(',')}}` : '') +
				',"outdated":[{"id":旧记忆编号,"by":推翻它的新记忆编号,"reason":"..."}]}。' +
				'outdated 只填被更新的记忆明确推翻的旧事实（比如搬家、换工作、分手），拿不准就空着。' +
				(profile ? `现在的印象：${profile.text}。` : '') +
				(writeProfile && profile?.lockedFields?.length ? `（${profile.lockedFields.map((k) => PROFILE_FIELDS.find(([f]) => f === k)?.[1] ?? k).join('、')}是主人写的，不用填）` : '') +
				`近期记忆：${recent.map((m) => `#${m.id}[${day(m.created_at)}] ${m.content}`).join('；')}` +
				// 原文抽样：只有开着才带（默认关）。它只用来**核对**上面的记忆，不产生新记忆。
				(transcriptLines !== ''
					? `\n\n同一时期的部分聊天原文（用来核对上面的记忆有没有记错；原文和你记的不一样，以原文为准，把错的填进 outdated）：\n${transcriptLines}`
					: ''),
				{ signal: controller.signal, maxTokens: 900, feature: 'dream' }
			);
			if (controller.signal.aborted || text === null) return;

			const match = text.match(/\{[\s\S]*\}/);
			if (match === null) return;
			const parsed = JSON.parse(match[0]);
			if (controller.signal.aborted) return;

			const nowVirtual = this.clock.now();
			const byId = new Map(recent.map((m) => [m.id, m]));
			const outdated = [];
			this.db.exec('BEGIN');
			try {
				// 兜底补写 pending（审查 #02）
				const dupCheck = this.db.prepare(`
					SELECT 1 FROM pending WHERE character_id = 'feiyu' AND owner_id = ? AND reason = ?
					  AND status IN ('pending', 'done', 'surfaced') LIMIT 1
				`);
				for (const mp of (Array.isArray(parsed.missedPending) ? parsed.missedPending : []).slice(0, 3)) {
					const hours = Number(mp.dueInHours);
					if (!Number.isFinite(hours) || hours <= 0) continue;
					const reasonText = String(mp.reason ?? '').trim();
					if (reasonText === '' || dupCheck.get(ownerId, reasonText) !== undefined) continue; // 去重
					const dueAt = nowVirtual + hours * 3600_000;
					const last = this.db.prepare(`
						SELECT channel, channel_id FROM memory WHERE owner_id = ?
						ORDER BY created_at DESC LIMIT 1
					`).get(ownerId);
					this.db.prepare(`
						INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at, origin)
						VALUES ('feiyu', ?, ?, ?, ?, ?, 'pending', ?, 'dream')
					`).run(ownerId, last?.channel ?? 'qq-private', last?.channel_id ?? '', dueAt,
						reasonText, nowVirtual);
					// 新登记的待办要重新挂闹钟，否则要等下一轮 tick 才发现它（#80）
					this.armPendingAlarm();
				}
				// 被推翻的旧记忆：只认这批里有的编号，新的必须比旧的晚
				for (const o of (Array.isArray(parsed.outdated) ? parsed.outdated : [])) {
					if (outdated.length >= 3) break;
					const old = byId.get(Number(o?.id));
					const by = byId.get(Number(o?.by));
					if (!old || !by || old.id === by.id || by.created_at < old.created_at || (old.importance ?? 1) >= 5) continue;
					this.db.prepare("UPDATE memory SET status = 'outdated', valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND status = 'active'")
						.run(nowVirtual, by.id, nowVirtual, old.id);
					this.db.prepare('DELETE FROM vec WHERE memory_id = ?').run(old.id);
					outdated.push({ id: old.id, by: by.id, reason: String(o.reason ?? '').slice(0, 80), content: old.content.slice(0, 80) });
				}
				// relation_stage 演进（审查 #05）：Dream 建议 + 互动计数/情绪均值兜底
				if (person !== undefined) {
					const stageRank = { stranger: 0, acquaintance: 1, friend: 2, close: 3 };
					let next = parsed.suggestedRelationStage;
					if (next === null || !(next in stageRank)) {
						const avgEmotion = recent.reduce((s, m) => s + (m.emotion ?? 0), 0) / recent.length;
						const count = person.interaction_count ?? 0;
						if (count >= 50 && avgEmotion >= 0.5) next = 'friend';
						else if (count >= 10 && avgEmotion >= 0) next = 'acquaintance';
					}
					if (next !== null && next in stageRank && stageRank[next] > stageRank[person.relation_stage] && Number(person.stage_locked ?? 0) !== 1) {
						// 好感跟着抬到新阶段的起点，免得下次结算又降回去
						this.db.prepare(
							'UPDATE person SET relation_stage = ?, affinity = MAX(COALESCE(affinity, 0), ?), affinity_at = ? WHERE canonical_id = ?'
						).run(next, stageBase(next), nowVirtual, person.canonical_id);
					}
				}
				this.db.exec('COMMIT');
			} catch (error) {
				this.db.exec('ROLLBACK');
				throw error;
			}
			// 印象：新格式按栏合并（主人写的栏不动）；老格式（一段话）照旧
			let profileText = '';
			if (writeProfile && parsed.profileFields && typeof parsed.profileFields === 'object') {
				const before = getProfile(this.db, ownerId)?.text ?? '';
				const merged = mergeProfileFields(this.db, ownerId, parsed.profileFields, 'dream');
				if (merged && merged.text !== before) profileText = merged.text;
			} else if (typeof parsed.profile === 'string') {
				profileText = parsed.profile.trim();
				if (writeProfile && profileText !== '') setProfile(this.db, ownerId, { text: profileText, by: 'dream', updatedAt: Date.now() });
			}
			// 久不联系淡下来的好感落账（可能降一级）；生日临近就登记祝福
			if (person !== undefined) {
				try { settleAffinity(this.db, person.canonical_id, 0, nowVirtual); } catch { /* 老库没有列 */ }
				try { ensureBirthdayPending(this.db, ownerId, name, nowVirtual); } catch { /* 不要紧 */ }
			}
			if (outdated.length > 0 || (writeProfile && profileText !== '')) {
				const logs = getKv(this.db, 'dream.log', []) ?? [];
				// transcriptLines：这次带了几行原文（0 = 没带）。
				// 没有这个数，从外面根本看不出「对照原文」到底生效了没有 ——
				// 加了开关却没观测点，是上次表情包那轮踩过的坑。
				logs.unshift({
					at: Date.now(), ownerId, name, outdated,
					profile: writeProfile && profileText !== '',
					transcriptLines: transcriptLines === '' ? 0 : transcriptLines.split('\n').length,
				});
				setKv(this.db, 'dream.log', logs.slice(0, 50));
			}
			// 整理完成：推进水位 + 重置空闲计时
			setKv(this.db, `dream.watermark.${ownerId}`, Math.max(...recent.map((m) => m.id)));
			this.lastInteractionVirtualMs.set(ownerId, nowVirtual);
		} catch (error) {
			this.log('error', `[fish-soul] Dream(${ownerId}) 异常：${String(error instanceof Error ? error.message : error)}`);
		} finally {
			this.dreamControllers.delete(ownerId);
			this.isDreamRunning = false;
		}
	}

	/** 此刻的状态（gateway 判断"睡着了就别插话"用）：'sleeping' | 'busy' | 'free' | … | null。 */
	availability() {
		try { return this.stateSnapshot().today.currentSlot?.availability ?? null; } catch { return null; }
	}

	/** 路由 /life/state 的状态快照。 */
	stateSnapshot() {
		const parts = this.clock.getRoleDateParts();
		const day = this.db.prepare(
			"SELECT * FROM day WHERE character_id = 'feiyu' AND date = ?"
		).get(parts.dateStr);
		let plan = null;
		try { plan = day !== undefined ? JSON.parse(day.plan_json) : null; } catch { plan = null; }
		const slot = day !== undefined ? this.currentSlot(day, parts) : null;
		return {
			clock: {
				virtualNowMs: this.clock.now(),
				virtualIsoLocal: `${parts.dateStr} ${pad2(parts.hour)}:${pad2(parts.minute)}:00`,
				virtualDate: parts.dateStr,
				timeScale: this.clock.scale,
				isAccelerated: this.clock.scale > 1,
				realCooldownRemainingSec: Math.max(0, Math.ceil((PROACTIVE_REAL_COOLDOWN_MS - (Date.now() - (this.lastProactiveReal.get('qq') ?? 0))) / 1000))
			},
			today: {
				characterId: 'feiyu',
				date: parts.dateStr,
				dailyMoodTone: plan?.dailyMoodTone ?? null,
				currentSlot: slot ?? null,
				scheduleSummary: plan?.schedule ?? [],
				proactiveCount: day?.proactive_count ?? 0,
				dailyMaxCount: this.dailyMax(),
				lastProactiveAt: day?.last_proactive_at ?? null,
				locks: { isTickRunning: this.isTickRunning, isDreamRunning: this.isDreamRunning }
			},
			proactiveConfig: this.getConfig().proactive ?? {}
		};
	}
}
