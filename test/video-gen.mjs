/**
 * 视频生成层：配置收拾、三家 provider 的提交/轮询形状、生成流程的失败分支、落盘与清理。
 *
 * 为什么要有这个测试：
 *   生成视频是按次计费的写操作，失败还分十几种（没开、没配、提交被拒、等超时、
 *   任务失败、下载炸了、视频太大、不是视频文件、磁盘满……）。这些分支靠真机试，
 *   一次就是真扣一次钱，而且有些（比如轮询超时、下载中途断）根本造不出来。
 *   所以这里把 fetch 换成桩，把每条分支都走一遍；不启浏览器、不发真网络。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSubmit, generateVideo, isMp4Bytes, pruneVideos, readPoll, videoErrorText, videoGenConfig } from '../lib/video-gen.js';

// 每个用例一个临时目录，跑完就删（不留一堆视频在 TMPDIR 里）
const madeDirs = new Set();
let hooked = false;
const dirOf = (name) => {
	const d = mkdtempSync(join(tmpdir(), `dsh-video-${name}-`));
	madeDirs.add(d);
	if (!hooked) {
		hooked = true;
		process.on('exit', () => {
			for (const x of madeDirs) { try { rmSync(x, { recursive: true, force: true }); } catch { /* 忽略 */ } }
		});
	}
	return d;
};

// 真的 mp4 头：第 4 字节起是 ftyp
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('isom'), Buffer.alloc(64, 7)]);

const jsonRes = (obj, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: { get: () => null },
	json: async () => obj
});

const bytesRes = (buf, contentLength = null) => ({
	ok: true,
	status: 200,
	headers: { get: (k) => (k.toLowerCase() === 'content-length' && contentLength !== null ? String(contentLength) : null) },
	body: new ReadableStream({
		start(c) {
			c.enqueue(new Uint8Array(buf));
			c.close();
		}
	})
});

// 没有 Content-Length，但流式送来的字节超过上限
const oversizeRes = () => ({
	ok: true,
	status: 200,
	headers: { get: () => null },
	body: new ReadableStream({
		start(c) {
			c.enqueue(new Uint8Array(Buffer.alloc(512, 1)));
			c.enqueue(new Uint8Array(Buffer.alloc(4096, 1)));
			c.close();
		}
	})
});

// 送一半就断（连接断了）
const brokenRes = () => ({
	ok: true,
	status: 200,
	headers: { get: () => null },
	body: new ReadableStream({
		pull(c) {
			if (this.step === undefined) { this.step = 0; c.enqueue(new Uint8Array(MP4)); return; }
			c.error(new Error('连接断了'));
		}
	})
});

function stubFetch(handler) {
	const calls = [];
	const fn = async (url, opts = {}) => {
		calls.push({ url: String(url), opts });
		return handler(String(url), opts, calls.length);
	};
	fn.calls = calls;
	return fn;
}

// 依次给桩子发牌；牌发完了还来请求就抛（说明流程多发了请求）
function queueFetch(list) {
	const q = [...list];
	return stubFetch(() => {
		if (!q.length) throw new Error('桩子用完了：多发了请求');
		return q.shift();
	});
}

const cfgOf = (raw = {}) => videoGenConfig({
	enabled: true,
	baseURL: 'https://api.example',
	apiKey: 'key-123',
	model: 'model-x',
	...raw
});

test('A1 配置：默认关、provider 只认白名单、时长和次数钳在范围内', () => {
	const c = videoGenConfig({});
	assert.equal(c.enabled, false, '生成是花钱的写操作，默认必须关');
	assert.equal(c.provider, 'volc');
	assert.equal(c.aspectRatio, '9:16');
	assert.equal(c.durationSec, 5);
	assert.equal(c.perDay, 1);
	assert.equal(c.timeoutMs, 30000);
	assert.equal(c.pollIntervalMs, 5000);
	assert.equal(c.pollBudgetMs, 600000);
	assert.equal(c.maxBytes, 100 * 1024 * 1024);
	assert.equal(videoGenConfig({ provider: '不存在的' }).provider, 'volc', '白名单外的退回 volc');
	assert.equal(videoGenConfig({ provider: 'minimax' }).provider, 'minimax');
	assert.equal(videoGenConfig({ provider: 'openai-compat' }).provider, 'openai-compat');
	assert.equal(videoGenConfig({ durationSec: 999 }).durationSec, 12, '时长上限 12 秒');
	assert.equal(videoGenConfig({ durationSec: 0 }).durationSec, 2, '时长下限 2 秒');
	assert.equal(videoGenConfig({ durationSec: 'abc' }).durationSec, 5, '乱的时长退回默认');
	assert.equal(videoGenConfig({ perDay: -1 }).perDay, 0);
	assert.equal(videoGenConfig({ perDay: 99 }).perDay, 5);
	assert.equal(videoGenConfig({ aspectRatio: '4:3' }).aspectRatio, '9:16');
	assert.equal(videoGenConfig({ baseURL: 'https://x.example///' }).baseURL, 'https://x.example', '尾部斜杠去掉');
});

