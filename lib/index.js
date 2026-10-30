/**
 * dsh-fish-soul —— 人格、按人记忆、日程自走与主动开口（设计方案 v1.1）。
 *
 * 装配：db（soul.db）→ clock（VirtualClock）→ retrieval（召回+Worker）
 *      → life（tick/主动/Dream）→ routes（8 条契约路由）→ 工具与 pre-step。
 *
 * 依赖：零 npm 运行时依赖——node:sqlite 内置驱动、内置 fetch、Intl.Segmenter。
 * schemastery 与 @deepseek-ai/dsh-tools 为宿主常驻依赖（参照 dsh-archive-vault）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadHostDeps } from './hostdeps.mjs';
import { openDatabase, configPath, fishSoulDir, resolveOrCreatePerson, readVecMeta } from './db.js';
import { VirtualClock } from './clock.js';
import { EmbeddingClient, VectorWorker, recall } from './retrieval.js';
import { LifeEngine } from './life.js';
import { registerRoutes, registerAgentHooks } from './routes.js';
import { tokenizeForBm25 } from './segment.js';

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

/** fish-soul-config.json 读写（合并 patch 后落盘）。 */
function loadConfigFile() {
	try {
		if (!existsSync(configPath())) return {};
		return JSON.parse(readFileSync(configPath(), 'utf8'));
	} catch {
		return {};
	}
}

function saveConfigFile(patch) {
	const next = { ...loadConfigFile(), ...patch };
	writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
}

/** 读取 persona.json（Character Card V3），提取注入文本；缺失时给最小占位。 */
function loadPersonaText(log) {
	const path = join(fishSoulDir(), 'persona.json');
	try {
		if (!existsSync(path)) return '你是 feiyu（鱼）：一个有自己的作息、会记住每个说过话的人的 QQ 好友。';
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		// V3：data 内嵌；V2/扁平：顶层字段。只取文本字段，不碰图片/配音资源。
		const card = raw.data ?? raw;
		const parts = [];
		if (card.description) parts.push(String(card.description));
		if (card.personality) parts.push(`性格：${card.personality}`);
		if (card.scenario) parts.push(`场景：${card.scenario}`);
		if (Array.isArray(card.mes_example)) parts.push(card.mes_example.join('\n'));
		else if (card.mes_example) parts.push(String(card.mes_example));
		return parts.length > 0 ? parts.join('\n\n') : String(card.system_prompt ?? '你是 feiyu。');
	} catch (error) {
		log('error', `[fish-soul] persona.json 读取失败：${String(error instanceof Error ? error.message : error)}`);
		return '你是 feiyu（鱼）。';
	}
}

