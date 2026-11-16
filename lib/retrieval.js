/**
 * retrieval.js —— 远程向量、补偿 RRF 召回、单队列世代锁 Worker（设计方案 §8/§9，审查 #06/#08）。
 *
 *  - 向量只用远程 OpenAI 兼容 POST {baseURL}/embeddings，内置 fetch，零依赖；
 *  - 写入 vec.blob 前 L2 归一化 + Float32 小端序，检索时纯点积；
 *  - 点积前预过滤有效 memory_id（character/owner/status/valid_to），防脏向量混入；
 *  - 未向量化新记忆向量侧 0.85× 对称补偿（审查 #06，保验收第 2 条"下一轮能召回"）；
 *  - 单队列双优先级串行 Worker：实时队列高优不限速，重建存量 32 条/分钟（物理钟令牌）；
 *  - generation_id 世代锁：切换模型/端点/维度或重建时 +1 清表，Worker 写库前校验世代；
 *  - Fail-open 铁律：未配 Key / 网络异常 / 800ms 物理超时 → 立即降级纯 BM25，绝不断对话。
 */
import { bm25Search, queryForBm25, splitKeywords, tokenizeForBm25, CHAR_WEIGHT } from './segment.js';
import { decayFactor } from './soul-memory.js';
import { bumpGeneration, getKv, readVecMeta, setKv, writeVecMeta } from './db.js';

const RRF_K = 60;
const PENDING_VEC_COMPENSATION = 0.85;
const REBUILD_RATE_PER_MIN = 32;
const REALTIME_BATCH = 32;
const REBUILD_MAX_BATCH = 8;
const REALTIME_MAX_ATTEMPTS = 5;

// ───────────────────────── 时间意图（#78） ─────────────────────────
// 问「刚才」问的就是最近的，可检索这一层原来听不出来：
//   ① 刷视频的记忆写进来时 importance 恒为 1（lib/browse.js），30 天半衰期还会淡；
//   ② BM25 里「刷」「视频」在几百条记忆里都出现过，idf 几乎为 0，「刚才」「什么」几乎查不到；
//   ③ 于是「你刚才刷了什么视频呀」没有一个词有区分度，排名全由重要度和分层决定 —— 老记忆赢；
//      刚刷的那几条甚至进不了 BM25 前 50（候选池先被砍掉了，事后加权救不回来）。
// 这里给近期记忆一条通路：查询带时间词时，窗口内的记忆先进候选池（截断之前），排序时再加权。
// 只改排序，不造记忆：没对上词的记忆分数就是 0，进不了池，也不会被捞出来。
const DAY_MS = 86_400_000;
/**
 * 滚动时间窗：时间词 → 往前看几天。
 * 「刚才 / 刚刚 / 刚」是一两天内，「最近 / 近期」是这几天。
 */
const ROLLING_INTENT_DAYS = new Map([
	['刚才', 1], ['刚刚', 1], ['刚刚才', 1], ['方才', 1], ['刚', 1],
	['上次', 3], ['上回', 3],
	['最近', 3], ['近期', 3]
]);
/**
 * 问句里的空词：对上它们不算"对上内容"。
 * 「什么」「怎么」在记忆正文里到处都是（真机库里 33 条含「什么」），拿它们当内容词，
 * 谁都能被算成"对上了" —— 「我最近心情怎么样」会被不相干的近期记忆挤掉。
 * 只在时间意图这条通路上排除，不动 segment.js 的停用词表（那会动到所有查询的老排名）。
 */
const EMPTY_QUERY_TERMS = new Set([
	'什么', '怎么', '怎样', '咋', '啥', '哪个', '哪些', '为什么', '为啥'
]);

/**
 * 指代词与泛动词：命中它们**不代表命中了话题**。
 *
 * 🔴 真机事故：「上次那个梗」里，一条刷视频的记忆因为正文含「那个」被当成了"那个梗"，
 * 直接排到第一 —— 问的是梗，答的却是刷视频，等于想起了一件没发生的事。
 *
 * 这些词不算「内容词」（不该让一条记忆因为它们被提上来），
 * 但它们在问句里仍然算数 —— 所以单列一档，不跟疑问空词混在一起。
 * 「说/问/看」这类在 lib/segment.js 的停用词表里已经滤掉了，不重复列。
 */
