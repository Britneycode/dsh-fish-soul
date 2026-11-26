// 回归测试：模型失败率过高与 token 放大（LlmRouter 冷却/防误放大 + 周记/学说法/Dream/聊完记一下 失败退避）。
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpHome } from './_tmp.mjs';
import { LlmRouter } from '../lib/llm.js';
import { getKv, setKv } from '../lib/db.js';
import { SlangLearner } from '../lib/slang.js';

const mkKvDb = () => {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	return db;
};

const makeRouter = (db, script, { cfg = {}, host = null, now } = {}) => {
	const calls = [];
	const logs = [];
	const ctx = {
		get: (n) => {
			if (n === 'llm') return {
				listProviders: () => [{ id: 'p1', name: 'P1' }],
				listModels: async () => [{ id: 'm1', name: 'M1' }],
				async *stream(o) {
					calls.push({ model: o.model, maxTokens: o.maxTokens, hasImage: o.messages?.[0]?.content?.some((b) => b.type === 'image') ?? false });
					yield* script(calls.length - 1, o);
				}
			};
			if (n === 'agentDefaultModel') return { currentSelection: () => host };
			return undefined;
		}
	};
	const router = new LlmRouter({ ctx, db, getConfig: () => cfg, log: (l, m) => logs.push(`${l}: ${m}`), now });
	return { router, calls, logs };
};

// 1. LlmRouter thinkAteBudget：EMPTY_RESPONSE + think / 隐藏思考吃满 / 清理已被污染的 roomy
{
	const db = mkKvDb();
	const { router, calls } = makeRouter(db, function* () {
		yield { type: 'reasoning', text: '想了很多' };
		yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'empty' } } };
	});
	assert.equal(await router.call('测试', { maxTokens: 1200 }), null);
	assert.deepEqual(calls.map((c) => c.maxTokens), [1200], 'EMPTY_RESPONSE + think 不该放大到 8000 重试');
	assert.deepEqual(getKv(db, 'llm.roomy', []), [], 'EMPTY_RESPONSE + think 不该写进 roomy');

	const db2 = mkKvDb();
	const r2 = makeRouter(db2, function* () {
		yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 1100 } };
		yield { type: 'finish', reason: { kind: 'length' } };
	});
	assert.equal(await r2.router.call('测试', { maxTokens: 1200 }), null);
	assert.deepEqual(r2.calls.map((c) => c.maxTokens), [1200], '隐藏思考吃满 length 预算也不该放大到 8000');
	assert.deepEqual(getKv(db2, 'llm.roomy', []), [], '隐藏思考吃满不该写进 roomy');

	const db3 = mkKvDb();
	setKv(db3, 'llm.roomy', ['p1/m1']);
	const r3 = makeRouter(db3, function* () {
		yield { type: 'reasoning', text: '一直在想' };
		yield { type: 'finish', reason: { kind: 'max-tokens' } };
	});
	assert.equal(await r3.router.call('测试', { maxTokens: 1200 }), null);
	assert.deepEqual(r3.calls.map((c) => c.maxTokens), [8000]);
	assert.deepEqual(getKv(db3, 'llm.roomy', []), [], '8000 还被思考吃光时，应从 roomy 移出');
	console.log('✓ LlmRouter thinkAteBudget：拦住 EMPTY_RESPONSE / 隐藏思考放大，并清理被污染的 roomy');
}

// 2. LlmRouter thinkFallback：在 roomy 重试之前抢救思考里的 JSON，且不误记为 failed
{
	for (const finishKind of ['stop', 'error']) {
		const db = mkKvDb();
		const { router, calls } = makeRouter(db, function* () {
			yield { type: 'reasoning', text: '结果是 {"ok":true}' };
			yield { type: 'finish', reason: finishKind === 'error' ? { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } : { kind: 'stop' } };
		});
		const got = await router.call('出 JSON', { maxTokens: 1200, feature: 'slang', thinkFallback: true });
		assert.equal(got, '结果是 {"ok":true}');
		assert.equal(calls.length, 1, `thinkFallback(${finishKind}) 不该触发 roomy 重试`);
		assert.deepEqual(getKv(db, 'llm.roomy', []), []);
		const stats = router.usage(1).byFeature.slang;
		assert.equal(stats.calls, 1);
		assert.equal(stats.failed, 0, `thinkFallback(${finishKind}) 救回来的不该算失败`);
	}
	console.log('✓ LlmRouter thinkFallback：优先于 roomy 抢救思考 JSON，且不误计失败');
}