export async function apply(ctx, config) {
	const log = (level, msg) => ctx.logger?.[level]?.(msg);
	const merged = { ...loadConfigFile(), ...(config ?? {}) };
	let currentConfig = merged;
	const getConfig = () => currentConfig;
	const saveConfig = (patch) => {
		saveConfigFile(patch);
		currentConfig = { ...loadConfigFile() };
	};

	// ── 底座 ──
	const db = openDatabase();
	ctx.effect(() => () => { try { db.close(); } catch { /* 已关闭 */ } }, 'dsh-fish-soul: db');
	const clock = new VirtualClock();

	// ── 检索 ──
	const embedder = new EmbeddingClient(() => ({
		enabled: currentConfig.embedding?.enabled !== false,
		baseURL: currentConfig.embedding?.baseURL ?? '',
		apiKey: currentConfig.embedding?.apiKey ?? '',
		model: currentConfig.embedding?.model ?? '',
		timeoutMs: currentConfig.embedding?.timeoutMs ?? 800
	}));
	/** 带临时配置的探测（/probe 路由用，允许未保存先测）。 */
	embedder.probeWith = async (probeCfg) => {
		const temp = new EmbeddingClient(() => probeCfg);
		return temp.probe();
	};
	const worker = new VectorWorker({ db, embedder, clock });
	worker.start();
	ctx.effect(() => () => worker.stop(), 'dsh-fish-soul: vector worker');

	// ── qq-bridge 投递：OneBot 11 HTTP 直连 NapCat（本机 qq-bridge 同款通道），fail-open ──
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
					: { user_id: Number(target), message: [{ type: 'text', data: { text } }] })
			});
			return res.ok;
		} catch (error) {
			log('error', `[fish-soul] 投递失败（${channelId}）：${String(error instanceof Error ? error.message : error)}`);
			return false;
		}
	}

	/** LLM 调用（日程生成 / 主动文案 / Dream 归纳）：宿主 ctx.llm.stream（fish-memory 同款签名），不可用返回 null（fail-open）。 */
	async function callLlm(prompt) {
		try {
			const llm = ctx.get?.('llm') ?? ctx.llm;
			if (llm === null || typeof llm.stream !== 'function') return null;
			// 选用第一个可用 provider/model；宿主配置缺省时让 stream 用会话默认
			let target = {};
			try {
				const providers = llm.listProviders?.() ?? [];
				const first = providers[0];
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
				temperature: 0.7
			})) {
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

	// ── 8 条契约路由 ──
	registerRoutes(ctx, { db, clock, embedder, worker, life, getConfig, saveConfig, log });

	// ── persona 与 pre-step ──
	const personaText = loadPersonaText(log);

	/** 当前会话上下文（pre-step 与工具共用）：从事件中尽力提取，失败走安全默认。 */
	function resolveSessionContext(event) {
		const data = event?.data ?? event ?? {};
		const sender = data.sender ?? data.user ?? {};
		const qqUin = String(sender.qqUin ?? sender.uin ?? sender.userId ?? data.qqUin ?? '');
		const nickname = String(sender.nickname ?? sender.displayName ?? data.nickname ?? '');
		const groupId = data.groupId ?? data.groupUin ?? null;
		const channel = groupId !== null && groupId !== undefined ? 'qq-group' : 'qq-private';
		const channelId = groupId !== null && groupId !== undefined ? `group:${groupId}` : `private:${qqUin}`;
		if (qqUin === '') {
			return { ownerId: 'user:master', channel, channelId, person: null };
		}
		const person = resolveOrCreatePerson(db, {
			qqUin, nickname, nowMs: clock.now(), masterQqUin: currentConfig.masterQqUin ?? ''
		});
		return { ownerId: `user:${person.canonical_id}`, channel, channelId, person };
	}

	/** 最近一条用户消息文本（systemPrompt.context 的 text() 是同步的，召回在此提前缓存）。 */
	let latestQuery = '';
	let latestSession = { ownerId: 'user:master', channel: 'qq-private', channelId: '' };
	/** text() 同步返回用的召回缓存：后台异步刷新，下一轮注入用新结果。 */
	let cachedBlock = '';

	function refreshBlock() {
		const query = latestQuery;
		if (query === '') {
			const snap = life.stateSnapshot();
			cachedBlock = `[此刻状态] 虚拟时间 ${snap.clock.virtualIsoLocal}；` +
				`基调 ${snap.today.dailyMoodTone ?? '未生成'}；` +
				`时段 ${snap.today.currentSlot?.activity ?? '未知'}（${snap.today.currentSlot?.availability ?? '?'}）`;
			return;
		}
		void recall({
			db, embedder, clock,
			config: {
				fusionMethod: currentConfig.retrieval?.fusionMethod ?? 'rrf',
				topK: currentConfig.retrieval?.topK ?? 5
			},
			characterId: 'feiyu', ownerId: latestSession.ownerId, query
		}).then((memories) => {
			const snap = life.stateSnapshot();
			const lines = [];
			lines.push(`[此刻状态] 虚拟时间 ${snap.clock.virtualIsoLocal}；` +
				`基调 ${snap.today.dailyMoodTone ?? '未生成'}；` +
				`时段 ${snap.today.currentSlot?.activity ?? '未知'}（${snap.today.currentSlot?.availability ?? '?'}）`);
			if (memories.length > 0) {
				lines.push('[相关记忆]');
				for (const m of memories) lines.push(`- #${m.id}（${m.kind}）${m.content}`);
			}
			if (latestSession.channel === 'qq-group') {
				// 群摘要按 channel_id 隔离（审查 #01）
				const recent = db.prepare(`
					SELECT content FROM memory
					WHERE character_id = 'feiyu' AND channel = 'qq-group' AND channel_id = ?
					  AND status = 'active' AND valid_to IS NULL
					ORDER BY created_at DESC LIMIT 5
				`).all(latestSession.channelId);
				if (recent.length > 0) {
					lines.push(`[本群近期摘要 ${latestSession.channelId}]`);
					for (const r of recent) lines.push(`- ${r.content}`);
				}
			}
			cachedBlock = lines.join('\n');
		}).catch(() => { /* fail-open：召回失败保留旧块，不断对话 */ });
	}

	/** agent/inbox/inserted：互动登记 + 刷新召回缓存。 */
	function noteInteraction(payload) {
		const data = payload?.data ?? payload ?? {};
		latestSession = resolveSessionContext(payload);
		life.noteInteraction(latestSession.ownerId);
		const text = String(data.text ?? data.content ?? payload?.text ?? '');
		if (text !== '') latestQuery = text;
		refreshBlock();
	}

	registerAgentHooks(ctx, {
		personaText,
		buildContextBlock: () => cachedBlock,
		noteInteraction,
		log
	});
	refreshBlock(); // 启动时先铺一块此刻状态

	// ── 工具：remember / recall / forget（§8.1，审查 #02）──
	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'remember',
		description: '把用户刚说的事实 / 事件 / 感受写入长期记忆。用户提及未来约定或提醒时，' +
			'同时填 dueInMinutes（相对分钟，优先）或 dueAtIso + proactiveReason，会在同一事务内' +
			'登记到期主动提醒（pending）。',
		parameters: {
			content: { type: 'string', required: true, description: '要记住的内容（一句完整的话）' },
			kind: { type: 'string', required: true, description: "'fact' | 'event' | 'feeling'" },
			importance: { type: 'number', description: '1..5，>=3 豁免时间衰减' },
			emotion: { type: 'number', description: '-2..+2' },
			dueInMinutes: { type: 'number', description: '相对当前虚拟时间的分钟数（到期提醒，优先）' },
			dueAtIso: { type: 'string', description: '或 ISO-8601 绝对时间（角色时区）' },
			proactiveReason: { type: 'string', description: '到期主动开口的理由' }
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value) }]
		},
		async execute(args, toolCtx) {
			const content = String(args.content ?? '').trim();
			const kind = ['fact', 'event', 'feeling'].includes(args.kind) ? args.kind : 'fact';
			if (content === '') return '内容为空，未写入。';
			const session = resolveSessionContext(toolCtx ?? {});
			const nowVirtual = clock.now();
			const importance = Math.min(5, Math.max(1, Number(args.importance ?? 1)));
			const emotion = Math.min(2, Math.max(-2, Number(args.emotion ?? 0)));

			// 到期时间：dueInMinutes 优先（避免模型算错绝对时间，审查 #02）
			let dueAt = null;
			if (args.dueInMinutes !== undefined && args.dueInMinutes !== null) {
				dueAt = nowVirtual + Number(args.dueInMinutes) * 60_000;
			} else if (typeof args.dueAtIso === 'string' && args.dueAtIso !== '') {
				const parsed = Date.parse(args.dueAtIso);
				if (Number.isFinite(parsed)) dueAt = parsed;
			}

			let memoryId = 0;
			db.exec('BEGIN');
			try {
				const result = db.prepare(`
					INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
					                    importance, emotion, source_session, created_at, updated_at, status)
					VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
				`).run(session.ownerId, session.channel, session.channelId, kind, content,
					tokenizeForBm25(content), importance, emotion,
					String(toolCtx?.sessionId ?? ''), nowVirtual, nowVirtual);
				memoryId = Number(result.lastInsertRowid);
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
			// 向量进实时高优队列，不阻塞回复（§8.1）
			worker.enqueueRealtime(memoryId, content);
			return dueAt !== null
				? `已记住 #${memoryId}，并登记到期提醒（${new Date(dueAt).toISOString()}）。`
				: `已记住 #${memoryId}。`;
		}
	})), 'dsh-fish-soul: remember');

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'recall',
		description: '按当前对话内容主动检索长期记忆（BM25 + 语义向量 RRF 融合）。',
		parameters: {
			query: { type: 'string', required: true, description: '检索词或问题' }
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value) }]
		},
		async execute(args, toolCtx) {
			const session = resolveSessionContext(toolCtx ?? {});
			const memories = await recall({
				db, embedder, clock,
				config: {
					fusionMethod: currentConfig.retrieval?.fusionMethod ?? 'rrf',
					topK: currentConfig.retrieval?.topK ?? 5
				},
				characterId: 'feiyu', ownerId: session.ownerId,
				query: String(args.query ?? '')
			});
			if (memories.length === 0) return '没有检索到相关记忆。';
			return memories.map((m) => `#${m.id}（${m.kind} / ${m.owner_id}）${m.content}`).join('\n');
		}
	})), 'dsh-fish-soul: recall');

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'forget',
		description: '删除一条指定 id 的长期记忆（级联清理向量），或纠正一条过时记忆。',
		parameters: {
			id: { type: 'number', required: true, description: '记忆 id（来自 remember/recall 输出）' }
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value) }]
		},
		async execute(args) {
			const id = Number(args.id);
			if (!Number.isInteger(id)) return 'id 必须是整数。';
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
			return `已删除记忆 #${id}（向量已级联清理）。`;
		}
	})), 'dsh-fish-soul: forget');

	log('info', '[fish-soul] 插件启动：soul.db 就绪，VirtualClock ×' + clock.scale +
		`，Worker 运行中，世代 gen #${readVecMeta(db)?.generation_id ?? 1}`);
}
