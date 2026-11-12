// 面板手动补标签：老表情（收藏时模型没给标签 / 早期导入的）没标签就永远进不了「按感觉挑」的池子。
//
// 盯的是结果，不是方法：保存后 kv 里那条的 tags / tagsBy 要变，旧向量要作废（不然按旧标签挑），
// 下一次 pickByFeel 真要能挑到它。主人自己放进 _stickers 的图没有 kv 记录，补标签时顺手补一条。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DSH_HOME = tmpHome('sticker-manual-');
const { openDatabase } = await import('../lib/db.js');
const { StickerBox, stickerConfig } = await import('../lib/stickers.js');
const { handleV07Route } = await import('../lib/routes-v07.js');

const ok = (n) => console.log('✓', n);
const db = openDatabase();
/** 每段一个独立工作区：向量 / 标签都是按工作区隔离的，混在一起看不出是哪一段在起作用。 */
const newWs = (name) => { const p = join(process.env.DSH_HOME, name); mkdirSync(join(p, '_stickers'), { recursive: true }); return p; };
const box = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 10 }), log: () => {} });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
const bytes = (n) => Buffer.concat([PNG, Buffer.from([n])]);

// 假 embedder：按**字**计数（跟 sticker-manage 一致）。子串匹配会漏「想卖个萌」这种不连续的情况。
const CHARS = ['得', '意', '猫', '害', '羞', '卖', '萌', '可', '爱', '睡', '觉'];
const fake = {
	embed: async (texts) => ({
		vectors: texts.map((t) => CHARS.map((c) => (String(t).includes(c) ? 1 : 0)))
	})
};

/** 走一次面板接口（POST /stickers/tags）。 */
async function postTags(payload, ws) {
	let sent = null;
	await handleV07Route({
		method: 'POST', path: '/stickers/tags', url: new URL('http://localhost/stickers/tags'), req: {}, res: {},
		send: (status, obj) => { sent = { status, ...obj }; },
		readBody: async () => JSON.stringify(payload ?? {}),
		sameOrigin: () => true,
		deps: { db, getConfig: () => ({ stickers: {} }), saveConfig: () => {}, stickers: box, gateway: { workspacePath: () => ws }, log: () => {} }
	});
	return sent;
}
const rowOf = (file) => box.collected().find((x) => x.file === file);

// ① 收藏来的老表情（没标签）→ 手动补标签落进 kv
{
	const ws = newWs('ws-set');
	const old = box.importImage({ bytes: bytes(0), mediaType: 'image/png', name: '老表情', workspacePath: ws, from: '某人' });
	assert.equal(old.ok, true, old.reason);
	assert.deepEqual(rowOf(old.file)?.tags, [], '前置：这条没标签');

	const r = box.setTags(old.file, '得意、猫', ws);
	assert.equal(r.ok, true, `手动补标签要成功，实际：${JSON.stringify(r)}`);
	assert.deepEqual(r.tags, ['得意', '猫'], '标签要拆开');
	assert.deepEqual(rowOf(old.file).tags, ['得意', '猫'], '要写回 kv 的 tags');
	assert.equal(rowOf(old.file).tagsBy, 'manual', '要标成手动补的');
	ok('手动补标签 → kv 里的 tags 变了、tagsBy=manual');
}

