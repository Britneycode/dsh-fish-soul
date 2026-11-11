/**
 * douyin-share.mjs —— 原生视频卡片分享（抖音网页版「分享给朋友」面板）
 *
 * 为什么要独立标签页
 * ------------------
 * 主标签页是私信面板（轮询在用）。分享要跳到视频详情页 —— 共用会把轮询搞挂。
 * ⇒ 另开一个标签页干完就关，主标签页一点没动。
 *
 * 三个踩出来的坑（别改）
 * ----------------------
 * 1. 分享按钮**没有 onClick**，React 只挂了 onMouseEnter / onMouseLeave
 *    ⇒ 点它什么都不会发生，必须**悬停**才弹「分享给朋友」面板。
 * 2. 面板里每个按钮都叫「分享」，按名字找会发错人
 *    ⇒ 只认按钮上的 `data-userid`（平台的数字 uid）；缺失 / 重复 / 被遮挡
 *      / 不在视口，一律**不发送**。
 * 3. 「分享成功」的 toast **不算证据**
 *    ⇒ 必须回到目标私信，读原生卡片气泡里平台自己的 `parsedContent.itemId`，
 *      和要分享的作品 ID 对上才算数。
 */
import { ensurePanel, enterChat } from './douyin-panel.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expr = (fn, arg) => `(${fn.toString()})(${JSON.stringify(arg)})`;

/**
 * 在页面里执行。只认平台的数字 uid，不读大容器里的第一个「分享」。
 * @param {{uid: string}} p
 * @returns {{ok: boolean, reason?: string, uid?: string, x?: number, y?: number, text?: string}}
 */
export function recipientFromPage({ uid }) {
	const visible = (el) => {
		const r = el.getBoundingClientRect();
		const s = getComputedStyle(el);
		return r.width > 15 && r.height > 15 && s.display !== 'none' && s.visibility !== 'hidden';
	};
	const hits = [...document.querySelectorAll('[data-userid]')]
		.filter((el) => el.getAttribute('data-userid') === uid && visible(el))
		.filter((el) => ['分享', '已分享', '已发送'].includes((el.innerText || '').trim()));
	if (hits.length !== 1) return { ok: false, reason: hits.length ? 'ambiguous' : 'not_found' };
	const el = hits[0];
	el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
	const r = el.getBoundingClientRect();
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { ok: false, reason: 'outside_viewport' };
	const at = document.elementFromPoint(x, y);
	if (!at || (at !== el && !el.contains(at))) return { ok: false, reason: 'covered' };
	return { ok: true, uid, x, y, text: (el.innerText || '').trim() };
}

/**
 * 只取原生分享气泡里平台消息的 itemId。
 * 上传文件、图片和文字网址都不算 —— 那些不是「平台自己的原生卡片」。
 * @returns {Array<{videoId: string, fromMe: boolean, native: boolean}>}
 */
export function nativeCardsFromPage() {
	const out = [];
	for (const card of document.querySelectorAll('[class*="MessageItemShareAwemecontainer"]')) {
		const found = new Map();
		const walk = (value, depth, seen) => {
			if (!value || typeof value !== 'object' || depth > 7 || seen.has(value)) return;
			seen.add(value);
			const message = value.message;
			if (message && typeof message === 'object') {
				const id = String(message.parsedContent?.itemId || message.parsedContent?.aweme_id || '');
				if (/^\d{8,20}$/.test(id) && message.isMyMessage === true) found.set(id, true);
			}
			for (const [key, child] of Object.entries(value)) {
				if (key === '_owner' || key === '_store' || key === 'ref' || key === 'message') continue;
				if (typeof child === 'object') walk(child, depth + 1, seen);
			}
		};
		let node = card;
		for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
			for (const key of Object.keys(node).filter((k) => k.startsWith('__reactProps'))) walk(node[key], 0, new Set());
		}
		for (const id of found.keys()) out.push({ videoId: id, fromMe: true, native: true });
	}
	return out;
}

/** 在指定标签页里执行一段 JS（main 的 browser.eval 只认主标签页，这里要换 session）。 */
async function evalAt(browser, sid, expression) {
	const r = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
	return r.result?.value;
}

/**
 * 给 douyin-panel 用的一层薄壳：面板/进会话那套代码吃的是「一个页面」的接口，
 * 这里把它绑到新开的那个标签页上。
 */
function makeView(browser, sid, targetId, windowMode) {
	return {
		sessionId: sid,
		targetId,
		windowMode: () => windowMode,
		send: (method, params, sessionId) => browser.send(method, params, sessionId),
		eval: (expression) => evalAt(browser, sid, expression),
		goto: async (url, opts = {}) => {
			const settle = Number(opts.settleMs ?? 6000);
			await browser.send('Page.navigate', { url }, sid);
			const until = Date.now() + settle;
			let href = '';
			while (Date.now() < until) {
				href = String(await evalAt(browser, sid, 'location.href').catch(() => '') || '');
				if (href && href !== 'about:blank' && !href.startsWith('chrome-error://')) break;
				await pause(400);
			}
			if (!href || href === 'about:blank' || href.startsWith('chrome-error://')) throw new Error(`导航失败：${url}`);
			await pause(1000); // 等页面起起来（面板那套自己还会再等 im-entry）
			return { url: href };
		},
	};
}

