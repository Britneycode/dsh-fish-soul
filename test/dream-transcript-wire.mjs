// 接线层：确认 Dream 的原文**真的从 ChatArchive 流到 LLM 的 prompt**，
// 而且是通过 index.js 的接线（不是测试自己 new 一个）——防止「模块写好了但没接上」。
//
// 这一条守的是上一版最容易漏的形态：lib/memory-label.js / transcriptSample 都写好了、
// 单测也绿，但 apply() 里没把 chatArchive 传进去 = 线上等于没有。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-dw-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const db = openDatabase();
const { LifeEngine } = await import('../lib/life.js');
const { ChatArchive } = await import('../lib/chat-archive.js');

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

// ── ① 接线存在：index.js 把 chatArchive 交给 LifeEngine ──
{
	assert.match(src, /transcripts\s*:\s*chatArchive|get transcripts\(\)\s*\{\s*return chatArchive/, 'index.js 要把 chatArchive 交给 LifeEngine');
	// 存下来那一半在 LifeEngine 里
	const lifeSrc = readFileSync(new URL('../lib/life.js', import.meta.url), 'utf8');
	assert.match(lifeSrc, /this\.transcripts|defineProperty\(this,\s*'transcripts'/, 'LifeEngine 要存下 transcripts');
	assert.match(lifeSrc, /transcriptSample\(/, 'LifeEngine 要有取样方法');
}

// ── ② 延迟取值：不能是解构（chatArchive 建得比 LifeEngine 晚）──
{
	// 完全照 index.js 的写法：传一个 getter，构造时那个值还不存在（= undefined）
	const box = { archive: undefined };
	const life = new LifeEngine({
		db, clock: { now: () => Date.now() }, getConfig: () => ({ memory: { transcriptReview: true } }),
		callLlm: async () => '{}', deliver: async () => true, log: () => {}, persona: () => ({}),
		get transcripts() { return box.archive; },
	});
	// 构造完之后才把 archive 挂上（这就是 index.js 的真实顺序）
	const archive = new ChatArchive({ getConfig: () => ({ chatArchive: { enabled: true, channels: [], days: 30 } }), log: () => {} });
	archive.add('qq:10001', { who: '10001', text: '我搬去杭州了' });
	box.archive = archive;

	const now = Date.now();
	db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, importance, created_at, updated_at, status, evidence)
		VALUES ('feiyu', 'user:master', 'qq-private', '10001', 'fact', '主人住在成都', 2, ?, ?, 'active', '主人说的')`).run(now, now);

	let prompt = '';
	life.callLlm = async (p) => { prompt = p; return '{}'; };
	await life.runDream('user:master');
	assert.match(prompt, /我搬去杭州了/, '构造之后才挂上的存档也要能取到原文（延迟取值）');
	archive.stop();
}

// ── ③ 时间窗要往前留缓冲（真 bug：记忆是整理出来的，原文一定比它早）──
{
	const box2 = { archive: undefined };
	const life = new LifeEngine({
		db, clock: { now: () => Date.now() }, getConfig: () => ({ memory: { transcriptReview: true } }),
		callLlm: async () => '{}', deliver: async () => true, log: () => {}, persona: () => ({}),
		get transcripts() { return box2.archive; },
	});
	const archive = new ChatArchive({ getConfig: () => ({ chatArchive: { enabled: true, channels: [], days: 30 } }), log: () => {} });
	// 原文比记忆早（真实情况就是这样：先聊天，聊完才整理出记忆）
	archive.add('qq:10001', { who: '10001', text: '我上个月搬去杭州了' });
	box2.archive = archive;

	// 记忆的时间「现在」；原文也在「现在」——差不到 1 毫秒的那种极限情况
	const now = Date.now();
	const out = life.transcriptSample('user:master', [{ id: 1, created_at: now }], { qq_uin: '10001', display_name: '主人' });
	assert.match(out, /我上个月搬去杭州了/, '原文比记忆早一点也必须取得到（时间窗要往前留缓冲）');
	archive.stop();
}

// ── ④ 手动入口存在：/inspector/dream 走的就是同一个 runDream ──
{
	const routes = readFileSync(new URL('../lib/routes-soul.js', import.meta.url), 'utf8');
	assert.match(routes, /path === '\/inspector\/dream'/, '要有一个「现在整理一次」的入口');
	assert.match(routes, /await life\.runDream\(ownerId\)/, '入口必须走同一个 runDream（不然规则不一样）');
	// 防重入：不能两个 dream 同时跑
	assert.match(routes, /isDreamRunning/, '并发时要拒绝');
}

db.close();
console.log('✓ Dream 原文接线：真接上了、延迟取值成立、手动入口走同一条路');