const GENERIC_QUERY_TERMS = new Set([
	'那个', '这个', '这些', '那些', '这样', '那样', '这么', '那么',
	'干', '弄', '事', '东西', '会儿',
	// 疑问代词：问法，不是话题。「谁说的」里的「谁」不该让日记靠它被提上来。
	'谁', '谁的', '哪儿', '哪', '哪里', '多少', '几个', '咋样', '如何',
	// 泛指的说法：「他说的」「我讲的」指的是某句话，不是话题
	'说的', '讲的'
]);
/**
 * 时间意图的内容词上限：超过这个数说明这不是一句问话，是一整段转录
 * （整理记忆时把聊天尾巴整段丢进来查，见 lib/index.js 的 related）—— 那种场合不按时间意图重排。
 */
const MAX_INTENT_CORE_TERMS = 12;
/** 一次最多提升多少条近期记忆：免得一整批近期记忆把老记忆的排名全挤到后面。 */
const MAX_PROMOTED_RECENT = 20;
/** 窗口内记忆在最终排序里的加权：要压过分层权重 recent 1.1 / longTerm 1.2 的差距。 */
export const RECENCY_BOOST = 1.5;

/** number[] → L2 归一化后的 Float32 小端序 Buffer。 */
export function normalizeToBlob(vec) {
	let sumSq = 0;
	for (const v of vec) sumSq += v * v;
	const norm = Math.sqrt(sumSq) || 1;
	const f32 = new Float32Array(vec.length);
	for (let i = 0; i < vec.length; i++) f32[i] = vec[i] / norm;
	return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Buffer → Float32Array（小端序，零拷贝视图）。 */
export function blobToF32(blob) {
	const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
	return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** 两个 L2 归一化向量的点积（= 余弦相似度）。 */
function dot(a, b) {
	const n = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < n; i++) s += a[i] * b[i];
	return s;
}

export class EmbeddingClient {
	/** @param {() => object} getConfig 读取当前向量配置（enabled/baseURL/apiKey/model/timeoutMs/writeTimeoutMs） */
	constructor(getConfig) {
		this.getConfig = getConfig;
	}

	/**
	 * 远程 embedding（带失败原因）。超时用真实物理时钟：
	 * 查询路径默认 800ms（不拖慢回复），写入/重建路径用 writeTimeoutMs（默认 10s，批量 32 条 800ms 必超时）。
	 * @returns {Promise<{ok:true, vectors:number[][], latencyMs:number} | {ok:false, error:string, latencyMs:number}>}
	 */
	async embedDetailed(inputs, { timeoutMs } = {}) {
		const cfg = this.getConfig();
		const started = Date.now();
		if (!cfg.enabled || !cfg.baseURL || !cfg.apiKey || !cfg.model) {
			return { ok: false, error: 'NOT_CONFIGURED', latencyMs: 0 };
		}
		const limit = timeoutMs ?? cfg.timeoutMs ?? 800;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), limit);
		try {
			const res = await fetch(`${cfg.baseURL.replace(/\/+$/, '')}/embeddings`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
				body: JSON.stringify({ model: cfg.model, input: inputs }),
				signal: controller.signal
			});
			if (!res.ok) return { ok: false, error: `HTTP_${res.status}`, latencyMs: Date.now() - started };
			const data = await res.json();
			const rows = Array.isArray(data?.data) ? data.data : [];
			if (rows.length !== inputs.length || !Array.isArray(rows[0]?.embedding)) {
				return { ok: false, error: 'BAD_RESPONSE', latencyMs: Date.now() - started };
			}
			// 按 index 排序：部分网关不保证返回顺序
			rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			return { ok: true, vectors: rows.map((r) => r.embedding), latencyMs: Date.now() - started };
		} catch (error) {
			const timedOut = controller.signal.aborted;
			return { ok: false, error: timedOut ? `TIMEOUT_${limit}MS` : 'NETWORK', latencyMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
		}
	}

	/** 兼容旧接口：失败返回 null（fail-open）。 */
	async embed(inputs, opts) {
		const r = await this.embedDetailed(inputs, opts);
		return r.ok ? r : null;
	}

	/** 连通性探测：返回维度/延迟，失败时给出真实原因（401/超时/网络/响应格式）。 */
	async probe() {
		const cfg = this.getConfig();
		const r = await this.embedDetailed(['ping'], { timeoutMs: Math.max(cfg.timeoutMs ?? 800, 3000) });
		if (!r.ok) return { ok: false, latencyMs: r.latencyMs, errorCode: r.error };
		return { ok: true, latencyMs: r.latencyMs, detectedDim: r.vectors[0].length };
	}
}

