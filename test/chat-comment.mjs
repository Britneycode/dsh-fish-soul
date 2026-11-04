// 主人私聊发链接 + 让她去评论区说一句 → 她真的去发一条；别人/群里/没有意图都不发。
import assert from 'node:assert/strict';

const { mediaMethods } = await import('../lib/gateway-media.js');

const makeCtx = ({ chatType = 'private', userId = '123', master = '123', used = 0, cap = 3, text = '', links = [], bvids = [], shorts = [] } = {}) => {
	const sent = [];
	const ctx = Object.create(mediaMethods);
	ctx.masterQq = () => master;
	ctx.log = () => {};
	ctx.withTimeout = (p) => p;
	ctx.biliConfig = () => ({ enabled: true });
	ctx.douyinConfig = () => ({ enabled: false });
	ctx.douyinBrowser = null;
	ctx.browser = {
		cfg: () => ({ commentPerDay: cap }),
		commentedToday: () => used,
		gather: async (bvid) => ({ bvid, aid: 42, title: '一口气看完 AI 发展史' }),
		commentOn: async (v, hint) => { sent.push({ bvid: v.bvid, hint }); return '确实，这框架我也试了'; },
		describe: async () => ['【视频：一口气看完 AI 发展史】'],
		client: { resolveShort: async (url) => { sent.push({ short: url }); return 'BV1xx411c7mD'; } }
	};
	const items = [{ m: { text, links, chatType, userId }, person: {} }];
	return { ctx, items, sent };
};

// 1. 主人私聊 + 让她评论 + 带链接 → 发一条，并且回执进上下文
{
	const { ctx, items, sent } = makeCtx({ text: '你去评论区冒个泡', links: ['https://www.bilibili.com/video/BV1xx411c7mD'] });
	const notes = await ctx.videoNotes(items);
	assert.equal(sent.filter((x) => x.bvid).length, 1, '应该发一条评论');
	assert.equal(sent[0].bvid, 'BV1xx411c7mD');
	assert.ok(notes.some((n) => n.includes('已经在《')), '回执要进上下文');
}

// 2. 不是主人 → 不发
{
	const { ctx, items, sent } = makeCtx({ userId: '999', text: '你去评论区冒个泡' });
	await ctx.videoNotes(items);
	assert.equal(sent.filter((x) => x.bvid).length, 0, '别人说这句不该发');
}

// 3. 主人但没这个意图 → 不发
{
	const { ctx, items, sent } = makeCtx({ text: '这个视频好看吗' });
	await ctx.videoNotes(items);
	assert.equal(sent.filter((x) => x.bvid).length, 0, '没有让她评论的意思就不发');
}

// 4. 群里 → 不发（哪怕带 @ 和意图）
{
	const { ctx, items, sent } = makeCtx({ chatType: 'group', text: '你去评论区冒个泡' });
	await ctx.videoNotes(items);
	assert.equal(sent.filter((x) => x.bvid).length, 0, '群里不触发');
}

// 5. 额度用完 → 不发，但给一句提示
{
	const { ctx, items, sent } = makeCtx({ text: '评论区留一句', links: ['https://www.bilibili.com/video/BV1xx411c7mD'], used: 3, cap: 3 });
	const notes = await ctx.videoNotes(items);
	assert.equal(sent.filter((x) => x.bvid).length, 0);
	assert.ok(notes.some((n) => n.includes('额度已经用完')), '额度用完要明说');
}

// 6. b23 短链 → 先换 BV 再发
{
	const { ctx, items, sent } = makeCtx({ text: '去评论一下', links: ['https://b23.tv/abc'] });
	await ctx.videoNotes(items);
	const short = sent.find((x) => x.short);
	assert.ok(short, '短链应该先解析');
	assert.equal(short.short, 'https://b23.tv/abc');
}

console.log('聊天里让她评论：测试全部通过');
