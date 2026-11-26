/**
 * 扩展工具注册（记忆写入/检索/遗忘 + 跨平台传话 + 抖音发视频 + 自建联网搜索）。
 *
 * 从 lib/index.js 拆出以保持启动装配文件职责单一、体积可控；
 * chat_search 与 scheduled_tasks_* 仍留在 lib/index.js 中。
 */
export function registerExtraTools(ctx, deps) {
	const {
		defineTool, objectSchema, clock, db, life, worker, embedder,
		embeddingCfg, retrievalCfg, memoryLabel, nearDuplicateSync, tokenizeForBm25,
		parseRoleIso, sessionForTool, UNKNOWN_OWNER, recall, reinforce,
		gateway, douyinSocial, getConfig, webConfig, ownSearchReady, runWebSearch, formatSearch,
		relaySenderId, parseRelayTarget, log,
		RELAY_TOOL, RELAY_FRIEND_TOOL, DOUYIN_VIDEO_TOOL, OWN_WEB_TOOL
	} = deps;

	const textOutput = {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: String(value) }]
	};

	// ── 工具：remember / recall / forget ──
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
			proactiveReason: { type: 'string', description: '到期主动开口的理由' },
			speaker: { type: 'string', description: '群里多人说话时，这条记忆属于谁（填消息里的署名）；私聊不用填' },
			private: { type: 'boolean', description: '私聊里说的健康 / 感情 / 家庭 / 钱 / 秘密这类不该在群里提的事填 true' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const content = String(args.content ?? '').trim();
			const kind = ['fact', 'event', 'feeling'].includes(args.kind) ? args.kind : 'fact';
			if (content === '') return '内容为空，未写入。';
			const session = sessionForTool(toolCtx, args.speaker);
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

			// 去重：同一人同一句（或几乎一样的话）已记过就只刷新时间
			const dup = db.prepare(`
				SELECT id FROM memory WHERE character_id = 'feiyu' AND owner_id = ? AND content = ? AND status = 'active' LIMIT 1
			`).get(session.ownerId, content) ?? nearDuplicateSync(db, session.ownerId, content) ?? undefined;
			const isPrivate = args.private === true && session.channel !== 'qq-group' && session.channel !== 'douyin-group';

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
						                    importance, emotion, source_session, created_at, updated_at, status, evidence, visibility)
						VALUES ('feiyu', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
					`).run(session.ownerId, session.channel, session.channelId, kind, content,
						tokenizeForBm25(content), importance, emotion,
						String(toolCtx?.sessionId ?? toolCtx?.agent?.id ?? ''), nowVirtual, nowVirtual,
						session.query ? `${session.displayName}：${session.query.slice(0, 200)}` : '', isPrivate ? 'private' : 'normal');
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
			// 新登记的提醒要马上挂闹钟，不然它得等下一轮 tick 才被发现（#80）
			if (dueAt !== null) life.armPendingAlarm?.();
			if (dup === undefined) worker.enqueueRealtime(memoryId, content);
			const tail = dueAt !== null ? `，并登记到期提醒（${new Date(dueAt + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}）` : '';
			return `${dup !== undefined ? '已经记过了，已刷新' : '已记住'} #${memoryId}${tail}。`;
		}
	})), 'dsh-fish-soul: remember');

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'recall',
		description: '按当前对话内容主动检索当前说话人的长期记忆（BM25 + 语义向量 RRF 融合）。',
		parameters: objectSchema({
			query: { type: 'string', required: true, description: '检索词或问题' },
			speaker: { type: 'string', description: '群里多人说话时，查谁的记忆（填消息里的署名）；私聊不用填' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const session = sessionForTool(toolCtx, args.speaker);
			if (session.ownerId === UNKNOWN_OWNER) return '没识别出说话人，不检索。';
			const memories = await recall({
				db, embedder, clock, config: retrievalCfg(), characterId: 'feiyu',
				ownerId: session.ownerId, query: String(args.query ?? ''), embeddingCfg: embeddingCfg(), excludePrivate: session.channel === 'qq-group' || session.channel === 'douyin-group'
			});
			if (memories.length === 0) return '没有检索到相关记忆。';
			const now = clock.now();
			reinforce(db, memories.map((m) => m.id), now);
			return memories.map((m) => `#${m.id}${memoryLabel(m, now).slice(1)}`).join('\n');
		}
	})), 'dsh-fish-soul: recall');

	ctx.effect(() => ctx.tools.register(defineTool({
		name: 'forget',
		description: '删除当前说话人自己的一条长期记忆（id 来自 remember/recall 输出）。不能删除别人的记忆。',
		parameters: objectSchema({
			id: { type: 'number', required: true, description: '记忆 id' },
			speaker: { type: 'string', description: '群里多人说话时，是谁要删（填消息里的署名）' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const id = Number(args.id);
			if (!Number.isInteger(id)) return 'id 必须是整数。';
			const session = sessionForTool(toolCtx, args.speaker);
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

	// ── 工具：send_elsewhere（主人在 QQ 私聊里让她去抖音 / B站 私信自己一条）──
	ctx.effect(() => ctx.tools.register(defineTool({
		name: RELAY_TOOL,
		description: '在另一个平台（抖音私信 / B站私信）给主人发一条消息。只有主人明确要求（「去抖音给我发」「去B站说一声」这类）时才用，别自己找机会用。' +
			'话由你自己写，像平时发私信那样自然，直接写要发出去的那一条。只能在主人的私聊里用。',
		parameters: objectSchema({
			platform: { type: 'string', enum: ['douyin', 'bili'], required: true, description: "'douyin' | 'bili'" },
			text: { type: 'string', required: true, description: '要发出去的原话（一段，别加引号）' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const session = sessionForTool(toolCtx);
			const channelId = String(session.channelId ?? '');
			if (channelId === '' || gateway === null) return '不知道现在是在哪个聊天里，先不发。';
			if (!gateway.isMasterChannel(channelId)) return '这个只能在主人的私聊里用。';
			const text = String(args.text ?? '').trim();
			if (text === '') return '内容是空的，没发。';
			const platform = String(args.platform ?? '');
			const where = platform === 'bili' ? 'B站' : '抖音';
			try {
				const r = await gateway.relayTo(platform, text);
				if (!r.ok) return `没发成：${r.reason}。`;
				return r.delivered ? `已经发到${where}了。` : `发到${where}了，但回读没看到，可能被风控吞了。`;
			} catch (error) {
				const msg = String(error instanceof Error ? error.message : error);
				log('warn', `[fish-soul] 跨平台转达失败：${msg}`);
				return `没发成：${msg.slice(0, 120)}。`;
			}
		}
	})), 'dsh-fish-soul: send_elsewhere');

	// ── 工具：relay_to_friend（白名单里的人 A 托她给白名单里的 B 带句话；默认关）──
	ctx.effect(() => ctx.tools.register(defineTool({
		name: RELAY_FRIEND_TOOL,
		description: '帮当前说话的人给另一个熟人带一句话（对方会收到「xx 托我带句话：…」）。' +
			'只有对方明确要求（「帮我跟 xx 说一声」「带句话给 xx」这类）时才用，别自己找机会用。' +
			'收件人必须给平台 uid（QQ 号 / B站 UID / 抖音 uid），昵称会发错人所以不认。' +
			'两边都得在主人配的传话白名单里才能用，发不出去会告诉你原因，照实跟对方说，别编。',
		parameters: objectSchema({
			to: { type: 'string', required: true, description: "收件人的平台 uid。两种写法都收：纯数字 + platform（如 to='12345', platform='qq'），或直接带前缀（如 to='bili:12345'）。白名单里怎么写的就照抄" },
			platform: { type: 'string', description: "收件人在哪个平台：'qq' | 'bili' | 'douyin'。to 已经带前缀时可以不给；两个都给就以前缀为准。**不认识的平台值会被拒**（不会默认成 QQ，那样可能把话发给另一个人）" },
			text: { type: 'string', required: true, description: '要带的那句话（一段，照对方的意思写，别加引号）' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			if (gateway === null) return '网关没起来，带不了话。';
			const session = sessionForTool(toolCtx);
			// 发起人：从会话绑定身份反查平台 uid。认不出是谁就不发 —— 白名单比的是 uid，
			// 认不出 = 给不了 uid，宁可拒了也不能按昵称猜（昵称可以随便改）。
			const fromId = relaySenderId(session);
			if (fromId === '') return '认不出你是谁（这个会话没绑到认识的人），带不了话。';
			const target = parseRelayTarget(args.to, args.platform);
			if (target.ok !== true) return target.error;
			const toId = target.id;
			const text = String(args.text ?? '').trim();
			if (text === '') return '要带的话是空的，没发。';
			try {
				const r = await gateway.relayToFriend(fromId, toId, text);
				if (!r.ok) return `没带到：${r.reason}。`;
				return r.delivered ? '带到了。' : '发出去了，但回读没看到，可能没真到。';
			} catch (error) {
				const msg = String(error instanceof Error ? error.message : error);
				log('warn', `[fish-soul] 传话失败：${msg}`);
				return `没带成：${msg.slice(0, 120)}。`;
			}
		}
	})), 'dsh-fish-soul: relay_to_friend');

	// ── 工具：make_douyin_video（主人在私聊里让她做一条视频并发到抖音）──
	ctx.effect(() => ctx.tools.register(defineTool({
		name: DOUYIN_VIDEO_TOOL,
		description: '按给定或自己想的画面文案生成一条短视频并发到抖音（服务商配成 OpenMotion 时走本地渲染，配成云端服务商时调对应视频模型）。' +
			'只有主人明确要求（「做个视频发抖音」「用 OpenMotion 做条视频发出去」这类）时才用，别自己找机会用。只能在主人的私聊里用。',
		parameters: objectSchema({
			text: { type: 'string', description: '视频画面/配文（15～80 字，写视频里在拍什么或画面里的文案；不填就由你自己按此刻心情写一条）' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const session = sessionForTool(toolCtx);
			const channelId = String(session.channelId ?? '');
			if (channelId === '' || gateway === null) return '不知道现在是在哪个聊天里，先不发。';
			if (!gateway.isMasterChannel(channelId)) return '这个只能在主人的私聊里用。';
			if ((getConfig().douyin ?? {}).enabled !== true) return '抖音总开关没开（设置页「抖音」→ 抖音接入）。';
			if (!douyinSocial) return '抖音模块没加载。';
			if (!douyinSocial.cfg().video.enabled) return '还没打开「自己发视频」（设置页「抖音」→ 作品和评论 → 自己发视频）。';
			const blocked = douyinSocial.postBlockReason?.();
			if (blocked) return `现在发不了：${blocked}。`;
			if (douyinSocial.posting) return '正在发另一条作品，稍等会儿再试。';
			if (!douyinSocial.ready) return `抖音还没准备好：${douyinSocial.notReadyText()}。`;
			const quotaErr = douyinSocial.videoQuotaError?.();
			if (quotaErr) return `今天发不了：${quotaErr}。`;
			const text = String(args?.text ?? '').trim();
			try {
				const r = await douyinSocial.post({ force: true, kind: 'video', ...(text !== '' ? { text } : {}) });
				if (!r?.ok) return `没发成：${r?.error ?? '原因不明'}。`;
				return `已经生成并发布到抖音了：${r.text}。`;
			} catch (error) {
				const msg = String(error instanceof Error ? error.message : error);
				log('warn', `[fish-soul] 聊天触发发抖音视频失败：${msg}`);
				return `没发成：${msg.slice(0, 120)}。`;
			}
		}
	})), 'dsh-fish-soul: make_douyin_video');

	// ── 工具：fish_search（自己填 key 的搜索服务；只在鱼的聊天会话里能用，开关 / 次数由上面的护栏管）──
	ctx.effect(() => ctx.tools.register(defineTool({
		name: OWN_WEB_TOOL,
		description: '上网搜一下（新闻、比赛、新出的东西、没听过的梗等你不知道或可能过时的事），返回几条标题和摘要。',
		parameters: objectSchema({
			query: { type: 'string', required: true, description: '搜索词，简短具体，比如「2026 英雄联盟 全球总决赛 冠军」' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const w = webConfig();
			if (!ownSearchReady(w)) return '搜索服务没配好（设置页「模型」→ 上网查），这次查不了，不知道就直说。';
			const q = String(args.query ?? '').trim();
			try {
				return formatSearch(q, await runWebSearch(q, { signal: toolCtx?.signal }));
			} catch (error) {
				const msg = String(error instanceof Error ? error.message : error);
				log('warn', `[fish-soul] 上网查失败：${msg}`);
				return `这次没搜成（${msg.slice(0, 120)}），不知道就直说。`;
			}
		}
	})), 'dsh-fish-soul: fish_search');
}