/** 向量索引当前是否可用于检索：状态非 stale、维度已知、且配置模型与索引模型一致（防混模型）。 */
function vectorIndexUsable(meta, embeddingCfg) {
	return meta !== null && meta.dim > 0 && meta.status !== 'stale' &&
		(embeddingCfg?.model ?? '') === meta.model_id;
}

/**
 * 有效候选集（召回过滤，审查 #07）：角色自身 + 当前说话人 + 别人说的关于当前说话人的事（不含私密的）。
 * excludePrivate：群里不拿私聊里说的私密记忆。
 */
function loadCandidates(db, characterId, ownerId, { excludePrivate = false } = {}) {
	return db.prepare(`
		SELECT id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion,
		       created_at, updated_at, visibility, about, recall_count, last_recalled_at, evidence
		FROM memory
		WHERE character_id = ? AND status = 'active' AND valid_to IS NULL
		  AND (owner_id IN ('self', ?) OR (about = ? AND visibility = 'normal'))
		  AND (? = 0 OR visibility = 'normal')
	`).all(characterId, ownerId, ownerId, excludePrivate ? 1 : 0);
}

/**
 * 向量路排名（异步，可预取）：query → memory_id → 1-based 排名。不可用时返回 null。
 */
export async function vectorRanks({ db, embedder, characterId, ownerId, query, embeddingCfg }) {
	const meta = readVecMeta(db);
	if (!vectorIndexUsable(meta, embeddingCfg)) return null;
	const embedded = await embedder.embed([query]);
	if (embedded === null) return null;
	const qf32 = blobToF32(normalizeToBlob(embedded.vectors[0]));
	if (qf32.length !== meta.dim) return null;
	// 只从数据库搬出有权参与本轮排名的向量；保持原先按 memory_id 排序以稳定相同分数。
	const vecRows = db.prepare(`SELECT memory_id, blob FROM vec WHERE generation_id = ? AND dim = ?
		AND memory_id IN (SELECT id FROM memory WHERE character_id = ? AND status = 'active' AND valid_to IS NULL
		AND (owner_id IN ('self', ?) OR (about = ? AND visibility = 'normal')))
		ORDER BY memory_id`).all(meta.generation_id, meta.dim, characterId, ownerId, ownerId);
	const sims = [];
	for (const vr of vecRows) sims.push({ id: vr.memory_id, sim: dot(qf32, blobToF32(vr.blob)) });
	sims.sort((a, b) => b.sim - a.sim);
	return { generationId: meta.generation_id, ranks: new Map(sims.slice(0, 50).map((r, i) => [r.id, i + 1])) };
}

/**
 * 同步召回（§8.2）：BM25（含衰减）+ 可选的已预取向量排名 → 补偿 RRF。
 * 同步是为了在 systemPrompt.context 的同步 text() 里拿到"本轮"结果，消除一轮滞后。
 */
// 分层只修正已匹配结果，不凭层级制造相关性；周记先识别，重要度优先于近期。
export function memoryTier(row, now) {
	if (row.kind === 'weekly') return 'weekly';
	if (Number(row.importance ?? 1) >= 3) return 'longTerm';
	return Number.isFinite(Number(row.created_at)) && now - Number(row.created_at) < 7 * 86_400_000 ? 'recent' : 'longTerm';
}
export function memoryTierWeight(tier, config = {}) {
	const defaults = { recent: 1.1, longTerm: 1.2, weekly: 0.9 };
	const n = Number(config.tierWeights?.[tier] ?? defaults[tier] ?? 1);
	return Number.isFinite(n) ? Math.min(2, Math.max(0.1, n)) : defaults[tier] ?? 1;
}

/**
 * 时间词 → 时间窗：以「距今多少毫秒」（年龄）表示的区间 [minAge, maxAge]。
 *   刚才 / 刚刚 / 刚：滚动 1 天
 *   最近 / 近期：滚动 3 天
 *
 * 只认「纯指时间」的词。「今天 / 昨天」不认：中文里「今天晚饭」「昨天写的东西」
 * 是拿今天/昨天修饰话题的（今天晚饭吃什么、昨天写的东西在哪），不是「问哪一段时间的记忆」。
 * 把它们当时间窗会把这类话题问句也一起重排，属于误伤。
 * @returns {[number, number]|null}
 */
function intentWindow(token) {
	const days = ROLLING_INTENT_DAYS.get(token);
	return days === undefined ? null : [0, days * DAY_MS];
}

