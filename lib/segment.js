/**
 * segment.js —— 零依赖中文分词 + BM25 + 艾宾浩斯衰减（设计方案 §9.5，审查 #09）。
 *
 *  - 分词：Node 内置 Intl.Segmenter('zh-CN', { granularity: 'word' }) + 最小停用词表，
 *    严禁 nodejieba 等原生编译包，也不要单字切分（会被"的/了/是"污染召回）；
 *  - BM25：初筛 Top 50 后在 JS 层乘艾宾浩斯衰减：importance >= 3 豁免，
 *    否则 score × exp(-ln2/7 × Δt_days)（半衰期 7 个虚拟日，Δt 用虚拟钟）。
 */
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

const STOP_WORDS = new Set([
	'的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
	'上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
	'自己', '这', '他', '她', '它', '们', '吗', '吧', '呢', '啊', '呀', '嘛', '哦'
]);

/**
 * 文本 → 空格分隔的关键词串（写入 memory.keywords）。
 * @param {string} text
 * @returns {string}
 */
export function tokenizeForBm25(text) {
	const tokens = [];
	for (const seg of segmenter.segment(String(text ?? '').toLowerCase())) {
		if (seg.isWordLike) {
			const w = seg.segment.trim();
			if (w.length > 0 && !STOP_WORDS.has(w)) tokens.push(w);
		}
	}
	return tokens.join(' ');
}

/** keywords 串 → 词项数组。 */
export function splitKeywords(keywords) {
	return String(keywords ?? '').split(/\s+/).filter((w) => w.length > 0);
}

/**
 * 轻量 BM25（Okapi, k1=1.5, b=0.75）。
 * 语料规模数千条、候选即全量 active 记忆，直接 JS 内存算分足够。
 *
 * @param {Array<{id:number, keywords:string, updated_at:number, importance:number}>} docs
 * @param {string[]} queryTerms
 * @param {number} nowVirtualMs 虚拟钟当前时间（衰减用）
 * @param {number} topN 返回条数（初筛 Top 50）
 * @returns {Array<{id:number, score:number}>} 按衰减后得分降序
 */
export function bm25Search(docs, queryTerms, nowVirtualMs, topN = 50, { decay = true } = {}) {
	if (docs.length === 0 || queryTerms.length === 0) return [];
	const K1 = 1.5;
	const B = 0.75;

	const docTokens = docs.map((d) => splitKeywords(d.keywords));
	const avgLen = docTokens.reduce((sum, t) => sum + t.length, 0) / docs.length || 1;

	// df：包含某词项的文档数
	const df = new Map();
	for (const tokens of docTokens) {
		for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
	}
	const N = docs.length;

	const scored = [];
	for (let i = 0; i < docs.length; i++) {
		const tokens = docTokens[i];
		if (tokens.length === 0) continue;
		const tf = new Map();
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

		let score = 0;
		for (const q of queryTerms) {
			const f = tf.get(q);
			if (f === undefined) continue;
			const n = df.get(q) ?? 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (tokens.length / avgLen)));
		}
		if (score <= 0) continue;

		// 艾宾浩斯衰减（JS 层，虚拟钟）：importance >= 3 豁免
		const doc = docs[i];
		if (decay && (doc.importance ?? 1) < 3) {
			const deltaDays = Math.max(0, (nowVirtualMs - doc.updated_at) / 86_400_000);
			score *= Math.exp((-Math.LN2 / 7) * deltaDays);
		}
		scored.push({ id: doc.id, score });
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topN);
}
