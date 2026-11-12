// 表情包导入后自动看图打标签：没标签的表情永远进不了「按感觉挑」的池子。
//
// 为什么要有：选图导入只存了字节和文件名，tags 是空的 —— 池子恒为空，「按感觉挑」整条路是死的。
// 这里盯的是「结果落到哪」：kv 里那条的 tags 要非空；模型没视觉 / 回得不像标签 → 静默降级，导入照旧成功。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

process.env.DSH_HOME = tmpHome('sticker-vision-');
const { openDatabase } = await import('../lib/db.js');
const mod = await import('../lib/stickers.js');
const { StickerBox, stickerConfig } = mod;
const { handleV07Route } = await import('../lib/routes-v07.js');

const ok = (n) => console.log('✓', n);
const db = openDatabase();
const ws = join(process.env.DSH_HOME, 'workspace');
mkdirSync(ws, { recursive: true });
const stickers = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 10 }), log: () => {} });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
const PNG2 = Buffer.concat([PNG, Buffer.from([0])]);

/**
 * 走一次面板的「选图导入」（POST /stickers/import）。
 * ctype 给 image/* 走新路（原始二进制），给 application/json 走旧路（base64）。
 * @returns {{sent: object|null, calls: Array<{prompt: string, opts: object}>}}
 */
async function importSticker({ bytes, name = '导入的', ctype = 'image/png', json = null, llmRouter = null }) {
	const calls = [];
	const fakeLlm = llmRouter ?? { call: async (prompt, opts) => { calls.push({ prompt, opts }); return '睡觉、可爱'; } };
	let sent = null;
	const req = {
		method: 'POST',
		url: new URL(`http://localhost/stickers/import?name=${encodeURIComponent(name)}`),
		headers: { 'sec-fetch-site': 'same-origin', 'content-type': ctype, 'content-length': String(bytes.length) },
		destroyed: false,
		pause() { this.paused = true; },
		resume() { this.paused = false; },
		destroy() { this.destroyed = true; },
		on(ev, fn) { (this._h ??= {})[ev] ??= []; (this._h[ev] ??= []).push(fn); return this; },
		once(ev, fn) { return this.on(ev, fn); },
		removeListener() { return this; },
		async *[Symbol.asyncIterator]() { yield bytes; }
	};
	await handleV07Route({
		method: 'POST', path: '/stickers/import', url: req.url, req, res: {},
		send: (status, obj) => { sent = { status, ...obj }; },
		readBody: async () => { if (json === null) throw new Error('这条路不该用 readBody'); return json; },
		sameOrigin: () => true,
		deps: { db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), saveConfig: () => {}, stickers, gateway: { workspacePath: () => ws }, log: () => {}, llmRouter: fakeLlm }
	});
	return { sent, calls };
}

// ① 模型回的话 → 干净的短词标签
{
	assert.equal(typeof mod.tagsFromVision, 'function', '要有 tagsFromVision（模型回的话 → 标签）');
	const tagsFromVision = mod.tagsFromVision;
	assert.deepEqual(tagsFromVision('得意、可爱'), ['得意', '可爱'], '顿号分隔的短词都留下');
	assert.deepEqual(tagsFromVision('得意 可爱'), ['得意', '可爱'], '空格分隔也算');
	assert.deepEqual(tagsFromVision('标签：得意、可爱'), ['得意', '可爱'], '带「标签：」前缀要剥掉');
	assert.deepEqual(tagsFromVision('[可以可以]'), ['可以可以'], '方括号包着的也算一个标签');
	assert.deepEqual(tagsFromVision('看不清'), [], '模型说看不清 → 不是标签');
	assert.deepEqual(tagsFromVision('我无法查看这张图片'), [], '模型说看不到 → 不是标签');
	assert.deepEqual(tagsFromVision('这是一张很长的描述句子用来占位'), [], '长句不当标签');
	assert.deepEqual(tagsFromVision('动画表情'), [], '废话不当标签');
	assert.deepEqual(tagsFromVision(''), [], '空回话没标签');
	assert.deepEqual(tagsFromVision(null), [], '没回话没标签');

	// 别把「她表达不出来」和「她表达的这个感觉」搞混：这些是正经的情绪标签，不是失败。
	// 「看不清」才是失败（她看不见图）；「不知道 / 无奈 / 抱歉」是表情包常有的感觉。
	assert.deepEqual(tagsFromVision('不知道、无奈'), ['不知道', '无奈'], '「不知道」是表情的感觉，不是失败');
	assert.deepEqual(tagsFromVision('不确定、纠结'), ['不确定', '纠结'], '「不确定」是感觉，不是失败');
	assert.deepEqual(tagsFromVision('抱歉、卖萌'), ['抱歉', '卖萌'], '「抱歉」是感觉，不是失败');
	assert.deepEqual(tagsFromVision('尴尬'), ['尴尬'], '单个短词也算');
	ok('看图回话 → 短词标签（长句 / 看不清 / 废话都丢掉；「不知道」这类感觉留着）');
}

