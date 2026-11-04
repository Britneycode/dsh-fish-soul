// 评论区留一句（批 1 / A 档）：开关、每日上限、失败不记额度、划走不评、[不评] 不发。
import assert from 'node:assert/strict';

import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-comment-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { BiliBrowser } = await import('../lib/browse.js');

const db = openDatabase();
const sent = [];
const client = {
	async view(bvid) {
		return { bvid, aid: 42, cid: 7, title: '一口气看完 AI 发展史', owner: '小然今天吃什么', desc: 'AI 时间线', tname: '科技' };
	},
	async subtitleText() { return '字幕内容'; },
	async hotComments() { return ['好看']; },
	async danmaku() { return []; },
	async replyComment(arg) {
		if (client.fail) throw new Error('state=17');
		sent.push(arg);
		return { rpid: 1 };
	},
	async like() {},
	async favorite() {}
};
client.fail = false;

const clock = { getRoleDateParts: () => ({ dateStr: '2026-11-04' }), now: () => Date.now() };

/** 每次 watch 会调两次模型：先"感受"，再"评论那句话"。 */
function makeBrowser({ comment = true, perDay = 1, impression = '这段讲得比我想的清楚多了', line = '这段讲得比我们班那条时间线清楚。' } = {}) {
	sent.length = 0;
	client.fail = false;
	const queue = [impression, line];
	return new BiliBrowser({
		db,
		clock,
		client,
		getConfig: () => ({
			browse: {
				enabled: true, perDay: 3, videosPerSession: 3,
				like: false, share: false, favorite: false, danmaku: false,
				comment, commentPerDay: perDay
			}
		}),
		callLlm: async () => (queue.length > 0 ? queue.shift() : impression),
		persona: () => ({ name: '贪吃鱼', brief: '' }),
		watchDelayMs: [0, 0]
	});
}

const reset = () => { db.prepare('DELETE FROM kv').run(); db.prepare('DELETE FROM bili_seen').run(); };
const watched = (b) => b.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);

// ── 1. 开关关着：一句都不留 ──
{
	reset();
	const got = await watched(makeBrowser({ comment: false }));
	assert.equal(sent.length, 0, '开关关着不该发评论');
	assert.equal(got.commented, '', '返回值里 commented 应为空');
}

// ── 2. 开着：发一条顶层评论，额度 +1 ──
{
	reset();
	const b = makeBrowser();
	const got = await watched(b);
	assert.equal(sent.length, 1, '应该发一条');
	assert.deepEqual(sent[0], { type: 1, oid: 42, root: 0, parent: 0, message: '这段讲得比我们班那条时间线清楚。' });
	assert.equal(got.commented, '这段讲得比我们班那条时间线清楚。');
	assert.equal(b.commentedToday(), 1, '额度要记一次');
}

// ── 3. 到上限就不再发 ──
{
	reset();
	const b = makeBrowser({ perDay: 1 });
	await watched(b);
	await b.watch({ bvid: 'BVtest2', source: 'recommend' }, false, false, false);
	assert.equal(sent.length, 1, '一天 1 条，第二条不该发');
	assert.equal(b.commentedToday(), 1);
}

// ── 4. 模型说 [不评]：不发，也不记额度 ──
{
	reset();
	const b = makeBrowser({ line: '[不评]' });
	const got = await watched(b);
	assert.equal(sent.length, 0, '[不评] 不该发');
	assert.equal(got.commented, '');
	assert.equal(b.commentedToday(), 0, '没发就不该记额度');
}

// ── 5. 接口报错（比如 state=17 折叠）：吞掉、不记额度 ──
{
	reset();
	const b = makeBrowser();
	client.fail = true;
	const got = await watched(b);
	assert.equal(got.commented, '', '发失败不该谎报成功');
	assert.equal(b.commentedToday(), 0, '失败不记额度');
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bili_seen').get().n, 1, '视频照样记进看过');
}

// ── 6. 划走：不评 ──
{
	reset();
	const b = makeBrowser({ impression: '[划走] 不感兴趣' });
	const got = await watched(b);
	assert.equal(sent.length, 0, '划走的视频不该评论');
	assert.equal(got.skipped, true);
	assert.equal(b.commentedToday(), 0);
}

console.log('comment-video ok');
