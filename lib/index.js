/**
 * dsh-fish-soul —— 人格、按人记忆、日程自走与主动开口（设计方案 v1.1）。
 *
 * 装配：db（soul.db）→ clock（VirtualClock）→ retrieval（召回+Worker）
 *      → life（tick/主动/Dream）→ routes（8 条契约路由）→ 工具与 pre-step。
 *
 * 依赖：零 npm 运行时依赖——node:sqlite 内置驱动、内置 fetch、Intl.Segmenter。
 * schemastery 与 @deepseek-ai/dsh-tools 为宿主常驻依赖（参照 dsh-archive-vault）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadHostDeps } from './hostdeps.mjs';
import { openDatabase, configPath, fishSoulDir, resolveOrCreatePerson, findPersonByQq, readVecMeta, getKv } from './db.js';
import { VirtualClock } from './clock.js';
import { EmbeddingClient, VectorWorker, recall, recallSync, vectorRanks } from './retrieval.js';
import { LifeEngine } from './life.js';
import { registerRoutes, registerAgentHooks } from './routes.js';
import { tokenizeForBm25 } from './segment.js';
import { loadPersona, matchLore, applyMacros } from './persona.js';

// schemastery / dsh-tools 从宿主树解析（hostdeps 模式，fish-memory 同款）：
// 裸 import 在桌面 profile（autoInstallPeers:false）下会让整条插件不激活。
const hostDeps = await loadHostDeps();
const z = hostDeps.z;
const defineTool = hostDeps.defineTool;

export const name = 'dsh-fish-soul';
export const inject = ['webServer', 'tools', 'systemPrompt', 'llm'];

// schemastery 彻底拿不到时省略 Config（插件照常加载，fish-memory 同款降级）
export const Config = z === null ? undefined : z.object({
	masterQqUin: z.string().default(''),
	qqBridge: z.object({
		baseURL: z.string().default('http://127.0.0.1:3000') // OneBot 11 HTTP（与 qq-bridge NapCat 端点一致）
	}).default({}),
	embedding: z.object({
		enabled: z.boolean().default(true),
		baseURL: z.string().default(''),
		apiKey: z.string().default(''),
		model: z.string().default(''),
		timeoutMs: z.number().default(800)
	}).default({}),
	retrieval: z.object({
		fusionMethod: z.string().default('rrf'),
		topK: z.number().default(5),
		tokenBudget: z.number().default(1200)
	}).default({}),
	proactive: z.object({
		enabled: z.boolean().default(true),
		dailyMaxCount: z.number().default(2),
		activeHours: z.array(z.number()).default([8, 24]),
		idleTriggerHours: z.number().default(6),
		targets: z.object({
			masterCanonicalId: z.string().default('user:master'),
			masterPrivateChannelId: z.string().default(''),
			selfGroupChannelIds: z.array(z.string()).default([])
		}).default({})
	}).default({})
});

/** 深合并：over 中的普通对象递归合并，其余值（含数组）整体覆盖；undefined 不覆盖。 */
export function deepMerge(base, over) {
	const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
	if (!isObj(base)) return isObj(over) ? { ...over } : (over === undefined ? base : over);
	const out = { ...base };
	if (!isObj(over)) return out;
	for (const [k, v] of Object.entries(over)) {
		if (v === undefined) continue;
		out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
	}
	return out;
}

/** fish-soul-config.json 读写（设置页写这里）。 */
function loadConfigFile() {
	try {
		if (!existsSync(configPath())) return {};
		return JSON.parse(readFileSync(configPath(), 'utf8'));
	} catch {
		return {};
	}
}

function saveConfigFile(patch) {
	const next = deepMerge(loadConfigFile(), patch);
	writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
}

/** 把扁平参数描述转成标准 JSON Schema（宿主 defineTool 校验 additionalProperties）。 */
function objectSchema(props) {
	const properties = {};
	const required = [];
	for (const [k, v] of Object.entries(props)) {
		const { required: req, ...rest } = v;
		properties[k] = rest;
		if (req === true) required.push(k);
	}
	return { type: 'object', properties, required, additionalProperties: false };
}

/** 把"YYYY-MM-DDTHH:mm"这类无时区 ISO 视为角色时区（UTC+8），而不是宿主机本地时区。 */
function parseRoleIso(iso) {
	const s = String(iso).trim();
	const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
	const parsed = Date.parse(hasZone ? s : `${s.length === 10 ? `${s}T09:00:00` : s}+08:00`);
	return Number.isFinite(parsed) ? parsed : null;
}

const UNKNOWN_OWNER = 'user:unknown';
const SESSION_FALLBACK_REAL_MS = 120_000;