test('A2 提交（火山）：路径、内容、比例时长和鉴权头', () => {
	const cfg = cfgOf({ baseURL: 'https://ark.example', apiKey: 'key-123', model: 'doubao-seed' });
	const s = buildSubmit('volc', cfg, '一只鱼');
	assert.ok(s.url.endsWith('/contents/generations/tasks'), s.url);
	assert.equal(s.method, 'POST');
	assert.equal(s.body.content[0].text, '一只鱼');
	assert.equal(s.body.content[0].type, 'text');
	assert.equal(s.body.ratio, cfg.aspectRatio);
	assert.equal(s.body.duration, cfg.durationSec);
	assert.equal(s.body.model, 'doubao-seed');
	assert.ok(s.headers.Authorization.includes('key-123'), s.headers.Authorization);
	assert.equal(s.headers['Content-Type'], 'application/json');
});

test('A3 提交（MiniMax）：路径和时长字段', () => {
	const cfg = cfgOf({ provider: 'minimax', durationSec: 8 });
	const s = buildSubmit('minimax', cfg, '一只鱼');
	assert.ok(s.url.endsWith('/v2/video_generation'), s.url);
	assert.equal(s.method, 'POST');
	assert.equal(s.body.duration, cfg.durationSec);
	assert.equal(s.body.content[0].text, '一只鱼');
	assert.equal(s.body.model, 'model-x');
	assert.ok(s.headers.Authorization.includes('key-123'));
});

test('A4 提交（openai 兼容）：路径、prompt 和 seconds', () => {
	const cfg = cfgOf({ provider: 'openai-compat', durationSec: 6 });
	const s = buildSubmit('openai-compat', cfg, '一只鱼');
	assert.ok(s.url.endsWith('/videos'), s.url);
	assert.equal(s.method, 'POST');
	assert.equal(s.body.prompt, '一只鱼');
	assert.equal(s.body.seconds, cfg.durationSec);
	assert.ok(s.headers.Authorization.includes('key-123'));
});

test('A5 轮询（火山）：成功时给出视频地址', () => {
	const r = readPoll('volc', { status: 'succeeded', content: { video_url: 'https://x/y.mp4' } });
	assert.equal(r.state, 'succeeded');
	assert.equal(r.url, 'https://x/y.mp4');
});

test('A6 轮询（火山）：失败时给出对方说的原因', () => {
	const r = readPoll('volc', { status: 'failed', error: { message: 'x' } });
	assert.equal(r.state, 'failed');
	assert.equal(r.error, 'x');
});

test('A7 轮询（火山）：过期单独一种状态', () => {
	const r = readPoll('volc', { status: 'expired' });
	assert.equal(r.state, 'expired');
});

test('A8 轮询（MiniMax）：取消按过期算', () => {
	const r = readPoll('minimax', { status: 'cancelled' });
	assert.equal(r.state, 'expired');
});

test('A9 轮询：没见过的状态当还在跑，不能炸', () => {
	const r = readPoll('volc', { status: 'weird' });
	assert.equal(r.state, 'running');
	assert.equal(readPoll('minimax', { status: 'weird' }).state, 'running');
	assert.equal(readPoll('openai-compat', { status: 'in_progress' }).state, 'running');
});

test('A10 轮询（openai 兼容）：completed 也算成功，地址在 data 里', () => {
	const r = readPoll('openai-compat', { status: 'completed', data: [{ url: 'https://z/v.mp4' }] });
	assert.equal(r.state, 'succeeded');
	assert.equal(r.url, 'https://z/v.mp4');
	assert.equal(readPoll('openai-compat', { status: 'succeeded', url: 'https://z/w.mp4' }).url, 'https://z/w.mp4');
});