// ② 看图打标 → kv 里那条的 tags 非空
{
	const r = stickers.importImage({ bytes: PNG, mediaType: 'image/png', name: '看的', workspacePath: ws, from: '主人' });
	assert.equal(r.ok, true, r.reason);
	const seen = [];
	const vision = async (prompt, images) => { seen.push({ prompt, images }); return '得意、柴犬'; };
	const tags = await stickers.tagByVision({ file: r.file, bytes: PNG, mediaType: 'image/png', workspacePath: ws }, vision);
	assert.deepEqual(tags, ['得意', '柴犬'], `看图回的话要变成标签，实际：${JSON.stringify(tags)}`);
	const row = stickers.collected().find((x) => x.file === r.file);
	assert.deepEqual(row.tags, ['得意', '柴犬'], '标签要落进 kv');
	assert.equal(row.tagsBy, 'vision', '要记下是看图打的');
	assert.equal(seen.length, 1, '要真把图交给模型看');
	assert.equal(seen[0].images[0].data, PNG.toString('base64'), '给模型的是这张图的字节');
	ok('看图打标 → kv 里那条的 tags 非空（tagsBy=vision）');
}

// ③ 模型没视觉 / 调用失败 → 静默降级：打不上标签，也不把导入搞挂
{
	const r = stickers.importImage({ bytes: PNG2, mediaType: 'image/png', name: '瞎的', workspacePath: ws, from: '主人' });
	assert.equal(r.ok, true, r.reason);
	const o = { file: r.file, bytes: PNG2, mediaType: 'image/png', workspacePath: ws };
	assert.deepEqual(await stickers.tagByVision(o, async () => '看不清'), [], '模型说看不清 → 没标签');
	assert.deepEqual(await stickers.tagByVision(o, async () => { throw new Error('模型挂了'); }), [], '调用失败 → 没标签');
	assert.deepEqual(await stickers.tagByVision(o, null), [], '没有看图能力 → 没标签');
	const row = stickers.collected().find((x) => x.file === r.file);
	assert.deepEqual(row.tags, [], '打不上就还是没标签（不能瞎填）');
	ok('模型没视觉 / 调用失败 → 静默降级，不打标签也不抛错');
}

// ④ 已经有标签的不覆盖（模型自己标的、summary 捡来的都算）
{
	// 字节要跟前面几段不一样：importImage 按 sha1 判重，重复字节会返回 dup（导入没成功，拿到的是上一条）。
	const PNG3 = Buffer.concat([PNG, Buffer.from([1])]);
	const r = stickers.importImage({ bytes: PNG3, mediaType: 'image/png', name: '已有', workspacePath: ws, from: '主人', tags: ['自己标的'] });
	assert.equal(r.ok, true, `导入要成功（重复字节会判重）：${r.reason}`);
	const tags = await stickers.tagByVision({ file: r.file, bytes: PNG3, mediaType: 'image/png', workspacePath: ws }, async () => '得意、可爱');
	assert.deepEqual(tags, ['自己标的'], '已有标签就别覆盖');
	assert.deepEqual(stickers.collected().find((x) => x.file === r.file).tags, ['自己标的']);
	ok('已经有标签的不会被看图打标覆盖');
}

// ⑤ 接线：面板「选图导入」那条路要真的走看图打标（只有方法没人调 = 白写）
{
	// 字节跟前面几段不同：importImage 按 sha1 判重，重复字节会直接返回 dup，导入根本没发生。
	const PNG4 = Buffer.concat([PNG, Buffer.from([2])]);
	const { sent, calls } = await importSticker({ bytes: PNG4, name: '看的' });
	assert.equal(sent?.ok, true, `导入要成功，实际：${JSON.stringify(sent)}`);
	assert.equal(calls.length, 1, '导入要调模型看图（接线断了就是 0）');
	assert.ok(String(calls[0]?.opts?.images?.[0]?.data ?? '').length > 0, '要把图交给模型');
	const row = stickers.collected().find((x) => x.file === sent.file);
	assert.deepEqual(row?.tags, ['睡觉', '可爱'], `导入完那条的 tags 要有，实际：${JSON.stringify(row?.tags)}`);
	assert.equal(row.tagsBy, 'vision');
	ok('面板选图导入 → 看图打标 → kv 里那条的 tags 非空');
}

