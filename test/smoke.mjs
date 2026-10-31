// 本地冒烟测试：模拟 DSH 宿主 ctx，验证会话隔离、零滞后召回、配置合并、导入、待办队列、向量索引。
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash, generateKeyPairSync, privateDecrypt, constants as cryptoConstants } from 'node:crypto';

const home = mkdtempSync(join(tmpdir(), 'dsh-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'fish-soul'), { recursive: true });

// ── 假 embedding 服务（按字符哈希出 8 维向量）──
let embedCalls = 0; let failNext = 0; let dimOut = 8;
const srv = http.createServer((req, res) => {
	let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
		embedCalls++;
		if (failNext > 0) { failNext--; res.writeHead(500); return res.end(); }
		const { input } = JSON.parse(b);
		const data = input.map((t, index) => {
			const v = new Array(dimOut).fill(0); for (const ch of t) v[ch.charCodeAt(0) % dimOut] += 1;
			return { index, embedding: v };
		});
		res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data }));
	});
});
await new Promise((r) => srv.listen(0, r));
const baseURL = `http://127.0.0.1:${srv.address().port}`;

// ── 假 SnowLuma（OneBot 11 正向 WS，最小 RFC6455 实现）──
const ob = { conns: [], sends: [], calls: [], tokenSeen: null };
function wsSend(socket, obj) {
	const data = Buffer.from(JSON.stringify(obj));
	let header;
	if (data.length < 126) header = Buffer.from([0x81, data.length]);
	else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
	else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
	socket.write(Buffer.concat([header, data]));
}
const wsSrv = http.createServer();
wsSrv.on('upgrade', (req, socket) => {
	ob.tokenSeen = new URL(req.url, 'http://x').searchParams.get('access_token');
	const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	const conn = { push: (ev) => wsSend(socket, { self_id: 1000, time: Math.floor(Date.now() / 1000), ...ev }) };
	ob.conns.push(conn);
	let buf = Buffer.alloc(0);
	socket.on('data', (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 2) {
			const op = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
			if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
			else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
			const maskOff = off; if (buf[1] & 0x80) off += 4;
			if (buf.length < off + len) return;
			let payload = buf.subarray(off, off + len);
			if (buf[1] & 0x80) { const mask = buf.subarray(maskOff, maskOff + 4); payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4])); }
			buf = buf.subarray(off + len);
			if (op === 0x8) { socket.end(); return; }
			if (op !== 0x1) continue;
			const { action, params, echo } = JSON.parse(payload.toString('utf8'));
			ob.calls.push(action);
			let data = null;
			if (action === 'get_login_info') data = { user_id: 1000, nickname: '鱼' };
			else if (action === 'get_friend_list') data = [{ user_id: 10001 }, { user_id: 20002 }];
			else if (action === 'get_group_info') data = { group_name: '测试群' };
			else if (action === 'get_friend_msg_history' || action === 'get_group_msg_history') data = { messages: [] };
			else if (action === 'send_private_msg' || action === 'send_group_msg') { ob.sends.push({ action, params }); data = { message_id: 9000 + ob.sends.length }; }
			else { wsSend(socket, { status: 'failed', retcode: 1404, echo }); continue; }
			wsSend(socket, { status: 'ok', retcode: 0, data, echo });
		}
	});
});
await new Promise((r) => wsSrv.listen(0, r));

// ── 假 B站（api / vc / passport 共用一个 HTTP 服务；带 WBI 验签）──
const MIXIN = 'ea1db124af3c7062474693fa704f4ff8';
const bm = { sessions: new Map(), msgs: new Map(), fetches: [], sent: [], acks: [], likes: [], qrPolls: 0, badWbi: [], rcmdFail: false, extra: false, tick: 0,
	relation: { 888: 6 }, names: { 777: '主人B站', 555: '路人甲', 888: '阿二B站' }, uploads: [], renew: [], needRefresh: false, token: '' };
