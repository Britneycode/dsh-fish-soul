/**
 * gateway-behavior.js —— v0.9 网关的"习惯"部分（混入 ChatGateway.prototype）：
 * 心情 → 回复快慢 / 插话 / 表情包和语音、去 AI 味、展开合并转发、群里冷热、戳回去 / 表情回应 / 正在输入、
 * 按聊天选模型、每轮判断心情。所有 OneBot 扩展接口都是"试一下"：不支持就记住、以后不再调。
 */
import { behaviorConfig, moodProfile, firstDelayMs, deAi, splitChat, stripSelfName, forwardLines, GroupHeat, resolveChatModel, FORWARD_MARK, NEUTRAL_MOOD } from './behavior.js';
import { service } from './gateway-util.js';

/** 表情回应用的 QQ 表情 id：赞 / OK / 微笑；开心时爱心 / 笑哭；难过时流泪；生气时不回应 */
const REACT_IDS = { '': ['76', '124', '14'], 开心: ['66', '76', '182'], 感动: ['66'], 想念: ['66'], 担心: ['76'], 委屈: ['5'], 失落: ['5'] };

export const behaviorMethods = {
	behavior() {
		return behaviorConfig(this.getConfig().behavior);
	},

	/** 她现在（对这个人）的状态 → 行为倍率；没开"心情影响行为"或者拿不到就是 1。 */
	moodOf(person) {
		if (!this.behavior().moodAffects) return NEUTRAL_MOOD;
		try { return this.soul.moodFor?.(person ?? null) ?? NEUTRAL_MOOD; } catch { return NEUTRAL_MOOD; }
	},

	sleep(ms) {
		return ms > 0 ? new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }) : Promise.resolve();
	},

	heatTracker() {
		this._heat ??= new GroupHeat();
		return this._heat;
	},

	heatOf(channelId) {
		const cfg = this.behavior().heat;
		if (!cfg.enabled) return { state: 'off', label: '', factor: 1, count: 0, speakers: 0 };
		return this.heatTracker().state(channelId, cfg, this.lastSpoke.get(channelId) ?? 0);
	},

	/** 调一个可能不支持的 OneBot 扩展接口；明确不支持的记住，以后不再调。 */
	async tryCall(action, params) {
		this._unsupported ??= new Set();
		if (typeof this.channel.call !== 'function' || !this.channel.connected || this._unsupported.has(action)) return false;
		try {
			await this.channel.call(action, params, 8000);
			return true;
		} catch (error) {
			if (/1404|不支持|not ?(found|support)|unknown|未知|不存在/i.test(String(error instanceof Error ? error.message : error))) this._unsupported.add(action);
			return false;
		}
	},

	/** 合并转发：取一层内容拼进正文（限条数）；取不到就保持"暂时看不了"。 */
	async expandForwards(m) {
		const cfg = this.behavior().forward;
		if (!cfg.enabled || !Array.isArray(m.forwards) || m.forwards.length === 0) return;
		for (const f of m.forwards.slice(0, 2)) {
			let data = f.content;
			if (!data && f.id && typeof this.channel.call === 'function' && this.channel.connected) {
				try { data = await this.channel.call('get_forward_msg', { message_id: f.id, id: f.id }, 8000); } catch { data = null; }
			}
			const lines = data ? forwardLines(data, { maxLines: cfg.maxLines }) : [];
			if (lines.length === 0 || !m.text.includes(FORWARD_MARK)) continue;
			m.text = m.text.replace(FORWARD_MARK, `【合并转发（${lines.length} 条）：\n${lines.join('\n')}\n】`);
		}
	},

	/** 被戳了：按概率戳回去（群里 / 私聊）。 */
	async pokeBack(groupId, userId) {
		const cfg = this.behavior().interactions;
		if (!cfg.pokeBack || this.random() >= cfg.pokeBackChance) return false;
		const uid = Number(userId);
		const calls = groupId !== null
			? [['send_poke', { group_id: Number(groupId), user_id: uid }], ['group_poke', { group_id: Number(groupId), user_id: uid }]]
			: [['send_poke', { user_id: uid }], ['friend_poke', { user_id: uid }]];
		for (const [action, params] of calls) {
			if (await this.tryCall(action, params)) {
				this.note('poke', { channelId: groupId !== null ? `group:${groupId}` : `private:${userId}`, reason: '戳了回去' });
				return true;
			}
		}
		return false;
	},

	/** 群里叫她的那条：按概率点个表情回应（生气的时候不点）。 */
	async reactTo(m, person) {
		const cfg = this.behavior().interactions;
		if (!cfg.react || m.chatType !== 'group' || !/^\d+$/.test(String(m.messageId)) || this.random() >= cfg.reactChance) return false;
		const ids = REACT_IDS[this.moodOf(person).mood] ?? null;
		if (!ids) return false;
		const emoji = ids[Math.floor(this.random() * ids.length) % ids.length];
		const ok = await this.tryCall('set_msg_emoji_like', { message_id: Number(m.messageId), emoji_id: emoji });
		if (ok) this.note('react', { channelId: m.channelId, who: m.nickname, text: m.text, reason: `点了个表情回应（${emoji}）` });
		return ok;
	},

	/** QQ 私聊：显示"对方正在输入"（支持的实现才有）。 */
	typing(m) {
		if (!this.behavior().interactions.typing || m.chatType !== 'private' || m.channel !== 'qq') return;
		void this.tryCall('set_input_status', { user_id: Number(m.userId), event_type: 1 });
	},

	/** 这个聊天用哪个模型（设置页「模型 · 聊天用哪个模型」）；null = 跟 DSH 默认。 */
	chatModelFor(channelId) {
		let ids = [];
		try { ids = (service(this.ctx, 'llm')?.listProviders?.() ?? []).map((p) => String(p.id ?? p.name)); } catch { ids = []; }
		const sel = resolveChatModel(this.getConfig().chatModels, channelId, { known: (p) => ids.length === 0 || ids.includes(p) });
		return sel === null ? null : { provider: sel.provider, model: sel.model };
	},

	/** 已经开着的会话：模型和设置不一样就切过去（清掉设置后切回 DSH 默认）。 */
	applyChatModel(agent, channelId) {
		const m = agent?.model;
		if (!m || typeof m.select !== 'function') return;
		this._modelApplied ??= new Set();
		let want = this.chatModelFor(channelId);
		if (want === null) {
			if (!this._modelApplied.has(agent.id)) return;
			this._modelApplied.delete(agent.id);
			want = this.modelSelection() ?? null;
			if (want === null) return;
		} else this._modelApplied.add(agent.id);
		try {
			const cur = m.current?.();
			if (cur && cur.provider === want.provider && cur.model === want.model) return;
			m.select({ provider: want.provider, model: want.model });
			this.log('info', `[fish-soul] ${this.titleOf(channelId)} 换成模型 ${want.model}`);
		} catch (error) {
			this.log('warn', `[fish-soul] 切换模型失败：${String(error instanceof Error ? error.message : error)}`);
		}
	},

	/** 每轮判断心情（默认关，超时不等）。 */
	async judgeTurn(channelId, speakers) {
		if (!this.behavior().turnMood.enabled || typeof this.soul.judgeMood !== 'function') return;
		const jobs = speakers.filter((s) => s.person).slice(-2).map((s) => this.soul.judgeMood(s.person, s.displayName, s.text, channelId).catch(() => null));
		if (jobs.length > 0) await this.withTimeout(Promise.all(jobs), 6000);
	},

	/** 发出去之前去 AI 味（+ 拆成几条）；整段都是套话就返回 ''（这轮不发）。 */
	cleanOut(text, row) {
		// 自己的名字前缀（"鱼：…"）不管开没开去 AI 味都去掉
		const name = String(this.soul.personaName?.() ?? '').trim();
		text = stripSelfName(text, [name, '鱼', '小鱼', 'feiyu']);
		const cfg = this.behavior().outFilter;
		if (!cfg.enabled || String(text ?? '').trim() === '') return text;
		const r = deAi(text, { maxChars: cfg.maxChars, extra: cfg.extra });
		const changes = [...r.changes];
		let out = r.text;
		// 一段好几句就拆成几条、去掉句尾的句号（单独的开关）
		if (cfg.split && out.trim() !== '') {
			const s = splitChat(out, { random: this.random });
			out = s.text;
			changes.push(...s.changes);
		}
		if (changes.length > 0) this.note('filtered', { channelId: row.channel_id, title: row.title, text, reason: `去 AI 味：${changes.join('、')}` });
		return out;
	},

	/** 心情不好时：表情包按概率不发（只管 _stickers 里的），语音按概率改成打字。 */
	moodPick(profile, 图, row) {
		if (!(profile.sticker < 1)) return 图;
		return 图.filter((g) => {
			if (!/_stickers[\\/]/.test(String(g.value ?? '')) || this.random() < profile.sticker) return true;
			this.note('filtered', { channelId: row.channel_id, title: row.title, text: String(g.value), reason: `${profile.mood || profile.tone}，这张表情包没发` });
			return false;
		});
	},

	moodVoice(profile) {
		return !(profile.voice < 1) || this.random() < profile.voice;
	},

	firstDelay(profile) {
		return firstDelayMs(profile, this.random);
	}
};
