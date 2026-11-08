// 一条记忆「给模型看的样子」。
//
// 抽成独立模块的原因：原来它是 `apply()` 里的闭包，没法单独测；
// 而这块逻辑现在有了新契约（要带 evidence，见下），必须有断言守着。
//
// 参考 Anthropic《The components of agent memory》：好的记忆笔记要包含
// **结论 + 为什么可信**（哪些是核过的、哪些还只是印象）。不然模型分不清
// 「他亲口说的」和「我自己瞎猜的」，错的结论会被当成既定事实一直用下去。

// KIND_LABEL / relTime 已经在 soul-memory.js 里了，这里直接复用，别再造一份
import { KIND_LABEL, relTime } from './soul-memory.js';

export { KIND_LABEL, relTime };

// evidence 里这些是「人人都有」的噪音，标出来只会占地方
const NOISE_EVIDENCE = new Set(['聊完自动记', '聊完小结', '']);

/**
 * 一条记忆渲染成一行。
 *
 * @param {object} m memory 行
 * @param {number} now 当前时间（虚拟钟）
 * @param {(canonicalId: string) => string} nameOf 按 canonical_id 取显示名
 * @param {(content: string) => string} [staleTag] #76：装置能力类陈述的「可能已过时」标注
 */
export function memoryLabel(m, now, nameOf = () => '别人', staleTag = () => '') {
	const tags = [m.owner_id === 'self' ? '你自己' : KIND_LABEL[m.kind] ?? m.kind, relTime(m.created_at, now)];
	if (m.about && m.owner_id !== 'self') tags.push(`${nameOf(m.owner_id) ?? '别人'}说的`);

	// evidence = 这条记忆怎么来的。只标"有信息量"的：
	// 空的不写；「聊完自动记」这种人人都有得写的不写；跟上面那句重复的不写。
	const from = String(m.evidence ?? '').trim();
	if (!NOISE_EVIDENCE.has(from)) {
		// 关于她自己的事：「跟某某聊天时说的」——那个某某是**原始 QQ 号 / 会话名**，
		// 她看了没意义。换成显示名；换不到就整个不写（宁可少一个标签，也别把 QQ 号漏给她看）。
		const selfTold = String(m.owner_id) === 'self' ? from.match(/^跟(.+)聊天时说的$/) : null;
		if (selfTold !== null) {
			const who = nameOf(`user:${selfTold[1]}`);
			if (who && who !== '别人') tags.push(`跟${who}聊天时说的`);
		} else if (!tags.some((t) => String(t).includes(from))) {
			tags.push(from);
		}
	}

	if (m.visibility === 'private') tags.push('私聊里说的，别在群里提');
	if (m.owner_id === 'self') {
		const tag = staleTag(m.content);
		if (tag !== '') tags.push(tag);
	}
	return `- （${tags.filter(Boolean).join(' · ')}）${m.content}`;
}