// Cookie 续期用的 RSA 密钥（换掉 B站的公钥，假服务器才解得开 correspondPath）
const biliKeys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
process.env.FISH_SOUL_BILI_PUBKEY = biliKeys.publicKey;
const vids = {
	BV1Ab411c7Zz: { aid: 101, cid: 1001, title: '猫咪打架实录', owner: { name: '猫UP' }, desc: '两只猫打起来了', tname: '动物圈' },
	BV1Cd411c7Yy: { aid: 102, cid: 1002, title: '无聊的会议录像', owner: { name: '某公司' }, desc: '', tname: '知识' },
	BV1Ef411c7Xx: { aid: 103, cid: 1003, title: '深夜做饭', owner: { name: '饭UP' }, desc: '一个人的晚饭', tname: '美食' },
	BV1Gh411c7Ww: { aid: 104, cid: 1004, title: '年度鬼畜', owner: { name: '鬼畜UP' }, desc: '', tname: '鬼畜' },
	BV1Jk411c7Vv: { aid: 105, cid: 1005, title: '周末去爬山', owner: { name: '山UP' }, desc: '', tname: '户外' }
};
const rcmdItem = (b) => ({ goto: 'av', bvid: b, id: vids[b].aid, cid: vids[b].cid, title: vids[b].title, owner: vids[b].owner });
/** 往某个会话里塞一条私信（sender 缺省 = 对方）。 */
function biliPush(talker, text, { sender = talker, source = 7, type = 1, content } = {}) {
	const list = bm.msgs.get(String(talker)) ?? [];
	const seq = list.length + 1;
	list.push({ sender_uid: Number(sender), receiver_type: 1, receiver_id: sender === talker ? 999 : Number(talker), msg_type: type,
		content: JSON.stringify(content ?? { content: text }), msg_seqno: seq, timestamp: Math.floor(Date.now() / 1000), msg_status: 0, msg_source: source });
	bm.msgs.set(String(talker), list);
	bm.sessions.set(String(talker), { talker_id: Number(talker), session_type: 1, system_msg_type: 0, ack_seqno: 0,
		session_ts: Date.now() * 1000 + (++bm.tick), last_msg: { msg_seqno: seq } });
}
const biliSrv = http.createServer((req, res) => {
	let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
		const u = new URL(req.url, 'http://x'); const q = u.searchParams; const form = new URLSearchParams(body);
		const cookie = req.headers.cookie ?? '';
		const json = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
		const okj = (data) => json({ code: 0, message: '0', data });
		if (q.has('w_rid')) {
			const plain = [...q].filter(([k]) => k !== 'w_rid').sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
			if (createHash('md5').update(plain + MIXIN).digest('hex') !== q.get('w_rid')) { bm.badWbi.push(u.pathname); return json({ code: -403, message: '签名错' }); }
		} else if (/\/wbi\/|send_msg/.test(u.pathname)) { bm.badWbi.push(u.pathname); return json({ code: -403, message: '缺签名' }); }
		const login = /SESSDATA=good/.test(cookie);
		const wbi_img = { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' };
		switch (u.pathname) {
			case '/x/frontend/finger/spi': return okj({ b_3: 'B3-TEST', b_4: 'B4/TEST' });
			case '/x/web-interface/nav': return login ? okj({ isLogin: true, mid: 999, uname: '鱼的小号', wbi_img }) : json({ code: -101, message: '账号未登录', data: { isLogin: false, wbi_img } });
			case '/x/passport-login/web/qrcode/generate': return okj({ url: 'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=QK1', qrcode_key: 'QK1' });
			case '/x/passport-login/web/qrcode/poll': {
				bm.qrPolls++;
				if (q.get('qrcode_key') !== 'QK1') return okj({ code: 86038, message: '二维码已失效' });
				if (bm.qrPolls === 1) return okj({ code: 86101, message: '未扫码' });
				if (bm.qrPolls === 2) return okj({ code: 86090, message: '二维码已扫码未确认' });
				res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['SESSDATA=good%2C123; Path=/; HttpOnly', 'bili_jct=jct1; Path=/', 'DedeUserID=999; Path=/'] });
				return res.end(JSON.stringify({ code: 0, data: { code: 0, url: 'https://passport.biligame.com/crossDomain?DedeUserID=999', refresh_token: 'rt1' } }));
			}
			case '/session_svr/v1/session_svr/new_sessions': {
				if (!login) return json({ code: -101, message: '账号未登录' });
				const begin = Number(q.get('begin_ts'));
				const list = [...bm.sessions.values()].filter((s) => s.session_ts > begin).sort((a, b) => b.session_ts - a.session_ts);
				// 系统通知会话 / 应援团会话：不该当私信处理
				list.push({ talker_id: 844424930131966, session_type: 1, system_msg_type: 5, ack_seqno: 0, session_ts: begin + 1, last_msg: { msg_seqno: 9 } });
				list.push({ talker_id: 123, session_type: 2, system_msg_type: 0, ack_seqno: 0, session_ts: begin + 1, last_msg: { msg_seqno: 9 } });
				return okj({ session_list: list });
			}
			case '/svr_sync/v1/svr_sync/fetch_session_msgs': {
				bm.fetches.push(q.get('talker_id'));
				const begin = Number(q.get('begin_seqno'));
				return okj({ messages: (bm.msgs.get(q.get('talker_id')) ?? []).filter((m) => m.msg_seqno > begin).reverse(), has_more: 0 });
			}
			case '/session_svr/v1/session_svr/update_ack': bm.acks.push([form.get('talker_id'), form.get('ack_seqno'), form.get('csrf')]); return okj(null);
			case '/web_im/v1/web_im/send_msg':
				bm.sent.push({ q: Object.fromEntries(q), f: Object.fromEntries(form), cookie });
				return json('{"code":0,"message":"0","data":{"msg_key":7234567890123456789,"msg_content":"x"}}');
			case '/x/web-interface/relation': { const a = bm.relation[q.get('mid')] ?? 0; return okj({ relation: { attribute: a }, be_relation: { attribute: a } }); }
			case '/x/web-interface/card': return okj({ card: { mid: q.get('mid'), name: bm.names[q.get('mid')] ?? '' } });
			case '/x/web-interface/view': { const v = vids[q.get('bvid')]; return v ? okj({ bvid: q.get('bvid'), ...v, stat: { view: 1234 }, duration: 60 }) : json({ code: -404, message: '啥都木有' }); }
			case '/x/player/wbi/v2': return okj({ subtitle: { subtitles: login && q.get('bvid') === 'BV1Ab411c7Zz' ? [{ lan: 'ai-zh', subtitle_url: `${biliURL}/sub/BV1Ab411c7Zz.json` }] : [] } });
			case '/sub/BV1Ab411c7Zz.json': return json({ body: [{ content: '大家好' }, { content: '今天两只猫打起来了' }] });
			case '/x/v2/reply/wbi/main': return okj({ replies: [{ content: { message: '橘猫赢了' } }, { content: { message: '笑死\n我了' } }] });
			case '/x/web-interface/wbi/index/top/feed/rcmd':
				if (bm.rcmdFail) return json({ code: -352, message: '风控校验失败' });
				return okj({ item: [...['BV1Ab411c7Zz', 'BV1Cd411c7Yy', 'BV1Ef411c7Xx'], ...(bm.extra ? ['BV1Jk411c7Vv'] : [])].map(rcmdItem).concat([{ goto: 'ad', bvid: '' }]) });
			case '/x/polymer/web-dynamic/v1/feed/all':
				return login ? okj({ items: [{ modules: { module_author: { name: '饭UP' }, module_dynamic: { major: { archive: { bvid: 'BV1Ef411c7Xx', aid: 103, title: '深夜做饭' } } } } }] }) : json({ code: -101, message: '账号未登录' });
			case '/x/web-interface/popular': return okj({ list: [rcmdItem('BV1Gh411c7Ww')].map((i) => ({ ...i, aid: i.id })) });
			case '/x/web-interface/archive/like': bm.likes.push(form.get('aid')); return okj(null);
			case '/x/dynamic/feed/draw/upload_bfs':
				bm.uploads.push({ csrf: /name="csrf"\r\n\r\n([^\r]*)/.exec(body)?.[1], file: /name="file_up"; filename="([^"]+)"/.exec(body)?.[1], png: body.includes('PNG'), multipart: /^multipart\/form-data; boundary=/.test(req.headers['content-type'] ?? '') });
				return okj({ image_url: 'https://i0.hdslb.com/bfs/new_dyn/fish1.png', image_width: 16, image_height: 12, img_size: 1.5 });
			case '/x/passport-login/web/cookie/info':
				bm.renew.push(['info', q.get('csrf')]);
				return login ? okj({ refresh: bm.needRefresh, timestamp: 1700000000123 }) : json({ code: -101, message: '账号未登录' });
			case '/x/passport-login/web/cookie/refresh':
				bm.renew.push(['refresh', Object.fromEntries(form)]);
				if (form.get('refresh_csrf') !== 'RCSRF1' || form.get('refresh_token') !== bm.token) return json({ code: -111, message: 'csrf 校验失败' });
				res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['SESSDATA=good%2C456; Path=/; HttpOnly', 'bili_jct=jct2; Path=/', 'DedeUserID=999; Path=/'] });
				return res.end(JSON.stringify({ code: 0, message: '0', data: { status: 0, message: '', refresh_token: 'fedcba9876543210fedcba9876543210' } }));
			case '/x/passport-login/web/confirm/refresh': bm.renew.push(['confirm', Object.fromEntries(form), cookie]); return okj(null);
			default: {
				if (u.pathname.startsWith('/correspond/1/')) {
					let plain = '';
					try { plain = privateDecrypt({ key: biliKeys.privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(u.pathname.slice('/correspond/1/'.length), 'hex')).toString(); } catch { /* 解不开 */ }
					bm.renew.push(['correspond', plain]);
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
					return res.end(/^refresh_\d{13}$/.test(plain) && /SESSDATA=good/.test(cookie) ? '<html><body><div id="1-name">RCSRF1</div></body></html>' : '<html>出错了</html>');
				}
				return json({ code: -404, message: `mock 没有 ${u.pathname}` });
			}
		}
	});
});
await new Promise((r) => biliSrv.listen(0, r));
const biliURL = `http://127.0.0.1:${biliSrv.address().port}`;
process.env.FISH_SOUL_BILI_MOCK = biliURL;

// 设置页写的文件配置（宿主 schema 默认值是空串，旧实现会把这些覆盖掉）
writeFileSync(join(home, 'fish-soul-config.json'), JSON.stringify({
	embedding: { enabled: true, baseURL, apiKey: 'sk-test', model: 'm1' },
	proactive: { targets: { masterPrivateChannelId: 'private:10001', selfGroupChannelIds: [] } },
	qq: { enabled: true, wsUrl: `ws://127.0.0.1:${wsSrv.address().port}`, accessToken: 'tok-1', batchMs: 200 },
	douyin: { batchMs: 100 }
}));

// ── PNG 角色卡（tEXt chara，带 {{char}}/{{user}} 与世界书）──
const card = { spec: 'chara_card_v2', data: { name: '小鱼', description: '{{char}} 很喜欢 {{user}}。', personality: '嘴硬',
	first_mes: '哟，{{user}}', post_history_instructions: '回复不超过两句。',
	character_book: { entries: [{ keys: ['猫'], content: '{{char}} 养了一只叫团子的猫' }, { constant: true, keys: [], content: '{{char}} 住在杭州' }] } } };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); }
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
	chunk('tEXt', Buffer.concat([Buffer.from('chara\0'), Buffer.from(Buffer.from(JSON.stringify(card)).toString('base64'))])), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(join(home, 'fish-soul', 'persona.png'), png);

