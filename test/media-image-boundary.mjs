// 出站图片的信任根边界：QQ / B站 / 抖音私信发图时，工作区（和插件数据目录）自己必须是普通目录。
// 漏洞形态：信任根只 realpath 了一层 —— 根自己要是 junction（指到工作区外），真实路径整个落到
// 工作区外，只拿 realRoot 去比是拦不住的，工作区外的图照样读出来发出去。
// 验证纪律：先见红（改前根 = junction 时能读到工作区外的文件），再修；修完见绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { 抠正文图 } from '../lib/channels/vendor/qq-bridge.js';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('media-img-bnd-');
process.env.DSH_HOME = join(home, 'dsh');

const { ChatGateway } = await import('../lib/gateway.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const MAX = 10 * 1024 * 1024;

/** 真实的 ChatGateway 壳：只要 log 和 canvasConvert。 */
const gateway = (logs = []) => Object.assign(Object.create(ChatGateway.prototype), {
	log: (...args) => { logs.push(args.map(String).join(' ')); },
	canvasConvert: null,
});

const b64 = (r) => Buffer.from(r.data.file.slice('base64://'.length), 'base64');
const ws = (name) => { const p = join(home, name); mkdirSync(p, { recursive: true }); return p; };

test('工作区里的正常图照发（根是普通目录时不受影响）', async () => {
	const w = ws('ws-ok');
	writeFileSync(join(w, 'ok.png'), PNG);
	const g = gateway();
	assert.ok(g.localImagePath('ok.png', w), 'localImagePath 要给得出真实路径');
	assert.deepEqual(b64(g.resolveImageFile('ok.png', w)), PNG, 'QQ 出站要拿到图本身');
	const dm = await g.dmImages({ workspace_path: w }, 抠正文图('![x](ok.png)').图, { images: [] });
	assert.equal(dm.length, 1, '私信要带上这张图');
	assert.deepEqual(dm[0].bytes, PNG);
});

test('插件数据目录里的图照发（第二个根没被误伤）', () => {
	const dataDir = join(home, 'dsh', 'fish-soul');
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, 'data.png'), PNG);
	const w = ws('ws-data');
	const g = gateway();
	assert.ok(g.localImagePath(join(dataDir, 'data.png'), w), '数据目录里的图能发');
});

test('.. 越界：工作区外的文件读不到', () => {
	const w = ws('ws-dotdot');
	writeFileSync(join(home, 'secret.png'), PNG);
	const g = gateway();
	assert.equal(g.localImagePath(join(w, '..', 'secret.png'), w), null);
	assert.equal(g.resolveImageFile(join(w, '..', 'secret.png'), w), null);
});

test('工作区内部的 junction 指向工作区外：读不到', () => {
	const w = ws('ws-inner');
	const outside = join(home, 'outside');
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, 'secret.png'), PNG);
	symlinkSync(outside, join(w, 'escape'), 'junction'); // Windows 建 junction 不需要特权
	const g = gateway();
	assert.equal(g.localImagePath(join('escape', 'secret.png'), w), null, '内部 junction 不能当通路');
	assert.equal(g.resolveImageFile(join('escape', 'secret.png'), w), null);
});

test('工作区根本身是 junction：整根不可信，工作区外的图发不出去', async () => {
	const outside = join(home, 'root-outside');
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, 'secret.png'), PNG);
	const w = join(home, 'ws-root-junction');
	symlinkSync(outside, w, 'junction'); // 根 = junction
	const logs = [];
	const g = gateway(logs);
	assert.equal(g.localImagePath('secret.png', w), null, 'localImagePath 不能返回工作区外的图');
	assert.equal(g.resolveImageFile('secret.png', w), null, 'QQ 出站不能读出工作区外的图');
	const dm = await g.dmImages({ workspace_path: w }, 抠正文图('![x](secret.png)').图, { images: [] });
	assert.equal(dm.length, 0, '私信不能带上工作区外的图');
	assert.ok(logs.some((l) => l.includes('不可信')), '根不可信要留一条日志（别悄悄吞）');
});

test('插件数据目录本身是 junction：整根不可信', () => {
	const target = join(home, 'data-outside');
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, 'data.png'), PNG);
	const dshHome2 = join(home, 'dsh-junction');
	mkdirSync(dshHome2, { recursive: true });
	symlinkSync(target, join(dshHome2, 'fish-soul'), 'junction'); // 数据目录根 = junction
	const prev = process.env.DSH_HOME;
	process.env.DSH_HOME = dshHome2;
	try {
		const g = gateway();
		assert.equal(g.localImagePath(join(dshHome2, 'fish-soul', 'data.png'), ws('ws-data2')), null, '数据目录根不可信');
	} finally { process.env.DSH_HOME = prev; }
});

test('格式 / 大小：不回归', () => {
	const w = ws('ws-format');
	writeFileSync(join(w, 'note.txt'), PNG);
	mkdirSync(join(w, 'dir.png'));
	writeFileSync(join(w, 'big.png'), Buffer.alloc(MAX + 1));
	writeFileSync(join(w, 'exact.png'), Buffer.alloc(MAX));
	const g = gateway();
	assert.equal(g.localImagePath('note.txt', w), null, '非图片扩展名');
	assert.equal(g.localImagePath('dir.png', w), null, '目录不能当图');
	assert.equal(g.localImagePath('big.png', w), null, '超过 10MB');
	assert.ok(g.localImagePath('exact.png', w), '正好 10MB 收');
});
