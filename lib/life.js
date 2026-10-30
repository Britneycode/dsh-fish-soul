/**
 * life.js —— 自走层：15m tick、每日日程、主动投递、3h Dream 整理（设计方案 §10，审查 #02/#03/#08）。
 *
 * 时钟绑定（§10.5）：
 *  - day/pending 时间戳、空闲判定、due_at 比对 → 虚拟钟；
 *  - 主动消息 >=15s 风控冷却、Dream 最小间隔 30s（加速模式）、tick 定时器换算 → 物理钟。
 *
 * 投递安全（审查 #01）：只发 config.proactive.targets 白名单内的
 * masterPrivateChannelId / selfGroupChannelIds，严禁凭 owner_id 盲发。
 */
import { VirtualClock } from './clock.js';

const TICK_VIRTUAL_MS = 15 * 60_000;
const DREAM_IDLE_VIRTUAL_MS = 3 * 3600_000;
const DREAM_MIN_REAL_GAP_MS = 30_000;
const PROACTIVE_REAL_COOLDOWN_MS = 15_000;

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {VirtualClock} deps.clock
 * @param {() => object} deps.getConfig 读取完整配置（含 proactive 白名单）
 * @param {(prompt: string) => Promise<string|null>} deps.callLlm 日程/Dream 归纳用的 LLM 调用（fail-open 返回 null）
 * @param {(channelId: string, text: string) => Promise<boolean>} deps.deliver 主动消息投递（qq-bridge 适配层）
 * @param {(level: string, msg: string) => void} [deps.log]
 */
export class LifeEngine {
	constructor({ db, clock, getConfig, callLlm, deliver, log }) {
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
		this.lastProactiveRealMs = 0;
		this.lastDreamRealMs = 0;
		this.lastInteractionVirtualMs = new Map(); // owner_id → 虚拟时间
		this.timer = null;
	}

	start() {
		if (this.timer !== null) return;
		const realDelay = this.clock.toRealIntervalMs(TICK_VIRTUAL_MS, 1000);
		this.timer = setInterval(() => { void this.tick(); }, realDelay);
		this.timer.unref?.();
	}

	stop() {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		for (const c of this.dreamControllers.values()) c.abort();
		this.dreamControllers.clear();
	}

	/** 实时消息到达（pre-step 调用）：更新互动时间，并中断该用户的 Dream（审查 #08）。 */
	noteInteraction(ownerId) {
		this.lastInteractionVirtualMs.set(ownerId, this.clock.now());
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

			// 1. 每日日程：当天无记录则调 LLM 生成一次
			let day = this.db.prepare(
				'SELECT * FROM day WHERE character_id = ? AND date = ?'
			).get(characterId, parts.dateStr);
			if (day === undefined) {
				const plan = await this.generateDayPlan(parts.dateStr);
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
		} catch (error) {
			this.log('error', `[fish-soul] tick 异常：${String(error instanceof Error ? error.message : error)}`);
		} finally {
			this.isTickRunning = false;
		}
	}

	/** 每日日程 LLM 生成；失败时给保底默认（fail-open，不阻塞 tick）。 */
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
				`为人格 feiyu 生成 ${dateStr} 的一天作息。只输出 JSON：` +
				`{"dailyMoodTone":"元气|慵懒|平静","schedule":[{"range":"HH:MM - HH:MM","activity":"...","availability":"busy|idle|sleeping"},...4 段]}`
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