// ⑥ 旧路（JSON + base64）也是选图导入，也得打标（不然换个前端就白导了）
{
	const PNG5 = Buffer.concat([PNG, Buffer.from([3])]);
	const { sent, calls } = await importSticker({
		bytes: PNG5, name: '旧路的', ctype: 'application/json',
		json: JSON.stringify({ name: '旧路的', mediaType: 'image/png', base64: PNG5.toString('base64') })
	});
	assert.equal(sent?.ok, true, `导入要成功，实际：${JSON.stringify(sent)}`);
	assert.equal(calls.length, 1, '旧路也要看图打标');
	const row = stickers.collected().find((x) => x.file === sent.file);
	assert.deepEqual(row?.tags, ['睡觉', '可爱'], `旧路导入那条的 tags 要有，实际：${JSON.stringify(row?.tags)}`);
	ok('旧路（JSON+base64）导入 → 也看图打标');
}

// ⑦ 重复导入（已存在、还没标签）→ 顺手把老的那条也打上（不然它永远进不了池子）
{
	const PNG6 = Buffer.concat([PNG, Buffer.from([4])]);
	const old = stickers.importImage({ bytes: PNG6, mediaType: 'image/png', name: '老没标签的', workspacePath: ws, from: '主人' });
	assert.equal(old.ok, true, old.reason);
	assert.deepEqual(stickers.collected().find((x) => x.file === old.file).tags, [], '前置：这条没标签');
	const { sent, calls } = await importSticker({ bytes: PNG6, name: '老没标签的' });
	assert.equal(sent?.dup, true, `重复导入要认得出是重复，实际：${JSON.stringify(sent)}`);
	assert.equal(calls.length, 1, '重复导入也要看图打标');
	assert.deepEqual(stickers.collected().find((x) => x.file === old.file).tags, ['睡觉', '可爱'], '老的那条被打上标了');
	ok('重复导入 → 顺手把没标签的老条目也打上');
}

// ⑧ 宿主送不进图（没有附件库）→ 别把模型编出来的描述当标签
{
	const { LlmRouter } = await import('../lib/llm.js');
	const asked = [];
	const router = new LlmRouter({
		ctx: {
			get: (n) => {
				if (n === 'llm') return {
					listProviders: () => [],
					async *stream(o) {
						asked.push(o.messages[0].content.map((c) => c.type).join('+'));
						// 没附件库时 llm 只发文字：模型看不见图，会照着提示词编
						yield { type: 'text-delta', text: '睡觉、可爱' };
					}
				};
				return undefined; // 宿主没有 attachments 服务
			}
		},
		db, getConfig: () => ({}), log: () => {}
	});
	const PNG7 = Buffer.concat([PNG, Buffer.from([5])]);
	const { sent } = await importSticker({ bytes: PNG7, name: '瞎的宿主', llmRouter: router });
	assert.equal(sent?.ok, true, `导入照旧成功，实际：${JSON.stringify(sent)}`);
	assert.deepEqual(asked, [], `宿主送不进图就别问模型（问了只会得到编的），实际问了：${asked.join(' → ')}`);
	assert.deepEqual(stickers.collected().find((x) => x.file === sent.file)?.tags, [], '没标签');
	ok('宿主没有附件库 → 不问模型，导入照旧成功');
}

// ⑨ 附件库在、但通道不吃 image 块（llm.call 会退回纯文字重试）→ 别把编出来的标签落进库
//
// 这是真坑：llm.js 带图调用失败时会「退回纯文字重试一次」，模型看不见图却会照着提示词
// 编一段像模像样的描述回过来。编出来的标签比没标签更糟 —— 它会污染「按感觉挑」的池子，
// 以后按感觉挑就会挑到一张根本不是那个感觉的表情。
{
	const { LlmRouter } = await import('../lib/llm.js');
	const asks = [];
	const router = new LlmRouter({
		ctx: {
			get: (n) => {
				if (n === 'llm') return {
					listProviders: () => [],
					async *stream(o) {
						const types = o.messages[0].content.map((c) => c.type);
						asks.push(types.join('+'));
						// 通道不吃图：带图必抛；纯文字就编一段
						if (types.includes('image')) throw new Error('model does not support image input');
						yield { type: 'text-delta', text: '睡觉、可爱' };
					}
				};
				// 附件库是好的（图「送得进去」），坏在模型/通道那一步
				if (n === 'attachments') return { admitPromptContent: async (p) => p };
				return undefined;
			}
		},
		db, getConfig: () => ({}), log: () => {}
	});
	const PNG8 = Buffer.concat([PNG, Buffer.from([6])]);
	const { sent } = await importSticker({ bytes: PNG8, name: '通道不吃图', llmRouter: router });
	assert.equal(sent?.ok, true, `导入照旧成功，实际：${JSON.stringify(sent)}`);
	assert.deepEqual(stickers.collected().find((x) => x.file === sent.file)?.tags, [],
		`图没送进模型 → 不许把编出来的标签落进 kv（模型实际被问了：${asks.join(' → ')}）`);
	ok('通道不吃图（退回纯文字重试）→ 不落编出来的标签');
}

console.log('sticker-vision-tags ok');