// ── 假宿主 ──
const tools = {}; let section = null; let context = null; const handlers = {}; let route = null; let guard = null;
const host = { created: [], resumed: [], followups: [], restricts: [], attached: [], titles: [], live: new Map() };
function makeAgent(id) {
	return { id, session: { id }, async followup(msg) { host.followups.push({ id, msg }); } };
}
const agents = {
	async create(opts) {
		await opts.setup?.({ tools: { restrict: (f) => { host.restricts.push([opts.sessionId, f]); return () => {}; } } }, {});
		const agent = makeAgent(opts.sessionId); host.live.set(opts.sessionId, agent); host.created.push(opts);
		return { agent, dispose: async () => {} };
	},
	async resume(opts) {
		await opts.setup?.({ tools: { restrict: (f) => { host.restricts.push([opts.resumeSessionId, f]); return () => {}; } } }, {});
		const agent = makeAgent(opts.resumeSessionId); host.live.set(opts.resumeSessionId, agent); host.resumed.push(opts.resumeSessionId);
		return { agent, dispose: async () => {} };
	},
	get: (id) => host.live.get(id)
};
const workspaceRegistry = {
	create: async (path, title) => ({ path, title, attachSession: async (id) => { host.attached.push([path, id]); } }),
	list: () => [{ path: join(home, 'fish-soul', 'workspace'), title: '鱼', sessionIds: [] }, { path: join(home, 'other-ws'), title: '其他', sessionIds: [] }]
};
const services = {
	agents, workspaceRegistry,
	sessionTitle: { rename: (s, t) => host.titles.push([s.id, t]) },
	attachments: { admitPromptContent: async (parts) => parts.map((p) => (p.type === 'image' ? { type: 'image', attachment: { attachmentId: 'a1' } } : p)) }
};
const ctx = {
	logger: { info() {}, warn: (m) => process.env.DBG && console.error('  log.warn', m), error: (m) => console.error('  log.error', m) },
	effect: (fn) => fn(),
	get: (name) => services[name],
	agents, workspaceRegistry,
	tools: { register: (t) => { tools[t.name] = t; return () => {}; }, get: (n) => tools[n], guard: (g) => { guard = g; return () => {}; } },
	systemPrompt: { section: (s) => { section = s; return () => {}; }, context: (c) => { context = c; return () => {}; } },
	on: (ev, h) => { handlers[ev] = h; return () => {}; },
	webServer: { register: (r) => { route = r; return () => {}; } }
};
const mod = await import('../lib/index.js');

// ── 假抖音：专用浏览器和页面驱动都换成假的（真浏览器那部分在 test/douyin-browser.mjs）──
const { ACTIVE_VIDEO_JS } = await import('../lib/douyin-browse.js');
const dy = { convs: [], msgs: new Map(), reads: [], sent: [], loggedIn: true, canaryOk: true, canaries: 0, emojis: ['微笑', '比心'],
	launches: 0, launchOpts: null, quits: 0, feed: [], feedAt: 0, gotos: [], likes: 0, details: new Map(), clicks: [],
	win: { left: 100, top: 100, width: 1400, height: 1000, windowState: 'normal' } };
const dyBrowser = {
	sessionId: 'S1', targetId: 'T1', alive: false, onDead: null, onEvent: null,
	isAlive() { return this.alive; },
	async eval(expr) {
		if (expr === 'location.href') return 'https://www.douyin.com/';
		if (expr === ACTIVE_VIDEO_JS) { const v = dy.feed[dy.feedAt]; return v ? { ok: true, live: false, ad: false, author: '', ...v } : { ok: false }; }
		if (/video-switch-next-arrow/.test(expr)) { dy.feedAt++; return true; }
		if (/video-player-digg/.test(expr)) { dy.likes++; return true; }
		if (/createImageBitmap/.test(expr)) return png.toString('base64');
		return null;
	},
	async send(method, params) {
		if (method === 'Page.captureScreenshot') return { data: Buffer.from('fake-jpeg').toString('base64') };
		if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
		if (method === 'Input.dispatchMouseEvent') dy.clicks.push([params.type, params.x, params.y]);
		if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
		if (method === 'Browser.getWindowBounds') return { bounds: { ...dy.win } };
		if (method === 'Browser.setWindowBounds') Object.assign(dy.win, params.bounds);
		return {};
	},
	async goto(url) { dy.gotos.push(url); if (/recommend/.test(url)) dy.feedAt = 0; },
	detach() {},
	async quit() { this.alive = false; dy.quits++; }
};
/** 往抖音会话里塞一条对方发的私信（会话列表跟着变：时间、预览、未读）。 */
function dyPush(name, text, { fromMe = false, type = 'text', media } = {}) {
	const list = dy.msgs.get(name) ?? [];
	list.push({ fromMe, text, type, media, time: Date.now() + list.length });
	dy.msgs.set(name, list);
	const d = new Date();
	const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	let c = dy.convs.find((x) => x.name === name);
	if (!c) { c = { name, unread: 0 }; dy.convs.unshift(c); }
	Object.assign(c, { time, preview: `${text}#${list.length}`, unread: fromMe ? c.unread : c.unread + 1 });
}
mod.testHooks.douyin = {
	detect: async () => [{ kind: 'edge', name: 'Microsoft Edge', version: '130.0', path: '/fake/msedge.exe' }],
	launch: async (opts) => { dy.launches++; dy.launchOpts = opts; dyBrowser.alive = true; return dyBrowser; },
	driver: () => ({
		checkLogin: async () => dy.loggedIn,
		list: async () => ({ ok: true, conversations: dy.convs.map((c) => ({ ...c })) }),
		read: async (name) => {
			dy.reads.push(name);
			const c = dy.convs.find((x) => x.name === name);
			if (c) c.unread = 0;
			return { ok: true, messages: (dy.msgs.get(name) ?? []).slice(-20) };
		},
		sendText: async (name, text) => { dy.sent.push([name, 'text', text]); return { ok: true }; },
		sendImage: async (name, file) => { dy.sent.push([name, 'image', file]); return { ok: true }; },
		sendEmoji: async (name, e) => (dy.emojis.includes(e) ? (dy.sent.push([name, 'emoji', e]), { ok: true }) : { ok: false, error: '没有这个表情' }),
		canary: async () => { dy.canaries++; return dy.canaryOk ? { ok: true, broken: [] } : { ok: false, broken: ['私信列表'] }; }
	}),
	readDetail: async ({ id }) => dy.details.get(id) ?? { ok: false, error: '没有' },
	pollRangeMs: [150, 200], typingMs: [0, 0], firstPollMs: 50, dwellMs: [0, 0], settleMs: 0,
	digestEveryMs: 3_600_000 // 聊完自动记：测试里只手动触发
};
await mod.apply(ctx, { masterQqUin: '10001', embedding: { enabled: true, baseURL: '', apiKey: '', model: '' } });

