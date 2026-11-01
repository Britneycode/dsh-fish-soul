/**
 * douyin-social.js —— 鱼在抖音自己发图文作品、回作品下的评论（v0.10，默认都关，尽力而为）。
 *
 * 抖音网页版没有能直接调的接口，全靠专用浏览器里点页面：
 *  - 发图文：把她写的话在浏览器里画成一张文字卡片（canvas），到创作者中心「发布图文」上传、填标题和描述、点发布。
 *    创作者中心（creator.douyin.com）可能要单独登录一次；页面改版就会发不出去（设置页能看到原因）。
 *  - 回评论：每 20 分钟打开「我的」作品页，看最近 3 个作品的评论区，对新评论点「回复」、打字、发送。
 *    第一次只记下已有的评论、不回旧的；"作者"自己的不回；每小时最多 perHour 条。
 *    抖音常在发评论前要短信验证：碰到就停下、提醒主人去浏览器里验证一次，6 小时内不再试。
 * 评论区 / 输入框的结构参考了 pcmxiao/dsh-douyin-bridge 的 lib/comment.mjs（MIT），代码是这里自己写的。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SocialBase, socialCfg, cleanSocialText } from './social.js';
import { fishSoulDir, findPersonByDouyin, getKv, setKv } from './db.js';

const HOUR_MS = 3600_000;
const VERIFY_BACKOFF_MS = 6 * HOUR_MS;
const CREATOR_UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3';
const SELF_URL = 'https://www.douyin.com/user/self?showTab=post';
const SEND_PATH = 'M17.5 30C23.851 30';
const SEL = {
	input: '.comment-input-inner-container',
	item: '[data-e2e="comment-item"]',
	stats: '.comment-item-stats-container',
	right: '.commentInput-right-ct',
	editor: '.public-DraftEditor-content[contenteditable="true"]',
	commentBtn: '[data-e2e="feed-comment-icon"]'
};

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const errText = (e) => String(e instanceof Error ? e.message : e);

/** 标题：正文第一句，最多 20 字（抖音图文标题上限 20）。 */
export function noteTitle(text) {
	const first = String(text ?? '').split(/[。！？!?\n]/).map((s) => s.trim()).find(Boolean) ?? '';
	return first.slice(0, 20);
}

/** 评论去重用的 id：作品 + 谁 + 说了什么。 */
export function commentKey(workId, author, content) {
	return `${workId}:${createHash('sha1').update(`${author}\n${content}`).digest('hex').slice(0, 16)}`;
}

// ───────────── 页面脚本 ─────────────

const VERIFY_JS = String.raw`(() => {
  const t = document.body ? document.body.innerText : '';
  const sms = /接收短信验证码|获取验证码|请输入验证码/.test(t);
  const captcha = /滑块验证|安全验证|请完成验证|拖动滑块/.test(t);
  return sms || captcha ? (sms ? 'sms' : 'captcha') : '';
})()`;

/** 文字卡片（1080×1440 PNG，base64）。 */
function cardJs(text, foot, theme) {
	return `(async () => {
  const text = ${JSON.stringify(text)};
  const foot = ${JSON.stringify(foot)};
  const themes = [['#FFF6E5', '#5B4636'], ['#EAF4FF', '#2F4A66'], ['#F3EEFF', '#4A3A6B'], ['#EAF7EE', '#2F5A3E'], ['#FFEFF1', '#6B3A44']];
  const [bg, fg] = themes[${Number(theme) || 0} % themes.length];
  const W = 1080, H = 1440;
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = fg; g.textBaseline = 'top';
  const size = text.length > 80 ? 52 : text.length > 40 ? 62 : 76;
  const font = (px) => px + 'px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif';
  g.font = font(size);
  const maxW = W - 200;
  const lines = [];
  for (const para of text.split('\\n')) {
    let cur = '';
    for (const ch of para) {
      if (g.measureText(cur + ch).width > maxW && cur !== '') { lines.push(cur); cur = ch; } else cur += ch;
    }
    lines.push(cur);
  }
  const lh = Math.round(size * 1.6);
  let y = Math.max(120, Math.round((H - lines.length * lh) / 2) - 40);
  for (const l of lines) { g.fillText(l, 100, y); y += lh; }
  g.globalAlpha = 0.55; g.font = font(34);
  g.fillText(foot, 100, H - 150);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const u = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
})()`;
}