/**
 * 查询里有没有时间意图（「刚才 / 刚刚 / 最近」这类词），有的话给出时间窗和命中的时间词。
 * 用分词后的词元比对，不用子串：「金刚」不会被当成「刚」。
 */
export function recencyIntent(query, now) {
	const windows = [];
	const tokens = new Set();
	for (const token of tokenizeForBm25(query).split(/\s+/)) {
		const w = intentWindow(token);
		if (w === null) continue;
		tokens.add(token);
		for (const ch of token) tokens.add(ch); // 多字时间词在 BM25 查询里还会拆成单字
		windows.push(w);
	}
	return windows.length > 0 ? { windows, tokens } : null;
}

/** 记忆有多新（毫秒）：以事情发生的时间为准，updated_at 只作兜底；算不出来就当成很老。 */
function memoryAge(row, now) {
	const at = Number(row?.created_at ?? row?.updated_at);
	if (!Number.isFinite(at)) return Infinity;
	return Math.max(0, now - at);
}

/**
 * 这条记忆有没有对上「内容词」（问句里除时间词、空词以外的整词）。
 *
 * 只要对上**一个**具体词就算 —— 问句是「你刚才刷了什么视频」时，
 * 对上「刷」或「视频」就该算数；要求全对上反而会漏（「刷视频」这种组合很少逐字出现）。
 * 泛词（那个/干/事…）已在上游剔除，这里不重复处理。
 */
function matchesCore(row, core) {
	if (!core || core.size === 0) return false;
	for (const k of splitKeywords(row.keywords)) if (core.has(k)) return true;
	return false;
}

/** 记忆的年龄落在任一时间窗里吗。 */
function inWindows(age, windows) {
	for (const [min, max] of windows) if (age >= min && age <= max) return true;
	return false;
}

/**
 * 这条记忆在「带时间词」的查询里该不该被加权：落在时间窗里就加权，否则不加。
 * 只改排序权重，不改记忆本身（不改内容、不改重要度、不新建记忆）。
 */
export function recencyWeight(row, now, intent) {
	if (!intent || !Array.isArray(intent.windows) || intent.windows.length === 0) return 1;
	return inWindows(memoryAge(row, now), intent.windows) ? RECENCY_BOOST : 1;
}

/**
 * 时间意图挑中的近期记忆：落在时间窗里、且对上了内容词的。
 * 只对上了时间词的不算 —— 记忆正文里也写着「最近」时，那是话题词（「我最近心情怎么样」），
 * 不是"问最近的"，硬提上来只会把不相干的近期记忆塞到前面。
 */
function freshSet(scored, rows, intent, core, now) {
	const at = new Map(rows.map((r) => [r.id, r]));
	const ids = new Set();
	for (const s of scored) {
		const row = at.get(s.id);
		if (!inWindows(memoryAge(row, now), intent.windows)) continue;
		// 必须命中**实词**才算对上了这个话题。
		// 泛词（那个/干/事…）不在 core 里 —— 「上次那个梗」的实词是「梗」，
		// 一条只含「那个」的刷视频记忆因此进不来（真机踩过：问梗、答刷视频）。
		if (!matchesCore(row, core)) continue;
		ids.add(s.id);
	}
	return ids;
}

/**
 * 时间意图的候选池：挑中的近期记忆提到池子前面（按新到旧，跟 browse.js 瞬态块一个顺序），
 * 老行为的前 50 原样跟在后面 —— 只加不减，谁都没被挤掉。
 * 必须在这一步做 —— BM25 前 50 的截断就在这里，截完再加权救不回已经被砍掉的。
 */
function poolWithRecent(scored, rows, now, fresh) {
	const at = new Map(rows.map((r) => [r.id, r]));
	const age = (s) => memoryAge(at.get(s.id), now);
	const promoted = scored.filter((s) => fresh.has(s.id)).sort((a, b) => age(a) - age(b)).slice(0, MAX_PROMOTED_RECENT);
	const promotedIds = new Set(promoted.map((s) => s.id));
	const old = scored.slice(0, 50).filter((s) => !promotedIds.has(s.id));
	return [...promoted, ...old];
}

