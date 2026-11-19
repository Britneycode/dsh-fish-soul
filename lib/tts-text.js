/**
 * tts-text.js —— 念出来之前对文本做的最后一层清洗。
 *
 * 为什么单独一层：`deAi` 那套是给**文字**消息用的（剥 Markdown、删括号动作、
 * 去 AI 套话），它刻意**不动表情码** —— 因为表情码在文字那条路上是有意义的
 * （抖音那边单独一段写 `[比心]` 会真的发成表情图）。但语音这条路没有「表情段」，
 * 表情码会被原样念出来，用户听到的是「方括号比心方括号」。
 *
 * 实测（2026-11-19）：
 *   deAi('我今天好累啊[比心]')   → '我今天好累啊[比心]'   ← 会念出来
 *   deAi('哈哈哈哈[笑死][绝了]') → '哈哈哈哈[笑死][绝了]' ← 会念出来
 *
 * 这跟 MEMORY 里记的那条同族：`[捂脸]` 不在抖音表情面板里 ⇒ 静默退化成文字发出去。
 * 表情码在「文字 / 语音」两条路上处理不一致，是同一个盲区。
 *
 * ⚠️ 只剥**确认为表情码**的方括号，不能见方括号就删：
 *   - `[语音]` 是协议标记，调用方在进来之前已经剥了，但这里也认一下（幂等）；
 *   - `[图片]` `【图片】` 这类占位要删；
 *   - 但 `[1]` `[注]` `[参考]` 这种正文里的引用标记**不是表情码**，
 *     无脑删会把正文改坏。所以判据是「1~8 个中日韩字/字母数字，且不是纯数字」。
 */

/** 表情码：半角方括号 + 1~8 个字（中日韩/字母/数字），且不是纯数字（那是引用标记）。 */
const EMOJI_CODE_RE = /\[([\u4e00-\u9fa5A-Za-z0-9]{1,8})\]/g;
/** 正文占位（这些不是表情，是图/附件的替身），整段删掉。 */
const PLACEHOLDER_RE = /[\[【](?:图片|图|表情|表情包|动画表情|附件|文件|视频|语音消息|图片消息)[\]】]/g;

/**
 * 看着像引用 / 脚注 / 正文标记的，不当表情码。
 *
 * 🔴 判据要窄。第一版只排了纯数字，结果 `[注]` 被当成表情码删掉了 ——
 *    而 `[注]` `[略]` `[完]` 这类单字方括号在中文正文里是标记，不是表情。
 *    表情名基本都是两个及以上（比心/笑死/绝了/爱心），单字极少（嗨/麻了…「嗨」是一个字）。
 *    所以：单字只认已知的那几个真表情名，其余单字一律当正文标记留着。
 */
const SINGLE_CHAR_EMOJI = new Set(['嗨']);
const looksLikeCitation = (inner) =>
	/^\d+$/.test(inner) ||
	/^[A-Za-z]{1,2}\d*$/.test(inner) ||
	(inner.length === 1 && !SINGLE_CHAR_EMOJI.has(inner));

/**
 * 把文本里会被念出来的表情码 / 占位符剥掉。
 *
 * @param {string} text
 * @returns {{text: string, removed: string[]}} removed 是剥掉了什么（给日志用，别静默）
 */
export function stripForSpeech(text) {
	const removed = [];
	let t = String(text ?? '');
	if (t === '') return { text: '', removed };

	t = t.replace(PLACEHOLDER_RE, (m) => {
		removed.push(m);
		return '';
	});

	t = t.replace(EMOJI_CODE_RE, (m, inner) => {
		// [语音] 是协议标记（调用方通常已经剥过，这里兜一层）
		if (inner === '语音') { removed.push(m); return ''; }
		if (looksLikeCitation(inner)) return m; // 引用标记留着
		removed.push(m);
		return '';
	});

	// 剥完可能留下多余空格 / 空段，收一下（但别把段落结构压平 —— 调用方按 \n\n 分段）
	t = t.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').replace(/^[ \t]+/gm, '');
	t = t.replace(/\n{3,}/g, '\n\n').trim();

	return { text: t, removed };
}
