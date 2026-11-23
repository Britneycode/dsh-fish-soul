import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { registerRoutes } from '../lib/routes.js';
import { LifeEngine } from '../lib/life.js';

const NOW = 1700000000000;

/** 最小 harness：内存 DB + 打桩 deps + gate 捕获真实 handler（与 smoke 同款手法）。 */
function makeHarness(personaOverride) {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		CREATE TABLE person (
			canonical_id TEXT PRIMARY KEY,
			display_name TEXT,
			relation_stage TEXT,
			interaction_count INTEGER DEFAULT 0,
			first_seen_at INTEGER,
			last_seen_at INTEGER
		);
		CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE memory (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			character_id TEXT, owner_id TEXT, channel TEXT, channel_id TEXT,
			kind TEXT, content TEXT, keywords TEXT,
			importance INTEGER DEFAULT 1, emotion INTEGER DEFAULT 0,
			source_session TEXT, created_at INTEGER, updated_at INTEGER,
			status TEXT DEFAULT 'active', valid_to INTEGER,
			evidence TEXT, visibility TEXT, about TEXT
		);
	`);

	const life = Object.create(LifeEngine.prototype);
	life.clock = { now: () => NOW };
	life.lastInteractionVirtualMs = new Map();
	life.lastAnyInteractionVirtualMs = 111;
	life.lastAnyInteractionRealMs = 222;
	life.dreamControllers = new Map();
	life.log = () => {};
	life.noteCalls = [];
	const _note = life.noteInteraction.bind(life);
	life.noteInteraction = (ownerId) => { life.noteCalls.push(ownerId); _note(ownerId); };
	life.stateSnapshot = () => ({ today: { dailyMoodTone: '慵懒' }, clock: {}, proactiveConfig: {} });

	const persona = personaOverride ?? { name: 'feiyu', anchor: '锚', routine: '日常', staticText: '鱼鱼是软软的一小只。'.repeat(40) };

	let handler = null;
	registerRoutes({}, {
		db, clock: { now: () => NOW }, worker: null, life, persona,
		getConfig: () => ({}), saveConfig: () => {}, log: () => {},
		gate: { ready: (h) => { handler = h; } },
	});
	assert.ok(handler, 'gate 应捕获到真实 handler');

	const call = async (method, path, body, headers = {}) => {
		let code = 0, payload = null;
		const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
		req.method = method;
		req.url = `/api/plugins/fish-soul${path}`;
		req.headers = headers;
		const res = { writeHead(c) { code = c; }, end(s) { try { payload = JSON.parse(String(s)); } catch { payload = null; } } };
		await handler(req, res);
		return { code, payload };
	};

	const seedMaster = (n = 88) => db.prepare(`
		INSERT INTO person (canonical_id, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('master', '主人', 'close', ?, 0, 0)
	`).run(n);

	const seedMemory = (extra) => db.prepare(`
		INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
		                    importance, emotion, source_session, created_at, updated_at,
		                    status, valid_to, evidence, visibility, about)
		VALUES ('feiyu', 'user:master', ?, ?, 'episode', ?, '', 1, 0, '', ?, ?, ?, ?, '桌面宠物对话', 'normal', NULL)
	`).run(extra.channel ?? 'qq-private', extra.channelId ?? '', extra.content, extra.createdAt, extra.updatedAt ?? extra.createdAt, extra.status ?? 'active', extra.validTo ?? null);

	const memoryCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM memory').get().n);

	return { db, life, call, seedMaster, seedMemory, memoryCount };
}

// GET /life/state：v1 追加版本字段，原快照字段原样展开
{
	const { call } = makeHarness();
	const { code, payload } = await call('GET', '/life/state');
	assert.equal(code, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.apiVersion, 1);
	assert.equal(typeof payload.pluginVersion, 'string');
	assert.ok(payload.pluginVersion.length > 0);
	assert.equal(payload.today.dailyMoodTone, '慵懒');
}

// GET /life/context：人格 / 画像 / 主人关系 / 最近记忆，retired 不进上下文，brief 截断 300
{
	const h = makeHarness();
	h.seedMaster(88);
	h.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
		.run('profile.user:master', JSON.stringify({ text: '主人印象文本', by: 'user', locked: true, updatedAt: 0 }));
	h.seedMemory({ content: '这条是活跃记忆', createdAt: 2000 });
	h.seedMemory({ content: '这条已退役', createdAt: 3000, status: 'retired' });

	const { code, payload } = await h.call('GET', '/life/context');
	assert.equal(code, 200);
	assert.equal(payload.apiVersion, 1);
	assert.equal(payload.persona.name, 'feiyu');
	assert.equal(payload.persona.brief.length, 300);
	assert.equal(payload.profile, '主人印象文本');
	assert.equal(payload.master.displayName, '主人');
	assert.equal(payload.master.relationStage, 'close');
	assert.equal(payload.master.interactionCount, 88);
	assert.equal(payload.lastInteractionVirtualAt, 111);
	assert.equal(payload.lastInteractionAt, 111, '旧字段保留兼容');
	assert.equal(payload.lastInteractionRealAt, 222);
	assert.equal(payload.memories.length, 1);
	assert.equal(payload.memories[0].content, '这条是活跃记忆');
	assert.equal(typeof payload.memories[0].createdAt, 'number');
}

// GET /life/context：无 master 行时兜底建行
{
	const { call } = makeHarness();
	const { code, payload } = await call('GET', '/life/context');
	assert.equal(code, 200);
	assert.equal(payload.master.displayName, '主人');
	assert.equal(payload.master.interactionCount, 0);
}

// GET /life/context：上游新版 deps.persona 是函数（() => ({name,brief})），端点同样要吃下
{
	const h = makeHarness(() => ({ name: 'feiyu', brief: '函数形态的简短人格。'.repeat(30) }));
	h.seedMaster(88);
	const { code, payload } = await h.call('GET', '/life/context');
	assert.equal(code, 200);
	assert.equal(payload.persona.name, 'feiyu');
	assert.equal(payload.persona.brief.length, 300);
	assert.ok(payload.persona.brief.startsWith('函数形态的简短人格。'));
	assert.equal(payload.persona.anchor, '');
	assert.equal(payload.persona.routine, '');
}

// POST /life/interaction click：不计数（只 chat/voice 计）、时间更新、写 kv、不写记忆
{
	const h = makeHarness();
	h.seedMaster(88);
	const before = h.memoryCount();
	const { code, payload } = await h.call('POST', '/life/interaction', { type: 'click', petId: 'main' });
	assert.equal(code, 200);
	assert.equal(payload.apiVersion, 1);
	assert.equal(payload.interaction.type, 'click');
	assert.equal(payload.interaction.at, NOW);
	assert.equal(payload.interaction.memoryId, null);
	assert.equal(h.life.noteCalls.length, 1);
	assert.equal(h.life.noteCalls[0], 'user:master', 'noteInteraction 必须收到字符串 ownerId（审查 #08）');
	assert.equal(typeof h.life.noteCalls[0], 'string', '传对象会让 Dream abort 失效 + Map 垃圾键');
	// Dream abort：主人的 Dream 整理应被新互动打断
	h.life.dreamControllers.set('user:master', { abort() { this.aborted = true; } });
	await h.call('POST', '/life/interaction', { type: 'click', petId: 'main' });
	assert.equal(h.life.dreamControllers.has('user:master'), false, '新互动必须 abort 主人的 Dream');
	const master = h.db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get();
	assert.equal(master.interaction_count, 88, 'click 不计 interaction_count（只有 chat/voice 计）');
	assert.equal(master.last_seen_at, NOW);
	const kv = JSON.parse(h.db.prepare("SELECT value FROM kv WHERE key = 'desktop.lastInteraction'").get().value);
	assert.equal(kv.type, 'click');
	assert.equal(kv.petId, 'main');
	assert.equal(h.memoryCount(), before);
}

// POST /life/interaction chat：写 dsh episode 记忆，不写 kv
{
	const h = makeHarness();
	h.seedMaster(88);
	const { payload } = await h.call('POST', '/life/interaction', { type: 'chat', petId: 'main', text: '在干么呢' });
	assert.equal(typeof payload.interaction.memoryId, 'number');
	const row = h.db.prepare('SELECT * FROM memory WHERE id = ?').get(payload.interaction.memoryId);
	assert.equal(row.channel, 'dsh');
	assert.equal(row.channel_id, 'desktop-pet');
	assert.equal(row.kind, 'episode');
	assert.equal(row.evidence, '桌面宠物对话');
	assert.equal(row.status, 'active');
	assert.equal(h.db.prepare("SELECT value FROM kv WHERE key = 'desktop.lastInteraction'").get(), undefined);
}

// POST /life/interaction voice：evidence 记为桌面语音输入
{
	const h = makeHarness();
	h.seedMaster(88);
	const { payload } = await h.call('POST', '/life/interaction', { type: 'voice', petId: 'main', text: '你好呀' });
	const row = h.db.prepare('SELECT * FROM memory WHERE id = ?').get(payload.interaction.memoryId);
	assert.equal(row.evidence, '桌面语音输入');
}

// POST /life/interaction：chat/voice 空文本不写记忆（与 remember / memorizeUnanswered 守卫一致）
{
	const h = makeHarness();
	h.seedMaster(88);
	const before = h.memoryCount();
	const r1 = await h.call('POST', '/life/interaction', { type: 'chat', petId: 'main' });
	assert.equal(r1.payload.interaction.memoryId, null, '空 chat 不应写记忆');
	const r2 = await h.call('POST', '/life/interaction', { type: 'voice', petId: 'main', text: '' });
	assert.equal(r2.payload.interaction.memoryId, null, '空 voice 不应写记忆');
	assert.equal(h.memoryCount(), before, '空文本不得落库');
	const master = h.db.prepare("SELECT interaction_count FROM person WHERE canonical_id = 'master'").get();
	assert.equal(master.interaction_count, 90, '空文本仍然计互动次数');
}

// POST /life/interaction：文本超 500 截断
{
	const h = makeHarness();
	h.seedMaster(88);
	const { payload } = await h.call('POST', '/life/interaction', { type: 'chat', petId: 'main', text: '喵'.repeat(600) });
	const row = h.db.prepare('SELECT content FROM memory WHERE id = ?').get(payload.interaction.memoryId);
	assert.equal(row.content.length, 500);
}

// POST /life/interaction：未知 type 400，无副作用；坏 JSON 400；跨源 403
{
	const h = makeHarness();
	h.seedMaster(88);
	const bad = await h.call('POST', '/life/interaction', { type: 'pet' });
	assert.equal(bad.code, 400);
	assert.equal(bad.payload.reason, 'bad-request');
	const badJson = await h.call('POST', '/life/interaction', '{oops');
	assert.equal(badJson.code, 400);
	assert.equal(badJson.payload.reason, 'invalid-json');
	const cross = await h.call('POST', '/life/interaction', { type: 'click' }, { 'sec-fetch-site': 'cross-site' });
	assert.equal(cross.code, 403);
	assert.equal(cross.payload.reason, 'forbidden');
	const master = h.db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get();
	assert.equal(master.interaction_count, 88, '被拒请求不产生副作用');
}

console.log('✓ v1 互通端点：/life/state 版本字段、/life/context 上下文组装、/life/interaction 回传与校验');
