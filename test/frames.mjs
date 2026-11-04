// 抽帧看画面（批 2）：开关、时长门槛、每日额度、失败不误伤、图片块形状。
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-frames-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { BiliBrowser } = await import('../lib/browse.js');
const { buildContent, buildFfmpegArgs } = await import('../lib/llm.js').then(async (m) => ({
	buildContent: m.buildContent,
	buildFfmpegArgs: (await import('../lib/video-frames.js')).buildFfmpegArgs
}));

const db = openDatabase();
const IMG = { data: Buffer.from('fake-jpeg').toString('base64'), mediaType: 'image/jpeg', name: 'BVtest1-frames.jpg' };

function makeBrowser({ frames = true, framesPerDay = 1, framesPerDayChat = 10, duration = 600, framesImpl, linkReply = '他穿着酒红卫衣，桌上摆一排宝可梦。' } = {}) {
	const calls = { llm: [], frames: 0 };
	const client = {
		async view(bvid) {
			return { bvid, aid: 42, cid: 7, duration, title: '何同学又跑了一百天', owner: '何同学工作室', desc: '', tname: '生活' };
		},
		async subtitleText() { return ''; },
		async hotComments() { return []; },
		async danmaku() { return []; },
		async like() {},
		async favorite() {},
		async replyComment() { return { rpid: 1 }; }
	};
	const browser = new BiliBrowser({
		db,
		clock: { getRoleDateParts: () => ({ dateStr: '2026-11-04' }), now: () => Date.now() },
		client,
		getConfig: () => ({
			browse: {
				enabled: true, perDay: 3, videosPerSession: 1, like: false, share: false, favorite: false,
				danmaku: false, comment: false, search: false, frames, framesPerDay, framesPerDayChat, maxLinks: 3, subtitleChars: 100, descChars: 50, hotCommentChars: 20
			}
		}),
		callLlm: async (prompt, opts) => {
			calls.llm.push({ prompt, opts });
			return opts?.images ? linkReply : '他跑了三个月，膝盖先受不了了。';
		},
		persona: () => ({ name: '贪吃鱼', brief: '' }),
		frames: async (v) => {
			calls.frames += 1;
			const impl = framesImpl ?? (() => IMG);
			const r = impl(v);
			if (r instanceof Error) throw r;
			return r;
		},
		watchDelayMs: [0, 0]
	});
	return { browser, calls };
}

const reset = () => { db.prepare('DELETE FROM kv').run(); db.prepare('DELETE FROM bili_seen').run(); };

// ── 1. 开关关着：不抽帧，也不给图 ──
{
	reset();
	const { browser, calls } = makeBrowser({ frames: false });
	await browser.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);
	assert.equal(calls.frames, 0);
	assert.equal(calls.llm.length, 1);
	assert.equal(calls.llm[0].opts, undefined);
}

// ── 2. 开着：抽一次、带图、记额度 ──
{
	reset();
	const { browser, calls } = makeBrowser();
	await browser.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);
	assert.equal(calls.frames, 1);
	assert.equal(calls.llm.length, 1);
	assert.equal(calls.llm[0].opts.images.length, 1);
	assert.equal(calls.llm[0].opts.images[0].data, IMG.data);
	assert.ok(calls.llm[0].prompt.includes('九宫格'), '提示词里要说明给了图');
	assert.equal(browser.framedToday(), 1);
}

// ── 3. 额度用满：这条不再抽 ──
{
	reset();
	const { browser, calls } = makeBrowser({ framesPerDay: 1 });
	await browser.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);
	await browser.watch({ bvid: 'BVtest2', source: 'recommend' }, false, false, false);
	assert.equal(calls.frames, 1, '一天只抽一条');
	assert.equal(calls.llm[1].opts, undefined, '第二条不带图');
}

// ── 4. 短片（<2 分钟）不抽 ──
{
	reset();
	const { browser, calls } = makeBrowser({ duration: 45 });
	await browser.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);
	assert.equal(calls.frames, 0);
	assert.equal(calls.llm[0].opts, undefined);
}

// ── 5. 抽帧失败：照旧写感受，额度不加 ──
{
	reset();
	const { browser, calls } = makeBrowser({ framesImpl: () => new Error('ffmpeg 退出码 1') });
	const got = await browser.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);
	assert.ok(got.impression && got.impression.length > 0, '抽帧失败也要有感受');
	assert.equal(calls.llm[0].opts, undefined);
	assert.equal(browser.framedToday(), 0);
}

// ── 6. 图片块形状（宿主认的就是这个） ──
{
	const content = buildContent('提示', [{ data: 'abc', name: 'x.jpg' }, { data: '' }]);
	assert.deepEqual(content[0], { type: 'text', text: '提示' });
	assert.equal(content.length, 2, '空的图要丢掉');
	assert.equal(content[1].type, 'image');
	assert.equal(content[1].mediaType, 'image/jpeg');
	assert.equal(content[1].name, 'x.jpg');
	assert.deepEqual(buildContent('只有字'), [{ type: 'text', text: '只有字' }]);
}

