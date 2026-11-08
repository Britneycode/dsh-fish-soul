/**
 * webp 转不了格式时：别静默丢掉。
 *
 * 为什么要有这个：
 *   这台机器没有 sharp（loadSharp() 返回 null），webp 只能靠浏览器 canvas 兜底。
 *   兜不住时 prepareImage 以前直接 return null，上层只写一条 warn 日志 ——
 *   表现是「表情包明明在库里，发出去什么都没有」，而且没有任何回执说明为什么。
 *
 *   抖音私信走 DOM.setFileInputFiles，这条路**绕过**文件框的 accept 过滤，
 *   而抖音官方客户端实现里 webp 走的是普通图片分支（aweType 2702，跟 png/jpeg 一样），
 *   所以原样发是有理的。没真机验过，所以做成「原样交出去、失败有回执」。
 *
 * 契约：
 *   ① 默认行为不变：没 sharp、没 canvas ⇒ 转不了 webp 就返回 null（QQ / B站 还靠这个）
 *   ② 打开 keepWebpIfNoConverter ⇒ 原样返回 webp，带 converted:false，不丢
 *   ③ 有 canvas 能转 ⇒ 仍然转（converted:true），不会因为开关就跳过转换
 *   ④ 非 webp 图片完全不受影响
 *   ⑤ dmImages 真的用了这个开关（不是只写了参数没人用）
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = `${process.env.TEMP || '/tmp'}/fish-soul-test-webp-${process.pid}-${Date.now()}`;
process.env.DSH_HOME = home;
const dir = join(home, 'imgs');
mkdirSync(dir, { recursive: true });

const { prepareImage, sniffImage } = await import('../lib/imageconv.js');

const ok = (msg) => console.log(`✓ ${msg}`);

/** 一张 1x1 的 webp（VP8L）。 */
function tinyWebp() {
	const payload = Buffer.from('2f00000000d0f5dc010000', 'hex');
	const body = Buffer.concat([
		Buffer.from('VP8L', 'ascii'),
		Buffer.from([payload.length & 0xff, 0, 0, 0]),
		payload,
	]);
	const riffSize = Buffer.alloc(4);
	riffSize.writeUInt32LE(body.length + 4, 0);
	return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WEBP', 'ascii'), body]);
}

/** 一张 1x1 的 png。 */
function tinyPng() {
	return Buffer.from(
		'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
		'0000000a49444154789c6300010000050001' + '0d0a2db4' + '0000000049454e44ae426082',
		'hex'
	);
}

const webpPath = join(dir, 'a.webp');
const pngPath = join(dir, 'a.png');
writeFileSync(webpPath, tinyWebp());
writeFileSync(pngPath, tinyPng());

// 先确认这两张图我们自己嗅探得对（不然下面全是假验）
assert.equal(sniffImage(tinyWebp()), 'webp', '测试用的 webp 得真的是 webp');
assert.equal(sniffImage(tinyPng()), 'png', '测试用的 png 得真的是 png');

const cacheDir = join(home, 'cache');

// ── ① 默认：转不了就返回 null（老行为，QQ / B站 靠它）──
{
	// 不给 canvasConvert、也没有 sharp ⇒ 转不了
	const r = await prepareImage(webpPath, { cacheDir, log: () => {} });
	assert.equal(r, null, '默认行为：转不了就 null（不能悄悄改了 QQ 那条路）');
	ok('默认：webp 转不了 → null（老行为保住）');
}

// ── ② 打开开关：原样返回，不丢 ──
{
	const r = await prepareImage(webpPath, { cacheDir, log: () => {} , keepWebpIfNoConverter: true });
	assert.ok(r !== null, '打开开关后不能返回 null —— 这张图不该被静默丢掉');
	assert.equal(r.type, 'webp', '类型要如实说是 webp');
	assert.equal(r.path, webpPath, '原样用原文件路径');
	assert.equal(r.converted, false, '要标出「没转过格式」');
	assert.ok(r.bytes.length > 0, '字节要带上');
	ok('开关：转不了就原样交出去（converted:false），不再静默丢弃');
}

// ── ③ 有 canvas 能转 ⇒ 还是转（开关不该让转换被跳过）──
{
	const r = await prepareImage(webpPath, {
		cacheDir,
		log: () => {},
		keepWebpIfNoConverter: true,
		// 假 canvas：直接把 png 字节当成转换结果
		canvasConvert: async () => tinyPng()
	});
	assert.ok(r !== null, '有转换器时要能转');
	assert.equal(r.type, 'png', '有 canvas 就转成 png');
	assert.equal(r.converted, true, '标出「确实是转过的」');
	ok('有 canvas：正常转 png（开关不会让转换被跳过）');
}

// ── ④ 非 webp 不受影响 ──
{
	const a = await prepareImage(pngPath, { cacheDir, log: () => {} });
	const b = await prepareImage(pngPath, { cacheDir, log: () => {}, keepWebpIfNoConverter: true });
	assert.equal(a?.type, 'png', 'png 原样返回');
	assert.equal(b?.type, 'png', '开关对 png 没影响');
	assert.equal(b?.path, pngPath, 'png 不经过转换');
	ok('非 webp：完全不受影响（png 原样走）');
}

// ── ⑤ dmImages 真的用了这个开关 ──
{
	const { readFileSync } = await import('node:fs');
	const gm = readFileSync(new URL('../lib/gateway-media.js', import.meta.url), 'utf8');
	assert.match(gm, /keepWebpIfNoConverter: true/, 'dmImages 要真的把这个开关传下去，否则等于没改');
	ok('dmImages：开关真的接上了（不是只写了参数没人用）');
}

console.log('\nimage-webp-fallback ok');