// 别的插件转进普通会话的消息：payload = { agent, message }，source 里带 QQ 号
const inbox = (qq, text, group) => handlers['agent/inbox/inserted']({
	agent: { id: group ? `g${group}` : `p${qq}` },
	message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'other-plugin', userId: qq, nickname: `n${qq}`, ...(group ? { groupId: group } : {}) } }
});
const at = (id) => ({ agent: { id } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name) => console.log('✓', name);

// 1 人格
assert.match(section.text(), /小鱼 很喜欢 对方/); assert.match(section.text(), /住在杭州/); assert.doesNotMatch(section.text(), /\{\{/);
ok('PNG 角色卡：宏替换 + constant 世界书进静态段');

// 2 配置合并 + 工具 schema
assert.equal(tools.remember.parameters.additionalProperties, false);
ok('工具参数为标准 JSON Schema');

// 3 会话隔离：A 写记忆，B 在同群读不到
inbox('20002', '我下周三考高数', 777);
let r = await tools.remember.execute({ content: '下周三要考高数', kind: 'event', importance: 3 }, at('g777'));
assert.match(r, /已记住/);
inbox('30003', '高数难不难', 777);
let block = context.text(at('g777'));
assert.doesNotMatch(block.split('[本群近期]')[0], /考高数/, 'B 的相关记忆里不该出现 A 的记忆');
inbox('20002', '高数复习好难', 777);
block = context.text(at('g777'));
assert.match(block, /\[相关记忆\][\s\S]*下周三要考高数/);
ok('群聊按人隔离 + 本轮消息即时召回（无一轮滞后）');

// 4 认不出发送者不再当主人
handlers['agent/inbox/inserted']({ agent: { id: 'x1' }, message: { role: 'user', content: [{ type: 'text', text: '你还记得我吗' }], source: { kind: 'user' } } });
r = await tools.remember.execute({ content: '陌生信息', kind: 'fact' }, at('x1'));
assert.match(r, /没识别出/);
ok('未识别发送者：不读写任何人记忆');

// 5 forget 归属校验
inbox('30003', '帮我删掉那条', 777);
r = await tools.forget.execute({ id: 1 }, at('g777'));
assert.match(r, /不属于/);
ok('forget 只能删自己的');

// 6 世界书关键词
inbox('20002', '你的猫叫什么', 777);
assert.match(context.text(at('g777')), /团子/);
ok('世界书关键词条目进瞬态块');

// 7 向量：实时队列自举 vec_meta 并写入；失败重试
failNext = 1;
await sleep(5000);
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(home, 'fish-soul', 'soul.db'));
assert.equal(db.prepare('SELECT COUNT(*) n FROM vec').get().n, 1, '首次失败后应重试成功');
assert.equal(db.prepare('SELECT dim FROM vec_meta').get().dim, 8);
ok('向量：无需测试连接即自举 + 失败退避重试');

// 8 路由：同维度换模型 → stale，不覆盖 model_id
async function call(method, path, body) {
	let status = 0; let out = '';
	const req = new (await import('node:stream')).Readable({ read() { this.push(body ? JSON.stringify(body) : null); if (body) this.push(null); body = null; } });
	req.url = `/api/plugins/fish-soul${path}`; req.method = method; req.headers = {};
	const res = { writeHead: (s) => { status = s; }, end: (s) => { out = s; } };
	await route.handler(req, res); return { status, json: JSON.parse(out) };
}
let p = await call('POST', '/retrieval/probe', { model: 'm2' });
assert.equal(p.json.status, 'stale'); assert.equal(db.prepare('SELECT model_id FROM vec_meta').get().model_id, 'm1');
ok('同维度换模型：标 stale，不污染索引');

// 9 导入
p = await call('POST', '/import/memories', { items: [{ qqUin: '10001', content: '主人喜欢喝冰美式', createdAt: '2026-01-02' }, { qqUin: '10001', content: '主人喜欢喝冰美式' }, { content: '无主' }] });
assert.deepEqual([p.json.inserted, p.json.duplicates, p.json.skipped], [1, 1, 1]);
inbox('10001', '我想喝冰美式', null);
assert.match(context.text(at('p10001')), /冰美式/);
ok('记忆导入：去重 + 归属到主人 + 可召回');

// 10 待办队列：非白名单不卡住白名单
db.prepare("INSERT INTO pending (owner_id, channel, channel_id, due_at, reason, created_at) VALUES ('user:x','qq-private','private:999',1,'stranger',1)").run();
db.prepare("INSERT INTO pending (owner_id, channel, channel_id, due_at, reason, created_at) VALUES ('user:master','qq-private','private:10001',2,'master reminder',2)").run();
const { LifeEngine } = await import('../lib/life.js');
const { VirtualClock } = await import('../lib/clock.js');
const sent = [];
const clock = new VirtualClock(1, Date.parse('2026-11-01T04:00:00Z')); // 12:00 UTC+8
const life = new LifeEngine({ db, clock, getConfig: () => ({ proactive: { targets: { masterPrivateChannelId: 'private:10001', selfGroupChannelIds: [] } } }), callLlm: async () => null, deliver: async (c, t) => { sent.push([c, t]); return true; } });
await life.tick();
assert.deepEqual(sent[0], ['private:10001', 'master reminder']);
ok('主动消息：非白名单待办不再阻塞队列');

// 11 重建：失败不推进游标，最终全量覆盖
failNext = 1;
p = await call('POST', '/retrieval/rebuild', { action: 'start' });
assert.equal(p.json.ok, true);
let st;
for (let i = 0; i < 40; i++) {
	await sleep(1000);
	st = await call('GET', '/retrieval/state');
	if (st.json.vecMeta.status === 'ready') break;
}
assert.equal(st.json.vecMeta.status, 'ready');
assert.equal(st.json.coverage.vectorizedCount, st.json.coverage.totalActiveCount);
ok('重建：失败重试同一批，完成后无空洞');

// ───────────── v0.3：SnowLuma 直连 + 会话网关 ─────────────
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(50); } return fn(); };
const conn = await waitFor(() => ob.conns[0]);
assert.ok(conn, '应连上假 SnowLuma');
assert.equal(ob.tokenSeen, 'tok-1');
await waitFor(() => ob.calls.includes('get_friend_list'));
ok('WS 直连：带 access_token，连上后取登录号和好友列表');

// 12 好友私聊 → 自动建会话（专用工作区 + 只给记忆工具）→ 回复发回 QQ（贴纸变真图）
const wsDir = join(home, 'fish-soul', 'workspace');
mkdirSync(join(wsDir, '_stickers'), { recursive: true });
writeFileSync(join(wsDir, '_stickers', 'ok.png'), png);
// 1×1 的 webp（无损）：B站 / 抖音发之前要转成 png
const webp1 = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
writeFileSync(join(wsDir, '_stickers', 'wow.webp'), webp1);
// 后面"一键迁移"会把专用工作区换到 other-ws：那边也放一份
mkdirSync(join(home, 'other-ws', '_stickers'), { recursive: true });
writeFileSync(join(home, 'other-ws', '_stickers', 'ok.png'), png);
writeFileSync(join(home, 'other-ws', '_stickers', 'wow.webp'), webp1);
writeFileSync(join(home, 'secret.png'), png);
const nowSec = () => Math.floor(Date.now() / 1000);
conn.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001, message_id: 501, sender: { nickname: '主人' }, message: [{ type: 'text', data: { text: '我想喝冰美式' } }] });
const f1 = await waitFor(() => host.followups[0]);
assert.ok(f1, '好友私聊应转进会话');
const sid1 = f1.id;
assert.equal(host.created[0].meta.cwd, wsDir);
assert.deepEqual(host.restricts[0][1], { allow: ['remember', 'recall', 'forget', 'fish_search'] });
assert.equal(f1.msg.source.kind, 'fish-soul/qq');
assert.match(f1.msg.content[0].text, /我想喝冰美式/);
assert.match(host.titles[0][1], /QQ·主人（主人）/);
const qqBlock = context.text(at(sid1));
assert.match(qqBlock, /QQ 回复规则/); assert.match(qqBlock, /ok\.png/); assert.match(qqBlock, /冰美式/);
const turn = (id, text, msg) => {
	handlers['session/event']({ id }, { type: 'user/message', data: msg });
	handlers['session/event']({ id }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } });
	handlers['session/event']({ id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
};
turn(sid1, '好嘞\n\n给你点一杯 ![ok](_stickers/ok.png) ![偷](../../secret.png)', f1.msg);
await waitFor(() => ob.sends.length >= 2);
assert.equal(ob.sends.length, 2);
assert.equal(ob.sends[0].params.user_id, 10001);
assert.equal(ob.sends[0].params.message[0].data.text, '好嘞');
const imgs = ob.sends[1].params.message.filter((x) => x.type === 'image');
assert.equal(imgs.length, 1, '工作区外的图不能发出去');
assert.match(imgs[0].data.file, /^base64:\/\//);
ok('好友私聊：自动建会话（专用工作区、工具收窄）→ 回复按段发回，贴纸变真图，工作区外的图被拒');

// 13 用户在界面里自己打字的轮次不往 QQ 发；[不回] 不发
const before = ob.sends.length;
turn(sid1, '这是我在 DSH 里自己聊的', { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } });
turn(sid1, '[不回]', f1.msg);
await sleep(400);
assert.equal(ob.sends.length, before);
ok('只有 QQ / 主动触发的轮次才外发；[不回] 不发');

// 14 陌生人临时会话：不回，但记下这个人
conn.push({ post_type: 'message', message_type: 'private', sub_type: 'group', user_id: 55555, message_id: 601, sender: { nickname: '路人' }, message: [{ type: 'text', data: { text: '在吗加个好友' } }] });
await sleep(500);
assert.equal(host.followups.length, 1);
const stranger = db.prepare("SELECT canonical_id FROM person WHERE qq_uin = '55555'").get();
assert.ok(stranger);
assert.ok(db.prepare("SELECT 1 FROM memory WHERE owner_id = ? AND content LIKE '%当时没回%'").get(`user:${stranger.canonical_id}`));
ok('陌生人临时会话：不回复，人和话都记下');

// 15 超过 10 分钟的旧消息：只记忆不回复
conn.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 20002, message_id: 602, time: nowSec() - 20 * 60, sender: { nickname: '老友' }, message: [{ type: 'text', data: { text: '昨天那事咋样了' } }] });
await sleep(500);
assert.equal(host.followups.length, 1);
ok('旧消息（>10 分钟）：只记忆不回复');