// 3. LlmRouter 已 abort 的带图调用：不再退回纯文字重试，且给出 timeout 错误码
{
	const db = mkKvDb();
	const ac = new AbortController();
	const { router, calls } = makeRouter(db, async function* () {
		ac.abort();
		throw new Error('aborted');
	});
	const info = { code: '' };
	const got = await router.call('看图', { signal: ac.signal, images: [{ data: 'AAAA', mediaType: 'image/png' }], failureInfo: info });
	assert.equal(got, null);
	assert.equal(calls.length, 1, '已超时的带图调用不该再发纯文字重试');
	assert.equal(info.code, 'timeout');
	console.log('✓ LlmRouter 超时带图调用：不再退回纯文字重试');
}

// 4. LlmRouter 按模型连续失败冷却（熔断 + 指数退避 + 恢复探测）
{
	const db = mkKvDb();
	let nowMs = 1_000_000;
	let primaryFail = true;
	const { router, calls } = makeRouter(db, function* (idx, o) {
		if (o.model === 'bad-model') {
			if (primaryFail) throw new Error('upstream 500');
			yield { type: 'text-delta', text: '恢复了' };
			return;
		}
		if (o.model === 'good-host') {
			yield { type: 'text-delta', text: '兜底成功' };
		}
	}, {
		cfg: { models: { slang: { provider: 'p1', model: 'bad-model' } } },
		host: { provider: 'p1', model: 'good-host' },
		now: () => nowMs
	});

	for (let i = 0; i < 3; i++) assert.equal(await router.call('q', { feature: 'slang' }), '兜底成功');
	assert.equal(calls.filter((c) => c.model === 'bad-model').length, 3, '前 3 次正常尝试主模型');

	// 第 4 次：主模型已在 5 分钟冷却期，直接跳过主模型走健康兜底
	assert.equal(await router.call('q', { feature: 'slang' }), '兜底成功');
	assert.equal(calls.filter((c) => c.model === 'bad-model').length, 3, '冷却期内不再打主模型');

	// 无健康兜底时：直接快速失败（不发起流式调用、不计入 usage.calls）
	const dbNoFb = mkKvDb();
	let now2 = 2_000_000;
	const rNoFb = makeRouter(dbNoFb, function* () { throw new Error('boom'); }, { now: () => now2 });
	for (let i = 0; i < 3; i++) await rNoFb.router.call('q', { feature: 'slang' });
	const beforeCalls = rNoFb.router.usage(1).byFeature.slang.calls;
	const fi = { code: '' };
	assert.equal(await rNoFb.router.call('q', { feature: 'slang', failureInfo: fi }), null);
	assert.equal(fi.code, 'cooldown');
	assert.equal(rNoFb.calls.length, 3, '冷却期内快速失败，不调底层 stream');
	assert.equal(rNoFb.router.usage(1).byFeature.slang.calls, beforeCalls, '冷却期内跳过不计入调用次数');

	// 推进 5 分钟后再失败 1 次 → 冷却翻倍到 10 分钟
	now2 += 5 * 60_000 + 1;
	await rNoFb.router.call('q', { feature: 'slang' }); // streak=4 -> 10m cooldown
	assert.equal(rNoFb.calls.length, 4);
	now2 += 5 * 60_000 + 1; // 仅过 5 分钟仍在 10 分钟冷却中
	const fi2 = { code: '' };
	assert.equal(await rNoFb.router.call('q', { feature: 'slang', failureInfo: fi2 }), null);
	assert.equal(fi2.code, 'cooldown');
	assert.equal(rNoFb.calls.length, 4);

	// 主模型冷却到期后恢复成功 → 清零 streak
	nowMs += 5 * 60_000 + 1;
	primaryFail = false;
	assert.equal(await router.call('q', { feature: 'slang' }), '恢复了');
	assert.equal(calls.filter((c) => c.model === 'bad-model').length, 4);
	assert.equal(router.inCooldown('p1/bad-model'), false);
	console.log('✓ LlmRouter 模型冷却：3 次失败后跳过主模型并指数退避，恢复后重置');
}