test('A11 默认关：不开就一个请求都不发', async () => {
	const fetchImpl = queueFetch([jsonRes({ id: 'x' })]);
	const r = await generateVideo(videoGenConfig({}), { prompt: '一只鱼', outDir: dirOf('off'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'DISABLED');
	assert.equal(fetchImpl.calls.length, 0, '没开就不能发请求');
});

test('A12 没配齐：地址/密钥/模型缺一样都不行，也不发请求', async () => {
	for (const raw of [{ baseURL: '' }, { apiKey: '' }, { model: '' }]) {
		const fetchImpl = queueFetch([jsonRes({ id: 'x' })]);
		const r = await generateVideo(cfgOf(raw), { prompt: '一只鱼', outDir: dirOf('noconf'), fetchImpl, sleep: async () => {}, now: () => 0 });
		assert.equal(r.ok, false);
		assert.equal(r.code, 'NOT_CONFIGURED', JSON.stringify(raw));
		assert.equal(fetchImpl.calls.length, 0, '没配齐就不能发请求');
	}
});

test('A13 提交被拒：接口报错也不能把异常抛出去', async () => {
	const fetchImpl = queueFetch([jsonRes({ error: 'boom' }, 500)]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('submit500'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'SUBMIT_FAILED');
	assert.ok(r.error && !r.error.includes('SUBMIT_FAILED'), r.error);
});

test('A14 提交没给任务号：一样算提交失败', async () => {
	const fetchImpl = queueFetch([jsonRes({ result: 'ok' })]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('noid'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'SUBMIT_FAILED');
});

test('A15 轮询超预算：到点就停，轮询次数有上界', async () => {
	const cfg = cfgOf({ pollIntervalMs: 1000, pollBudgetMs: 10000 });
	let t = 0;
	const now = () => (t += 1000); // 每次问一次时间就往前推一个间隔
	const fetchImpl = stubFetch((url, opts, n) => {
		if (n === 1) return jsonRes({ id: 'task-1' });
		if (n > 40) throw new Error('轮询次数失控');
		return jsonRes({ status: 'running' });
	});
	const r = await generateVideo(cfg, { prompt: '一只鱼', outDir: dirOf('timeout'), fetchImpl, sleep: async () => {}, now });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'POLL_TIMEOUT');
	const polls = fetchImpl.calls.length - 1; // 减去提交那一次
	assert.ok(polls <= cfg.pollBudgetMs / cfg.pollIntervalMs + 1, `轮询了 ${polls} 次，超出预算上界`);
});

test('A16 任务失败：把对方说的原因带回来', async () => {
	const fetchImpl = queueFetch([jsonRes({ id: 'task-1' }), jsonRes({ status: 'failed', error: { message: '模型崩了' } })]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('failed'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'TASK_FAILED');
	assert.ok(r.error.includes('模型崩了'), r.error);
});

test('A17 生成成功：mp4 落盘，路径是绝对的，内容一模一样', async () => {
	const dir = dirOf('ok');
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } }),
		bytesRes(MP4)
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dir, fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, true, r.error);
	assert.equal(r.provider, 'volc');
	assert.ok(r.file.endsWith('.mp4'), r.file);
	assert.equal(r.file, join(dir, r.file.split(/[\\/]/).pop()), '文件要落在给的目录里');
	assert.ok(existsSync(r.file));
	assert.ok(isAbsolute(r.file), '要绝对路径');
	assert.equal(r.bytes, MP4.length);
	assert.deepEqual(readFileSync(r.file), MP4);
	assert.equal(readdirSync(dir).filter((f) => f.endsWith('.part')).length, 0, '不能留 .part');
});

test('A18 下载中途断：不能留 .part，也不能留半个 mp4', async () => {
	const dir = dirOf('broken');
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } }),
		brokenRes()
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dir, fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'DOWNLOAD_FAILED');
	assert.deepEqual(readdirSync(dir), [], '目录里不该剩任何文件');
});