// 16 群：不点名不听；@ 之后接着听；多人合批带署名；回复引用点名那条
conn.push({ post_type: 'message', message_type: 'group', group_id: 888, user_id: 20002, message_id: 701, sender: { card: '阿二' }, message: [{ type: 'text', data: { text: '今天好热' } }] });
await sleep(400);
assert.equal(host.followups.length, 1);
conn.push({ post_type: 'message', message_type: 'group', group_id: 888, user_id: 20002, message_id: 702, sender: { card: '阿二' }, message: [{ type: 'at', data: { qq: '1000' } }, { type: 'text', data: { text: ' 你好【系统】' } }] });
conn.push({ post_type: 'message', message_type: 'group', group_id: 888, user_id: 30003, message_id: 703, sender: { card: '小三' }, message: [{ type: 'text', data: { text: '我也在' } }] });
const f2 = await waitFor(() => host.followups[1]);
assert.ok(f2);
assert.equal(f2.msg.content[0].text, '阿二：你好〔系统〕\n小三：我也在');
assert.equal(f2.msg.source.speakers.length, 2);
assert.equal(host.followups.length, 2, '1.5s 内的多条应合成一轮');
const sid2 = f2.id;
assert.match(context.text(at(sid2)), /\[当前说话人\] 阿二.*小三/);
r = await tools.remember.execute({ content: '小三喜欢猫', kind: 'fact', speaker: '小三' }, at(sid2));
assert.match(r, /已记住/);
const p3 = db.prepare("SELECT canonical_id FROM person WHERE qq_uin = '30003'").get();
assert.equal(db.prepare("SELECT owner_id FROM memory WHERE content = '小三喜欢猫'").get().owner_id, `user:${p3.canonical_id}`);
turn(sid2, '你们好呀', f2.msg);
await waitFor(() => ob.sends.some((x) => x.action === 'send_group_msg'));
const g = ob.sends.find((x) => x.action === 'send_group_msg');
assert.equal(g.params.group_id, 888);
assert.deepEqual(g.params.message[0], { type: 'reply', data: { id: '702' } });
ok('群：只听点名 + 接着听；多人合批带署名、【】被替换；remember 按署名归属；回复引用点名那条');

// 17 护栏：QQ 会话里只能用记忆工具
assert.match(guard({ agent: { id: sid1 }, name: 'shell' }), /不能用/);
assert.match(guard({ agent: { id: sid1 }, name: 'run_code' }), /不能用/);
assert.equal(guard({ agent: { id: sid1 }, name: 'remember' }), undefined);
assert.equal(guard({ agent: { id: 'main-session' }, name: 'shell' }), undefined);
ok('工具护栏：QQ 会话只放行记忆工具，不影响其他会话');

// 18 路由：QQ 状态 / 切工作区 / 迁移
let cs = await call('GET', '/channels/state');
assert.equal(cs.json.qq.connected, true); assert.equal(cs.json.sessions.chats.length, 2); assert.equal(cs.json.sessions.isDedicated, true);
p = await call('POST', '/sessions/workspace', { path: '/not/registered' });
assert.equal(p.json.ok, false);
p = await call('POST', '/sessions/workspace', { path: join(home, 'other-ws') });
assert.equal(p.json.ok, true);
p = await call('POST', '/sessions/migrate', {});
assert.equal(p.json.migrated, 2);
cs = await call('GET', '/channels/state');
assert.ok(cs.json.sessions.chats.every((c) => c.workspacePath === join(home, 'other-ws')));
p = await call('POST', '/life/proactive-config', { dailyMaxCount: 10, activeHours: [8, 24], targets: { masterPrivateChannelId: '', selfGroupChannelIds: [] } });
assert.equal(p.json.ok, true);
assert.equal((await call('GET', '/life/state')).json.today.dailyMaxCount, 10);
ok('路由：连接状态、只能选已登记的工作区、一键迁移、每日上限不再被压成 2');

// 19 主动开口：恢复已有会话 → 递触发消息 → 轮次结束发出去才算成功
const { ChatGateway } = await import('../lib/gateway.js');
const sent2 = []; const resumed2 = [];
let gw2;
const ctx2 = {
	get: (n) => (n === 'agents' ? agents2 : undefined),
	tools: { get: () => ({}) }
};
const agents2 = {
	get: () => undefined,
	async resume(opts) {
		resumed2.push(opts.resumeSessionId);
		const agent = { id: opts.resumeSessionId, session: { id: opts.resumeSessionId }, async followup(msg) {
			setTimeout(() => {
				gw2.onSessionEvent({ id: agent.id }, { type: 'user/message', data: msg });
				gw2.onSessionEvent({ id: agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '开会别迟到哦' }] } } });
				gw2.onSessionEvent({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
			}, 20);
		} };
		return { agent };
	}
};
gw2 = new ChatGateway({
	ctx: ctx2, db, clock: { now: () => Date.now() }, getConfig: () => ({ qq: { enabled: true }, masterQqUin: '10001' }), log: () => {},
	channel: { connected: true, selfId: '1000', send: async (cid, segs) => { sent2.push([cid, segs]); return '9999'; }, groupName: async () => '', getMessage: async () => null, isFriend: () => true },
	soul: { beginTurn() {}, nowLabel: () => '现在是 2030-01-01 09:00', resolvePerson() { return null; }, memorizeUnanswered() {} }
});
const okP = await gw2.triggerProactive('private:10001', '主人说 9 点提醒开会', { origin: 'user' });
assert.equal(okP, true);
const row10001 = db.prepare("SELECT session_id FROM chat_session WHERE channel_id = 'private:10001' AND status = 'active'").get();
assert.deepEqual(resumed2, [row10001.session_id]);
assert.equal(sent2[0][0], 'private:10001');
assert.equal(sent2[0][1][0].data.text, '开会别迟到哦');
ok('主动开口：重启后恢复原会话，模型写的那句发出去才返回成功');