	/** 当前虚拟时刻落在 plan_json 的哪个时段。 */
	currentSlot(day, parts) {
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

	/** 主动开口判定与投递（硬约束：配额 <2、活跃时段、15s 物理冷却、白名单）。 */
	async maybeProactive(day, parts) {
		const cfg = this.getConfig();
		const p = cfg.proactive ?? {};
		if (p.enabled === false) return;

		// 硬约束 1：每日配额（day.proactive_count 持久化，重启不丢，审查 #02）
		const dailyMax = Math.min(2, p.dailyMaxCount ?? 2);
		if ((day.proactive_count ?? 0) >= dailyMax) return;

		// 硬约束 2：活跃时段 08:00–24:00（虚拟钟）
		const [activeStart, activeEnd] = p.activeHours ?? [8, 24];
		if (parts.hour < activeStart || parts.hour >= activeEnd) return;

		// 硬约束 3：物理钟 15s 风控冷却（即使虚拟已跨天，审查 #03）
		if (Date.now() - this.lastProactiveRealMs < PROACTIVE_REAL_COOLDOWN_MS) return;

		// 事件驱动优先：到期 pending（虚拟钟比对 due_at）
		const nowVirtual = this.clock.now();
		const due = this.db.prepare(`
			SELECT * FROM pending
			WHERE character_id = 'feiyu' AND status = 'pending' AND due_at <= ?
			ORDER BY due_at ASC LIMIT 1
		`).get(nowVirtual);

		let target = null;
		let reason = null;
		let pendingId = null;
		if (due !== undefined && this.isWhitelisted(due.channel_id, p)) {
			target = due.channel_id;
			reason = due.reason;
			pendingId = due.id;
		} else {
			// 时间驱动兜底：处在 idle 时段且主人距上次互动 > idleTriggerHours（虚拟钟）
			const slot = this.currentSlot(day, parts);
			if (slot?.availability !== 'idle') return;
			const masterOwner = p.targets?.masterCanonicalId ?? 'user:master';
			const lastSeen = this.lastInteractionVirtualMs.get(masterOwner) ?? 0;
			const idleHours = p.idleTriggerHours ?? 6;
			if (nowVirtual - lastSeen < idleHours * 3600_000) return;
			target = p.targets?.masterPrivateChannelId ?? null;
			reason = '好久没说话了，随便聊聊';
			if (target === null || !this.isWhitelisted(target, p)) return;
		}

		// 生成一句话并投递（LLM 失败则用 reason 直发，fail-open 不卡 tick）
		const text = (await this.callLlm(
			`你是 feiyu。主动开口理由：${reason}。用她的语气写一条不超过 60 字的 QQ 消息，只输出消息正文。`
		)) ?? reason;

		const ok = await this.deliver(target, text);
		// 投递结果落库（无论成败都计物理冷却，防止加速模式连发封号）
		this.lastProactiveRealMs = Date.now();
		if (ok) {
			this.db.prepare(`
				UPDATE day SET proactive_count = proactive_count + 1, last_proactive_at = ?
				WHERE character_id = 'feiyu' AND date = ?
			`).run(nowVirtual, day.date);
			if (pendingId !== null) {
				this.db.prepare("UPDATE pending SET status = 'done' WHERE id = ?").run(pendingId);
			}
			this.log('info', `[fish-soul] 主动消息已投递至 ${target}（今日第 ${(day.proactive_count ?? 0) + 1} 条）`);
		} else if (pendingId !== null) {
			this.db.prepare("UPDATE pending SET status = 'failed' WHERE id = ?").run(pendingId);
		}
	}

	/** 白名单校验（审查 #01）：仅 masterPrivateChannelId 与 selfGroupChannelIds。 */
	isWhitelisted(channelId, proactiveCfg) {
		const t = proactiveCfg.targets ?? {};
		if (channelId === t.masterPrivateChannelId) return true;
		return Array.isArray(t.selfGroupChannelIds) && t.selfGroupChannelIds.includes(channelId);
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
			await this.runDream(ownerId);
			break; // 串行：每 tick 最多整理一个用户
		}
	}

