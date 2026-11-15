// 抖音评论图片的出站边界：模型给的路径只能落在工作区 _stickers/ 里。
// 验证纪律：先见红（改前 .. 能读到工作区外的文件），再修；修完见绿。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const ok = (name) => console.log('✓', name);

const home = tmpHome('dy-img-bnd-');
process.env.DSH_HOME = join(home, 'dsh');
const ws = join(home, 'ws');
mkdirSync(join(ws, '_stickers'), { recursive: true });

const { DouyinSocial } = await import('../lib/douyin-social.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const MAX = 10 * 1024 * 1024;

// ── 越界目标：都在 _stickers 之外 ──
const secret = join(home, 'secret.png'); // 工作区外
writeFileSync(secret, Buffer.from('SECRET-OUTSIDE-WORKSPACE'));
writeFileSync(join(ws, 'outside-stickers.png'), Buffer.from('WORKSPACE-LEVEL')); // 工作区内、_stickers 外
const outsideDir = join(home, 'outside'); // 工作区外的目录（junction 指向它）
mkdirSync(outsideDir, { recursive: true });
writeFileSync(join(outsideDir, 'secret.png'), Buffer.from('SECRET-VIA-JUNCTION'));

// ── _stickers 里的正常文件 ──
writeFileSync(join(ws, '_stickers', 'ok.png'), PNG);
writeFileSync(join(ws, '_stickers', 'ok.jpg'), Buffer.from([0xff, 0xd8, 0xff, 1]));
writeFileSync(join(ws, '_stickers', 'ok.jpeg'), Buffer.from([0xff, 0xd8, 0xff, 2]));
writeFileSync(join(ws, '_stickers', 'ok.gif'), Buffer.from('GIF89a123', 'latin1'));
writeFileSync(join(ws, '_stickers', 'ok.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]));
writeFileSync(join(ws, '_stickers', 'notes.txt'), Buffer.from('不是图'));
mkdirSync(join(ws, '_stickers', 'dir.png'), { recursive: true }); // 目录冒充图片
writeFileSync(join(ws, '_stickers', 'big.png'), Buffer.alloc(MAX + 1)); // 超 10MB
writeFileSync(join(ws, '_stickers', 'exact.png'), Buffer.alloc(MAX)); // 正好 10MB：收

// ── 软链接 / junction 逃逸 ──
let fileLink = false;
try {
	symlinkSync(secret, join(ws, '_stickers', 'link.png'), 'file');
	fileLink = true;
} catch { /* Windows 没开开发者模式：软链接建不了，跳过这一条（junction 那条照跑） */ }
symlinkSync(outsideDir, join(ws, '_stickers', 'junc'), 'junction');

const logs = [];
const social = new DouyinSocial({
	host: { running: false, exclusive: async (n, fn) => fn() },
	getConfig: () => ({}),
	log: (...a) => { logs.push(a.map(String).join(' ')); },
	callLlm: async () => '',
	stickers: { list: () => [], resolveFeelRefs: async (t) => ({ text: t, resolved: [] }) },
	workspacePath: () => ws,
});

const pick = async (rel) => await social.replyImages(`看 ![x](${rel})`);

// ── .. 越界：读不到工作区外 ──
{
	const r = await pick('_stickers/../../secret.png');
	assert.equal(r.images.length, 0, '.. 不能读工作区外的文件');
	assert.equal(r.text.trim(), '看', '引用照样从文字里剥掉');
	const r2 = await pick('_stickers/../outside-stickers.png');
	assert.equal(r2.images.length, 0, '.. 不能读 _stickers 外的文件');
	assert.ok(logs.some((l) => l.includes('越界') || l.includes('拒绝')), '越界要留一条日志（别悄悄吞）');
	ok('评论图片：.. 越界被挡住（工作区外 / _stickers 外）');
}

// ── 软链接 / junction 逃逸 ──
{
	const r = await pick('_stickers/junc/secret.png');
	assert.equal(r.images.length, 0, 'junction 指向工作区外 → 不发');
	if (fileLink) {
		const r2 = await pick('_stickers/link.png');
		assert.equal(r2.images.length, 0, '软链接指向工作区外 → 不发');
		ok('评论图片：软链接 / junction 逃逸被挡住');
	} else {
		ok('评论图片：junction 逃逸被挡住（软链接：Windows 没权限建，跳过）');
	}
}

// ── 目录 / 格式 / 大小 ──
{
	assert.equal((await pick('_stickers/dir.png')).images.length, 0, '目录不能当图发');
	assert.equal((await pick('_stickers/notes.txt')).images.length, 0, '非图片格式不发');
	assert.equal((await pick('_stickers/big.png')).images.length, 0, '超过 10MB 不发');
	ok('评论图片：目录 / 非图片格式 / 超 10MB 被挡住');
}

// ── 正常图照发：五种格式原样，10MB 整数收 ──
{
	for (const n of ['ok.png', 'ok.jpg', 'ok.jpeg', 'ok.gif', 'ok.webp']) {
		const r = await pick(`_stickers/${n}`);
		assert.equal(r.images.length, 1, `${n} 应该被收下`);
		assert.equal(r.images[0].format, '', `${n} 不自己猜格式（交给 ImageX 返回的）`);
	}
	const r = await pick('_stickers/ok.png');
	assert.ok(r.images[0].bytes.equals(PNG), '读的是文件本体');
	const r2 = await pick('_stickers/exact.png');
	assert.equal(r2.images.length, 1, '正好 10MB 应该收');
	ok('评论图片：png/jpg/jpeg/gif/webp 原样发，10MB 整数收');
}

// ── 非 _stickers 路径照旧不理（不是图，不发） ──
{
	assert.equal((await pick('sub/other.png')).images.length, 0, '不在 _stickers/ 下的路径不发');
	assert.equal((await pick('https://example.com/a.png')).images.length, 0, '外链不在这条路上发');
	ok('评论图片：_stickers 以外的路径不发');
}

console.log('douyin-image-boundary ok');
