/**
 * bilibili.js —— B站网页接口客户端（扫码 / Cookie 登录、刷视频、私信收发）与私信轮询渠道。
 *
 * 接口与签名参照 bilibili-API-collect（WBI 签名、web_im 私信、svr_sync 消息记录）。
 *  - 登录凭据只存在 $DSH_HOME/fish-soul/bili-auth.json（0600），不进设置文件、不回传前端；
 *  - 私信没有推送：照网页端的节奏轮询 new_sessions（默认 20 秒），按每个会话的 msg_seqno 游标取新消息；
 *  - msg_key 等大整数在 JSON.parse 前转成字符串，避免精度丢失。
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fishSoulDir, getKv, setKv } from '../db.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MIXIN_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
	33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
	61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
	36, 20, 34, 44, 52
];
const COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', 'b_nut'];
const WBI_TTL_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** 真人发的私信来源（iOS / Android / H5 / PC / Web / 未知）；推送、自动回复、系统提示一律不当消息。 */
const HUMAN_SOURCES = new Set([0, 1, 2, 3, 4, 7]);
const RELATION_TTL_MS = 10 * 60_000;
const NAME_TTL_MS = 24 * 3600_000;
const SEND_GAP_MS = 1200;
const SPI_PATH = '/x/frontend/finger/spi';
const BUVID_RETRY_MS = 60_000;

export const BILI_HOSTS = {
	api: 'https://api.bilibili.com',
	vc: 'https://api.vc.bilibili.com',
	passport: 'https://passport.bilibili.com'
};

export function mixinKey(imgKey, subKey) {
	const orig = `${imgKey}${subKey}`;
	return MIXIN_TAB.map((n) => orig[n]).join('').slice(0, 32);
}

/** WBI 签名：返回带 wts / w_rid 的查询串。 */
export function wbiSign(params, key, wts = Math.round(Date.now() / 1000)) {
	const all = { ...params, wts };
	const query = Object.keys(all).sort().map((k) =>
		`${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`).join('&');
	return `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`;
}

/** 大整数（msg_key 等）先转字符串再解析。 */
export function parseBiliJson(text) {
	return JSON.parse(String(text).replace(/("(?:msg_key|msg_seqno|talker_id|sender_uid|receiver_id|session_ts|ack_ts|top_ts)"\s*:\s*)(\d{16,})/g, '$1"$2"'));
}

const stemOf = (url) => String(url ?? '').slice(String(url).lastIndexOf('/') + 1, String(url).lastIndexOf('.'));
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

function errorOf(json, fallback) {
	return new Error(`${fallback}：${json?.code ?? '?'} ${json?.message ?? json?.msg ?? ''}`.trim());
}

/** 一条 B站私信 → 入站消息（与 QQ 的 normalizeMessageEvent 同形）。非真人消息返回 null。 */
export function normalizeBiliMessage(msg, { talkerId, nickname = '' } = {}) {
	if (!msg || String(msg.sender_uid) !== String(talkerId)) return null;
	if (Number(msg.msg_status ?? 0) !== 0) return null;
	if (msg.msg_source !== undefined && !HUMAN_SOURCES.has(Number(msg.msg_source))) return null;
	let content = {};
	try { content = typeof msg.content === 'string' ? JSON.parse(msg.content) : (msg.content ?? {}); } catch { content = { content: String(msg.content ?? '') }; }
	const type = Number(msg.msg_type);
	let text = '';
	const images = [];
	const links = [];
	if (type === 1) text = String(content.content ?? '').replace(/【/g, '〔').replace(/】/g, '〕');
	else if (type === 2) { images.push({ url: content.url }); text = '【图片】'; }
	else if (type === 6) text = '【表情】';
	else if (type === 7) {
		const title = String(content.title || content.headline || '').slice(0, 60);
		text = `【分享${title ? `：${title}` : ''}】`;
		if (content.bvid) links.push(String(content.bvid));
		else if (content.url) links.push(String(content.url));
	} else return null;
	const mid = String(talkerId);
	return {
		channel: 'bili',
		chatType: 'private',
		channelId: `bili:${mid}`,
		targetId: mid,
		groupId: null,
		userId: mid,
		nickname,
		subType: '',
		messageId: String(msg.msg_seqno ?? ''),
		mentioned: true,
		replyId: null,
		text,
		images,
		links,
		timeMs: Number(msg.timestamp) > 0 ? Number(msg.timestamp) * 1000 : Date.now()
	};
}

