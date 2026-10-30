// 本地冒烟测试：模拟 DSH 宿主 ctx，验证会话隔离、零滞后召回、配置合并、导入、待办队列、向量索引。
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

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

// 设置页写的文件配置（宿主 schema 默认值是空串，旧实现会把这些覆盖掉）
writeFileSync(join(home, 'fish-soul-config.json'), JSON.stringify({
	embedding: { enabled: true, baseURL, apiKey: 'sk-test', model: 'm1' },
	proactive: { targets: { masterPrivateChannelId: 'private:10001', selfGroupChannelIds: [] } },
	qq: { enabled: true, wsUrl: `ws://127.0.0.1:${wsSrv.address().port}`, accessToken: 'tok-1', batchMs: 200 }
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
	logger: { info() {}, warn() {}, error: (m) => console.error('  log.error', m) },
	effect: (fn) => fn(),
	get: (name) => services[name],
	agents, workspaceRegistry,
	tools: { register: (t) => { tools[t.name] = t; return () => {}; }, get: (n) => tools[n], guard: (g) => { guard = g; return () => {}; } },
	systemPrompt: { section: (s) => { section = s; return () => {}; }, context: (c) => { context = c; return () => {}; } },
	on: (ev, h) => { handlers[ev] = h; return () => {}; },
	webServer: { register: (r) => { route = r; return () => {}; } }
};
const mod = await import('../lib/index.js');
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
writeFileSync(join(home, 'secret.png'), png);
const nowSec = () => Math.floor(Date.now() / 1000);
conn.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001, message_id: 501, sender: { nickname: '主人' }, message: [{ type: 'text', data: { text: '我想喝冰美式' } }] });
const f1 = await waitFor(() => host.followups[0]);
assert.ok(f1, '好友私聊应转进会话');
const sid1 = f1.id;
assert.equal(host.created[0].meta.cwd, wsDir);
assert.deepEqual(host.restricts[0][1], { allow: ['remember', 'recall', 'forget'] });
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
	const tick = async () => { qlife.lastProactiveRealMs = 0; await qlife.tick(); };
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

console.log('\n全部通过');
srv.close(); wsSrv.close(); process.exit(0);

