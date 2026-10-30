/**
 * douyin-browse.js —— 鱼自己刷抖音：空闲时在专用浏览器里打开推荐页，像人一样看几条（每条停 5–20 秒）再划走，
 * 然后挑出来的几条打开详情读文案和热评，用她自己的口吻写一两句感受，记进"自己的记忆"（owner_id='self'）。
 * 默认不点赞（设置页可打开）；直播间、看过的跳过。
 *
 * 读推荐页当前视频的做法参考了 LockyBee/dsh-douyin-agent（MIT）的 core.mjs，代码是这里自己写的。
 */
import { tokenizeForBm25 } from './segment.js';
import { detail } from './channels/vendor/douyin-bridge/douyin-detail.mjs';

const FEED_URL = 'https://www.douyin.com/?recommend=1';
const VIDEO_RE = /(?:douyin\.com\/(?:video|note)\/|iesdouyin\.com\/share\/(?:video|note)\/|[?&](?:modal_id|aweme_id|vid)=)(\d{15,20})/g;
const SHORT_RE = /https?:\/\/v\.douyin\.com\/[0-9A-Za-z_-]+\/?/g;
const DESCRIBE_TTL_MS = 3600_000;
const DAY_MS = 86_400_000;
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').replace(/【/g, '〔').replace(/】/g, '〕').trim().slice(0, n);
const errText = (e) => String(e instanceof Error ? e.message : e);

/** 文本里的抖音视频（id）与 v.douyin.com 短链。 */
export function findDouyinRefs(text) {
	const s = String(text ?? '');
	const ids = [];
	for (const m of s.matchAll(VIDEO_RE)) if (!ids.includes(m[1])) ids.push(m[1]);
	return { ids, shorts: [...new Set(s.match(SHORT_RE) ?? [])] };
}

/** 推荐页上"正在播的那条"：id / 文案 / 作者 / 是不是直播。 */
export const ACTIVE_VIDEO_JS = String.raw`(() => {
  const active = document.querySelector('[data-e2e="feed-active-video"]');
  if (!active) return { ok: false, why: 'no-active' };
  const idRe = /(?:^|\s)video_(\d{8,})(?:\s|$)/;
  let id = '';
  const pc = active.querySelector('[data-e2e="player-container"]');
  for (const el of [active, pc, ...active.querySelectorAll('[class*="video_"]')]) {
    if (!el) continue;
    const m = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').match(idRe);
    if (m) { id = m[1]; break; }
  }
  if (!id) {
    for (const el of [active, ...active.querySelectorAll('[data-e2e-vid],[data-aweme-id]')]) {
      const v = el.getAttribute && (el.getAttribute('data-e2e-vid') || el.getAttribute('data-aweme-id'));
      if (v && /^\d{8,}$/.test(v)) { id = v; break; }
    }
  }
  if (!id) {
    for (const a of active.querySelectorAll('a[href]')) {
      const m = String(a.getAttribute('href')).match(/\/video\/(\d{8,})|modal_id=(\d{8,})|aweme_id=(\d{8,})/);
      if (m) { id = m[1] || m[2] || m[3]; break; }
    }
  }
  if (!id) { const m = location.href.match(/modal_id=(\d{8,})/); if (m) id = m[1]; }
  const text = (active.innerText || '').slice(0, 400);
  const live = Boolean(active.querySelector('[data-e2e="feed-live"], [data-e2e="live-room"]')) || /直播中|点击进入直播间/.test(text);
  const descEl = active.querySelector('[data-e2e="video-desc"]');
  const authorEl = active.querySelector('[data-e2e="feed-video-nickname"]') || active.querySelector('[data-e2e="video-author-name"]') || active.querySelector('a[href*="/user/"]');
  const ad = /广告/.test((active.querySelector('[data-e2e="feed-ad"]') || {}).innerText || '');
  return {
    ok: true,
    id,
    live,
    ad,
    title: ((descEl && descEl.innerText) || '').trim().slice(0, 300),
    author: ((authorEl && authorEl.innerText) || '').replace(/^@/, '').trim().slice(0, 40)
  };
})()`;