/** 「我的」页的作品列表（新的在前）。 */
const WORKS_JS = String.raw`(() => {
  const out = [];
  const scope = document.querySelector('[data-e2e="user-post-list"]') || document;
  for (const a of scope.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
    const m = String(a.getAttribute('href')).match(/\/(video|note)\/(\d{8,})/);
    if (!m || out.some((x) => x.id === m[2])) continue;
    const li = a.closest('li') || a;
    if (/置顶/.test(li.innerText || '') && out.length > 0) continue;
    out.push({ id: m[2], kind: m[1], title: (a.innerText || li.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
  }
  return out;
})()`;

const COMMENT_STATE_JS = `(() => ({ box: Boolean(document.querySelector('${SEL.input}')), items: document.querySelectorAll('${SEL.item}').length, btn: Boolean(document.querySelector('${SEL.commentBtn}')), url: location.href }))()`;

/** 评论区里的一级评论：作者 / 内容 / 是不是作者本人 / 能不能回。 */
const LIST_COMMENTS_JS = `(() => [...document.querySelectorAll('${SEL.item}')].map((el, i) => {
  const lines = (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  const isAuthor = lines.slice(0, 3).includes('作者');
  const rest = lines.filter((s) => s !== '作者' && s !== '置顶' && s !== '作者赞过');
  const stats = el.querySelector('${SEL.stats}');
  const canReply = Boolean(stats && [...stats.querySelectorAll('*')].some((x) => (x.innerText || '').trim() === '回复'));
  return { i, author: (rest[0] || '').slice(0, 40), content: (rest[1] || '').slice(0, 300), isAuthor, canReply };
}))()`;

async function realClick(br, x, y) {
	for (const type of ['mousePressed', 'mouseReleased']) {
		await br.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, br.sessionId);
	}
}

async function waitFor(fn, { tries = 10, gapMs = 1000 } = {}) {
	for (let i = 0; i < tries; i++) {
		const v = await fn().catch(() => null);
		if (v) return v;
		await sleep(gapMs);
	}
	return null;
}