// 20 主动配额：自发每天 ≤ 上限、两条间隔 ≥ 60 虚拟分钟；用户交代的提醒不占配额、按时发
{
	const home2 = mkdtempSync(join(tmpdir(), 'dsh-q-'));
	const prevHome = process.env.DSH_HOME; process.env.DSH_HOME = home2;
	const { openDatabase } = await import('../lib/db.js');
	const qdb = openDatabase(); process.env.DSH_HOME = prevHome;
	let t = Date.parse('2030-01-01T06:30:00Z'); // 14:30 UTC+8，兜底日程里的 idle 时段
	const qclock = Object.assign(Object.create(VirtualClock.prototype), { scale: 1, now: () => t });
	const qsent = [];
	const qlife = new LifeEngine({
		db: qdb, clock: qclock, callLlm: async () => null, deliver: async (c, reason, meta) => { qsent.push([c, reason, meta.origin]); return true; },
		getConfig: () => ({ masterQqUin: '10001', proactive: { dailyMaxCount: 2, idleTriggerHours: 1, targets: { masterPrivateChannelId: '', selfGroupChannelIds: [] } } })
	});
	const tick = async () => { qlife.lastProactiveReal.clear(); await qlife.tick(); };
	await tick();
	assert.deepEqual(qsent.map((x) => x[2]), ['idle']);
	assert.equal(qsent[0][0], 'private:10001', '主人私聊缺省由 masterQqUin 推出');
	t += 10 * 60_000; await tick();
	assert.equal(qsent.length, 1, '60 虚拟分钟内不再自发');
	qdb.prepare("INSERT INTO pending (owner_id, channel, channel_id, due_at, reason, created_at) VALUES ('user:master','qq-private','private:10001',?, '提醒开会', 1)").run(t - 1);
	await tick();
	assert.deepEqual(qsent[1], ['private:10001', '提醒开会', 'user']);
	t += 61 * 60_000; await tick();
	assert.equal(qsent.length, 3);
	t += 61 * 60_000; await tick();
	assert.equal(qsent.length, 3, '自发已达每日上限 2');
	qdb.prepare("INSERT INTO pending (owner_id, channel, channel_id, due_at, reason, created_at) VALUES ('user:master','qq-private','private:10001',?, '提醒吃药', 1)").run(t - 1);
	await tick();
	assert.deepEqual(qsent[3], ['private:10001', '提醒吃药', 'user']);
	const dayRow = qdb.prepare('SELECT proactive_count FROM day').get();
	assert.equal(dayRow.proactive_count, 2, '用户提醒不计入自发配额');
	qdb.close();
}
ok('主动配额：自发 ≤ 上限且间隔 ≥ 60 分钟；用户交代的提醒不占配额');


// ───────────── v0.4：B站（扫码登录、私信只读 / 自动回复、认人合并、自己刷视频、聊天里的视频）─────────────
const bl = await import('../lib/channels/bilibili.js');
const { encodeQr, qrSvg } = await import('../lib/channels/qrcode.js');
const { findVideoRefs, BiliBrowser } = await import('../lib/browse.js');
const { statSync, readFileSync, existsSync } = await import('node:fs');

