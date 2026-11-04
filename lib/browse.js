/**
 * browse.js —— 鱼自己刷 B站：空闲时从关注 / 首页推荐里挑几条没看过的视频，
 * 读标题、简介、字幕节选和热评，用她自己的口吻写一两句感受，记进"自己的记忆"（owner_id='self'），
 * 聊天时就能自然说出"我今天刷到……"。默认不点赞、不投币、不评论（点赞可在设置页打开）。
 */
import { tokenizeForBm25 } from './segment.js';
import { getKv, setKv } from './db.js';

const BV_RE = /BV[0-9A-Za-z]{10}/g;
const SHORT_RE = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/g;
const DESCRIBE_TTL_MS = 3600_000;
const DAY_MS = 86_400_000;

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').replace(/【/g, '〔').replace(/】/g, '〕').trim().slice(0, n);

/** 文本里的 BV 号与 b23 短链。 */
export function findVideoRefs(text) {
	const s = String(text ?? '');
	return { bvids: [...new Set(s.match(BV_RE) ?? [])], shorts: [...new Set(s.match(SHORT_RE) ?? [])] };
}

/**
 * 一轮刷完：记一条动态；挑一条她标了 [分享] 的交给自走层（一轮最多一条）。B站 / 抖音共用。
 * @param {{note?: Function|null, share?: Function|null, log: Function}} self
 */
export function afterRound(self, label, watched, pick) {
	const seen = watched.filter((w) => !w.skipped);
	try {
		self.note?.('browse', {
			title: label,
			reason: watched.length === 0 ? `刷${label}：这轮没刷到新视频` : `刷${label}：看了 ${watched.length} 条${seen.length < watched.length ? `，划走 ${watched.length - seen.length} 条` : ''}`,
			text: seen.map((w) => `《${String(pick(w).title ?? '').slice(0, 20)}》`).join(' ')
		});
	} catch { /* 动态可缺 */ }
	const s = watched.find((w) => w.share);
	if (!s || typeof self.share !== 'function') return;
	try {
		const r = self.share({ platform: label, ...pick(s), url: s.url, impression: s.impression });
		self.note?.(r?.ok ? 'share' : 'browse', { title: label, reason: r?.ok ? `想把《${String(pick(s).title ?? '').slice(0, 20)}》分享给你` : `想分享但没排上：${r?.error ?? '不知道为什么'}`, text: s.url });
	} catch (error) {
		self.log('warn', `[fish-soul] 排分享失败：${String(error instanceof Error ? error.message : error)}`);
	}
}

export class BiliBrowser {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {import('./clock.js').VirtualClock} deps.clock
	 * @param {import('./channels/bilibili.js').BiliClient} deps.client
	 * @param {() => object} deps.getConfig 返回 config.bili
	 * @param {(prompt: string) => Promise<string|null>} deps.callLlm
	 * @param {() => {name: string, brief: string}} deps.persona
	 * @param {{enqueueRealtime(id: number, text: string): void}} [deps.worker]
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {[number, number]} [deps.watchDelayMs] 两条视频之间"看"多久（真实毫秒）
	 */
	constructor({ db, clock, client, getConfig, callLlm, persona, worker, log, watchDelayMs = [8000, 20000], share, note, frames }) {
		this.share = share ?? null; // 刷到特别想分享的：交给自走层排一条主动消息（带链接）
		this.note = note ?? null; // 记一条动态
		this.db = db;
		this.clock = clock;
		this.client = client;
		this.getConfig = getConfig;
		this.callLlm = callLlm;
		this.persona = persona;
		this.worker = worker;
		this.log = log ?? (() => {});
		this.watchDelayMs = watchDelayMs;
		this.running = false;
		this.described = new Map();
		this.framesOf = frames ?? null; // 抽九宫格看画面（可缺：没有就只读文字）
	}

