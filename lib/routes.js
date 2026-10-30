/**
 * routes.js —— 8 条 HTTP 路由（UI 设计文档 §4 契约）+ 三个工具 + 会话拦截（pre-step）。
 *
 * 宿主机制（以 dsh-archive-vault-desktop 为参照）：ctx.webServer.register({kind:'prefix', path, handler})。
 * 所有写操作路由做 sameOrigin 校验；响应 JSON 字段名与契约 1~8 严格对齐。
 */
import { readFileSync } from 'node:fs';
import { readVecMeta, writeVecMeta, listChatSessions } from './db.js';
import { douyinState, handleDouyinRoute } from './routes-douyin.js';
import { importMemories } from './importer.js';
import { dedicatedWorkspacePath } from './gateway.js';
import { DEFAULT_DAILY_MAX } from './life.js';
import { qrSvg } from './channels/qrcode.js';

const QR_TTL_MS = 170_000;

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
 * @param {import('./gateway.js').ChatGateway} [deps.gateway]
 * @param {import('./channels/snowluma.js').SnowLumaChannel} [deps.channel]
 * @param {import('./channels/bilibili.js').BiliChannel} [deps.bili]
 * @param {import('./channels/bilibili.js').BiliClient} [deps.biliClient]
 * @param {import('./browse.js').BiliBrowser} [deps.browser]
 * @param {import('./channels/douyin.js').DouyinChannel} [deps.douyin]
 * @param {import('./channels/douyin.js').DouyinHost} [deps.douyinHost]
 * @param {import('./douyin-browse.js').DouyinBrowser} [deps.douyinBrowser]
 */
