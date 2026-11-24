// 「此刻状态」这一行怎么拼 —— 抽成纯函数才测得动。
//
// 为什么要带星期和「距上次说话多久」：
//   原来这行只有「虚拟时间 2026-11-19 18:11」，她能读出几点，但读不出「周几」和
//   「上一条是 5 分钟前还是 3 天前」。前者让「周末」「周一上班」这类话题无从接起，
//   后者让「好久不见」永远不出现 —— 两处都是上下文里从来没有过的信息。
//
// 参考过的做法（2026-11-19 调研）：
//   - SillyTavern：`{{weekday}}` + `{{idleDuration}}`（明确是「距最后一条**用户**消息」）
//   - AstrBot：「现实世界时间感知」附带日期、时间、时区、星期
//   - MaiBot：只给 `当前时间：YYYY-MM-DD HH:MM:SS`
//   ⇒ 星期取前两家的做法，idleDuration 取 SillyTavern 的语义，MaiBot 那套我们已有。
//
// 时间戳一律放在瞬态块里，**不进 system 段** —— 秒级时间戳进稳定前缀会让每一轮
// 缓存全部失效（DESIGN-fish-soul.md 的注入位置约束也是同一条）。

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 同一段对话里报「刚才」是噪音，短于这个数整段不写。经验阈值，跟主动开口的护栏无关。 */
export const IDLE_SILENT_MS = 30 * 60_000;
/** 再久也只是「很久没说话」，具体几天没有信息量。 */
const IDLE_CAP_DAYS = 7;

/** 角色时区（UTC+8）下的星期名。只认 YYYY-MM-DD；认不出返回空串（不猜）。 */
export function weekdayOf(dateStr) {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr ?? ''));
	if (m === null) return '';
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
	return WEEKDAY[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] ?? '';
}

/**
 * 「距上次说话多久」的人话。null = 不值得说（同一个话头里，说了是噪音）。
 */
export function idleLabel(ms) {
	if (!Number.isFinite(ms) || ms < IDLE_SILENT_MS) return null;
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min} 分钟`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour} 小时`;
	const day = Math.floor(hour / 24);
	if (day >= IDLE_CAP_DAYS) return '很久';
	return `${day} 天`;
}

/**
 * 拼「此刻状态」那一行。
 *
 * @param {object} p
 * @param {string} p.virtualIsoLocal 角色时区的「YYYY-MM-DD HH:MM:SS」
 * @param {string} [p.weekday] 星期名，空就不写
 * @param {number|null} [p.idleMs] 距对方上次说话的真实毫秒，null/过短就不写
 * @param {string|null} [p.tone] 当日基调
 * @param {object|null} [p.slot] 当前时段 {range, availability, activity}
 * @param {boolean} [p.scheduleEnabled] 日程开关（#196）；false 时基调和日程整段不注入
 */
export function stateLineText({ virtualIsoLocal, weekday = '', idleMs = null, tone = null, slot = null, scheduleEnabled = true }) {
	const parts = [`虚拟时间 ${virtualIsoLocal}${weekday ? `（${weekday}）` : ''}`];
	const idle = idleLabel(idleMs);
	if (idle !== null) parts.push(`距上次说话 ${idle}`);
	if (scheduleEnabled) {
		parts.push(`基调 ${tone ?? '未生成'}`);
		if (slot) parts.push(`时段 ${slot.range ?? ''}（${slot.availability ?? '?'}）她今天大概这么打算：${slot.activity ?? '未知'}`);
		else parts.push('今天没排日程');
	}
	return `[此刻状态] ${parts.join('；')}`;
}