/** 真正的页面驱动（测试里换成假的）。全部都得在 host.exclusive 里调。 */
export function douyinSocialDriver(host) {
	const b = () => {
		if (!host.running) throw new Error('抖音浏览器没在运行');
		return host.browser;
	};
	const verifyKind = async () => String(await b().eval(VERIFY_JS).catch(() => '') ?? '');

	return {
		async renderCard(text, foot, theme = 0) {
			const out = await b().eval(cardJs(text, foot, theme));
			return typeof out === 'string' && out !== '' ? Buffer.from(out, 'base64') : null;
		},

		/** 创作者中心发一条图文。返回 {ok, code?, error?}。 */
		async publishNote({ title, text, file }) {
			const br = b();
			await br.goto(CREATOR_UPLOAD_URL, { settleMs: 8000 });
			const url = String(await br.eval('location.href').catch(() => '') ?? '');
			if (!/creator\.douyin\.com\/creator-micro/.test(url)) return { ok: false, code: 'NOT_LOGGED_IN', error: '创作者中心没登录：在抖音浏览器里打开 creator.douyin.com 登录一次' };
			// 切到「发布图文」页签（默认就是的话点了也没事）
			await br.eval(String.raw`(() => {
  const el = [...document.querySelectorAll('div, span, button')].find((x) => x.children.length === 0 && /^发布图文$/.test((x.innerText || '').trim()));
  if (el) el.click();
  return Boolean(el);
})()`).catch(() => false);
			await sleep(1500);
			const r = await br.send('Runtime.evaluate', { expression: `document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]')` }, br.sessionId);
			const objectId = r?.result?.objectId;
			if (!objectId) return { ok: false, code: 'NO_UPLOAD', error: '创作者中心页面上没找到上传图片的地方（可能改版了）' };
			await br.send('DOM.setFileInputFiles', { files: [file], objectId }, br.sessionId);
			const ready = await waitFor(() => br.eval(`(() => Boolean(document.querySelector('input[placeholder*="标题"]') || document.querySelector('[contenteditable="true"]')))()`), { tries: 40 });
			if (!ready) return { ok: false, code: 'NO_EDITOR', error: '传完图片没进到编辑页' };
			await sleep(1500);
			if (title) {
				const has = await br.eval(`(() => { const el = document.querySelector('input[placeholder*="标题"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); el.select && el.select(); return true; })()`).catch(() => false);
				if (has) { await br.send('Input.insertText', { text: title }, br.sessionId); await sleep(500); }
			}
			const pos = await br.eval(String.raw`(() => {
  const el = document.querySelector('.zone-container[contenteditable="true"]') || document.querySelector('[data-placeholder*="描述"][contenteditable="true"]') || document.querySelector('[contenteditable="true"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + Math.min(20, r.height / 2)) } : null;
})()`).catch(() => null);
			if (!pos) return { ok: false, code: 'NO_EDITOR', error: '编辑页上没找到写描述的地方' };
			await realClick(br, pos.x, pos.y);
			await sleep(500);
			await br.send('Input.insertText', { text }, br.sessionId);
			await sleep(1000);
			// 等图片传完（"上传中"没了）
			await waitFor(async () => !/上传中|正在上传/.test(String(await br.eval('document.body.innerText').catch(() => '') ?? '')), { tries: 30 });
			const clicked = await br.eval(String.raw`(() => {
  const btns = [...document.querySelectorAll('button')].filter((x) => (x.innerText || '').trim() === '发布' && !x.disabled);
  const el = btns[btns.length - 1];
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return true;
})()`).catch(() => false);
			if (!clicked) return { ok: false, code: 'NO_PUBLISH', error: '编辑页上没找到「发布」按钮' };
			const done = await waitFor(async () => {
				const v = await verifyKind();
				if (v) return { verify: v };
				const st = await br.eval(`(() => ({ url: location.href, text: (document.body.innerText || '').slice(0, 3000) }))()`);
				return /content\/manage/.test(st?.url ?? '') || /发布成功/.test(st?.text ?? '') ? { ok: true } : null;
			}, { tries: 25 });
			if (done?.verify) return { ok: false, code: 'NEEDS_VERIFY', error: '抖音要验证（短信 / 滑块）才能发' };
			if (!done?.ok) return { ok: false, code: 'NOT_CONFIRMED', error: '点了发布，但没等到「发布成功」（可能在审核，或者页面改版了）' };
			return { ok: true };
		},

		/** 「我的」作品（最多 limit 个，新的在前）。 */
		async listWorks(limit = 3) {
			const br = b();
			await br.goto(SELF_URL, { settleMs: 7000 });
			const list = await waitFor(async () => { const l = await br.eval(WORKS_JS); return Array.isArray(l) && l.length > 0 ? l : null; }, { tries: 6 });
			return (list ?? []).slice(0, limit);
		},

		/** 打开作品并展开评论区。 */
		async openWork(w) {
			const br = b();
			for (const url of [`https://www.douyin.com/?modal_id=${w.id}`, `https://www.douyin.com/${w.kind === 'note' ? 'note' : 'video'}/${w.id}`]) {
				try { await br.goto(url, { settleMs: 7000 }); } catch { continue; }
				let clickedIcon = false;
				for (let i = 0; i < 12; i++) {
					const st = await br.eval(COMMENT_STATE_JS).catch(() => null);
					if (st?.box) return { ok: true };
					if (st?.btn && !clickedIcon) {
						const p = await br.eval(`(() => { const el = document.querySelector('${SEL.commentBtn}'); if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.top >= 0 && r.bottom <= innerHeight ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`).catch(() => null);
						if (p) { await realClick(br, p.x, p.y); clickedIcon = true; }
					}
					await sleep(1000);
				}
			}
			return { ok: false, error: '作品页没打开评论区' };
		},

		async listComments() {
			const l = await b().eval(LIST_COMMENTS_JS).catch(() => []);
			return Array.isArray(l) ? l : [];
		},

		/** 回复某条评论（按作者 + 内容找，不靠序号）。返回 {ok, code?, error?}。 */
		async reply({ author, content }, text) {
			const br = b();
			const before = await br.eval(`document.querySelectorAll('${SEL.input}').length`).catch(() => 0);
			const clicked = await br.eval(`(() => {
  const want = ${JSON.stringify({ author, content: String(content).slice(0, 40) })};
  const el = [...document.querySelectorAll('${SEL.item}')].find((x) => { const t = x.innerText || ''; return t.includes(want.author) && t.includes(want.content); });
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  const stats = el.querySelector('${SEL.stats}');
  const leaf = stats && [...stats.querySelectorAll('*')].find((x) => (x.innerText || '').trim() === '回复');
  if (!leaf) return false;
  el.setAttribute('data-fish-reply', '1');
  leaf.click();
  return true;
})()`).catch(() => false);
			if (!clicked) return { ok: false, code: 'NOT_FOUND', error: '评论区里没找到这条评论' };
			await sleep(1200);
			// 回复框：这条评论里面的输入框，没有就用新冒出来的那个
			const pos = await br.eval(`(() => {
  const item = document.querySelector('[data-fish-reply="1"]');
  const all = [...document.querySelectorAll('${SEL.input}')];
  const box = (item && item.querySelector('${SEL.input}')) || (all.length > ${Number(before) || 0} ? all[all.length - 1] : null);
  if (!box) return null;
  box.setAttribute('data-fish-box', '1');
  box.scrollIntoView({ block: 'center' });
  const r = box.getBoundingClientRect();
  return r.width && r.height ? { x: Math.round(r.left + Math.min(30, r.width / 2)), y: Math.round(r.top + r.height / 2) } : null;
})()`).catch(() => null);
			const cleanup = () => br.eval(`(() => { for (const el of document.querySelectorAll('[data-fish-reply],[data-fish-box]')) { el.removeAttribute('data-fish-reply'); el.removeAttribute('data-fish-box'); } return true; })()`).catch(() => {});
			try {
				if (!pos) return { ok: false, code: 'NO_BOX', error: '点了「回复」没出来输入框' };
				await realClick(br, pos.x, pos.y);
				const focused = await waitFor(() => br.eval(`(() => { const box = document.querySelector('[data-fish-box="1"]'); const ed = box && box.querySelector('${SEL.editor}'); if (!ed) return false; const a = document.activeElement; if (!(a && (a === ed || ed.contains(a)))) ed.focus(); return true; })()`), { tries: 12, gapMs: 300 });
				if (!focused) return { ok: false, code: 'NO_EDITOR', error: '回复框没聚焦上' };
				await br.send('Input.insertText', { text }, br.sessionId);
				await sleep(800);
				const sent = await br.eval(`(() => {
  const box = document.querySelector('[data-fish-box="1"]');
  const scope = (box && (box.parentElement?.querySelector('${SEL.right}') || box.parentElement)) || null;
  if (!scope) return false;
  const byText = [...scope.querySelectorAll('button, span, div')].filter((x) => ['发送', '发布'].includes((x.innerText || '').trim()));
  const byIcon = [...scope.querySelectorAll('svg path')].filter((p) => (p.getAttribute('d') || '').startsWith('${SEND_PATH}')).map((p) => p.closest('span') || p.closest('button') || p);
  const el = byText[byText.length - 1] || byIcon[0];
  if (!el) return false;
  el.click();
  return true;
})()`).catch(() => false);
				if (!sent) return { ok: false, code: 'NO_SEND', error: '回复框旁边没找到发送按钮' };
				await sleep(2000);
				const v = await verifyKind();
				if (v) return { ok: false, code: 'NEEDS_VERIFY', error: '抖音要验证（短信 / 滑块）才能发评论' };
				const left = await br.eval(`(() => { const ed = document.querySelector('[data-fish-box="1"] ${SEL.editor}'); return ed ? (ed.innerText || '').trim() : ''; })()`).catch(() => '');
				if (left) return { ok: false, code: 'NOT_SENT', error: '点了发送，但字还在框里（可能没发出去）' };
				return { ok: true };
			} finally {
				await cleanup();
			}
		}
	};
}