	cfg() {
		const b = this.getConfig() ?? {};
		const br = b.browse ?? {};
		const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : d);
		return {
			enabled: b.enabled === true && br.enabled !== false,
			perDay: num(br.perDay, 3, 0, 12),
			videosPerSession: num(br.videosPerSession, 3, 1, 6),
			like: br.like === true,
			share: br.share !== false,
			favorite: br.favorite === true,
			favoritePerDay: num(br.favoritePerDay, 2, 0, 10),
			commentReply: br.commentReply === true,
			commentReplyPerDay: num(br.commentReplyPerDay, 1, 0, 5),
			hotComments: num(br.hotComments, 6, 0, 10),
			danmaku: br.danmaku !== false,
			comment: br.comment === true,
			commentPerDay: num(br.commentPerDay, 1, 0, 5),
			frames: br.frames === true,
			framesPerDay: num(br.framesPerDay, 1, 0, 5),
			framesPerDayChat: num(br.framesPerDayChat, 10, 0, 30),
			search: br.search === true,
			searchKeywords: (Array.isArray(br.searchKeywords) ? br.searchKeywords : [])
				.map((w) => String(w ?? '').trim()).filter((w) => w !== '').slice(0, 20),
			searchPerDay: num(br.searchPerDay, 2, 0, 12),
			maxLinks: num(br.maxLinks, 3, 1, 5),
			subtitleChars: num(br.subtitleChars, 1200, 0, 3000),
			descChars: num(br.descChars, 300, 0, 1000),
			hotCommentChars: num(br.hotCommentChars, 80, 0, 500)
		};
	}

	seen(bvid) {
		return this.db.prepare('SELECT 1 FROM bili_seen WHERE bvid = ?').get(bvid) !== undefined;
	}

	async candidates(count) {
		const pool = [];
		const add = (list) => { for (const it of list) if (!this.seen(it.bvid) && !pool.some((p) => p.bvid === it.bvid)) pool.push(it); };
		try { add((await this.client.followingVideos()).slice(0, 8)); } catch (error) {
			this.log('warn', `[fish-soul] 取关注动态失败：${String(error instanceof Error ? error.message : error)}`);
		}
		const following = pool.splice(0, pool.length);
		const picked = following.length > 0 ? [following[Math.floor(Math.random() * Math.min(3, following.length))]] : [];
		// 站内搜索是"又一个来源"，不是替代：先只取一半名额放进 pool 头部，剩下的等关注 / 推荐选完还有空位再补。
		// 不这么分会把推荐全挤掉（搜索 8 条 > 一轮 3~6 条），审 #38 发现。
		let searchRest = [];
		const keyword = await this.nextSearchKeyword();
		if (keyword !== '') {
			try {
				const found = await this.client.search(keyword, 8);
				if (found.length > 0) setKv(this.db, this.searchDayKey(), this.searchedToday() + 1);
				this.log('info', `[fish-soul] 站内搜「${keyword}」拿到 ${found.length} 条`);
				// 名额只有 1 个时让位给关注 / 推荐：搜索是"又一个来源"，不该独占唯一的一眼（审 #38）
				const half = count <= 1 ? 0 : Math.max(1, count - Math.floor(count / 2));
				if (half > 0) add(found.slice(0, half));
				searchRest = found.slice(half);
			} catch (error) {
				this.log('warn', `[fish-soul] 站内搜「${keyword}」失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		try { add(await this.client.recommend(12)); } catch (error) {
			this.log('warn', `[fish-soul] 取首页推荐失败，改看热门：${String(error instanceof Error ? error.message : error)}`);
			try { add(await this.client.popular(12)); } catch { /* 都失败就算了 */ }
		}
		for (const it of pool) {
			if (picked.length >= count) break;
			if (!picked.some((p) => p.bvid === it.bvid)) picked.push(it);
		}
		// 关注 / 推荐不够（都失败、或都看过了）→ 才用搜索剩下的补，别让这一轮空跑
		for (const it of searchRest) {
			if (picked.length >= count) break;
			if (!this.seen(it.bvid) && !picked.some((p) => p.bvid === it.bvid)) picked.push(it);
		}
		return picked.slice(0, count);
	}

	/** 视频的"看到的内容"：详情 + 字幕节选 + 热评（字幕要登录，取不到就只看简介和评论）。 */
	async gather(bvid, { subtitleChars = 1200, danmaku = this.cfg().danmaku } = {}) {
		const info = await this.client.view(bvid);
		let subtitle = '';
		if (subtitleChars > 0) {
			try { subtitle = await this.client.subtitleText(info.bvid, info.cid, subtitleChars); } catch { /* 没字幕 */ }
		}
		let comments = [];
		try { comments = await this.client.hotComments(info.aid, this.cfg().hotComments); } catch { /* 没评论 */ }
		let danmakuLines = [];
		if (danmaku && typeof this.client.danmaku === 'function') {
			try { danmakuLines = await this.client.danmaku(info.cid, 12); } catch { /* 没弹幕 / 解不开 */ }
		}
		return { ...info, subtitle, comments, danmaku: danmakuLines };
	}

	framesDayKey() {
		return `bili.frames.${this.clock.getRoleDateParts().dateStr}`;
	}

	framedToday() {
		return Number(getKv(this.db, this.framesDayKey(), 0)) || 0;
	}

	/** 你发链接给她时抽的帧，另记一本账，不占她自己刷视频的次数。 */
	framesChatDayKey() {
		return `bili.frames.chat.${this.clock.getRoleDateParts().dateStr}`;
	}

	framedTodayChat() {
		return Number(getKv(this.db, this.framesChatDayKey(), 0)) || 0;
	}

	favDayKey() {
		return `bili.fav.${this.clock.getRoleDateParts().dateStr}`;
	}

	replyDayKey() {
		return `bili.reply.${this.clock.getRoleDateParts().dateStr}`;
	}

	repliedToday() {
		return Number(getKv(this.db, this.replyDayKey(), 0)) || 0;
	}

	/** 最近一次回过的评论（设置页显示用），没回过返回 null。 */
	recentReply() {
		return getKv(this.db, 'bili.reply.last', null) ?? null;
	}

	favoritedToday() {
		return Number(getKv(this.db, this.favDayKey(), 0)) || 0;
	}

	searchDayKey() {
		return `bili.search.${this.clock.getRoleDateParts().dateStr}`;
	}

	searchedToday() {
		return Number(getKv(this.db, this.searchDayKey(), 0)) || 0;
	}

	commentDayKey() {
		return `bili.comment.${this.clock.getRoleDateParts().dateStr}`;
	}

	commentedToday() {
		return Number(getKv(this.db, this.commentDayKey(), 0)) || 0;
	}

	/** 她最近看过的几条标题（给她自己提搜索词当原料）。 */
	recentTitles(n = 5) {
		try {
			return this.db.prepare('SELECT title, owner_name FROM bili_seen ORDER BY seen_real_at DESC LIMIT ?').all(n)
				.map((r) => oneLine(r.title, 40)).filter(Boolean);
		} catch { return []; }
	}

	/** 最近搜过的词（最新的在前，最多 5 个），给提词当"别重复"的参考。 */
	recentKeywords() {
		try {
			const raw = JSON.parse(getKv(this.db, 'bili.search.recent', '[]'));
			return Array.isArray(raw) ? raw.map((x) => String(x ?? '')).filter((x) => x !== '').slice(0, 5) : [];
		} catch { return []; }
	}

	/** 记下这次搜的词，重复的挪到最前。 */
	noteKeyword(word) {
		const w = String(word ?? '').trim();
		if (w === '') return;
		const list = [w, ...this.recentKeywords().filter((x) => x !== w)].slice(0, 5);
		try { setKv(this.db, 'bili.search.recent', JSON.stringify(list)); } catch { /* 记不住不影响搜索 */ }
	}

	/** 没填词表时，让她自己按最近看过的提一个搜索词（一次小模型调用，只输出几个字）。 */
	async draftSearchKeyword() {
		const titles = this.recentTitles(5);
		if (titles.length === 0) return '';
		const p = this.persona?.() ?? { name: '鱼' };
		const recent = this.recentKeywords();
		const prompt = [
			`你是「${p.name}」。你最近刷到这些视频：`,
			...titles.map((t) => `- ${t}`),
			...(recent.length > 0 ? ['', `你最近已经搜过：${recent.join('、')}。这次换个方向，别重复。`] : []),
			'',
			'你现在想在 B站 搜一个新词，找点新鲜的。只输出一个 2-8 字的搜索词，不要解释、不要引号、不要标点。'
		].join('\n');
		try {
			const raw = String((await this.callLlm(prompt)) ?? '').trim();
			const first = raw.split(/\n/)[0] ?? '';
			return oneLine(first.replace(/[「」“”"'`]/g, ''), 12);
		} catch { return ''; }
	}

	/** 这一轮要不要搜、搜什么词（没开 / 今天额度用完 / 想不出词 → 空串）。 */
	async nextSearchKeyword() {
		const c = this.cfg();
		if (c.search !== true) return '';
		if (this.searchedToday() >= Number(c.searchPerDay ?? 2)) return '';
		const words = (Array.isArray(c.searchKeywords) ? c.searchKeywords : [])
			.map((w) => String(w ?? '').trim()).filter((w) => w !== '');
		if (words.length > 0) {
			const picked = words[Math.floor(Math.random() * words.length)];
			this.noteKeyword(picked);
			return picked;
		}
		const drafted = await this.draftSearchKeyword();
		if (drafted !== '') this.noteKeyword(drafted);
		return drafted;
	}

	promptFor(v, like, share = false, favorite = false, hasFrames = false) {
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		return [
			`你是「${p.name}」。${p.brief}`.trim(),
			'你刚在 B站刷到一个视频：',
			`标题：${oneLine(v.title, 80)}`,
			`UP主：${oneLine(v.owner, 30) || '未知'}${v.tname ? `；分区：${v.tname}` : ''}`,
			v.desc ? `简介：${oneLine(v.desc, 200)}` : '',
			v.subtitle ? `字幕节选：${v.subtitle}` : '（这个视频没有字幕，只能看简介和评论）',
			v.comments.length > 0 ? `热评：\n${v.comments.map((c) => `- ${c}`).join('\n')}` : '',
			hasFrames ? '画面：附了一张九宫格截图（从开头每 6 秒一格，共 9 格）。如果画面能看清，就在感受里写一句画面里的具体细节——谁在做什么、什么颜色、场景长什么样；实在看不清就写“没看到画面”。' : '',
			(v.danmaku ?? []).length > 0 ? `弹幕（按时间抽了几条）：${v.danmaku.map((d) => oneLine(d, 30)).join(' / ')}` : '',
			'',
			'用第一人称、口语化写一两句你看完的感受（大概讲了什么 + 你怎么看），不超过 80 字，不要照抄标题。',
			'完全没兴趣、划走了就只输出 [划走]。' + (like ? '特别喜欢的话在末尾加 [点赞]。' : '') + (share ? '特别有意思、很想发给朋友看的，在末尾加 [分享]（大多数视频不用）。' : '') +
				(favorite ? '以后还想再看、值得存起来的（教程、攻略、菜谱、特别喜欢的），在末尾加 [收藏]（大多数视频不用）。' : '')
		].filter((l) => l !== '').join('\n');
	}

	writeMemory(content, bvid) {
		const now = this.clock.now();
		const result = this.db.prepare(`
			INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
			                    importance, emotion, source_session, created_at, updated_at, status)
			VALUES ('feiyu', 'self', 'bili', ?, 'event', ?, ?, 1, 0, '', ?, ?, 'active')
		`).run(`bili:video:${bvid}`, content, tokenizeForBm25(content), now, now);
		const id = Number(result.lastInsertRowid);
		try { this.worker?.enqueueRealtime(id, content); } catch { /* 向量可缺 */ }
		return id;
	}

	/**
	 * 要不要抽帧看画面：开关开着、有 cid、不是短片、今天还有额度。
	 * 失败只记一条 warn，返回 null —— 绝不因为抽帧失败就看不到视频。
	 */
	async frameIfWanted(v, c) {
		if (c.frames !== true || typeof this.framesOf !== 'function') return null;
		if (!v.cid || (Number(v.duration ?? 0) < 120)) return null;
		if (this.framedToday() >= Number(c.framesPerDay ?? 1)) return null;
		try {
			const img = await this.framesOf(v);
			if (img?.data) {
				setKv(this.db, this.framesDayKey(), this.framedToday() + 1);
				return img;
			}
		} catch (error) {
			this.log('warn', `[fish-soul] 抽帧没成（照旧只看文字）：${String(error instanceof Error ? error.message : error)}`);
		}
		return null;
	}

	/** 你发链接过来时抽一帧，额度跟"自己刷"分开。 */
	async frameForLink(v, c) {
		if (c.frames !== true || typeof this.framesOf !== 'function') return null;
		if (!v.cid || (Number(v.duration ?? 0) < 60)) return null;
		if (this.framedTodayChat() >= Number(c.framesPerDayChat ?? 10)) return null;
		try {
			const img = await this.framesOf(v);
			if (img?.data) {
				setKv(this.db, this.framesChatDayKey(), this.framedTodayChat() + 1);
				return img;
			}
		} catch (error) {
			this.log('warn', `[fish-soul] 分享抽帧没成（照旧只看文字）：${String(error instanceof Error ? error.message : error)}`);
		}
		return null;
	}

	/** 把一张九宫格读成一句话，写进聊天时她能看到的那段文字里。 */
	async visualNote(v, frame) {
		try {
			const text = await this.callLlm(
				`这是 B站 视频《${oneLine(v.title, 40)}》开头的九宫格截图（每格约 6 秒）。` +
					'用一句不超过 30 字的话，写画面里看到的具体东西：谁在做什么、什么颜色、什么场景。' +
					'看不清就只写「没看清」。不要分点、不要引号、不要写"这张图"。',
				{ feature: 'browse', maxTokens: 80, images: [frame] }
			);
			const t = oneLine(String(text ?? '').replace(/^["“]|["”]$/g, ''), 40);
			return t && t !== '没看清' ? t : '';
		} catch (error) {
			this.log('warn', `[fish-soul] 读画面没成：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
	}

	/** 评论区留一句的提示词（短、口语、像真人随手写的）。 */
	commentPrompt(v, impression) {
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		return [
			`你是「${p.name}」。${p.brief}`.trim(),
			`你刚看完 B站 视频《${oneLine(v.title, 60)}》${v.owner ? `（UP主 ${oneLine(v.owner, 20)}）` : ''}。`,
			`你自己记下的感受：${oneLine(impression, 100)}`,
			'现在想在评论区留一句（不是回谁，就是自己看完想说）。',
			'要求：第一人称、口语、一到两句，不超过 25 个字；像真人随手写的，不要「打卡」「沙发」「前排」这类；不@人、不贴链接、不复述标题、不评价 UP主 本人。',
			'只想说「好看」这种空话，就只输出 [不评]。否则只输出那句话本身。'
		].filter(Boolean).join('\n');
	}

	/** 在视频底下留一句。成功返回评论文本，没留返回 ''。 */
	async commentOn(v, impression) {
		let text = '';
		try {
			const out = String((await this.callLlm(this.commentPrompt(v, impression))) ?? '').trim();
			if (/\[不评\]/.test(out)) return '';
			text = oneLine(out.replace(/^[「“"']|[」”"']$/g, ''), 25);
		} catch (error) {
			this.log('warn', `[fish-soul] 想评论没想出来：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
		if (text === '') return '';
		try {
			await Promise.race([
				this.client.replyComment({ type: 1, oid: v.aid, root: 0, parent: 0, message: text }),
				new Promise((_, reject) => setTimeout(() => reject(new Error('评论发帖超时')), 15_000))
			]);
			setKv(this.db, this.commentDayKey(), this.commentedToday() + 1);
			this.log('info', `[fish-soul] 在《${oneLine(v.title, 30)}》评论区留了一句：${text}`);
			return text;
		} catch (error) {
			this.log('warn', `[fish-soul] 评论没发出去：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
	}

	/**
	 * 楼中楼：从视频现有评论里挑一条值得搭话的，回一句（只回一条，不追着聊）。
	 * 模型输出「序号|回复内容」；[不回] / 序号不合法 / 内容为空都算没回。
	 */
	async commentReplyOn(v) {
		let list = [];
		try {
			list = await this.client.commentList(v.aid, 10);
		} catch (error) {
			this.log('warn', `[fish-soul] 读评论没成：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
		const me = String(this.client.uid ?? '');
		list = (list ?? []).filter((x) => x.content && x.rpid && String(x.mid) !== me);
		if (list.length === 0) return '';
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		const lines = [
			`你是「${p.name}」。${p.brief}`.trim(),
			`你刚看完 B站 视频《${oneLine(v.title, 50)}》。评论区长这样：`,
			...list.map((x, i) => `${i + 1}. ${x.name || '有人'}：${x.content}`),
			'挑一条你想接话的，回一句。要求：第一人称、口语、一到两句，不超过 30 个字；',
			'不要复述他说的话，不要@人，不要引战、不要跟人抬杠，不评价 UP主 本人，广告和骂人的别接。',
			'没有想接的就只输出 [不回]。要回就只输出「序号|回复内容」，两行都不要解释。'
		];
		const out = String((await this.callLlm(lines.join('\n'))) ?? '').trim();
		if (out === '' || /\[不回\]/.test(out)) return '';
		const m = out.match(/^\s*(\d{1,2})\s*[|｜]\s*([\s\S]+)$/);
		if (!m) return '';
		const pick = list[Number(m[1]) - 1];
		const text = oneLine(m[2].replace(/^[「“"']|[」”"']$/g, ''), 60);
		if (!pick || text === '') return '';
		try {
			await this.client.replyComment({ type: 1, oid: v.aid, root: pick.rpid, parent: 0, message: text });
			setKv(this.db, this.replyDayKey(), this.repliedToday() + 1);
			setKv(this.db, 'bili.reply.last', { bvid: v.bvid, title: oneLine(v.title, 40), name: pick.name, text, root: pick.rpid, at: Date.now() });
			this.log('info', `[fish-soul] 回了 @${pick.name} 的评论：${text}`);
			return text;
		} catch (error) {
			this.log('warn', `[fish-soul] 回评论没发出去：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
	}

	async watch(item, like, share = false, favorite = false) {
		const v = await this.gather(item.bvid);
		const c = this.cfg();
		const frame = await this.frameIfWanted(v, c);
		const out = await this.callLlm(this.promptFor(v, like, share, favorite, frame !== null), frame ? { images: [frame] } : undefined);
		const raw = String(out ?? '').trim();
		const skipped = /\[划走\]/.test(raw);
		const liked = like && /\[点赞\]/.test(raw);
		const wantShare = share && !skipped && /\[分享\]/.test(raw);
		const wantFav = favorite && !skipped && /\[收藏\]/.test(raw);
		const impression = oneLine(raw.replace(/\[(划走|点赞|分享|收藏)\]/g, ''), 120);
		let memoryId = null;
		if (!skipped) {
			const who = v.owner ? `${v.owner} 的` : '';
			const content = impression !== ''
				? `我在B站刷到${who}视频《${oneLine(v.title, 60)}》：${impression}`
				: `我在B站刷到${who}视频《${oneLine(v.title, 60)}》${v.tname ? `（${v.tname}）` : ''}`;
			memoryId = this.writeMemory(content, v.bvid);
		}
		if (liked) {
			try { await this.client.like(v.aid); } catch (error) {
				this.log('warn', `[fish-soul] 点赞失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		let favorited = false;
		if (wantFav && this.favoritedToday() < this.cfg().favoritePerDay) {
			try {
				await this.client.favorite(v.aid);
				favorited = true;
				setKv(this.db, this.favDayKey(), this.favoritedToday() + 1);
			} catch (error) {
				this.log('warn', `[fish-soul] 收藏失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		// 评论区留一句：只在真看完、有感受、开关开着、今天还没到额度时
		let commented = '';
		if (!skipped && impression !== '' && c.comment && v.aid && this.commentedToday() < c.commentPerDay) {
			commented = await this.commentOn(v, impression);
		}
		// 楼中楼：回一条别人的评论（默认关，单独额度）
		let replied = '';
		const replyCfg = this.cfg();
		if (!skipped && replyCfg.commentReply && v.aid && this.repliedToday() < replyCfg.commentReplyPerDay) {
			replied = await this.commentReplyOn(v);
		}
		this.db.prepare(`
			INSERT INTO bili_seen (bvid, aid, title, owner_name, source, impression, skipped, liked, favorited, memory_id, seen_at, seen_real_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bvid) DO NOTHING
		`).run(v.bvid, v.aid, oneLine(v.title, 120), oneLine(v.owner, 40), item.source ?? 'recommend', impression,
			skipped ? 1 : 0, liked ? 1 : 0, favorited ? 1 : 0, memoryId, this.clock.now(), Date.now());
		return { bvid: v.bvid, title: v.title, owner: v.owner, impression, skipped, liked, favorited, commented, replied, share: wantShare && impression !== '', url: `https://www.bilibili.com/video/${v.bvid}` };
	}

	/** 刷一轮。返回看过的视频。 */
	async run({ count } = {}) {
		if (this.running) return { ok: false, error: '正在刷，稍等' };
		this.running = true;
		try {
			const c = this.cfg();
			const items = await this.candidates(count ?? c.videosPerSession);
			const watched = [];
			for (const [i, item] of items.entries()) {
				if (i > 0) {
					const [lo, hi] = this.watchDelayMs;
					await sleep(lo + Math.floor(Math.random() * Math.max(0, hi - lo)));
				}
				try { watched.push(await this.watch(item, c.like, c.share && this.share !== null, c.favorite && this.favoritedToday() < c.favoritePerDay)); } catch (error) {
					this.log('warn', `[fish-soul] 看视频 ${item.bvid} 失败：${String(error instanceof Error ? error.message : error)}`);
				}
			}
			if (watched.length > 0) this.log('info', `[fish-soul] 刷了 ${watched.length} 条 B站视频：${watched.map((w) => w.title.slice(0, 16)).join(' / ')}`);
			afterRound(this, 'B站', watched, (w) => ({ title: w.title, author: w.owner }));
			return { ok: true, watched };
		} finally {
			this.running = false;
		}
	}

	/** 设置页：最近看过的。 */
	recent(limit = 8) {
		return this.db.prepare(`
			SELECT bvid, title, owner_name AS owner, impression, skipped, liked, favorited, source, seen_real_at AS seenAt
			FROM bili_seen ORDER BY seen_real_at DESC LIMIT ?
		`).all(limit).map((r) => ({ ...r, skipped: r.skipped === 1, liked: r.liked === 1, favorited: r.favorited === 1 }));
	}

	/** 瞬态块：最近一个虚拟日里看过、有感受的 2 条。 */
	contextLines(limit = 2) {
		const rows = this.db.prepare(`
			SELECT bvid, title, owner_name, impression FROM bili_seen
			WHERE skipped = 0 AND impression <> '' AND seen_at >= ?
			ORDER BY seen_at DESC LIMIT ?
		`).all(this.clock.now() - DAY_MS, limit);
		return rows.map((r) => `- 《${oneLine(r.title, 40)}》${r.owner_name ? `（${r.owner_name}）` : ''}：${r.impression}（链接 https://www.bilibili.com/video/${r.bvid}）`);
	}

	/** 聊天里有人发了 B站视频：取一段简短介绍拼进消息，让她"看过"再回。 */
	async describe(refs, { max = this.cfg().maxLinks } = {}) {
		const c = this.cfg();
		const bvids = [...(refs.bvids ?? [])];
		for (const s of refs.shorts ?? []) {
			if (bvids.length >= max) break;
			const bv = await this.client.resolveShort(s);
			if (bv && !bvids.includes(bv)) bvids.push(bv);
		}
		const notes = [];
		for (const bvid of bvids.slice(0, max)) {
			const hit = this.described.get(bvid);
			if (hit !== undefined && Date.now() - hit.at < DESCRIBE_TTL_MS) { notes.push(hit.text); continue; }
			try {
				const v = await this.gather(bvid, { subtitleChars: c.subtitleChars, danmaku: false });
				const frame = await this.frameForLink(v, c);
				const visual = frame ? await this.visualNote(v, frame) : '';
				const text = `【视频 ${bvid}：《${oneLine(v.title, 60)}》UP主 ${oneLine(v.owner, 20) || '未知'}` +
					(v.desc ? `；简介：${oneLine(v.desc, c.descChars)}` : '') +
					(v.subtitle ? `；字幕节选：${oneLine(v.subtitle, c.subtitleChars)}` : '') +
					(v.comments[0] ? `；热评：${oneLine(v.comments[0], c.hotCommentChars)}` : '') +
					(visual ? `；画面：${visual}` : '') + '】';
				this.described.set(bvid, { text, at: Date.now() });
				if (this.described.size > 200) this.described.delete(this.described.keys().next().value);
				notes.push(text);
			} catch { /* 这条看不了 */ }
		}
		return notes;
	}
}