export class BiliClient {
	/**
	 * @param {object} [opts]
	 * @param {(level: string, msg: string) => void} [opts.log]
	 * @param {typeof fetch} [opts.fetchImpl]
	 * @param {string} [opts.authPath]
	 */
	constructor({ log, fetchImpl, authPath } = {}) {
		this.log = log ?? (() => {});
		this.fetch = fetchImpl ?? ((...a) => fetch(...a));
		const mock = process.env.FISH_SOUL_BILI_MOCK;
		this.hosts = mock ? { api: mock, vc: mock, passport: mock } : { ...BILI_HOSTS };
		this.authPath = authPath ?? join(fishSoulDir(), 'bili-auth.json');
		this.auth = this.loadAuth();
		this.wbi = { key: '', at: 0 };
		this.authInvalid = false;
		this.names = new Map();
		this.buvidFailedAt = 0;
		this.buvidPending = null;
	}

	// ───────────── 凭据 ─────────────

	loadAuth() {
		try {
			if (existsSync(this.authPath)) {
				const a = JSON.parse(readFileSync(this.authPath, 'utf8'));
				return { cookies: a.cookies ?? {}, uid: String(a.uid ?? a.cookies?.DedeUserID ?? ''), uname: String(a.uname ?? ''), refreshToken: a.refreshToken ?? '', devId: a.devId ?? '', savedAt: a.savedAt ?? 0 };
			}
		} catch { /* 损坏视为未登录 */ }
		return { cookies: {}, uid: '', uname: '', refreshToken: '', devId: '', savedAt: 0 };
	}

	saveAuth() {
		mkdirSync(dirname(this.authPath), { recursive: true });
		writeFileSync(this.authPath, JSON.stringify({ ...this.auth, savedAt: Date.now() }, null, 2), { mode: 0o600 });
		try { chmodSync(this.authPath, 0o600); } catch { /* Windows 无所谓 */ }
	}

	get loggedIn() {
		const c = this.auth.cookies;
		return Boolean(c.SESSDATA && c.bili_jct && (c.DedeUserID || this.auth.uid));
	}

	get uid() {
		return String(this.auth.uid || this.auth.cookies.DedeUserID || '');
	}

	get devId() {
		if (!this.auth.devId) {
			this.auth.devId = randomUUID().toUpperCase();
			if (this.loggedIn) this.saveAuth();
		}
		return this.auth.devId;
	}

	cookieHeader() {
		return Object.entries(this.auth.cookies).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join('; ');
	}

	logout() {
		const devId = this.auth.devId;
		this.auth = { cookies: {}, uid: '', uname: '', refreshToken: '', devId, savedAt: 0 };
		this.authInvalid = false;
		this.buvidFailedAt = 0;
		try { rmSync(this.authPath, { force: true }); } catch { /* 已删 */ }
	}

	// ───────────── HTTP ─────────────

	async raw(url, { method = 'GET', body, referer = 'https://www.bilibili.com/', headers = {} } = {}) {
		const h = { 'User-Agent': UA, Referer: referer, Accept: 'application/json, text/plain, */*', ...headers };
		const cookie = this.cookieHeader();
		if (cookie !== '') h.Cookie = cookie;
		if (body !== undefined) h['Content-Type'] = 'application/x-www-form-urlencoded';
		return await this.fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	}

