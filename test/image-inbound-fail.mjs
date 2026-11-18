// #147 入站图片：8 秒写死超时对大图/弱网太苛（真机 3.7KB 就 5.2s），放宽到 20s 并按源重试一次；
// 下载失败以前只走不落盘的宿主日志，桌面版查不到 —— 现在落 diag-log（image-skip），
// 分「太大 / 下载失败 / 没交给宿主」三类。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-image-inbound-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { DiagLog } = await import('../lib/diag-log.js');
const { registerRoutes } = await import('../lib/routes.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const mount = (deps) => {
	let handler = null;
	registerRoutes({ effect: (fn) => fn(), webServer: { register: (o) => { handler = o.handler; } } }, deps);
	return async (path, method = 'GET') => {
		let out = null;
		await handler({ method, url: `/api/plugins/fish-soul${path}`, headers: {} }, { writeHead: () => {}, end: (t) => { out = JSON.parse(t); } });
		return out;
	};
};

const gateway = (diag) => Object.assign(Object.create(ChatGateway.prototype), {
	ctx: { get: () => ({ admitPromptContent: async (parts) => parts }) },
	log: () => {},
	diag,
	stickers: null,
	imageDownload: async () => PNG,
});

test('入站图片下载放宽到 20 秒', async () => {
	const { fetchImageBytes } = await import('../lib/gateway-util.js');
	const calls = [];
	const bytes = await fetchImageBytes({ url: 'https://i0.hdslb.com/bfs/x.jpg' }, async (url, opts) => { calls.push(opts); return null; });
	assert.equal(bytes, null);
	assert.equal(calls[0].timeoutMs, 20000, `入站图要放宽到 20s，实际 ${calls[0].timeoutMs}`);
});

test('同一个源失败后再试一次，两个源各试各的', async () => {
	const { fetchImageBytes } = await import('../lib/gateway-util.js');
	const calls = [];
	const download = async (url) => { calls.push(url); return calls.length >= 3 ? PNG : null; };
	const got = await fetchImageBytes({ url: 'https://a.example/1.jpg', file: 'https://b.example/2.jpg' }, download);
	assert.deepEqual(got, PNG);
	assert.deepEqual(calls, ['https://a.example/1.jpg', 'https://a.example/1.jpg', 'https://b.example/2.jpg']);
});

test('下载失败落 diag（只带主机名），且能在 diag-log 路由读出来', async () => {
	const diag = new DiagLog({ db, log: () => {} });
	const g = gateway(diag);
	g.imageDownload = async () => null;
	await g.admitImages('看图', [{ m: { images: [{ url: 'https://i0.hdslb.com/bfs/big.jpg' }], messageId: '1', nickname: 'n' } }], 's1');
	const call = mount({ getConfig: () => ({}), db, diag, worker: { coverageSnapshot: () => null, lastProbeLatencyMs: null }, soul: {} });
	const list = await call('/diag-log');
	const hit = (list.entries ?? list ?? []).filter((e) => e.key === 'image-skip');
	assert.ok(hit.length >= 1, '下载失败要在 diag-log 里查得到（桌面版宿主日志不落盘，只留它根本查不到）');
	assert.equal(hit.at(-1).detail.reason, 'download', JSON.stringify(hit.at(-1)));
	assert.equal(hit.at(-1).detail.host, 'i0.hdslb.com', '带主机名够了，别把完整 URL 落盘');
});

test('inline 图超限也落 diag（too-large）', async () => {
	const diag = new DiagLog({ db, log: () => {} });
	const g = gateway(diag);
	await g.admitImages('看图', [{ m: { images: [{ file: 'base64://' + 'A'.repeat(1024 * 1024 * 14) }], messageId: '2', nickname: 'n' } }], 's1');
	const hit = diag.entries.filter((e) => e.key === 'image-skip');
	assert.equal(hit.at(-1).detail.reason, 'too-large');
});

test('宿主没有 attachments 服务：图丢之前也落 diag（以前只有一行不落盘的 warn）', async () => {
	const diag = new DiagLog({ db, log: () => {} });
	const g = gateway(diag);
	g.ctx = { get: () => null };
	const parts = await g.admitImages('看图', [{ m: { images: [{ url: 'https://i0.hdslb.com/bfs/x.jpg' }], messageId: '3', nickname: 'n' } }], 's1');
	assert.equal(parts.length, 1, '没附件服务还是只转文字');
	assert.equal(diag.entries.at(-1).key, 'image-skip');
	assert.equal(diag.entries.at(-1).detail.reason, 'no-service');
});