// ── 7. ffmpeg 参数：跳过开头、只解 60 秒、九宫格 ──
{
	const args = buildFfmpegArgs({ url: 'https://example.com/a.mp4', out: 'C:/tmp/a.jpg' });
	const s = args.join(' ');
	assert.ok(s.includes('-ss 3'), '跳过开头 3 秒');
	assert.ok(s.includes('-t 60'), '只解 60 秒');
	assert.ok(s.includes('fps=1/6'), '每 6 秒一格');
	assert.ok(s.includes('tile=3x3'), '拼 3×3');
	assert.equal(args[args.length - 1], 'C:/tmp/a.jpg');
	assert.ok(s.includes('referer https://www.bilibili.com/'), 'B站 CDN 要 referer');
}

// ── 8. 图片要先过宿主附件库（裸 base64 会被通道静默丢掉） ──
{
	const { LlmRouter } = await import('../lib/llm.js');
	const router = Object.create(LlmRouter.prototype);
	const warns = [];
	router.log = (level, msg) => warns.push(msg);

	// 8a. 附件库正常：换成 attachment 引用
	router.ctx = { get: (name) => (name === 'attachments' ? { admitPromptContent: async (parts) => parts.map((p) => (p.type === 'image' ? { type: 'image', attachment: { id: 'att-1' } } : p)) } : undefined) };
	const ok = await router.promptParts('看图', [IMG], 'browse');
	assert.deepEqual(ok[0], { type: 'text', text: '看图' });
	assert.deepEqual(ok[1], { type: 'image', attachment: { id: 'att-1' } });

	// 8b. 附件库拒收：退回纯文字，不抛
	router.ctx = { get: () => ({ admitPromptContent: async () => { throw new Error('IMAGE_TOO_LARGE'); } }) };
	const fallback = await router.promptParts('看图', [IMG], 'browse');
	assert.deepEqual(fallback, [{ type: 'text', text: '看图' }]);
	assert.ok(warns.some((w) => w.includes('IMAGE_TOO_LARGE')), '要留一条 warn');

	// 8c. 没有附件库：同样退回纯文字
	router.ctx = { get: () => undefined };
	assert.deepEqual(await router.promptParts('看图', [IMG]), [{ type: 'text', text: '看图' }]);

	// 8d. 没有图：原样返回，不碰附件库
	router.ctx = { get: () => ({ admitPromptContent: async () => { throw new Error('不该被调用'); } }) };
	assert.deepEqual(await router.promptParts('只有字'), [{ type: 'text', text: '只有字' }]);
}

// ── 9. 你发链接时抽帧：额度独立，画面读成一句话进聊天上下文 ──
{
	reset();
	const { browser, calls } = makeBrowser({ framesPerDay: 1, framesPerDayChat: 2 });
	// 先让她自己刷掉唯一一次"自己刷"的额度
	await browser.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);
	assert.equal(browser.framedToday(), 1);
	assert.equal(calls.frames, 1);

	// 分享链接：照样能抽（不吃自己刷的额度）
	const notes = await browser.describe({ bvids: ['BVtest9'] });
	assert.equal(calls.frames, 2, '分享那条也要抽');
	assert.equal(browser.framedToday(), 1, '自己刷的额度不动');
	assert.equal(browser.framedTodayChat(), 1, '分享单独记账');
	assert.ok(notes[0].includes('画面：'), '画面要写进她那句话里');

	// 分享额度用完后不再抽，但仍然给文字
	const again = await browser.describe({ bvids: ['BVtest10'] });
	assert.equal(calls.frames, 3, '第二次分享还能抽一次');
	const third = await browser.describe({ bvids: ['BVtest11'] });
	assert.equal(calls.frames, 3, '额度满了就不抽');
	assert.ok(third[0].includes('【视频 BVtest11'), '仍然有文字');
	assert.ok(!third[0].includes('画面：'), '没有画面那句');
}

// ── 10. 读画面失败：退回只有文字，不影响回复 ──
{
	reset();
	const { browser, calls } = makeBrowser({ linkReply: '没看清' });
	const notes = await browser.describe({ bvids: ['BVtest12'] });
	assert.ok(notes[0].includes('【视频 BVtest12'));
	assert.ok(!notes[0].includes('画面：'), '看不清就不写画面');
}

// -- 11. 放大额度 / 换模型的两次重试都不能丢图（否则模型只看到"附了张截图"却没有图） --
{
	const src = fs.readFileSync(new URL("../lib/llm.js", import.meta.url), "utf8");
	assert.ok(src.includes("thinkFallback, images, _target: target"), "放大额度重试要带 images");
	assert.ok(/async fallback\(prompt, \{[^}]*images = \[\]/.test(src), "fallback 要收 images");
	assert.ok(src.includes("images, _target: { ...host"), "换模型重试要带 images");
}

console.log('抽帧测试全部通过');
