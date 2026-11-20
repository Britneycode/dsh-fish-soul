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
let publishVideoFails = false;
let statusAtSubmit = '';
let current = null;
const driver = {
	renderCard: async () => { calls.renderCard++; return Buffer.from('card'); },
	prepareNote: async () => { calls.prepareNote++; return { ok: true }; },
	listRecommendedMusic: async () => { calls.listRecommendedMusic++; if (musicThrows) throw new Error('视频路径不该碰配乐'); return { ok: true, songs: ['歌'] }; },
	closeMusicPanel: async () => { calls.closeMusicPanel++; },
	publishNote: async ({ beforeSubmit }) => { calls.publishNote++; await beforeSubmit(); return { ok: true, musicPicked: true }; },
	prepareVideo: async () => { calls.prepareVideo++; return { ok: true }; },
	publishVideo: async ({ beforeSubmit }) => {
		calls.publishVideo++;
		await beforeSubmit();
		statusAtSubmit = String(current.postJobs.pending()?.status ?? '');
		if (publishVideoFails) return { ok: false, code: 'NOT_CONFIRMED', error: '点了发布，但没等到「已发布」' };
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
let genOk = true;
let exclusiveAtGen = -1;
const videoGen = {
	generate: async (cfg) => {
		genCalls++;
		exclusiveAtGen = exclusiveCalls;
		if (!genOk) return { ok: false, code: 'NETWORK', error: '视频服务连不上' };
		return { ok: true, file: join(home, 'douyin-videos', 'v1.mp4'), bytes: 1024, provider: cfg.provider, elapsedMs: 1000 };
	},
};
const notes = [];
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
		note: (k, x) => notes.push({ k, ...x }),
		notify: () => {},
	});
	return current;
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

	// B7：生成失败 —— 不发布，任务记成 failed（还能重发）
	setKv(db, 'douyin.video.day', { date: '2026-11-09', count: 0, tries: 0, lastVirtual: 0 });
	genOk = false;
	const pvBefore = calls.publishVideo;
	r = await s.post({ force: true, kind: 'video' });
	assert.equal(r.ok, false);
	assert.equal(calls.publishVideo, pvBefore, '生成失败不能去发布');
	const failed = db.prepare("SELECT * FROM douyin_post_job WHERE status='failed' ORDER BY id DESC LIMIT 1").get();
	assert.ok(failed, '任务要记成 failed');
	assert.equal(failed.kind, 'video');
	genOk = true;

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

	console.log('✓ 抖音视频作品：kind 分流、图文与视频额度分开、生成不占浏览器锁、生成失败不发布、额度用完不花钱、点发布前先持久化、重启恢复与核实记账');
} finally {
	db.close();
	rmSync(home, { recursive: true, force: true });
}
