/**
 * routes.js —— 8 条 HTTP 路由（UI 设计文档 §4 契约）+ 三个工具 + 会话拦截（pre-step）。
 *
 * 宿主机制（以 dsh-archive-vault-desktop 为参照）：ctx.webServer.register({kind:'prefix', path, handler})。
 * 所有写操作路由做 sameOrigin 校验；响应 JSON 字段名与契约 1~8 严格对齐。
 */
import { readVecMeta, writeVecMeta } from './db.js';
import { recall } from './retrieval.js';

const API_PREFIX = '/api/plugins/fish-soul';

function readBody(req) {
	return new Promise((resolveBody, reject) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function sameOrigin(req) {
	const headers = req.headers ?? {};
	const hasFetchSite = headers['sec-fetch-site'] !== undefined;
	if (!hasFetchSite) return true; // 非浏览器客户端（curl 等）不校验
	return headers['sec-fetch-site'] === 'same-origin' || headers['sec-fetch-site'] === 'none';
}

function maskKey(key) {
	if (!key) return '';
	return key.length <= 4 ? '••••' : `sk-••••••••••••••••${key.slice(-4)}`;
}

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {import('./clock.js').VirtualClock} deps.clock
 * @param {import('./retrieval.js').EmbeddingClient} deps.embedder
 * @param {import('./retrieval.js').VectorWorker} deps.worker
 * @param {import('./life.js').LifeEngine} deps.life
 * @param {() => object} deps.getConfig
 * @param {(patch: object) => void} deps.saveConfig 持久化 fish-soul-config.json
 * @param {(level: string, msg: string) => void} [deps.log]
 */
export function registerRoutes(ctx, { db, clock, embedder, worker, life, getConfig, saveConfig, log }) {
	const logger = log ?? (() => {});

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: API_PREFIX,
		handler: async (req, res) => {
			const send = (code, obj) => {
				res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify(obj));
			};
			try {
				const url = new URL(req.url ?? '/', 'http://localhost');
				const path = url.pathname.replace(API_PREFIX, '') || '/';
				const method = req.method ?? 'GET';

				// ── 契约 1：检索配置与索引状态 ──
				if (method === 'GET' && path === '/retrieval/state') {
					const cfg = getConfig();
					const meta = readVecMeta(db);
					const cov = worker.coverageSnapshot();
					return send(200, {
						ok: true,
						config: {
							enabled: cfg.embedding?.enabled !== false,
							baseURL: cfg.embedding?.baseURL ?? '',
							apiKeyMasked: maskKey(cfg.embedding?.apiKey ?? ''),
							hasApiKey: Boolean(cfg.embedding?.apiKey),
							model: cfg.embedding?.model ?? '',
							batchSize: 32,
							timeoutMs: cfg.embedding?.timeoutMs ?? 800,
							fusionMethod: cfg.retrieval?.fusionMethod ?? 'rrf',
							rrfK: 60,
							topK: cfg.retrieval?.topK ?? 5,
							tokenBudget: cfg.retrieval?.tokenBudget ?? 1200
						},
						vecMeta: meta === null ? null : {
							modelId: meta.model_id,
							dim: meta.dim,
							provider: meta.provider,
							generationId: meta.generation_id,
							builtAt: meta.built_at,
							status: meta.status,
							lastProbeLatencyMs: worker.lastProbeLatencyMs ?? null,
							lastError: worker.lastError
						},
						coverage: cov
					});
				}

				// ── 契约 2：保存检索与融合配置（端点/模型变更触发 stale）──
				if (method === 'POST' && path === '/retrieval/config') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const cfg = getConfig();
					const meta = readVecMeta(db);
					const nextEmbedding = {
						...(cfg.embedding ?? {}),
						enabled: body.enabled ?? cfg.embedding?.enabled ?? true,
						baseURL: body.baseURL ?? cfg.embedding?.baseURL ?? '',
						model: body.model ?? cfg.embedding?.model ?? '',
						...(typeof body.apiKey === 'string' && body.apiKey !== '' ? { apiKey: body.apiKey } : {})
					};
					// 端点/模型与已建索引不一致 → stale（审查 #08 世代锁前置提示）
					const staleTriggered = meta !== null && meta.dim > 0 &&
						(nextEmbedding.baseURL !== (cfg.embedding?.baseURL ?? '') ||
						 nextEmbedding.model !== meta.model_id);
					if (staleTriggered) writeVecMeta(db, { status: 'stale' }, clock.now());
					saveConfig({
						embedding: nextEmbedding,
						retrieval: {
							fusionMethod: body.fusionMethod ?? cfg.retrieval?.fusionMethod ?? 'rrf',
							topK: body.topK ?? cfg.retrieval?.topK ?? 5,
							tokenBudget: body.tokenBudget ?? cfg.retrieval?.tokenBudget ?? 1200
						}
					});
					const after = readVecMeta(db);
					return send(200, {
						ok: true,
						staleTriggered,
						vecMeta: after === null ? null : {
							modelId: after.model_id, dim: after.dim,
							generationId: after.generation_id, status: after.status
						}
					});
				}

				// ── 契约 3：测试连接（["ping"]，800ms 物理超时，自动探测 dim）──
				if (method === 'POST' && path === '/retrieval/probe') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const cfg = getConfig();
					// 探测使用请求体里的最新配置（允许用户先改再测，未保存也能测）
					const probeCfg = {
						enabled: true,
						baseURL: body.baseURL ?? cfg.embedding?.baseURL ?? '',
						apiKey: body.apiKey ?? cfg.embedding?.apiKey ?? '',
						model: body.model ?? cfg.embedding?.model ?? '',
						timeoutMs: body.timeoutMs ?? 800
					};
					if (!probeCfg.apiKey || !probeCfg.baseURL || !probeCfg.model) {
						return send(200, {
							ok: false, status: 'error', latencyMs: 0,
							fallbackMode: 'bm25-only', errorCode: 'NO_KEY_OR_ENDPOINT',
							message: '未配置 Key / BaseURL / 模型 · 已自动降级为纯 BM25（对话不受影响）'
						});
					}
					const result = await embedder.probeWith(probeCfg);
					if (!result.ok) {
						worker.lastError = 'probe 失败/超时';
						return send(200, {
							ok: false, status: 'error', latencyMs: result.latencyMs,
							fallbackMode: 'bm25-only', errorCode: 'ETIMEDOUT_800MS',
							message: `连接失败/超时 (${result.latencyMs}ms) · 已自动降级为纯 BM25（对话不受影响）`
						});
					}
					worker.lastProbeLatencyMs = result.latencyMs;
					const meta = readVecMeta(db);
					const dimensionChanged = meta !== null && meta.dim > 0 && meta.dim !== result.detectedDim;
					// 维度变化等同模型变更：触发 stale，等用户重建（审查 #08）
					writeVecMeta(db, {
						model_id: probeCfg.model,
						dim: result.detectedDim,
						...(dimensionChanged ? { status: 'stale' } : {})
					}, clock.now());
					return send(200, {
						ok: true, status: dimensionChanged ? 'stale' : 'ready',
						latencyMs: result.latencyMs, detectedDim: result.detectedDim,
						dimensionChanged,
						generationId: readVecMeta(db)?.generation_id ?? 1,
						message: `可用 · 延迟 ${result.latencyMs}ms`
					});
				}

				// ── 契约 4：重建控制（start/pause/resume）──
				if (method === 'POST' && path === '/retrieval/rebuild') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const action = body.action;
					if (!['start', 'pause', 'resume'].includes(action)) {
						return send(200, { ok: false, error: "action must be 'start' | 'pause' | 'resume'" });
					}
					if (action === 'start') {
						const cfg = getConfig();
						const meta = readVecMeta(db);
						const { generationId } = worker.startRebuild({
							modelId: cfg.embedding?.model ?? meta?.model_id ?? '',
							dim: meta?.dim ?? 0
						});
						return send(200, { ok: true, status: 'building', generationId, ...worker.coverageSnapshot() });
					}
					if (action === 'pause') worker.pauseRebuild();
					else worker.resumeRebuild();
					const meta = readVecMeta(db);
					return send(200, {
						ok: true,
						status: meta?.status ?? 'ready',
						generationId: meta?.generation_id ?? 1,
						...worker.coverageSnapshot()
					});
				}

				// ── 契约 5：自走层状态 ──
				if (method === 'GET' && path === '/life/state') {
					return send(200, { ok: true, ...life.stateSnapshot() });
				}

				// ── 契约 6：主动投递白名单（严格校验，审查 #01）──
				if (method === 'POST' && path === '/life/proactive-config') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const dailyMaxCount = Math.min(2, Math.max(1, Number(body.dailyMaxCount ?? 2)));
					const activeHours = Array.isArray(body.activeHours) ? body.activeHours : [8, 24];
					const [h0, h1] = activeHours;
					if (!(h0 >= 0 && h0 <= 23 && h1 >= 1 && h1 <= 24 && h0 < h1)) {
						return send(200, { ok: false, error: 'activeHours 必须满足 0<=start<end<=24' });
					}
					const groups = Array.isArray(body.targets?.selfGroupChannelIds)
						? body.targets.selfGroupChannelIds : [];
					if (!groups.every((g) => typeof g === 'string' && g.startsWith('group:'))) {
						return send(200, { ok: false, error: 'selfGroupChannelIds 必须全部以 group: 开头' });
					}
					const masterChannel = String(body.targets?.masterPrivateChannelId ?? '');
					if (masterChannel !== '' && !masterChannel.startsWith('private:')) {
						return send(200, { ok: false, error: 'masterPrivateChannelId 必须以 private: 开头' });
					}
					saveConfig({
						proactive: {
							enabled: body.enabled !== false,
							dailyMaxCount,
							activeHours: [h0, h1],
							idleTriggerHours: Number(body.idleTriggerHours ?? 6),
							targets: {
								masterCanonicalId: body.targets?.masterCanonicalId ?? 'user:master',
								masterPrivateChannelId: masterChannel,
								selfGroupChannelIds: groups
							}
						}
					});
					return send(200, { ok: true, savedAt: clock.now() });
				}

				// ── 契约 7：记忆与人物检视 ──
				if (method === 'GET' && path === '/inspector/overview') {
					const ownerFilter = url.searchParams.get('ownerId');
					const meta = readVecMeta(db);
					const gen = meta?.generation_id ?? 1;
					const persons = db.prepare(`
						SELECT canonical_id, qq_uin, display_name, relation_stage, interaction_count, last_seen_at
						FROM person ORDER BY interaction_count DESC LIMIT 50
					`).all();
					const countByOwner = new Map(
						db.prepare(`
							SELECT owner_id, COUNT(*) AS n FROM memory
							WHERE character_id = 'feiyu' AND status = 'active' AND valid_to IS NULL
							GROUP BY owner_id
						`).all().map((r) => [r.owner_id, r.n])
					);
					const memSql = ownerFilter !== null && ownerFilter !== 'all'
						? `SELECT * FROM memory WHERE character_id = 'feiyu' AND status = 'active' AND valid_to IS NULL
						   AND owner_id = ? ORDER BY created_at DESC LIMIT 100`
						: `SELECT * FROM memory WHERE character_id = 'feiyu' AND status = 'active' AND valid_to IS NULL
						   ORDER BY created_at DESC LIMIT 100`;
					const memRows = ownerFilter !== null && ownerFilter !== 'all'
						? db.prepare(memSql).all(ownerFilter)
						: db.prepare(memSql).all();
					const vecGenById = new Map(
						db.prepare('SELECT memory_id, generation_id FROM vec').all().map((r) => [r.memory_id, r.generation_id])
					);
					const pendings = db.prepare(`
						SELECT * FROM pending WHERE character_id = 'feiyu' AND status = 'pending'
						ORDER BY due_at ASC LIMIT 50
					`).all();
					return send(200, {
						ok: true,
						currentGenerationId: gen,
						persons: [
							{ canonicalId: 'feiyu', ownerId: 'self', displayName: '鱼自身 (self)', relationStage: 'close', interactionCount: 0, memoryCount: countByOwner.get('self') ?? 0 },
							...persons.map((p) => ({
								canonicalId: p.canonical_id,
								ownerId: `user:${p.canonical_id}`,
								qqUin: p.qq_uin,
								displayName: p.display_name,
								relationStage: p.relation_stage,
								interactionCount: p.interaction_count,
								lastSeenAt: p.last_seen_at,
								memoryCount: countByOwner.get(`user:${p.canonical_id}`) ?? 0
							}))
						],
						memories: memRows.map((m) => {
							const vg = vecGenById.get(m.id) ?? null;
							return {
								id: m.id, ownerId: m.owner_id, channel: m.channel, channelId: m.channel_id,
								kind: m.kind, content: m.content, keywords: m.keywords,
								importance: m.importance, emotion: m.emotion,
								decayExempt: m.importance >= 3,
								createdAt: m.created_at,
								vecStatus: vg === null ? 'unvectorized_compensated' : (vg === gen ? 'vectorized' : 'stale'),
								vecGenerationId: vg
							};
						}),
						pendings: pendings.map((p) => ({
							id: p.id, ownerId: p.owner_id, channel: p.channel, channelId: p.channel_id,
							dueAt: p.due_at, reason: p.reason, status: p.status
						}))
					});
				}

				// ── 契约 8：删除记忆（级联 vec）或取消待办 ──
				if (method === 'POST' && path === '/inspector/forget') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const id = Number(body.id);
					if (!Number.isInteger(id)) return send(200, { ok: false, error: 'id 必须是整数' });
					if (body.targetType === 'pending') {
						db.prepare("UPDATE pending SET status = 'dropped' WHERE id = ?").run(id);
						return send(200, { ok: true, deletedId: id });
					}
					// memory：valid_to 标记 + 物理删 vec（ON DELETE CASCADE 之外的显式清理，双保险）
					const nowVirtual = clock.now();
					db.exec('BEGIN');
					try {
						db.prepare("UPDATE memory SET status = 'archived', valid_to = ?, updated_at = ? WHERE id = ?")
							.run(nowVirtual, nowVirtual, id);
						db.prepare('DELETE FROM vec WHERE memory_id = ?').run(id);
						db.exec('COMMIT');
					} catch (error) {
						db.exec('ROLLBACK');
						throw error;
					}
					const remaining = db.prepare(
						"SELECT COUNT(*) AS n FROM memory WHERE status = 'active' AND valid_to IS NULL"
					).get().n;
					return send(200, { ok: true, deletedId: id, cascadedVecDeleted: true, remainingActiveCount: remaining });
				}

				return send(404, { ok: false, error: 'not found' });
			} catch (error) {
				logger('error', `[fish-soul] 路由异常：${String(error instanceof Error ? error.message : error)}`);
				return send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
			}
		}
	}), 'dsh-fish-soul: api');
}

