// 表情包导入：GIF 到底卡在哪。
//
// 2026-11-12 用户报「本地 GIF 导入不进去」。静态看不出问题：
// 前端 accept 含 gif、readBase64 正常、isBase64 能过、sniffImage 认 GIF、
// EXT 有 image/gif → gif、MEDIA_TYPES 也含 image/gif。
//
// 这个测试走**真链路**（真 StickerBox + 真 handleV07Route + 真 HTTP body），
// 用真实 GIF 字节，钉住整条路。如果它在本地过，那问题就在浏览器侧或体积。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DSH_HOME = tmpHome('sticker-gif-');
const { openDatabase } = await import('../lib/db.js');
const { StickerBox } = await import('../lib/stickers.js');
const { handleV07Route } = await import('../lib/routes-v07.js');

const ok = (n) => console.log('✓', n);
const db = openDatabase();

// 工作区
const ws = join(process.env.DSH_HOME, 'workspace');
mkdirSync(ws, { recursive: true });

const stickers = new StickerBox({ db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), log: () => {} });

// 真实 GIF89a（1x1 透明，42 字节）
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// 造一个「像表情包」的大 GIF（约 300KB）：注释扩展段，每个子块最长 255 字节。
// GIF 规范里子块长度是 1 字节，所以只能拼很多个 255 字节的块。
function bigGifOf(targetBytes) {
	const head = Buffer.concat([
		GIF_1PX.slice(0, 6),                                     // GIF89a
		Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),  // 逻辑屏幕 1x1
		Buffer.from([0x21, 0xFE])                                // 注释扩展
	]);
	const blocks = [];
	let left = targetBytes;
	while (left > 0) {
		const n = Math.min(255, left);
		blocks.push(Buffer.from([n]), Buffer.alloc(n, 0x41));
		left -= n;
	}
	const tail = Buffer.concat([
		Buffer.from([0x00]),                                     // 块终止符
		GIF_1PX.slice(19)                                        // 图像描述符 + 数据 + 结尾
	]);
	return Buffer.concat([head, ...blocks, tail]);
}
const bigGif = bigGifOf(300_000);

async function callImport(bytes, mediaType, name) {
	let sent = null;
	const raw = JSON.stringify({ name, mediaType, base64: bytes.toString('base64') });
	const req = {
		method: 'POST',
		url: '/stickers/import',
		headers: { 'sec-fetch-site': 'same-origin' },
		on(ev, fn) {
			if (ev === 'data') fn(Buffer.from(raw));
			if (ev === 'end') fn();
			return this;
		},
		destroy() { this.destroyed = true; }
	};
	await handleV07Route({
		method: 'POST',
		path: '/stickers/import',
		url: new URL('http://localhost/stickers/import'),
		req,
		res: {},
		send: (status, obj) => { sent = { status, ...obj }; },
		readBody: (r, log, maxBytes) => {
			// 复用真 readBody，验证上限参数真的生效
			return import('../lib/routes.js').then((m) => m.readBody(r, log, maxBytes));
		},
		sameOrigin: () => true,
		deps: {
			db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), saveConfig: () => {},
			stickers, gateway: { workspacePath: () => ws }, log: () => {}
		}
	});
	return sent;
}

{
	// ① 小 GIF 直接导入
	const r = await callImport(GIF_1PX, 'image/gif', '小GIF');
	assert.equal(r.ok, true, `小 GIF 要能导入，实际：${JSON.stringify(r)}`);
	assert.match(r.file, /\.gif$/, '存下来的文件名要以 .gif 结尾');
	assert.ok(existsSync(join(ws, '_stickers', r.file)), '文件要真的落盘');
	ok('小 GIF 能导入（.gif 后缀、文件落盘）');
}

{
	// ② 大 GIF（约 300KB，模拟真表情包）
	const r = await callImport(bigGif, 'image/gif', '大GIF');
	assert.equal(r.ok, true, `300KB GIF 要能导入（共享 256KB 上限不该拦它），实际：${JSON.stringify(r)}`);
	const size = readFileSync(join(ws, '_stickers', r.file)).length;
	assert.ok(size > 200_000, `落盘大小要对（实际 ${size} 字节）`);
	ok('300KB GIF 能导入（走 import 自己的 6MB 上限，不是共享的 256KB）');
}

{
	// ③ 浏览器给的 mediaType 可能是空 / 怪值：以字节嗅探为准。
	//    用一张**没导过**的 GIF（同 sha1 会被判 dup，测不出嗅探）。
	const gif2 = Buffer.concat([GIF_1PX.slice(0, 19), Buffer.from([0x21, 0xFE, 0x02, 0x41, 0x42, 0x00]), GIF_1PX.slice(19)]);
	const r = await callImport(gif2, '', '无名GIF');
	assert.equal(r.ok, true, `mediaType 为空时该按字节嗅探，实际：${JSON.stringify(r)}`);
	assert.match(r.file, /\.gif$/, '嗅探出来要落成 .gif');
	ok('mediaType 为空也能按字节认成 GIF');
}

{
	// ④ 真的不是图片：要明确拒绝
	const r = await callImport(Buffer.from('这不是图片'), 'image/gif', '假GIF');
	assert.equal(r.ok, false, '非图片内容要拒绝');
	assert.match(r.error, /不是支持的图片格式/, '要说清是格式问题');
	ok('非图片内容明确拒绝（不静默成功）');
}

{
	// ⑤ 超过上限的 GIF 要拒绝，而且理由要说清。
	// 上限从 4MB 提到 20MB（改成原始二进制流式上传后，内存不再是约束）。
	const huge = Buffer.concat([GIF_1PX, Buffer.alloc(20 * 1024 * 1024 + 1024, 0)]);
	const r = await callImport(huge, 'image/gif', '超大GIF');
	assert.equal(r.ok, false, '超过 20MB 要拒绝');
	assert.match(r.error, /太大/, '理由要说清是太大');
	ok('超过 20MB 明确拒绝');
}

{
	// ⑥ 同一张图重复导入 → 标 dup（不是报失败）。
	//    用一张前面没导过的 GIF，否则第一次就撞上已有记录。
	const fresh = Buffer.concat([GIF_1PX.slice(0, 19), Buffer.from([0x21, 0xFE, 0x03, 0x43, 0x44, 0x45, 0x00]), GIF_1PX.slice(19)]);
	const a = await callImport(fresh, 'image/gif', '重名');
	assert.equal(a.ok, true, `第一次要能导入，实际：${JSON.stringify(a)}`);
	const b = await callImport(fresh, 'image/gif', '重名');
	assert.equal(b.ok, false, '同一张图（同 sha1）第二次导入应判重复');
	assert.equal(b.dup, true, '要标 dup，前端才知道是「已经有了」不是「失败」');
	ok('同一张图重复导入标 dup（不是报失败）');
}

console.log('sticker-import-gif ok');
