/**
 * routes.js —— 8 条 HTTP 路由（UI 设计文档 §4 契约）+ 三个工具 + 会话拦截（pre-step）。
 *
 * 宿主机制（以 dsh-archive-vault-desktop 为参照）：ctx.webServer.register({kind:'prefix', path, handler})。
 * 所有写操作路由做 sameOrigin 校验；响应 JSON 字段名与契约 1~8 严格对齐。
 * 渠道（QQ / B站 / 抖音）路由在这里和 routes-douyin.js；v0.6 的记忆纠正 / 人物画像 / 动态 / 暂停 / 备份 /
 * 聊天记录导入在 routes-soul.js；v0.7 的模型 / 用量 / 语音 / 表情包 / 群里的说法 / 首次引导在 routes-v07.js（UI 文档契约 21~31）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { readVecMeta, writeVecMeta, listChatSessions } from './db.js';
import { douyinState, handleDouyinRoute } from './routes-douyin.js';
import { douyinSessionHealth } from './douyin-http.js';
import { describeHealth } from './session-health.js';
import { handleSoulRoute, sourceLabel } from './routes-soul.js';
import { handleV07Route } from './routes-v07.js';
import { handleV09Route } from './routes-v09.js';
import { handleUpdateRoute } from './routes-update.js';
import { handleWorldInfoRoute } from './routes-worldinfo.js';
import { handlePersonaRoute } from './routes-persona.js';
import { pluginVersion } from './update-check.js';
import { stickerConfig } from './stickers.js';
import { slangConfig } from './slang.js';
import { importMemories } from './importer.js';
import { bulkMemory, filterWhere } from './memory-bulk.js';
import { dedicatedWorkspacePath, interjectConfig } from './gateway.js';
import { DEFAULT_DAILY_MAX, DEFAULT_IDLE_REAL_GAP_MIN } from './life.js';
import { qrSvg } from './channels/qrcode.js';
import { normalizeConfig } from './qq-group-admin.js';

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

/** API key 打码（routes-v07 也用同一套）。 */
export function maskKey(key) {
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
	const { db, clock, embedder, worker, life, getConfig, saveConfig, log, gateway, channel, bili, biliClient, browser, biliSocial } = deps;
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
				share: br.share !== false,
				favorite: br.favorite === true,
				favoritePerDay: br.favoritePerDay ?? 2,
				commentReply: br.commentReply === true,
				commentReplyPerDay: br.commentReplyPerDay ?? 1,
				hotComments: br.hotComments ?? 6,
				repliedToday: browser?.repliedToday?.() ?? 0,
				replyLast: browser?.recentReply?.() ?? null,
				favoritedToday: browser?.favoritedToday?.() ?? 0,
				danmaku: br.danmaku !== false,
				comment: br.comment === true,
				commentPerDay: br.commentPerDay ?? 1,
				commentedToday: browser?.commentedToday?.() ?? 0,
				frames: br.frames === true,
				framesPerDay: br.framesPerDay ?? 1,
				framedToday: browser?.framedToday?.() ?? 0,
				framesPerDayChat: Number(br.framesPerDayChat ?? 10),
				framedTodayChat: browser?.framedTodayChat?.() ?? 0,
				search: br.search === true,
				searchKeywords: Array.isArray(br.searchKeywords) ? br.searchKeywords : [],
				searchPerDay: br.searchPerDay ?? 2,
				maxLinks: br.maxLinks ?? 3,
				subtitleChars: br.subtitleChars ?? 1200,
				descChars: br.descChars ?? 300,
				hotCommentChars: br.hotCommentChars ?? 80,
				searchedToday: browser?.searchedToday?.() ?? 0,
				todayCount,
				running: browser?.running === true
			},
			...(bili?.status() ?? { loggedIn: false }),
			post: { enabled: b.post?.enabled === true, perDay: b.post?.perDay ?? 1 },
			comments: { enabled: b.comments?.enabled === true, perHour: b.comments?.perHour ?? 6, atMe: b.comments?.atMe === true, atReadVideo: b.comments?.atReadVideo === true, replyChars: b.comments?.replyChars ?? 40 },
			recent: browser?.recent(8) ?? [],
			social: biliSocial?.status() ?? null
		};
	};

	const handler = async (req, res) => {
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
					// #75：真实时间护栏（分钟，0 = 关掉）；日程开关
					const rawRealGap = Number(body.idleRealGapMinutes ?? DEFAULT_IDLE_REAL_GAP_MIN);
					const idleRealGapMinutes = Number.isFinite(rawRealGap) ? Math.min(1440, Math.max(0, Math.floor(rawRealGap))) : DEFAULT_IDLE_REAL_GAP_MIN;
					const rawIdleHours = Number(body.idleTriggerHours ?? 6);
					const idleTriggerHours = Number.isFinite(rawIdleHours) ? Math.min(168, Math.max(0, Math.floor(rawIdleHours))) : 6;
					saveConfig({
						proactive: {
							enabled: body.enabled !== false,
							dailyMaxCount,
							activeHours: [h0, h1],
							idleTriggerHours,
							idleRealGapMinutes,
							scheduleEnabled: body.scheduleEnabled !== false,
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
					// 筛选：内容包含 q、来源 source、私密 visibility；limit 最多 500（批量操作要看得到更多）
					const listFilter = filterWhere({ ownerId: ownerFilter, q: url.searchParams.get('q') ?? '', source: url.searchParams.get('source') ?? '', visibility: url.searchParams.get('visibility') ?? '' });
					const listLimit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? 100)) || 100));
					const meta = readVecMeta(db);
					const gen = meta?.generation_id ?? 1;
				const persons = db.prepare(`
					SELECT canonical_id, qq_uin, display_name, relation_stage, interaction_count, last_seen_at
					FROM person WHERE deleted_at IS NULL ORDER BY interaction_count DESC LIMIT 50
				`).all();
					const countByOwner = new Map(
						db.prepare(`
							SELECT owner_id, COUNT(*) AS n FROM memory
							WHERE character_id = 'feiyu' AND status = 'active' AND valid_to IS NULL
							GROUP BY owner_id
						`).all().map((r) => [r.owner_id, r.n])
					);
					const memRows = db.prepare(`SELECT * FROM memory WHERE ${listFilter.sql} ORDER BY created_at DESC LIMIT ${listLimit}`).all(...listFilter.params);
					const matchedTotal = db.prepare(`SELECT COUNT(*) AS n FROM memory WHERE ${listFilter.sql}`).get(...listFilter.params).n;
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
						matchedTotal,
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
								importance: m.importance, importanceLocked: m.importance_locked === 1, importanceAutoRecalled: m.importance_auto_recalled === 1, emotion: m.emotion,
								evidence: m.evidence ?? '', source: sourceLabel(m.source_session),
								decayExempt: m.importance >= 3,
								createdAt: m.created_at, visibility: m.visibility ?? 'normal', about: m.about ?? null, recallCount: m.recall_count ?? 0,
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
					// 批量：ids[]（记忆）
					if (Array.isArray(body.ids) && body.targetType !== 'pending') {
						const r = bulkMemory({ db, clock, worker, ids: body.ids, action: 'forget' });
						if (!r.ok) return send(200, r);
						const remaining = db.prepare("SELECT COUNT(*) AS n FROM memory WHERE status = 'active' AND valid_to IS NULL").get().n;
						return send(200, { ok: true, deletedIds: r.ids, deleted: r.changed, cascadedVecDeleted: true, remainingActiveCount: remaining });
					}
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

				// ── #68：删除整个人物卡（不只是清空记忆）──
				// #66 的「全部删掉」只清空 memory 行，person 行还在 → 广告号占着一个记忆区。
				// 这里把 person 行软删除（deleted_at 标记，不可恢复），顺手清空这个人的
				// memory（走 forget 可恢复）/ pending / mood / profile。
				if (method === 'POST' && path === '/inspector/person/delete') {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					const body = JSON.parse(await readBody(req) || '{}');
					const ownerId = String(body.ownerId ?? '');
					const cid = ownerId.replace(/^user:/, '');
					// 主人（master）和她自己（self）不能删
					if (cid === 'master' || ownerId === 'self' || cid === '' || cid === 'feiyu') {
						return send(200, { ok: false, error: '这个人物卡不能删' });
					}
					const p = db.prepare('SELECT canonical_id FROM person WHERE canonical_id = ?').get(cid);
					if (!p) return send(200, { ok: false, error: '没有这个人' });
					const now = clock.now();
					db.exec('BEGIN');
					try {
						// person 行软删除：记忆区不再列出（不可恢复，但行还在 soul.db 里）
						db.prepare('UPDATE person SET deleted_at = ? WHERE canonical_id = ?').run(now, cid);
						// 这个人的 memory：走 forget（可恢复，在「改掉 / 过时的」里能看到）
						db.prepare("UPDATE memory SET status = 'archived', valid_to = ?, updated_at = ? WHERE owner_id = ? AND status = 'active'")
							.run(now, now, ownerId);
						// pending：标 dropped
						db.prepare("UPDATE pending SET status = 'dropped' WHERE owner_id = ? AND status = 'pending'").run(ownerId);
						// mood / profile kv：删干净（人没了，情绪印象也不留）
						db.prepare('DELETE FROM kv WHERE key IN (?, ?)').run(`mood.${ownerId}`, `profile.${ownerId}`);
						db.exec('COMMIT');
					} catch (error) {
						db.exec('ROLLBACK');
						throw error;
					}
					return send(200, { ok: true, deletedCanonicalId: cid, ownerId });
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
							allGroups: q.allGroups === true,
							followUpCount: q.followUpCount ?? 3,
							followUpSeconds: q.followUpSeconds ?? 120,
							followUpSmart: q.followUpSmart === true,
							batchMs: q.batchMs ?? 3000,
							callNames: Array.isArray(q.callNames) ? q.callNames : [],
							interject: interjectConfig(q.interject),
							groupAdmin: normalizeConfig(q.groupAdmin),
							stickers: stickerConfig(cfg.stickers),
							slang: slangConfig(cfg.slang),
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
								workspacePath: r.workspace_path, lastInboundAt: r.last_inbound_at, createdAt: r.created_at,
								paused: gateway?.isPaused(r.channel_id) === true
							}))
						}
					});
				}

				// ── 一键自检（只读：查不动的那一项标红，不抛 500）──
				if (method === 'GET' && path === '/diagnose') {
					const cfg = getConfig();
					const items = [];
					const item = (key, label, ok, detail, hint) => items.push({ key, label, ok: ok === true, detail: String(detail ?? ''), ...(hint ? { hint } : {}) });
					// 插件版本
					const version = pluginVersion();
					item('version', '插件版本', version !== '0.0.0', version === '0.0.0' ? '读不到 package.json' : `v${version}`);
					// 通道连接（跟 /channels/state 同一份数据）
					const qqSt = channel?.status() ?? null;
					const biliSt = bili?.status() ?? null;
					const douyinSt = deps.douyin?.status() ?? null;
					const qqOn = cfg.qq?.enabled === true;
					const biliOn = cfg.bili?.enabled === true;
					const douyinOn = cfg.douyin?.enabled === true;
					const chanOk = (!qqOn || qqSt?.connected === true) && (!biliOn || biliSt?.loggedIn === true) && (!douyinOn || douyinSt?.state === 'running');
					item('channels', '通道连接', chanOk, [
						qqOn ? (qqSt?.connected === true ? 'QQ 已连' : 'QQ 没连上') : 'QQ 没开',
						biliOn ? (biliSt?.loggedIn === true ? 'B站 已登录' : 'B站 没登录') : 'B站 没开',
						douyinOn ? (douyinSt?.state === 'running' ? '抖音 在跑' : '抖音 没跑') : '抖音 没开'
					].join(' · '));
					// QQ 登录态（SnowLuma 连上没有、登的是哪个号）
					item('qq', 'QQ 登录态', qqSt?.connected === true, qqSt?.connected === true
						? `已登录 ${qqSt.nickname || qqSt.selfId || ''}${qqSt.friendCount != null ? ` · ${qqSt.friendCount} 位好友` : ''}`.trim()
						: (qqOn ? `没连上${qqSt?.lastError ? '：' + qqSt.lastError : ''}` : 'QQ 没开'));
					// 抖音登录态还剩多久（只读本地 cookie 文件里的 sid_guard，不联网不抓浏览器）
					//
					// 为什么值得单独一项：抖音掉登录的表现和「签名错了」「被风控」一模一样
					// （都是 status_code 8 / 空 body），查的时候分不清。sid_guard 自带签发时间，
					// 一眼就能看出是「登录快没了」还是「别的问题」。
					const dyHealth = douyinSessionHealth();
					const dyDesc = describeHealth(dyHealth, { warnHours: 24 });
					item('douyin-session', '抖音登录', dyDesc.ok, dyDesc.detail,
						dyHealth === null ? '没抓过 cookie，或者抖音还没登录过' : undefined);
					// 记忆条数
					try {
						const n = db.prepare("SELECT COUNT(*) AS n FROM memory WHERE status = 'active' AND valid_to IS NULL").get().n;
						item('memory', '记忆条数', true, `${n} 条`);
					} catch (error) {
						item('memory', '记忆条数', false, `查不到：${String(error instanceof Error ? error.message : error).slice(0, 80)}`);
					}
					// 今日次数（插嘴 / 主动开口）
					try {
						const today = new Date().toDateString();
						const interject = (gateway?.decisions ?? []).filter((d) => d.kind === 'interject' && new Date(d.at).toDateString() === today).length;
						let proactive = 0;
						try { proactive = Number(life?.stateSnapshot?.()?.today?.proactiveCount ?? 0); } catch { /* 无 */ }
						item('today', '今日次数', true, `插嘴 ${interject} 次 · 主动开口 ${proactive} 次`, '插嘴次数只统计本次启动后（动态缓冲最多 300 条）');
					} catch (error) {
						item('today', '今日次数', false, `查不到：${String(error instanceof Error ? error.message : error).slice(0, 80)}`);
					}
					// 补丁状态（插件包里的 cordis.patch.yml 在不在）
					const patchOk = existsSync(new URL('../cordis.patch.yml', import.meta.url));
					item('patch', '补丁状态', patchOk, patchOk ? 'cordis.patch.yml 在' : '没找到 cordis.patch.yml（插件可能没装全）');
					return send(200, { ok: true, items });
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
					// 群管理（公告 / 入群申请）：设置页没带这一段就沿用现在的，别被保存冲掉
					const groupAdmin = normalizeConfig(body.groupAdmin === undefined
						? cur.groupAdmin
						: { ...(cur.groupAdmin ?? {}), ...body.groupAdmin });
					if (groupAdmin.groupId !== '' && !/^\d{4,12}$/.test(groupAdmin.groupId)) return send(200, { ok: false, error: '群号只能是数字' });
					const next = {
						enabled: body.enabled === undefined ? cur.enabled === true : body.enabled === true,
						wsUrl,
						...(typeof body.accessToken === 'string' && body.accessToken !== '' ? { accessToken: body.accessToken.trim() } : {}),
						...(body.clearToken === true ? { accessToken: '' } : {}),
						groupAllowList: groups,
						allGroups: body.allGroups === undefined ? cur.allGroups === true : body.allGroups === true,
						followUpCount: Math.min(20, Math.max(0, Math.floor(Number(body.followUpCount ?? cur.followUpCount ?? 3)) || 0)),
						followUpSeconds: Math.min(1800, Math.max(0, Math.floor(Number(body.followUpSeconds ?? cur.followUpSeconds ?? 120)) || 0)),
						followUpSmart: body.followUpSmart === undefined ? cur.followUpSmart === true : body.followUpSmart === true,
						batchMs: Math.min(15000, Math.max(0, Math.floor(Number(body.batchMs ?? cur.batchMs ?? 3000)) || 0)),
						callNames: Array.isArray(body.callNames) ? body.callNames.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : (cur.callNames ?? []),
						interject: interjectConfig(body.interject === undefined ? cur.interject : { ...(cur.interject ?? {}), ...body.interject }),
						groupAdmin
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
								like: br.like === undefined ? cb.like === true : br.like === true,
								share: br.share === undefined ? cb.share !== false : br.share === true,
								favorite: br.favorite === undefined ? cb.favorite === true : br.favorite === true,
								favoritePerDay: clamp(br.favoritePerDay, cb.favoritePerDay ?? 2, 0, 30),
								commentReply: br.commentReply === undefined ? cb.commentReply === true : br.commentReply === true,
								commentReplyPerDay: clamp(br.commentReplyPerDay, cb.commentReplyPerDay ?? 1, 0, 20),
								hotComments: clamp(br.hotComments, cb.hotComments ?? 6, 0, 30),
								danmaku: br.danmaku === undefined ? cb.danmaku !== false : br.danmaku === true,
								comment: br.comment === undefined ? cb.comment === true : br.comment === true,
								commentPerDay: clamp(br.commentPerDay, cb.commentPerDay ?? 1, 0, 20),
								frames: br.frames === undefined ? cb.frames === true : br.frames === true,
								framesPerDay: clamp(br.framesPerDay, cb.framesPerDay ?? 1, 0, 15),
								framesPerDayChat: clamp(br.framesPerDayChat, cb.framesPerDayChat ?? 10, 0, 30),
								search: br.search === undefined ? cb.search === true : br.search === true,
								searchKeywords: (Array.isArray(br.searchKeywords) ? br.searchKeywords : (cb.searchKeywords ?? []))
									.map((w) => String(w ?? '').trim().slice(0, 30)).filter((w) => w !== '').slice(0, 20),
								searchPerDay: clamp(br.searchPerDay, cb.searchPerDay ?? 2, 0, 12),
								maxLinks: clamp(br.maxLinks, cb.maxLinks ?? 3, 1, 5),
								subtitleChars: clamp(br.subtitleChars, cb.subtitleChars ?? 1200, 0, 3000),
								descChars: clamp(br.descChars, cb.descChars ?? 300, 0, 1000),
								hotCommentChars: clamp(br.hotCommentChars, cb.hotCommentChars ?? 80, 0, 500)
							},
							post: {
								enabled: body.post?.enabled === undefined ? cur.post?.enabled === true : body.post.enabled === true,
								perDay: clamp(body.post?.perDay, cur.post?.perDay ?? 1, 0, 5)
							},
							comments: {
								enabled: body.comments?.enabled === undefined ? cur.comments?.enabled === true : body.comments.enabled === true,
								perHour: clamp(body.comments?.perHour, cur.comments?.perHour ?? 6, 0, 30),
								atMe: body.comments?.atMe === undefined ? cur.comments?.atMe === true : body.comments.atMe === true,
								atReadVideo: body.comments?.atReadVideo === undefined ? cur.comments?.atReadVideo === true : body.comments.atReadVideo === true,
								replyChars: clamp(body.comments?.replyChars, cur.comments?.replyChars ?? 40, 10, 300)
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

				// ── v0.10：现在发一条动态 / 现在看一眼评论 ──
				if (method === 'POST' && (path === '/bili/post-now' || path === '/bili/comments-now')) {
					if (!sameOrigin(req)) return send(403, { ok: false, error: 'forbidden' });
					if ((getConfig().bili ?? {}).enabled !== true) return send(200, { ok: false, error: '先打开 B站总开关' });
					if (!biliSocial) return send(200, { ok: false, error: 'B站模块没加载' });
					if (path === '/bili/post-now') {
						if (!biliSocial.cfg().post.enabled) return send(200, { ok: false, error: '先打开「自己发动态」' });
						const r = await biliSocial.post({ force: true });
						return send(200, r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error ?? '没发成' });
					}
					if (!biliSocial.cfg().comments.enabled) return send(200, { ok: false, error: '先打开「回评论」' });
					const r = await biliSocial.pollComments();
					return send(200, r.ok ? { ok: true, replied: r.replied, skipped: r.skipped } : { ok: false, error: r.error ?? '没看成' });
				}

				// ── 契约 18–24：抖音（设置 / 浏览器 / 登录截图 / 自检 / 现在刷一下）──
				if (await handleDouyinRoute({ method, path, req, send, readBody, sameOrigin, deps })) return;
				// ── v0.6：记忆纠正 / 人物画像 / 动态 / 暂停 / 备份 / 聊天记录导入 ──
				if (await handleSoulRoute({ method, path, url, req, res, send, readBody, sameOrigin, deps })) return;
				// ── v0.7：模型 / 用量 / 语音 / 表情包 / 群里的说法 / 首次引导 ──
				if (await handleV07Route({ method, path, url, req, res, send, readBody, sameOrigin, deps })) return;
				// ── v0.9：习惯 / 群设定 / 按聊天选模型 / 记忆调试器 / 日记 ──
				if (await handleV09Route({ method, path, req, send, readBody, sameOrigin, deps })) return;
				// ── 世界书：导入 / 开关 / 扫描深度与预算 / 试一试 ──
				if (await handleWorldInfoRoute({ method, path, req, send, readBody, sameOrigin, deps })) return;
				// ── 版本：当前版本 / 检查更新 / 自动检查开关 ──
				if (await handleUpdateRoute({ method, path, req, send, readBody, sameOrigin, deps })) return;
				// ── 人格：模板 / 编辑 / 导入角色卡 / 撤销 ──
				if (await handlePersonaRoute({ method, path, req, send, readBody, sameOrigin, deps })) return;

				return send(404, { ok: false, error: 'not found' });
			} catch (error) {
				logger('error', `[fish-soul] 路由异常：${String(error instanceof Error ? error.message : error)}`);
				return send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
			}
	};

	// 有闸门（apply 一开始就挂好的前缀路由）就把真正的处理器交给它；没有就按老办法自己挂。
	if (deps.gate) deps.gate.ready(handler);
	else ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'dsh-fish-soul: api');
}

