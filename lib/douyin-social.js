import { sleep } from './time-util.js';
/**
 * douyin-social.js —— 鱼在抖音自己发图文作品、回作品下的评论（v0.10，默认都关，尽力而为）。
 *
 * 抖音网页版没有能直接调的接口，全靠专用浏览器里点页面：
 *  - 发图文：把她写的话在浏览器里画成一张文字卡片（canvas），到创作者中心「发布图文」上传、填标题和描述、配 BGM、点发布。
 *    BGM 不写死歌单：到编辑页的音乐面板抓「推荐」里的歌，交给模型挑一首；配乐未确认就不发布。
 *    创作者中心（creator.douyin.com）可能要单独登录一次；页面改版就会发不出去（设置页能看到原因）。
 *  - 回评论：每 20 分钟打开「我的」作品页，看最近 3 个作品的评论区，对新评论点「回复」、打字、发送。
 *    第一次只记下已有的评论、不回旧的；"作者"自己的不回；每小时最多 perHour 条。
 *    抖音常在发评论前要短信验证：碰到就停下、提醒主人去浏览器里验证一次，6 小时内不再试。
 * 评论区 / 输入框的结构参考了 pcmxiao/dsh-douyin-bridge 的 lib/comment.mjs（MIT），代码是这里自己写的。
 */
import { mkdirSync, writeFileSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { callBridge, commentBridgeReady, installCommentBridge, uploadImage as uploadCommentImage, WRITE_NOT_ATTEMPTED, WRITE_ATTEMPTED_UNKNOWN } from './channels/vendor/douyin-bridge/douyin-comment.js';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SocialBase, socialCfg, cleanSocialText } from './social.js';
import { DouyinPostJobs } from './douyin-post-jobs.js';
import { 抠正文图 } from './channels/vendor/qq-bridge.js';
import { fishSoulDir, getKv, setKv } from './db.js';
import { isInside } from './gateway-util.js';

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

/**
 * 页面操作的时间上限。
 *
 * 🔴 页面 renderer 卡死但 CDP 连接还在时，Runtime.evaluate **永不回包**：
 *    send 默认 60 秒才超时，waitFor 再乘上轮数（配乐 6 轮 = 6 分钟），
 *    浏览器锁一直被占，期间所有页面操作排队（2026-11-15 巡检 P2）。
 *    ⇒ 每个 eval 都给短超时，waitFor 再加一道总预算兜底。
 *
 * 🔴 多次 eval 的操作（openWork / reply）还要**整操作**的总预算：
 *    光有单次 eval 的短超时不够 —— openWork 是两个 URL 各 12 轮，
 *    24 × 12 秒 = 5 分钟，照样霸着锁（独占锁超时只报错给调用方，
 *    不放锁：见 lib/channels/douyin.js 的 exclusive）。
 */
const PAGE_TIMING = {
	evalTimeoutMs: 12_000,      // 单次 eval 的上限
	waitBudgetMs: 60_000,       // waitFor 的总预算
	gotoTimeoutMs: 15_000,      // 单次导航的上限
	openWorkBudgetMs: 30_000,   // openWork 整操作的总预算
	replyBudgetMs: 30_000,      // reply 整操作的总预算
};

/**
 * 整操作的总预算（终点）。
 *
 * 终点同时管三件事：单次 eval 的超时、轮次之间的等待、还要不要发起下一次 eval。
 * 只在轮次之间查时间是没用的 —— 页面卡死时 eval 自己就挂死（永不回包）。
 *
 * @param {number} totalMs 总预算（毫秒）
 */
function deadline(totalMs) {
	const end = Date.now() + totalMs;
	const left = () => end - Date.now();
	return {
		left,
		/** 到点了没 */
		expired: () => left() <= 0,
		/** 这次 eval 给多少超时：不超过上限，也不越过终点 */
		timeoutFor: (cap) => Math.max(1, Math.min(cap, left())),
		/** 这次该等多久：不超过原时长，也不越过终点 */
		waitFor: (ms) => Math.max(0, Math.min(ms, left()))
	};
}

const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const errText = (e) => String(e instanceof Error ? e.message : e);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 评论图片只能取工作区 `_stickers/` 里的图。
 *
 * 路径是模型写的 = 不可信：`..` 能拼出工作区外的文件，软链接 / junction 能把
 * `_stickers/` 里的一项指到别处。所以边界收在**真实路径**上 ——
 * 目录、软链接/junction 逃逸、非图片格式、超大图一律不发（关掉，不抛）。
 *
 * 信任根本身也要先验：`_stickers` 必须是普通目录 —— 它自己是 junction / 软链接的话，
 * 真实路径整个落到工作区外，只拿 `realRoot` 去比是拦不住的。
 *
 * @param {string} rel `_stickers/xxx` 形状的相对路径
 * @param {string} root 工作区里的 `_stickers` 目录
 * @param {(level: string, msg: string) => void} log
 * @returns {string|null} 校验过的真实路径；不合格返回 null
 */
function safeStickerImagePath(rel, root, log) {
	const deny = () => {
		log('warn', `[fish-soul] 抖音评论图片越界，已忽略：${rel}`);
		return null;
	};
	let rootStat;
	try { rootStat = lstatSync(root); } catch { return null; } // 没有 _stickers 目录 = 没有可发的图
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		log('warn', `[fish-soul] 抖音评论图片根目录不可信（_stickers 不是普通目录），已拒绝：${rel}`);
		return null;
	}
	const abs = resolve(root, rel.slice('_stickers/'.length));
	if (!isInside(root, abs)) return deny();
	if (!IMAGE_EXT.has(extname(abs).toLowerCase())) return null;
	let realRoot, real;
	try {
		realRoot = realpathSync.native(root);
		real = realpathSync.native(abs);
	} catch { return null; }
	if (!isInside(realRoot, real)) return deny();
	try {
		const st = statSync(real);
		if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
	} catch { return null; }
	return real;
}

/** 标题：正文第一句，最多 20 字（抖音图文标题上限 20）。 */
export function noteTitle(text) {
	const first = String(text ?? '').split(/[。！？!?\n]/).map((s) => s.trim()).find(Boolean) ?? '';
	return first.slice(0, 20);
}

/** 心情 → cardJs themes 的下标（顺序：米黄暖 / 浅蓝丧 / 淡紫梦 / 浅绿清 / 粉甜）。 */
export const MOOD_THEME = { warm: 0, blue: 1, dream: 2, fresh: 3, pink: 4 };
const MOOD_LIST = 'warm 暖/治愈、blue 丧/低落、dream 梦幻/恍惚、fresh 清新/日常、pink 甜/开心';

/** 让模型给文案配心情，返回 {theme, reason}；解析不出来就随机一个主题，不耽误发布。 */
export function pickMoodTheme(raw, random = Math.random) {
	const fallback = { theme: Math.floor(random() * 5), reason: '' };
	const m = String(raw ?? '').match(/\{[^{}]*\}/s);
	if (!m) return fallback;
	let j;
	try { j = JSON.parse(m[0]); } catch { return fallback; }
	const mood = String(j?.mood ?? '').toLowerCase().trim();
	const theme = Object.hasOwn(MOOD_THEME, mood) ? MOOD_THEME[mood] : fallback.theme;
	return { theme, reason: String(j?.reason ?? '').trim().slice(0, 40) };
}

