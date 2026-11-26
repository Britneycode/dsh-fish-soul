// 聊天里发的抖音链接 → 原生卡片。
//
// 问题（2026-11-19 真机）：主人问「有没有有趣的视频分享给我」，她用**文字**回了两条链接。
// 原生卡片只在「她自己起意的分享待办」那条路才发（`origin='share'` → `deliverShare`）；
// 普通聊天回复走 `send` → 纯文本 ⇒ 链接就是链接，卡片没了。
//
// 修法：在出站（`DouyinAdapter.send`）这一层把文本拆段，**单独成段的链接**改发卡片，其余照旧。
//
// 拆段形态（真机那句话就是典型）：
//   「猫跳舞那个…笑半天」\n\n<链接1>\n\n「还有个桌宠小鲸鱼的…」\n\n<链接2>
// ⇒ [文字, 卡片, 文字, 卡片]
//
// 🔴 三个边界，一个都不能省：
//   ① 卡片发失败要**退回文字**，不能让那句话凭空消失（宁可退回链接，也不能丢内容）
//   ② 一段里既有文字又有链接（「看这个 https://… 挺好笑」）不能整段变卡片 ——
//      那样前面那半句会跟着消失。只处理「单独成段」的链接，所以这条正则必须是整段匹配。
//   ③ 卡片发送只认「会话 ID 能推出对端」的会话（`shareTargetFor`），不按昵称猜人。

/**
 * 整段就是一条抖音链接（前后没有别的字）。
 */
export const ALONE_LINK = /^https?:\/\/(?:www\.)?(?:douyin\.com\/(?:video|note)\/|v\.douyin\.com\/)\S*$/;

/**
 * 段落内联抖音链接（video / note / v.douyin.com 短链）。
 * 遇到中文字符、全角标点、空白或引号/括号边界即止，避免把紧贴链接的中文评语吞进 URL。
 */
export const INLINE_DOUYIN_LINK = /https?:\/\/(?:www\.)?(?:douyin\.com\/(?:video|note)\/|v\.douyin\.com\/)[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef<>"'\]）】」》]+/g;

const EMPTY_WRAPPER_PAIRS = [
	['（', '）'],
	['(', ')'],
	['【', '】'],
	['[', ']']
];

/** 剥掉围绕“已被抽走链接的空洞”的空括号、`（链接 ）` 或残余 `链接：` 前缀，不伤及真实文案。 */
function peelWrapperPair(before, after) {
	let b = before;
	let a = after;
	// Markdown `[标题](url)`：剥掉外层 `](` 与 `)`，保留标题原文
	const mdOpen = /\[([^\]\n]+)\]\(\s*$/.exec(b);
	if (mdOpen && /^\s*\)/.test(a)) {
		b = `${b.slice(0, mdOpen.index)}${mdOpen[1]}`;
		a = a.replace(/^\s*\)/, '');
	}
	for (const [open, close] of EMPTY_WRAPPER_PAIRS) {
		const openRe = new RegExp(`${open === '(' || open === '[' ? `\\${open}` : open}\\s*(?:(?:视频|图文)?链接[:：]?\\s*)?$`);
		const closeRe = new RegExp(`^\\s*${close === ')' || close === ']' ? `\\${close}` : close}`);
		if (openRe.test(b) && closeRe.test(a)) {
			b = b.replace(openRe, '');
			a = a.replace(closeRe, '');
			break;
		}
	}
	b = b.replace(/(?:^|\s)(?:(?:视频|图文)?链接[:：]\s*)$/, '');
	return [b, a];
}

function cleanGapText(s) {
	return String(s ?? '')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 把一段话里的抖音分享链接无损拆出来，保留周围文字与原本顺序：
 * - 单段纯链接 -> `[{ kind: 'link', url }]`
 * - 文+链混排（如 `看这个 https://... 挺好笑`、`猫跳舞笑死\nhttps://...`、`猫跳舞那个（链接 https://...）`）
 *   -> 清理围绕链接的空壳 `（链接 ）` / `()` 后，同时保留文字和链接，一个有效字都不丢。
 *
 * @param {string} para
 * @returns {Array<{ kind: 'text', text: string } | { kind: 'link', url: string }>}
 */
export function splitDouyinShareParagraph(para) {
	const src = String(para ?? '').trim();
	if (src === '') return [];
	if (ALONE_LINK.test(src)) return [{ kind: 'link', url: src }];

	const matches = [];
	const re = new RegExp(INLINE_DOUYIN_LINK.source, 'g');
	let m;
	while ((m = re.exec(src)) !== null) {
		const raw = m[0];
		const url = raw.replace(/[)\],.;:!?'"`]+$/u, '');
		if (url === '') continue;
		matches.push({ start: m.index, end: m.index + url.length, url });
	}
	if (matches.length === 0) return [{ kind: 'text', text: src }];

	const gaps = [];
	let pos = 0;
	for (const hit of matches) {
		gaps.push(src.slice(pos, hit.start));
		pos = hit.end;
	}
	gaps.push(src.slice(pos));

	for (let i = 0; i < matches.length; i += 1) {
		const [b, a] = peelWrapperPair(gaps[i], gaps[i + 1]);
		gaps[i] = b;
		gaps[i + 1] = a;
	}

	if (matches.length === 1) {
		const before = cleanGapText(gaps[0]);
		const after = cleanGapText(gaps[1]);
		const combined = cleanGapText([before, after].filter(Boolean).join(before.includes('\n') || after.includes('\n') ? '\n' : ' '));
		if (combined === '') return [{ kind: 'link', url: matches[0].url }];
		return before !== ''
			? [{ kind: 'text', text: combined }, { kind: 'link', url: matches[0].url }]
			: [{ kind: 'link', url: matches[0].url }, { kind: 'text', text: combined }];
	}

	const out = [];
	for (let i = 0; i < matches.length; i += 1) {
		const t = cleanGapText(gaps[i]);
		if (t !== '') out.push({ kind: 'text', text: t });
		out.push({ kind: 'link', url: matches[i].url });
	}
	const tail = cleanGapText(gaps[matches.length]);
	if (tail !== '') out.push({ kind: 'text', text: tail });
	return out;
}