export function recallSync({ db, clock, config, characterId, ownerId, query, vec, excludePrivate = false, explain = false }) {
	const topK = config.topK ?? 5;
	const rows = loadCandidates(db, characterId, ownerId, { excludePrivate });
	if (rows.length === 0) return explain ? { recalled: [], others: [], topK, vector: vec !== null && vec !== undefined } : [];
	const { terms: queryTerms, weights: queryWeights } = queryForBm25(query);
	const now = clock.now();
	const intent = recencyIntent(query, now);
	// 内容词 = 问句里除时间词、空词以外的整词（单字扩展太弱，不算）
	// 泛词（那个/干/故事…）单列一档：它们不算内容词，但也不是完全无关 —— 
	// 一条记忆要是只靠它们沾边，就不算"对上了这个话题"。
	const core = intent === null ? new Set() : new Set(queryTerms.filter((t) =>
		!intent.tokens.has(t) && !EMPTY_QUERY_TERMS.has(t) && !GENERIC_QUERY_TERMS.has(t) && (queryWeights.get(t) ?? 1) >= 1));
	// 只有一句聚焦的问话才按时间意图走：没有内容词（「刚才？」）、内容词太多（整段转录）都按老样子
	const useIntent = core.size > 0 && core.size <= MAX_INTENT_CORE_TERMS;
	// 遗忘曲线放在融合之后（两路都淡），BM25 这里不再单独衰减
	// 有时间意图时 BM25 扫全量候选再截断，让窗口内的近期记忆进得来（截断前生效，不是事后加权）
	const bm25All = bm25Search(rows, queryTerms, now, useIntent ? rows.length : 50, { decay: false, weights: queryWeights });
	const maxB = bm25All.length > 0 ? bm25All[0].score : 1;
	const fresh = useIntent ? freshSet(bm25All, rows, intent, core, now) : new Set();
	const bm25Top = useIntent ? poolWithRecent(bm25All, rows, now, fresh) : bm25All;
	const bm25Rank = new Map(bm25Top.map((r, i) => [r.id, i + 1]));
	const bm25Score = new Map(bm25Top.map((r) => [r.id, r.score]));
	// 只靠拆出来的单字对上的，RRF 里也按单字的权重算（排名靠前也不能挤掉真正对上的）
	const bm25Full = new Map(bm25Top.map((r) => [r.id, r.full !== false]));
	const vecActive = vec !== null && vec !== undefined;
	const vecRank = vecActive ? vec.ranks : new Map();
	const vectorizedIds = vecActive
		? new Set(db.prepare(`SELECT memory_id FROM vec WHERE generation_id = ? AND memory_id IN (
			SELECT id FROM memory WHERE character_id = ? AND status = 'active' AND valid_to IS NULL
			AND (owner_id IN ('self', ?) OR (about = ? AND visibility = 'normal'))
			AND (? = 0 OR visibility = 'normal'))`)
			.all(vec.generationId, characterId, ownerId, ownerId, excludePrivate ? 1 : 0).map((r) => r.memory_id))
		: new Set();

	const fusionMethod = config.fusionMethod ?? 'rrf';
	const candidates = [];
	for (const row of rows) {
		const br = bm25Rank.get(row.id);
		const vr = vecRank.get(row.id);
		let score;
		if (fusionMethod === 'weighted') {
			const bNorm = br !== undefined ? (bm25Score.get(row.id) ?? 0) / maxB : 0;
			const vNorm = vr !== undefined ? (51 - vr) / 50 : 0;
			score = 0.5 * bNorm + 0.5 * vNorm;
		} else {
			const bm25Part = br !== undefined ? (bm25Full.get(row.id) ? 1 : CHAR_WEIGHT) / (RRF_K + br) : 0;
			let vecPart = 0;
			if (vr !== undefined) vecPart = 1 / (RRF_K + vr);
			else if (vecActive && !vectorizedIds.has(row.id) && br !== undefined) {
				// 仅在向量路真正参与时才补偿；向量路整体不可用时纯 BM25，不额外偏袒新记忆
				vecPart = PENDING_VEC_COMPENSATION * bm25Part;
			}
			score = bm25Part + vecPart;
		}
		const tier = memoryTier(row, now);
		const tierWeight = memoryTierWeight(tier, config);
		// 时间意图：问「刚才」的，近期记忆加权排在前面（只影响排序，不新增任何记忆）
		const recency = fresh.has(row.id) ? recencyWeight(row, now, intent) : 1;
		if (explain) {
			const decay = decayFactor(row, now);
			candidates.push([row, score * decay * tierWeight * recency, { bm25Rank: br ?? null, vecRank: vr ?? null, raw: score, decay, tier, tierWeight, recency }]);
		} else if (score > 0) candidates.push([row, score * decayFactor(row, now) * tierWeight * recency]);
	}
	candidates.sort((a, b) => b[1] - a[1]);
	if (explain) {
		// 记忆调试器：每条候选的分数和"为什么没想起来"
		const hit = candidates.filter((c) => c[1] > 0);
		const recalledIds = new Set(hit.slice(0, topK).map(([row]) => row.id));
		const view = ([row, final, d], i) => ({
			id: row.id, content: row.content, kind: row.kind, ownerId: row.owner_id, visibility: row.visibility, importance: row.importance,
			createdAt: row.created_at, rank: final > 0 ? i + 1 : null, score: Math.round(final * 1e5) / 1e5, raw: Math.round(d.raw * 1e5) / 1e5,
			decay: Math.round(d.decay * 100) / 100, tier: d.tier, tierWeight: d.tierWeight, recency: d.recency, bm25Rank: d.bm25Rank, vecRank: d.vecRank,
			why: recalledIds.has(row.id) ? '想起来了'
				: final <= 0 ? (vecActive ? '关键词和意思都对不上' : '关键词对不上（向量没开 / 还没算好）')
					: d.decay < 0.3 ? `排第 ${i + 1}，太久没提、淡了（×${Math.round(d.decay * 100) / 100}）` : `排第 ${i + 1}，只取前 ${topK} 条`
		});
		return { recalled: hit.slice(0, topK).map(view), others: candidates.filter(([row]) => !recalledIds.has(row.id)).map(view).slice(0, 30), topK, vector: vecActive };
	}
	return candidates.slice(0, topK).map(([row]) => row);
}