/** 抖音：发图文（文字卡片）、回作品下的评论。 */
export class DouyinSocial extends SocialBase {
	/**
	 * @param {object} deps 同 SocialBase，外加 host（DouyinHost）、driver（测试用）、notify（给主人的提醒）
	 */
	constructor({ host, driver, notify, cardDir, ...deps }) {
		super({ pollMs: 20 * 60_000, replyGapMs: 30_000, ...deps, platform: 'douyin', label: '抖音' });
		this.host = host;
		this.driver = driver ?? douyinSocialDriver(host);
		this.notify = notify ?? (() => {});
		this.cardDir = cardDir ?? join(fishSoulDir(), 'douyin-cards');
		this.postNoun = '图文';
		this.blockedUntil = 0;
	}

	cfg() {
		const d = this.getConfig() ?? {};
		return socialCfg(d, d.masterName, 4);
	}

	get ready() {
		return this.host.running && this.host.loggedIn === true && Date.now() >= this.blockedUntil;
	}

	notReadyText() {
		if (Date.now() < this.blockedUntil) return '抖音刚要过验证，过几个小时再试（或者先去浏览器里验证一下）';
		return this.host.running ? '抖音还没登录' : '抖音浏览器没在运行';
	}

	postStyle() {
		return '你想在自己的抖音发一条图文：你写的话会印在一张纯色文字卡片上，同时当作品描述。像真人随手发的：一句心情、今天的小事、刚想到的话，一般 10～60 字，可以分两三行。';
	}

