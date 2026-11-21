// 抖音视频作品：kind 分流、额度分开记、生成不占浏览器锁、点发布前先持久化。
//
// 不启浏览器：假 driver + 假 host + 假 clock + 假视频生成器，配真 SQLite。
// 视频生成是**按次计费**的写操作，所以这里一律用桩，绝不真去调外部接口。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const home = mkdtempSync(join(tmpdir(), 'fish-video-post-'));
process.env.DSH_HOME = home;
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const { DouyinSocial } = await import('../lib/douyin-social.js');
const { DouyinPostJobs } = await import('../lib/douyin-post-jobs.js');
const db = openDatabase();

// ── B1：老库（没有 kind 列）补列，且重复 new 不炸 ──────────────────────────
const oldDb = new DatabaseSync(join(home, 'old.sqlite'));
oldDb.exec(`CREATE TABLE douyin_post_job (
 id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, role_date TEXT NOT NULL,
 status TEXT NOT NULL, card_path TEXT NOT NULL DEFAULT '', music TEXT NOT NULL DEFAULT '',
 error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
oldDb.prepare("INSERT INTO douyin_post_job(text,role_date,status,created_at,updated_at) VALUES('老作品','2026-11-09','confirmed',1,1)").run();
new DouyinPostJobs(oldDb);
const oldCols = oldDb.prepare('PRAGMA table_info(douyin_post_job)').all().map((r) => r.name);
assert.ok(oldCols.includes('kind'), '老库补上 kind 列');
assert.equal(oldDb.prepare('SELECT kind FROM douyin_post_job WHERE text=?').get('老作品').kind, 'note', '老行按图文算');
new DouyinPostJobs(oldDb); // 再 new 一次（列已存在）不能炸
oldDb.close();

// ── B2 / B3 / B12：kind 挡、pending 参数化、重启恢复按 kind ────────────────
const jobsDb = new DatabaseSync(join(home, 'jobs.sqlite'));
const jobs = new DouyinPostJobs(jobsDb);
const noteId = jobs.begin('图文一', '2026-11-09', 'note');
jobs.submitting(noteId);
assert.throws(() => jobs.begin('图文二', '2026-11-09', 'note'), /结果未知/, '同类有待核实的就不许再开');
const videoId = jobs.begin('视频一', '2026-11-09', 'video');
assert.ok(videoId > 0, '不同类互不挡');
jobs.submitting(videoId);
const jobs2 = new DouyinPostJobs(jobsDb); // 重启：submitting → unknown
assert.equal(jobs2.pending('note')?.id, noteId, 'pending(note) 只看图文');
assert.equal(jobs2.pending('video')?.id, videoId, 'pending(video) 只看视频');
assert.equal(jobs2.pending()?.id, noteId, 'pending() 返回任一（按 id 最早的）');
assert.equal(jobs2.kindOf(videoId), 'video', '重启后 kind 还在');
assert.equal(jobs2.kindOf(noteId), 'note');
assert.equal(jobs2.resolvePublished(videoId), true);
assert.equal(jobs2.pending('video'), null, '核实掉就没有了');
assert.equal(jobs2.pending('note')?.id, noteId, '图文那条不受影响');
assert.equal(jobs2.resolveNotPublished(noteId), true);
assert.equal(jobs2.pending(), null, '一条都不剩');
jobsDb.close();

// ── 抖音那一套（假 driver / 假 host / 假 clock / 假视频生成器） ─────────────
const calls = { renderCard: 0, prepareNote: 0, listRecommendedMusic: 0, closeMusicPanel: 0, publishNote: 0, prepareVideo: 0, publishVideo: 0 };
let musicThrows = false;
// 发布这一步的几种结局：ok（发出去）/ fail（点了但没等到确认）/ needsVerify（要验证）/ notLoggedIn（创作者中心没登录）
let videoMode = 'ok';
let statusAtSubmit = '';
let current = null;
const driver = {
	renderCard: async () => { calls.renderCard++; return Buffer.from('card'); },
	prepareNote: async () => { calls.prepareNote++; return { ok: true }; },
	listRecommendedMusic: async () => { calls.listRecommendedMusic++; if (musicThrows) throw new Error('视频路径不该碰配乐'); return { ok: true, songs: ['歌'] }; },
	closeMusicPanel: async () => { calls.closeMusicPanel++; },
	publishNote: async ({ beforeSubmit }) => { calls.publishNote++; await beforeSubmit(); return { ok: true, musicPicked: true }; },
	prepareVideo: async () => {
		calls.prepareVideo++;
		if (videoMode === 'notLoggedIn') return { ok: false, code: 'NOT_LOGGED_IN', error: '创作者中心没登录：在抖音浏览器里打开 creator.douyin.com 登录一次' };
		return { ok: true };
	},
	publishVideo: async ({ beforeSubmit }) => {
		calls.publishVideo++;
		// 要验证是在点发布**之前**被拦下来的：没点过就不该落「结果未知」。
		if (videoMode === 'needsVerify') return { ok: false, code: 'NEEDS_VERIFY', error: '抖音要验证（短信 / 滑块）才能发' };
		await beforeSubmit();
		statusAtSubmit = String(current.postJobs.pending()?.status ?? '');
		if (videoMode === 'fail') return { ok: false, code: 'NOT_CONFIRMED', error: '点了发布，但没等到「已发布」' };
		return { ok: true };
	},
};
let exclusiveCalls = 0;
const host = { running: true, loggedIn: true, exclusive: async (_label, fn) => { exclusiveCalls++; return await fn(); } };
const clock = { now: () => 100, getRoleDateParts: () => ({ dateStr: '2026-11-09', hour: 12, minute: 0 }) };
const prompts = [];
const callLlm = async (prompt) => {
	if (prompt.includes('配个「心情」')) return '{"mood":"warm","reason":"随手"}';
	if (prompt.includes('配背景音乐')) return '歌';
	prompts.push(prompt);
	return prompt.includes('短视频') ? '厨房的蒸汽糊住了窗' : '今天风挺大的';
};
let genCalls = 0;
let genMode = 'ok';
let exclusiveAtGen = -1;
const videoGen = {
	generate: async (cfg) => {
		genCalls++;
		exclusiveAtGen = exclusiveCalls;
		if (genMode === 'network') return { ok: false, code: 'NETWORK', error: '视频服务连不上', submitted: true };
		if (genMode === 'unsubmitted') return { ok: false, code: 'NOT_CONFIGURED', error: '视频生成还没配好', submitted: false };
		return { ok: true, file: join(home, 'douyin-videos', 'v1.mp4'), bytes: 1024, provider: cfg.provider, elapsedMs: 1000 };
	},
};
const notes = [];
const notifies = [];
const pruned = [];
const config = {
	enabled: true,
	post: { enabled: true, perDay: 1 },
	video: { enabled: true, perDay: 1, provider: 'volc', baseURL: 'https://example.invalid', apiKey: 'k', model: 'm', durationSec: 5, aspectRatio: '9:16', resolution: '768P' },
	comments: { enabled: false, perHour: 4 },
};
const make = () => {
	current = new DouyinSocial({
		db, clock, host, driver, getConfig: () => config, callLlm, persona: () => ({ name: '鱼' }),
		cardDir: join(home, 'cards'), videoGen,
		// 清旧视频的可注入桩：真删盘上的 mp4 不是这个套件要验的东西。
		videoPrune: (dir) => { pruned.push(dir); },
		note: (k, x) => notes.push({ k, ...x }),
		notify: (k, m) => notifies.push({ key: k, msg: m }),
	});
	return current;
};
/** 把当天的视频额度清零（视频一天最多几条，验别的分支前先腾出额度）。 */
// 「花掉的次数」也一起清（douyin.video.gen.day）—— 两笔账要能分别验。
const resetVideoQuota = () => {
	setKv(db, 'douyin.video.day', { date: '2026-11-09', count: 0, tries: 0, lastVirtual: 0 });
	setKv(db, 'douyin.video.gen.day', { date: '2026-11-09', count: 0 });
};

try {
	let s = make();

	// B10：图文 / 视频的提示词分叉（要在任何一条发出去之前查 —— 记忆里会有历史文案）
	const parts = { dateStr: '2026-11-09', hour: 12, minute: 0 };
	const notePrompt = s.postPrompt({ parts, slot: null, mood: '', kind: 'note' });
	const videoPrompt = s.postPrompt({ parts, slot: null, mood: '', kind: 'video' });
	assert.ok(notePrompt.includes('文字卡片'), '图文提示要说清会印成卡片');
	assert.ok(!notePrompt.includes('短视频'), '图文提示不该提短视频');
	assert.ok(!notePrompt.includes('视频'), '图文提示里不该出现「视频」');
	assert.ok(videoPrompt.includes('短视频'), '视频提示要说清是短视频');
	assert.ok(videoPrompt.includes('视频'), '视频提示里要有「视频」');
	assert.ok(!videoPrompt.includes('文字卡片'), '视频提示不该提文字卡片');

	// B8（上半）：发图文只动 douyin.post.day，douyin.video.day 根本不该存在
	let r = await s.post({ force: true });
	assert.equal(r.ok, true, r.error);
	assert.equal(getKv(db, 'douyin.post.day', null)?.count, 1, '图文额度记在 douyin.post.day');
	assert.equal(getKv(db, 'douyin.video.day', null), null, '发图文不该动视频额度');

	// B4 / B5 / B6 / B13 / B14 / B15：发视频
	for (const k of Object.keys(calls)) calls[k] = 0;
	exclusiveCalls = 0;
	genCalls = 0;
	musicThrows = true; // 视频路径要是碰了配乐，这里会抛
	r = await s.post({ force: true, kind: 'video' });
	assert.equal(r.ok, true, r.error);
	assert.equal(exclusiveAtGen, 0, '生成视频不能占着浏览器锁');
	assert.equal(exclusiveCalls, 1, '发布阶段才占锁');
	assert.equal(genCalls, 1, '生成一次');
	assert.equal(calls.listRecommendedMusic, 0, '视频路径不配乐');
	assert.equal(calls.prepareNote, 0, '视频路径不走图文那条路');
	assert.equal(calls.publishNote, 0, '视频路径不走图文那条路');
	assert.equal(calls.renderCard, 0, '视频路径不画卡片');
	assert.equal(calls.prepareVideo, 1, 'prepareVideo 调一次');
	assert.equal(calls.publishVideo, 1, 'publishVideo 调一次');
	assert.equal(statusAtSubmit, 'submitting', '点发布前要先把任务记成 submitting');
	musicThrows = false;

	// B8（下半）+ B15：视频额度单独记
	assert.equal(getKv(db, 'douyin.video.day', null)?.count, 1, '视频额度记在 douyin.video.day');
	assert.equal(getKv(db, 'douyin.post.day', null)?.count, 1, '图文额度不受影响');
	const st = s.status();
	assert.equal(st.video.todayCount, 1, '今天发了几条视频');
	assert.equal(st.video.perDay, 1);
	assert.equal(st.video.enabled, true);
	assert.equal(st.video.running, false);

	// B14：文案里说清楚是「视频」还是「图文」
	const memories = db.prepare("SELECT content FROM memory WHERE content LIKE '我在抖音发了条%' ORDER BY id").all().map((x) => x.content);
	assert.ok(memories.some((c) => c.includes('发了条视频')), '视频的记忆文案要说「视频」');
	assert.ok(memories.some((c) => c.includes('发了条图文')), '图文的记忆文案要说「图文」');
	const reasons = notes.filter((n) => n.k === 'post').map((n) => String(n.reason ?? ''));
	assert.ok(reasons.some((x) => x.includes('发了条视频')), '提示文案要说「视频」');
	assert.ok(reasons.some((x) => x.includes('发了条图文')), '提示文案要说「图文」');

	// B9：额度用完 —— 一次钱都不能花
	const genBefore = genCalls;
	r = await s.post({ force: true, kind: 'video' });
	assert.equal(r.ok, false, '额度用完就不发');
	assert.match(r.error, /最多 1 条/);
	assert.equal(genCalls, genBefore, '额度用完时不能调生成（不花钱）');

	// B7：生成失败 —— 真的调到 videoGen，不发布，任务记成 failed
	resetVideoQuota();
	genMode = 'network';
	const pvBefore = calls.publishVideo;
	const genBeforeFail = genCalls;
	r = await s.post({ force: true, kind: 'video' });
	assert.equal(r.ok, false);
	assert.equal(genCalls, genBeforeFail + 1, 'B7 必须真的调到 videoGen.generate（不能被额度提前拦死空跑）');
	assert.match(String(r.error ?? ''), /视频服务连不上/, '生成失败原因要透出来');
	assert.equal(calls.publishVideo, pvBefore, '生成失败不能去发布');
	const failed = db.prepare("SELECT * FROM douyin_post_job WHERE status='failed' ORDER BY id DESC LIMIT 1").get();
	assert.ok(failed, '任务要记成 failed');
	assert.equal(failed.kind, 'video');
	genMode = 'ok';

	// B12：重启后 submitting 的视频任务变 unknown，kind 还在
	const vid = s.postJobs.begin('视频草稿', '2026-11-09', 'video');
	s.postJobs.submitting(vid);
	s = make();
	const pending = s.postJobs.pending('video');
	assert.equal(pending?.status, 'unknown', '重启后 submitting 要变 unknown');
	assert.equal(pending?.kind, 'video', 'kind 要还在');
	assert.equal(s.postJobs.pending()?.kind, 'video', '面板那条也要带 kind');

	// B11：核实后按 kind 记账（视频记视频的额度）
	const videoCountBefore = getKv(db, 'douyin.video.day', null)?.count ?? 0;
	const postCountBefore = getKv(db, 'douyin.post.day', null)?.count ?? 0;
	assert.equal(s.resolvePost(vid, 'published').ok, true);
	assert.equal(getKv(db, 'douyin.video.day', null)?.count, videoCountBefore + 1, '视频核实后记到视频额度');
	assert.equal(getKv(db, 'douyin.post.day', null)?.count, postCountBefore, '图文额度不动');

	// B23 / B24：视频文件落账 + 发完清旧 mp4 ────────────────────────────────
	//
	// B23 守的是「崩了也知道视频在哪」：prepared() 把 mp4 路径记进账本，
	//      删掉这行 ⇒ 崩了只能重新生成（再花一次钱），而测试照样绿。
	// B24 守的是「盘上不能无限堆 mp4」：单条上限 100MB，不清理就是真金白银在涨。
	{
		resetVideoQuota();
		videoMode = 'ok';
		pruned.length = 0;
		const genBefore = genCalls;
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, true, r.error);
		assert.equal(genCalls, genBefore + 1, '发一次生成一次');
		const row = db.prepare("SELECT * FROM douyin_post_job WHERE kind='video' ORDER BY id DESC LIMIT 1").get();
		assert.equal(row.status, 'confirmed', '发成功了任务要落 confirmed');
		assert.equal(row.card_path, join(home, 'douyin-videos', 'v1.mp4'), '账本要记下 mp4 的路径（崩了知道视频在哪）');
		assert.equal(pruned.length, 1, '发完要调一次清理');
		assert.equal(pruned[0], s.videoDir, '清理的就是视频目录（跟生成落盘的是同一个）');
	}

	// B21：碰到验证 → 退避计数 + 停一段时间 + 提醒主人 ────────────────────
	{
		resetVideoQuota();
		videoMode = 'needsVerify';
		const before = Number(getKv(db, 'douyin.verify.count', 0)) || 0;
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, false, '要验证时发不出去');
		assert.equal(Number(getKv(db, 'douyin.verify.count', 0)) || 0, before + 1, '碰到验证要涨退避计数');
		assert.ok(s.blockedUntil > Date.now(), '碰到验证要停一段时间');
		assert.ok(notifies.some((x) => x.key === 'douyin.verify'), '要提醒主人去验证');
		// 验证是点发布**之前**被拦的 ⇒ 任务落 failed（不是 unknown），不挡后面的发布
		assert.equal(s.postJobs.pending('video'), null, '没点过发布就不该落「结果未知」');
		setKv(db, 'douyin.verify.count', 0);
		s = make();
	}

	// B22：创作者中心没登录 → 提醒主人去登录，且失败路径也要清理旧 mp4 ─────────
	{
		resetVideoQuota();
		videoMode = 'notLoggedIn';
		notifies.length = 0;
		pruned.length = 0;
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, false, '没登录发不出去');
		assert.equal(pruned.length, 1, '发布失败路径也要清旧视频（防百 MB mp4 长期堆积）');
		const n = notifies.find((x) => x.key === 'douyin.creator');
		assert.ok(n, '要提醒主人创作者中心没登录');
		assert.match(String(n.msg ?? ''), /创作者中心没登录/, '提醒里要说清是没登录');
		assert.equal(s.postJobs.pending('video'), null, '没传上去就不该落「结果未知」');
	}

	// B25：这次没被拦 → 验证计数清零（跟 blocked() 是一对） ───────────────────
	//
	// blocked() 涨「连续被拦的次数」，verifyCleared() 把它清零：验证过去了，下次从 6 小时起算。
	// 视频路径上也必须调 —— 不然一条视频发成功，图文那边还在按「连续第 3 次被拦」退避 24 小时。
	{
		resetVideoQuota();
		videoMode = 'ok';
		setKv(db, 'douyin.verify.count', 3);
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, true, r.error);
		assert.equal(Number(getKv(db, 'douyin.verify.count', 0)) || 0, 0, '发成功了要把验证计数清零（下次从 6 小时起算）');
	}

	// B26：钱花出去的次数也受每日上限保护（force 也不例外） ─────────────────
	//
	// 「今天最多几条」护的是**发成功的条数**：生成成功但发布失败时 count 不涨 ⇒
	// 再点一次「现在发一条」又生成一条 = 又花一次钱，当天能点出好几笔钱。
	// 所以另记一笔「今天生成过几条」，在 generate 之前就卡住。
	{
		resetVideoQuota();
		videoMode = 'notLoggedIn'; // 生成成功、发布失败：钱花了，作品没发出去
		const genBefore = genCalls;
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, false, '没登录发不出去');
		assert.equal(genCalls, genBefore + 1, '生成过一次（钱花出去了）');
		// 再点一次「现在发一条」：不许再生成，且重建 DouyinSocial（模拟重启）依然受保护
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, false, '今天花过钱了就不该再生成');
		assert.match(String(r.error ?? ''), /最多 1 条/, '要提示今天已经用完当天的量');
		assert.equal(genCalls, genBefore + 1, '不能再生成（不花钱）');
		s = make();
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, false, '重启后花过的次数仍落库拦截');
		assert.equal(genCalls, genBefore + 1, '重启后依然不能再生成');
	}

	// B27：零费用本地校验拦截（submitted=false）不扣当天生成额度 ────────────────
	{
		resetVideoQuota();
		videoMode = 'ok';
		genMode = 'unsubmitted';
		const genBefore = genCalls;
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, false);
		assert.equal(genCalls, genBefore + 1);
		assert.equal(getKv(db, 'douyin.video.gen.day', null)?.count, 0, 'submitted=false 的零费用拦截要回退花钱次数');
		genMode = 'ok';
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, true, `改好配置后当天应可重试：${r.error}`);
	}

	// B20：点了发布但没等到确认 → 落 unknown，后续发布被拦住 ────────────────
	//
	// 「可能已经发出去了」⇒ 不能自动重发（重发 = 再生成一条 = 再花一次钱），
	// 必须人去创作者中心核实。这条语义之前只在账本层测过，social 层没接上。
	{
		resetVideoQuota();
		videoMode = 'fail';
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, false, '没等到确认就是没发成');
		assert.match(String(r.error ?? ''), /未知/, '要提示结果未知（可能已经发出，要人工核实）');
		assert.equal(s.postJobs.pending('video')?.status, 'unknown', '点了发布但没等到结果 → 任务落 unknown');
		const genBefore = genCalls;
		r = await s.post({ force: true, kind: 'video' });
		assert.equal(r.ok, false, '有未核实的作品时不该再发');
		assert.match(String(r.error ?? ''), /未知/);
		assert.equal(genCalls, genBefore, '被拦住时不能再调生成（不花钱）');
	}

	console.log('✓ 抖音视频作品：kind 分流、图文与视频额度分开、生成不占浏览器锁、生成失败不发布、额度用完不花钱、点发布前先持久化、重启恢复与核实记账、mp4 路径落账、发完清旧视频、碰到验证要退避、没登录要提醒、发完清验证计数、花过的次数也受上限、发布中断落 unknown 且挡住后续');
} finally {
	db.close();
	rmSync(home, { recursive: true, force: true });
}