/** 记忆调试器用：这个人在这个场合下根本不会参与检索的记忆（私密的在群里、已归档 / 失效的）。 */
export function excludedMemories(db, characterId, ownerId, { inGroup = false } = {}) {
	return db.prepare(`
		SELECT id, content, kind, visibility, status, valid_to FROM memory
		WHERE character_id = ? AND (owner_id = ? OR about = ?)
		  AND (status != 'active' OR valid_to IS NOT NULL OR (? = 1 AND visibility != 'normal') OR (owner_id != ? AND visibility != 'normal'))
		ORDER BY updated_at DESC LIMIT 20
	`).all(characterId, ownerId, ownerId, inGroup ? 1 : 0, ownerId).map((m) => ({
		id: m.id, content: m.content, kind: m.kind,
		why: m.status !== 'active' ? ({ archived: '已经归档（淡忘）了', superseded: '被新的说法替换了', outdated: '主人标成过时了' }[m.status] ?? `状态是 ${m.status}`)
			: m.valid_to !== null ? '已经被新的说法替换（失效）' : m.visibility !== 'normal' && inGroup ? '私聊里说的，群里不想起' : '别人私聊说的关于他的事，不拿出来'
	}));
}

/** 异步召回（recall 工具用）：先取向量排名再同步融合。 */
export async function recall({ db, embedder, clock, config, characterId, ownerId, query, embeddingCfg, excludePrivate = false }) {
	const vec = await vectorRanks({ db, embedder, characterId, ownerId, query, embeddingCfg })
		.catch(() => null);
	return recallSync({ db, clock, config, characterId, ownerId, query, vec, excludePrivate });
}

/**
 * 单队列双优先级串行 Worker + 世代锁（审查 #08）。
 *
 *  - 实时队列：高优、不限速；失败带退避重试（最多 5 次），不再"失败即丢"；
 *  - 重建队列：按"条"计的 32 条/分钟物理令牌；只有写库成功才推进游标（失败不留空洞），
 *    游标落 kv，重启后 status='building' 自动续传；
 *  - 写库前校验世代 + 模型：配置模型与 vec_meta.model_id 不一致 → 置 stale，拒绝写入混模型向量；
 *  - vec_meta 为空或 dim=0 时，以首个成功响应自举（模型/维度），无需先点"测试连接"。
 */
export class VectorWorker {
	constructor({ db, embedder, clock, getEmbeddingConfig }) {
		this.db = db;
		this.embedder = embedder;
		this.clock = clock;
		this.getEmbeddingConfig = getEmbeddingConfig ?? (() => embedder.getConfig());
		/** @type {Array<{memoryId:number, content:string, generationId:number, attempts:number, notBefore:number}>} */
		this.realtimeQueue = [];
		const meta = readVecMeta(db);
		this.rebuildRunning = meta?.status === 'building';
		this.rebuildCursor = Number(getKv(db, 'vec.rebuildCursor', 0)) || 0;
		this.rebuildGen = meta?.generation_id ?? 1;
		this.rebuildBackoffUntil = 0;
		this.tokens = REBUILD_RATE_PER_MIN;
		this.lastTokenAt = Date.now();
		this.timer = null;
		this.lastError = null;
		this._busy = false;
	}