	/**
	 * @param {'api'|'vc'|'passport'} host
	 * @param {string} path
	 * @param {{params?: object, form?: object, wbi?: boolean, referer?: string, allowCodes?: number[]}} [opts]
	 */
	async call(host, path, { params, form, wbi = false, referer, allowCodes = [] } = {}) {
		// 没有 buvid3 的请求会被风控直接 412，先领一个设备标识（只放内存，登录时随凭据落盘）
		if (host !== 'passport' && path !== SPI_PATH && !this.auth.cookies.buvid3) await this.ensureBuvid();
		let query = '';
		if (params !== undefined) {
			query = wbi ? wbiSign(params, await this.wbiKey()) : new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
		} else if (wbi) {
			query = wbiSign({}, await this.wbiKey());
		}
		const url = `${this.hosts[host]}${path}${query ? `?${query}` : ''}`;
		const body = form === undefined ? undefined : new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString();
		const res = await this.raw(url, {
			method: form === undefined ? 'GET' : 'POST',
			body,
			referer: referer ?? (host === 'vc' ? 'https://message.bilibili.com/' : 'https://www.bilibili.com/'),
			headers: host === 'vc' ? { Origin: 'https://message.bilibili.com' } : {}
		});
		const text = await res.text();
		let json;
		try { json = parseBiliJson(text); } catch {
			throw new Error(`B站接口 ${path}：HTTP ${res.status}${res.status === 412 ? '（触发了风控，过会儿再试）' : '（返回的不是 JSON）'}`);
		}
		if (json?.code === -101 && this.loggedIn) {
			this.authInvalid = true;
			this.log('warn', '[fish-soul] B站登录已失效，需要重新扫码');
		}
		if (json?.code !== 0 && !allowCodes.includes(json?.code)) throw errorOf(json, `B站接口 ${path}`);
		return json;
	}

	async ensureBuvid() {
		if (this.auth.cookies.buvid3 || Date.now() - this.buvidFailedAt < BUVID_RETRY_MS) return;
		// 并发的几个请求共用同一次领取
		this.buvidPending ??= (async () => {
			try {
				const json = await this.call('api', SPI_PATH);
				if (!json.data?.b_3) throw new Error('没给 b_3');
				this.auth.cookies.buvid3 = String(json.data.b_3);
				this.auth.cookies.buvid4 = encodeURIComponent(String(json.data.b_4 ?? ''));
			} catch (error) {
				this.buvidFailedAt = Date.now();
				this.log('warn', `[fish-soul] 取 buvid 失败（不影响登录）：${String(error instanceof Error ? error.message : error)}`);
			} finally {
				this.buvidPending = null;
			}
		})();
		await this.buvidPending;
	}

	/** nav：登录态 + WBI 密钥。未登录时 code=-101 但 wbi_img 照给。 */
	async nav() {
		const json = await this.call('api', '/x/web-interface/nav', { allowCodes: [-101] });
		const img = json.data?.wbi_img;
		if (img?.img_url && img?.sub_url) this.wbi = { key: mixinKey(stemOf(img.img_url), stemOf(img.sub_url)), at: Date.now() };
		return json.data ?? {};
	}

	async wbiKey() {
		if (this.wbi.key !== '' && Date.now() - this.wbi.at < WBI_TTL_MS) return this.wbi.key;
		await this.nav();
		if (this.wbi.key === '') throw new Error('拿不到 B站 WBI 签名密钥');
		return this.wbi.key;
	}

	// ───────────── 登录 ─────────────

	async qrStart() {
		const json = await this.call('passport', '/x/passport-login/web/qrcode/generate');
		return { url: String(json.data?.url ?? ''), key: String(json.data?.qrcode_key ?? '') };
	}