	/**
	 * 3h Dream 空闲整理（审查 #05/#08）：
	 *  - 归纳该用户近期记忆、补写漏登记的 pending、评估 relation_stage 晋升；
	 *  - AbortController 绑定 owner_id，实时消息到达即 abort 并放弃未提交结果。
	 */
	async runDream(ownerId) {
		this.isDreamRunning = true;
		this.lastDreamRealMs = Date.now();
		const controller = new AbortController();
		this.dreamControllers.set(ownerId, controller);
		try {
			const recent = this.db.prepare(`
				SELECT id, kind, content, emotion, created_at FROM memory
				WHERE character_id = 'feiyu' AND owner_id = ? AND status = 'active' AND valid_to IS NULL
				ORDER BY created_at DESC LIMIT 50
			`).all(ownerId);
			if (recent.length === 0) return;

			const person = this.db.prepare(
				'SELECT * FROM person WHERE canonical_id = ?'
			).get(ownerId.replace(/^user:/, ''));

			const text = await this.callLlm(
				`整理用户 ${ownerId} 的近期记忆（共 ${recent.length} 条）。只输出 JSON：` +
				`{"missedPending":[{"dueInHours":数字,"reason":"..."}],` +
				`"suggestedRelationStage":"stranger|acquaintance|friend|close|null"}。` +
				`近期记忆：${recent.map((m) => `#${m.id} ${m.content}`).join('；')}`
			);
			if (controller.signal.aborted || text === null) return;

			const match = text.match(/\{[\s\S]*\}/);
			if (match === null) return;
			const parsed = JSON.parse(match[0]);
			if (controller.signal.aborted) return;

			const nowVirtual = this.clock.now();
			this.db.exec('BEGIN');
			try {
				// 兜底补写 pending（审查 #02）
				for (const mp of parsed.missedPending ?? []) {
					const dueAt = nowVirtual + Number(mp.dueInHours ?? 1) * 3600_000;
					const last = this.db.prepare(`
						SELECT channel, channel_id FROM memory WHERE owner_id = ?
						ORDER BY created_at DESC LIMIT 1
					`).get(ownerId);
					this.db.prepare(`
						INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at)
						VALUES ('feiyu', ?, ?, ?, ?, ?, 'pending', ?)
					`).run(ownerId, last?.channel ?? 'qq-private', last?.channel_id ?? '', dueAt,
						String(mp.reason ?? 'Dream 补写的约定'), nowVirtual);
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
					if (next !== null && next in stageRank && stageRank[next] > stageRank[person.relation_stage]) {
						this.db.prepare(
							'UPDATE person SET relation_stage = ? WHERE canonical_id = ?'
						).run(next, person.canonical_id);
					}
				}
				this.db.exec('COMMIT');
			} catch (error) {
				this.db.exec('ROLLBACK');
				throw error;
			}
			// 整理完成：重置该用户空闲计时，避免每 tick 重复 Dream
			this.lastInteractionVirtualMs.set(ownerId, nowVirtual);
		} catch (error) {
			this.log('error', `[fish-soul] Dream(${ownerId}) 异常：${String(error instanceof Error ? error.message : error)}`);
		} finally {
			this.dreamControllers.delete(ownerId);
			this.isDreamRunning = false;
		}
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
				virtualIsoLocal: `${parts.dateStr} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:00`,
				virtualDate: parts.dateStr,
				timeScale: this.clock.scale,
				isAccelerated: this.clock.scale > 1,
				realCooldownRemainingSec: Math.max(0, Math.ceil((PROACTIVE_REAL_COOLDOWN_MS - (Date.now() - this.lastProactiveRealMs)) / 1000))
			},
			today: {
				characterId: 'feiyu',
				date: parts.dateStr,
				dailyMoodTone: plan?.dailyMoodTone ?? null,
				currentSlot: slot ?? null,
				scheduleSummary: plan?.schedule ?? [],
				proactiveCount: day?.proactive_count ?? 0,
				dailyMaxCount: Math.min(2, this.getConfig().proactive?.dailyMaxCount ?? 2),
				lastProactiveAt: day?.last_proactive_at ?? null,
				locks: { isTickRunning: this.isTickRunning, isDreamRunning: this.isDreamRunning }
			},
			proactiveConfig: this.getConfig().proactive ?? {}
		};
	}
}
