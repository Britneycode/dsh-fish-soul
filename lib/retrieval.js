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
import { decayFactor } from './soul-memory.js';
import { bumpGeneration, getKv, readVecMeta, setKv, writeVecMeta } from './db.js';

const RRF_K = 60;
const PENDING_VEC_COMPENSATION = 0.85;
const REBUILD_RATE_PER_MIN = 32;
const REALTIME_BATCH = 32;
const REBUILD_MAX_BATCH = 8;
const REALTIME_MAX_ATTEMPTS = 5;

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
export function vectorIndexUsable(meta, embeddingCfg) {
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
	const validIds = new Set(loadCandidates(db, characterId, ownerId).map((r) => r.id));
	const vecRows = db.prepare('SELECT memory_id, blob FROM vec WHERE generation_id = ? AND dim = ?')
		.all(meta.generation_id, meta.dim);
	const sims = [];
	for (const vr of vecRows) {
		if (!validIds.has(vr.memory_id)) continue;
		sims.push({ id: vr.memory_id, sim: dot(qf32, blobToF32(vr.blob)) });
	}
	sims.sort((a, b) => b.sim - a.sim);
	return { generationId: meta.generation_id, ranks: new Map(sims.slice(0, 50).map((r, i) => [r.id, i + 1])) };
}

/**
 * 同步召回（§8.2）：BM25（含衰减）+ 可选的已预取向量排名 → 补偿 RRF。
 * 同步是为了在 systemPrompt.context 的同步 text() 里拿到"本轮"结果，消除一轮滞后。
 */
export function recallSync({ db, clock, config, characterId, ownerId, query, vec, excludePrivate = false }) {
	const topK = config.topK ?? 5;
	const rows = loadCandidates(db, characterId, ownerId, { excludePrivate });
	if (rows.length === 0) return [];
	const queryTerms = splitKeywords(tokenizeForBm25(query));
	const now = clock.now();
	// 遗忘曲线放在融合之后（两路都淡），BM25 这里不再单独衰减
	const bm25Top = bm25Search(rows, queryTerms, now, 50, { decay: false });
	const bm25Rank = new Map(bm25Top.map((r, i) => [r.id, i + 1]));
	const bm25Score = new Map(bm25Top.map((r) => [r.id, r.score]));
	const vecActive = vec !== null && vec !== undefined;
	const vecRank = vecActive ? vec.ranks : new Map();
	const vectorizedIds = vecActive
		? new Set(db.prepare('SELECT memory_id FROM vec WHERE generation_id = ?').all(vec.generationId).map((r) => r.memory_id))
		: new Set();

	const fusionMethod = config.fusionMethod ?? 'rrf';
	const maxB = bm25Top.length > 0 ? bm25Top[0].score : 1;
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
			const bm25Part = br !== undefined ? 1 / (RRF_K + br) : 0;
			let vecPart = 0;
			if (vr !== undefined) vecPart = 1 / (RRF_K + vr);
			else if (vecActive && !vectorizedIds.has(row.id) && br !== undefined) {
				// 仅在向量路真正参与时才补偿；向量路整体不可用时纯 BM25，不额外偏袒新记忆
				vecPart = PENDING_VEC_COMPENSATION * bm25Part;
			}
			score = bm25Part + vecPart;
		}
		if (score > 0) candidates.push([row, score * decayFactor(row, now)]);
	}
	return candidates.sort((a, b) => b[1] - a[1]).slice(0, topK).map(([row]) => row);
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
		this.timer = setInterval(() => { void this.tick(); }, 500);
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