	whoIs(it, master) {
		const person = findPersonByDouyin(this.db, it.name);
		return it.name === master ? '（是你的主人）' : person ? `（你认识，是${oneLine(person.display_name, 20)}）` : '（不认识的人）';
	}

	/** 碰到验证：停 6 小时，提醒主人一次。 */
	blocked(what) {
		this.blockedUntil = Date.now() + VERIFY_BACKOFF_MS;
		this.notify('douyin.verify', `抖音${what}前要验证（短信 / 滑块），在设置页「抖音」里点「显示一下」打开浏览器验证一次；这 6 个小时先不试了`);
	}

	async publish(text) {
		const parts = this.clock.getRoleDateParts();
		const png = await this.host.exclusive('画卡片', () => this.driver.renderCard(text, parts.dateStr.replace(/-/g, '.'), Math.floor(this.random() * 5)), { maxMs: 30_000 });
		if (!png) throw new Error('卡片没画出来');
		mkdirSync(this.cardDir, { recursive: true });
		const file = join(this.cardDir, `card-${Date.now()}.png`);
		writeFileSync(file, png);
		const r = await this.host.exclusive('发抖音图文', () => this.driver.publishNote({ title: noteTitle(text), text, file }), { maxMs: 4 * 60_000 });
		if (r?.code === 'NEEDS_VERIFY') this.blocked('发作品');
		if (r?.code === 'NOT_LOGGED_IN') this.notify('douyin.creator', '想在抖音发图文，但创作者中心没登录：在抖音浏览器里打开 creator.douyin.com 登录一次就好');
		if (!r?.ok) throw new Error(r?.error ?? '没发出去');
		this.notify('douyin.creator', null);
		return '';
	}

