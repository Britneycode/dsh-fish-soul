// B站 私信平台表情面板：面板响应 → 能写进提示词的码清单。
//
// 为什么是「码」不是「图」：B站 的表情走普通文本消息，正文写 `[doge]` 服务端自己渲染。
// 依据：官方文档 `e_infos` 仅当 msg_type=1 且有表情时出现；真机私信历史里抓到过 msg_type=1 的正文嵌 `[给心心]`。
import assert from 'node:assert/strict';
import { codesLine, panelCodes, BiliEmotes } from '../lib/bili-emotes.js';

const ok = (name) => console.log('✓', name);

// 1. 真形状的面板响应：收藏包在前但是空的、小黄脸是主力
const panel = { data: { packages: [
	{ text: '收藏', type: 13, emote: [] },
	{ text: '小黄脸', type: 1, emote: [
		{ text: '[doge]', meta: { alias: '狗头' } },
		{ text: '[笑哭]', meta: { alias: '笑哭' } },
		{ text: '[星星眼]' },
		{ text: 'not-a-code' },
		{ text: '[doge]', meta: { alias: '重复的' } }
	] },
	{ text: '2233·群星闪耀时收藏集表情包', type: 3, emote: [
		{ text: '[2233·群星闪耀时收藏集表情包_达咩]', meta: { alias: '达咩' } }
	] }
] } };

{
	const codes = panelCodes(panel, { limit: 10 });
	assert.deepEqual(codes.slice(0, 2).map((x) => x.text), ['[doge]', '[笑哭]'], '小黄脸优先');
	assert.equal(codes.filter((x) => x.text === '[doge]').length, 1, '去重');
	assert.ok(!codes.some((x) => x.text === 'not-a-code'), '不成码形状的丢掉');
	assert.ok(!codes.some((x) => x.text.includes('_')), '带包名的长码丢掉（她写不对）');
	assert.equal(panelCodes(panel, { limit: 2 }).length, 2, 'limit 生效');

	// 别名和码一样时不重复写（`[笑哭]（笑哭）` 白占字数）
	const line = codesLine(codes);
	assert.ok(line.includes('[doge]（狗头）'), line);
	assert.ok(!line.includes('（笑哭）'), '别名等于码本身时不重复：' + line);
	assert.ok(line.includes('[星星眼]'), '没别名的只给码');

	assert.equal(codesLine([]), '');
	assert.equal(codesLine(null), '');
	assert.deepEqual(panelCodes(null), [], '没有 data 不炸');
	assert.deepEqual(panelCodes({ data: { packages: 'x' } }), [], 'packages 不是数组不炸');
}
ok('面板 → 码清单：优先小黄脸、去重、丢长码、别名不重复');

// 2. 默认关：不开就不打接口
{
	let called = 0;
	const box = new BiliEmotes({ getConfig: () => ({ stickers: {} }), client: { call: async () => { called++; return panel; } } });
	assert.deepEqual(await box.list(), [], '默认关 → 空清单');
	assert.equal(called, 0, '默认关时一次接口都不打');
	assert.equal(box.status().enabled, false);

	// 开了才打
	const on = new BiliEmotes({ getConfig: () => ({ stickers: { biliPanel: true } }), client: { call: async () => { called++; return panel; } } });
	const got = await on.list();
	assert.ok(got.length > 0, '开了能拿到码');
	assert.equal(called, 1);
	assert.equal(on.status().count, got.length);

	// 缓存：六小时内不再打
	await on.list();
	assert.equal(called, 1, '缓存期内不重复打接口');

	// 并发只打一次
	const conc = new BiliEmotes({ getConfig: () => ({ stickers: { biliPanel: true } }), client: { call: async () => { called++; await new Promise((r) => setTimeout(r, 20)); return panel; } } });
	called = 0;
	await Promise.all([conc.list(), conc.list(), conc.list()]);
	assert.equal(called, 1, '同时来几个人只打一次');
}
ok('默认关；开了才打接口；六小时缓存；并发只打一次');

// 3. 兜底：接口失败不抛错、不清空已有
{
	const boom = new BiliEmotes({
		getConfig: () => ({ stickers: { biliPanel: true } }),
		client: { call: async () => { throw new Error('412 风控'); } }
	});
	const r = await boom.list();
	assert.deepEqual(r, [], '失败返回空（不抛）');
	assert.match(boom.status().lastError, /412/);

	// 先成功拿到，再失败：保留旧清单
	let fail = false;
	const flaky = new BiliEmotes({
		getConfig: () => ({ stickers: { biliPanel: true } }),
		client: { call: async () => { if (fail) throw new Error('网络没了'); return panel; } }
	});
	const first = await flaky.list();
	assert.ok(first.length > 0);
	flaky.fetchedAt = 0; // 让缓存过期
	fail = true;
	const second = await flaky.list();
	assert.deepEqual(second.map((x) => x.text), first.map((x) => x.text), '失败时保留上一次的清单');
}
ok('接口失败不抛错、不清空已有清单');

console.log('✓ B站 私信平台表情面板：码清单、默认关、缓存、并发去重、失败兜底');