// 5. WeeklyCompressor：maxTokens >= 1500，失败后指数退避（1h -> 2h）避免 30m 无限重试与反复快照
{
	const home = tmpHome('fish-weekly-backoff-');
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const { insertMemory } = await import('../lib/soul-memory.js');
	const { WeeklyCompressor, weekStart } = await import('../lib/weekly.js');
	const db = openDatabase();
	try {
		let nowMs = Date.parse('2026-11-16T02:00:00Z');
		const clock = { now: () => nowMs };
		const prevWeek = weekStart(nowMs) - 1000;
		insertMemory(db, null, { ownerId: 'user:a', channel: 'private', channelId: 'private:a', kind: 'episode', content: '上周的记录' }, prevWeek);
		const seenOpts = [];
		let shouldFail = true;
		const svc = new WeeklyCompressor({
			db, clock, worker: { enqueueRealtime() {} }, getConfig: () => ({ weeklyAuto: true }),
			callLlm: async (_p, opts) => { seenOpts.push(opts); return shouldFail ? null : '上周摘要'; }
		});
		assert.equal((await svc.runOne()).ok, false);
		assert.equal(seenOpts[0].maxTokens, 1500, '周记预算应提到 1500');
		assert.ok(svc.retryAfter >= nowMs + 60 * 60_000, '首次失败退避至少 1 小时');
		// 未过退避期：模拟 start 的门控条件
		nowMs += 30 * 60_000;
		assert.equal(nowMs < svc.retryAfter, true, '30 分钟后仍在退避期内');
		nowMs += 30 * 60_000;
		assert.equal(nowMs >= svc.retryAfter, true, '1 小时后允许再试');
		assert.equal((await svc.runOne()).ok, false);
		assert.ok(svc.retryAfter >= nowMs + 2 * 60 * 60_000, '连续第 2 次失败退避翻倍到 2 小时');
		nowMs += 2 * 60 * 60_000;
		shouldFail = false;
		assert.equal((await svc.runOne()).ok, true);
		assert.equal(svc.failStreak, 0);
		assert.equal(svc.retryAfter, 0);
		console.log('✓ WeeklyCompressor：maxTokens=1500 与失败退避（1h → 2h）');
	} finally { db.close(); rmSync(home, { recursive: true, force: true }); }
}

// 6. SlangLearner：去掉 drop、限制词表、2000/thinkFallback、<think> 解析、失败退避不饿死其他群
{
	const db = mkKvDb();
	let nowMs = Date.parse('2026-11-16T00:00:00Z');
	const prompts = [];
	const llmOpts = [];
	const callsByCh = [];
	const sl = new SlangLearner({
		db, now: () => nowMs, getConfig: () => ({ enabled: true, expressions: false, privateChats: false, minLines: 10, intervalHours: 6 }),
		personaName: () => '小鱼', titleOf: (c) => c,
		callLlm: async (p, o) => {
			prompts.push(p); llmOpts.push(o);
			if (p.includes('group:1')) { callsByCh.push('group:1'); return null; }
			callsByCh.push('group:2');
			return '<think>先想一下</think>{"terms":[{"term":"稳了","meaning":"没问题","example":"这把稳了"}],"style":"短句"}';
		}
	});
	// 塞满 30 个已有词验证提示词截断和 drop 移除
	for (let i = 0; i < 30; i++) sl.edit('group:1', { add: { term: `梗${i}`, meaning: 'a'.repeat(60) } });
	for (let i = 0; i < 10; i++) {
		sl.observe('group:1', '甲', `群1第${i}句`);
		sl.observe('group:2', '乙', `群2第${i}句`);
	}
	await sl.tick(); // 命中 group:1 失败
	assert.deepEqual(callsByCh, ['group:1']);
	assert.equal(llmOpts[0].maxTokens, 2000);
	assert.equal(llmOpts[0].thinkFallback, true);
	assert.equal(prompts[0].includes('"drop"'), false, '提示词不再带无效 drop 字段');
	assert.equal(prompts[0].includes('梗0='), false, '已有词表只带前 20 条');
	assert.ok(sl.data('group:1').retryAfter >= nowMs + 30 * 60_000);

	// 10 分钟后的下一个 tick：跳过冷却中的 group:1，直接处理 group:2 且能解析 <think> 包裹的 JSON
	nowMs += 10 * 60_000;
	await sl.tick();
	assert.deepEqual(callsByCh, ['group:1', 'group:2'], '失败群退避期间不再饿死 group:2');
	assert.equal(sl.data('group:2').terms[0].term, '稳了');
	console.log('✓ SlangLearner：精简提示词、2000/thinkFallback、<think>解析与分群退避');
}

