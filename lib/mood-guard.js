/**
 * mood-guard.js —— 情绪状态机的一道闸 + 提示词护栏（PR3）。
 *
 * 借鉴 anima-brain 的 emotion.py（常量 + 公式都在代码里，真读过的）：
 *   每轴每天的总绝对位移上限 0.12、档位滞回 0.035 ——
 *   挡的都是「同一个话题反复刷让数值滚雪球」和「卡在档位边界反复横跳」。
 *
 * 我们的 mood 是离散标签 + intensity 1~3 + 12h 半衰，不是 PAD 坐标，
 * 所以两个常数不能直接搬数值，只能搬**结构**：
 *
 *   我们只保留**一条**：每日翻转次数上限 —— 一天最多换 4 次标签。
 *   挡的是「开心→委屈→开心→委屈」这种横跳，不是「情绪变强」。
 *
 *   🔴 为什么没有「按强度滞后」那道：既有契约（smoke-v09）要求
 *      同一个 now 下 开心(满格) → 委屈 必须能翻，而且翻完 markMoodSaid
 *      要重新返回 true。那是「模型判断了就是判断了」，是她的主体性。
 *      第一版按 anima-brain 的强度滞后带写（新强度 > 旧残温 × 1.5），
 *      直接打挂那条契约 —— 而且不是测试过时，是我理解的边界错了。
 *
 *   ② 每日翻转次数上限：一天最多换 4 次标签。
 *      挡的是「开心→委屈→开心→委屈」这种横跳，不是「情绪变强」——
 *      同标签叠加（余温加深）是既有契约，不能被这道闸压。
 *
 * 这两道都是**写入侧**的闸，读侧 getMood 不变（衰减照旧）。
 */
export const MOOD_FLIPS_PER_DAY = 4;

/** UTC+8 的日期串（和日记 / 周记同一套时区约定）。 */
export function moodDayOf(ms) {
	return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 判「这次还能不能换标签」的第二个闸：**一天最多翻几次**。
 *
 * 🔴 这里不能写成「每日位移上限」。既有契约（smoke-persona）要求
 *    同一种情绪又来会叠加 1 → 3 → 3 —— 那是「余温加深」，是既有设计，
 *    拿位移上限去压它直接打挂那条测试。
 *
 * 真正要挡的是**反复翻转**（开心→委屈→开心→委屈），不是「情绪变强」。
 * 所以闸② 数的是「今天换了几次标签」，不是「涨了几格强度」。
 *
 * @param {{day:string, flips:number}|null} today 当天的翻转记录
 * @param {number} now 当前虚拟时间
 * @returns {{ok:true, day:string, flips:number}|{ok:false, day:string, flips:number, reason:string}}
 */
export function canFlipToday(today, now) {
	const day = moodDayOf(now);
	const flips = today?.day === day ? Number(today.flips ?? 0) : 0;
	if (flips >= MOOD_FLIPS_PER_DAY) {
		return { ok: false, day, flips, reason: `今天已经翻过 ${flips} 次了，上限 ${MOOD_FLIPS_PER_DAY}` };
	}
	return { ok: true, day, flips };
}

/**
 * 提示词护栏（借鉴 anima-brain 的 emotion.py::note）。
 *
 * 原文：「This is fictional character state, not evidence about the user's feelings.
 *        Character mood must never make the response dismissive during user vulnerability.」
 *
 * 为什么我们的提示词里需要它：这个项目踩过 #75 / #76 两次「虚构内容顺着
 * 提示词变假事实」—— 状态注记不写清「这是你自己的状态，不是对方的证据」，
 * 模型就会把「我现在在生气」推成「他惹我生气了」这个事实，而它会进记忆。
 *
 * 第二句对应真实风险：她在生气时收到对方说「我最近不太好」，
 * 绝不能回「我现在心情不好，你先别烦我」。
 */
export const MOOD_STATE_GUARD = '（这些只是你自己的状态，不是对方情绪的证据，别据此推断对方；对方在说难受、委屈、撑不住这类脆弱的话时，不许敷衍，也不许拿你自己的心情当理由）';
