// 看图打标时顺手给「机器起的名字」换一个有意义的短名。
//
// 为什么要有：选图导入存的是用户原始文件名（`95BC0E6AC`、`IMG_20231101`），看图打标已经知道
// 这张图是什么了，名字却还是一串没意义的字符 —— 面板上根本认不出哪张是哪张。
// 盯的是结果：哈希名换成第一个标签当名字；主人自己起的名字一个字都不动；kv 里的 file 跟着改。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

process.env.DSH_HOME = tmpHome('sticker-auto-name-');
const { openDatabase } = await import('../lib/db.js');
const mod = await import('../lib/stickers.js');
const { StickerBox, stickerConfig } = mod;
const { handleV07Route } = await import('../lib/routes-v07.js');

const ok = (n) => console.log('✓', n);
const db = openDatabase();
/** 每段一个独立工作区：撞名 / 改名都按工作区算，混在一起看不出是哪一段在起作用。 */
const newWs = (name) => { const p = join(process.env.DSH_HOME, name); mkdirSync(join(p, '_stickers'), { recursive: true }); return p; };
const box = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 10 }), log: () => {} });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
/** 字节要各不相同：importImage 按 sha1 判重，重复字节会返回 dup（导入根本没发生）。 */
const bytes = (n) => Buffer.concat([PNG, Buffer.from([n])]);
const rowOf = (ws, file) => box.collected().find((x) => x.file === file && x.workspacePath === ws);
const inDir = (ws, file) => existsSync(join(ws, '_stickers', file));

// ① 哪些名字算「机器起的」（主人自己起的一个都不能算进去）
{
	assert.equal(typeof mod.isAutoName, 'function', '要有 isAutoName（这个名字是不是机器起的）');
	const isAutoName = mod.isAutoName;
	for (const n of ['95BC0E6AC', 'a3f5c9e2b1', 'IMG_20231101', 'DSC00001', 'Screenshot_20231101_120000', 'wx_camera_1699999999999', '20231101', '2023-11-01', 'image', '截图', 'c56a4180-65c3-4542-9c38-a7a5e8b2a11f']) {
		assert.equal(isAutoName(n), true, `${n} 是机器起的名字，该换`);
	}
	for (const n of ['得意猫', '狗头', '这是我的表情', 'goodmorning', 'happybirthday', 'sleepy', 'morning', 'cat']) {
		assert.equal(isAutoName(n), false, `${n} 是人起的名字，不该动`);
	}
	ok('isAutoName：哈希 / 相机默认名 / 时间戳算机器起的；人起的名字不算');
}

// ② 哈希名 → 看图打上标后换成第一个标签当名字（文件真的改名了）
{
	const ws = newWs('ws-hash');
	const r = box.importImage({ bytes: bytes(0), mediaType: 'image/png', name: '95BC0E6AC', workspacePath: ws, from: '主人' });
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.file, '95BC0E6AC.png', '前置：先按原名存着');
	const tags = await box.tagByVision({ file: r.file, bytes: bytes(0), mediaType: 'image/png', workspacePath: ws }, async () => '得意、可爱');
	assert.deepEqual(tags, ['得意', '可爱'], '前置：看图打上标了');

	const renamed = box.autoRename(r.file, tags, ws);
	assert.equal(renamed.ok, true, `哈希名要能改成 tag 名，实际：${JSON.stringify(renamed)}`);
	assert.equal(renamed.file, '得意.png', '新名字用第一个标签');
	assert.ok(inDir(ws, '得意.png'), '新名字的文件要在');
	assert.equal(inDir(ws, '95BC0E6AC.png'), false, '旧名字的文件要没了');
	ok('哈希名 + 看图打标 → 换成第一个标签当名字（文件真改名）');
}

// ③ 改名后 kv 里的引用要跟着改（不然面板 /「按感觉挑」还指着旧名字）
{
	const ws = newWs('ws-kv');
	const r = box.importImage({ bytes: bytes(1), mediaType: 'image/png', name: '95BC0E6AC', workspacePath: ws, from: '主人' });
	const tags = await box.tagByVision({ file: r.file, bytes: bytes(1), mediaType: 'image/png', workspacePath: ws }, async () => '柴犬、可爱');
	const renamed = box.autoRename(r.file, tags, ws);
	assert.equal(renamed.ok, true, renamed.reason);
	assert.equal(renamed.file, '柴犬.png');
	assert.ok(rowOf(ws, '柴犬.png'), `kv 里要有新名字那条，实际：${JSON.stringify(box.collected().map((x) => x.file))}`);
	assert.equal(rowOf(ws, '柴犬.png').file, '柴犬.png', 'kv 里的 file 要跟着改');
	assert.equal(rowOf(ws, '95BC0E6AC.png'), undefined, 'kv 里不能还留着旧名字');
	assert.deepEqual(rowOf(ws, '柴犬.png').tags, ['柴犬', '可爱'], '标签要还在这条上');
	assert.equal(rowOf(ws, '柴犬.png').tagsBy, 'vision');
	ok('改名后 kv 的 file 跟着改（引用不断）');
}