	/** @returns {Promise<{status: 'waiting'|'scanned'|'expired'|'ok', uname?: string, uid?: string}>} */
	async qrPoll(key) {
		const url = `${this.hosts.passport}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`;
		const res = await this.raw(url, { referer: 'https://passport.bilibili.com/login' });
		const json = parseBiliJson(await res.text());
		const code = Number(json.data?.code ?? json.code);
		if (code === 86101) return { status: 'waiting' };
		if (code === 86090) return { status: 'scanned' };
		if (code === 86038) return { status: 'expired' };
		if (code !== 0) throw errorOf(json.data ?? json, '扫码登录');
		const cookies = {};
		const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
		for (const line of setCookies) {
			const [pair] = String(line).split(';');
			const eq = pair.indexOf('=');
			if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
		}
		try {
			const q = new URL(String(json.data?.url ?? '')).searchParams;
			for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5']) {
				if (!cookies[k] && q.get(k)) cookies[k] = encodeURIComponent(q.get(k));
			}
		} catch { /* url 不完整就只靠 Set-Cookie */ }
		if (!cookies.SESSDATA || !cookies.bili_jct) throw new Error('扫码成功了，但没拿到登录 Cookie');
		await this.adoptCookies(cookies, String(json.data?.refresh_token ?? ''));
		return { status: 'ok', uname: this.auth.uname, uid: this.uid };
	}

	/** 手动粘贴 Cookie 登录（"SESSDATA=…; bili_jct=…; DedeUserID=…"）。 */
	async loginWithCookie(text) {
		const cookies = {};
		for (const part of String(text ?? '').split(/;\s*/)) {
			const eq = part.indexOf('=');
			if (eq <= 0) continue;
			const k = part.slice(0, eq).trim();
			if (COOKIE_KEYS.includes(k)) cookies[k] = part.slice(eq + 1).trim();
		}
		if (!cookies.SESSDATA || !cookies.bili_jct) throw new Error('至少要有 SESSDATA 和 bili_jct');
		await this.adoptCookies(cookies, '');
		return { uname: this.auth.uname, uid: this.uid };
	}

	async adoptCookies(cookies, refreshToken) {
		const prev = this.auth;
		const prevInvalid = this.authInvalid;
		this.auth = { cookies: {}, uid: '', uname: '', refreshToken, devId: prev.devId, savedAt: 0 };
		for (const k of COOKIE_KEYS) if (cookies[k]) this.auth.cookies[k] = cookies[k];
		// 同一台设备：沿用已经领到的 buvid
		for (const k of ['buvid3', 'buvid4']) if (!this.auth.cookies[k] && prev.cookies[k]) this.auth.cookies[k] = prev.cookies[k];
		// 新凭据试失败：原来的登录原样保留（包括"是否失效"标记，不能被这次失败的尝试带坏）
		const rollback = () => { this.auth = prev; this.authInvalid = prevInvalid; };
		let nav;
		try {
			await this.ensureBuvid();
			nav = await this.nav();
		} catch (error) {
			rollback();
			throw error;
		}
		if (nav.isLogin !== true) {
			rollback();
			throw new Error('B站说这个登录无效（Cookie 过期或不完整）');
		}
		this.auth.uid = String(nav.mid ?? this.auth.cookies.DedeUserID ?? '');
		this.auth.uname = String(nav.uname ?? '');
		this.authInvalid = false;
		this.saveAuth();
	}

	/** 启动 / 设置页查看时校验一下登录态（失败不抛）。 */
	async verify() {
		if (!this.loggedIn) return false;
		try {
			const nav = await this.nav();
			this.authInvalid = nav.isLogin !== true;
			if (nav.isLogin === true && nav.uname && nav.uname !== this.auth.uname) { this.auth.uname = String(nav.uname); this.saveAuth(); }
			return nav.isLogin === true;
		} catch {
			return !this.authInvalid;
		}
	}

	// ───────────── 刷视频 ─────────────

	async recommend(ps = 10) {
		const idx = 1 + Math.floor(Math.random() * 8);
		const json = await this.call('api', '/x/web-interface/wbi/index/top/feed/rcmd', {
			wbi: true, params: { ps, fresh_type: 4, fresh_idx: idx, fresh_idx_1h: idx, brush: idx, feed_version: 'V8', web_location: 1430650 }
		});
		return (json.data?.item ?? []).filter((i) => i.goto === 'av' && i.bvid).map((i) => ({
			bvid: String(i.bvid), aid: String(i.id ?? ''), cid: String(i.cid ?? ''), title: String(i.title ?? ''),
			owner: String(i.owner?.name ?? ''), source: 'recommend'
		}));
	}

	async followingVideos() {
		if (!this.loggedIn) return [];
		const json = await this.call('api', '/x/polymer/web-dynamic/v1/feed/all', {
			params: { type: 'video', page: 1, timezone_offset: -480, features: 'itemOpusStyle' }
		});
		const out = [];
		for (const it of json.data?.items ?? []) {
			const arc = it?.modules?.module_dynamic?.major?.archive;
			if (!arc?.bvid) continue;
			out.push({ bvid: String(arc.bvid), aid: String(arc.aid ?? ''), cid: '', title: String(arc.title ?? ''), owner: String(it.modules?.module_author?.name ?? ''), source: 'following' });
		}
		return out;
	}

	async popular(ps = 10) {
		const json = await this.call('api', '/x/web-interface/popular', { params: { ps, pn: 1 } });
		return (json.data?.list ?? []).filter((i) => i.bvid).map((i) => ({
			bvid: String(i.bvid), aid: String(i.aid ?? ''), cid: String(i.cid ?? ''), title: String(i.title ?? ''), owner: String(i.owner?.name ?? ''), source: 'popular'
		}));
	}

	async view(bvid) {
		const json = await this.call('api', '/x/web-interface/view', { params: { bvid } });
		const d = json.data ?? {};
		return {
			bvid: String(d.bvid ?? bvid), aid: String(d.aid ?? ''), cid: String(d.cid ?? d.pages?.[0]?.cid ?? ''),
			title: String(d.title ?? ''), desc: String(d.desc ?? ''), tname: String(d.tname ?? ''),
			owner: String(d.owner?.name ?? ''), duration: Number(d.duration ?? 0), views: Number(d.stat?.view ?? 0)
		};
	}

	async subtitleText(bvid, cid, maxChars = 1200) {
		if (!cid) return '';
		const json = await this.call('api', '/x/player/wbi/v2', { wbi: true, params: { bvid, cid } });
		const subs = json.data?.subtitle?.subtitles ?? [];
		const pick = subs.find((s) => /^(ai-)?zh/i.test(String(s.lan ?? ''))) ?? subs[0];
		if (!pick?.subtitle_url) return '';
		const url = String(pick.subtitle_url).startsWith('//') ? `https:${pick.subtitle_url}` : String(pick.subtitle_url);
		const res = await this.raw(url);
		const body = (await res.json())?.body ?? [];
		return body.map((b) => String(b.content ?? '')).join('，').slice(0, maxChars);
	}

	async hotComments(aid, n = 3) {
		if (!aid) return [];
		const json = await this.call('api', '/x/v2/reply/wbi/main', { wbi: true, params: { type: 1, oid: aid, mode: 3, ps: 5 } });
		return (json.data?.replies ?? []).map((r) => String(r?.content?.message ?? '').replace(/\s+/g, ' ').slice(0, 80)).filter(Boolean).slice(0, n);
	}

	async like(aid) {
		await this.call('api', '/x/web-interface/archive/like', { form: { aid, like: 1, csrf: this.auth.cookies.bili_jct ?? '' } });
	}

	/** b23.tv 短链 → BV 号（拿不到返回 ''）。 */
	async resolveShort(url) {
		try {
			const res = await this.fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
			const loc = res.headers.get('location') ?? '';
			return (loc.match(/BV[0-9A-Za-z]{10}/) ?? [''])[0];
		} catch {
			return '';
		}
	}

	// ───────────── 私信 ─────────────

	async newSessions(beginTsUs) {
		const json = await this.call('vc', '/session_svr/v1/session_svr/new_sessions', { params: { begin_ts: beginTsUs, build: 0, mobi_app: 'web' } });
		return json.data?.session_list ?? [];
	}

	async fetchMessages(talkerId, beginSeqno, size = 20) {
		const json = await this.call('vc', '/svr_sync/v1/svr_sync/fetch_session_msgs', {
			params: { talker_id: talkerId, session_type: 1, size, begin_seqno: beginSeqno, build: 0, mobi_app: 'web' }
		});
		return json.data?.messages ?? [];
	}

	async updateAck(talkerId, seqno) {
		const csrf = this.auth.cookies.bili_jct ?? '';
		await this.call('vc', '/session_svr/v1/session_svr/update_ack', {
			form: { talker_id: talkerId, session_type: 1, ack_seqno: seqno, csrf_token: csrf, csrf, build: 0, mobi_app: 'web' }
		});
	}

	async sendText(receiverId, text) {
		const csrf = this.auth.cookies.bili_jct ?? '';
		const devId = this.devId;
		const json = await this.call('vc', '/web_im/v1/web_im/send_msg', {
			wbi: true,
			params: { w_sender_uid: this.uid, w_receiver_id: receiverId, w_dev_id: devId },
			form: {
				'msg[sender_uid]': this.uid,
				'msg[receiver_id]': receiverId,
				'msg[receiver_type]': 1,
				'msg[msg_type]': 1,
				'msg[msg_status]': 0,
				'msg[dev_id]': devId,
				'msg[timestamp]': Math.floor(Date.now() / 1000),
				'msg[new_face_version]': 1,
				'msg[content]': JSON.stringify({ content: text }),
				csrf_token: csrf,
				csrf,
				build: 0,
				mobi_app: 'web'
			}
		});
		return String(json.data?.msg_key ?? '');
	}

	/** 我和对方的关注关系。 */
	async relation(mid) {
		const json = await this.call('api', '/x/web-interface/relation', { params: { mid } });
		const rel = Number(json.data?.relation?.attribute ?? 0);
		const be = Number(json.data?.be_relation?.attribute ?? 0);
		const following = rel === 2 || rel === 6;
		const followedBy = be === 2 || be === 6;
		return { following, followedBy, mutual: rel === 6 || (following && followedBy) };
	}

	async userName(mid) {
		const hit = this.names.get(String(mid));
		if (hit !== undefined && Date.now() - hit.at < NAME_TTL_MS) return hit.name;
		let name = '';
		try {
			const json = await this.call('api', '/x/web-interface/card', { params: { mid } });
			name = String(json.data?.card?.name ?? '');
		} catch { /* 取不到就用 UID */ }
		this.names.set(String(mid), { name, at: Date.now() });
		return name;
	}
}

