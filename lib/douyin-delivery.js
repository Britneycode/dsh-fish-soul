/**
 * douyin-delivery.js —— 抖音视频卡片的**交付层**：卡片和说明分两个阶段落盘。
 *
 * 为什么分两阶段
 * --------------
 * 卡片（点开就播的那条）和说明（配的那句话）是两次独立动作，各自有各自的成败：
 *   · 卡片没确认 → **不能**拿「文字发成功了」结账（那是两件事）
 *   · 卡片确认了、说明失败 → 只重试说明，**不重发卡片**（重发就是重复分享）
 *   · 提交后结果未知 → 停止自动重试，等人工核实
 *
 * 🔴 红线：这里**不保证「恰好一次」**。任何中断都可能留下 unknown 待人工核实。
 *    宁可让人手动核实一次，也不要自动重发一份重复的卡片。
 */
import { createHash } from 'node:crypto';
import { getKv, setKv } from './db.js';

const VIDEO_URL = /https?:\/\/(?:www\.)?douyin\.com\/video\/(\d{8,20})(?!\d)/g;

// ponytail: 一次只发一张（queueShare 一次就一条）；要一次多张再调大这个数
const MAX_CARDS = 1;

/** 文本里有哪些抖音作品 ID。 */
export function douyinVideoIds(text) {
	return [...new Set([...String(text || '').matchAll(VIDEO_URL)].map((m) => m[1]))];
}

/** 把已经发成卡片的链接从正文里去掉（没发出去的链接留着）。 */
export function removeCardLinks(text, ids) {
	const delivered = new Set(ids);
	return String(text || '')
		.replace(VIDEO_URL, (url, id) => (delivered.has(id) ? '' : url))
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 交付一批视频卡片 + 一句说明。
 *
 * @param {object} p
 * @param {import('node:sqlite').DatabaseSync} p.db 状态落盘用
 * @param {string} p.deliveryId 交付标识（同一次投递重试时必须相同 ⇒ 状态才认得出）
 * @param {string[]} p.videoIds 作品 ID
 * @param {string} p.caption 说明文字
 * @param {(id: string, onSubmitted: () => void) => Promise<object>} p.sendCard
 * @param {(text: string) => Promise<object>} p.sendText
 * @returns {Promise<{ok: boolean, verified: boolean, unknown?: boolean, cardVerified?: boolean, error?: string}>}
 */
export async function deliverDouyinCards({ db, deliveryId, videoIds, caption = '', sendCard, sendText, log = () => {} }) {
	const ids = [...new Set(videoIds || [])];
	if (!deliveryId || !ids.length || ids.length > MAX_CARDS || ids.some((id) => !/^\d{8,20}$/.test(String(id)))) {
		return { ok: false, verified: false, error: '缺少交付标识或有效视频 ID' };
	}
	const hash = createHash('sha256').update(String(deliveryId)).digest('hex').slice(0, 32);
	const root = `douyin.cardDelivery.${hash}`;

	// ── 阶段一：卡片 ────────────────────────────────────────────
	for (const videoId of ids) {
		const key = `${root}.${videoId}`;
		const state = getKv(db, key, null);
		if (state?.phase === 'verified') continue;                       // 上一轮已经确认过
		if (state?.phase === 'submitted' || state?.phase === 'unknown') {
			return { ok: false, verified: false, unknown: true, videoId, error: '卡片曾提交但尚未核实，保留待核实状态，不重复分享' };
		}
		let submitted = false;
		let result;
		try {
			// onSubmitted 在**点击之前**落盘 —— 中断了也知道「可能已经发出去了」
			result = await sendCard(videoId, () => {
				setKv(db, key, { phase: 'submitted', at: Date.now(), videoId });
				submitted = true;
			});
		} catch (error) {
			result = { ok: false, submitted, error: String(error?.message || error) };
		}
		if (result?.ok !== true || result?.verified !== true) {
			// 提交过但没确认 ⇒ unknown，**绝不自动重发**；压根没提交 ⇒ 可以再来一次
			const unknown = submitted || result?.submitted === true;
			setKv(db, key, { phase: unknown ? 'unknown' : 'not_sent', at: Date.now(), videoId, error: result?.error || '未取得卡片交付证据' });
			return { ok: false, verified: false, unknown, videoId, error: result?.error || '未取得卡片交付证据' };
		}
		setKv(db, key, { phase: 'verified', at: Date.now(), videoId, evidence: result.evidence || 'native-card' });
		log('card-verified', { deliveryId, videoId });
	}

	// ── 阶段二：说明 ────────────────────────────────────────────
	const text = removeCardLinks(caption, ids);
	if (text !== '') {
		const key = `${root}.caption`;
		const state = getKv(db, key, null);
		if (state?.phase === 'unknown' || state?.phase === 'submitted') {
			return { ok: false, verified: false, unknown: true, cardVerified: true, error: '卡片已确认；说明的发送结果待核实，不重发卡片' };
		}
		if (state?.phase !== 'verified') {
			let result;
			try {
				result = await sendText(text);
			} catch (error) {
				result = { ok: false, error: String(error?.message || error) };
			}
			const partsBad = Boolean(result?.parts?.length) && result.parts.some((p) => p.ok !== true || p.delivered !== true);
			if (result?.ok !== true || result?.delivered !== true || partsBad) {
				// 明确没发出去（ok=false）⇒ 下次只重试说明；动作做了但没回读到 ⇒ unknown，不盲重发
				const unknown = result?.ok === true;
				setKv(db, key, { phase: unknown ? 'unknown' : 'not_sent', at: Date.now(), error: result?.error || '说明未全部确认' });
				return {
					ok: false, verified: false, unknown, cardVerified: true,
					error: unknown ? '卡片已确认，说明发送结果不确定；不会重复分享卡片' : '卡片已确认，说明没发出去；重试时只发说明，不重发卡片',
				};
			}
			setKv(db, key, { phase: 'verified', at: Date.now() });
		}
	}
	return { ok: true, verified: true, delivered: true, cardVerified: true, videoIds: ids };
}
