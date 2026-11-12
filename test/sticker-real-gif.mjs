// 用真实 GIF 跑一遍导入链路（用户提供的文件）。
//
// 2026-11-12：用户报「本地那个 GIF 图导入不进去」，文件是
// C:\Users\13372\Downloads\95BC0E6AC65107FCC2990285387AA790.gif
// 965,713 字节、256x256、GIF89a。
//
// base64 后约 1.29MB —— 超过旧的共享 256KB body 上限，正是修复要覆盖的场景。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'C:/Users/13372/Downloads/95BC0E6AC65107FCC2990285387AA790.gif';
if (!existsSync(SRC)) {
	console.log('（跳过：本机没有这个 GIF）');
	process.exit(0);
}

process.env.DSH_HOME = tmpHome('sticker-real-gif-');
const { openDatabase } = await import('../lib/db.js');
const { StickerBox } = await import('../lib/stickers.js');
const { handleV07Route } = await import('../lib/routes-v07.js');
const { readBody } = await import('../lib/routes.js');

const ok = (n) => console.log('✓', n);
const db = openDatabase();
const ws = join(process.env.DSH_HOME, 'workspace');
mkdirSync(ws, { recursive: true });

const stickers = new StickerBox({ db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), log: () => {} });
const bytes = readFileSync(SRC);
const b64 = bytes.toString('base64');
console.log(`  真实文件：${bytes.length} 字节，base64 后 ${b64.length} 字节（约 ${Math.round(b64.length / 1024)}KB）`);

async function callImport(payload, { maxBody = null } = {}) {
	let sent = null;
	const raw = JSON.stringify(payload);
	const req = {
		method: 'POST', url: '/stickers/import',
		headers: { 'sec-fetch-site': 'same-origin' },
		on(ev, fn) {
			if (ev === 'data') fn(Buffer.from(raw));
			if (ev === 'end') fn();
			return this;
		},
		destroy() { this.destroyed = true; }
	};
	await handleV07Route({
		method: 'POST', path: '/stickers/import',
		url: new URL('http://localhost/stickers/import'),
		req, res: {},
		send: (status, obj) => { sent = { status, ...obj }; },
		// 模拟真实宿主：把共享 readBody 传下去（不传 maxBody 时用它的默认 256KB）
		readBody: (r, log, mb) => readBody(r, log, mb ?? (maxBody ?? undefined)),
		sameOrigin: () => true,
		deps: { db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), saveConfig: () => {}, stickers, gateway: { workspacePath: () => ws }, log: () => {} }
	});
	return sent;
}

{
	// ① 先证明：**旧的共享上限会拦掉它** —— 这是用户遇到的真实故障
	let sent = null;
	const raw = JSON.stringify({ name: '真实GIF', mediaType: 'image/gif', base64: b64 });
	const req = {
		method: 'POST', url: '/stickers/import', headers: { 'sec-fetch-site': 'same-origin' },
		on(ev, fn) {
			// 模拟分块到达，触发上限判断
			if (ev === 'data') {
				for (let i = 0; i < raw.length; i += 64 * 1024) fn(Buffer.from(raw.slice(i, i + 64 * 1024)));
			}
			if (ev === 'end') fn();
			return this;
		},
		destroy() { this.destroyed = true; }
	};
	await handleV07Route({
		method: 'POST', path: '/stickers/import', url: new URL('http://localhost/stickers/import'),
		req, res: {}, send: (s, o) => { sent = { s, ...o }; },
		// 故意不传 maxBytes —— 模拟修复前的共享 256KB 上限
		readBody: (r, log) => readBody(r, log),
		sameOrigin: () => true,
		deps: { db, getConfig: () => ({ stickers: { collect: true, perDay: 10 } }), saveConfig: () => {}, stickers, gateway: { workspacePath: () => ws }, log: () => {} }
	});
	assert.equal(sent?.ok, false, '旧的 256KB 共享上限必须拦住这个 1.29MB body（这就是用户看到的失败）');
	assert.match(String(sent?.error ?? ''), /请求没读完|太大/, `失败理由要说清，实际：${JSON.stringify(sent)}`);
	ok(`复现：旧的 256KB 共享上限会拦掉它（${Math.round(b64.length / 1024)}KB base64）`);
}

{
	// ② 修复后：import 走自己的 6MB 上限，这张要能进
	const r = await callImport({ name: '真实GIF', mediaType: 'image/gif', base64: b64 });
	assert.equal(r.ok, true, `修复后真实 GIF 要能导入，实际：${JSON.stringify(r)}`);
	assert.match(r.file, /\.gif$/, '要落成 .gif');
	const saved = join(ws, '_stickers', r.file);
	assert.ok(existsSync(saved), '文件要真的写进 _stickers');
	assert.equal(statSync(saved).size, bytes.length, '字节数要和原文件一致（没有被截断）');
	// 内容一致性：头尾都对得上
	const back = readFileSync(saved);
	assert.equal(back.slice(0, 6).toString(), 'GIF89a', 'GIF 头要完好');
	assert.equal(back.slice(-1)[0], 0x3b, 'GIF 尾字节 0x3B 要完好（说明没被截断）');
	ok('修复后真实 GIF 能完整导入（字节数一致、头尾完好）');
}

{
	// ③ 列表里要能看见它（面板靠 /stickers/state）
	const list = stickers.list(ws);
	const hit = list.find((x) => /真实GIF/.test(x.file));
	assert.ok(hit !== undefined, '导入后要出现在 _stickers 清单里');
	assert.equal(hit.exists, true, '清单里要标 exists');
	ok('导入后出现在清单里（面板能看到）');
}

{
	// ④ 能删（用户说「不支持删除」）
	const file = stickers.list(ws).find((x) => /真实GIF/.test(x.file)).file;
	assert.equal(stickers.remove(file, ws), true, '要能删掉');
	assert.equal(existsSync(join(ws, '_stickers', file)), false, '删了文件要真的没了');
	ok('导入的 GIF 能删除');
}

console.log('sticker-real-gif ok');
