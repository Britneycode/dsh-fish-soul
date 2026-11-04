// QQ 发任意图：发图清单（_stickers 表情包 + 工作区里任意图片）的边界。
// 清单给模型的是相对工作区根的路径，模型照着写 ![说明](相对路径) 就能发出去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-sendany-');
process.env.DSH_HOME = home;
const { ChatGateway } = await import('../lib/gateway.js');

/** listImages 只用到 getConfig 和 listStickers，给个够用的壳。 */
const listImages = (ws, cfg = {}) => ChatGateway.prototype.listImages.call(
	Object.assign(Object.create(ChatGateway.prototype), { getConfig: () => cfg }), ws);

/** 造文件；at 用来改修改时间（验证"新的留下、旧的截掉"）。 */
function put(dir, name, at) {
	mkdirSync(dir, { recursive: true });
	const p = join(dir, name);
	writeFileSync(p, '');
	if (at !== undefined) utimesSync(p, at, at);
	return p;
}

test('默认关：清单里只有 _stickers 的图', () => {
	const ws = join(home, 'ws-off');
	put(join(ws, '_stickers'), 'a.png');
	put(join(ws, 'photo'), '猫.jpg');
	put(ws, 'b.png');
	assert.deepEqual(listImages(ws), ['_stickers/a.png'], '默认只给表情包');
	assert.deepEqual(listImages(ws, { images: { sendAny: false } }), ['_stickers/a.png'], '显式关也一样');
});

test('开 sendAny：工作区里别的目录的图也进清单（相对路径）', () => {
	const ws = join(home, 'ws-on');
	put(join(ws, '_stickers'), 'a.png');
	put(join(ws, 'photo'), '猫.jpg');
	put(ws, 'b.png');
	put(join(ws, 'deep'), 'c.png');
	put(join(ws, 'deep', 'sub'), 'd.png');
	const list = listImages(ws, { images: { sendAny: true } });
	assert.ok(list.includes('_stickers/a.png'), '表情包也在');
	assert.ok(list.includes('photo/猫.jpg'), '一级子目录里的图（相对路径）');
	assert.ok(list.includes('b.png'), '根目录里的图');
	assert.ok(list.includes('deep/c.png'), '一级子目录里的图');
	assert.ok(!list.includes('deep/sub/d.png'), '二级目录不扫');
});

test('超过 64 张：按修改时间新的留下', () => {
	const ws = join(home, 'ws-cap');
	for (let i = 0; i < 70; i++) put(join(ws, 'pics'), `p${String(i).padStart(2, '0')}.png`, 1_700_000_000 + i);
	const list = listImages(ws, { images: { sendAny: true } });
	assert.equal(list.length, 64, '总共最多 64 张');
	assert.equal(list[0], 'pics/p69.png', '最新的排最前');
	assert.ok(list.includes('pics/p06.png'), '第 64 张还在');
	assert.ok(!list.includes('pics/p05.png'), '最老的被截掉');
});

test('_stickers 超过 40 张还是随机抽 40（新逻辑没动它）', () => {
	const ws = join(home, 'ws-many');
	for (let i = 0; i < 50; i++) put(join(ws, '_stickers'), `s${String(i).padStart(2, '0')}.png`);
	const a = listImages(ws, { images: { sendAny: true } });
	const b = listImages(ws, { images: { sendAny: true } });
	assert.equal(a.length, 40, '还是只给 40 张');
	assert.notDeepEqual(a, b, '两次抽样不一样（还是随机抽）');
	// 多抽几次，确认后 10 张真的能出现（固定取前 40 的话永远出现不了）
	const seen = new Set();
	for (let i = 0; i < 12; i++) for (const f of listImages(ws, { images: { sendAny: true } })) seen.add(f);
	assert.equal(seen.size, 50, '多抽几次能把 50 张都覆盖到');
});

test('工作区不存在或扫不动：回退成 _stickers 清单，不抛', () => {
	assert.deepEqual(listImages(join(home, 'nope'), { images: { sendAny: true } }), [], '目录不存在：空清单');
	const notDir = join(home, 'not-a-dir');
	writeFileSync(notDir, '');
	assert.deepEqual(listImages(notDir, { images: { sendAny: true } }), [], '根路径不是目录：空清单，不抛');
	const ws = join(home, 'ws-broken');
	put(join(ws, '_stickers'), 'ok.png');
	assert.deepEqual(listImages(ws, { images: { sendAny: true } }), ['_stickers/ok.png'], '能扫的就只给表情包');
});