	start() {
		if (this.timer !== null) return;
		// 🔴 定时器里的 async 必须自己吞错：宿主没有全局 unhandledRejection 兜底，
		//    库被关（插件卸载）或 SQLITE_BUSY 超时时这一轮 reject 会让进程直接退出。
		//    同类（behavior / slang / life / social）都带 catch，只有这里和 soul-memory 漏了。
		this.timer = setInterval(() => { void this.tick().catch((error) => this.log?.('warn', `[fish-soul] 向量索引这一轮出错：${String(error instanceof Error ? error.message : error)}`)); }, 500);
		this.timer.unref?.();
	}

	stop() {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}

	enqueueRealtime(memoryId, content) {
		const gen = readVecMeta(this.db)?.generation_id ?? 1;
		this.realtimeQueue.push({ memoryId, content, generationId: gen, attempts: 0, notBefore: 0 });
	}

	/** 物理钟令牌桶（按条计）。 */
	refillTokens() {
		const now = Date.now();
		this.tokens = Math.min(REBUILD_RATE_PER_MIN, this.tokens + ((now - this.lastTokenAt) / 60_000) * REBUILD_RATE_PER_MIN);
		this.lastTokenAt = now;
		return Math.floor(this.tokens);
	}

	async tick() {
		if (this._busy) return;
		this._busy = true;
		try {
			const now = Date.now();
			const ready = this.realtimeQueue.filter((t) => t.notBefore <= now);
			if (ready.length > 0) {
				const batch = ready.slice(0, REALTIME_BATCH);
				const ids = new Set(batch);
				this.realtimeQueue = this.realtimeQueue.filter((t) => !ids.has(t));
				const ok = await this.embedBatch(batch);
				if (!ok) {
					for (const t of batch) {
						t.attempts += 1;
						if (t.attempts < REALTIME_MAX_ATTEMPTS) {
							t.notBefore = Date.now() + Math.min(60_000, 2_000 * 2 ** t.attempts);
							this.realtimeQueue.push(t);
						}
						// 超过重试次数：留给"重建索引"兜底，覆盖率面板会显示未向量化条数
					}
				}
			} else if (this.rebuildRunning && Date.now() >= this.rebuildBackoffUntil) {
				await this.rebuildStep();
			}
		} catch (error) {
			this.lastError = String(error instanceof Error ? error.message : error);
		} finally {
			this._busy = false;
		}
	}