/**
 * 私信轮询渠道。onMessage(m) 收到的是归一化后的入站消息，回不回由网关决定。
 */
export class BiliChannel {
	constructor({ client, db, getConfig, log, onMessage }) {
		this.client = client;
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.onMessage = onMessage;
		this.timer = null;
		this.running = false;
		this.gen = 0;
		this.polling = false;
		this.lastPollAt = 0;
		this.lastError = '';
		this.relations = new Map();
		this.sendChain = Promise.resolve();
		this.lastSendAt = 0;
	}

	cfg() {
		const b = this.getConfig() ?? {};
		const poll = Number(b.pollSeconds);
		return { enabled: b.enabled === true, pollSeconds: Number.isFinite(poll) ? Math.min(300, Math.max(10, poll)) : 20 };
	}

	get connected() {
		return this.running && this.client.loggedIn && !this.client.authInvalid;
	}

	status() {
		return {
			running: this.running,
			loggedIn: this.client.loggedIn,
			authInvalid: this.client.authInvalid,
			uid: this.client.uid,
			uname: this.client.auth.uname,
			lastPollAt: this.lastPollAt,
			lastError: this.lastError
		};
	}

	start() {
		if (this.running) return;
		this.running = true;
		// 代号：restart 时还在途的旧一轮轮询醒来后不再续定时器，避免两条轮询链并行
		const gen = ++this.gen;
		void this.client.verify();
		const loop = async () => {
			if (!this.running || gen !== this.gen) return;
			await this.pollOnce().catch(() => {});
			if (!this.running || gen !== this.gen) return;
			this.timer = setTimeout(loop, this.cfg().pollSeconds * 1000);
			this.timer.unref?.();
		};
		this.timer = setTimeout(loop, 1500);
		this.timer.unref?.();
	}