// ② 补完标签后「按感觉挑」的池子里真能命中（老表情原本不在池子里）
{
	const ws = newWs('ws-feel');
	const shy = box.importImage({ bytes: bytes(1), mediaType: 'image/png', name: '害羞的', workspacePath: ws, from: '某人', tags: ['害羞'] });
	assert.equal(shy.ok, true, shy.reason);
	const late = box.importImage({ bytes: bytes(2), mediaType: 'image/png', name: '后来补的', workspacePath: ws, from: '某人' });
	assert.equal(late.ok, true, late.reason);
	assert.deepEqual(rowOf(late.file)?.tags, [], '前置：这条没标签');

	// 补之前：池子里只有「害羞的」，「得意」挑不到没标签的那张
	const before = await box.pickByFeel(ws, '得意', fake, { model: 'fake-1' });
	assert.equal(before.ok, true, before.reason);
	assert.notEqual(before.file, late.file, `没标签的不能进池子，实际挑到：${before.file}`);

	// 补之后：下一次「按感觉挑」就命中（向量由 pickByFeel 懒补，不用额外触发）
	assert.equal(box.setTags(late.file, ['得意', '猫'], ws).ok, true);
	const after = await box.pickByFeel(ws, '得意', fake, { model: 'fake-1' });
	assert.equal(after.ok, true, after.reason);
	assert.equal(after.file, late.file, `手动补的标签要能被「按感觉挑」命中，实际挑到：${after.file}`);
	const row = rowOf(late.file);
	assert.ok(row?.vec, '向量要懒补进 kv');
	assert.equal(row.vecModel, 'fake-1');
	ok('手动补标签 → pickByFeel 池子里能命中（向量懒补，不用额外触发）');
}

// ③ 改标签 → 旧向量作废（不作废就是拿旧标签的向量去比，按感觉挑会挑错）
{
	const ws = newWs('ws-stale');
	const one = box.importImage({ bytes: bytes(3), mediaType: 'image/png', name: '要改的', workspacePath: ws, from: '某人' });
	assert.equal(one.ok, true, one.reason);
	assert.equal(box.setTags(one.file, ['得意', '猫'], ws).ok, true);
	assert.equal(await box.embedStickers(ws, fake, { model: 'fake-1' }), 1, '前置：先打上向量');
	assert.ok(rowOf(one.file)?.vec, '前置：已经有向量');

	// 标签没变 → 别白扔向量
	assert.equal(box.setTags(one.file, ['得意', '猫'], ws).ok, true);
	assert.ok(rowOf(one.file)?.vec, '标签没变就别白扔向量');

	// 标签变了 → 向量作废，下次懒补
	assert.equal(box.setTags(one.file, ['睡觉'], ws).ok, true);
	const after = rowOf(one.file);
	assert.deepEqual(after.tags, ['睡觉']);
	assert.equal(after.vec, undefined, '标签变了向量要作废（下次懒补）');
	assert.equal(after.vecModel, undefined);
	assert.equal(await box.embedStickers(ws, fake, { model: 'fake-1' }), 1, '作废后要能重新打上');
	assert.equal((await box.pickByFeel(ws, '睡觉', fake, { model: 'fake-1' })).file, one.file, '按新标签挑得到');
	ok('改标签 → 旧向量作废；标签没变不动向量');
}

// ④ 清空标签 / 不存在的贴纸 / 空参数 → 静默降级，不抛错
{
	const ws = newWs('ws-degrade');
	const one = box.importImage({ bytes: bytes(4), mediaType: 'image/png', name: '清空的', workspacePath: ws, from: '某人' });
	assert.equal(one.ok, true, one.reason);
	assert.equal(box.setTags(one.file, '可爱', ws).ok, true);

	const cleared = box.setTags(one.file, '', ws);
	assert.equal(cleared.ok, true, '清空标签是允许的');
	assert.deepEqual(rowOf(one.file)?.tags, [], '标签清空了');
	assert.equal(rowOf(one.file)?.tagsBy, '', '清空后不该还写着 manual');

	const missing = box.setTags('根本没有.png', '得意', ws);
	assert.equal(missing.ok, false);
	assert.ok(missing.reason, '要说清为什么不行');
	assert.doesNotThrow(() => box.setTags('', '', ''), '空参数不抛错');
	assert.doesNotThrow(() => box.setTags(one.file, null, ws), 'tags 给 null 不抛错');
	ok('清空标签 / 没有这张 / 空参数 → 静默降级不抛错');
}

