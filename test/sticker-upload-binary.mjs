// 表情包导入：原始二进制流式上传（新路）。
//
// 为什么加这条：base64 + JSON 那条路太窄 ——
//   · base64 膨胀 33%
//   · 客户端 读→切片→stringify→编码 要 4× 峰值内存
//   · 服务端 Buffer.concat().toString() + JSON.parse 再吃 2.4×
//   · 中文文件名更糟：V8 里含一个非 Latin1 字符就把整串升 TwoByte，再翻倍
// 965KB 的 GIF（base64 后 1257KB）撞上旧的 256KB 共享上限，就是用户遇到的失败。
//
// 新路：前端 `fetch(url, { body: File })` 直接发二进制，后端流式写临时文件。
// 内存几乎不随文件大小增长，上限从 4MB 提到 20MB。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

process.env.DSH_HOME = tmpHome('sticker-binary-');
const { openDatabase } = await import('../lib/db.js');
const { StickerBox } = await import('../lib/stickers.js');
const { handleV07Route } = await import('../lib/routes-v07.js');

const ok = (n) => console.log('✓', n);
const db = openDatabase();
const ws = join(process.env.DSH_HOME, 'workspace');
mkdirSync(ws, { recursive: true });
const stickers = new StickerBox({ db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), log: () => {} });

const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** 造一个指定字节数的合法 GIF（注释扩展段，每块最多 255 字节）。 */
function gifOfSize(total) {
	const head = Buffer.concat([GIF_1PX.slice(0, 6), Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]), Buffer.from([0x21, 0xFE])]);
	const blocks = [];
	let left = Math.max(0, total - head.length - GIF_1PX.slice(19).length - 1);
	while (left > 0) { const n = Math.min(255, left); blocks.push(Buffer.from([n]), Buffer.alloc(n, 0x41)); left -= n; }
	return Buffer.concat([head, ...blocks, Buffer.from([0x00]), GIF_1PX.slice(19)]);
}

/** 模拟一次二进制上传：分块推给 req（像真网络那样）。 */
async function uploadBinary(bytes, { name = '测试', contentType = 'image/gif', chunkSize = 64 * 1024 } = {}) {
	let sent = null;
	const req = {
		method: 'POST',
		url: '/stickers/import',
		headers: { 'sec-fetch-site': 'same-origin', 'content-type': contentType, 'content-length': String(bytes.length) },
		destroyed: false,
		pause() { this.paused = true; },
		resume() { this.paused = false; },
		destroy() { this.destroyed = true; },
		on(ev, fn) { (this._h ??= {})[ev] ??= []; this._h[ev].push(fn); return this; },
		once(ev, fn) { return this.on(ev, fn); },
		removeListener() { return this; },
		async *[Symbol.asyncIterator]() {
			for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
		}
	};
	// pipeline 用 asyncIterator；同时手动触发 data/end 让老式监听也能工作
	const url = new URL(`http://localhost/stickers/import?name=${encodeURIComponent(name)}`);
	await handleV07Route({
		method: 'POST', path: '/stickers/import', url, req, res: {},
		send: (status, obj) => { sent = { status, ...obj }; },
		readBody: async () => { throw new Error('这条路不该用 readBody（会把二进制弄坏）'); },
		sameOrigin: () => true,
		deps: { db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), saveConfig: () => {}, stickers, gateway: { workspacePath: () => ws }, log: () => {} }
	});
	return sent;
}

{
	// ① 小 GIF 走二进制路
	const r = await uploadBinary(GIF_1PX, { name: '二进制小图' });
	assert.equal(r.ok, true, `二进制上传要能导入，实际：${JSON.stringify(r)}`);
	assert.match(r.file, /\.gif$/, '要落成 .gif');
	ok('小 GIF 走原始二进制 → 导入成功');
}

{
	// ② 1.3MB（用户那个 GIF 的量级）—— 旧 base64 路的死区
	const gif = gifOfSize(1_300_000);
	const r = await uploadBinary(gif, { name: '1.3MB的表情' });
	assert.equal(r.ok, true, `1.3MB 要能导入，实际：${JSON.stringify(r)}`);
	const saved = readFileSync(join(ws, '_stickers', r.file));
	assert.equal(saved.length, gif.length, '字节数要一致（没被截断）');
	assert.equal(saved.slice(0, 6).toString(), 'GIF89a', 'GIF 头完好');
	assert.equal(saved[saved.length - 1], 0x3b, 'GIF 尾字节 0x3B 完好');
	ok('1.3MB GIF 能导入且完整（旧 base64 路在这一档必失败）');
}