const CLICK_NEXT_JS = String.raw`(() => {
  const btn = document.querySelector('[data-e2e="video-switch-next-arrow"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const CLICK_LIKE_JS = String.raw`(() => {
  const scope = document.querySelector('[data-e2e="feed-active-video"]') || document;
  const btn = scope.querySelector('[data-e2e="video-player-digg"]') || document.querySelector('[data-e2e="video-player-digg"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

export class DouyinBrowser {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {import('./clock.js').VirtualClock} deps.clock
	 * @param {import('./channels/douyin.js').DouyinHost} deps.host
	 * @param {() => object} deps.getConfig 返回 config.douyin
	 * @param {(prompt: string) => Promise<string|null>} deps.callLlm
	 * @param {() => {name: string, brief: string}} deps.persona
	 * @param {[number, number]} [deps.dwellMs] 推荐页每条看多久（真实毫秒）
	 * @param {(opts: {browser: object, id: string, commentLimit?: number}) => Promise<object>} [deps.readDetail]
	 */
	constructor({ db, clock, host, getConfig, callLlm, persona, worker, log, dwellMs = [5000, 20000], readDetail = detail, settleMs = 8000, fetchImpl }) {
		this.db = db;
		this.clock = clock;
		this.host = host;
		this.getConfig = getConfig;
		this.callLlm = callLlm;
		this.persona = persona;
		this.worker = worker;
		this.log = log ?? (() => {});
		this.dwellMs = dwellMs;
		this.readDetail = readDetail;
		this.settleMs = settleMs;
		this.fetch = fetchImpl ?? ((...a) => fetch(...a));
		this.running = false;
		this.described = new Map();
	}

	cfg() {
		const d = this.getConfig() ?? {};
		const br = d.browse ?? {};
		const num = (v, def, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : def);
		return {
			enabled: d.enabled === true && br.enabled === true,
			perDay: num(br.perDay, 3, 0, 12),
			videosPerSession: num(br.videosPerSession, 3, 1, 6),
			like: br.like === true
		};
	}

	get ready() {
		return this.host.running && this.host.loggedIn === true;
	}

	seen(id) {
		return this.db.prepare('SELECT 1 FROM douyin_seen WHERE aweme_id = ?').get(String(id)) !== undefined;
	}

	dwell() {
		const [lo, hi] = this.dwellMs;
		return lo + Math.floor(Math.random() * Math.max(0, hi - lo));
	}

	async activeVideo(b) {
		const r = await b.eval(ACTIVE_VIDEO_JS).catch(() => null);
		return r && r.ok ? r : null;
	}

	/** 划到下一条：先点"下一条"箭头，不行按 ↓，再不行滚轮；确认 id 变了。 */
	async next(b, prevId) {
		const changed = async () => {
			for (let i = 0; i < 8; i++) {
				await sleep(400);
				const v = await this.activeVideo(b);
				if (v && v.id && v.id !== prevId) return true;
			}
			return false;
		};
		if (await b.eval(CLICK_NEXT_JS).catch(() => false) && await changed()) return true;
		try {
			for (const type of ['keyDown', 'keyUp']) {
				await b.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 }, b.sessionId);
			}
			if (await changed()) return true;
		} catch { /* 换滚轮 */ }
		try {
			const m = await b.send('Page.getLayoutMetrics', {}, b.sessionId);
			const vp = m?.cssVisualViewport ?? {};
			await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round((vp.clientWidth ?? 800) / 2), y: Math.round((vp.clientHeight ?? 600) / 2), deltaX: 0, deltaY: 600 }, b.sessionId);
			if (await changed()) return true;
		} catch { /* 划不动 */ }
		return false;
	}

	/** 推荐页上看几条（只看、不读详情），返回要细看的视频。 */
	async scroll(count) {
		const b = this.host.browser;
		await b.goto(FEED_URL, { settleMs: this.settleMs });
		const picked = [];
		let prevId = '';
		for (let step = 0; step < count + 6 && picked.length < count; step++) {
			const v = await this.activeVideo(b);
			if (v && v.id && v.id !== prevId) {
				prevId = v.id;
				if (!v.live && !v.ad && !this.seen(v.id) && !picked.some((p) => p.id === v.id)) {
					picked.push({ id: v.id, title: v.title, author: v.author });
					await sleep(this.dwell());
				} else {
					await sleep(800 + Math.floor(Math.random() * 1200));
				}
			} else if (!v) {
				await sleep(1500);
			}
			if (picked.length >= count) break;
			if (!await this.next(b, prevId)) break;
		}
		return picked;
	}

	promptFor(v, like) {
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		return [
			`你是「${p.name}」。${p.brief}`.trim(),
			'你刚在抖音刷到一个视频：',
			`文案：${oneLine(v.desc || v.title, 200) || '（没有文案）'}`,
			`作者：${oneLine(v.author, 30) || '未知'}`,
			v.tags?.length > 0 ? `话题：${v.tags.slice(0, 6).map((t) => oneLine(t, 20)).join(' ')}` : '',
			v.comments?.length > 0 ? `热评：\n${v.comments.slice(0, 4).map((c) => `- ${oneLine(c.text ?? c, 80)}`).join('\n')}` : '',
			'',
			'用第一人称、口语化写一两句你看完的感受（大概是什么 + 你怎么看），不超过 80 字，不要照抄文案。',
			'完全没兴趣、划走了就只输出 [划走]。' + (like ? '特别喜欢的话在末尾加 [点赞]。' : '')
		].filter((l) => l !== '').join('\n');
	}

	writeMemory(content, id) {
		const now = this.clock.now();
		const result = this.db.prepare(`
			INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
			                    importance, emotion, source_session, created_at, updated_at, status)
			VALUES ('feiyu', 'self', 'douyin', ?, 'event', ?, ?, 1, 0, '', ?, ?, 'active')
		`).run(`douyin:video:${id}`, content, tokenizeForBm25(content), now, now);
		const mid = Number(result.lastInsertRowid);
		try { this.worker?.enqueueRealtime(mid, content); } catch { /* 向量可缺 */ }
		return mid;
	}

	/** 细看一条：详情页读文案 + 热评 → 感受 → 记忆（要点赞就在详情页点）。 */
	async watch(item, like) {
		const b = this.host.browser;
		let d = null;
		try { d = await this.readDetail({ browser: b, id: item.id, commentLimit: 6 }); } catch (error) {
			this.log('warn', `[fish-soul] 抖音视频 ${item.id} 详情没读到：${errText(error)}`);
		}
		const v = {
			id: item.id,
			title: item.title,
			desc: d?.ok ? String(d.desc ?? '') : '',
			author: (d?.ok && d.author) || item.author || '',
			tags: d?.ok && Array.isArray(d.tags) ? d.tags : [],
			comments: d?.ok && Array.isArray(d.comments) ? d.comments : []
		};
		const out = await this.callLlm(this.promptFor(v, like));
		const raw = String(out ?? '').trim();
		const skipped = /\[划走\]/.test(raw);
		const wantLike = like && /\[点赞\]/.test(raw);
		const impression = oneLine(raw.replace(/\[(划走|点赞)\]/g, ''), 120);
		const title = oneLine(v.title || v.desc, 60);
		let memoryId = null;
		if (!skipped) {
			const who = v.author ? `${oneLine(v.author, 20)} 的` : '';
			const content = impression !== ''
				? `我在抖音刷到${who}视频《${title || '没写文案'}》：${impression}`
				: `我在抖音刷到${who}视频《${title || '没写文案'}》`;
			memoryId = this.writeMemory(content, v.id);
		}
		let liked = false;
		if (wantLike) {
			try { liked = await b.eval(CLICK_LIKE_JS) === true; } catch (error) {
				this.log('warn', `[fish-soul] 抖音点赞失败：${errText(error)}`);
			}
		}
		this.db.prepare(`
			INSERT INTO douyin_seen (aweme_id, title, author, impression, skipped, liked, memory_id, seen_at, seen_real_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(aweme_id) DO NOTHING
		`).run(v.id, oneLine(v.title || v.desc, 120), oneLine(v.author, 40), impression, skipped ? 1 : 0, liked ? 1 : 0, memoryId, this.clock.now(), Date.now());
		return { id: v.id, title: v.title || v.desc, author: v.author, impression, skipped, liked };
	}

	/** 刷一轮。返回看过的视频。 */
	async run({ count } = {}) {
		if (this.running) return { ok: false, error: '正在刷，稍等' };
		if (!this.ready) return { ok: false, error: this.host.running ? '抖音还没登录' : '抖音浏览器没在运行' };
		this.running = true;
		try {
			const c = this.cfg();
			const n = count ?? c.videosPerSession;
			const items = await this.host.exclusive('刷抖音', () => this.scroll(n), { maxMs: 6 * 60_000 });
			const watched = [];
			for (const item of items) {
				try { watched.push(await this.host.exclusive('看抖音视频', () => this.watch(item, c.like), { maxMs: 3 * 60_000 })); } catch (error) {
					this.log('warn', `[fish-soul] 看抖音视频 ${item.id} 失败：${errText(error)}`);
				}
			}
			if (watched.length > 0) this.log('info', `[fish-soul] 刷了 ${watched.length} 条抖音：${watched.map((w) => String(w.title).slice(0, 16)).join(' / ')}`);
			return { ok: true, watched };
		} finally {
			this.running = false;
		}
	}

	/** 设置页：最近看过的。 */
	recent(limit = 8) {
		return this.db.prepare(`
			SELECT aweme_id AS id, title, author, impression, skipped, liked, seen_real_at AS seenAt
			FROM douyin_seen ORDER BY seen_real_at DESC LIMIT ?
		`).all(limit).map((r) => ({ ...r, skipped: r.skipped === 1, liked: r.liked === 1 }));
	}

	/** 瞬态块：最近一个虚拟日里看过、有感受的。 */
	contextLines(limit = 2) {
		const rows = this.db.prepare(`
			SELECT title, author, impression FROM douyin_seen
			WHERE skipped = 0 AND impression <> '' AND seen_at >= ?
			ORDER BY seen_at DESC LIMIT ?
		`).all(this.clock.now() - DAY_MS, limit);
		return rows.map((r) => `- 《${oneLine(r.title, 40)}》${r.author ? `（${r.author}）` : ''}：${r.impression}`);
	}

	/** v.douyin.com 短链 → 视频 id（拿不到返回 ''）。 */
	async resolveShort(url) {
		let cur = url;
		for (let i = 0; i < 3; i++) {
			try {
				const res = await this.fetch(cur, { redirect: 'manual', headers: { 'User-Agent': MOBILE_UA }, signal: AbortSignal.timeout(5000) });
				const loc = res.headers.get('location') ?? '';
				const ids = findDouyinRefs(loc).ids;
				if (ids.length > 0) return ids[0];
				if (!loc) return '';
				cur = new URL(loc, cur).href;
			} catch {
				return '';
			}
		}
		return '';
	}

	/** 聊天里有人发了抖音视频：打开详情读文案和热评，拼一段简短介绍进消息，让她"看过"再回。 */
	async describe(refs, { max = 1 } = {}) {
		if (!this.ready) return [];
		const ids = [...(refs.ids ?? [])];
		for (const s of refs.shorts ?? []) {
			if (ids.length >= max) break;
			const id = await this.resolveShort(s);
			if (id && !ids.includes(id)) ids.push(id);
		}
		const notes = [];
		for (const id of ids.slice(0, max)) {
			const hit = this.described.get(id);
			if (hit !== undefined && Date.now() - hit.at < DESCRIBE_TTL_MS) { notes.push(hit.text); continue; }
			try {
				const d = await this.host.exclusive('看分享的抖音', () => this.readDetail({ browser: this.host.browser, id, commentLimit: 3 }), { maxMs: 45_000 });
				if (!d?.ok) continue;
				const c0 = d.comments?.[0];
				const text = `【抖音视频：${oneLine(d.desc, 120) || '（没有文案）'}；作者 ${oneLine(d.author, 20) || '未知'}` +
					(c0 ? `；热评：${oneLine(c0.text ?? c0, 60)}` : '') + '】';
				this.described.set(id, { text, at: Date.now() });
				if (this.described.size > 200) this.described.delete(this.described.keys().next().value);
				notes.push(text);
			} catch { /* 这条看不了 */ }
		}
		return notes;
	}
}