/**
 * 启动闸门：apply 第一行就把 /api/plugins/fish-soul 前缀路由挂上。
 * 初始化没走完时回 503 + 当前步骤；中途失败回 503 + 失败的步骤和原因；走完后转给真正的处理器。
 * 这样设置页 404 只意味着"插件根本没加载"，503 意味着"加载了但卡在 / 挂在某一步"。
 */
export function mountApiGate(ctx, log = () => {}) {
	const state = { phase: 'starting', step: null, index: 0, total: 0, error: null, handler: null };
	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: API_PREFIX,
		handler: async (req, res) => {
			if (state.handler) return state.handler(req, res);
			res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '2' });
			res.end(JSON.stringify({
				ok: false,
				starting: state.phase === 'starting',
				failed: state.phase === 'failed',
				step: state.step, stepIndex: state.index, stepTotal: state.total,
				error: state.error ?? (state.phase === 'starting' ? '插件还在启动' : null)
			}));
		}
	}), 'dsh-fish-soul: api');
	log('info', `[fish-soul] 启动闸门已挂：${API_PREFIX}（初始化完成前回 503）`);
	return {
		get state() { return { ...state, handler: undefined }; },
		setTotal(n) { state.total = n; },
		step(name) { state.index += 1; state.step = name; },
		ready(handler) { state.handler = handler; state.phase = 'ready'; },
		fail(error) {
			// 路由已经交出去了（挂路由之后的步骤失败，比如注册工具）：设置页照常能用，只记下来，不把整页打回 503
			if (state.phase === 'ready') {
				state.lateError = String(error instanceof Error ? error.message : error);
				return;
			}
			state.phase = 'failed';
			state.error = String(error instanceof Error ? error.message : error);
			state.handler = null;
		}
	};
}