test('A19 太大：声明的大小超了就拒，没声明但流式超了也拒', async () => {
	const dir = dirOf('toobig');
	const declared = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } }),
		bytesRes(MP4, 999999)
	]);
	const r1 = await generateVideo(cfgOf({ maxBytes: 1024 }), { prompt: '一只鱼', outDir: dir, fetchImpl: declared, sleep: async () => {}, now: () => 0 });
	assert.equal(r1.ok, false);
	assert.equal(r1.code, 'TOO_LARGE', '声明的大小也要拦');
	assert.deepEqual(readdirSync(dir), []);

	const streamed = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } }),
		oversizeRes()
	]);
	const r2 = await generateVideo(cfgOf({ maxBytes: 1024 }), { prompt: '一只鱼', outDir: dir, fetchImpl: streamed, sleep: async () => {}, now: () => 0 });
	assert.equal(r2.ok, false);
	assert.equal(r2.code, 'TOO_LARGE', '实际字节超了也要拦，不能只信 Content-Length');
	assert.deepEqual(readdirSync(dir), []);
});

test('A20 不是视频：文件头不对就删掉，不能把假货留在盘上', async () => {
	const dir = dirOf('fake');
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } }),
		bytesRes(Buffer.from('notavideo'))
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dir, fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'BAD_VIDEO');
	assert.deepEqual(readdirSync(dir), [], '不是视频的文件要删掉');
});

test('A21 好了但没给地址：算没生成出来', async () => {
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: {} })
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('nourl'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NO_URL');
});

test('A22 清理：超数的删最旧，留最新的', () => {
	const dir = dirOf('prune');
	for (let i = 0; i < 25; i++) {
		const p = join(dir, `video-${i}.mp4`);
		writeFileSync(p, 'x');
		const t = new Date(Date.now() - (24 - i) * 1000); // video-24 最新，video-0 最旧
		utimesSync(p, t, t);
	}
	const removed = pruneVideos(dir, { keepDays: 3, maxFiles: 20, maxBytes: 500 * 1024 * 1024 });
	assert.equal(removed, 5, '25 个留 20 个，删 5 个');
	assert.equal(readdirSync(dir).length, 20);
	assert.ok(existsSync(join(dir, 'video-24.mp4')), '最新的要留下');
	assert.ok(existsSync(join(dir, 'video-5.mp4')), '第 20 新的要留下');
	assert.ok(!existsSync(join(dir, 'video-0.mp4')), '最旧的要删掉');
	assert.ok(!existsSync(join(dir, 'video-4.mp4')), '第 5 旧的要删掉');
});

test('A23 mp4 头：认 ftyp，不认别的', () => {
	assert.equal(isMp4Bytes(MP4), true);
	assert.equal(isMp4Bytes(Buffer.from('notavideo')), false);
	assert.equal(isMp4Bytes(Buffer.from('short')), false);
	assert.equal(isMp4Bytes(null), false);
});

test('A24 错误文案：每种失败都给人话，不能把代码甩给用户', () => {
	const codes = ['DISABLED', 'NOT_CONFIGURED', 'SUBMIT_FAILED', 'POLL_TIMEOUT', 'TASK_FAILED', 'TASK_EXPIRED',
		'DOWNLOAD_FAILED', 'TOO_LARGE', 'NO_URL', 'BAD_VIDEO', 'NO_SPACE', 'UNKNOWN'];
	for (const code of codes) {
		const text = videoErrorText(code);
		assert.ok(text && text.length > 0, code);
		assert.ok(!text.includes(code), `${code} 不该出现在文案里：${text}`);
		assert.ok(/[一-龥]/.test(text), `${code} 的文案要是中文：${text}`);
	}
	assert.ok(videoErrorText('SUBMIT_FAILED', 'HTTP 500').includes('HTTP 500'), '细节要带出来');
});

test('A25 任务过期：过期单独一种结果，不能当成普通失败', async () => {
	const fetchImpl = queueFetch([jsonRes({ id: 'task-1' }), jsonRes({ status: 'expired' })]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('expired'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'TASK_EXPIRED');
});

test('A26 查进度请求失败：要说清是查进度炸了，不是任务本身失败', async () => {
	const fetchImpl = queueFetch([jsonRes({ id: 'task-1' }), jsonRes({}, 502)]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('pollfail'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'UNKNOWN');
	assert.ok(r.error.includes('查进度'), r.error);
});