{
	// ③ 8MB —— 验证流式真的没把整包读进内存（能过就说明上限按字节算）
	const gif = gifOfSize(8 * 1024 * 1024);
	const before = process.memoryUsage().heapUsed;
	const r = await uploadBinary(gif, { name: '8MB大图' });
	const after = process.memoryUsage().heapUsed;
	assert.equal(r.ok, true, `8MB 要能导入，实际：${JSON.stringify(r)}`);
	const saved = readFileSync(join(ws, '_stickers', r.file));
	assert.equal(saved.length, gif.length, '8MB 字节数要一致');
	// 堆增长不该接近文件大小（流式写盘的特征）。放宽到 4MB 容忍 GC 抖动。
	const grew = after - before;
	assert.ok(grew < 4 * 1024 * 1024, `堆增长 ${Math.round(grew / 1024)}KB 应该远小于 8MB（流式写盘）`);
	ok(`8MB GIF 能导入（堆只涨了 ${Math.round(grew / 1024)}KB，确认是流式）`);
}

{
	// ④ 超上限要明确拒绝，别留半截文件
	const before = new Set(readdirSync(join(ws, '_stickers')));
	const huge = gifOfSize(21 * 1024 * 1024);
	const r = await uploadBinary(huge, { name: '超大' });
	assert.equal(r.ok, false, '超 20MB 要拒绝');
	assert.match(String(r.error ?? ''), /太大/, `理由要说清，实际：${r.error}`);
	const after = new Set(readdirSync(join(ws, '_stickers')));
	const leftovers = [...after].filter((f) => !before.has(f) && f.startsWith('.upload-'));
	assert.deepEqual(leftovers, [], '失败不能留临时文件');
	ok('超上限明确拒绝，且不留半截临时文件');
}

{
	// ⑤ 不是图片要拒绝（类型以字节嗅探为准，不信 content-type）
	const r = await uploadBinary(Buffer.from('这不是图片内容'), { name: '假图', contentType: 'image/gif' });
	assert.equal(r.ok, false, '非图片要拒绝');
	assert.match(String(r.error ?? ''), /不是支持的图片格式/);
	ok('content-type 说是 image/gif 但内容不是图 → 按字节嗅探拒绝');
}

{
	// ⑥ 中文文件名走查询串（放 header 会抛）
	const gif = gifOfSize(2000);
	const r = await uploadBinary(gif, { name: '我的表情 🐟' });
	assert.equal(r.ok, true, `中文/emoji 文件名要能导入，实际：${JSON.stringify(r)}`);
	assert.match(r.file, /我的表情/, '文件名要保留中文（只做安全化，不丢字）');
	ok('中文 + emoji 文件名正常（走查询串，不塞 header）');
}

{
	// ⑦ 旧路（JSON + base64）仍然可用 —— 向后兼容
	let sent = null;
	const payload = JSON.stringify({ name: '旧路', mediaType: 'image/gif', base64: gifOfSize(3000).toString('base64') });
	const req = {
		method: 'POST', url: '/stickers/import',
		headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
		destroyed: false,
		on(ev, fn) { if (ev === 'data') fn(Buffer.from(payload)); if (ev === 'end') fn(); return this; },
		destroy() { this.destroyed = true; }
	};
	await handleV07Route({
		method: 'POST', path: '/stickers/import', url: new URL('http://localhost/stickers/import'), req, res: {},
		send: (s, o) => { sent = { s, ...o }; },
		readBody: (r, log, maxBytes) => import('../lib/routes.js').then((m) => m.readBody(r, log, maxBytes)),
		sameOrigin: () => true,
		deps: { db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), saveConfig: () => {}, stickers, gateway: { workspacePath: () => ws }, log: () => {} }
	});
	assert.equal(sent?.ok, true, `旧 base64 路要还能用（向后兼容），实际：${JSON.stringify(sent)}`);
	ok('旧路（JSON + base64）仍可用（向后兼容）');
}

console.log('sticker-upload-binary ok');
