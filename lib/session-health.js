/**
 * 登录态「还能活多久」——从 cookie 里读，不用等它坏掉才知道。
 *
 * 为什么要有这个：
 *   以前唯一的信号是「请求开始失败」。抖音这边掉登录的表现跟「签名错了」「风控了」
 *   一模一样（都是 status_code 8 / 空 body），排查时根本分不清是哪一种。
 *   `sid_guard` 这个 cookie 自带签发时间和有效期，看一眼就知道还剩多久。
 *
 * 格式（实测，抖音）：
 *   sid_guard = <session>|<签发秒>|<有效期秒>|<GMT 字符串>
 *   例：bfc8e3...%7C1794133354%7C5184001%7CThu,+07-Jan-2027+10:22:35+GMT
 *   值是 URL 编码的，要 decodeURIComponent 之后再按 `|` 拆。
 *
 * 只读：这里只解析字符串，不碰网络、不改 cookie。
 */

/** 把秒数说成人话：还剩 3 天 / 12 小时 / 8 分钟。 */
export function humanizeSeconds(sec) {
	const s = Math.floor(Number(sec));
	if (!Number.isFinite(s)) return '';
	if (s <= 0) return '已过期';
	const day = Math.floor(s / 86400);
	const hour = Math.floor((s % 86400) / 3600);
	const min = Math.floor((s % 3600) / 60);
	if (day > 0) return `${day} 天${hour > 0 ? ` ${hour} 小时` : ''}`;
	if (hour > 0) return `${hour} 小时${min > 0 ? ` ${min} 分钟` : ''}`;
	return `${Math.max(1, min)} 分钟`;
}

/**
 * 从 sid_guard 的值算出还剩多少秒。
 * @param {string} raw cookie 原始值（可能是 URL 编码的）
 * @returns {{remainingSec: number, expiresAt: number, issuedAt: number, ttlSec: number} | null}
 *          解不出来返回 null（格式变了、或者根本不是 sid_guard）
 */
export function parseSidGuard(raw) {
	if (raw === undefined || raw === null || raw === '') return null;
	let text = String(raw);
	try { text = decodeURIComponent(text); } catch { /* 编码坏了就按原样拆 */ }
	const parts = text.split('|');
	if (parts.length < 3) return null;
	const issuedAt = Number(parts[1]);
	const ttlSec = Number(parts[2]);
	if (!Number.isFinite(issuedAt) || !Number.isFinite(ttlSec) || issuedAt <= 0 || ttlSec <= 0) return null;
	const expiresAt = issuedAt + ttlSec;
	return { remainingSec: expiresAt - Math.floor(Date.now() / 1000), expiresAt, issuedAt, ttlSec };
}

/**
 * 从一份 cookie 集合里找 sid_guard 并解析。
 * @param {Record<string, string>|Array<{name:string,value:string}>} cookies
 *       两种形态都吃：对象（插件自己存的 `{name: value}`）或 CDP 的数组。
 * @returns {{remainingSec: number, expiresAt: number} | null}
 */
export function sessionHealth(cookies) {
	if (!cookies) return null;
	let raw;
	if (Array.isArray(cookies)) {
		const hit = cookies.find((c) => c && c.name === 'sid_guard');
		raw = hit?.value;
	} else if (typeof cookies === 'object') {
		raw = cookies.sid_guard ?? cookies.SID_GUARD;
	}
	const parsed = parseSidGuard(raw);
	if (parsed === null) return null;
	return { remainingSec: parsed.remainingSec, expiresAt: parsed.expiresAt };
}

/**
 * 给诊断页用的一句话。
 * @param {{remainingSec: number}|null} health sessionHealth() 的结果
 * @param {{warnHours?: number}} [opts] 少于这么多小时就标黄（默认 24）
 * @returns {{ok: boolean, detail: string}}
 */
export function describeHealth(health, { warnHours = 24 } = {}) {
	if (health === null) return { ok: true, detail: '读不到过期时间（cookie 里没有 sid_guard）' };
	const { remainingSec } = health;
	if (remainingSec <= 0) return { ok: false, detail: '登录已过期，需要重新扫码' };
	const hours = remainingSec / 3600;
	const text = `还剩 ${humanizeSeconds(remainingSec)}`;
	if (hours < warnHours) return { ok: false, detail: `${text}（不足 ${warnHours} 小时，快过期了）` };
	return { ok: true, detail: text };
}