export async function apply(ctx, config) {
	const log = (level, msg) => ctx.logger?.[level]?.(msg);
	// 配置来源：宿主 Config（schema 默认值）为底，设置页写的文件覆盖其上——
	// 旧实现 {...file, ...host} 浅合并会让 schema 的空默认值把文件里的 Key/BaseURL 清空。
	const hostConfig = config ?? {};
	let currentConfig = deepMerge(hostConfig, loadConfigFile());
	const getConfig = () => currentConfig;
	const saveConfig = (patch) => {
		saveConfigFile(patch);
		currentConfig = deepMerge(hostConfig, loadConfigFile());
	};
	const embeddingCfg = () => ({
		enabled: currentConfig.embedding?.enabled !== false,
		baseURL: currentConfig.embedding?.baseURL ?? '',
		apiKey: currentConfig.embedding?.apiKey ?? '',
		model: currentConfig.embedding?.model ?? '',
		timeoutMs: currentConfig.embedding?.timeoutMs ?? 800,
		writeTimeoutMs: currentConfig.embedding?.writeTimeoutMs ?? 10_000
	});

	// ── 底座 ──
	const db = openDatabase();
	ctx.effect(() => () => { try { db.close(); } catch { /* 已关闭 */ } }, 'dsh-fish-soul: db');
	// 虚拟钟从上次快照续走（加速验收中途重启不倒退）
	const clock = new VirtualClock(undefined, Number(getKv(db, 'clock.virtualMs', 0)) || 0);

	// ── 检索 ──
	const embedder = new EmbeddingClient(embeddingCfg);
	embedder.probeWith = async (probeCfg) => new EmbeddingClient(() => probeCfg).probe();
	const worker = new VectorWorker({ db, embedder, clock, getEmbeddingConfig: embeddingCfg });
	worker.start();
	ctx.effect(() => () => worker.stop(), 'dsh-fish-soul: vector worker');

	// ── qq-bridge 投递：OneBot 11 HTTP 直连 NapCat，fail-open ──
	async function deliver(channelId, text) {
		try {
			const base = currentConfig.qqBridge?.baseURL ?? 'http://127.0.0.1:3000';
			const isGroup = channelId.startsWith('group:');
			const target = channelId.replace(/^(group|private):/, '');
			const res = await fetch(`${base.replace(/\/+$/, '')}/${isGroup ? 'send_group_msg' : 'send_private_msg'}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'user-agent': 'dsh-fish-soul' },
				body: JSON.stringify(isGroup
					? { group_id: Number(target), message: [{ type: 'text', data: { text } }] }
					: { user_id: Number(target), message: [{ type: 'text', data: { text } }] }),
				signal: AbortSignal.timeout(10_000)
			});
			if (!res.ok) return false;
			// OneBot 11：HTTP 200 不代表成功，还要看 status/retcode
			const data = await res.json().catch(() => null);
			return data === null || data.status === 'ok' || data.retcode === 0;
		} catch (error) {
			log('error', `[fish-soul] 投递失败（${channelId}）：${String(error instanceof Error ? error.message : error)}`);
			return false;
		}
	}

	/** LLM 调用（日程 / 主动文案 / Dream）：支持 AbortSignal，Dream 被实时消息打断时真正停止流。 */
	async function callLlm(prompt, { signal } = {}) {
		try {
			const llm = ctx.get?.('llm') ?? ctx.llm;
			if (llm === null || llm === undefined || typeof llm.stream !== 'function') return null;
			let target = {};
			try {
				const first = (llm.listProviders?.() ?? [])[0];
				if (first !== undefined) {
					target = { provider: first.id ?? first.name, model: first.models?.[0]?.id ?? first.models?.[0] };
					if (target.model === undefined) target = {};
				}
			} catch { target = {}; }
			let out = '';
			for await (const chunk of llm.stream({
				...target,
				messages: [{ role: 'user', content: prompt }],
				maxTokens: 600,
				temperature: 0.7,
				...(signal ? { signal } : {})
			})) {
				if (signal?.aborted) return null;
				if (chunk?.type === 'text-delta') out += chunk.text;
			}
			return out.trim() === '' ? null : out.trim();
		} catch {
			return null;
		}
	}

	// ── 自走层 ──
	const life = new LifeEngine({ db, clock, getConfig, callLlm, deliver, log });
	life.start();
	ctx.effect(() => () => life.stop(), 'dsh-fish-soul: life');

	registerRoutes(ctx, { db, clock, embedder, worker, life, getConfig, saveConfig, log });

	// ── 人格（JSON / PNG 卡，宏替换，世界书）──
	const persona = loadPersona(fishSoulDir(), log);
	log('info', `[fish-soul] 人格来源 ${persona.source}：${persona.name}，世界书关键词条目 ${persona.lore.length}`);

	// ── 会话上下文：按会话隔离，禁止"认不出就当主人" ──
	/** @type {Map<string, {ownerId:string, channel:string, channelId:string, person:object|null, displayName:string, query:string, vec:object|null, vecQuery:string, atReal:number}>} */
	const sessions = new Map();
	let latestKey = null;

	function extractSender(event) {
		const data = event?.data ?? event ?? {};
		const sender = data.sender ?? data.user ?? {};
		const qqUin = String(sender.qqUin ?? sender.uin ?? sender.userId ?? sender.user_id ?? data.qqUin ?? data.userId ?? data.user_id ?? '');
		const nickname = String(sender.nickname ?? sender.card ?? sender.displayName ?? data.nickname ?? '');
		const groupId = data.groupId ?? data.groupUin ?? data.group_id ?? null;
		const sessionKey = String(event?.sessionId ?? data.sessionId ?? event?.session?.id ?? '') ||
			(groupId != null ? `group:${groupId}` : (qqUin !== '' ? `private:${qqUin}` : ''));
		return { data, qqUin, nickname, groupId, sessionKey };
	}

	function buildSession({ qqUin, nickname, groupId }, person) {
		const channel = groupId != null ? 'qq-group' : 'qq-private';
		const channelId = groupId != null ? `group:${groupId}` : (qqUin !== '' ? `private:${qqUin}` : '');
		return {
			ownerId: person !== null ? `user:${person.canonical_id}` : UNKNOWN_OWNER,
			channel, channelId, person,
			displayName: person?.display_name ?? (nickname || '对方'),
			query: '', vec: null, vecQuery: '', atReal: Date.now()
		};
	}

	/** inbox 事件：唯一会自增 interaction_count 的入口。 */
	function sessionFromInbound(event) {
		const s = extractSender(event);
		const person = s.qqUin === '' ? null : resolveOrCreatePerson(db, {
			qqUin: s.qqUin, nickname: s.nickname, nowMs: clock.now(), masterQqUin: currentConfig.masterQqUin ?? ''
		});
		if (person === null) log('warn', '[fish-soul] 消息里没解析出发送者 QQ 号：按 user:unknown 隔离处理（不读写任何人的记忆）');
		const key = s.sessionKey || `anon:${Date.now()}`;
		const session = { ...(sessions.get(key) ?? {}), ...buildSession(s, person) };
		sessions.set(key, session);
		latestKey = key;
		if (sessions.size > 500) sessions.delete(sessions.keys().next().value);
		return { key, session, text: String(s.data.text ?? s.data.content ?? event?.text ?? '') };
	}

	/** 工具调用：按 sessionId → 工具上下文里的发送者（只读）→ 2 分钟内最近一条入站消息 → unknown。 */
	function sessionForTool(toolCtx) {
		const s = extractSender(toolCtx ?? {});
		if (s.sessionKey && sessions.has(s.sessionKey)) return sessions.get(s.sessionKey);
		if (s.qqUin !== '') {
			const person = findPersonByQq(db, s.qqUin);
			if (person !== null) return buildSession(s, person);
		}
		const latest = latestKey !== null ? sessions.get(latestKey) : undefined;
		if (latest !== undefined && Date.now() - latest.atReal < SESSION_FALLBACK_REAL_MS) return latest;
		return buildSession({ qqUin: '', nickname: '', groupId: null }, null);
	}

	const retrievalCfg = () => ({
		fusionMethod: currentConfig.retrieval?.fusionMethod ?? 'rrf',
		topK: currentConfig.retrieval?.topK ?? 5
	});

	function stateLine() {
		const snap = life.stateSnapshot();
		return `[此刻状态] 虚拟时间 ${snap.clock.virtualIsoLocal}；` +
			`基调 ${snap.today.dailyMoodTone ?? '未生成'}；` +
			`时段 ${snap.today.currentSlot?.activity ?? '未知'}（${snap.today.currentSlot?.availability ?? '?'}）`;
	}

	/**
	 * 同步组装本轮瞬态块：BM25 当场算（本轮消息，零滞后），向量排名若已为同一 query 预取完成则一起融合。
	 * 旧实现异步刷新一个全局 cachedBlock，导致注入的是"上一条消息、可能是另一个人"的记忆。
	 */
	function buildContextBlock(arg) {
		const key = extractSender(arg ?? {}).sessionKey || latestKey;
		const session = key !== null ? sessions.get(key) : undefined;
		const lines = [stateLine()];
		if (session === undefined) return lines.join('\n');
		lines.push(`[当前说话人] ${session.displayName}（${session.ownerId === UNKNOWN_OWNER ? '身份未识别' : session.person?.relation_stage ?? 'stranger'}）`);
		if (session.ownerId !== UNKNOWN_OWNER && session.query !== '') {
			try {
				const memories = recallSync({
					db, clock, config: retrievalCfg(), characterId: 'feiyu', ownerId: session.ownerId,
					query: session.query, vec: session.vecQuery === session.query ? session.vec : null
				});
				const budget = currentConfig.retrieval?.tokenBudget ?? 1200;
				let used = 0;
				const memLines = [];
				for (const m of memories) {
					const line = `- （${m.kind}）${m.content}`;
					used += line.length; // 中文约 1 字 ≈ 1 token，按字符保守估算
					if (used > budget) break;
					memLines.push(line);
				}
				if (memLines.length > 0) lines.push('[相关记忆]', ...memLines);
			} catch { /* fail-open */ }
			const due = session.dueReasons ?? [];
			if (due.length > 0) lines.push('[到期的约定，可自然提起]', ...due.map((r) => `- ${r}`));
		}
		if (session.channel === 'qq-group' && session.channelId !== '') {
			const recent = db.prepare(`
				SELECT content FROM memory
				WHERE character_id = 'feiyu' AND channel = 'qq-group' AND channel_id = ?
				  AND status = 'active' AND valid_to IS NULL
				ORDER BY created_at DESC LIMIT 5
			`).all(session.channelId);
			if (recent.length > 0) lines.push(`[本群近期]`, ...recent.map((r) => `- ${r.content}`));
		}
		const lore = matchLore(persona.lore, session.query);
		if (lore.length > 0) lines.push('[设定补充]', ...lore.map((e) => `- ${applyMacros(e.content, { charName: persona.name, userName: session.displayName })}`));
		if (persona.postHistory !== '') lines.push(applyMacros(persona.postHistory, { charName: persona.name, userName: session.displayName }));
		return lines.join('\n');
	}

	/** inbox 入站：登记互动 + 记录本轮 query + 预取向量排名（800ms 内返回则本轮可用，否则本轮纯 BM25）。 */
	function noteInteraction(payload) {
		const { session, text } = sessionFromInbound(payload);
		if (session.ownerId !== UNKNOWN_OWNER) life.noteInteraction(session.ownerId);
		if (text === '') return;
		session.query = text;
		if (session.ownerId === UNKNOWN_OWNER) return;
		// 每条入站消息只取一次到期约定（text() 可能被多次调用，不能在那里做有副作用的操作）
		session.dueReasons = life.surfacePendingFor(session.ownerId);
		void vectorRanks({
			db, embedder, characterId: 'feiyu', ownerId: session.ownerId, query: text, embeddingCfg: embeddingCfg()
		}).then((vec) => {
			if (session.query === text) { session.vec = vec; session.vecQuery = text; }
		}).catch(() => { /* fail-open */ });
	}

	registerAgentHooks(ctx, {
		personaText: persona.staticText,
		buildContextBlock,
		noteInteraction,
		log
	});

	// ── 工具：remember / recall / forget ──
	const textOutput = {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: String(value) }]
	};

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'remember',
		description: '把用户刚说的事实 / 事件 / 感受写入长期记忆。用户提及未来约定或提醒时，' +
			'同时填 dueInMinutes（相对分钟，优先）或 dueAtIso + proactiveReason，会在同一事务内' +
			'登记到期主动提醒（pending）。',
		parameters: objectSchema({
			content: { type: 'string', required: true, description: '要记住的内容（一句完整的话）' },
			kind: { type: 'string', enum: ['fact', 'event', 'feeling'], required: true, description: "'fact' | 'event' | 'feeling'" },
			importance: { type: 'number', description: '1..5，>=3 豁免时间衰减' },
			emotion: { type: 'number', description: '-2..+2' },
			dueInMinutes: { type: 'number', description: '相对当前虚拟时间的分钟数（到期提醒，优先）' },
			dueAtIso: { type: 'string', description: '或绝对时间，如 2026-11-02T09:00（按 UTC+8 角色时区理解）' },
			proactiveReason: { type: 'string', description: '到期主动开口的理由' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const content = String(args.content ?? '').trim();
			const kind = ['fact', 'event', 'feeling'].includes(args.kind) ? args.kind : 'fact';
			if (content === '') return '内容为空，未写入。';
			const session = sessionForTool(toolCtx);
			if (session.ownerId === UNKNOWN_OWNER) return '没识别出说话人是谁，这条先不记（避免记到别人名下）。';
			const nowVirtual = clock.now();
			const importance = Math.min(5, Math.max(1, Number(args.importance ?? 1) || 1));
			const emotion = Math.min(2, Math.max(-2, Number(args.emotion ?? 0) || 0));

			let dueAt = null;
			const minutes = Number(args.dueInMinutes);
			if (args.dueInMinutes !== undefined && args.dueInMinutes !== null && Number.isFinite(minutes) && minutes > 0) {
				dueAt = nowVirtual + minutes * 60_000;
			} else if (typeof args.dueAtIso === 'string' && args.dueAtIso !== '') {
				// 模型看到的是瞬态块里的虚拟时间，所以绝对时间就是虚拟时间轴上的点
				dueAt = parseRoleIso(args.dueAtIso);
				if (dueAt !== null && dueAt <= nowVirtual) dueAt = null;
			}

			// 去重：同一人同一句已记过就只刷新时间
			const dup = db.prepare(`
				SELECT id FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND content = ? AND status = 'active' LIMIT 1
			`).get(session.ownerId, content);

			let memoryId = 0;
			db.exec('BEGIN');
			try {
				if (dup !== undefined) {
					memoryId = dup.id;
					db.prepare('UPDATE memory SET updated_at = ?, importance = MAX(importance, ?) WHERE id = ?')
						.run(nowVirtual, importance, memoryId);
				} else {
					const result = db.prepare(`
						INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
						                    importance, emotion, source_session, created_at, updated_at, status)
						VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
					`).run(session.ownerId, session.channel, session.channelId, kind, content,
						tokenizeForBm25(content), importance, emotion,
						String(toolCtx?.sessionId ?? ''), nowVirtual, nowVirtual);
					memoryId = Number(result.lastInsertRowid);
				}
				if (dueAt !== null) {
					db.prepare(`
						INSERT INTO pending (character_id, owner_id, channel, channel_id, due_at, reason, status, created_at)
						VALUES ('feiyu', ?, ?, ?, ?, ?, 'pending', ?)
					`).run(session.ownerId, session.channel, session.channelId, dueAt,
						String(args.proactiveReason ?? content.slice(0, 60)), nowVirtual);
				}
				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
			if (dup === undefined) worker.enqueueRealtime(memoryId, content);
			const tail = dueAt !== null ? `，并登记到期提醒（${new Date(dueAt + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}）` : '';
			return `${dup !== undefined ? '已经记过了，已刷新' : '已记住'} #${memoryId}${tail}。`;
		}
	})), 'dsh-fish-soul: remember');

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'recall',
		description: '按当前对话内容主动检索当前说话人的长期记忆（BM25 + 语义向量 RRF 融合）。',
		parameters: objectSchema({
			query: { type: 'string', required: true, description: '检索词或问题' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const session = sessionForTool(toolCtx);
			if (session.ownerId === UNKNOWN_OWNER) return '没识别出说话人，不检索。';
			const memories = await recall({
				db, embedder, clock, config: retrievalCfg(), characterId: 'feiyu',
				ownerId: session.ownerId, query: String(args.query ?? ''), embeddingCfg: embeddingCfg()
			});
			if (memories.length === 0) return '没有检索到相关记忆。';
			return memories.map((m) => `#${m.id}（${m.kind}${m.owner_id === 'self' ? ' / 自己' : ''}）${m.content}`).join('\n');
		}
	})), 'dsh-fish-soul: recall');

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'forget',
		description: '删除当前说话人自己的一条长期记忆（id 来自 remember/recall 输出）。不能删除别人的记忆。',
		parameters: objectSchema({
			id: { type: 'number', required: true, description: '记忆 id' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const id = Number(args.id);
			if (!Number.isInteger(id)) return 'id 必须是整数。';
			const session = sessionForTool(toolCtx);
			const row = db.prepare("SELECT owner_id FROM memory WHERE id = ? AND status = 'active'").get(id);
			if (row === undefined) return `没有找到记忆 #${id}。`;
			// 归属校验：只能删自己的；主人可删任何人（含 self）
			const isMaster = session.ownerId === 'user:master';
			if (!isMaster && row.owner_id !== session.ownerId) return `记忆 #${id} 不属于当前说话人，不能删除。`;
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
			return `已删除记忆 #${id}。`;
		}
	})), 'dsh-fish-soul: forget');

	log('info', '[fish-soul] 插件启动：soul.db 就绪，VirtualClock ×' + clock.scale +
		`，Worker 运行中，世代 gen #${readVecMeta(db)?.generation_id ?? 1}`);
}