/**
 * 会话注入（设计方案 §6/§7，审查 #07）——按宿主真实 seam 实现（fish-memory 同款）：
 *  - 人格卡：`ctx.systemPrompt.section({ name, order, interpolate:false, text })` 静态注入，
 *    order 排在宿主自有段（~10200）之后，保住前缀缓存；返回值是 Cordis disposer 函数；
 *  - 动态瞬态块：`ctx.systemPrompt.context({ ..., interpolate:false, text })`，
 *    宿主会把这段作为一条消息追加到对话末尾（即最新用户消息之前），内容变了才追加——
 *    正好满足 §7「瞬态块不固化进历史、不碰 messages[0]」的要求；
 *  - 互动登记：`agent/inbox/inserted` 事件（fish-memory 实测每个 agent 作用域都能收到）。
 */
export function registerAgentHooks(ctx, deps) {
	const { personaText, buildContextBlock, noteInteraction, log } = deps;

	// 人格卡静态注入（KV Cache 前缀）
	try {
		ctx.effect(() => ctx.systemPrompt.section({
			name: 'fish-soul-persona',
			order: 89000, // 宿主自有段排到 ~10200，人格卡放其后、动态段之前
			interpolate: false,
			text: () => personaText
		}), 'dsh-fish-soul: persona section');
	} catch (error) {
		log('error', `[fish-soul] persona section 挂不上：${String(error instanceof Error ? error.message : error)}`);
	}

	// 瞬态上下文（此刻状态 + Top5 记忆 + 群摘要），每轮由宿主按需取 text()
	try {
		ctx.effect(() => ctx.systemPrompt.context({
			name: 'fish-soul',
			order: 900,
			interpolate: false,
			text: () => buildContextBlock()
		}), 'dsh-fish-soul: transient context');
	} catch (error) {
		log('error', `[fish-soul] context 挂不上：${String(error instanceof Error ? error.message : error)}`);
	}

	// 互动登记：agent/inbox/inserted（宿主实测事件，非每轮都有，收到即记）
	try {
		ctx.on('agent/inbox/inserted', (payload) => {
			try { noteInteraction(payload); } catch { /* 单条失败不影响会话 */ }
		});
	} catch (error) {
		log('error', `[fish-soul] inbox 监听挂不上：${String(error instanceof Error ? error.message : error)}`);
	}
}
