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
	constructor({ db, clock, client, getConfig, callLlm, persona, worker, log, watchDelayMs = [8000, 20000], share, note }) {
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
			danmaku: br.danmaku !== false,
			search: br.search === true,
			searchKeywords: (Array.isArray(br.searchKeywords) ? br.searchKeywords : [])
				.map((w) => String(w ?? '').trim()).filter((w) => w !== '').slice(0, 20),
			searchPerDay: num(br.searchPerDay, 2, 0, 12)
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
		const keyword = await this.nextSearchKeyword();
		if (keyword !== '') {
			try {
				const found = await this.client.search(keyword, 8);
				if (found.length > 0) setKv(this.db, this.searchDayKey(), this.searchedToday() + 1);
				this.log('info', `[fish-soul] 站内搜「${keyword}」拿到 ${found.length} 条`);
				add(found);
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
		return picked.slice(0, count);
	}

	/** 视频的"看到的内容"：详情 + 字幕节选 + 热评（字幕要登录，取不到就只看简介和评论）。 */
	async gather(bvid, { subtitleChars = 1200, danmaku = this.cfg().danmaku } = {}) {
		const info = await this.client.view(bvid);
		let subtitle = '';
		try { subtitle = await this.client.subtitleText(info.bvid, info.cid, subtitleChars); } catch { /* 没字幕 */ }
		let comments = [];
		try { comments = await this.client.hotComments(info.aid, 3); } catch { /* 没评论 */ }
		let danmakuLines = [];
		if (danmaku && typeof this.client.danmaku === 'function') {
			try { danmakuLines = await this.client.danmaku(info.cid, 12); } catch { /* 没弹幕 / 解不开 */ }
		}
		return { ...info, subtitle, comments, danmaku: danmakuLines };
	}

	favDayKey() {
		return `bili.fav.${this.clock.getRoleDateParts().dateStr}`;
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

	/** 她最近看过的几条标题（给她自己提搜索词当原料）。 */
	recentTitles(n = 5) {
		try {
			return this.db.prepare('SELECT title, owner_name FROM bili_seen ORDER BY seen_real_at DESC LIMIT ?').all(n)
				.map((r) => oneLine(r.title, 40)).filter(Boolean);
		} catch { return []; }
	}

	/** 没填词表时，让她自己按最近看过的提一个搜索词（一次小模型调用，只输出几个字）。 */
	async draftSearchKeyword() {
		const titles = this.recentTitles(5);
		if (titles.length === 0) return '';
		const p = this.persona?.() ?? { name: '鱼' };
		const prompt = [
			`你是「${p.name}」。你最近刷到这些视频：`,
			...titles.map((t) => `- ${t}`),
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
		if (words.length > 0) return words[Math.floor(Math.random() * words.length)];
		return await this.draftSearchKeyword();
	}

	promptFor(v, like, share = false, favorite = false) {
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		return [
			`你是「${p.name}」。${p.brief}`.trim(),
			'你刚在 B站刷到一个视频：',
			`标题：${oneLine(v.title, 80)}`,
			`UP主：${oneLine(v.owner, 30) || '未知'}${v.tname ? `；分区：${v.tname}` : ''}`,
			v.desc ? `简介：${oneLine(v.desc, 200)}` : '',
			v.subtitle ? `字幕节选：${v.subtitle}` : '（这个视频没有字幕，只能看简介和评论）',
			v.comments.length > 0 ? `热评：\n${v.comments.map((c) => `- ${c}`).join('\n')}` : '',
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

	async watch(item, like, share = false, favorite = false) {
		const v = await this.gather(item.bvid);
		const out = await this.callLlm(this.promptFor(v, like, share, favorite));
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
		this.db.prepare(`
			INSERT INTO bili_seen (bvid, aid, title, owner_name, source, impression, skipped, liked, favorited, memory_id, seen_at, seen_real_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bvid) DO NOTHING
		`).run(v.bvid, v.aid, oneLine(v.title, 120), oneLine(v.owner, 40), item.source ?? 'recommend', impression,
			skipped ? 1 : 0, liked ? 1 : 0, favorited ? 1 : 0, memoryId, this.clock.now(), Date.now());
		return { bvid: v.bvid, title: v.title, owner: v.owner, impression, skipped, liked, favorited, share: wantShare && impression !== '', url: `https://www.bilibili.com/video/${v.bvid}` };
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
	async describe(refs, { max = 2 } = {}) {
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
				const v = await this.gather(bvid, { subtitleChars: 300, danmaku: false });
				const text = `【视频 ${bvid}：《${oneLine(v.title, 60)}》UP主 ${oneLine(v.owner, 20) || '未知'}` +
					(v.desc ? `；简介：${oneLine(v.desc, 120)}` : '') +
					(v.subtitle ? `；字幕节选：${oneLine(v.subtitle, 300)}` : '') +
					(v.comments[0] ? `；热评：${oneLine(v.comments[0], 60)}` : '') + '】';
				this.described.set(bvid, { text, at: Date.now() });
				if (this.described.size > 200) this.described.delete(this.described.keys().next().value);
				notes.push(text);
			} catch { /* 这条看不了 */ }
		}
		return notes;
	}
}