	/** 看最近几个作品的评论区，挨个决定回不回。 */
	async pollComments() {
		const c = this.cfg();
		if (!c.comments.enabled || this.polling || !this.ready) return { ok: false, replied: 0, skipped: 0, error: c.comments.enabled ? this.notReadyText() : '回评论关着' };
		this.polling = true;
		let replied = 0;
		let skipped = 0;
		const seeded = getKv(this.db, 'douyin.comments.seeded', false) === true;
		try {
			const works = await this.host.exclusive('看自己的作品', () => this.driver.listWorks(3), { maxMs: 60_000 });
			this.lastPollAt = Date.now();
			outer: for (const w of works) {
				const comments = await this.host.exclusive('看作品评论', async () => {
					const o = await this.driver.openWork(w);
					return o.ok ? await this.driver.listComments() : [];
				}, { maxMs: 90_000 });
				for (const cm of comments) {
					if (!cm.author || !cm.content) continue;
					const it = { id: commentKey(w.id, cm.author, cm.content), mid: '', name: cm.author, title: w.title, content: cm.content, where: w.kind === 'note' ? '图文' : '视频', author: cm.author };
					if (this.handled(it.id)) continue;
					if (!seeded) { this.record(it, 'backlog'); continue; } // 第一次：只记下来，不回旧的
					if (cm.isAuthor) { this.record(it, 'skipped'); continue; }
					if (!cm.canReply) continue;
					if (this.repliedLastHour() >= c.comments.perHour) break outer;
					const raw = String((await this.callLlm(this.replyPrompt(it, c.master))) ?? '').trim();
					const text = /\[不回\]/.test(raw) ? '' : cleanSocialText(raw, 100);
					if (text === '') {
						if (raw === '') break outer;
						this.record(it, 'skipped');
						skipped++;
						this.note('comment', { title: this.label, reason: `${oneLine(it.name, 16)} 在评论区说了句话，没回`, text: oneLine(it.content, 60) });
						continue;
					}
					const wait = this.replyGapMs - (Date.now() - this.lastReplyRealMs);
					if (wait > 0) await sleep(wait);
					const r = await this.host.exclusive('回抖音评论', async () => {
						let x = await this.driver.reply(cm, text);
						if (x?.code === 'NOT_FOUND' && (await this.driver.openWork(w)).ok) x = await this.driver.reply(cm, text); // 页面被别的事换掉了：重开一次
						return x;
					}, { maxMs: 90_000 });
					this.lastReplyRealMs = Date.now();
					if (r?.ok) {
						this.record(it, 'replied', text);
						replied++;
						this.note('comment', { title: this.label, reason: `回了 ${oneLine(it.name, 16)} 的评论`, text: `${oneLine(it.content, 40)} → ${text}` });
						continue;
					}
					this.lastError = `回评论：${r?.error ?? '没发出去'}`.slice(0, 120);
					this.log('warn', `[fish-soul] 抖音回评论失败：${r?.error ?? '没发出去'}`);
					if (r?.code === 'NEEDS_VERIFY') { this.blocked('发评论'); break outer; } // 留着，验证完下次再回
					this.record(it, 'failed', text);
				}
			}
			if (!seeded && works.length > 0) setKv(this.db, 'douyin.comments.seeded', true);
			if (replied > 0) this.lastError = '';
			return { ok: true, replied, skipped };
		} catch (error) {
			this.lastError = `看评论：${errText(error)}`.slice(0, 120);
			this.log('warn', `[fish-soul] 抖音看评论失败：${errText(error)}`);
			return { ok: false, replied, skipped, error: errText(error) };
		} finally {
			this.polling = false;
		}
	}

	status() {
		return { ...super.status(), blockedUntil: this.blockedUntil > Date.now() ? this.blockedUntil : 0 };
	}
}
