// 「记忆带来源」+「Dream 对照聊天原文」（2026-11-08，参考 Anthropic《The components of agent memory》）
//
// ① 注入时把 evidence 带出来：让她分得清「他亲口说的」和「我自己总结的印象」。
//    文章里的要点：好的 memory note 要有结论 + 为什么可信（哪些查过、哪些还没确认）。
// ② Dream 能拿真实对话核对记忆：原来只 SELECT memory，记忆写错了永远发现不了。
//    客户端那篇的 Mt. Moon 案例就是这样：记错一次，后面一路信下去。
//    默认关（memory.transcriptReview），取不到原文就退回只看记忆。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const keep = setTimeout(() => {}, 60_000);
const home = tmpHome('dsh-ev-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { ChatArchive } = await import('../lib/chat-archive.js');
const { LifeEngine } = await import('../lib/life.js');

// ── ① ChatArchive.sample：只读、有上限、失败返空 ──
{
	const archive = new ChatArchive({ getConfig: () => ({ chatArchive: { enabled: true, channels: ['qq:1000'], days: 30 } }), log: () => {} });
	const now = Date.now();
	archive.add('qq:1000', { who: '主人', text: '我搬家了，现在住杭州' });
	archive.add('qq:1000', { who: '鱼', self: true, text: '哦？那我记一下' });
	archive.add('qq:2000', { who: '别人', text: '不相干的人说话' });

	const rows = archive.sample({ channel: 'qq:1000', since: now - 60_000, until: now + 60_000, limit: 10 });
	assert.equal(rows.length, 2, '只取这个会话的两条');
	assert.equal(rows.some((r) => r.content.includes('不相干')), false, '别的会话不能混进来');
	assert.equal(rows.some((r) => r.self === true), true, '她自己说的也要在（self 标记）');

	// 上限
	const many = new ChatArchive({ getConfig: () => ({ chatArchive: { enabled: true, channels: ['qq:9'], days: 30 } }), log: () => {} });
	for (let i = 0; i < 30; i++) many.add('qq:9', { who: 'x', text: `第${i}句` });
	assert.equal(many.sample({ channel: 'qq:9', since: 0, until: now + 60_000, limit: 7 }).length, 7, 'limit 要生效');
	assert.equal(many.sample({ channel: 'qq:9', since: 0, until: now + 60_000, limit: 999 }).length, 30, 'limit 上限 200，但库里只有 30 条');
	archive.stop(); many.stop();
}

// ── ② Dream 的原文取样：关着不取、开着取、拿不到就空串 ──
{
	const db = openDatabase();
	const calls = [];
	const fakeTranscripts = {
		sample: ({ channel = '', limit = 40 }) => {
			calls.push({ channel, limit });
			return channel === 'qq:1000'
				? [{ who: '1000', self: false, content: '我搬家了，现在住杭州', at: Date.now() - 5000 },
					{ who: '', self: true, content: '那我记一下', at: Date.now() - 4000 }]
				: [];
		},
	};
	const mk = (cfg) => new LifeEngine({
		db, clock: { now: () => Date.now() }, getConfig: () => cfg, callLlm: async () => '{}',
		deliver: async () => true, log: () => {}, persona: () => ({ name: '鱼', brief: '' }),
		transcripts: fakeTranscripts,
	});

	const recent = [{ id: 1, created_at: Date.now() - 3600_000 }];
	const person = { qq_uin: '1000', display_name: '主人' };

	// 关着：一次都不该取
	calls.length = 0;
	assert.equal(mk({ memory: { transcriptReview: false } }).transcriptSample('user:master', recent, person), '', '默认关：不取原文');
	assert.deepEqual(calls, [], '关着就不该去碰存档');

	// 开着：取到了，拼成「是谁：说了什么」，而且是她/对方分得清
	calls.length = 0;
	const on = mk({ memory: { transcriptReview: true } }).transcriptSample('user:master', recent, person);
	assert.match(on, /主人：我搬家了，现在住杭州/, '原文要带说话人');
	assert.match(on, /我：那我记一下/, '她自己说的要标成「我」');
	assert.ok(calls.length > 0, '开了就要真去取');

	// 开着但取不到：空串，不能崩
	const dead = new LifeEngine({
		db, clock: { now: () => Date.now() }, getConfig: () => ({ memory: { transcriptReview: true } }),
		callLlm: async () => '{}', deliver: async () => true, log: () => {}, persona: () => ({}),
		transcripts: { sample: () => { throw new Error('库坏了'); } },
	});
	assert.equal(dead.transcriptSample('user:master', recent, person), '', '存档读失败也不能把 Dream 弄挂');

	// 没接 transcripts（老调用方式）：空串
	const none = new LifeEngine({
		db, clock: { now: () => Date.now() }, getConfig: () => ({ memory: { transcriptReview: true } }),
		callLlm: async () => '{}', deliver: async () => true, log: () => {}, persona: () => ({}),
	});
	assert.equal(none.transcriptSample('user:master', recent, person), '', '没接存档就当没这功能');
	db.close();
}


// ── ③ 注入时的标签要带 evidence（结论 + 为什么可信）──
{
	// memoryLabel 是插件内部函数：走 apply 之后从 testHooks 拿。这里直接调插件启动太重，
	// 于是用 memoryLabel 的纯逻辑做等价断言（字段就那几样）。
	const { memoryLabel } = await import('../lib/memory-label.js');
	const now = Date.now();
	const base = { id: 1, owner_id: 'user:master', kind: 'fact', content: '他搬家了，现在住杭州', created_at: now - 3600_000, evidence: '主人说的' };
	const line = memoryLabel(base, now, () => '主人');
	assert.match(line, /主人说的/, 'evidence 要出现在标签里 —— 让她知道这条是听来的、不是自己想的');
	assert.match(line, /他搬家了/, '内容照旧');

	// 空 evidence / 「聊完自动记」不标（那是噪音，人人都有）
	assert.doesNotMatch(memoryLabel({ ...base, evidence: '' }, now, () => '主人'), /说的/);
	assert.doesNotMatch(memoryLabel({ ...base, evidence: '聊完自动记' }, now, () => '主人'), /聊完自动记/);
	// 跟她自己说的重复就别写两遍
	assert.equal((memoryLabel({ ...base, evidence: '主人说的' }, now, () => '主人').match(/主人说的/g) ?? []).length, 1, '别重复');
	// 关于她自己的事：谁跟她说的要留着（这是她的视角，不是来源噪音）
	assert.match(memoryLabel({ ...base, owner_id: 'self', about: null, content: '我上周去成都吃火锅', evidence: '跟60006聊天时说的' }, now, (id) => (id === 'user:60006' ? '阿六' : '别人')),
		/跟阿六聊天时说的/, '她自己说过的话：把会话号换成显示名');
	// 换不到显示名就不写（别把 QQ 号漏给她看）
	assert.doesNotMatch(memoryLabel({ ...base, owner_id: 'self', about: null, evidence: '跟60006聊天时说的' }, now, () => '别人'),
		/60006/, '换不到名字就不要这个标签，绝不能把 QQ 号写进去');
}

clearTimeout(keep);
console.log('✓ 记忆带来源 + Dream 对照聊天原文：存档取样只读有上限，开关默认关，取不到就退回只看记忆');