/**
 * 把一个视频以**原生卡片**分享给某个好友。
 *
 * @param {object} p
 * @param {object} p.browser main 的 Browser（send(method, params, sessionId)）
 * @param {string} p.videoId 作品 ID
 * @param {string} p.peerUid 收件人的平台数字 uid（分享面板上的 data-userid）
 * @param {string} p.friendName 收件人在私信列表里的名字（回读时要进这个会话）
 * @param {(info: object) => Promise<void>|void} [p.onSubmitted] 点击**之前**落盘用
 * @param {(stage: string, info: object) => void} [p.log]
 * @returns {Promise<{ok: boolean, verified: boolean, submitted: boolean, evidence?: string, error?: string}>}
 */
export async function shareVideoToFriend({ browser, videoId, peerUid, friendName, onSubmitted = () => {}, log = () => {}, windowMode = 'background' }) {
	const id = String(videoId || '').trim();
	const uid = String(peerUid || '').trim();
	const name = String(friendName || '').trim();
	if (!/^\d{8,20}$/.test(id) || !/^\d{6,20}$/.test(uid) || !name) {
		return { ok: false, verified: false, submitted: false, error: '缺少有效视频 ID、收件人 uid 或会话名' };
	}
	let targetId = '';
	let sid = '';
	let submitted = false;
	const originalTarget = browser.targetId;
	const ev = (expression) => evalAt(browser, sid, expression);
	const waitFor = async (read, timeout = 18000) => {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			const value = await read().catch(() => null);
			if (value) return value;
			await pause(350);
		}
		return null;
	};
	try {
		({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
		({ sessionId: sid } = await browser.send('Target.attachToTarget', { targetId, flatten: true }));
		if (!targetId || !sid) throw new Error('没有拿到独立标签页连接');
		await browser.send('Page.enable', {}, sid);
		await browser.send('Runtime.enable', {}, sid);
		await browser.send('Page.bringToFront', {}, sid);
		await browser.send('Page.navigate', { url: `https://www.douyin.com/video/${id}` }, sid);
		const icon = await waitFor(() => ev(`(() => {
			if (document.readyState !== 'complete') return null;
			const el = document.querySelector('[data-e2e="video-share-icon-container"]');
			if (!el) return null;
			el.scrollIntoView({block:'center',behavior:'instant'});
			const r = el.getBoundingClientRect();
			return r.width > 4 && r.top >= 0 && r.bottom <= innerHeight ? {x:r.left+r.width/2,y:r.top+r.height/2}:null;
		})()`));
		if (!icon) throw new Error('视频详情页没有可见分享入口');
		// 分享入口是 hover，不点击。先移出，再移入，保证 mouseenter 真的发生。
		await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: icon.x - 60, y: icon.y - 40 }, sid);
		await pause(150);
		await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...icon }, sid);
		const selected = await (async () => {
			const until = Date.now() + 10000;
			while (Date.now() < until) {
				const r = await ev(expr(recipientFromPage, { uid })).catch(() => null);
				if (r?.reason === 'ambiguous') throw new Error('分享面板存在重复收件人 uid');
				if (r?.ok) return r;
				await pause(350);
			}
			return null;
		})();
		if (!selected) throw new Error('分享面板中没有唯一且可见的目标 uid，未发送');
		if (selected.text !== '分享') throw new Error('该目标的分享按钮不是待发送状态，先核实而不重复发送');
		// 在动作提交前写持久化状态：中断了也只能核实，不能盲目重发。
		await onSubmitted({ videoId: id, peerUid: uid });
		submitted = true;
		await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: selected.x, y: selected.y }, sid);
		await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selected.x, y: selected.y, button: 'left', clickCount: 1 }, sid);
		await pause(75);
		await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selected.x, y: selected.y, button: 'left', clickCount: 1 }, sid);
		// toast 只用来记日志，**不是**凭据。
		const ack = await waitFor(() => ev(`(() => {
			const btn=[...document.querySelectorAll('[data-userid]')].find(e=>e.getAttribute('data-userid')===${JSON.stringify(uid)});
			if (btn && /^(已分享|已发送)$/.test((btn.innerText||'').trim())) return true;
			return [...document.querySelectorAll('[class*="toast" i], [role="status"], [role="alert"]')]
			.some(e=>/分享成功|发送成功/.test(e.textContent||''));
		})()`), 5000);
		log('card-submit', { videoId: id, peerUid: uid, acknowledged: Boolean(ack) });
		// 面板提示不是最终凭据。打开同一个好友的私信核对平台 itemId。
		const view = makeView(browser, sid, targetId, windowMode);
		await ensurePanel(view);
		if (!await enterChat(view, name)) throw new Error('分享后无法进入目标私信回读');
		const card = await waitFor(async () => {
			const cards = await ev(expr(nativeCardsFromPage));
			return cards?.find((c) => c.videoId === id && c.fromMe && c.native) || null;
		}, 10000);
		if (!card) throw new Error('分享已提交，但目标私信中没有确认到指定视频的原生卡片');
		log('card-verified', { videoId: id, peerUid: uid });
		return { ok: true, verified: true, delivered: true, submitted: true, videoId: id, peerUid: uid, evidence: 'native-card-itemId' };
	} catch (error) {
		return { ok: false, verified: false, delivered: false, submitted, videoId: id, peerUid: uid, error: String(error?.message || error) };
	} finally {
		if (targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
		if (originalTarget) await browser.send('Target.activateTarget', { targetId: originalTarget }).catch(() => {});
	}
}
