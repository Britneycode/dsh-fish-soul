// #181 推理模型回空正文：别为「注定还是空」的重试烧钱，也别让重启把学到的名单清掉。
//
// 真机症状：
//   ① 推理模型把 1500 的额度全花在思考上 → 正文空 + finish=max-tokens。
//      旧代码判定「额度不够」，放大到 8000 再试一次 —— 思考动辄 13k token，那次**必然又是空**，纯烧钱。
//   ② roomy（吃过空回复的模型名单）是纯内存 Set，重启即清 ⇒ 每次重启第一枪都要白卷一次。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LlmRouter } from '../lib/llm.js';
import { getKv } from '../lib/db.js';

const ROOMY_TOKENS = 8000;

/** 造一个宿主：listProviders/listModels 给出 p1/m1，stream 按脚本吐块并记下每次要的额度。 */
function makeRouter(db, script, cfg = {}) {
	const budgets = [];
	const ctx = {
		get: (n) => {
			if (n === 'llm') return {
				listProviders: () => [{ id: 'p1', name: 'P1' }],
				listModels: async () => [{ id: 'm1', name: 'M1' }],
				async *stream(o) {
					budgets.push(o.maxTokens);
					yield* script(budgets.length - 1, o);
				}
			};
			return undefined; // 没有 agentDefaultModel ⇒ fallback 直接放弃，call 返回 null
		}
	};
	const logs = [];
	const router = new LlmRouter({ ctx, db, getConfig: () => cfg, log: (l, m) => logs.push(`${l}: ${m}`) });
	return { router, budgets, logs };
}

const mkdb = () => {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	return db;
};

/** 只有思考、没有正文，结束原因 max-tokens（= 额度被思考吃光）。 */
function* thinkOnly() {
	yield { type: 'reasoning', text: '想了很久'.repeat(20) };
	yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1500 } };
	yield { type: 'finish', reason: { kind: 'max-tokens' } };
}

/** 正文空、也没有思考，结束原因 max-tokens（= 真的是额度不够，该放大重试）。 */
function* emptyNoThink() {
	yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } };
	yield { type: 'finish', reason: { kind: 'max-tokens' } };
}

// ① 思考吃光额度 → 不放大重试（那次注定还是空），也不把这个模型记进 roomy
{
	const db = mkdb();
	const { router, budgets } = makeRouter(db, thinkOnly);
	const r = await router.call('随便问一句', { maxTokens: 1500 });
	assert.equal(r, null, '没兜底模型就是 null');
	assert.equal(budgets.length, 1, `额度被思考吃光就别再试一次，实际问了 ${budgets.length} 次（额度 ${budgets.join(' → ')}）`);
	assert.deepEqual(budgets, [1500], '没放大到 roomy 额度');
	assert.deepEqual(getKv(db, 'llm.roomy', []), [], `抬额度只会烧更多思考费，不该记进 roomy，实际：${JSON.stringify(getKv(db, 'llm.roomy', []))}`);
	console.log('✓ #181 思考吃光额度：不再放大重试（注定是空的那一枪省掉了）');
}

// ② 真的额度不够（没有思考）→ 放大重试一次，并把模型记进 roomy + 落库
{
	const db = mkdb();
	const { router, budgets } = makeRouter(db, emptyNoThink);
	const r = await router.call('随便问一句', { maxTokens: 1500 });
	assert.equal(r, null);
	assert.equal(budgets.length, 2, `该重试一次，实际问了 ${budgets.length} 次`);
	assert.deepEqual(budgets, [1500, ROOMY_TOKENS], '第二次要放大到推理模型额度');
	assert.deepEqual(getKv(db, 'llm.roomy', []), ['p1/m1'], `roomy 要落 kv，实际：${JSON.stringify(getKv(db, 'llm.roomy', []))}`);
	console.log('✓ #181 真空回复：放大重试照旧，名单落库');
}

// ③ 重启（新的 router 同一个库）→ 第一枪就用大额度，不再白卷一次
{
	const db = mkdb();
	const first = makeRouter(db, emptyNoThink);
	await first.router.call('随便问一句', { maxTokens: 1500 });
	assert.deepEqual(getKv(db, 'llm.roomy', []), ['p1/m1'], '前置：名单已落库');
	// 重启：全新实例（内存 Set 没了），库还在
	const second = makeRouter(db, emptyNoThink);
	await second.router.call('随便问一句', { maxTokens: 1500 });
	assert.deepEqual(second.budgets, [ROOMY_TOKENS], `重启后第一枪就该是大额度，实际：${second.budgets.join(' → ')}`);
	console.log('✓ #181 重启不再清名单：第一枪就给足额度');
}

// ④ 思考里写了答案 + 调用方允许 → 照样能用（跳过重试不能把这个救回来）
{
	const db = mkdb();
	const { router, budgets } = makeRouter(db, function* () {
		yield { type: 'reasoning', text: '我觉得答案是 {"mood":"开心"} 就这样' };
		yield { type: 'finish', reason: { kind: 'max-tokens' } };
	});
	const r = await router.call('判断心情', { maxTokens: 1500, thinkFallback: true });
	assert.equal(r, '我觉得答案是 {"mood":"开心"} 就这样', `思考里的答案要能用，实际：${JSON.stringify(r)}`);
	assert.equal(budgets.length, 1, '不该为它再烧一次');
	console.log('✓ #181 thinkFallback 没被跳过重试弄坏');
}

// ⑤ kv 里的名单是脏数据（手写坏了 / 老版本写的别的形状）→ 退化到「没名单」，调用照旧
{
	const db = mkdb();
	db.prepare("INSERT INTO kv (key, value) VALUES ('llm.roomy', ?)").run('这不是一个数组');
	const { router, budgets } = makeRouter(db, thinkOnly);
	const r = await router.call('随便问一句', { maxTokens: 1500 });
	assert.equal(r, null, '脏名单不该让调用炸掉');
	assert.deepEqual(budgets, [1500], '脏名单当成没名单，不放大');
	console.log('✓ #181 名单是脏数据：当成没名单，不炸');
}

console.log('llm-roomy-budget: all assertions passed');
