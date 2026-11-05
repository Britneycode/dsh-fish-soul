// 表情包面板的目录管理：主人直接放进 _stickers 的图、改名、删；导入不占每天收藏的额度。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';
import { getKv } from '../lib/db.js';
import { StickerBox, stickerConfig } from '../lib/stickers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
const PNG2 = Buffer.concat([PNG, Buffer.from([0])]);

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

const home = tmpHome('fs-sticker-');
const ws = join(home, 'ws');
mkdirSync(join(ws, '_stickers'), { recursive: true });
const box = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 10 }) });

// 1. 主人直接放进 _stickers 的图：面板里能看见，但不该写 kv
writeFileSync(join(ws, '_stickers', '主人放的.png'), PNG);
{
	const items = box.list(ws);
	const orphan = items.find((x) => x.file === '主人放的.png');
	assert.ok(orphan, '主人放进 _stickers 的图要出现在面板里');
	assert.equal(orphan.tracked, false, '它不是收藏记录');
	assert.equal(orphan.exists, true);
	assert.equal(orphan.from, '主人放的');
	assert.equal(orphan.workspacePath, ws);
	assert.ok(orphan.at > 0, '时间用文件的修改时间');
	assert.equal(getKv(db, 'stickers.collected', null), null, '看目录不写 kv');
}

// 2. 收藏记录也在清单里；文件没了标 exists=false
const imported = box.importImage({ bytes: PNG, mediaType: 'image/png', name: '狗头', workspacePath: ws, from: '主人' });
assert.equal(imported.ok, true, imported.reason);
{
	const hit = box.list(ws).find((x) => x.file === imported.file);
	assert.ok(hit, '收藏的也要在清单里');
	assert.equal(hit.tracked, true);
	assert.equal(hit.exists, true);
	assert.equal(box.list(ws).filter((x) => x.file === imported.file).length, 1, '同一个文件只出现一次');
}

// 3. 改名：收藏过的 → 文件改名，记录同步
{
	const r = box.rename(imported.file, '新名字', ws);
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.file, '新名字.png');
	assert.equal(existsSync(join(ws, '_stickers', '新名字.png')), true);
	assert.equal(existsSync(join(ws, '_stickers', imported.file)), false);
	assert.equal(box.collected()[0].file, '新名字.png', '收藏记录里的文件名要跟着改');
}

// 4. 改名：主人放的 → 只改文件，不写 kv
{
	const before = JSON.stringify(getKv(db, 'stickers.collected', []));
	const r = box.rename('主人放的.png', '换个名', ws);
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.file, '换个名.png');
	assert.equal(existsSync(join(ws, '_stickers', '换个名.png')), true);
	assert.equal(JSON.stringify(getKv(db, 'stickers.collected', [])), before, '主人放的改名不该动 kv');
}

// 5. 撞名：明确拒绝，不自动加序号
{
	const r = box.rename('换个名.png', '新名字', ws);
	assert.equal(r.ok, false);
	assert.match(r.reason, /同名/);
	assert.equal(existsSync(join(ws, '_stickers', '换个名.png')), true, '拒绝时原文件不动');
	assert.equal(existsSync(join(ws, '_stickers', '新名字2.png')), false, '不自动加序号');
}

// 6. 改成同一个名字：幂等
{
	const r = box.rename('换个名.png', '换个名', ws);
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.file, '换个名.png');
	assert.equal(existsSync(join(ws, '_stickers', '换个名.png')), true);
}

// 7. 文件不在 _stickers 里：拒绝
{
	assert.equal(box.rename('根本没有.png', 'x', ws).ok, false);
	assert.equal(box.rename('新名字.png', 'x', join(home, '别的工作区')).ok, false, '别的目录里的同名文件不算');
}

// 8. 删：主人放的也能删
{
	assert.equal(box.remove('换个名.png', ws), true);
	assert.equal(existsSync(join(ws, '_stickers', '换个名.png')), false);
	assert.equal(box.remove('换个名.png', ws), false, '删过就没了');
}

// 9. 删：文件已经没了，收藏记录也要删掉
{
	unlinkSync(join(ws, '_stickers', '新名字.png'));
	assert.equal(box.remove('新名字.png', ws), true);
	assert.equal(box.collected().length, 0);
	assert.equal(box.remove('新名字.png', ws), false);
}

// 10. 导入不占每天收藏的额度：perDay=0 也照样能导
{
	const box0 = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 0 }) });
	const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
	const before = getKv(db, `stickers.day.${day}`, 0);
	const r = box0.importImage({ bytes: PNG2, mediaType: 'image/png', name: '导入的', workspacePath: ws, from: '主人' });
	assert.equal(r.ok, true, r.reason);
	assert.equal(getKv(db, `stickers.day.${day}`, 0), before, '导入不占每天收藏的额度');
	// 但她自己收藏（聊天里存）是要占额度的：perDay=0 存不进来
	box0.remember('s1', { bytes: PNG2, mediaType: 'image/png', sticker: true });
	const blocked = box0.collect('s1', '要存的', ws, { from: '某人' });
	assert.equal(blocked.ok, false);
	assert.match(blocked.reason, /存够了/);
}

console.log('✓ 表情包面板：目录里的图看得见、改名、删；导入不占每天收藏的额度');
