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
		relaySenderId, parseRelayTarget, log, toolWhen = {},
		RELAY_TOOL, RELAY_FRIEND_TOOL, DOUYIN_VIDEO_TOOL, DOUYIN_NOTE_TOOL, OWN_WEB_TOOL
	} = deps;

	const textOutput = {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: String(value) }]
	};

	const reg = (def, label) => {
		const when = toolWhen[def.name];
		return ctx.effect(() => (when ? ctx.tools.register(def, { when }) : ctx.tools.register(def)), label);
	};

	// ── 工具：remember / recall / forget ──
	reg(defineTool({
		name: 'remember',
		description: '写入长期记忆（fact/event/feeling）。有未来约定或提醒时同填 dueInMinutes（优先）或 dueAtIso + proactiveReason。',
		parameters: objectSchema({
			content: { type: 'string', required: true, description: '要记住的完整一句话' },
			kind: { type: 'string', enum: ['fact', 'event', 'feeling'], required: true, description: "'fact' | 'event' | 'feeling'" },
			importance: { type: 'number', description: '1..5，>=3 豁免衰减' },
			emotion: { type: 'number', description: '-2..+2' },
			dueInMinutes: { type: 'number', description: '相对当前虚拟时间的分钟数（优先）' },
			dueAtIso: { type: 'string', description: '或绝对时间 YYYY-MM-DDTHH:mm（UTC+8）' },
			proactiveReason: { type: 'string', description: '到期主动提醒理由' },
			speaker: { type: 'string', description: '群里说话人署名，私聊留空' },
			private: { type: 'boolean', description: '私聊里的健康/感情/家庭/钱/秘密填 true' }
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
	}), 'dsh-fish-soul: remember');

	reg(defineTool({
		name: 'recall',
		description: '主动检索当前说话人的长期记忆（BM25 + 向量融合）。',
		parameters: objectSchema({
			query: { type: 'string', required: true, description: '检索词或问题' },
			speaker: { type: 'string', description: '群里说话人署名，私聊留空' }
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
			const budget = Math.max(400, Number(retrievalCfg().tokenBudget ?? 1200) || 1200);
			const out = [];
			const ids = [];
			let spent = 0;
			for (const m of memories) {
				const line = `#${m.id}${memoryLabel(m, now).slice(1)}`;
				const nextSpent = spent + line.length + (out.length > 0 ? 1 : 0);
				if (out.length > 0 && nextSpent > budget) break;
				out.push(line);
				ids.push(m.id);
				spent = nextSpent;
			}
			reinforce(db, ids, now);
			return out.join('\n');
		}
	}), 'dsh-fish-soul: recall');

	reg(defineTool({
		name: 'forget',
		description: '按 id 删除当前说话人的长期记忆，不可删他人记忆。',
		parameters: objectSchema({
			id: { type: 'number', required: true, description: '记忆 id' },
			speaker: { type: 'string', description: '群里说话人署名' }
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
	}), 'dsh-fish-soul: forget');

	// ── 工具：send_elsewhere（主人在 QQ 私聊里让她去抖音 / B站 私信自己一条）──
	reg(defineTool({
		name: RELAY_TOOL,
		description: '在抖音/B站给主人发私信。仅主人明确要求时在主人私聊里用，直接写要发的原话。',
		parameters: objectSchema({
			platform: { type: 'string', enum: ['douyin', 'bili'], required: true, description: "'douyin' | 'bili'" },
			text: { type: 'string', required: true, description: '要发出去的原话（一段，别加引号）' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const session = sessionForTool(toolCtx);
			const channelId = String(session.channelId ?? '');
			if (channelId === '' || gateway === null) return '不知道现在是在哪个聊天里，先不发。';
			if (!gateway.isMasterPrivateChat(channelId)) return '这个只能在主人的私聊里用。';
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
	}), 'dsh-fish-soul: send_elsewhere');

	// ── 工具：relay_to_friend（白名单里的人 A 托她给白名单里的 B 带句话；默认关）──
	reg(defineTool({
		name: RELAY_FRIEND_TOOL,
		description: '帮白名单里的熟人给另一位白名单熟人带话。仅对方明确要求时用；to 必须填平台 uid（不认昵称）；失败时如实告知原因。',
		parameters: objectSchema({
			to: { type: 'string', required: true, description: "收件人平台 uid，如 to='12345' 配 platform='qq' 或 to='bili:12345'" },
			platform: { type: 'string', description: "平台：'qq' | 'bili' | 'douyin'（to 已带前缀可省略；不认的值会拒）" },
			text: { type: 'string', required: true, description: '要带的那句话（一段，别加引号）' }
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
	}), 'dsh-fish-soul: relay_to_friend');

	// ── 工具：make_douyin_video（主人在私聊里让她做一条视频并发到抖音）──
	reg(defineTool({
		name: DOUYIN_VIDEO_TOOL,
		description: '生成一条短视频并发到抖音。仅主人在私聊里明确要求时用。',
		parameters: objectSchema({
			text: { type: 'string', description: '画面/配文（15～80 字；不填按此刻心情自拟）' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const session = sessionForTool(toolCtx);
			const channelId = String(session.channelId ?? '');
			if (channelId === '' || gateway === null) return '不知道现在是在哪个聊天里，先不发。';
			if (!gateway.isMasterPrivateChat(channelId)) return '这个只能在主人的私聊里用。';
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
	}), 'dsh-fish-soul: make_douyin_video');

	// ── 工具：make_douyin_note（主人在私聊里让她发一条图文到抖音）──
	reg(defineTool({
		name: DOUYIN_NOTE_TOOL,
		description: '把文字做成卡片发一条抖音图文。仅主人在私聊里明确要求时用。',
		parameters: objectSchema({
			text: { type: 'string', description: '图文配文（不填按此刻心情自拟）' }
		}),
		output: textOutput,
		async execute(args, toolCtx) {
			const session = sessionForTool(toolCtx);
			const channelId = String(session.channelId ?? '');
			if (channelId === '' || gateway === null) return '不知道现在是在哪个聊天里，先不发。';
			if (!gateway.isMasterPrivateChat(channelId)) return '这个只能在主人的私聊里用。';
			if ((getConfig().douyin ?? {}).enabled !== true) return '抖音总开关没开（设置页「抖音」→ 抖音接入）。';
			if (!douyinSocial) return '抖音模块没加载。';
			if (!douyinSocial.cfg().post.enabled) return '还没打开「自己发图文」（设置页「抖音」→ 作品和评论 → 自己发图文）。';
			const blocked = douyinSocial.postBlockReason?.();
			if (blocked) return `现在发不了：${blocked}。`;
			if (douyinSocial.posting) return '正在发另一条作品，稍等会儿再试。';
			if (!douyinSocial.ready) return `抖音还没准备好：${douyinSocial.notReadyText()}。`;
			const text = String(args?.text ?? '').trim();
			try {
				const r = await douyinSocial.post({ force: true, kind: 'post', ...(text !== '' ? { text } : {}) });
				if (!r?.ok) return `没发成：${r?.error ?? '原因不明'}。`;
				return `已经发布到抖音了：${r.text}。`;
			} catch (error) {
				const msg = String(error instanceof Error ? error.message : error);
				log('warn', `[fish-soul] 聊天触发发抖音图文失败：${msg}`);
				return `没发成：${msg.slice(0, 120)}。`;
			}
		}
	}), 'dsh-fish-soul: make_douyin_note');

	// ── 工具：fish_search（自己填 key 的搜索服务；只在鱼的聊天会话里能用，开关 / 次数由上面的护栏管）──
	reg(defineTool({
		name: OWN_WEB_TOOL,
		description: '上网查不知道或可能过时的事（新闻/比赛/新梗），返回标题和摘要。',
		parameters: objectSchema({
			query: { type: 'string', required: true, description: '简短具体的搜索词' }
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
	}), 'dsh-fish-soul: fish_search');
}

/** 构造聊天专有工具（及定时任务工具）的作用域判定函数：非鱼会话（如 DSH 桌面）不挂载定义，省下首轮 schema token。 */
export function buildChatToolWhen({ getGateway, sessions, getConfig, webConfig, RELAY_TOOL, RELAY_FRIEND_TOOL, DOUYIN_VIDEO_TOOL, DOUYIN_NOTE_TOOL, OWN_WEB_TOOL }) {
	const agentChannelFor = (toolCtx) => {
		const id = String(toolCtx?.agent?.id ?? toolCtx?.scope?.id ?? toolCtx?.sessionId ?? '');
		if (id === '') return '';
		const gw = getGateway();
		return gw?.turns?.get(id)?.channelId ?? sessions.get(id)?.channelId ?? gw?.chatForSession(id)?.channel_id ?? '';
	};
	const isFishChat = (toolCtx) => agentChannelFor(toolCtx) !== '';
	const isMasterChatWhen = (toolCtx) => {
		const chId = agentChannelFor(toolCtx);
		const gw = getGateway();
		return chId !== '' && gw !== null && typeof gw.isMasterChannel === 'function' && gw.isMasterChannel(chId);
	};
	const isMasterPrivateWhen = (toolCtx) => {
		const chId = agentChannelFor(toolCtx);
		const gw = getGateway();
		return chId !== '' && gw !== null && typeof gw.isMasterPrivateChat === 'function' && gw.isMasterPrivateChat(chId);
	};
	const toolWhen = {
		[RELAY_TOOL]: isMasterPrivateWhen,
		[RELAY_FRIEND_TOOL]: (toolCtx) => isFishChat(toolCtx) && getConfig().relay?.enabled === true,
		[DOUYIN_VIDEO_TOOL]: (toolCtx) => isMasterPrivateWhen(toolCtx) && getConfig().douyin?.enabled === true && getConfig().douyin?.video?.enabled === true,
		[DOUYIN_NOTE_TOOL]: (toolCtx) => isMasterPrivateWhen(toolCtx) && getConfig().douyin?.enabled === true && getConfig().douyin?.post?.enabled === true,
		[OWN_WEB_TOOL]: (toolCtx) => isFishChat(toolCtx) && webConfig().enabled === true && webConfig().provider !== 'host'
	};
	return { isMasterChatWhen, toolWhen };
}

/** 兜底工具护栏：即使会话按默认预设恢复或未走 restrict，仍按通道/档位与本轮身份实时鉴权。 */
export function registerToolGuard(ctx, {
	getGateway, getConfig, platformOf, isAllowedVoiceInput,
	webConfig, webUsedToday, countWebUse, markHostWebSeen,
	CHAT_TOOLS, WEB_TOOLS, OWN_WEB_TOOL, isOpenMotionTool, log
}) {
	try {
		if (typeof ctx.tools.guard !== 'function') {
			log('warn', '[fish-soul] 宿主没有 tools.guard：QQ 会话的工具限制只靠建会话时的 restrict');
			return;
		}
		const allowed = new Set(CHAT_TOOLS);
		const sessionOpen = (id) => {
			const gw = getGateway();
			const row = gw?.chatForSession(id);
			return row !== null && row !== undefined && gw.sessionOpenFor(row.channel_id) === true;
		};
		const isMasterSession = (id) => {
			const gw = getGateway();
			const row = gw?.chatForSession(id);
			return row !== null && row !== undefined && gw.isMasterChannel(row.channel_id) === true;
		};
		ctx.effect(() => {
			const off = ctx.tools.guard((exec) => {
				const gw = getGateway();
				const cfg = getConfig();
				const id = exec?.agent?.id;
				const activeChannel = gw?.turns?.get(String(id))?.channelId;
				const boundChannel = gw?.chatForSession(String(id))?.channel_id;
				let douyinMaster = false;
				if ((activeChannel && platformOf(activeChannel) === 'douyin') || (boundChannel && platformOf(boundChannel) === 'douyin')) {
					const douyinChannel = activeChannel && platformOf(activeChannel) === 'douyin'
						? activeChannel
						: boundChannel && platformOf(boundChannel) === 'douyin' ? boundChannel : '';
					const douyinUin = douyinChannel === '' ? '' : String(gw?.douyinUinOf?.({ channelId: douyinChannel }) ?? '');
					const masterUin = String(cfg.masterQqUin ?? '').trim();
					if (douyinUin === '' || masterUin === '' || douyinUin !== masterUin) return '抖音身份尚未验证，暂不开放聊天工具';
					douyinMaster = gw.sessionAllowMode() !== 'memory';
				}
				const ours = id !== undefined && id !== null && gw?.isOurSession(id) === true;
				if (!ours && WEB_TOOLS.includes(exec?.name)) markHostWebSeen();
				if (!ours) return exec?.name === OWN_WEB_TOOL ? `${OWN_WEB_TOOL} 只给鱼的聊天会话用（DSH 自己的会话请用 web_search）` : undefined;
				if (WEB_TOOLS.includes(exec.name) || exec.name === OWN_WEB_TOOL) {
					const w = webConfig();
					if (!w.enabled) return `聊天会话里现在不能上网（设置页「模型」里打开「聊天时可以上网查」）`;
					if (exec.name === OWN_WEB_TOOL && w.provider === 'host') return `现在用的是 DSH 自带的搜索，请用 web_search`;
					if (exec.name !== OWN_WEB_TOOL && w.provider !== 'host') return `现在用的是自己配的搜索服务，请用 ${OWN_WEB_TOOL}`;
					if (webUsedToday() >= w.perDay) return `今天上网查的次数用完了（每天 ${w.perDay} 次）`;
					if (WEB_TOOLS.includes(exec.name)) markHostWebSeen();
					countWebUse(id, exec.name);
					return undefined;
				}
				if (exec.name === 'sound_read' && cfg.voice?.saveIncoming === true && !sessionOpen(id)) {
					const st = gw?.turns?.get(String(id));
					return st?.fromUs === true && st.channelId && platformOf(st.channelId) === 'qq' && cfg.voice?.enabled === true && isAllowedVoiceInput(exec.arguments, st.voicePaths)
						? undefined : '只能分析当前 QQ 说话人本轮保存的语音，且只允许 input 参数';
				}
				if (exec.name === 'run_code') return `聊天会话里不能运行代码（放开工具也不放 run_code：它能跑任意程序）`;
				if (sessionOpen(id)) return undefined;
				if (douyinMaster && !isOpenMotionTool(exec.name)) return undefined;
				if (isOpenMotionTool(exec.name)) {
					return isMasterSession(id) ? undefined : 'OpenMotion 视频工具只能在主人的私聊里用';
				}
				return allowed.has(exec.name) ? undefined : `聊天会话（QQ / B站 / 抖音）里不能用 ${exec.name}（只开放记忆工具、跨平台转达、熟人传话和上网查；设置页「模型」里可以放开）`;
			});
			const gw = getGateway();
			if (gw) gw.voiceGuardReady = true;
			return () => { const curGw = getGateway(); if (curGw) curGw.voiceGuardReady = false; off?.(); };
		}, 'dsh-fish-soul: qq tool guard');
	} catch (error) {
		log('error', `[fish-soul] 工具护栏挂不上：${String(error instanceof Error ? error.message : error)}`);
	}
}