// ④ 主人自己起的名字一个字都不动
{
	const ws = newWs('ws-own');
	const r = box.importImage({ bytes: bytes(2), mediaType: 'image/png', name: '得意猫', workspacePath: ws, from: '主人' });
	const tags = await box.tagByVision({ file: r.file, bytes: bytes(2), mediaType: 'image/png', workspacePath: ws }, async () => '得意、可爱');
	assert.deepEqual(tags, ['得意', '可爱']);
	const renamed = box.autoRename(r.file, tags, ws);
	assert.equal(renamed.ok, false, '自己起的名字不该改');
	assert.ok(renamed.reason, '要说清为什么不动');
	assert.ok(inDir(ws, '得意猫.png'), '原来那张还在');
	assert.equal(rowOf(ws, '得意猫.png')?.file, '得意猫.png', 'kv 里也不能变');
	ok('主人自己起的名字（得意猫）不动');
}

// ⑤ 撞名加数字后缀，不覆盖别的表情
{
	const ws = newWs('ws-dup');
	const first = box.importImage({ bytes: bytes(3), mediaType: 'image/png', name: '得意', workspacePath: ws, from: '主人' });
	assert.equal(first.file, '得意.png', '前置：先有一张叫得意的');
	const second = box.importImage({ bytes: bytes(4), mediaType: 'image/png', name: 'AABBCCDD', workspacePath: ws, from: '主人' });
	const tags = await box.tagByVision({ file: second.file, bytes: bytes(4), mediaType: 'image/png', workspacePath: ws }, async () => '得意');
	const renamed = box.autoRename(second.file, tags, ws);
	assert.equal(renamed.ok, true, renamed.reason);
	assert.equal(renamed.file, '得意2.png', '撞名要加数字后缀');
	assert.ok(inDir(ws, '得意.png'), '原来那张不能被覆盖');
	assert.ok(inDir(ws, '得意2.png'), '新的要另起一个名');
	assert.equal(rowOf(ws, '得意.png')?.file, '得意.png', '原来那条的 kv 引用不能变');
	ok('撞名 → 加数字后缀（得意2），不覆盖原来那张');
}

// ⑥ 判断不了 / 没标签 / 改名失败 → 静默降级，保持原名
{
	const ws = newWs('ws-degrade');
	const r = box.importImage({ bytes: bytes(5), mediaType: 'image/png', name: '95BC0E6AC', workspacePath: ws, from: '主人' });
	const noTags = box.autoRename(r.file, [], ws);
	assert.equal(noTags.ok, false, '没标签就不能改名');
	assert.ok(inDir(ws, '95BC0E6AC.png'), '原名照旧');
	assert.equal(rowOf(ws, '95BC0E6AC.png')?.file, '95BC0E6AC.png', 'kv 也不变');
	// 没有这张 → 不抛错
	assert.doesNotThrow(() => box.autoRename('根本没有.png', ['得意'], ws), '没有这张不抛错');
	assert.doesNotThrow(() => box.autoRename('', ['得意'], ws), '空参数不抛错');
	ok('没标签 / 没有这张 → 静默降级，保持原名');
}

// ⑦ 接线：面板「选图导入」→ 看图打标 → 哈希名自动换掉（只有方法没人调 = 白写）
{
	const ws = newWs('ws-route');
	const b = bytes(6);
	let sent = null;
	const req = {
		method: 'POST',
		url: new URL('http://localhost/stickers/import?name=95BC0E6AC'),
		headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'image/png', 'content-length': String(b.length) },
		destroyed: false,
		pause() { this.paused = true; },
		resume() { this.paused = false; },
		destroy() { this.destroyed = true; },
		on(ev, fn) { (this._h ??= {})[ev] ??= []; (this._h[ev] ??= []).push(fn); return this; },
		once(ev, fn) { return this.on(ev, fn); },
		removeListener() { return this; },
		async *[Symbol.asyncIterator]() { yield b; }
	};
	await handleV07Route({
		method: 'POST', path: '/stickers/import', url: req.url, req, res: {},
		send: (status, obj) => { sent = { status, ...obj }; },
		readBody: async () => { throw new Error('这条路不该用 readBody'); },
		sameOrigin: () => true,
		deps: {
			db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), saveConfig: () => {}, stickers: box,
			gateway: { workspacePath: () => ws }, log: () => {}, llmRouter: { call: async () => '睡觉、可爱' }
		}
	});
	assert.equal(sent?.ok, true, `导入要成功，实际：${JSON.stringify(sent)}`);
	assert.equal(sent?.file, '睡觉.png', `哈希名要自动换成第一个标签，实际：${sent?.file}`);
	assert.ok(inDir(ws, '睡觉.png'), '新名字的文件要在');
	assert.equal(inDir(ws, '95BC0E6AC.png'), false, '旧名字的文件要没了');
	assert.deepEqual(rowOf(ws, '睡觉.png')?.tags, ['睡觉', '可爱'], '标签也要在新名字那条上');
	assert.equal(rowOf(ws, '95BC0E6AC.png'), undefined, 'kv 里不能还留着旧名字');
	ok('面板选图导入 → 看图打标 → 哈希名自动换掉');
}

console.log('sticker-auto-name ok');