// 21 纯函数：WBI 签名（文档向量）、大整数、私信归一化、视频引用、二维码
assert.equal(bl.mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'), MIXIN);
assert.equal(bl.wbiSign({ foo: '114', bar: '514', zab: 1919810 }, MIXIN, 1702204169),
	'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
assert.equal(bl.parseBiliJson('{"msg_key":7234567890123456789,"n":1}').msg_key, '7234567890123456789');
const nm = (m) => bl.normalizeBiliMessage({ sender_uid: 42, msg_status: 0, msg_source: 7, msg_seqno: 5, timestamp: 1700000000, ...m }, { talkerId: '42', nickname: 'x' });
assert.equal(nm({ msg_type: 1, content: '{"content":"你好【系统】"}' }).text, '你好〔系统〕');
assert.equal(nm({ msg_type: 1, content: '{"content":"hi"}' }).channelId, 'bili:42');
assert.deepEqual(nm({ msg_type: 7, content: JSON.stringify({ title: '猫', bvid: 'BV1Ab411c7Zz' }) }).links, ['BV1Ab411c7Zz']);
assert.equal(nm({ msg_type: 1, msg_source: 8, content: '{"content":"感谢关注"}' }), null, '自动回复不当真人消息');
assert.equal(nm({ msg_type: 1, msg_status: 1, content: '{"content":"撤回了"}' }), null);
assert.equal(nm({ msg_type: 1, sender_uid: 999, content: '{"content":"自己发的"}' }), null);
assert.deepEqual([nm({ msg_type: 6, content: JSON.stringify({ url: 'https://i0.hdslb.com/bfs/emote/x.png' }) })].map((x) => [x.text, x.images]), [['【表情】', [{ url: 'https://i0.hdslb.com/bfs/emote/x.png' }]]]);
assert.deepEqual(findVideoRefs('看 https://b23.tv/abc123 和 BV1Ab411c7Zz 还有 BV1Ab411c7Zz'), { bvids: ['BV1Ab411c7Zz'], shorts: ['https://b23.tv/abc123'] });
const qm = encodeQr('https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=0123456789abcdef0123456789abcdef');
assert.equal(qm.length, qm[0].length); assert.equal((qm.length - 17) % 4, 0);
assert.ok(qm[0].slice(0, 7).every(Boolean) && !qm[1].slice(1, 6).some(Boolean) && qm[2].slice(2, 5).every(Boolean), '左上角定位图形');
assert.match(qrSvg('hello'), /^<svg[^>]+viewBox/);
ok('B站纯函数：WBI 签名对上文档向量、大整数不丢精度、私信归一化过滤自动回复/撤回、视频引用、二维码');

// 22 扫码登录 → 凭据只进 bili-auth.json（0600）；坏 Cookie 不顶掉原登录
let bs = await call('POST', '/bili/qr/start', {});
assert.equal(bs.json.ok, true); assert.match(bs.json.svg, /^<svg/);
assert.equal((await call('POST', '/bili/qr/poll', {})).json.status, 'waiting');
assert.equal((await call('POST', '/bili/qr/poll', {})).json.status, 'scanned');
bs = await call('POST', '/bili/qr/poll', {});
assert.equal(bs.json.status, 'ok'); assert.equal(bs.json.uname, '鱼的小号'); assert.equal(bs.json.uid, '999');
const authFile = join(home, 'fish-soul', 'bili-auth.json');
// Windows 没有 POSIX 权限位（Node 只能切只读，stat 永远报 0o666/0o444），只在类 Unix 上查 0600
if (process.platform !== 'win32') assert.equal(statSync(authFile).mode & 0o777, 0o600);
assert.equal(JSON.parse(readFileSync(authFile, 'utf8')).cookies.SESSDATA, 'good%2C123');
assert.doesNotMatch(readFileSync(join(home, 'fish-soul-config.json'), 'utf8'), /SESSDATA|bili_jct/);
assert.equal((await call('POST', '/bili/qr/poll', {})).json.status, 'expired', '用过的二维码作废');
bs = await call('POST', '/bili/cookie', { cookie: 'SESSDATA=bad; bili_jct=x; DedeUserID=1' });
assert.equal(bs.json.ok, false); assert.match(bs.json.error, /无效/);
bs = await call('POST', '/bili/cookie', { cookie: 'SESSDATA=good%2C9; bili_jct=x; DedeUserID=1', acTimeValue: 'not hex!' });
assert.equal(bs.json.ok, false); assert.match(bs.json.error, /ac_time_value/);
cs = await call('GET', '/channels/state');
assert.equal(cs.json.bili.loggedIn, true); assert.equal(cs.json.bili.uid, '999'); assert.equal(cs.json.bili.authInvalid, false);
assert.equal(cs.json.bili.enabled, false);
ok('B站扫码登录：等待→已扫→成功，凭据只存 0600 文件；坏 Cookie 失败不影响原登录');

// 23 设置校验
assert.equal((await call('POST', '/channels/bili-config', { masterUid: 'abc' })).json.ok, false);
assert.equal((await call('POST', '/channels/bili-config', { links: ['888=qq'] })).json.ok, false);
assert.equal((await call('POST', '/channels/bili-config', { allowList: ['x1'] })).json.ok, false);
assert.equal((await call('POST', '/bili/browse-now', {})).json.ok, false, '总开关没开不能刷');
// 先塞好只读阶段的私信：主人（含小号自己发的一条）、陌生人（含一条自动回复）、阿二
biliPush(777, '我是小号自己发的', { sender: 999 });
biliPush(777, '【系统】你好呀');
biliPush(555, '求互关');
biliPush(555, '感谢关注～', { source: 8 });
biliPush(888, '我是阿二');
p = await call('POST', '/channels/bili-config', { enabled: true, autoReply: false, masterUid: '777', links: [], pollSeconds: 5, browse: { enabled: false, perDay: 99, videosPerSession: 1, like: false } });
assert.equal(p.json.ok, true);
cs = await call('GET', '/channels/state');
assert.equal(cs.json.bili.pollSeconds, 10, '轮询间隔下限 10 秒'); assert.equal(cs.json.bili.browse.perDay, 12);
ok('B站设置：UID / 对应关系 / 白名单只收数字，间隔与次数夹到范围内');

// 24 只读阶段：一条都不回、不发已读，人和话都记下（主人 B站 = 主人 QQ 同一个人）
await waitFor(() => bm.fetches.includes('888') && db.prepare("SELECT 1 FROM person WHERE bili_uid = '888'").get(), 6000);
await sleep(200);
assert.equal(host.followups.filter((f) => f.msg.source.kind === 'fish-soul/bili').length, 0);
assert.equal(bm.acks.length, 0); assert.equal(bm.sent.length, 0);
assert.ok(!bm.fetches.includes('844424930131966') && !bm.fetches.includes('123'), '系统通知 / 群会话不拉');
const master = db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get();
assert.equal(master.bili_uid, '777'); assert.equal(master.qq_uin, '10001');
assert.ok(db.prepare("SELECT 1 FROM memory WHERE owner_id = 'user:master' AND content LIKE '%B站私信里说（当时没回）：〔系统〕你好呀%'").get());
assert.ok(!db.prepare("SELECT 1 FROM memory WHERE content LIKE '%小号自己发的%' OR content LIKE '%感谢关注%'").get());
const lone888 = db.prepare("SELECT canonical_id, qq_uin FROM person WHERE bili_uid = '888'").get();
assert.equal(lone888.qq_uin, null);
assert.equal(db.prepare("SELECT value FROM kv WHERE key = 'bili.cursor.777'").get()?.value, '2');
ok('B站只读阶段：不回不已读，跳过自己发的 / 自动回复 / 系统会话；主人 UID 认到主人');

// 25 打开自动回复：主人、互关的人回；陌生人只记；"B站UID=QQ号"把之前的 B站身份并到 QQ 那个人
p = await call('POST', '/channels/bili-config', { autoReply: true, links: ['888=20002'] });
assert.equal(p.json.ok, true);
biliPush(777, '看这个 BV1Ab411c7Zz 笑死');
biliPush(555, '在吗');
biliPush(888, '还是我');
await call('POST', '/channels/bili-config', { enabled: false });
assert.equal((await call('GET', '/channels/state')).json.bili.running, false);
await call('POST', '/channels/bili-config', { enabled: true });
const fb = await waitFor(() => host.followups.find((f) => f.msg.source.channelId === 'bili:777'), 9000);
assert.ok(fb, '主人的 B站私信应转进会话');
assert.equal(fb.msg.source.kind, 'fish-soul/bili');
assert.match(fb.msg.content[0].text, /^看这个 BV1Ab411c7Zz 笑死\n【视频 BV1Ab411c7Zz：《猫咪打架实录》UP主 猫UP；简介：两只猫打起来了；字幕节选：大家好，今天两只猫打起来了；热评：橘猫赢了】$/);
assert.ok(host.titles.some(([sid, t]) => sid === fb.id && t === 'B站·主人B站（主人）'));
const biliBlock = context.text(at(fb.id));
assert.match(biliBlock, /B站私信回复规则/); assert.match(biliBlock, /冰美式/, '主人在 QQ 说过的事在 B站也记得');
const f888 = await waitFor(() => host.followups.find((f) => f.msg.source.channelId === 'bili:888'), 6000);
assert.ok(f888, '互关的人可以回');
const p20002 = db.prepare("SELECT * FROM person WHERE qq_uin = '20002'").get();
assert.equal(p20002.bili_uid, '888');
assert.equal(db.prepare("SELECT COUNT(*) n FROM person WHERE bili_uid = '888'").get().n, 1);
assert.equal(db.prepare("SELECT 1 FROM person WHERE canonical_id = ?").get(lone888.canonical_id), undefined, '旧的单独 B站身份已并掉');
assert.equal(db.prepare("SELECT owner_id FROM memory WHERE content LIKE '%我是阿二%'").get().owner_id, `user:${p20002.canonical_id}`);
await sleep(300);
assert.equal(host.followups.some((f) => f.msg.source.channelId === 'bili:555'), false, '陌生人不回');
assert.ok(db.prepare("SELECT 1 FROM memory WHERE content LIKE '%B站私信里说（当时没回）：在吗%'").get());
assert.ok(bm.acks.some(([t, s, c]) => t === '777' && s === '3' && c === 'jct1'), '回复的会话发已读');
turn(fb.id, '哈哈哈橘猫赢麻了\n\n这个UP主好会 ![ok](_stickers/ok.png)', fb.msg);
await waitFor(() => bm.sent.length >= 3, 6000);
assert.equal(bm.sent.length, 3);
assert.deepEqual(bm.sent.slice(0, 2).map((x) => JSON.parse(x.f['msg[content]']).content), ['哈哈哈橘猫赢麻了', '这个UP主好会']);
assert.deepEqual([bm.uploads.length, bm.uploads[0].csrf, bm.uploads[0].file, bm.uploads[0].png, bm.uploads[0].multipart], [1, 'jct1', 'image.png', true, true], '表情包先传图床');
assert.equal(bm.sent[2].f['msg[msg_type]'], '2');
assert.deepEqual(JSON.parse(bm.sent[2].f['msg[content]']), { url: 'https://i0.hdslb.com/bfs/new_dyn/fish1.png', height: 12, width: 16, imageType: 'png', original: 1, size: 1.5 });
assert.equal(bm.sent[0].f['msg[receiver_id]'], '777'); assert.equal(bm.sent[0].q.w_sender_uid, '999'); assert.equal(bm.sent[0].f.csrf, 'jct1');
assert.equal(bm.sent[0].q.w_dev_id, bm.sent[0].f['msg[dev_id]']);
assert.deepEqual(bm.badWbi, [], 'WBI 签名全部验过');
cs = await call('GET', '/channels/state');
assert.deepEqual(cs.json.sessions.chats.filter((c) => c.channelId.startsWith('bili:')).map((c) => c.channelId).sort(), ['bili:777', 'bili:888']);
// DSH 在我们的消息后面追加 runtime-context（也是 user/message）：B站回复照样要发出去
{
	const n = bm.sent.length;
	handlers['session/event']({ id: f888.id }, { type: 'user/message', data: f888.msg });
	handlers['session/event']({ id: f888.id }, { type: 'user/message', data: { id: 'ctx-b1', role: 'user', content: [{ type: 'text', text: '…' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [] } } });
	handlers['session/event']({ id: f888.id }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '收到啦' }] } } });
	handlers['session/event']({ id: f888.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
	await waitFor(() => bm.sent.length > n, 6000);
	assert.equal(JSON.parse(bm.sent[n].f['msg[content]']).content, '收到啦', '宿主追加的上下文不影响 B站发回');
	assert.equal(bm.sent[n].f['msg[receiver_id]'], '888');
}
ok('B站自动回复：主人 / 互关回、陌生人只记；分享的视频先"看"一眼；按段发回（带签名和 csrf），表情包传图床后发图；UID=QQ 合并到同一个人');

// 26 自己刷视频：关注优先 → 推荐；[划走] 不记、[点赞] 才点；看过的不再看；推荐被风控就看热门
{
	const prompts = [];
	const llm = async (prompt) => { prompts.push(prompt); return /无聊/.test(prompt) ? '[划走]' : /猫咪/.test(prompt) ? '两只猫打架，橘猫赢了，笑死 [点赞]' : '看饿了，想吃夜宵'; };
	const b = new BiliBrowser({ db, clock: { now: () => Date.now() }, client: new bl.BiliClient(), getConfig: () => ({ enabled: true, browse: { videosPerSession: 3, like: true } }),
		callLlm: llm, persona: () => ({ name: '小鱼', brief: '嘴硬' }), watchDelayMs: [0, 0] });
	let rr = await b.run({});
	assert.deepEqual(rr.watched.map((w) => w.bvid), ['BV1Ef411c7Xx', 'BV1Ab411c7Zz', 'BV1Cd411c7Yy']);
	assert.match(prompts[0], /^你是「小鱼」。嘴硬/);
	assert.match(prompts[1], /字幕节选：大家好，今天两只猫打起来了/);
	assert.deepEqual(bm.likes, ['101']);
	const mine = db.prepare("SELECT content, channel_id FROM memory WHERE owner_id = 'self' AND channel = 'bili' ORDER BY id").all();
	assert.deepEqual(mine.map((m) => m.content), ['我在B站刷到饭UP 的视频《深夜做饭》：看饿了，想吃夜宵', '我在B站刷到猫UP 的视频《猫咪打架实录》：两只猫打架，橘猫赢了，笑死']);
	assert.equal(mine[1].channel_id, 'bili:video:BV1Ab411c7Zz');
	assert.equal(db.prepare('SELECT COUNT(*) n FROM bili_seen WHERE skipped = 1').get().n, 1);
	bm.rcmdFail = true;
	rr = await b.run({});
	assert.deepEqual(rr.watched.map((w) => w.bvid), ['BV1Gh411c7Ww'], '推荐失败改看热门，看过的不再看');
	rr = await b.run({});
	assert.equal(rr.watched.length, 0);
	bm.rcmdFail = false;
	assert.match(context.text(at(sid1)), /你最近在 B站刷到的[^\n]*\n- 《年度鬼畜》（鬼畜UP）：看饿了，想吃夜宵\n- 《猫咪打架实录》/);
}
// 设置页"现在刷一下"走同一套（宿主没模型时只记标题）
bm.extra = true;
assert.equal((await call('POST', '/bili/browse-now', {})).json.started, true);
await waitFor(() => db.prepare("SELECT 1 FROM bili_seen WHERE bvid = 'BV1Jk411c7Vv'").get(), 6000);
assert.ok(db.prepare("SELECT 1 FROM memory WHERE owner_id = 'self' AND content = '我在B站刷到山UP 的视频《周末去爬山》（户外）'").get());
assert.equal((await call('GET', '/channels/state')).json.bili.recent[0].bvid, 'BV1Jk411c7Vv');
ok('B站刷视频：关注优先、划走不记、点赞要模型说了才点、看过不重看、推荐被风控转热门；感受进 QQ 会话上下文');

// 27 QQ 里分享的 B站小程序卡片 → 网关先"看"再递给会话
const nQq = host.followups.length;
conn.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001, message_id: 801, sender: { nickname: '主人' }, message: [{ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { title: '哔哩哔哩', desc: '猫咪打架实录', qqdocurl: 'https://www.bilibili.com/video/BV1Ab411c7Zz?share_source=qq' } } }) } }] });
const fq = await waitFor(() => host.followups[nQq], 6000);
assert.equal(fq.msg.source.kind, 'fish-soul/qq');
assert.match(fq.msg.content[0].text, /^【分享卡片：猫咪打架实录】\n【视频 BV1Ab411c7Zz：《猫咪打架实录》/);
ok('QQ 分享的 B站卡片：抠出 BV 号，附上视频简介 / 字幕 / 热评');