export function registerRoutes(ctx, deps) {
	const { db, clock, embedder, worker, life, getConfig, saveConfig, log, gateway, channel, bili, biliClient, browser } = deps;
	const logger = log ?? (() => {});
	/** 进行中的 B站扫码（密钥只留在服务端） */
	let qr = null;
	const biliState = () => {
		const b = getConfig().bili ?? {};
		const br = b.browse ?? {};
		let todayCount = 0;
		try { todayCount = life.browseState(clock.getRoleDateParts().dateStr).count; } catch { /* 无 */ }
		return {
			enabled: b.enabled === true,
			autoReply: b.autoReply === true,
			masterUid: b.masterUid ?? '',
			allowList: Array.isArray(b.allowList) ? b.allowList : [],
			replyMutual: b.replyMutual !== false,
			links: Array.isArray(b.links) ? b.links : [],
			proactive: b.proactive === true,
			pollSeconds: b.pollSeconds ?? 20,
			browse: {
				enabled: br.enabled !== false,
				perDay: br.perDay ?? 3,
				videosPerSession: br.videosPerSession ?? 3,
				like: br.like === true,
				todayCount,
				running: browser?.running === true
			},
			...(bili?.status() ?? { loggedIn: false }),
			recent: browser?.recent(8) ?? []
		};
	};

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

				// 面板样式（client.js 只留逻辑，样式单独给）
				if (method === 'GET' && path === '/ui/panel.css') {
					res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
					res.end(readFileSync(new URL('./panel.css', import.meta.url), 'utf8'));
					return;
				}

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
						const hint = {
							HTTP_401: 'Key 无效或已过期', HTTP_403: 'Key 无权限', HTTP_404: 'BaseURL 或模型名不对',
							HTTP_429: '被限流', NETWORK: '网络不可达', BAD_RESPONSE: '返回格式不是 OpenAI embeddings'
						}[result.errorCode] ?? (String(result.errorCode).startsWith('TIMEOUT') ? '超时' : '未知错误');
						worker.lastError = `probe 失败：${result.errorCode}`;
						return send(200, {
							ok: false, status: 'error', latencyMs: result.latencyMs,
							fallbackMode: 'bm25-only', errorCode: result.errorCode,
							message: `${hint}（${result.errorCode}，${result.latencyMs}ms）· 已自动降级为纯 BM25（对话不受影响）`
						});
					}
					worker.lastProbeLatencyMs = result.latencyMs;
					const meta = readVecMeta(db);
					const indexed = meta !== null && meta.dim > 0;
					const dimensionChanged = indexed && meta.dim !== result.detectedDim;
					const modelChanged = indexed && meta.model_id !== probeCfg.model;
					// 只有"尚无索引"时才用探测结果初始化 vec_meta；已有索引时绝不覆盖 model_id/dim——
					// 旧实现在同维度换模型时直接改写 model_id，新旧模型向量混在同一世代且不提示重建。
					if (!indexed) {
						writeVecMeta(db, { model_id: probeCfg.model, dim: result.detectedDim }, clock.now());
					} else if (dimensionChanged || modelChanged) {
						writeVecMeta(db, { status: 'stale' }, clock.now());
					}
					const stale = dimensionChanged || modelChanged;
					return send(200, {
						ok: true, status: stale ? 'stale' : 'ready',
						latencyMs: result.latencyMs, detectedDim: result.detectedDim,
						dimensionChanged, modelChanged,
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
							modelId: cfg.embedding?.model ?? meta?.model_id ?? ''
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
					// 只限她自发的主动消息；你交代的提醒不占这个数
					const rawMax = Number(body.dailyMaxCount ?? DEFAULT_DAILY_MAX);
					const dailyMaxCount = Number.isFinite(rawMax) ? Math.min(50, Math.max(0, Math.floor(rawMax))) : DEFAULT_DAILY_MAX;
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

				// ── 契约 9：记忆导入（迁移：dsh-fish-memory 导出 / 任意 JSON 数组）──
				// body: { items: [{ content, kind?, qqUin?|ownerId?, channel?, channelId?, createdAt?, importance?, emotion? }], dryRun? }
				if (method === 'POST' && path === '/import/memories') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const items = Array.isArray(body.items) ? body.items : [];
					const result = importMemories({ db, clock, worker, items, dryRun: body.dryRun === true, masterQqUin: getConfig().masterQqUin ?? '' });
					return send(200, { ok: true, ...result });
				}

				// ── 契约 10：QQ 接入与会话状态 ──
				if (method === 'GET' && path === '/channels/state') {
					const cfg = getConfig();
					const q = cfg.qq ?? {};
					const current = gateway?.workspacePath() ?? dedicatedWorkspacePath();
					const workspaces = gateway?.listWorkspaces() ?? [];
					return send(200, {
						ok: true,
						masterQqUin: cfg.masterQqUin ?? '',
						qq: {
							enabled: q.enabled === true,
							wsUrl: q.wsUrl ?? 'ws://127.0.0.1:3001',
							hasToken: Boolean(q.accessToken),
							tokenMasked: maskKey(q.accessToken ?? ''),
							groupAllowList: Array.isArray(q.groupAllowList) ? q.groupAllowList : [],
							followUpCount: q.followUpCount ?? 3,
							followUpSeconds: q.followUpSeconds ?? 120,
							...(channel?.status() ?? { connected: false })
						},
						bili: biliState(),
						douyin: douyinState(deps),
						sessions: {
							workspacePath: current,
							dedicatedPath: dedicatedWorkspacePath(),
							isDedicated: current === dedicatedWorkspacePath(),
							workspaces,
							chats: [...listChatSessions(db, 'qq'), ...listChatSessions(db, 'bili'), ...listChatSessions(db, 'douyin')].map((r) => ({
								channelId: r.channel_id, title: r.title, sessionId: r.session_id,
								workspacePath: r.workspace_path, lastInboundAt: r.last_inbound_at, createdAt: r.created_at
							}))
						}
					});
				}

				// ── 契约 11：保存 QQ 接入配置（连接参数变了就重连）──
				if (method === 'POST' && path === '/channels/qq-config') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const cur = getConfig().qq ?? {};
					const wsUrl = String(body.wsUrl ?? cur.wsUrl ?? 'ws://127.0.0.1:3001').trim();
					if (!/^wss?:\/\//i.test(wsUrl)) return send(200, { ok: false, error: 'wsUrl 必须以 ws:// 或 wss:// 开头' });
					const groups = Array.isArray(body.groupAllowList) ? body.groupAllowList.map((g) => String(g).replace(/^group:/, '').trim()) : (cur.groupAllowList ?? []);
					if (!groups.every((g) => /^\d{4,12}$/.test(g))) return send(200, { ok: false, error: '群号只能是数字' });
					const master = body.masterQqUin === undefined ? undefined : String(body.masterQqUin).trim();
					if (master !== undefined && master !== '' && !/^\d{5,12}$/.test(master)) return send(200, { ok: false, error: '主人 QQ 号只能是数字' });
					const next = {
						enabled: body.enabled === undefined ? cur.enabled === true : body.enabled === true,
						wsUrl,
						...(typeof body.accessToken === 'string' && body.accessToken !== '' ? { accessToken: body.accessToken.trim() } : {}),
						...(body.clearToken === true ? { accessToken: '' } : {}),
						groupAllowList: groups,
						followUpCount: Math.min(20, Math.max(0, Math.floor(Number(body.followUpCount ?? cur.followUpCount ?? 3)) || 0)),
						followUpSeconds: Math.min(1800, Math.max(0, Math.floor(Number(body.followUpSeconds ?? cur.followUpSeconds ?? 120)) || 0))
					};
					const connectionChanged = next.enabled !== (cur.enabled === true) || next.wsUrl !== cur.wsUrl ||
						(next.accessToken !== undefined && next.accessToken !== cur.accessToken);
					saveConfig({ qq: next, ...(master !== undefined ? { masterQqUin: master } : {}) });
					if (connectionChanged) channel?.restart();
					return send(200, { ok: true, reconnecting: connectionChanged });
				}

				// ── 契约 12：选会话工作区（只影响之后新建的会话）──
				// body: { path } 选已有工作区；{ dedicated: true } 新建/选用专用工作区
				if (method === 'POST' && path === '/sessions/workspace') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					let target;
					if (body.dedicated === true) {
						target = dedicatedWorkspacePath();
					} else {
						target = String(body.path ?? '').trim();
						const known = (gateway?.listWorkspaces() ?? []).some((w) => w.path === target);
						if (!known) return send(200, { ok: false, error: '只能选 DSH 里已有的工作区' });
					}
					if (gateway) await gateway.ensureWorkspace(target);
					saveConfig({ sessions: { workspacePath: target === dedicatedWorkspacePath() ? '' : target } });
					return send(200, { ok: true, workspacePath: target });
				}

				// ── 契约 13：全部迁到当前工作区（每个聊天重建一个空会话，记忆不动）──
				if (method === 'POST' && path === '/sessions/migrate') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					if (!gateway) return send(200, { ok: false, error: '网关未启动' });
					const result = await gateway.migrateAll();
					return send(200, { ok: true, ...result });
				}

				// ── 契约 14：B站设置（私信 / 刷视频；总开关变了就重启轮询）──
				if (method === 'POST' && path === '/channels/bili-config') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const cur = getConfig().bili ?? {};
					const digits = (list, label) => {
						const out = (Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean);
						if (!out.every((x) => /^\d{1,20}$/.test(x))) throw new Error(`${label}只能填数字 UID`);
						return out;
					};
					const masterUid = body.masterUid === undefined ? String(cur.masterUid ?? '') : String(body.masterUid).trim();
					if (masterUid !== '' && !/^\d{1,20}$/.test(masterUid)) return send(200, { ok: false, error: '主人 B站 UID 只能是数字' });
					const links = body.links === undefined ? (cur.links ?? []) : (Array.isArray(body.links) ? body.links : [])
						.map((x) => String(x).trim()).filter(Boolean);
					if (!links.every((x) => /^\d{1,20}\s*[=:：]\s*\d{5,12}$/.test(x))) return send(200, { ok: false, error: '对应关系每行写成「B站UID=QQ号」' });
					const clamp = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(v ?? d)) || 0));
					const br = body.browse ?? {};
					const cb = cur.browse ?? {};
					let next;
					try {
						next = {
							enabled: body.enabled === undefined ? cur.enabled === true : body.enabled === true,
							autoReply: body.autoReply === undefined ? cur.autoReply === true : body.autoReply === true,
							masterUid,
							allowList: body.allowList === undefined ? (cur.allowList ?? []) : digits(body.allowList, '白名单'),
							replyMutual: body.replyMutual === undefined ? cur.replyMutual !== false : body.replyMutual === true,
							links,
							proactive: body.proactive === undefined ? cur.proactive === true : body.proactive === true,
							pollSeconds: clamp(body.pollSeconds, cur.pollSeconds ?? 20, 10, 300),
							browse: {
								enabled: br.enabled === undefined ? cb.enabled !== false : br.enabled === true,
								perDay: clamp(br.perDay, cb.perDay ?? 3, 0, 12),
								videosPerSession: clamp(br.videosPerSession, cb.videosPerSession ?? 3, 1, 6),
								like: br.like === undefined ? cb.like === true : br.like === true
							}
						};
					} catch (error) {
						return send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
					}
					const restart = next.enabled !== (cur.enabled === true);
					saveConfig({ bili: next });
					if (restart) bili?.restart();
					return send(200, { ok: true });
				}

				// ── 契约 15：B站扫码登录（生成二维码 / 轮询状态）──
				if (method === 'POST' && path === '/bili/qr/start') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					if (!biliClient) return send(200, { ok: false, error: 'B站模块没加载' });
					const { url: qrUrl, key } = await biliClient.qrStart();
					if (!qrUrl || !key) return send(200, { ok: false, error: 'B站没给二维码' });
					qr = { key, at: Date.now() };
					return send(200, { ok: true, svg: qrSvg(qrUrl, { scale: 5 }), expiresInSec: Math.floor(QR_TTL_MS / 1000) });
				}
				if (method === 'POST' && path === '/bili/qr/poll') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					if (qr === null || Date.now() - qr.at > QR_TTL_MS) { qr = null; return send(200, { ok: true, status: 'expired' }); }
					const r = await biliClient.qrPoll(qr.key);
					if (r.status === 'expired' || r.status === 'ok') qr = null;
					if (r.status === 'ok') bili?.restart();
					return send(200, { ok: true, ...r });
				}

				// ── 契约 16：B站 Cookie 登录 / 退出 ──
				if (method === 'POST' && path === '/bili/cookie') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					let r;
					try { r = await biliClient.loginWithCookie(String(body.cookie ?? ''), String(body.acTimeValue ?? '')); } catch (error) {
						return send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
					}
					bili?.restart();
					return send(200, { ok: true, ...r });
				}
				if (method === 'POST' && path === '/bili/logout') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					biliClient?.logout();
					bili?.restart();
					return send(200, { ok: true });
				}

				// ── 契约 17：现在刷一轮（后台跑，设置页刷新"最近看过"）──
				if (method === 'POST' && path === '/bili/browse-now') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					if ((getConfig().bili ?? {}).enabled !== true) return send(200, { ok: false, error: '先打开 B站总开关' });
					if (!browser || browser.running) return send(200, { ok: false, error: '正在刷，稍等' });
					void browser.run({}).catch((error) => logger('warn', `[fish-soul] 手动刷 B站失败：${String(error instanceof Error ? error.message : error)}`));
					return send(200, { ok: true, started: true });
				}

				// ── 契约 18–24：抖音（设置 / 浏览器 / 登录截图 / 自检 / 现在刷一下）──
				if (await handleDouyinRoute({ method, path, req, send, readBody, sameOrigin, deps })) return;

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
 *  - 互动登记：`agent/inbox/inserted` 事件，payload 是 `{ agent, message }`
 *    （message.content 是块数组、message.source 是来源）。
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
			text: (arg) => buildContextBlock(arg)
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