/** 从抖音推荐的歌里挑一首（只能挑列表里的，模型编的名字不算）；挑不出来返回 ''。 */
export function pickRecommendedSong(raw, songs) {
	const list = (Array.isArray(songs) ? songs : []).map((s) => String(s ?? '').trim()).filter(Boolean);
	if (!list.length) return '';
	const out = String(raw ?? '').trim().replace(/^["'「『\s]+|["'」』\s]+$/g, '');
	if (!out) return '';
	if (list.includes(out)) return out;
	return [...list].sort((a, b) => b.length - a.length).find((s) => out.includes(s)) ?? '';
}

/** 评论去重用的 id：作品 + 谁 + 说了什么。 */
export function commentKey(workId, author, content) {
	return `${workId}:${createHash('sha1').update(`${author}\n${content}`).digest('hex').slice(0, 16)}`;
}

/**
 * 评论去重 id：优先用评论自己的 cid（`作品:cid:xxx`），没有 cid 才落回文本哈希。
 *
 * 文本 key 的毛病：作者改了评论，正文变了 → key 变了 → 同一条评论被当成新的又回一遍
 * （在真实账号上回两遍）。cid 是抖音给的评论 id，不随正文变。
 *
 * @param {string} workId 作品 id
 * @param {string} cid 评论 id（没有就空串）
 * @param {string} author 作者昵称
 * @param {string} content 评论正文
 * @returns {string} 去重 id
 */
export function commentId(workId, cid, author, content) {
	const c = String(cid ?? '').trim();
	if (c !== '') return `${workId}:cid:${c}`;
	return commentKey(workId, author, content);
}

// ───────────── 页面脚本 ─────────────

export const VERIFY_JS = String.raw`(() => {
  const t = document.body ? document.body.innerText : '';
  const sms = /接收短信验证码|获取验证码|请输入验证码/.test(t);
  const captcha = /滑块验证|安全验证|请完成验证|拖动滑块/.test(t);
  // 滑块常挂在独立 iframe（rc-verifycenter）里，body 文本一个字都不露（2026-11-15 真机踩过）
  const frame = [...document.querySelectorAll('iframe')].some((f) => /rc-verifycenter|verifycenter|captcha/i.test(String(f.src || '')));
  return sms || captcha || frame ? (sms ? 'sms' : 'captcha') : '';
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

/** 评论区状态。box 必须是「可见」的（有布局尺寸）——note 页评论区默认折叠，
 *  容器在 DOM 里但 display:none，只判存在会把折叠态误判成「已打开」，
 *  于是 openWork 不点图标就返回 ok，后面 reply() 必然 NO_BOX（2026-11-06 实测）。 */
export const COMMENT_STATE_JS = `(() => {
  const box = document.querySelector('${SEL.input}');
  const r = box ? box.getBoundingClientRect() : null;
  return {
    box: Boolean(r && r.width > 0 && r.height > 0),
    inDom: Boolean(box),
    items: document.querySelectorAll('${SEL.item}').length,
    btn: Boolean(document.querySelector('${SEL.commentBtn}')),
    url: location.href
  };
})()`;

/** 编辑页上的「选择音乐」入口（页面有多个同名节点，取最后一个——真正可点的那颗）。 */
const MUSIC_ENTRY_JS = String.raw`(() => {
  const els = [...document.querySelectorAll('div, span, button')].filter((x) => x.children.length === 0 && /选择音乐/.test((x.innerText || '').trim()));
  const el = els[els.length - 1];
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
})()`;

/** 只在可见音乐抽屉中读取歌卡；避免抓到预览区或其他面板里的文字。 */
const MUSIC_DOM_JS = String.raw`
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const panel = [...document.querySelectorAll('.semi-sidesheet-content, [class*="music-collection-container"]')].find(el => visible(el) && (el.matches('[class*="music-collection-container"]') || el.querySelector('input[placeholder*="搜索"], [class*="music-collection-container"]')));
  const rows = panel ? [...panel.querySelectorAll('[class*="card-container"], [class*="music-item"], [class*="song-item"], [class*="MusicItem"]')].filter(visible) : [];
  const nameOf = (row) => ((row.querySelector('[class*="song-name"]')?.innerText || (row.innerText || '').split('\n')[0]) || '').trim();
`;
const MUSIC_OPEN_JS = `(() => { ${MUSIC_DOM_JS} return Boolean(panel); })()`;
const MUSIC_ROWS_JS = `(() => { ${MUSIC_DOM_JS}
  return rows.map(nameOf).map(s => String(s || '').trim()).filter(Boolean).slice(0, 20);
})()`;
const MUSIC_TAB_JS = `(() => { ${MUSIC_DOM_JS}
  if (!panel) return false;
  const tab = [...panel.querySelectorAll('div, span, button')].find(x => x.children.length === 0 && (x.innerText || '').trim() === '推荐' && visible(x));
  if (tab) tab.click();
  return Boolean(tab);
})()`;

/** 评论区里的一级评论：作者 / 内容 / 是不是作者本人 / 能不能回。
 *  真实结构（2026-11-06 连真浏览器 dump 出来的）：
 *    div[data-e2e=comment-item]
 *      a[href*="/user/"]                        ← 昵称
 *      .comment-item-info-wrap                  ← 作者信息块（里面有 [data-e2e=video-comment-more] 的「...」按钮）
 *      .comment-item-info-wrap + 1（兄弟节点）   ← 评论正文
 *      .VAQA49VP                                ← 「3天前·浙江」
 *      .comment-item-stats-container            ← 「0 分享 回复」
 *  两条教训：① 整个 item 的 innerText 常常是**单行无换行**的，拆行取 rest[1] 取不到正文；
 *  ② [data-e2e=video-comment-more] 的文本就是「...」，换行布局时它会独占一行被当成正文 →
 *  19/20 条评论被读成「...」。所以正文改取「作者信息块的下一个兄弟节点」，拆行只做兜底。 */
export const LIST_COMMENTS_JS = `(() => [...document.querySelectorAll('${SEL.item}')].map((el, i) => {
  const lines = (el.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  const stats = el.querySelector('${SEL.stats}');
  const canReply = Boolean(stats && [...stats.querySelectorAll('*')].some((x) => (x.innerText || '').trim() === '回复'));
  const infoWrap = el.querySelector('.comment-item-info-wrap')
    || (el.querySelector('[data-e2e="video-comment-more"]') || {}).parentElement
    || null;
  const nameLink = el.querySelector('a[href*="/user/"]');
  let author = nameLink ? (nameLink.innerText || '').trim() : '';
  // 正文 = 作者信息块的下一个兄弟节点（独立节点，不含「更多」按钮，也不含「展开」按钮）
  let content = infoWrap && infoWrap.nextElementSibling ? (infoWrap.nextElementSibling.innerText || '').trim() : '';
  const NOISE = (s) => s === '' || s === '...' || s === '···' || s === '…' || s === '作者' || s === '置顶' || s === '作者赞过';
  if (NOISE(content)) content = '';
  if (!content) {
    // 兜底：叶子节点里挑一段既不是作者名、也不是时间 / 按钮 / 纯数字的文本
    const cand = [...el.querySelectorAll('span, div, p')].filter((x) => x.children.length === 0)
      .map((x) => (x.innerText || '').trim())
      .filter((s) => !NOISE(s) && s !== author
        && !/^展开/.test(s) && !/^收起/.test(s)
        && !/^\\d+$/.test(s)
        && !/^(分享|回复|点赞|收藏|举报|关注)$/.test(s)
        && !/\\d+\\s*(天|小时|分钟|秒|周|月|年)前/.test(s)
        && !/·\\S+$/.test(s));
    content = cand[0] || '';
  }
  if (!author) author = (lines[0] || '').slice(0, 40);
  // 「作者」标记是 0 层叶子节点里文本恰为「作者」的那颗（不靠行号、不靠位置）
  const isAuthor = [...el.querySelectorAll('span, div, p')].some((x) => x.children.length === 0 && (x.innerText || '').trim() === '作者');
  return { i, author: author.slice(0, 40), content: content.slice(0, 300), isAuthor, canReply };
}))()`;

async function realClick(br, x, y, timeoutMs) {
	for (const type of ['mousePressed', 'mouseReleased']) {
		await br.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, br.sessionId, timeoutMs);
	}
}

/** 预算到期的哨兵：区分「没等到」和「等到的是假值」。 */
const BUDGET_OUT = Symbol('budget-out');

/**
 * 等 fn 出结果，最长等 budgetMs。
 *
 * 🔴 预算必须**包住 fn 这一次调用** —— 页面 renderer 卡死时 fn 自己就挂死
 *    （Runtime.evaluate 永不回包），只在轮次之间查时间没用：
 *    配乐 6 轮 × 60 秒 = 锁被占 6 分钟（2026-11-15 巡检 P2）。
 *
 * @param {Function} fn 每轮调用一次；返回假值 / 抛错 = 还没等到
 * @param {object} opts
 * @param {number} opts.tries 最多试几轮
 * @param {number} opts.gapMs 两轮之间隔多久
 * @param {number} opts.budgetMs 总预算（毫秒）；到点直接返回 null（非正数 = 不等，直接返回 null）
 * @returns {Promise<any>} 等到的值；没等到返回 null
 */
async function waitFor(fn, { tries = 10, gapMs = 1000, budgetMs = PAGE_TIMING.waitBudgetMs } = {}) {
	const end = Date.now() + budgetMs;
	for (let i = 0; i < tries; i++) {
		const left = end - Date.now();
		if (left <= 0) return null;
		let timer;
		const v = await Promise.race([
			fn().catch(() => null),
			new Promise((resolve) => { timer = setTimeout(() => resolve(BUDGET_OUT), left); timer.unref?.(); }),
		]).finally(() => clearTimeout(timer));
		if (v === BUDGET_OUT) return null;
		if (v) return v;
		const rest = end - Date.now();
		if (rest <= 0) return null;
		await sleep(Math.min(gapMs, rest));
	}
	return null;
}

/** 点编辑页上的「选择音乐」入口（真点，不是 JS click），返回点了没。 */
/** 页面活性检测（导出供测试）。renderer 卡死时 eval 会永远 pending，必须带超时竞速。
 *  不通就 reload 一次再试；还不通返回 false，调用方别再往死页面上发操作。
 *  （2026-11-15 真机实录：创作者中心页挂着验证码 iframe 后整页 hung 死，
 *  Runtime.evaluate / Page.navigate 全部无响应，配乐两次报错的根因。） */
export async function ensurePageAlive(br, { timeoutMs = 3000, reload = true } = {}) {
	const probe = () => Promise.race([
		br.eval('1').then(() => true, () => false),
		sleep(timeoutMs).then(() => false),
	]);
	if (await probe()) return true;
	if (!reload) return false;
	// 死页面上 reload 命令本身也不回。send 的超时参数只对真 Browser 生效，
	// 这里再套一层竞速，任何实现都不会卡死超过 5 秒。
	await Promise.race([
		br.send('Page.reload', {}, br.sessionId, 5000).catch(() => {}),
		sleep(5000),
	]);
	await sleep(3000);
	return await probe();
}

async function clickMusicEntry(br, timing) {
	const sel = await br.eval(MUSIC_ENTRY_JS, { timeoutMs: timing.evalTimeoutMs }).catch(() => null);
	if (!sel) return false;
	await realClick(br, sel.x, sel.y);
	await sleep(1200);
	return true;
}

/** 打开音乐面板，返回面板开了没。 */
async function openMusicPanel(br, timing) {
	if (!await clickMusicEntry(br, timing)) return false;
	const opened = await waitFor(() => br.eval(MUSIC_OPEN_JS, { timeoutMs: timing.evalTimeoutMs }).catch(() => false), { tries: 6, gapMs: 800, budgetMs: timing.waitBudgetMs });
	return opened === true;
}

/** 打开推荐列表并保持抽屉打开，模型选完后直接点击同一张卡片。 */
async function grabRecommendedMusic(br, timing) {
	// 页面卡死时 eval 永远 pending，waitFor 会空等十几秒再报「没找到面板」（2026-11-15 真机）。
	// 先探活，死了就 reload 一次；还死就直接报原因，不在死页面上盲点。
	if (!await ensurePageAlive(br)) return { ok: false, error: '页面没响应（已尝试刷新一次），没找到或打开音乐面板' };
	if (!await openMusicPanel(br, timing)) return { ok: false, error: '没找到或打开音乐面板' };
	await br.eval(MUSIC_TAB_JS, { timeoutMs: timing.evalTimeoutMs }).catch(() => false);
	const songs = await waitFor(async () => {
		const list = await br.eval(MUSIC_ROWS_JS, { timeoutMs: timing.evalTimeoutMs }).catch(() => []);
		return Array.isArray(list) && list.length ? list : null;
	}, { tries: 12, gapMs: 800, budgetMs: timing.waitBudgetMs });
	if (!songs) return { ok: false, error: '音乐面板没有加载出推荐歌曲' };
	const counts = {};
	for (const name of songs) counts[name] = (counts[name] ?? 0) + 1;
	return { ok: true, songs: [...new Set(songs)].slice(0, 10), counts };
}

/** 关掉音乐面板，避免失败后影响下一次操作。 */
async function shutMusicPanel(br, timing) {
	if (!await br.eval(MUSIC_OPEN_JS, { timeoutMs: timing.evalTimeoutMs }).catch(() => false)) return;
	for (const type of ['keyDown', 'keyUp']) {
		await br.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, br.sessionId).catch(() => {});
	}
	await sleep(400);
	await br.eval(String.raw`(() => {
  const panel = [...document.querySelectorAll('.semi-sidesheet-content, [class*="music-collection-container"]')].find(x => { const r = x.getBoundingClientRect(); return r.width && r.height; });
  if (!panel) return true;
  const close = panel.closest('.semi-sidesheet')?.querySelector('.semi-sidesheet-close, [aria-label="close"]');
  if (close) close.click();
  return true;
})()`, { timeoutMs: timing.evalTimeoutMs }).catch(() => false);
}

/** 仅点击匹配歌曲卡片内的「使用」，并在编辑区确认歌名后才允许发布。
 *  allowDuplicate：推荐里同名卡不止一张时点第一张。编辑页仍要确认歌名，确认不了就不发布。 */
async function pickNoteMusic(br, music, { allowDuplicate = false, timing = PAGE_TIMING } = {}) {
	if (!music) return { ok: false, error: '模型没有选出推荐歌曲' };
	try {
		const card = await br.eval(`(() => { ${MUSIC_DOM_JS}
  const matches = rows.filter(row => nameOf(row) === ${JSON.stringify(music)});
  if (!matches.length) return { count: 0 };
  const target = matches.length === 1 || ${allowDuplicate ? 'true' : 'false'} ? matches[0] : null;
  if (!target) return { count: matches.length };
  target.scrollIntoView({ block: 'center' });
  const r = target.getBoundingClientRect();
  return { count: matches.length, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`, { timeoutMs: timing.evalTimeoutMs });
		if (!card?.count) return { ok: false, error: '选中的歌曲已不在推荐列表' };
		// 同名（剪辑版 / 合集版）不整单作废。点第一张，后面仍要编辑页确认歌名。
		if (card.count !== 1 && !allowDuplicate) return { ok: false, error: '推荐列表里有同名歌曲，无法确定选哪首' };
		await br.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y }, br.sessionId);
		const btn = await waitFor(() => br.eval(`(() => { ${MUSIC_DOM_JS}
  const matches = rows.filter(row => nameOf(row) === ${JSON.stringify(music)});
  if (!matches.length || (matches.length !== 1 && !${allowDuplicate ? 'true' : 'false'})) return null;
  const b = [...matches[0].querySelectorAll('button, [class*="apply-btn"]')].find(x => /^(使用(歌曲)?|配乐|选它)$/.test((x.innerText || '').trim()) && visible(x));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`, { timeoutMs: timing.evalTimeoutMs }), { tries: 8, gapMs: 500, budgetMs: timing.waitBudgetMs });
		if (!btn) return { ok: false, error: '歌曲卡片悬停后没有出现使用按钮' };
		await realClick(br, btn.x, btn.y);
		const verified = await waitFor(() => br.eval(`(() => {
  const want = ${JSON.stringify(music)}.replace(/\\s+/g, '');
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const anchors = [...document.querySelectorAll('[class*="container-right"]')].filter(visible);
  for (const anchor of anchors) {
    if (anchor.closest('.semi-sidesheet, [class*="music-collection-container"]')) continue;
    let row = anchor;
    for (let i = 0; i < 4 && row; i++, row = row.parentElement) {
      if (row === document.body || row.querySelector('.semi-sidesheet, [class*="music-collection-container"], [class*="preview"], [contenteditable="true"], input[placeholder*="标题"]')) break;
      const text = (row.innerText || '').trim();
      if (text.length <= 250 && text.replace(/\\s+/g, '').includes(want)) return true;
    }
  }
  return false;
})()`, { timeoutMs: timing.evalTimeoutMs }).catch(() => false), { tries: 10, gapMs: 500, budgetMs: timing.waitBudgetMs });
		return verified ? { ok: true } : { ok: false, error: '已点击使用，但编辑页未确认显示歌名' };
	} catch (error) {
		return { ok: false, error: `配乐操作出错：${String(error?.message ?? error).slice(0, 80)}` };
	}
}

/** 真正的页面驱动（测试里换成假的）。全部都得在 host.exclusive 里调。
 *  timing：页面操作的时间上限（eval 单次超时 / waitFor 总预算），测试可以调小。 */
export function douyinSocialDriver(host, timing = {}) {
	const tm = { ...PAGE_TIMING, ...timing };
	const b = () => {
		if (!host.running) throw new Error('抖音浏览器没在运行');
		return host.browser;
	};
	/**
	 * 读页面上的验证类型 —— **区分「没有验证码」和「没读到」**。
	 *
	 * ⚠️ eval 失败（超时 / CDP 断连 / 页面崩了）时读回来是空串，
	 *    和「没有验证码」分不开。分不开就等于把「不知道」当成「不用验证」。
	 *
	 * @param {number} timeoutMs 这次读的超时（reply 走整操作预算，别超预算）
	 * @returns {Promise<{kind: string, error: string}>} error 非空 = 没读到
	 */
	const readVerifyKind = async (timeoutMs) => {
		try {
			return { kind: String(await b().eval(VERIFY_JS, { timeoutMs }) ?? ''), error: '' };
		} catch (error) {
			return { kind: '', error: errText(error) };
		}
	};
	/** 发作品那条路用：读不到就当没有（它还有「发布成功」这个更硬的凭据兜底）。 */
	const verifyKind = async () => (await readVerifyKind(tm.evalTimeoutMs)).kind;

	return {
		async renderCard(text, foot, theme = 0) {
			const out = await b().eval(cardJs(text, foot, theme), { timeoutMs: tm.evalTimeoutMs });
			return typeof out === 'string' && out !== '' ? Buffer.from(out, 'base64') : null;
		},

		/** 创作者中心：传图 + 填标题描述，停在编辑页。返回 {ok, code?, error?}。 */
		async prepareNote({ title, text, file }) {
			const br = b();
			// 进创作者中心前先探活：renderer 卡死时 goto 会白等 60 秒超时（2026-11-15 真机）。
			if (!await ensurePageAlive(br)) return { ok: false, code: 'PAGE_DEAD', error: '抖音浏览器页面没响应（已尝试刷新一次），过会儿再试' };
			await br.goto(CREATOR_UPLOAD_URL, { settleMs: 8000 });
			const url = String(await br.eval('location.href', { timeoutMs: tm.evalTimeoutMs }).catch(() => '') ?? '');
			if (!/creator\.douyin\.com\/creator-micro/.test(url)) return { ok: false, code: 'NOT_LOGGED_IN', error: '创作者中心没登录：在抖音浏览器里打开 creator.douyin.com 登录一次' };
			// 切到「发布图文」页签（默认就是的话点了也没事）
			await br.eval(String.raw`(() => {
  const el = [...document.querySelectorAll('div, span, button')].find((x) => x.children.length === 0 && /^发布图文$/.test((x.innerText || '').trim()));
  if (el) el.click();
  return Boolean(el);
})()`, { timeoutMs: tm.evalTimeoutMs }).catch(() => false);
			await sleep(1500);
			const r = await br.send('Runtime.evaluate', { expression: `document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]')` }, br.sessionId, tm.evalTimeoutMs);
			const objectId = r?.result?.objectId;
			if (!objectId) return { ok: false, code: 'NO_UPLOAD', error: '创作者中心页面上没找到上传图片的地方（可能改版了）' };
			await br.send('DOM.setFileInputFiles', { files: [file], objectId }, br.sessionId);
			const ready = await waitFor(() => br.eval(`(() => Boolean(document.querySelector('input[placeholder*="标题"]') || document.querySelector('[contenteditable="true"]')))()`, { timeoutMs: tm.evalTimeoutMs }), { tries: 40, budgetMs: tm.waitBudgetMs });
			if (!ready) return { ok: false, code: 'NO_EDITOR', error: '传完图片没进到编辑页' };
			await sleep(1500);
			if (title) {
				const has = await br.eval(`(() => { const el = document.querySelector('input[placeholder*="标题"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); el.select && el.select(); return true; })()`, { timeoutMs: tm.evalTimeoutMs }).catch(() => false);
				if (has) { await br.send('Input.insertText', { text: title }, br.sessionId); await sleep(500); }
			}
			const pos = await br.eval(String.raw`(() => {
  const el = document.querySelector('.zone-container[contenteditable="true"]') || document.querySelector('[data-placeholder*="描述"][contenteditable="true"]') || document.querySelector('[contenteditable="true"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + Math.min(20, r.height / 2)) } : null;
})()`, { timeoutMs: tm.evalTimeoutMs }).catch(() => null);
			if (!pos) return { ok: false, code: 'NO_EDITOR', error: '编辑页上没找到写描述的地方' };
			await realClick(br, pos.x, pos.y);
			await sleep(500);
			await br.send('Input.insertText', { text }, br.sessionId);
			await sleep(1000);
			// 等图片传完（"上传中"没了）
			await waitFor(async () => !/上传中|正在上传/.test(String(await br.eval('document.body.innerText', { timeoutMs: tm.evalTimeoutMs }).catch(() => '') ?? '')), { tries: 30, budgetMs: tm.waitBudgetMs });
			return { ok: true };
		},

		/** 打开音乐面板，抓推荐歌并保持面板打开。 */
		async listRecommendedMusic() {
			return await grabRecommendedMusic(b(), tm);
		},

		async closeMusicPanel() { await shutMusicPanel(b(), tm); },

		/** 配乐确认成功后才能点发布。 */
		async publishNote({ music, beforeSubmit, allowDuplicate = false }) {
			const br = b();
			const picked = await pickNoteMusic(br, String(music ?? ''), { allowDuplicate, timing: tm });
			if (!picked.ok) return { ok: false, code: 'MUSIC_FAILED', error: `配乐失败，未发布：${picked.error}` };
			if (beforeSubmit) await beforeSubmit(); // 在可能产生平台副作用之前持久化
			const clicked = await br.eval(String.raw`(() => {
  const btns = [...document.querySelectorAll('button')].filter((x) => (x.innerText || '').trim() === '发布' && !x.disabled);
  const el = btns[btns.length - 1];
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return true;
})()`, { timeoutMs: tm.evalTimeoutMs }).catch(() => false);
			if (!clicked) return { ok: false, code: 'NO_PUBLISH', error: '编辑页上没找到「发布」按钮' };
			const done = await waitFor(async () => {
				const v = await verifyKind();
				if (v) return { verify: v };
				const st = await br.eval(`(() => ({ url: location.href, text: (document.body.innerText || '').slice(0, 3000) }))()`, { timeoutMs: tm.evalTimeoutMs });
				return /content\/manage/.test(st?.url ?? '') || /发布成功/.test(st?.text ?? '') ? { ok: true } : null;
			}, { tries: 25, budgetMs: tm.waitBudgetMs });
			if (done?.verify) return { ok: false, code: 'NEEDS_VERIFY', error: '抖音要验证（短信 / 滑块）才能发' };
			if (!done?.ok) return { ok: false, code: 'NOT_CONFIRMED', error: '点了发布，但没等到「发布成功」（可能在审核，或者页面改版了）' };
			return { ok: true, musicPicked: true };
		},

		/** 「我的」作品（最多 limit 个，新的在前）。 */
		async listWorks(limit = 3) {
			const br = b();
			await br.goto(SELF_URL, { settleMs: 7000, timeoutMs: tm.gotoTimeoutMs });
			const list = await waitFor(async () => { const l = await br.eval(WORKS_JS, { timeoutMs: tm.evalTimeoutMs }); return Array.isArray(l) && l.length > 0 ? l : null; }, { tries: 6, budgetMs: tm.waitBudgetMs });
			return (list ?? []).slice(0, limit);
		},

		/** 打开作品并展开评论区。评论区默认折叠时要点图标展开，且可能一次点不开（面板动画 / 被别的东西盖住），
		 *  所以每 3 轮重试一次、最多点 4 次；全程以「输入框可见」为准，不靠「元素存在」误判。
		 *
		 *  🔴 整操作有总预算（deadline）：两个 URL 各 12 轮，每轮至少一次 eval，
		 *     页面卡死时一轮就 60 秒 ⇒ 光靠单次 eval 的短超时也要 5 分钟，照样霸着锁。 */
		async openWork(w) {
			const br = b();
			const dl = deadline(tm.openWorkBudgetMs);
			let last = null;
			for (const url of [`https://www.douyin.com/?modal_id=${w.id}`, `https://www.douyin.com/${w.kind === 'note' ? 'note' : 'video'}/${w.id}`]) {
				if (dl.expired()) break;
				try { await br.goto(url, { settleMs: 7000, timeoutMs: dl.timeoutFor(tm.gotoTimeoutMs) }); } catch { continue; }
				let clicks = 0;
				for (let i = 0; i < 12; i++) {
					if (dl.expired()) break;
					const st = await br.eval(COMMENT_STATE_JS, { timeoutMs: dl.timeoutFor(tm.evalTimeoutMs) }).catch(() => null);
					last = st ?? last;
					if (st?.box) return { ok: true };
					if (st?.btn && clicks < 4 && i % 3 === 0) {
						const p = await br.eval(`(() => { const el = document.querySelector('${SEL.commentBtn}'); if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.top >= 0 && r.bottom <= innerHeight ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`, { timeoutMs: dl.timeoutFor(tm.evalTimeoutMs) }).catch(() => null);
						if (p) { await realClick(br, p.x, p.y, dl.timeoutFor(tm.evalTimeoutMs)); clicks++; }
					}
					await sleep(dl.waitFor(1000));
				}
			}
			const why = last === null ? '读不到页面状态' : `输入框${last.inDom ? '在 DOM 里但不可见' : '不存在'}、评论图标${last.btn ? '在' : '不在'}、已读到 ${last.items} 条评论`;
			return { ok: false, error: `作品页没打开评论区（${why}）` };
		},

		async listComments() {
			const l = await b().eval(LIST_COMMENTS_JS, { timeoutMs: tm.evalTimeoutMs }).catch(() => []);
			return Array.isArray(l) ? l : [];
		},

		/**
		 * 抖音评论可用的表情码清单（[微笑] 这种）。
		 *
		 * ⚠️ 抖音服务端会把文字码自动渲染成表情图片 —— 实测发一条「[发呆]」，
		 *    页面上出来的是那张表情图（2026-11-07 真机验证）。
		 *    所以「发表情」不需要任何特殊接口，就是发带表情码的文字。
		 *
		 * 清单缓存 6 小时：接口一次给 200 多个，拉一次够用很久。
		 */
		async emojiCodes() {
			const br = b();
			if (!this._emojiCodes) {
				if (!(await commentBridgeReady(br, { timeoutMs: tm.evalTimeoutMs }))) await installCommentBridge(br, { timeoutMs: tm.evalTimeoutMs });
				const r = await callBridge(br, 'emojiList', {}, { timeoutMs: tm.evalTimeoutMs });
				this._emojiCodes = r.ok ? (r.list || []).map((e) => e.name).filter(Boolean) : [];
				this._emojiCodesAt = Date.now();
			}
			if (Date.now() - (this._emojiCodesAt || 0) > 6 * 3600_000) {
				this._emojiCodes = null;
				return this.emojiCodes();
			}
			return this._emojiCodes;
		},

		/**
		 * 接口版评论列表（带 cid）。
		 *
		 * 为什么要它：DOM 版只能拿到「作者 + 内容」，拿不到评论 id；
		 * 而回评论要带 reply_id（被回复那条的 cid），只有接口能给。
		 * 拿不到就返回空数组，调用方退回 DOM 版。
		 */
		async listCommentsApi(awemeId, count = 20) {
			const br = b();
			// ⚠️ 顺序：先保证页面在作品页上，**再**装桥。
			//    导航会把页面里注入的桥冲掉（反了就成了「桥没装上」）。
			// ⚠️ 接口认的是「当前页面 URL」—— 页面停在 /note/<id> 上才给评论，
			//    停在 ?modal_id=<id> 上会返回**空列表**（2026-11-07 实测：同一作品 6 条 vs 0 条）。
			//    Referer 是受限头，fetch 里设不了，只能保证页面本身在那儿。
			const onWork = await br.eval(`(() => {
				const id = ${JSON.stringify(String(awemeId || ''))};
				return location.pathname.indexOf('/note/' + id) >= 0 || location.pathname.indexOf('/video/' + id) >= 0;
			})()`, { timeoutMs: tm.evalTimeoutMs }).catch(() => false);
			if (!onWork) {
				await br.goto(`https://www.douyin.com/note/${awemeId}`, { settleMs: 8000, timeoutMs: tm.gotoTimeoutMs }).catch(() => {});
			}
			if (!(await commentBridgeReady(br, { timeoutMs: tm.evalTimeoutMs }))) {
				const ins = await installCommentBridge(br, { timeoutMs: tm.evalTimeoutMs });
				if (!ins.ok) return [];
			}
			const r = await callBridge(br, 'commentList', { awemeId, count }, { timeoutMs: tm.evalTimeoutMs });
			if (!r.ok) return [];
			return (r.list || []).map((c) => ({
				author: c.author || '', content: c.text || '', cid: c.cid || '',
				replyId: c.replyId || '0', isAuthor: false, canReply: true,
			}));
		},

		/**
		 * 接口版回评论（带 reply_id）。text 可为空（只发图）。
		 *
		 * ⚠️ 这是写操作，**不做自动重试** —— 重试就是重复发评论。
		 * ⚠️ 失败分两种（writeState 是结构化字段，别拿错误文本猜）：
		 *    · NOT_ATTEMPTED     —— 根本没发出去（桥没装上 / 本地校验没过 / 图没传上去），
		 *                            调用方可以退回 DOM 点击；
		 *    · ATTEMPTED_UNKNOWN —— 可能已经发出去了（超时 / 断连 / 抖音没回评论 id），
		 *                            调用方**绝不能再发一次**。
		 *
		 * @param {object} opts
		 * @param {() => void} [opts.onBeforeWrite] 真正把评论发出去**之前**叫一次（同步）。
		 *        只有这一刻才算「可能已经发出去了」—— 本地校验 / 前置阶段没过时**不许**叫：
		 *        叫了，调用方就会把「压根没发出去」当成「可能发出去了」，这条评论再也回不了。
		 */
		async replyApi({ awemeId, cid, text, images }, opts = {}) {
			// ⚠️ 本地校验在 Node 侧先判一遍：请求根本没发出去 → NOT_ATTEMPTED。
			//    页面桥里也有一份（防别的调用方绕过），但这里必须先判 ——
			//    否则 onBeforeWrite 会被叫到，白白把「没发出去」记成「可能发出去了」。
			if (!awemeId) return { ok: false, writeState: WRITE_NOT_ATTEMPTED, error: '没给作品 id' };
			const br = b();
			if (!(await commentBridgeReady(br))) {
				const ins = await installCommentBridge(br);
				if (!ins.ok) return { ok: false, writeState: WRITE_NOT_ATTEMPTED, error: '评论桥没装上' };
			}
			const posted = [];
			// ⚠️ 只把**前置阶段**（取授权 + 传图）包起来，不包 postComment：
			//    前置阶段抛了 = 图还没传上去，评论**根本没发出去** → NOT_ATTEMPTED，
			//    调用方还能退回 DOM 点击。postComment 抛了性质完全不同（可能已经发出去了）。
			try {
				for (const img of images || []) {
					const bytes = img.bytes;
					if (!bytes) continue;
					const auth = await callBridge(br, 'uploadAuth', {});
					if (!auth.ok) return { ok: false, writeState: WRITE_NOT_ATTEMPTED, error: `取图片上传授权失败：${auth.error ?? ''}`.slice(0, 120) };
					const up = await uploadCommentImage({ auth, bytes, format: img.format });
					if (!up.ok) return { ok: false, writeState: WRITE_NOT_ATTEMPTED, error: `图片上传失败：${up.error ?? ''}`.slice(0, 120) };
					posted.push({ uri: up.uri, width: up.width, height: up.height, format: up.format });
				}
			} catch (error) {
				// 前置阶段的网络异常（授权 / 上传）：评论没发出去 → NOT_ATTEMPTED，保留 DOM 回退
				return { ok: false, writeState: WRITE_NOT_ATTEMPTED, error: `图片前置失败：${errText(error)}`.slice(0, 120) };
			}
			// 正文和图片都空 = 请求根本没发出去（同页面桥那份；这里先判：onBeforeWrite 不能叫）
			if (!text && !posted.length) return { ok: false, writeState: WRITE_NOT_ATTEMPTED, error: '正文和图片都是空的' };
			// ⚠️ 真正要发出去了 —— 只有这一刻才算「可能已经发出去了」
			opts.onBeforeWrite?.();
			const r = await callBridge(br, 'postComment', {
				awemeId, text: text || '', replyId: cid || '', images: posted,
			}, { write: true });
			if (!r.ok) return { ok: false, writeState: r.writeState ?? WRITE_ATTEMPTED_UNKNOWN, error: r.error ?? '没发出去' };
			return { ok: true, cid: r.cid };
		},

		/** 回复某条评论（按作者 + 内容找，不靠序号）。内容是「...」这类截断残渣时只按作者找
		 *  （2026-11-06：按「...」includes 永远匹配不到，5 条想回的评论全 NOT_FOUND）。返回 {ok, code?, error?}。
		 *
		 *  🔴 整操作有总预算（deadline）：这里 6 次 eval + 4 段固定等待，
		 *     页面卡死时不设预算就是 6 × 60 秒 = 6 分钟，照样霸着浏览器锁。 */
		async reply({ author, content }, text) {
			const br = b();
			const dl = deadline(tm.replyBudgetMs);
			const to = () => dl.timeoutFor(tm.evalTimeoutMs);
			const before = await br.eval(`document.querySelectorAll('${SEL.input}').length`, { timeoutMs: to() }).catch(() => 0);
			const usable = String(content ?? '').trim();
			const contentKey = usable === '' || usable === '...' || usable === '···' || usable === '…' ? null : usable.slice(0, 40);
			const clicked = await br.eval(`(() => {
  const want = ${JSON.stringify({ author, content: contentKey })};
  const el = [...document.querySelectorAll('${SEL.item}')].find((x) => { const t = x.innerText || ''; return t.includes(want.author) && (want.content === null || t.includes(want.content)); });
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  const stats = el.querySelector('${SEL.stats}');
  const leaf = stats && [...stats.querySelectorAll('*')].find((x) => (x.innerText || '').trim() === '回复');
  if (!leaf) return false;
  el.setAttribute('data-fish-reply', '1');
  leaf.click();
  return true;
})()`, { timeoutMs: to() }).catch(() => false);
			if (!clicked) return { ok: false, code: 'NOT_FOUND', error: '评论区里没找到这条评论' };
			await sleep(dl.waitFor(1200));
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
})()`, { timeoutMs: to() }).catch(() => null);
			const cleanup = () => br.eval(`(() => { for (const el of document.querySelectorAll('[data-fish-reply],[data-fish-box]')) { el.removeAttribute('data-fish-reply'); el.removeAttribute('data-fish-box'); } return true; })()`, { timeoutMs: to() }).catch(() => {});
			try {
				if (!pos) return { ok: false, code: 'NO_BOX', error: '点了「回复」没出来输入框' };
				await realClick(br, pos.x, pos.y, to());
				const focused = await waitFor(() => br.eval(`(() => { const box = document.querySelector('[data-fish-box="1"]'); const ed = box && box.querySelector('${SEL.editor}'); if (!ed) return false; const a = document.activeElement; if (!(a && (a === ed || ed.contains(a)))) ed.focus(); return true; })()`, { timeoutMs: to() }), { tries: 12, gapMs: 300, budgetMs: Math.min(tm.waitBudgetMs, dl.left()) });
				if (!focused) return { ok: false, code: 'NO_EDITOR', error: '回复框没聚焦上' };
				await br.send('Input.insertText', { text }, br.sessionId, to());
				await sleep(dl.waitFor(800));
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
})()`, { timeoutMs: to() }).catch(() => false);
				if (!sent) return { ok: false, code: 'NO_SEND', error: '回复框旁边没找到发送按钮' };
				await sleep(dl.waitFor(2000));
				// ⚠️ 「读不回来」和「读到空」必须分开（2026-11-16 巡检 P2）：
				//    eval 超时 / CDP 断连 / 页面崩了，读回来的都是空串 —— 和
				//    「没有验证码」「框里真没字」分不开。分不开就一路落到 ok: true，
				//    主人被告知「回了 X 的评论」，其实压根没发出去（状态虚报）。
				//    读失败只能说「不知道」：宁可报失败（下一轮按 failed 记、不重发），
				//    也不能把「不知道」报成「发出去了」。
				const verified = await readVerifyKind(to());
				if (verified.error) return { ok: false, code: 'VERIFY_UNKNOWN', error: `读不到抖音的验证状态：${verified.error}` };
				if (verified.kind) return { ok: false, code: 'NEEDS_VERIFY', error: '抖音要验证（短信 / 滑块）才能发评论' };
				let left;
				try {
					left = String(await br.eval(`(() => { const ed = document.querySelector('[data-fish-box="1"] ${SEL.editor}'); return ed ? (ed.innerText || '').trim() : ''; })()`, { timeoutMs: to() }) ?? '');
				} catch (error) {
					return { ok: false, code: 'SEND_UNKNOWN', error: `点了发送，但读不回回复框：${errText(error)}` };
				}
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
	constructor({ host, driver, notify, cardDir, stickers, embedder, workspacePath, canvasConvert, ...deps }) {
		super({ pollMs: 20 * 60_000, replyGapMs: 30_000, ...deps, platform: 'douyin', label: '抖音' });
		this.host = host;
		this.driver = driver ?? douyinSocialDriver(host);
		this.notify = notify ?? (() => {});
		this.cardDir = cardDir ?? join(fishSoulDir(), 'douyin-cards');
		this.postNoun = '图文';
		this.postJobs = this.db ? new DouyinPostJobs(this.db) : null;
		this.blockedUntil = 0;
		// 图片评论：她自己 _stickers 库里的表情包（模型挑哪张）。
		// 可能传函数（惰性 —— index.js 里 StickerBox 在后面才 new），第一次用再解。
		this._stickersBox = stickers ?? null;
		this.embedder = embedder ?? null;
		this.workspacePath = typeof workspacePath === 'function' ? workspacePath : () => String(workspacePath ?? '');
		this.canvasConvert = canvasConvert ?? null;
	}

	/** 表情包库（惰性解一次）。 */
	get stickers() {
		if (typeof this._stickersBox === 'function') {
			const box = this._stickersBox();
			this._stickersBox = box ?? null;
		}
		return this._stickersBox ?? null;
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
		return '你写的话会印在一张纯色文字卡片上，同时当作品描述。像真人随手发的那种：短、碎、口语，一般 10～60 字，可以分两三行。偶尔（不是每条）可以带个轻量的钩子：一个小问句、一句此刻的小感受，像跟朋友聊天，别硬凑，也别每条都来。不要"记录生活"这种四字口号，不要文艺腔。';
	}

	whoIs(it, master) {
		return '（身份未验证）'; // 评论昵称不能作为身份凭据
	}

	/**
	 * 碰到验证：停一段时间，提醒主人一次。
	 *
	 * 「每次都要手机号验证」的反馈（2026-11-08）：固定停 6 小时 → 停完再试 → 又被验证 → 又停 6 小时，
	 * 一直循环。所以改成**按连续次数指数退避**：6 小时 → 12 → 24 → 48 小时（封顶 3 天），
	 * 验证成功一次就把计数清零。这样平台一直不放行时，我们不会隔几小时去撞一次墙。
	 */
	blocked(what) {
		const prev = Number(getKv(this.db, 'douyin.verify.count', 0)) || 0;
		const n = prev + 1;
		setKv(this.db, 'douyin.verify.count', n);
		const hours = Math.min(72, VERIFY_BACKOFF_MS / HOUR_MS * (2 ** (n - 1)));
		this.blockedUntil = Date.now() + hours * HOUR_MS;
		const hoursLeft = Math.round(hours);
		this.notify('douyin.verify', `抖音${what}前又要验证（短信 / 滑块）——这是第 ${n} 次了，已停 ${hoursLeft} 小时再试；` +
			`想现在就发，去设置页「抖音」里点「显示一下」打开浏览器验证一次，验证过了计数会清零`);
	}

	/** 验证过了（这次没被拦）：把连续计数清零，下次按 6 小时起算。 */
	verifyCleared() {
		if (Number(getKv(this.db, 'douyin.verify.count', 0)) === 0) return;
		setKv(this.db, 'douyin.verify.count', 0);
	}

	postBlockReason() { return !this.postJobs ? '发布记录不可用，停止发布' : this.postJobs.pending() ? '有作品提交结果未知，请先去创作者中心核实' : ''; }
	beginPost(text, date) { return this.postJobs.begin(text, date); }
	confirmPost(id) { this.postJobs.confirm(id); }
	failPost(id, error) { this.postJobs.fail(id, error); }
	resolvePost(id, outcome) {
		const pending = this.postJobs?.pending();
		if (!pending || pending.status !== 'unknown' || pending.id !== Number(id)) return { ok: false, error: '没有这条待核实作品' };
		if (outcome === 'not_published') return { ok: this.postJobs.resolveNotPublished(pending.id) };
		if (outcome !== 'published') return { ok: false, error: '请选择已发布或未发布' };
		const now = this.clock.now();
		this.db.exec('BEGIN');
		try {
			if (!this.postJobs.resolvePublished(pending.id)) throw Error('状态已经变化');
			this.db.prepare("INSERT INTO social_post(platform,post_id,content,created_at,created_real_at) VALUES('douyin','',?,?,?)").run(pending.text, now, Date.now());
			// 旧日任务不覆盖今天的额度；历史发布日期无法准确推断。
			if (pending.role_date === this.clock.getRoleDateParts().dateStr) {
				const st = this.postState(pending.role_date);
				setKv(this.db, 'douyin.post.day', { ...st, count: st.count + 1, lastVirtual: now });
			}
			this.db.exec('COMMIT');
		} catch (error) { this.db.exec('ROLLBACK'); throw error; }
		return { ok: true };
	}

	async publish(text, jobId) {
		const parts = this.clock.getRoleDateParts();
		// 心情只管卡片配色：挑不出来就随机一个
		let theme = Math.floor(this.random() * 5);
		try {
			const raw = String((await this.callLlm(`给这条抖音图文配个「心情」。\n\n图文正文：\n${text}\n\n心情只能是这 5 个之一：${MOOD_LIST}。\n只输出一行 JSON：{"mood":"warm|blue|dream|fresh|pink","reason":"一句话为什么"}`)) ?? '').trim();
			theme = pickMoodTheme(raw, this.random).theme;
		} catch { /* 挑不出来就算了 */ }
		const png = await this.host.exclusive('画卡片', () => this.driver.renderCard(text, parts.dateStr.replace(/-/g, '.'), theme), { maxMs: 30_000 });
		if (!png) throw new Error('卡片没画出来');
		mkdirSync(this.cardDir, { recursive: true });
		const file = join(this.cardDir, `card-${Date.now()}.png`);
		writeFileSync(file, png);
		// 传图 → 抓推荐歌 → 挑歌 → 配 BGM → 发布：整段在浏览器锁里连着做完（页面不能被别的事换掉）
		let song = '';
		const r = await this.host.exclusive('发抖音图文', async () => {
			const pre = await this.driver.prepareNote({ title: noteTitle(text), text, file });
			if (!pre?.ok) return pre;
			try {
				const list = await this.driver.listRecommendedMusic();
				if (!list?.ok) return { ok: false, error: `配乐失败，未发布：${list?.error ?? '无法读取推荐歌曲'}` };
				const choice = await this.chooseMusic(text, list.songs, list.counts);
				song = choice.song;
				if (!song) return { ok: false, error: '配乐失败，未发布：模型没有选出推荐歌曲' };
				this.postJobs.prepared(jobId, file, song);
				return await this.driver.publishNote({ music: song, allowDuplicate: choice.duplicate, beforeSubmit: () => this.postJobs.submitting(jobId) });
			} finally {
				// 自定义 driver（testHooks.douyinSocial）可能没这个方法；它挂在 finally 里，
				// 抛出去会盖掉真正的失败原因。
				try { await this.driver.closeMusicPanel?.(); } catch { /* 关不掉就算了 */ }
			}
		}, { maxMs: 5 * 60_000 });
		if (r?.code === 'NEEDS_VERIFY') this.blocked('发作品');
		if (r?.code === 'NOT_LOGGED_IN') this.notify('douyin.creator', '想在抖音发图文，但创作者中心没登录：在抖音浏览器里打开 creator.douyin.com 登录一次就好');
		if (!r?.ok) throw new Error(r?.error ?? '没发出去');
		this.verifyCleared(); // 这次没被拦：验证计数清零
		this.note('post', { title: this.label, reason: `已确认配乐《${song}》` });
		this.notify('douyin.creator', null);
		return '';
	}

	/** 从抖音推荐的歌里挑一首。挑不出来 song 为空。duplicate 表示这个名字在推荐里不止一张卡。 */
	async chooseMusic(text, songs, counts = null) {
		const names = (Array.isArray(songs) ? songs : []).map((s) => String(s ?? '').trim()).filter(Boolean);
		const list = [...new Set(names)].slice(0, 10);
		if (!list.length) return { song: '', duplicate: false };
		try {
			const raw = String((await this.callLlm(`给这条抖音图文配背景音乐。从下面这些抖音推荐歌里挑一首最适合的（歌名原样照抄），不适合就回空串。\n\n图文正文：\n${text}\n\n推荐歌：\n${list.map((s) => `- ${s}`).join('\n')}\n\n只输出歌名，不要别的。`)) ?? '').trim();
			const song = pickRecommendedSong(raw, list);
			const n = counts && typeof counts === 'object' ? Number(counts[song]) || 0 : names.filter((s) => s === song).length;
			return { song, duplicate: song !== '' && n > 1 };
		} catch { throw new Error('配乐失败，未发布：模型选歌调用出错'); }
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
				// 评论列表：DOM 版仍是主来源（页面上能看见但接口没收录的，接口版会漏）；
				// 接口版只用来**补 cid** —— DOM 版拿不到评论 id，回评论要靠它。
				// 图片评论清单：她自己 _stickers 库里的表情包（文件名带标签；只列文件还在的）
				if (this.stickers && !this.imageHint) {
					try {
						const manifest = (this.stickers.list(this.workspacePath()) ?? [])
							.filter((x) => x.exists !== false)
							.map((x) => ({ file: x.file, tags: Array.isArray(x.tags) ? x.tags : [] }));
						if (manifest.length) this.imageHint = manifest.slice(0, 40).map((x) => x.tags.length ? `${x.file}（${x.tags.join('、')}）` : x.file).join('、');
					} catch { /* 拿不到清单就不给提示 */ }
				}
				// 表情码清单（开了才拉，提示词里告诉她能写哪些码）
				if (c.comments.emoji === true && !this.emojiHint) {
					const codes = await this.driver.emojiCodes().catch(() => []);
					if (codes.length) this.emojiHint = codes.slice(0, 60).join(' ');
				}
				const comments = await this.host.exclusive('看作品评论', async () => {
					const o = await this.driver.openWork(w);
					if (!o.ok) return [];
					const dom = await this.driver.listComments();
					const viaApi = typeof this.driver.listCommentsApi === 'function'
						? await this.driver.listCommentsApi(w.id).catch(() => [])
						: [];
					if (!dom.length && viaApi.length) return viaApi;
					if (viaApi.length) {
						const byText = new Map(viaApi.map((c) => [`${c.author}|${c.content}`, c.cid]));
						for (const c of dom) {
							if (!c.cid) c.cid = byText.get(`${c.author}|${c.content}`) ?? '';
						}
					}
					return dom;
				}, { maxMs: 90_000 });
				for (const cm of comments) {
					if (!cm.author || !cm.content) continue;
					const cid = String(cm.cid ?? '').trim();
					const it = { id: commentId(w.id, cid, cm.author, cm.content), mid: '', name: cm.author, title: w.title, content: cm.content, where: w.kind === 'note' ? '图文' : '视频', author: cm.author };
					// ⚠️ 兼容旧记录：库里存的都是文本 key（作品+作者+原文的哈希）。
					//    只查新 key 会把**已经回过**的评论当成新评论再回一遍 —— 双查，
					//    新 key 或旧文本 key 命中任一个都算已处理（record 只写新 id）。
					const legacyId = cid !== '' ? commentKey(w.id, cm.author, cm.content) : '';
					if (this.handled(it.id) || (legacyId !== '' && this.handled(legacyId))) continue;
					if (!seeded) { this.record(it, 'backlog'); continue; } // 第一次：只记下来，不回旧的
					if (cm.isAuthor) { this.record(it, 'skipped'); continue; }
					if (!cm.canReply) continue;
					if (this.repliedLastHour() >= c.comments.perHour) break outer;
					const raw = String((await this.callLlm(this.replyPrompt(it, c.master))) ?? '').trim();
					if (/[不回]/.test(raw)) { this.record(it, 'skipped'); skipped++; continue; }
					// 图片评论：`![得意](_stickers/得意猫.png)` → 读文件 → 带图发（一条最多 1 张）
					const withImg = await this.replyImages(raw);
					const text = cleanSocialText(withImg.text, 100);
					if (text === '' && withImg.images.length === 0) {
						if (raw === '') break outer;
						this.record(it, 'skipped');
						skipped++;
						this.note('comment', { title: this.label, reason: `${oneLine(it.name, 16)} 在评论区说了句话，没回`, text: oneLine(it.content, 60) });
						continue;
					}
					const wait = this.replyGapMs - (Date.now() - this.lastReplyRealMs);
					if (wait > 0) await sleep(wait);
					// ⚠️ mayHaveSent：写操作**可能已经发出去了**（或者正在发出去的半路上）。
					//    exclusive 超时（请求挂住 / CDP 卡住）时，异常从回调里冒出来，
					//    这时我们不知道评论到底发出去了没有 —— 发出去的就记 failed（下一轮不再发），
					//    **压根没发出去的一条都不记**（还能回，别把这条评论白白丢掉）。
					//    两条写路径的标记时机不一样：
					//    · 接口路径：真正 callBridge(postComment) 之前才标记 ——
					//      本地校验 / 前置阶段没过 = 压根没发出去（还能退回 DOM），不能标；
					//    · DOM 路径：**进写路径就标记** —— 点回复 / 找输入框 / 插字这些步骤卡住时，
					//      exclusive 超时只把错误交给调用方，回调还在锁里接着跑，
					//      它可能随后自己点下「发送」把评论发出去。
					//      这时候不提前标记，下一轮就会再发一遍 = 重复公开评论。
					let mayHaveSent = false;
					// ⚠️ writeAbandoned：外层**已经放弃**了（exclusive 超时 → 错误抛给调用方，
					//    回调还在锁里接着跑）。放弃之后回调再走到「真要写出去」那一刻，
					//    外层已经没人接结果了 —— 那一刻就地补记 failed，
					//    否则数据库里一条记录都没有，下一轮会把同一条评论再发一遍（重复公开评论）。
					let writeAbandoned = false;
					const markSent = () => {
						mayHaveSent = true;
						if (writeAbandoned) this.record(it, 'failed', text);
					};
					let r;
					try {
						r = await this.host.exclusive('回抖音评论', async () => {
							// 有 cid 就走接口（稳、不依赖页面结构）；没有（DOM 版列表）才走点击
							if (cm.cid) {
								const x = await this.driver.replyApi({ awemeId: w.id, cid: cm.cid, text, images: withImg.images }, { onBeforeWrite: markSent });
								if (x?.ok) return x;
								// ⚠️ 结果不明 = 可能已经发出去了 —— 再退回 DOM 点一次就是重复评论，比不回严重得多
								if (x?.writeState === WRITE_ATTEMPTED_UNKNOWN) {
									this.log('warn', `[fish-soul] 抖音评论接口结果不明，不再重复发：${x?.error ?? ''}`);
									return { ok: false, code: 'WRITE_UNKNOWN', error: `接口结果不明，可能已经发出去了：${x?.error ?? ''}`.slice(0, 120) };
								}
								// 接口失败退回点击（老路），但**不重试接口** —— 重试就是重复发
								this.log('warn', `[fish-soul] 抖音评论接口失败，退回点击：${x?.error ?? ''}`);
							}
							// ⚠️ DOM 路径保守标记：进写路径就算「可能已经发出去了」（见上）
							markSent();
							let x = await this.driver.reply(cm, text);
							if (x?.code === 'NOT_FOUND' && (await this.driver.openWork(w)).ok) x = await this.driver.reply(cm, text); // 页面被别的事换掉了：重开一次
							return x;
						}, { maxMs: 90_000 });
					} catch (error) {
						// 外层放弃：回调后面再走到写出去那一刻，就地补记 failed（见 writeAbandoned）
						writeAbandoned = true;
						// 写操作可能已经发出去了（超时 / 断连）→ 记成 failed，下一轮不再发这条
						if (mayHaveSent) this.record(it, 'failed', text);
						throw error;
					}
					this.lastReplyRealMs = Date.now();
					if (r?.ok) {
						this.verifyCleared(); // 这次没被拦：验证计数清零
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

	/**
	 * 图片评论：从回复文本里解析 `![说明](_stickers/文件)`，读文件 → 带图发。
	 *
	 * 模型挑图的语法和 QQ / B站 私信一致（`![得意](_stickers/得意猫.png)`），
	 * 也支持按感觉挑（`![得意](_stickers/@得意)`，先换成库里最像的那张）。
	 * 一次最多 1 张（抖音图片评论一条一张）。
	 *
	 * 路径不可信：只收工作区 `_stickers/` 里的真图（越界 / 目录 / 非图片 / 超 10MB 一律不发）。
	 *
	 * @returns {Promise<{text: string, images: Array<{bytes: Buffer, format: string}>}>}
	 */
	async replyImages(raw) {
		const out = { text: String(raw ?? ''), images: [] };
		if (!this.stickers) return out;
		// 按感觉挑：`_stickers/@得意` → 库里最像的那张真文件名（失败原样走，@ 那段会被丢掉）
		if (out.text.includes('_stickers/@')) {
			try {
				const r = await this.stickers.resolveFeelRefs(out.text, this.workspacePath(), this.embedder, {}) ?? { text: out.text, resolved: [] };
				out.text = r.text;
			} catch { /* 没配嵌入模型 / 算失败：原样走，@ 那段发不出去就当没写 */ }
		}
		const picked = 抠正文图(out.text);
		out.text = picked.净文字;
		const ws = String(this.workspacePath() ?? '').trim();
		if (ws === '') return out; // 没有工作区 = 没有可发的图（别拿进程当前目录顶）
		const root = join(ws, '_stickers');
		for (const img of picked.图.slice(0, 1)) {
			if (img.kind !== 'path') continue;
			const rel = String(img.value).replace(/^\.\//, '');
			if (!rel.startsWith('_stickers/')) continue;
			const file = safeStickerImagePath(rel, root, (...args) => this.log(...args));
			if (!file) continue;
			let bytes = null;
			try { bytes = readFileSync(file); } catch { continue; }
			// ⚠️ 不转格式 —— 实测（2026-11-08）png / jpg / gif / webp 都能直接发：
			//    ImageX 照收，返回的 format 就是它认的格式，抖音服务端也照渲染。
			//    以前那版把 webp 转 png、还跳过 gif —— 两个都是错判：
			//    · 「抖音不收 gif」是看评论框 accept 属性猜的，那是**文件选择器的 UI 过滤**，
			//      走 API 绕开它，gif 照样能发；
			//    · webp 转 png 白费一道，还依赖抖音浏览器开着（canvas 在浏览器里）。
			out.images.push({ bytes, format: '' });
		}
		return out;
	}

	status() {
		return { ...super.status(), postPending: this.postJobs?.pending() ?? null, blockedUntil: this.blockedUntil > Date.now() ? this.blockedUntil : 0 };
	}
}