	/**
	 * 批量 embedding 并写 vec。返回是否成功（失败调用方决定重试/不推进游标）。
	 * @returns {Promise<boolean>}
	 */
	async embedBatch(tasks) {
		if (tasks.length === 0) return true;
		const cfg = this.getEmbeddingConfig();
		const r = await this.embedder.embedDetailed(tasks.map((t) => t.content), {
			timeoutMs: cfg.writeTimeoutMs ?? 10_000
		});
		if (!r.ok) {
			this.lastError = `embedding 失败（${r.error}），已排队重试；对话侧照常 BM25`;
			return false;
		}
		let meta = readVecMeta(this.db);
		const dim = r.vectors[0].length;
		if (meta === null || meta.dim === 0) {
			// 自举：首个成功响应确定模型与维度
			meta = writeVecMeta(this.db, {
				model_id: cfg.model,
				dim,
				status: meta?.status === 'building' ? 'building' : 'ready'
			}, this.clock.now());
			meta = readVecMeta(this.db);
		}
		if (cfg.model !== meta.model_id || dim !== meta.dim) {
			// 配置模型/维度与索引不一致：拒绝写入，标 stale 等用户重建（防同维度混模型）
			writeVecMeta(this.db, { status: 'stale' }, this.clock.now());
			this.lastError = `模型/维度与索引不一致（索引 ${meta.model_id}/${meta.dim}，当前 ${cfg.model}/${dim}），请重建索引`;
			return true; // 不是网络失败，不重试
		}
		const insert = this.db.prepare(`
			INSERT OR REPLACE INTO vec (memory_id, model_id, dim, generation_id, blob)
			VALUES (?, ?, ?, ?, ?)
		`);
		this.db.exec('BEGIN');
		try {
			for (let i = 0; i < tasks.length; i++) {
				if (tasks[i].generationId !== meta.generation_id) continue; // 世代锁
				const alive = this.db.prepare("SELECT 1 FROM memory WHERE id = ? AND status = 'active'").get(tasks[i].memoryId);
				if (alive === undefined) continue; // 飞行期间被 forget
				insert.run(tasks[i].memoryId, meta.model_id, meta.dim, meta.generation_id, normalizeToBlob(r.vectors[i]));
			}
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
		this.lastError = null;
		return true;
	}

	/** 重建推进一小步：按令牌数取批，成功才推进游标并持久化。 */
	async rebuildStep() {
		const meta = readVecMeta(this.db);
		if (meta === null || meta.status !== 'building') {
			this.rebuildRunning = false;
			return;
		}
		const budget = Math.min(REBUILD_MAX_BATCH, this.refillTokens());
		if (budget < 1) return;
		const rows = this.db.prepare(`
			SELECT id, content FROM memory
			WHERE status = 'active' AND valid_to IS NULL AND id > ?
			ORDER BY id ASC LIMIT ?
		`).all(this.rebuildCursor, budget);
		if (rows.length === 0) {
			this.rebuildRunning = false;
			writeVecMeta(this.db, { status: 'ready', built_at: this.clock.now() }, this.clock.now());
			setKv(this.db, 'vec.rebuildCursor', 0);
			return;
		}
		this.tokens -= rows.length;
		const ok = await this.embedBatch(rows.map((r) => ({ memoryId: r.id, content: r.content, generationId: meta.generation_id })));
		if (!ok) {
			this.tokens += rows.length; // 失败不计入限速
			this.rebuildBackoffUntil = Date.now() + 15_000; // 不推进游标，15s 后重试同一批
			return;
		}
		if (readVecMeta(this.db)?.status === 'stale') { this.rebuildRunning = false; return; }
		this.rebuildCursor = rows[rows.length - 1].id;
		setKv(this.db, 'vec.rebuildCursor', this.rebuildCursor);
	}

	/** 启动重建：世代 +1、清空旧 vec、dim 置 0 由首个成功响应自举（换模型时维度可能变化）。 */
	startRebuild({ modelId }) {
		this.rebuildGen = bumpGeneration(this.db, { modelId, dim: 0, nowMs: this.clock.now() });
		this.rebuildCursor = 0;
		setKv(this.db, 'vec.rebuildCursor', 0);
		this.rebuildRunning = true;
		// 实时队列中旧世代任务作废
		this.realtimeQueue = this.realtimeQueue.map((t) => ({ ...t, generationId: this.rebuildGen }));
		return { generationId: this.rebuildGen };
	}

	pauseRebuild() {
		this.rebuildRunning = false;
		writeVecMeta(this.db, { status: 'stale' }, this.clock.now());
	}

	resumeRebuild() {
		const meta = readVecMeta(this.db);
		if (meta !== null) {
			this.rebuildGen = meta.generation_id;
			writeVecMeta(this.db, { status: 'building' }, this.clock.now());
			this.rebuildRunning = true;
		}
	}

	/** 覆盖率快照（路由 /retrieval/state 用）。 */
	coverageSnapshot() {
		const meta = readVecMeta(this.db);
		const gen = meta?.generation_id ?? 1;
		const total = this.db.prepare(
			"SELECT COUNT(*) AS n FROM memory WHERE status = 'active' AND valid_to IS NULL"
		).get().n;
		const vectorized = this.db.prepare(
			'SELECT COUNT(*) AS n FROM vec WHERE generation_id = ?'
		).get(gen).n;
		const unvectorizedNew = this.db.prepare(`
			SELECT COUNT(*) AS n FROM memory m
			WHERE m.status = 'active' AND m.valid_to IS NULL
			  AND NOT EXISTS (SELECT 1 FROM vec v WHERE v.memory_id = m.id AND v.generation_id = ?)
		`).get(gen).n;
		return {
			vectorizedCount: vectorized,
			totalActiveCount: total,
			unvectorizedNewCount: unvectorizedNew,
			rateLimitPerMin: REBUILD_RATE_PER_MIN,
			lastCursorMemoryId: this.rebuildCursor,
			isWorkerRunning: this.rebuildRunning || this.realtimeQueue.length > 0,
			realtimeQueueLength: this.realtimeQueue.length
		};
	}
}