// 7. LifeEngine Dream：2000/thinkFallback、<think>解析、失败按人退避不饿死他人、用户打断不触发退避
{
	const home = tmpHome('fish-dream-backoff-');
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const { insertMemory } = await import('../lib/soul-memory.js');
	const { LifeEngine } = await import('../lib/life.js');
	const db = openDatabase();
	try {
		let nowReal = 5_000_000;
		const nowVirtual = Date.parse('2026-11-16T12:00:00Z');
		const clock = { now: () => nowVirtual };
		insertMemory(db, null, { ownerId: 'user:bad', channel: 'qq-private', channelId: 'private:1', kind: 'fact', content: '坏主人的记忆' }, nowVirtual - 4 * 3600_000);
		insertMemory(db, null, { ownerId: 'user:ok', channel: 'qq-private', channelId: 'private:2', kind: 'fact', content: '好主人的记忆' }, nowVirtual - 4 * 3600_000);
		const dreamCalls = [];
		const engine = new LifeEngine({
			db, clock, realNow: () => nowReal, getConfig: () => ({}), deliver: async () => true,
			callLlm: async (p, o) => {
				dreamCalls.push({ p, o });
				if (p.includes('user:bad')) return null;
				return '<think>整理好了</think>{"missedPending":[],"suggestedRelationStage":null,"outdated":[],"corrected":[]}';
			}
		});
		engine.lastInteractionVirtualMs.set('user:bad', nowVirtual - 4 * 3600_000);
		engine.lastInteractionVirtualMs.set('user:ok', nowVirtual - 4 * 3600_000);

		await engine.maybeDream();
		assert.equal(dreamCalls.length, 1);
		assert.equal(dreamCalls[0].o.maxTokens, 2000);
		assert.equal(dreamCalls[0].o.thinkFallback, true);
		assert.ok((engine.dreamFailBackoff.get('user:bad')?.until ?? 0) >= nowReal + 30 * 60_000);

		// 1 分钟后（>30s DREAM_MIN_REAL_GAP_MS）再 tick：跳过退避中的 user:bad，成功整理 user:ok
		nowReal += 60_000;
		await engine.maybeDream();
		assert.equal(dreamCalls.length, 2);
		assert.match(dreamCalls[1].p, /user:ok/);
		assert.ok(getKv(db, 'dream.watermark.user:ok', 0) > 0, 'user:ok 成功推进水位');

		// 用户打断导致的 abort 不计入失败退避
		insertMemory(db, null, { ownerId: 'user:abort', channel: 'qq-private', channelId: 'private:3', kind: 'fact', content: '被打断的记忆' }, nowVirtual - 4 * 3600_000);
		const engineAbort = new LifeEngine({
			db, clock, realNow: () => nowReal, getConfig: () => ({}), deliver: async () => true,
			callLlm: async (_p, o) => { engineAbort.noteInteraction('user:abort'); return null; }
		});
		await engineAbort.runDream('user:abort');
		assert.equal(engineAbort.dreamFailBackoff.has('user:abort'), false, '用户打断不算模型失败退避');
		console.log('✓ LifeEngine Dream：2000/thinkFallback、<think>解析、按人退避与打断豁免');
	} finally { db.close(); rmSync(home, { recursive: true, force: true }); }
}

// 8. ChatDigester (extract)：2000/thinkFallback、<think>解析、失败 5m→10m 退避且连续 5 次丢弃毒批
{
	const home = tmpHome('fish-extract-backoff-');
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const { ChatJournal, ChatDigester } = await import('../lib/soul-memory.js');
	const db = openDatabase();
	try {
		let nowMs = 20_000_000;
		const clock = { now: () => nowMs };
		const journal = new ChatJournal();
		journal.add('private:100', { ownerId: 'user:100', who: '阿明', text: '我明天去面试', at: nowMs });
		let llmCalls = 0;
		let returnVal = null;
		const digester = new ChatDigester({
			db, clock, journal, worker: { enqueueRealtime() {} },
			now: () => nowMs,
			getConfig: () => ({ enabled: true, idleMinutes: 10, maxLines: 40 }),
			related: () => [], findOwnerByName: () => null, personaName: () => '小鱼', titleOf: () => '阿明'
			, callLlm: async (_p, o) => {
				llmCalls++;
				assert.equal(o.maxTokens, 2000);
				assert.equal(o.thinkFallback, true);
				return returnVal;
			}
		});
		// 11 分钟后首次到期并失败
		nowMs += 11 * 60_000;
		await digester.check();
		assert.equal(llmCalls, 1);
		assert.equal(journal.pendingCount(), 1, '第 1 次失败应放回待整理');

		// 30 秒 / 4 分钟后再 check：退避中不再触发
		nowMs += 4 * 60_000;
		await digester.check();
		assert.equal(llmCalls, 1, '5 分钟退避期内不重复打模型');

		// 推进到第 2、3、4、5 次失败后，毒批被丢弃
		for (const waitMin of [1, 10, 20, 40]) {
			nowMs += waitMin * 60_000 + 1;
			await digester.check();
		}
		assert.equal(llmCalls, 5);
		assert.equal(journal.pendingCount(), 0, '连续失败 5 次应丢弃毒批不再循环');

		// 新消息进来后，<think> 包裹的 JSON 能成功解析
		journal.add('private:100', { ownerId: 'user:100', who: '阿明', text: '面试过了', at: nowMs });
		nowMs += 11 * 60_000;
		returnVal = '<think>分析一下</think>{"memories":[],"outdated":[],"self":[],"summary":"聊面试","people":[]}';
		await digester.check();
		assert.equal(llmCalls, 6);
		assert.equal(journal.pendingCount(), 0);
		console.log('✓ ChatDigester：5m 指数退避、连续 5 次丢弃毒批与 <think> 解析');
	} finally { db.close(); rmSync(home, { recursive: true, force: true }); }
}

console.log('llm-failure-backoff: all assertions passed');
