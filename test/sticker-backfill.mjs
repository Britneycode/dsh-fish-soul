// 表情包补标签 + 补向量（`StickerBox.backfillTags`）。
//
// 为什么要这个：聊天里收藏那条路（`collect()`）根本不打标 —— 标签只来自她当场写的
// `[收藏表情:名字|标签]` 或 OneBot summary。真机实测 11 张里 6 张无标签，其中 5 张
// summary 是 `[动画表情]`（被当噪声丢了）。无标签 ⇒ `embedStickers` 跳过它（只处理有标签的）
// ⇒ 永远进不了「按感觉挑」的池子 ⇒ 她只能反复用那几张有标签的。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = tmpHome('dsh-sticker-backfill-');
process.env.DSH_HOME = home;
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const { StickerBox } = await import('../lib/stickers.js');

const db = openDatabase();
const ok = (m) => console.log('✓', m);

const ws = join(home, 'workspace');
mkdirSync(join(ws, '_stickers'), { recursive: true });
// 造 4 张图：2 张有标签（不该被动）、2 张没标签（要打上）
const write = (name, byte = 0x47) => writeFileSync(join(ws, '_stickers', name), Buffer.from([0x89, 0x50, 0x4e, 0x47, byte, byte, byte]));
write('已标签.gif', 1);
write('没标签A.gif', 2);
write('没标签B.jpg', 3);
write('读不到.png', 4);

const seed = (items) => setKv(db, 'stickers.collected', items);
seed([
	{ file: '已标签.gif', hash: 'h1', workspacePath: ws, tags: ['得意', '看戏'], tagsBy: 'self', at: 1 },
	{ file: '没标签A.gif', hash: 'h2', workspacePath: ws, tags: [], tagsBy: '', at: 2 },
	{ file: '没标签B.jpg', hash: 'h3', workspacePath: ws, tags: [], tagsBy: '', at: 3 },
	{ file: '读不到.png', hash: 'h4', workspacePath: ws, tags: [], tagsBy: '', at: 4 }
]);

const box = new StickerBox({ db, getConfig: () => ({ collect: true, perDay: 10 }), log: () => {} });

// ── 1. 没给 vision → 一张都打不上（不能瞎填）──
{
	const r = await box.backfillTags({ workspacePath: ws, vision: null, embedder: null });
	assert.equal(r.total, 3, '只挑没标签的 3 张（有标签的 1 张不动）');
	assert.equal(r.tagged, 0, '没有 vision 就一张都打不上');
	assert.equal(r.skipped, 3, '全算跳过');
	const all = getKv(db, 'stickers.collected', []);
	assert.deepEqual(all.find((x) => x.file === '已标签.gif').tags, ['得意', '看戏'], '有标签的没被动');
	assert.deepEqual(all.find((x) => x.file === '没标签A.gif').tags, [], '没打上就还是空');
	ok('没有识图能力 → 一张都不打，也不瞎填');
}

// ── 2. vision 给了标签 → 打上，且不改有标签的那张 ──
{
	let calls = 0;
	const vision = async (prompt, images) => {
		calls++;
		assert.ok(Array.isArray(images) && images.length === 1, '每次只送一张图');
		assert.ok(typeof images[0].data === 'string' && images[0].data.length > 0, '送的是 base64 数据');
		// 按文件名给不同的标签，好区分
		if (images[0].name === '没标签A.gif') return '看戏、得意';
		if (images[0].name === '没标签B.jpg') return '表示同意';
		return null;
	};
	const r = await box.backfillTags({ workspacePath: ws, vision, embedder: null });
	assert.equal(r.tagged, 2, '两张打上了');
	assert.equal(calls, 3, '三张都送模型看了一次');
	const all = getKv(db, 'stickers.collected', []);
	const a = all.find((x) => x.file === '没标签A.gif');
	const b = all.find((x) => x.file === '没标签B.jpg');
	assert.deepEqual(a.tags, ['看戏', '得意'], 'A 打上了标签');
	assert.equal(a.tagsBy, 'vision', '来源标成 vision');
	assert.deepEqual(b.tags, ['表示同意'], 'B 打上了标签');
	assert.deepEqual(all.find((x) => x.file === '已标签.gif').tags, ['得意', '看戏'], '已有标签的不被覆盖');
	ok('看图打标：没标签的打上、有标签的不覆盖');
}

// ── 3. 模型说「看不清」→ 当失败，不写成标签 ──
{
	seed([
		{ file: '没标签A.gif', hash: 'h2', workspacePath: ws, tags: [], tagsBy: '', at: 2 }
	]);
	const r = await box.backfillTags({ workspacePath: ws, vision: async () => '看不清', embedder: null });
	assert.equal(r.tagged, 0, '「看不清」不算标签');
	assert.equal(r.skipped, 1);
	assert.deepEqual(getKv(db, 'stickers.collected', [])[0].tags, [], '库里还是空标签');
	ok('模型看不清 → 当失败，不写成标签');
}

