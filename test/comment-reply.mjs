// 楼中楼：从视频评论里挑一条回一句（默认关、每天上限、[不回] 不发、失败不记额度、不回自己的评论）。
import assert from 'node:assert/strict';

import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-reply-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { BiliBrowser } = await import('../lib/browse.js');

const db = openDatabase();
const sent = [];
const client = {
	uid: 999,
	async view(bvid) {
		return { bvid, aid: 42, cid: 7, title: '一口气看完 AI 发展史', owner: '小然今天吃什么', desc: 'AI 时间线', tname: '科技' };
	},
	async subtitleText() { return '字幕内容'; },
	async hotComments() { return ['好看']; },
	async danmaku() { return []; },
	async commentList() {
		if (client.failList) throw new Error('wbi 挂了');
		return [
			{ rpid: '111', mid: '5', name: '阿茶', content: '这个时间线讲得真清楚' },
			{ rpid: '222', mid: '6', name: '小满', content: '求个笔记' },
			{ rpid: '333', mid: '999', name: '我自己', content: '我上次留的那句' }
		];
	},
	async replyComment(arg) {
		if (client.failSend) throw new Error('state=17');
		sent.push(arg);
		return { rpid: 1 };
	},
	async like() {},
	async favorite() {}
};
client.failList = false;
client.failSend = false;

const clock = { getRoleDateParts: () => ({ dateStr: '2026-11-04' }), now: () => Date.now() };

/** watch 的模型调用顺序：感受 →（留一句）→ 楼中楼。 */
function makeBrowser({ reply = true, perDay = 1, answer = '2|笔记我也没有，但我记得是从 2019 年那波开始的。', comment = false } = {}) {
	sent.length = 0;
	client.failList = false;
	client.failSend = false;
	const queue = ['这段讲得比我想的清楚多了', answer];
	return new BiliBrowser({
		db,
		clock,
		client,
		getConfig: () => ({
			browse: {
				enabled: true, perDay: 3, videosPerSession: 3,
				like: false, share: false, favorite: false, danmaku: false,
				comment, commentPerDay: 1,
				commentReply: reply, commentReplyPerDay: perDay, hotComments: 6
			}
		}),
		callLlm: async () => (queue.length > 0 ? queue.shift() : ''),
		persona: () => ({ name: '贪吃鱼', brief: '' }),
		watchDelayMs: [0, 0]
	});
}

const reset = () => { db.prepare('DELETE FROM kv').run(); db.prepare('DELETE FROM bili_seen').run(); };
const watched = (b) => b.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);

// ── 1. 开关关着：一条都不回 ──
{
	reset();
	const got = await watched(makeBrowser({ reply: false }));
	assert.equal(sent.length, 0, '开关关着不该回评论');
	assert.equal(got.replied, '');
}

// ── 2. 开着：回一条，带 root=rpid、parent=0，额度 +1 ──
{
	reset();
	const b = makeBrowser();
	const got = await watched(b);
	assert.equal(sent.length, 1, '应该回一条');
	assert.equal(sent[0].oid, 42);
	assert.equal(sent[0].root, '222', 'root 必须是挑中那条评论的 rpid');
	assert.equal(sent[0].parent, 0);
	assert.ok(sent[0].message.includes('2019'), '内容来自模型那句');
	assert.equal(got.replied, sent[0].message);
	assert.equal(b.repliedToday(), 1);
}

// ── 3. [不回]：不发 ──
{
	reset();
	const b = makeBrowser({ answer: '[不回]' });
	const got = await watched(b);
	assert.equal(sent.length, 0);
	assert.equal(got.replied, '');
	assert.equal(b.repliedToday(), 0);
}

// ── 4. 额度用满：第二条不回 ──
{
	reset();
	const b = makeBrowser({ perDay: 1 });
	await watched(b);
	await b.watch({ bvid: 'BVtest2', source: 'recommend' }, false, false, false);
	assert.equal(sent.length, 1, '一天只回一条');
	assert.equal(b.repliedToday(), 1);
}

// ── 5. 读评论失败：照旧写感受，不回、不记额度 ──
{
	reset();
	const b = makeBrowser();
	client.failList = true;
	const got = await b.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);
	assert.ok(got.impression !== '', '读评论失败也要有感受');
	assert.equal(got.replied, '');
	assert.equal(b.repliedToday(), 0);
}

// ── 6. 发送失败：不记额度 ──
{
	reset();
	const b = makeBrowser();
	client.failSend = true;
	const got = await watched(b);
	assert.equal(got.replied, '');
	assert.equal(b.repliedToday(), 0);
}

// ── 7. 不挑自己的评论（列表里 mid=uid 那条被过滤） ──
{
	reset();
	const b = makeBrowser({ answer: '3|应该找不到这条' });
	const got = await watched(b);
	assert.equal(got.replied, '', '只有两条能挑，序号 3 不合法');
	assert.equal(sent.length, 0);
}

// ── 8. 评论列表里的脏数据（空 rpid / 空内容）被过滤 ──
{
	reset();
	const orig = client.commentList;
	client.commentList = async () => [{ rpid: '', mid: '1', name: 'x', content: 'y' }, { rpid: '9', mid: '2', name: 'a', content: '' }];
	const b = makeBrowser();
	const got = await watched(b);
	assert.equal(got.replied, '');
	assert.equal(sent.length, 0);
	client.commentList = orig;
}

// ── 9. 热评条数可配（读进入参） ──
{
	reset();
	let asked = 0;
	const orig = client.hotComments;
	client.hotComments = async (aid, n) => { asked = n; return ['好看']; };
	const b = makeBrowser({ reply: false });
	await watched(b);
	assert.equal(asked, 6, '默认读 6 条热评');
	client.hotComments = orig;
}

{
	reset();
	const b = makeBrowser({ reply: true });
	await watched(b);
	assert.equal(sent.length, 1, '回了一条');
	const last = b.recentReply();
	assert.ok(last, '留痕写进去了');
	assert.equal(last.bvid, 'BVtest1', '留痕带 bvid');
	assert.equal(last.name, '小满', '留痕带被回的人');
	assert.ok(String(last.text).length > 0, '留痕带原话');
}

console.log('楼中楼测试全部通过');
