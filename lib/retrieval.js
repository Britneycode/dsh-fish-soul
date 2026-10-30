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
import { bm25Search, splitKeywords, tokenizeForBm25 } from './segment.js';
import { bumpGeneration, readVecMeta, writeVecMeta } from './db.js';

const RRF_K = 60;
const PENDING_VEC_COMPENSATION = 0.85;
const REBUILD_RATE_PER_MIN = 32;
const REALTIME_BATCH = 32;

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
function blobToF32(blob) {
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
	/** @param {() => object} getConfig 读取当前向量配置（enabled/baseURL/apiKey/model/dim/timeoutMs） */
	constructor(getConfig) {
		this.getConfig = getConfig;
	}

	/**
	 * 远程 embedding，fail-open：任何失败返回 null（调用方降级 BM25）。
	 * 超时用真实物理时钟 AbortController（默认 800ms）。
	 * @param {string[]} inputs
	 * @returns {Promise<{vectors: number[][], latencyMs: number} | null>}
	 */
	async embed(inputs) {
		const cfg = this.getConfig();
		if (!cfg.enabled || !cfg.baseURL || !cfg.apiKey || !cfg.model) return null;
		const timeoutMs = cfg.timeoutMs ?? 800;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const started = Date.now();
		try {
			const res = await fetch(`${cfg.baseURL.replace(/\/+$/, '')}/embeddings`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${cfg.apiKey}`
				},
				body: JSON.stringify({ model: cfg.model, input: inputs }),
				signal: controller.signal
			});
			const latencyMs = Date.now() - started;
			if (!res.ok) return null;
			const data = await res.json();
			const rows = Array.isArray(data?.data) ? data.data : [];
			if (rows.length === 0 || !Array.isArray(rows[0]?.embedding)) return null;
			return { vectors: rows.map((r) => r.embedding), latencyMs };
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/** 连通性探测（路由 /probe 用）：发送 ["ping"]，返回维度与延迟或失败。 */
	async probe() {
		const result = await this.embed(['ping']);
		if (result === null) return { ok: false, latencyMs: 804 };
		return { ok: true, latencyMs: result.latencyMs, detectedDim: result.vectors[0].length };
	}
}

/**
 * 召回（§8.2）：BM25 初筛 Top50（含衰减） + 向量点积 Top50 → 补偿 RRF(k=60) 融合。
 * 全程 fail-open：向量不可用直接退化为纯 BM25 排名。
 *
 * @returns {Promise<object[]>} TopK 记忆行（含 content 等完整列）
 */
export async function recall({ db, embedder, clock, config, characterId, ownerId, query }) {
	const topK = config.topK ?? 5;

	// 召回过滤（审查 #07）：角色自身 + 当前说话人
	const rows = db.prepare(`
		SELECT id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion,
		       created_at, updated_at
		FROM memory
		WHERE character_id = ? AND owner_id IN ('self', ?) AND status = 'active' AND valid_to IS NULL
	`).all(characterId, ownerId);
	if (rows.length === 0) return [];

	const nowVirtual = clock.now();
	const queryTerms = splitKeywords(tokenizeForBm25(query));

	// ── BM25 路（衰减后 Top 50）──
	const bm25Top = bm25Search(rows, queryTerms, nowVirtual, 50);
	const bm25Rank = new Map(bm25Top.map((r, i) => [r.id, i + 1]));

	// ── 向量路（fail-open）──
	const meta = readVecMeta(db);
	const gen = meta?.generation_id ?? 1;
	/** @type {Map<number, number>} memory_id → 1-based 向量排名 */
	let vecRank = new Map();
	const embedded = await embedder.embed([query]);
	if (embedded !== null && meta !== null && meta.dim > 0) {
		const qf32 = blobToF32(normalizeToBlob(embedded.vectors[0]));
		// 预过滤：只对有效候选集内的当前世代向量做点积（审查 #06：防脏向量混入）
		const validIds = new Set(rows.map((r) => r.id));
		const vecRows = db.prepare(`
			SELECT v.memory_id, v.blob FROM vec v
			WHERE v.generation_id = ? AND v.dim = ?
		`).all(gen, meta.dim);
		const sims = [];
		for (const vr of vecRows) {
			if (!validIds.has(vr.memory_id)) continue;
			sims.push({ id: vr.memory_id, sim: dot(qf32, blobToF32(vr.blob)) });
		}
		sims.sort((a, b) => b.sim - a.sim);
		vecRank = new Map(sims.slice(0, 50).map((r, i) => [r.id, i + 1]));
	}

	// ── 未向量化集合：无当前世代 vec 记录的候选（审查 #06）──
	const vectorizedIds = new Set(
		db.prepare('SELECT memory_id FROM vec WHERE generation_id = ?').all(gen).map((r) => r.memory_id)
	);

	// ── 补偿 RRF 融合 ──
	const fusionMethod = config.fusionMethod ?? 'rrf';
	const candidates = new Map(); // id → score
	for (const row of rows) {
		const br = bm25Rank.get(row.id);
		const vr = vecRank.get(row.id);
		let score;
		if (fusionMethod === 'weighted') {
			// 加权平均：无量纲标定，仅作备选；BM25 分归一化到 [0,1]
			const maxB = bm25Top.length > 0 ? bm25Top[0].score : 1;
			const bNorm = br !== undefined ? (bm25Top.find((x) => x.id === row.id)?.score ?? 0) / maxB : 0;
			const vNorm = vr !== undefined ? (51 - vr) / 50 : 0;
			score = 0.5 * bNorm + 0.5 * vNorm;
		} else {
			const bm25Part = br !== undefined ? 1 / (RRF_K + br) : 0;
			let vecPart = 0;
			if (vr !== undefined) {
				vecPart = 1 / (RRF_K + vr);
			} else if (!vectorizedIds.has(row.id) && br !== undefined) {
				// 尚未生成当前世代向量 → 0.85× 对称补偿，新记忆不被旧记忆饿死
				vecPart = PENDING_VEC_COMPENSATION * bm25Part;
			}
			score = bm25Part + vecPart;
		}
		if (score > 0) candidates.set(row.id, score);
	}

	const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
	const byId = new Map(rows.map((r) => [r.id, r]));
	return ranked.map(([id]) => byId.get(id));
}

/**
 * 单队列双优先级串行 Worker + 世代锁（审查 #08）。
 *
 *  - 实时队列（remember 新记忆）：高优、不限速、批量 32；
 *  - 重建队列（存量 active 记忆）：低优、32 条/分钟物理令牌、按 memory_id 游标断点续传；
 *  - 写库前校验 task.generation_id === vec_meta.generation_id，不等则丢弃响应。
 */
export class VectorWorker {
	constructor({ db, embedder, clock }) {
		this.db = db;
		this.embedder = embedder;
		this.clock = clock;
		/** @type {Array<{memoryId:number, content:string, generationId:number}>} */
		this.realtimeQueue = [];
		this.rebuildRunning = false;
		this.rebuildCursor = 0; // memory_id 游标（断点续传）
		this.rebuildGen = 1;
		this.tokens = REBUILD_RATE_PER_MIN; // 物理钟令牌桶
		this.lastTokenAt = Date.now();
		this.timer = null;
		this.lastError = null;
	}

	/** 启动主循环（500ms 物理间隔检查一次队列）。 */
	start() {
		if (this.timer !== null) return;
		this.timer = setInterval(() => { void this.tick(); }, 500);
		this.timer.unref?.();
	}

	stop() {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}

	/** remember 写入后调用：新记忆进实时高优队列。 */
	enqueueRealtime(memoryId, content) {
		const gen = readVecMeta(this.db)?.generation_id ?? 1;
		this.realtimeQueue.push({ memoryId, content, generationId: gen });
	}

	/** 物理钟令牌桶：每分钟 32 枚。 */
	takeToken() {
		const now = Date.now();
		this.tokens = Math.min(REBUILD_RATE_PER_MIN, this.tokens + ((now - this.lastTokenAt) / 60_000) * REBUILD_RATE_PER_MIN);
		this.lastTokenAt = now;
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}

	/** 串行消费：实时队列清空后才消费重建队列。 */
	async tick() {
		if (this._busy) return;
		this._busy = true;
		try {
			if (this.realtimeQueue.length > 0) {
				const batch = this.realtimeQueue.splice(0, REALTIME_BATCH);
				await this.embedBatch(batch);
			} else if (this.rebuildRunning) {
				await this.rebuildStep();
			}
		} catch (error) {
			this.lastError = String(error instanceof Error ? error.message : error);
		} finally {
			this._busy = false;
		}
	}

	/** 批量 embedding 并写 vec（世代校验在写库前）。 */
	async embedBatch(tasks) {
		if (tasks.length === 0) return;
		const embedded = await this.embedder.embed(tasks.map((t) => t.content));
		if (embedded === null) {
			// fail-open：本轮放弃，实时任务丢弃（下轮 recall 走补偿 RRF），重建任务等下一 tick
			this.lastError = 'embedding 不可用，已跳过本批（fail-open BM25）';
			return;
		}
		const meta = readVecMeta(this.db);
		if (meta === null) return;
		const insert = this.db.prepare(`
			INSERT OR REPLACE INTO vec (memory_id, model_id, dim, generation_id, blob)
			VALUES (?, ?, ?, ?, ?)
		`);
		for (let i = 0; i < tasks.length; i++) {
			// 世代锁：飞行期间有人重建/切换模型 → 丢弃旧世代响应（审查 #08）
			if (tasks[i].generationId !== meta.generation_id) continue;
			insert.run(tasks[i].memoryId, meta.model_id, meta.dim, meta.generation_id,
				normalizeToBlob(embedded.vectors[i]));
		}
	}

	/** 重建推进一小步：从游标处取一批，限速消费。 */
	async rebuildStep() {
		if (!this.takeToken()) return;
		const meta = readVecMeta(this.db);
		if (meta === null || meta.status !== 'building') {
			this.rebuildRunning = false;
			return;
		}
		const rows = this.db.prepare(`
			SELECT id, content FROM memory
			WHERE status = 'active' AND valid_to IS NULL AND id > ?
			ORDER BY id ASC LIMIT ?
		`).all(this.rebuildCursor, REALTIME_BATCH);
		if (rows.length === 0) {
			// 全量完成
			this.rebuildRunning = false;
			writeVecMeta(this.db, { status: 'ready', built_at: this.clock.now() }, this.clock.now());
			return;
		}
		await this.embedBatch(rows.map((r) => ({ memoryId: r.id, content: r.content, generationId: this.rebuildGen })));
		this.rebuildCursor = rows[rows.length - 1].id;
	}

	/**
	 * 启动重建：事务内世代 +1 并清空旧 vec（审查 #08）。
	 * @returns {{generationId:number}}
	 */
	startRebuild({ modelId, dim }) {
		this.rebuildGen = bumpGeneration(this.db, { modelId, dim, nowMs: this.clock.now() });
		this.rebuildCursor = 0;
		this.rebuildRunning = true;
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
			isWorkerRunning: this.rebuildRunning || this.realtimeQueue.length > 0
		};
	}
}
