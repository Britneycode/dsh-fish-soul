/**
 * VirtualClock —— 虚拟业务时钟与真实物理时钟严格隔离（设计方案 §10.5，审查 #03）。
 *
 * 绑定规范：
 *  - 虚拟钟 now()：memory/person/day/pending 全部时间戳、艾宾浩斯衰减 Δt、
 *    Dream 空闲判定、pending.due_at 比对。
 *  - 物理钟 Date.now()：embedding 800ms 超时、重建 32 条/分钟限速、
 *    主动消息 >=15s 风控冷却——外部世界永远用真实毫秒。
 *  - 15 分钟 tick 等虚拟间隔一律经 toRealIntervalMs() 换算成真实定时器延迟，
 *    并设 1000ms 物理下限，防止 FISH_TIME_SCALE=1000 时打爆事件循环。
 */
export class VirtualClock {
	/** @param {number} scale FISH_TIME_SCALE，>=1 @param {number} startVirtualMs 虚拟起点，默认当前真实时间 */
	constructor(scale = Number(process.env.FISH_TIME_SCALE || 1), startVirtualMs = Date.now()) {
		this.scale = Math.max(1, Number.isFinite(scale) ? scale : 1);
		this.bootRealMs = Date.now();
		// 单调性：虚拟钟永不早于真实时间，也永不早于上次持久化的快照（重启不倒退）
		this.bootVirtualMs = Math.max(Date.now(), Number.isFinite(startVirtualMs) ? startVirtualMs : 0);
	}

	/** 虚拟当前时间戳（ms）。 */
	now() {
		return Math.floor(this.bootVirtualMs + (Date.now() - this.bootRealMs) * this.scale);
	}

	/** 角色时区（Asia/Shanghai，UTC+8）下的日期串与时刻。 */
	getRoleDateParts(atMs = this.now()) {
		const d = new Date(atMs + 8 * 3600_000);
		const iso = d.toISOString();
		return { dateStr: iso.slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
	}

	/** 虚拟间隔 → 真实定时器延迟（含 1000ms 物理下限）。 */
	toRealIntervalMs(virtualMs, minRealMs = 1000) {
		return Math.max(minRealMs, Math.floor(virtualMs / this.scale));
	}

	/** 两个虚拟时间戳之间相差的虚拟天数（艾宾浩斯衰减用）。 */
	virtualDaysBetween(laterMs, earlierMs) {
		return (laterMs - earlierMs) / 86_400_000;
	}
}