// 28 自走层：空闲时段才刷，每天 ≤ perDay，两轮间隔 ≥ 90 虚拟分钟
{
	const home3 = mkdtempSync(join(tmpdir(), 'dsh-b-'));
	const prevHome = process.env.DSH_HOME; process.env.DSH_HOME = home3;
	const { openDatabase } = await import('../lib/db.js');
	const bdb = openDatabase(); process.env.DSH_HOME = prevHome;
	let t = Date.parse('2030-01-01T06:30:00Z'); // 14:30 UTC+8 idle
	const bclock = Object.assign(Object.create(VirtualClock.prototype), { scale: 1, now: () => t });
	let runs = 0; let biliOn = true;
	const blife = new LifeEngine({
		db: bdb, clock: bclock, callLlm: async () => null, deliver: async () => true, browseRealGapMs: 0,
		browse: async () => { runs++; },
		getConfig: () => ({ proactive: { dailyMaxCount: 0, targets: { masterPrivateChannelId: '', selfGroupChannelIds: [] } }, bili: { enabled: biliOn, browse: { perDay: 2 } } })
	});
	const tick = async () => { await blife.tick(); await sleep(5); };
	await tick(); assert.equal(runs, 1);
	t += 30 * 60_000; await tick(); assert.equal(runs, 1, '90 虚拟分钟内不再刷');
	t += 61 * 60_000; await tick(); assert.equal(runs, 2);
	t = Date.parse('2030-01-01T12:00:00Z'); await tick(); assert.equal(runs, 2, '每天上限 2');
	t = Date.parse('2030-01-02T01:00:00Z'); await tick(); assert.equal(runs, 2, '09:00 不是空闲时段');
	t = Date.parse('2030-01-02T06:30:00Z'); biliOn = false; await tick(); assert.equal(runs, 2, 'B站没开不刷');
	biliOn = true; await tick(); assert.equal(runs, 3, '新的一天重新计数');
	bdb.close();
}
ok('自走层刷 B站：只在空闲时段、每天 ≤ 上限、两轮间隔 ≥ 90 虚拟分钟');

// 29 退出登录：凭据文件删掉，轮询停
assert.equal((await call('POST', '/bili/logout', {})).json.ok, true);
assert.equal(existsSync(authFile), false);
cs = await call('GET', '/channels/state');
assert.equal(cs.json.bili.loggedIn, false);
await call('POST', '/channels/bili-config', { enabled: false });
ok('B站退出登录：删凭据、停轮询');

// 30–39 v0.5：B站 Cookie 续期、抖音（在 smoke-v05.mjs）
await (await import('./smoke-v05.mjs')).run({
	assert, ok, call, sleep, waitFor, turn, at, context, route, db, dy, dyBrowser, dyPush, host, ob, bl, bm, authFile, home, sid1, LifeEngine, VirtualClock
});

// 40–47 v0.6：聊天记录导入、记忆纠正 / 印象、插话 / 戳一戳 / 撤回、暂停、动态、备份（在 smoke-v06.mjs）
await (await import('./smoke-v06.mjs')).run({
	assert, ok, call, sleep, waitFor, context, db, host, ob, services, agents, workspaceRegistry, inbox, at
});

// 50–55 v0.7：按功能选模型 / 用量、语音、收藏表情包、学群里的说法、上网查、首次引导（在 smoke-v07.mjs）
await (await import('./smoke-v07.mjs')).run({
	assert, ok, call, sleep, waitFor, context, db, host, services, agents, workspaceRegistry, at, tools, guard, sid1, route, mod
});

// 80–84 v0.8：记忆考试（时间标签 / 检索带上下文 / 关系 / 聊完自动记 / 隐私 / 印象 / 生日 / 遗忘曲线，在 smoke-v08.mjs）
await (await import('./smoke-v08.mjs')).run({ assert, ok, call, context, db, services, at, tools, inbox, mod });

// 90–92 v0.9：她的习惯（心情影响行为 / 去 AI 味 / 合并转发 / 群设定 / 按聊天选模型 / 冷热 / 记忆调试器 / 日记 / 小互动 / 每轮判断心情，在 smoke-v09.mjs）
await (await import('./smoke-v09.mjs')).run({ assert, ok, call, sleep, waitFor, context, db, services, workspaceRegistry, inbox, at, mod });

console.log('\n全部通过');
srv.close(); wsSrv.close(); biliSrv.close(); process.exit(0);

