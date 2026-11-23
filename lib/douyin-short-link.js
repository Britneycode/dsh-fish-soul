// 抖音短链 → 作品 ID。
//
// 为什么单独抽出来：`v.douyin.com/xxx` 只有跳转一次才知道是哪个作品，
// 而这件事在 `DouyinBrowser`（刷视频那条路）和 `DouyinAdapter`（发消息那条路）
// 都要用。放浏览器里的话，发消息那条路就得凭空依赖一个浏览器实例。
//
// ⚠️ 拿不到就返回空串，**不猜**：猜错就是发错视频的卡片，比不发严重。

import { isIP } from 'node:net';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** 跳转地址里带的作品 ID（`/video/<数字>`、`/note/<数字>` 或 `?modal_id=`/`aweme_id=`/`vid=`）。 */
const ID_IN_URL = /(?:(?:video|note)\/|[?&](?:modal_id|aweme_id|vid)=)(\d{8,20})(?!\d)/;

/** 仅放行 https 协议、无凭据、标准 443 端口的抖音官网域，拦截内网/IP 字面量 SSRF 跳转。 */
function isAllowedDouyinUrl(raw) {
	let u;
	try { u = new URL(raw); } catch { return false; }
	if (u.protocol !== 'https:') return false;
	if (u.username !== '' || u.password !== '') return false;
	if (u.port !== '' && u.port !== '443') return false;
	const host = u.hostname.toLowerCase().replace(/\.$/, '');
	if (host === '' || isIP(host.replace(/^\[|\]$/g, '')) !== 0) return false;
	return host === 'douyin.com' || host.endsWith('.douyin.com') || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com');
}

/**
 * 跟随 `v.douyin.com` 短链，拿作品 ID。
 *
 * @param {string} url 短链（也接受完整 `douyin.com/video/<id>` —— 那种直接返回 id）
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} 作品 ID；拿不到返回 ''
 */
export async function resolveDouyinShortLink(url, { fetchImpl, timeoutMs = 5000 } = {}) {
	const start = String(url ?? '').trim();
	if (start === '' || !isAllowedDouyinUrl(start)) return '';
	// 已经是完整链接：不用发请求
	const direct = ID_IN_URL.exec(start);
	if (direct !== null) return direct[1];

	const doFetch = fetchImpl ?? ((...a) => fetch(...a));
	let cur = start;
	for (let i = 0; i < 3; i++) {
		try {
			const res = await doFetch(cur, {
				redirect: 'manual',
				headers: { 'User-Agent': MOBILE_UA },
				signal: AbortSignal.timeout(timeoutMs),
			});
			const loc = res?.headers?.get?.('location') ?? '';
			if (loc === '') return '';
			const next = new URL(loc, cur).href;
			if (!isAllowedDouyinUrl(next)) return '';
			const hit = ID_IN_URL.exec(next);
			if (hit !== null) return hit[1];
			cur = next;
		} catch {
			// 超时 / 断网 / 地址不合法：一律当「拿不到」，不猜
			return '';
		}
	}
	return '';
}
