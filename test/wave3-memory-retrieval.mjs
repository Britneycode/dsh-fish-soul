// Wave 3 记忆与检索优化回归保护
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-wave3-');
process.env.DSH_HOME = home;

const { openDatabase, reassignMemoryOwner, getKv, setKv, getProfile, setProfile } = await import('../lib/db.js');
const { blobToF32, normalizeToBlob, EmbeddingClient, vectorRanks, recallSync, VectorWorker } = await import('../lib/retrieval.js');
const {
	ChatJournal, ChatDigester, insertMemory, nearDuplicateSync, isRecentlyRejectedSync,
	pruneStaleBrowsingMemories, pruneExpiredDailyKv, reinforce
} = await import('../lib/soul-memory.js');
const { LifeEngine } = await import('../lib/life.js');
const { memoryLabel } = await import('../lib/memory-label.js');
const { registerExtraTools } = await import('../lib/index-tools.js');
const { tokenizeForBm25 } = await import('../lib/segment.js');

const db = openDatabase();
const ok = (m) => console.log('✓', m);
const DAY = 86_400_000;

try {
	// ── 1. blobToF32 零拷贝视图（对齐零拷贝，不对齐安全拷贝）──
	{
		const ab = new ArrayBuffer(16);
		new Float32Array(ab, 0, 2).set([0.6, 0.8]);
		const aligned = new Uint8Array(ab, 0, 8);
		const f1 = blobToF32(aligned);
		assert.equal(f1.buffer, ab, '4 字节对齐的 Uint8Array 必须复用底层 ArrayBuffer');
		assert.ok(Math.abs(f1[0] - 0.6) < 1e-6 && Math.abs(f1[1] - 0.8) < 1e-6);

		const unaligned = new Uint8Array(ab, 1, 8);
		const f2 = blobToF32(unaligned);
		assert.notEqual(f2.buffer, ab, '非 4 字节对齐偏移应回退安全拷贝');
		ok('blobToF32 零拷贝与对齐兜底正确');
	}

	// ── 2. EmbeddingClient query LRU 与 probe 绕过缓存 ──
	{
		let fetchCount = 0;
		const origFetch = globalThis.fetch;
		globalThis.fetch = async (_url, init) => {
			fetchCount++;
			const body = JSON.parse(String(init?.body ?? '{}'));
			const inputs = Array.isArray(body.input) ? body.input : [body.input];
			return new Response(JSON.stringify({
				data: inputs.map((_, i) => ({ index: i, embedding: [1, 0] }))
			}), { status: 200, headers: { 'content-type': 'application/json' } });
		};
		try {
			const client = new EmbeddingClient(() => ({ enabled: true, baseURL: 'http://emb.local/v1', apiKey: 'k', model: 'm1', timeoutMs: 800 }));
			await client.embed(['你好'], { useCache: true });
			await client.embed(['你好'], { useCache: true });
			assert.equal(fetchCount, 1, '相同 query 应命中 LRU 缓存只发 1 次请求');
			await client.probe();
			await client.probe();
			assert.equal(fetchCount, 3, 'probe() 必须绕过 queryCache 每次真实探测');
		} finally {
			globalThis.fetch = origFetch;
		}
		ok('EmbeddingClient queryCache LRU 与 probe 绕过验证通过');
	}

	// ── 3. vectorRanks excludePrivate 与 recallSync vectorizedIds / excludeIds ──
	{
		const addMem = (ownerId, visibility, content, vecArr) => {
			const r = db.prepare(`
				INSERT INTO memory (character_id, owner_id, channel, kind, content, keywords, importance, created_at, updated_at, visibility, status)
				VALUES ('feiyu', ?, 'qq-private', 'fact', ?, ?, 2, 1000, 1000, ?, 'active')
			`).run(ownerId, content, tokenizeForBm25(content), visibility);
			const id = Number(r.lastInsertRowid);
			if (vecArr) {
				db.prepare("INSERT INTO vec (memory_id, model_id, dim, generation_id, blob) VALUES (?, 'm1', 2, 1, ?)")
					.run(id, normalizeToBlob(vecArr));
			}
			return id;
		};
		const idShown = addMem('user:u3', 'normal', '咖啡 拿铁 好喝', [0.99, 0.01]);
		const idPriv = addMem('user:u3', 'private', '秘密 心事', [1, 0]);
		const idKeep1 = addMem('user:u3', 'normal', '咖啡 日常 一号', [0.9, 0.1]);
		const idKeep2 = addMem('user:u3', 'normal', '咖啡 日常 二号', [0.8, 0.2]);
		db.prepare("INSERT OR REPLACE INTO vec_meta (id, model_id, dim, generation_id, built_at, status) VALUES (1, 'm1', 2, 1, 1000, 'ready')").run();

		const embedder = { embed: async () => ({ vectors: [[1, 0]] }) };
		const vrGroup = await vectorRanks({ db, embedder, characterId: 'feiyu', ownerId: 'user:u3', query: '咖啡', embeddingCfg: { model: 'm1' }, excludePrivate: true });
		assert.equal(vrGroup.ranks.has(idPriv), false, 'excludePrivate=true 时私密记忆不得占向量排名');
		assert.ok(vrGroup.vectorizedIds instanceof Set && vrGroup.vectorizedIds.has(idKeep1));

		let extraVecSql = false;
		const proxyDb = {
			prepare(sql) {
				if (sql.includes('FROM vec')) extraVecSql = true;
				return db.prepare(sql);
			}
		};
		const res = recallSync({
			db: proxyDb, clock: { now: () => 2000 }, config: { topK: 2 }, characterId: 'feiyu',
			ownerId: 'user:u3', query: '咖啡', vec: vrGroup, excludePrivate: true, excludeIds: new Set([idShown])
		});
		assert.equal(extraVecSql, false, 'vec 已带 vectorizedIds 时 recallSync 不应重复查 vec 表');
		assert.equal(res.length, 2, 'excludeIds 应在 topK 截断前过滤以保满 topK');
		assert.equal(res.some((m) => m.id === idShown || m.id === idPriv), false);
		ok('vectorRanks excludePrivate、vectorizedIds 复用与 excludeIds 保满 topK 验证通过');
	}

	// ── 4. VectorWorker 增量补漏 + coverageSnapshot 排除孤儿向量 + 入队去重 ──
	{
		const rAct1 = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, kind, content, keywords, created_at, updated_at, status) VALUES ('feiyu','user:u4','qq','fact','已向量化','已 向量',10,10,'active')`).run();
		const rAct2 = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, kind, content, keywords, created_at, updated_at, status) VALUES ('feiyu','user:u4','qq','fact','漏掉的记忆','漏掉',11,11,'active')`).run();
		const rArch = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, kind, content, keywords, created_at, updated_at, status) VALUES ('feiyu','user:u4','qq','fact','孤儿已删','孤儿',12,12,'archived')`).run();
		const gen = 2;
		db.exec('DELETE FROM vec');
		db.prepare("INSERT OR REPLACE INTO vec_meta (id, model_id, dim, generation_id, built_at, status) VALUES (1, 'm2', 2, ?, 100, 'ready')").run(gen);
		db.prepare("INSERT INTO vec (memory_id, model_id, dim, generation_id, blob) VALUES (?, 'm2', 2, ?, ?)").run(Number(rAct1.lastInsertRowid), gen, normalizeToBlob([1, 0]));
		db.prepare("INSERT INTO vec (memory_id, model_id, dim, generation_id, blob) VALUES (?, 'm2', 2, ?, ?)").run(Number(rArch.lastInsertRowid), gen, normalizeToBlob([0, 1]));

		const embedCalls = [];
		const worker = new VectorWorker({
			db, clock: { now: () => 200 },
			embedder: {
				async embedDetailed(inputs) {
					embedCalls.push(inputs);
					return { ok: true, vectors: inputs.map(() => [0.5, 0.5]), latencyMs: 1 };
				}
			},
			getEmbeddingConfig: () => ({ enabled: true, baseURL: 'http://e', apiKey: 'k', model: 'm2' })
		});
		const totalActive = db.prepare("SELECT COUNT(*) n FROM memory WHERE status='active' AND valid_to IS NULL").get().n;
		const before = worker.coverageSnapshot();
		assert.equal(before.vectorizedCount, 1, 'coverageSnapshot 必须忽略已归档的孤儿 vec 行');
		assert.equal(before.totalActiveCount, totalActive);

		worker.enqueueRealtime(999999, 'dup');
		worker.enqueueRealtime(999999, 'dup');
		assert.equal(worker.realtimeQueue.filter((t) => t.memoryId === 999999).length, 1, 'enqueueRealtime 同 id 不重复排队');
		worker.realtimeQueue.length = 0;

		await worker.tick();
		const after = worker.coverageSnapshot();
		assert.equal(after.vectorizedCount, totalActive, 'backfillStep 应按 ready 索引增量补齐漏向量行且不清空已有 vec');
		assert.ok(embedCalls.flat().includes('漏掉的记忆'));
		assert.ok(db.prepare('SELECT 1 FROM vec WHERE memory_id = ?').get(Number(rAct1.lastInsertRowid)), '已有向量不得被抹除');
		ok('VectorWorker 增量补漏、孤儿 vec 过滤与入队去重通过');
	}

	// ── 5. ChatDigester 墓碑防回填 + 异步 related（不挡显式 nearDuplicateSync）──
	{
		const now = 5_000_000_000;
		const owner = 'user:tomb';
		const archId = insertMemory(db, null, { ownerId: owner, channel: 'qq-private', channelId: 'private:t1', kind: 'fact', content: '他每周五去打羽毛球', importance: 2 }, now - 5 * DAY);
		db.prepare("UPDATE memory SET status = 'archived', valid_to = ?, updated_at = ? WHERE id = ?").run(now - 2 * DAY, now - 2 * DAY, archId);
		const corrId = insertMemory(db, null, { ownerId: 'self', channel: 'qq-private', channelId: 'private:t1', kind: 'fact', content: '我养了一只柯基叫旺财', importance: 2 }, now - 5 * DAY);
		db.prepare("UPDATE memory SET status = 'outdated', invalid_kind = 'corrected', valid_to = ?, updated_at = ? WHERE id = ?").run(now - 1 * DAY, now - 1 * DAY, corrId);

		assert.equal(nearDuplicateSync(db, owner, '他每周五去打羽毛球'), null, '显式 remember 用的 nearDuplicateSync 不得被墓碑拦截');
		assert.ok(isRecentlyRejectedSync(db, owner, '他每周五去打羽毛球', now));

		const prompts = [];
		const journal = new ChatJournal({ db, keepRecent: 10 });
		const digester = new ChatDigester({
			db, clock: { now: () => now }, journal, worker: null,
			getConfig: () => ({ enabled: true }),
			related: async () => [{ id: 888, owner_id: owner, content: '异步召回的旧记忆', updated_at: now - 1000 }],
			callLlm: async (p) => {
				prompts.push(p);
				return JSON.stringify({
					memories: [{ who: '阿墓', kind: 'fact', content: '他每周五去打羽毛球', importance: 2 }],
					self: [{ content: '我养了一只柯基叫旺财', importance: 2 }]
				});
			},
			findOwnerByName: () => null, personaName: () => '鱼', titleOf: (c) => c, log: () => {}, note: () => {}
		});
		const res = await digester.run('private:t1', [
			{ who: '阿墓', ownerId: owner, text: '我周五照旧运动，听说你养了旺财' }
		]);
		assert.match(prompts[0], /异步召回的旧记忆/, 'ChatDigester.run 必须 await 异步 related()');
		assert.equal(res.added, 0);
		assert.equal(res.self, 0);
		assert.equal(res.tombstoneSkipped, 2, 'archived 与 corrected 墓碑均应拦住后台自动回填');
		ok('ChatDigester 墓碑防回填与异步 related 验证通过');
	}

	// ── 6. ChatJournal pending 跨重启持久化与 take 清空 ──
	{
		const j1 = new ChatJournal({ db, keepRecent: 10 });
		for (let i = 1; i <= 5; i++) j1.add('private:persist1', { who: '阿久', ownerId: 'user:p9', text: `第${i}条待整理消息` });
		assert.ok(getKv(db, 'journal.pending.private:persist1', null)?.length === 5, '第 5 条应自动落盘 kv');

		const j2 = new ChatJournal({ db, keepRecent: 10 });
		const due = j2.due(Date.now() + 10_000, 1000, 40);
		assert.ok(due.includes('private:persist1'), '重建 ChatJournal 应恢复 pending 并触发 due');
		const taken = j2.take('private:persist1');
		assert.equal(taken.length, 5);
		assert.equal(getKv(db, 'journal.pending.private:persist1', null), null, 'take 后应删除 kv 键');
		ok('ChatJournal pending 持久化、恢复与清空通过');
	}

	// ── 7. ChatDigester.stop() 刷盘未满 5 条的 ChatJournal pending 到 kv 并跨实例恢复 ──
	{
		const jStop = new ChatJournal({ db, keepRecent: 10 });
		jStop.add('private:flush1', { who: '阿停', ownerId: 'user:pstop', text: '停机前第一条消息' });
		jStop.add('private:flush1', { who: '阿停', ownerId: 'user:pstop', text: '停机前第二条消息' });
		assert.equal(getKv(db, 'journal.pending.private:flush1', null), null, '未满 5 条暂未写入 kv');
		const dStop = new ChatDigester({
			db, clock: { now: () => Date.now() }, journal: jStop, worker: null,
			getConfig: () => ({ enabled: false }), related: () => [], callLlm: async () => null,
			findOwnerByName: () => null, personaName: () => '鱼', titleOf: (c) => c
		});
		dStop.stop();
		const saved = getKv(db, 'journal.pending.private:flush1', null);
		assert.equal(Array.isArray(saved) && saved.length, 2, 'stop() 必须把不足 5 条的缓冲刷盘到 kv');

		const jRestored = new ChatJournal({ db, keepRecent: 10 });
		assert.equal(jRestored.take('private:flush1').length, 2, '重建 ChatJournal 应恢复停机前刷盘的 pending');
		ok('ChatDigester.stop() 刷盘不足 5 条 pending 与跨重启恢复通过');
	}

	// ── 8. LifeEngine.runDream 保底保留高重要度 fact ──
	{
		const now = 9_000_000_000;
		const owner = 'user:dreamkeep';
		db.prepare("INSERT OR REPLACE INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('dreamkeep', '888111', '阿梦', 'friend', 20, ?, ?)").run(now, now);
		insertMemory(db, null, { ownerId: owner, channel: 'qq-private', channelId: 'private:888111', kind: 'fact', content: '对花生严重过敏', importance: 4 }, now - 100 * DAY);
		for (let i = 0; i < 40; i++) {
			insertMemory(db, null, { ownerId: owner, channel: 'qq-private', channelId: 'private:888111', kind: 'episode', content: `普通闲聊小结${i}`, importance: 2 }, now - (40 - i) * 60_000);
		}
		const dreamPrompts = [];
		const engine = new LifeEngine({
			db, clock: { now: () => now }, realNow: () => now, getConfig: () => ({}), deliver: async () => true,
			callLlm: async (p) => { dreamPrompts.push(p); return '{"missedPending":[],"suggestedRelationStage":null,"outdated":[],"corrected":[]}'; }
		});
		await engine.runDream(owner);
		assert.match(dreamPrompts[0], /对花生严重过敏/, '超过 35 条新 episode 后仍需把高重要度核心 fact 带入 Dream');
		ok('LifeEngine.runDream 保留核心 fact 窗口通过');
	}

	// ── 9. reassignMemoryOwner 与 idx_memory_kind_created 索引 ──
	{
		const now = 6_000_000_000;
		db.prepare("INSERT OR REPLACE INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('src_p', '501', '源', 'stranger', 1, ?, ?)").run(now, now);
		db.prepare("INSERT OR REPLACE INTO person (canonical_id, qq_uin, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('dst_p', '502', '目', 'stranger', 1, ?, ?)").run(now, now);
		db.prepare("INSERT INTO memory (owner_id, channel, kind, content, importance, created_at, updated_at, about) VALUES ('user:other', 'qq-private', 'fact', '提到旧人', 2, ?, ?, 'user:src_p')").run(now, now);
		setProfile(db, 'user:src_p', { text: '在杭州做设计', by: 'dream', updatedAt: now });
		setKv(db, 'mood.user:src_p', { label: '开心', at: now });
		setKv(db, 'dream.watermark.user:src_p', 100);
		setKv(db, 'dream.watermark.user:dst_p', 200);

		reassignMemoryOwner(db, 'user:src_p', 'user:dst_p');
		assert.equal(db.prepare("SELECT about FROM memory WHERE content = '提到旧人'").get().about, 'user:dst_p');
		assert.equal(getProfile(db, 'user:dst_p')?.text, '在杭州做设计', '目标无印象时应迁移源印象');
		assert.equal(getKv(db, 'mood.user:src_p', null), null);
		assert.equal(getKv(db, 'dream.watermark.user:src_p', null), null);
		assert.equal(getKv(db, 'dream.watermark.user:dst_p', null), null, '合并后重置目标 Dream 水位');

		reassignMemoryOwner(db, 'user:dst_p', 'user:dst_p');
		assert.equal(getProfile(db, 'user:dst_p')?.text, '在杭州做设计', '同人自迁移不得清空自己的印象');

		const idx = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_kind_created'").get();
		assert.ok(idx, 'idx_memory_kind_created 索引必须存在');
		ok('reassignMemoryOwner 全量清理合并与 idx_memory_kind_created 索引通过');
	}

	// ── 10. pruneStaleBrowsingMemories 与 pruneExpiredDailyKv ──
	{
		const now = 200 * DAY;
		const oldVid = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, created_at, updated_at, status) VALUES ('feiyu','self','bili','bili:video:BV1old','event','46天前看过的旧视频','旧 视频',1,?,?,'active')`).run(now - 46 * DAY, now - 46 * DAY).lastInsertRowid;
		const recalledVid = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, recall_count, created_at, updated_at, status) VALUES ('feiyu','self','douyin','douyin:video:aw1','event','被想起过的旧视频','想起',1,2,?,?,'active')`).run(now - 60 * DAY, now - 60 * DAY).lastInsertRowid;
		const recentVid = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, created_at, updated_at, status) VALUES ('feiyu','self','bili','bili:video:BV1new','event','3天前刚看的视频','新',1,?,?,'active')`).run(now - 3 * DAY, now - 3 * DAY).lastInsertRowid;
		const weeklyLinkedVid = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, created_at, updated_at, status) VALUES ('feiyu','self','bili','bili:video:BV1weekly','event','50天前写进周记的视频','周记',1,?,?,'active')`).run(now - 50 * DAY, now - 50 * DAY).lastInsertRowid;
		const weeklySummaryId = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, created_at, updated_at, status) VALUES ('feiyu','self','bili','bili:video:BV1weekly','weekly','那周的周记摘要','周记',2,?,?,'active')`).run(now - 49 * DAY, now - 49 * DAY).lastInsertRowid;
		db.prepare('INSERT INTO weekly_source (summary_id, source_id) VALUES (?, ?)').run(Number(weeklySummaryId), Number(weeklyLinkedVid));
		db.prepare("INSERT OR REPLACE INTO vec (memory_id, model_id, dim, generation_id, blob) VALUES (?, 'm2', 2, 2, ?)").run(Number(oldVid), normalizeToBlob([1, 0]));

		const pRes = pruneStaleBrowsingMemories(db, now);
		assert.equal(pRes.archived, 1);
		assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(Number(oldVid)).status, 'archived');
		assert.equal(db.prepare('SELECT 1 FROM vec WHERE memory_id = ?').get(Number(oldVid)), undefined, '清理旧浏览记忆时顺带删 vec');
		assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(Number(recalledVid)).status, 'active');
		assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(Number(recentVid)).status, 'active');
		assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(Number(weeklyLinkedVid)).status, 'active', '已被周记引用的旧浏览记忆不得归档');
		assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(Number(weeklySummaryId)).status, 'active', '清理旧浏览记忆不得触发周记失效');

		const TZ = 8 * 3600_000;
		const nowReal = Date.UTC(2026, 10, 27, 4, 0, 0);
		const oldDay = new Date(nowReal - 20 * DAY + TZ).toISOString().slice(0, 10);
		const keepDay = new Date(nowReal - 2 * DAY + TZ).toISOString().slice(0, 10);
		setKv(db, `web.count.${oldDay}`, 3);
		setKv(db, `relay.count.${oldDay}.user:1`, 2);
		setKv(db, `bili.frames.${keepDay}`, 1);
		setKv(db, 'bili.frames.other', 9);

		const kRes = pruneExpiredDailyKv(db, nowReal);
		assert.equal(kRes.deleted, 2);
		assert.equal(getKv(db, `web.count.${oldDay}`, null), null);
		assert.equal(getKv(db, `relay.count.${oldDay}.user:1`, null), null);
		assert.equal(getKv(db, `bili.frames.${keepDay}`, null), 1);
		assert.equal(getKv(db, 'bili.frames.other', null), 9);
		ok('pruneStaleBrowsingMemories 与 pruneExpiredDailyKv 验证通过');
	}

	// ── 11. recall 工具 tokenBudget 截断（至少保留 1 条）──
	{
		const owner = 'user:toolcap';
		const now = 8_000_000_000;
		for (let i = 0; i < 4; i++) {
			insertMemory(db, null, { ownerId: owner, channel: 'qq-private', channelId: 'private:tc', kind: 'fact', content: `长记忆样本${i}：` + '猫'.repeat(180), importance: 3 }, now - i * 1000);
		}
		const registered = {};
		registerExtraTools({
			effect: (fn) => fn(),
			tools: { register: (t) => { registered[t.name] = t; return () => {}; } }
		}, {
			defineTool: (d) => d,
			objectSchema: (p) => ({ type: 'object', properties: p }),
			clock: { now: () => now }, db, life: {}, worker: { enqueueRealtime() {} }, embedder: {},
			embeddingCfg: () => ({ enabled: false }),
			retrievalCfg: () => ({ topK: 5, tokenBudget: 400 }),
			memoryLabel, nearDuplicateSync, tokenizeForBm25,
			parseRoleIso: () => null,
			sessionForTool: () => ({ ownerId: owner, channel: 'qq-private', channelId: 'private:tc' }),
			UNKNOWN_OWNER: 'unknown',
			recall: async ({ ownerId, query }) => recallSync({ db, clock: { now: () => now }, config: { topK: 5 }, characterId: 'feiyu', ownerId, query, vec: null }),
			reinforce, gateway: null, douyinSocial: null, getConfig: () => ({}),
			webConfig: () => ({ enabled: false }), ownSearchReady: () => false,
			runWebSearch: async () => '', formatSearch: () => '',
			relaySenderId: () => '', parseRelayTarget: () => ({ ok: false, error: '' }), log: () => {},
			RELAY_TOOL: 'send_elsewhere', RELAY_FRIEND_TOOL: 'relay_to_friend',
			DOUYIN_VIDEO_TOOL: 'make_douyin_video', OWN_WEB_TOOL: 'fish_search'
		});
		const out = await registered.recall.execute({ query: '长记忆样本' }, {});
		const lines = out.split('\n').filter(Boolean);
		assert.ok(lines.length >= 1 && lines.length < 4, `tokenBudget=400 应截断条目数量（实际返回 ${lines.length} 条，总字数 ${out.length}）`);
		ok('recall 工具 tokenBudget 截断验证通过');
	}
} finally {
	db.close();
}

console.log('✓ wave3-memory-retrieval：11 组断言全过');