	stop() {
		this.running = false;
		this.gen++;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	restart() {
		this.stop();
		if (this.cfg().enabled) this.start();
	}

	/** 轮询一次：新会话 → 每个会话按游标取新消息 → 交给网关。 */
	async pollOnce() {
		if (this.polling || !this.cfg().enabled || !this.client.loggedIn || this.client.authInvalid) return;
		this.polling = true;
		try {
			const selfUid = this.client.uid;
			const begin = Number(getKv(this.db, 'bili.sessionTs', 0)) || (Date.now() - 10 * 60_000) * 1000;
			const list = await this.client.newSessions(begin);
			let maxTs = begin;
			for (const s of [...list].reverse()) {
				const ts = Number(s.session_ts ?? 0);
				if (ts > maxTs) maxTs = ts;
				if (Number(s.session_type) !== 1 || Number(s.system_msg_type ?? 0) !== 0) continue;
				const talker = String(s.talker_id ?? '');
				if (talker === '' || talker === selfUid) continue;
				const key = `bili.cursor.${talker}`;
				let cursor = Number(getKv(this.db, key, null) ?? s.ack_seqno ?? 0) || 0;
				const lastSeq = Number(s.last_msg?.msg_seqno ?? s.max_seqno ?? Infinity);
				if (lastSeq <= cursor) continue;
				const msgs = await this.client.fetchMessages(talker, cursor, 20);
				const fresh = msgs.filter((m) => Number(m.msg_seqno) > cursor).sort((a, b) => Number(a.msg_seqno) - Number(b.msg_seqno));
				let nickname = '';
				for (const m of fresh) {
					cursor = Math.max(cursor, Number(m.msg_seqno));
					if (String(m.sender_uid) !== talker) continue;
					if (nickname === '') nickname = await this.client.userName(talker);
					const norm = normalizeBiliMessage(m, { talkerId: talker, nickname });
					if (norm === null) continue;
					try { await this.onMessage(norm); } catch (error) {
						this.log('error', `[fish-soul] B站私信处理失败：${String(error instanceof Error ? error.message : error)}`);
					}
				}
				setKv(this.db, key, cursor);
			}
			setKv(this.db, 'bili.sessionTs', maxTs);
			this.lastPollAt = Date.now();
			this.lastError = '';
		} catch (error) {
			this.lastError = String(error instanceof Error ? error.message : error);
		} finally {
			this.polling = false;
		}
	}

	/** 已读回执（自动回复打开时才发：只读阶段保留未读，方便你在 App 里看）。 */
	async ack(mid, seqno) {
		try { await this.client.updateAck(mid, seqno); } catch { /* 无所谓 */ }
	}

	async isMutual(mid) {
		const hit = this.relations.get(String(mid));
		if (hit !== undefined && Date.now() - hit.at < RELATION_TTL_MS) return hit.mutual;
		let mutual = false;
		try { mutual = (await this.client.relation(mid)).mutual; } catch { mutual = hit?.mutual ?? false; }
		this.relations.set(String(mid), { mutual, at: Date.now() });
		return mutual;
	}

	/** 串行发送，两条之间至少隔 1.2 秒。 */
	send(mid, text) {
		const run = async () => {
			const wait = SEND_GAP_MS - (Date.now() - this.lastSendAt);
			if (wait > 0) await sleep(wait + Math.floor(Math.random() * 600));
			try {
				return await this.client.sendText(mid, text);
			} finally {
				this.lastSendAt = Date.now();
			}
		};
		const p = this.sendChain.then(run, run);
		this.sendChain = p.catch(() => {});
		return p;
	}
}