// ⑤ 主人自己放进 _stickers 的图：本来没有 kv 记录，补标签时补一条（不然它永远进不了池子）
{
	const ws = newWs('ws-dir');
	writeFileSync(join(ws, '_stickers', '主人放的.png'), bytes(5));
	assert.equal(box.collected().some((x) => x.file === '主人放的.png'), false, '前置：目录里的图不写 kv');

	const r = box.setTags('主人放的.png', '可爱', ws);
	assert.equal(r.ok, true, `目录里的图也要能补标签，实际：${JSON.stringify(r)}`);
	const row = rowOf('主人放的.png');
	assert.ok(row, '要补一条收藏记录');
	assert.deepEqual(row.tags, ['可爱']);
	assert.equal(row.tagsBy, 'manual');
	assert.match(row.hash, /^[0-9a-f]{40}$/, '补记录时算 sha1（跟收藏来的记录形状一致）');
	assert.equal(row.from, '主人放的');
	assert.equal(row.workspacePath, ws);
	// 目录里没有这张 → 拒绝
	assert.equal(box.setTags('目录里没有.png', '可爱', ws).ok, false);
	ok('主人放进目录的图 → 补标签时补一条 kv 记录（能进池子）');
}

// ⑥ 接线：面板路由 POST /stickers/tags 要真的写回 kv
{
	const ws = newWs('ws-route');
	const target = box.importImage({ bytes: bytes(6), mediaType: 'image/png', name: '路由的', workspacePath: ws, from: '某人' });
	assert.equal(target.ok, true, target.reason);

	const sent = await postTags({ file: target.file, workspacePath: ws, tags: '得意、卖萌' }, ws);
	assert.equal(sent?.ok, true, `路由要成功，实际：${JSON.stringify(sent)}`);
	assert.deepEqual(sent.tags, ['得意', '卖萌']);
	assert.deepEqual(rowOf(target.file)?.tags, ['得意', '卖萌'], '路由要写回 kv');

	// 也收 hash（只想按 hash 定位的调用方）
	const byHash = await postTags({ hash: rowOf(target.file).hash, tags: ['猫'] }, ws);
	assert.equal(byHash?.ok, true, `按 hash 也要能改，实际：${JSON.stringify(byHash)}`);
	assert.deepEqual(rowOf(target.file)?.tags, ['猫']);

	// 没有这张 / 空 body → 明确失败但 200，不抛
	const missing = await postTags({ file: '根本没有.png', workspacePath: ws, tags: '得意' }, ws);
	assert.equal(missing?.status, 200, '失败也要 200（面板按 ok 判断）');
	assert.equal(missing?.ok, false);
	assert.equal((await postTags({}, ws))?.ok, false, '空 body 不抛错');
	// 别的工作区（不认识的目录）不许改
	const stranger = await postTags({ file: target.file, workspacePath: join(process.env.DSH_HOME, '别处'), tags: '得意' }, ws);
	assert.equal(stranger?.ok, false, '不认识的目录不能改');
	assert.deepEqual(rowOf(target.file)?.tags, ['猫'], '被拒的请求不能改动 kv');
	ok('POST /stickers/tags → 写回 kv（file+workspacePath / hash 两种定位都认，失败静默）');
}

// ⑦ 面板入口：卡片上有「编辑标签」，保存打的就是这个接口（只有路由没人调 = 白写）
{
	const ui = readFileSync(new URL('../lib/client.soul.js', import.meta.url), 'utf8');
	assert.match(ui, /"\/stickers\/tags"/, '面板要真的调 /stickers/tags（入口断了就是死代码）');
	assert.match(ui, /编辑标签/, '卡片上要有「编辑标签」入口');
	assert.match(ui, /x\.tags/, '卡片要把现有标签读出来显示');
	const css = readFileSync(new URL('../lib/panel.css', import.meta.url), 'utf8');
	assert.match(css, /\.fs-sticker \.fs-sticker-tag-btn\{[^}]*position:absolute/, '编辑按钮要跟删除按钮一样贴在卡片上');
	assert.match(css, /@media \(hover:none\)\{\.fs-sticker \.fs-sticker-tag-btn\{opacity:1\}\}/, '触屏没有 hover，按钮要常驻可见');
	ok('面板卡片：编辑标签入口 → 调 /stickers/tags → 保存后刷新');
}

console.log('sticker-manual-tags ok');