/**
 * 人格卡 + 瞬态上下文：**只挂在我们自己的 agent 上**，在 `agents.create/resume` 的 `setup(agentCtx)` 里调。
 *
 * 宿主文档的 seam 就是这样：`agent.ctx` 上的注册只对该 agent 生效、随 agent 释放自动摘掉，
 * 而同名的 scoped 段还会遮蔽全局段（真实宿主 rc.6 已用 probe-per-agent.mjs 验过）。
 * 以前挂在插件的全局 `ctx.systemPrompt` 上，靠 `injectsFor` 回调返回空串来兜，结果宿主里**所有**
 * 会话的每次组装都要先跑一遍这个判断，人格段也真的漏进过用户的技术对话（#40）。
 * 现在不注册全局段 = 别的会话的组装根本看不到我们这两块（#41 的架构方案，按 setup 时序重做）。
 */
export function registerAgentSections(agentCtx, deps) {
	const { personaText, buildContextBlock, log } = deps;

	// 人格卡静态注入（KV Cache 前缀）。order 排在宿主自有段（~10200）之后。
	try {
		agentCtx.effect(() => agentCtx.systemPrompt.section({
			name: 'fish-soul-persona',
			order: 89000,
			interpolate: false,
			text: () => (typeof personaText === 'function' ? personaText() : personaText)
		}), 'dsh-fish-soul: persona section');
	} catch (error) {
		log('error', `[fish-soul] persona section 挂不上：${String(error instanceof Error ? error.message : error)}`);
	}

	// 瞬态上下文（此刻状态 + Top5 记忆 + 群摘要），每轮由宿主按需取 text()
	try {
		agentCtx.effect(() => agentCtx.systemPrompt.context({
			name: 'fish-soul',
			order: 900,
			interpolate: false,
			text: (arg) => buildContextBlock(arg)
		}), 'dsh-fish-soul: transient context');
	} catch (error) {
		log('error', `[fish-soul] context 挂不上：${String(error instanceof Error ? error.message : error)}`);
	}
}

/**
 * 全局钩子（与具体 agent 无关的那部分）：
 *  - 互动登记：`agent/inbox/inserted` 事件，payload 是 `{ agent, message }`
 *    （message.content 是块数组、message.source 是来源）。
 *
 * 人格卡 / 瞬态块的注入不在这里 —— 那是 per-agent 的，见 {@link registerAgentSections}。
 * 注意：别的插件把 QQ 消息转发进它自己建的普通会话时，那个会话不经过我们的 create/resume，
 * 要等 inbox 事件里认出 QQ 身份后，用 `payload.agent.ctx` 补挂（同样是 per-agent，不碰全局）。
 */
export function registerAgentHooks(ctx, deps) {
	const { noteInteraction, log } = deps;

	// 互动登记：agent/inbox/inserted（宿主实测事件，非每轮都有，收到即记）
	try {
		ctx.on('agent/inbox/inserted', (payload) => {
			try { noteInteraction(payload); } catch { /* 单条失败不影响会话 */ }
		});
	} catch (error) {
		log('error', `[fish-soul] inbox 监听挂不上：${String(error instanceof Error ? error.message : error)}`);
	}
}