// ── 4. 图读不到（文件不在）→ 跳过，不影响别的 ──
{
	seed([
		{ file: '不存在.gif', hash: 'h9', workspacePath: ws, tags: [], tagsBy: '', at: 1 },
		{ file: '没标签A.gif', hash: 'h2', workspacePath: ws, tags: [], tagsBy: '', at: 2 }
	]);
	const r = await box.backfillTags({ workspacePath: ws, vision: async () => '可爱', embedder: null });
	assert.equal(r.skipped, 1, '读不到的那张跳过');
	assert.equal(r.tagged, 1, '另一张照打');
	ok('图读不到 → 跳过，不影响别的');
}

// ── 5. 补完标签顺手补向量（embedStickers 只认有标签的，顺序不能反）──
{
	seed([
		{ file: '没标签A.gif', hash: 'h2', workspacePath: ws, tags: [], tagsBy: '', at: 2 }
	]);
	const embedded = [];
	const embedder = {
		getConfig: () => ({ model: 'test-model' }),
		embed: async (texts) => { embedded.push(...texts); return { vectors: texts.map(() => new Float32Array([0.1, 0.2, 0.3])) }; }
	};
	const r = await box.backfillTags({ workspacePath: ws, vision: async () => '可爱、卖萌', embedder, opts: { model: 'test-model' } });
	assert.equal(r.tagged, 1, '先打上标签');
	assert.equal(r.embedded, 1, '再补向量');
	assert.equal(embedded.length, 1, 'embedding 收到的是刚打上的标签');
	assert.ok(embedded[0].includes('可爱'), '嵌的是标签文字');
	const row = getKv(db, 'stickers.collected', [])[0];
	assert.ok(typeof row.vec === 'string' && row.vec !== '', '向量落库了');
	assert.equal(row.vecModel, 'test-model');
	ok('补完标签顺手补向量（顺序对了才进得了「按感觉挑」的池子）');
}

// ── 6. limit 生效（一次别补太多，面板是同步等的）──
{
	seed(Array.from({ length: 10 }, (_, i) => ({ file: `x${i}.gif`, hash: `hx${i}`, workspacePath: ws, tags: [], tagsBy: '', at: i })));
	for (let i = 0; i < 10; i++) write(`x${i}.gif`, i + 10);
	const r = await box.backfillTags({ workspacePath: ws, vision: async () => '可爱', embedder: null, opts: { limit: 3 } });
	assert.equal(r.total, 3, 'limit 只挑 3 张');
	assert.equal(r.tagged, 3);
	ok('limit 生效（面板同步等待，一次别补太多）');
}

// ── 7. workspacePath 过滤：别的库不动 ──
{
	const other = join(home, 'other');
	mkdirSync(join(other, '_stickers'), { recursive: true });
	writeFileSync(join(other, '_stickers', '别处.gif'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
	seed([
		{ file: '没标签A.gif', hash: 'h2', workspacePath: ws, tags: [], tagsBy: '', at: 1 },
		{ file: '别处.gif', hash: 'ho', workspacePath: other, tags: [], tagsBy: '', at: 2 }
	]);
	const r = await box.backfillTags({ workspacePath: ws, vision: async () => '可爱', embedder: null });
	assert.equal(r.total, 1, '只补指定工作区的');
	const all = getKv(db, 'stickers.collected', []);
	assert.deepEqual(all.find((x) => x.file === '别处.gif').tags, [], '别的工作区没被动');
	ok('workspacePath 过滤：别的工作区不动');
}

console.log('\nsticker-backfill ok');

// ── 8. 三种失败必须分得开（否则「有些表情没标签」只能靠猜）──
//   ① 回了 null      → 图没送进模型（llm.js 那边另有 warn）
//   ② 回了「看不清」 → 图进去了，模型没认出来
//   ③ 回了一段话但不像标签 → 提示词 / 模型理解问题
{
	const logs = [];
	const box2 = new StickerBox({ db, getConfig: () => ({ collect: true, perDay: 10 }), log: (lvl, msg) => logs.push(`${lvl}:${msg}`) });
	seed([{ file: '没标签A.gif', hash: 'h2', workspacePath: ws, tags: [], tagsBy: '', at: 1 }]);

	await box2.backfillTags({ workspacePath: ws, vision: async () => null, embedder: null });
	assert.ok(logs.some((l) => l.includes('没拿到回复')), '① 回 null 要留痕');

	logs.length = 0;
	await box2.backfillTags({ workspacePath: ws, vision: async () => '看不清', embedder: null });
	assert.ok(logs.some((l) => l.includes('回的不像标签') && l.includes('看不清')), '② 「看不清」要留痕并带上原文');

	logs.length = 0;
	await box2.backfillTags({ workspacePath: ws, vision: async () => { throw new Error('通道 500'); }, embedder: null });
	assert.ok(logs.some((l) => l.includes('抛错') && l.includes('通道 500')), '③ 抛错要留痕并带上原因');

	ok('三种失败各留一行（图没进去 / 看不清 / 回的格式不对，日志里分得开）');
}
