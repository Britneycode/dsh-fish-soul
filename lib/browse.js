/**
 * browse.js —— 鱼自己刷 B站：空闲时从关注 / 首页推荐里挑几条没看过的视频，
 * 读标题、简介、字幕节选和热评，用她自己的口吻写一两句感受，记进"自己的记忆"（owner_id='self'），
 * 聊天时就能自然说出"我今天刷到……"。默认不点赞、不投币、不评论（点赞可在设置页打开）。
 */
import { tokenizeForBm25 } from './segment.js';

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
	constructor({ db, clock, client, getConfig, callLlm, persona, worker, log, watchDelayMs = [8000, 20000] }) {
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
			like: br.like === true
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
	async gather(bvid, { subtitleChars = 1200 } = {}) {
		const info = await this.client.view(bvid);
		let subtitle = '';
		try { subtitle = await this.client.subtitleText(info.bvid, info.cid, subtitleChars); } catch { /* 没字幕 */ }
		let comments = [];
		try { comments = await this.client.hotComments(info.aid, 3); } catch { /* 没评论 */ }
		return { ...info, subtitle, comments };
	}

	promptFor(v, like) {
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		return [
			`你是「${p.name}」。${p.brief}`.trim(),
			'你刚在 B站刷到一个视频：',
			`标题：${oneLine(v.title, 80)}`,
			`UP主：${oneLine(v.owner, 30) || '未知'}${v.tname ? `；分区：${v.tname}` : ''}`,
			v.desc ? `简介：${oneLine(v.desc, 200)}` : '',
			v.subtitle ? `字幕节选：${v.subtitle}` : '（这个视频没有字幕，只能看简介和评论）',
			v.comments.length > 0 ? `热评：\n${v.comments.map((c) => `- ${c}`).join('\n')}` : '',
			'',
			'用第一人称、口语化写一两句你看完的感受（大概讲了什么 + 你怎么看），不超过 80 字，不要照抄标题。',
			'完全没兴趣、划走了就只输出 [划走]。' + (like ? '特别喜欢的话在末尾加 [点赞]。' : '')
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

	async watch(item, like) {
		const v = await this.gather(item.bvid);
		const out = await this.callLlm(this.promptFor(v, like));
		const raw = String(out ?? '').trim();
		const skipped = /\[划走\]/.test(raw);
		const liked = like && /\[点赞\]/.test(raw);
		const impression = oneLine(raw.replace(/\[(划走|点赞)\]/g, ''), 120);
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
		this.db.prepare(`
			INSERT INTO bili_seen (bvid, aid, title, owner_name, source, impression, skipped, liked, memory_id, seen_at, seen_real_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bvid) DO NOTHING
		`).run(v.bvid, v.aid, oneLine(v.title, 120), oneLine(v.owner, 40), item.source ?? 'recommend', impression,
			skipped ? 1 : 0, liked ? 1 : 0, memoryId, this.clock.now(), Date.now());
		return { bvid: v.bvid, title: v.title, owner: v.owner, impression, skipped, liked };
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
				try { watched.push(await this.watch(item, c.like)); } catch (error) {
					this.log('warn', `[fish-soul] 看视频 ${item.bvid} 失败：${String(error instanceof Error ? error.message : error)}`);
				}
			}
			if (watched.length > 0) this.log('info', `[fish-soul] 刷了 ${watched.length} 条 B站视频：${watched.map((w) => w.title.slice(0, 16)).join(' / ')}`);
			return { ok: true, watched };
		} finally {
			this.running = false;
		}
	}

	/** 设置页：最近看过的。 */
	recent(limit = 8) {
		return this.db.prepare(`
			SELECT bvid, title, owner_name AS owner, impression, skipped, liked, source, seen_real_at AS seenAt
			FROM bili_seen ORDER BY seen_real_at DESC LIMIT ?
		`).all(limit).map((r) => ({ ...r, skipped: r.skipped === 1, liked: r.liked === 1 }));
	}

	/** 瞬态块：最近一个虚拟日里看过、有感受的 2 条。 */
	contextLines(limit = 2) {
		const rows = this.db.prepare(`
			SELECT title, owner_name, impression FROM bili_seen
			WHERE skipped = 0 AND impression <> '' AND seen_at >= ?
			ORDER BY seen_at DESC LIMIT ?
		`).all(this.clock.now() - DAY_MS, limit);
		return rows.map((r) => `- 《${oneLine(r.title, 40)}》${r.owner_name ? `（${r.owner_name}）` : ''}：${r.impression}`);
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
				const v = await this.gather(bvid, { subtitleChars: 300 });
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
