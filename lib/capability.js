/**
 * capability.js —— 「她关于自己装置能力」的说法（#76）。
 *
 * 问题：她曾长期坚称「我没有识图能力、只能读字」。这类陈述写进长期记忆后，
 * 会因为「被反复想起」被自动升到 3 星（3 星不衰减 → 永生），每轮都注入，
 * 于是现实（插件早就能发图 / 抽帧）变了，记忆却比现实更坚定，最后她被自己写下的记忆说服。
 *
 * 这里只做判定，不做存储策略：
 *  - isCapabilityClaim(text)：这是不是一句「关于自己能不能做某事」的话；
 *  - CAPABILITY_NEGATIONS / CAPABILITY_SUBJECTS：判定用的词表（保守，宁可漏判也不误伤）；
 *  - 她现在实际能做什么（PLUGIN_CAPABILITIES）：插件侧的代码事实，供注入时的标注与人工核对。
 *
 * 只认**她自己**说的（owner_id = 'self'）：说别人「他不能看图」是稳定的事实，不受影响。
 */

/** 否定 / 限定的说法。 */
const NEGATIONS = ['不能', '不会', '没法', '无法', '不支持', '没有', '只能', '只会', '看不了', '读不了', '识不了', '发不了'];

/** 能力名词：装置 / 平台相关的功能。 */
const SUBJECTS = [
	'看图', '识图', '读图', '看图片', '看照片', '图片', '照片', '看视频', '视频', '抽帧',
	'语音', '表情包', '表情', '上网', '搜图', '搜索', '回评论', '评论', '刷B站', '刷抖音', 'B站', '抖音'
];

/** 明确"只能读字"这类说法：字面不含上面的能力名词，但同样是能力断言。 */
const TEXT_ONLY = ['只能读字', '只能看字', '只认字', '只能看文字', '只能处理文字', '只支持文字'];

/**
 * 插件现在实际做的事（代码事实，供人工核对 / 文档引用）：
 * 看图（QQ 照片、表情包原图）、看视频抽帧、收发语音、刷 B站 / 抖音、
 * 回评论（抖音 / B站）、主动开口、按人记忆。
 * 注意：能不能"看懂"由宿主模型决定，插件只保证"确实把图/帧/语音送到她面前"。
 */

/**
 * 这句话是不是「关于自己能不能做某事」的能力断言。
 * 判定保守：必须同时出现"否定/限定"和"能力名词"，或命中"只能读字"这类固定说法。
 * @param {string} text
 * @returns {boolean}
 */
export function isCapabilityClaim(text) {
	const s = String(text ?? '').trim();
	if (s === '') return false;
	if (TEXT_ONLY.some((t) => s.includes(t))) return true;
	if (!NEGATIONS.some((n) => s.includes(n))) return false;
	return SUBJECTS.some((t) => s.includes(t));
}

/** 第三人称标记：出现了就说明说的不是她自己（"他不能看图"是稳定事实，不该按易失能力处理）。 */
const THIRD_PERSON = ['他们', '她们', '别人', '大家', '同事', '朋友', '老师', '他', '她'];

/**
 * 这句话是不是「**她自己**说自己不能做某事」。
 * 自己写的记忆通常是第一人称；出现第三人称就当说的是别人。
 * @param {string} text
 * @returns {boolean}
 */
export function isSelfCapabilityClaim(text) {
	const s = String(text ?? '').trim();
	if (!isCapabilityClaim(s)) return false;
	return !THIRD_PERSON.some((t) => s.includes(t));
}

/**
 * 注入时给能力类记忆加的标注：提醒模型这是"以前的说法"，装置 / 模型变了就可能过期。
 * @param {string} text
 * @returns {string} 标注（不是能力断言就返回空串）
 */
export function capabilityStaleTag(text) {
	return isSelfCapabilityClaim(text) ? '可能已过时' : '';
}
