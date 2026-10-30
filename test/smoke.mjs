// 本地冒烟测试：模拟 DSH 宿主 ctx，验证会话隔离、零滞后召回、配置合并、导入、待办队列、向量索引。
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

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

// 设置页写的文件配置（宿主 schema 默认值是空串，旧实现会把这些覆盖掉）
writeFileSync(join(home, 'fish-soul-config.json'), JSON.stringify({
	embedding: { enabled: true, baseURL, apiKey: 'sk-test', model: 'm1' },
	proactive: { targets: { masterPrivateChannelId: 'private:10001', selfGroupChannelIds: [] } }
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
const tools = {}; let section = null; let context = null; const handlers = {}; let route = null;
const ctx = {
	logger: { info() {}, warn() {}, error: (m) => console.error('  log.error', m) },
	effect: (fn) => fn(),
	tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
	systemPrompt: { section: (s) => { section = s; return () => {}; }, context: (c) => { context = c; return () => {}; } },
	on: (ev, h) => { handlers[ev] = h; },
	webServer: { register: (r) => { route = r; return () => {}; } }
};
const mod = await import('../lib/index.js');
await mod.apply(ctx, { masterQqUin: '10001', embedding: { enabled: true, baseURL: '', apiKey: '', model: '' } });

const inbox = (qq, text, group) => handlers['agent/inbox/inserted']({ data: { sender: { userId: qq, nickname: `n${qq}` }, groupId: group, text, sessionId: group ? `g${group}` : `p${qq}` } });
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
let r = await tools.remember.execute({ content: '下周三要考高数', kind: 'event', importance: 3 }, { sessionId: 'g777' });
assert.match(r, /已记住/);
inbox('30003', '高数难不难', 777);
let block = context.text({ sessionId: 'g777' });
assert.doesNotMatch(block.split('[本群近期]')[0], /考高数/, 'B 的相关记忆里不该出现 A 的记忆');
inbox('20002', '高数复习好难', 777);
block = context.text({ sessionId: 'g777' });
assert.match(block, /\[相关记忆\][\s\S]*下周三要考高数/);
ok('群聊按人隔离 + 本轮消息即时召回（无一轮滞后）');

// 4 认不出发送者不再当主人
handlers['agent/inbox/inserted']({ data: { text: '你还记得我吗', sessionId: 'x1' } });
r = await tools.remember.execute({ content: '陌生信息', kind: 'fact' }, { sessionId: 'x1' });
assert.match(r, /没识别出/);
ok('未识别发送者：不读写任何人记忆');

// 5 forget 归属校验
inbox('30003', '帮我删掉那条', 777);
r = await tools.forget.execute({ id: 1 }, { sessionId: 'g777' });
assert.match(r, /不属于/);
ok('forget 只能删自己的');

// 6 世界书关键词
inbox('20002', '你的猫叫什么', 777);
assert.match(context.text({ sessionId: 'g777' }), /团子/);
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
assert.match(context.text({ sessionId: 'p10001' }), /冰美式/);
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

console.log('\n全部通过');
srv.close(); process.exit(0);
