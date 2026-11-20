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
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSubmit, durationFor, generateVideo, isMp4Bytes, minimaxResolutionOk, pruneVideos, readPoll, videoErrorText, videoGenConfig } from '../lib/video-gen.js';
import { createSafeDownloadStream } from '../lib/safe-download.js';

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

/**
 * 假下载器：只管给字节，不管网络。
 * 真实下载走 lib/safe-download.js（逐跳校验、只连公网），这里替掉它是为了测 video-gen 自己的逻辑。
 */
function fakeDownload(bytes, { headers = {} } = {}) {
	const seen = [];
	const fn = async (url, opts = {}) => {
		seen.push({ url: String(url), opts });
		return { status: 200, headers, body: (async function* () { yield bytes; })() };
	};
	fn.seen = seen;
	return fn;
}

// 真的走 safe-download 的下载器，只把网络换成假的：lookup / request 可注入
function netStub({ answers = [{ address: '8.8.8.8', family: 4 }], responses = [] } = {}) {
	const seen = [];
	const stream = createSafeDownloadStream({
		lookup: async (host) => (typeof answers === 'function' ? answers(host) : answers),
		request: (url, opts, cb) => {
			seen.push({ url: url.href, opts });
			const req = new EventEmitter();
			req.end = () => queueMicrotask(() => {
				const next = responses.shift();
				if (!next) return req.emit('error', Error('unexpected request'));
				const res = Readable.from((next.body ?? []).map((x) => Buffer.from(x)));
				res.statusCode = next.status ?? 200;
				res.headers = next.headers ?? {};
				cb(res);
			});
			return req;
		}
	});
	return { stream, seen };
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
	assert.equal(videoGenConfig({ durationSec: 999 }).durationSec, 15, '时长上限 15 秒（MiniMax H3 的上限）');
	assert.equal(videoGenConfig({ durationSec: 0 }).durationSec, 4, '时长下限 4 秒：2~3 秒火山和 MiniMax 都直接拒');
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

test('A4 提交（openai 兼容）：路径、prompt、size 是像素尺寸、seconds 吸附到 4/8/12', () => {
	const cfg = cfgOf({ provider: 'openai-compat', durationSec: 6 });
	const s = buildSubmit('openai-compat', cfg, '一只鱼');
	assert.ok(s.url.endsWith('/videos'), s.url);
	assert.equal(s.method, 'POST');
	assert.equal(s.body.prompt, '一只鱼');
	assert.equal(s.body.seconds, '8', 'openai 只认 4/8/12（官方是字符串枚举），6 秒要吸附到 8');
	assert.equal(s.body.size, '720x1280', 'size 是像素尺寸，不是比例');
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
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dir, fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: fakeDownload(MP4) });
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
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
	]);
	const downloadImpl = async () => ({
		status: 200,
		headers: {},
		body: (async function* () { yield MP4; throw new Error('连接断了'); })()
	});
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dir, fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'DOWNLOAD_FAILED');
	assert.deepEqual(readdirSync(dir), [], '目录里不该剩任何文件');
});

test('A19 太大：声明的大小超了就拒，没声明但流式超了也拒', async () => {
	const dir = dirOf('toobig');
	const declared = netStub({ responses: [{ status: 200, headers: { 'content-length': '999999' }, body: [MP4] }] });
	const r1 = await generateVideo(cfgOf({ maxBytes: 1024 }), { prompt: '一只鱼', outDir: dir, fetchImpl: queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
	]), sleep: async () => {}, now: () => 0, downloadImpl: declared.stream });
	assert.equal(r1.ok, false);
	assert.equal(r1.code, 'TOO_LARGE', '声明的大小也要拦');
	assert.deepEqual(readdirSync(dir), []);

	const streamed = netStub({ responses: [{ status: 200, body: [Buffer.alloc(512, 1), Buffer.alloc(4096, 1)] }] });
	const r2 = await generateVideo(cfgOf({ maxBytes: 1024 }), { prompt: '一只鱼', outDir: dir, fetchImpl: queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
	]), sleep: async () => {}, now: () => 0, downloadImpl: streamed.stream });
	assert.equal(r2.ok, false);
	assert.equal(r2.code, 'TOO_LARGE', '实际字节超了也要拦，不能只信 Content-Length');
	assert.deepEqual(readdirSync(dir), []);
});

test('A20 不是视频：文件头不对就删掉，不能把假货留在盘上', async () => {
	const dir = dirOf('fake');
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dir, fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: fakeDownload(Buffer.from('notavideo')) });
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
		'DOWNLOAD_FAILED', 'TOO_LARGE', 'NO_URL', 'BAD_VIDEO', 'NO_SPACE', 'UNKNOWN',
		'NETWORK', 'NO_PERMISSION', 'TIMEOUT', 'QUOTA'];
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

test('A26 查进度请求失败：5xx 会重试几次才放弃，且要说清是查进度炸了', async () => {
	let polls = 0;
	const fetchImpl = stubFetch((url, opts, n) => {
		if (n === 1) return jsonRes({ id: 'task-1' });
		polls++;
		return jsonRes({}, 502);
	});
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('pollfail'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'UNKNOWN');
	assert.ok(r.error.includes('查进度'), r.error);
	assert.equal(polls, 4, '502 要退避重试 3 次（1s/2s/4s）才放弃');
});

test('A27 轮询（MiniMax）：认官方的状态枚举 Success / Fail / Preparing', () => {
	const ok = readPoll('minimax', { status: 'Success' });
	assert.equal(ok.state, 'succeeded', '官方枚举是 Success，不是 succeeded');
	const bad = readPoll('minimax', { status: 'Fail', base_resp: { status_code: 1004, status_msg: 'login fail' } });
	assert.equal(bad.state, 'failed');
	assert.ok(bad.error.includes('login fail'), bad.error);
	assert.equal(readPoll('minimax', { status: 'Preparing' }).state, 'running');
	assert.equal(readPoll('minimax', { status: 'Queueing' }).state, 'running');
	assert.equal(readPoll('minimax', { status: 'Processing' }).state, 'running');
});

test('A28 下载请求要带鉴权头（跟 baseURL 同源时）', async () => {
	const net = netStub({ responses: [{ status: 200, body: [MP4] }] });
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://api.example/v.mp4' } })
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('auth'), fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: net.stream });
	assert.equal(r.ok, true, r.error);
	assert.equal(net.seen.length, 1);
	assert.equal(net.seen[0].opts.headers.authorization, 'Bearer key-123', '同源下载才带 key');
});

test('A29 私网地址不能下：provider 回 127.0.0.1 也不能真去连', async () => {
	for (const url of ['http://127.0.0.1/x.mp4', 'http://127.0.0.1:1/x.mp4', 'http://10.0.0.5/x.mp4', 'http://192.168.1.7/x.mp4']) {
		const net = netStub({ responses: [{ status: 200, body: [MP4] }] });
		const fetchImpl = queueFetch([
			jsonRes({ id: 'task-1' }),
			jsonRes({ status: 'succeeded', content: { video_url: url } })
		]);
		const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('private'), fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: net.stream });
		assert.equal(r.ok, false, url);
		assert.equal(net.seen.length, 0, `不能真的去连 ${url}`);
	}
	// 域名解析到私网也一样不行
	const net = netStub({ answers: [{ address: '10.1.2.3', family: 4 }], responses: [{ status: 200, body: [MP4] }] });
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'http://internal.test/x.mp4' } })
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('private-dns'), fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: net.stream });
	assert.equal(r.ok, false);
	assert.equal(net.seen.length, 0, '解析到私网也不能连');
});

test('A30 302 跳进私网要被挡住：不能真去私网取', async () => {
	const net = netStub({ responses: [{ status: 302, headers: { location: 'http://127.0.0.1/private' } }] });
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('redir'), fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: net.stream });
	assert.equal(r.ok, false);
	assert.equal(net.seen.length, 1, '只跳一次，私网那一跳不能真发请求');
});

test('A31 cfg 没归一也不死循环：漏 pollBudgetMs 也要有上界', async () => {
	let t = 0;
	const now = () => (t += 60_000); // 每次问一次时间就往前推一分钟
	const fetchImpl = stubFetch((url, opts, n) => {
		if (n === 1) return jsonRes({ id: 'task-1' });
		if (n > 40) throw new Error('轮询次数失控');
		return jsonRes({ status: 'running' });
	});
	const r = await generateVideo({ enabled: true, baseURL: 'https://api.example', apiKey: 'key-123', model: 'model-x', timeoutMs: 30000 }, {
		prompt: '一只鱼', outDir: dirOf('nonorm'), fetchImpl, sleep: async () => {}, now
	});
	assert.equal(r.ok, false);
	assert.ok(['POLL_TIMEOUT', 'UNKNOWN'].includes(r.code), r.code);
	assert.ok(fetchImpl.calls.length <= 30, `发了 ${fetchImpl.calls.length} 次请求，超出上界`);
});

test('A32 时钟坏掉（NaN）也不能把任务查到没边', async () => {
	const fetchImpl = stubFetch((url, opts, n) => {
		if (n === 1) return jsonRes({ id: 'task-1' });
		if (n > 10) throw new Error('轮询次数失控');
		return jsonRes({ status: 'running' });
	});
	const r = await generateVideo(cfgOf({ pollIntervalMs: 100, pollBudgetMs: 5 }), {
		prompt: '一只鱼', outDir: dirOf('badclock'), fetchImpl, now: () => NaN
	});
	assert.equal(r.ok, false);
	assert.ok(fetchImpl.calls.length <= 3, `发了 ${fetchImpl.calls.length} 次请求，超出上界`);
});

test('A33 错误文案不带本机绝对路径，也不带原始错误码', async () => {
	const outDir = join(dirOf('notdir'), 'iam-a-file');
	writeFileSync(outDir, 'x');
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir, fetchImpl: queueFetch([]), sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NOT_CONFIGURED');
	assert.ok(!/[A-Za-z]:[\\/]/.test(r.error), `文案里带绝对路径：${r.error}`);
	assert.ok(!r.error.includes('EEXIST'), `文案里带原始错误码：${r.error}`);
	assert.ok(!r.error.includes('mkdir'), r.error);
});

test('A34 磁盘满（ENOSPC）要报 NO_SPACE，不是笼统的下载失败', async () => {
	const dir = dirOf('nospc');
	const downloadImpl = async () => ({
		status: 200,
		headers: {},
		body: (async function* () {
			yield MP4;
			const e = new Error('no space left on device');
			e.code = 'ENOSPC';
			throw e;
		})()
	});
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
	]);
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dir, fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NO_SPACE');
	assert.deepEqual(readdirSync(dir), [], '半截文件要删掉');
});

test('A35 provider 回显的 key 不能进用户可见的文案', async () => {
	const key = 'sk-secret-key-123456';
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'failed', error: { message: `Incorrect API key provided: ${key}` } })
	]);
	const r = await generateVideo(cfgOf({ apiKey: key }), { prompt: '一只鱼', outDir: dirOf('scrub'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'TASK_FAILED');
	assert.ok(!r.error.includes(key), `文案里带完整 key：${r.error}`);
	assert.ok(!r.error.includes(key.slice(0, 8)), `文案里带 key 前半段：${r.error}`);
});

test('A36 轮询遇到 5xx 会重试：重试后成功就照样算成功', async () => {
	const fetchImpl = stubFetch((url, opts, n) => {
		if (n === 1) return jsonRes({ id: 'task-1' });
		if (n === 2) return jsonRes({}, 502);
		return jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } });
	});
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('retry502'), fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: fakeDownload(MP4) });
	assert.equal(r.ok, true, r.error);
	assert.ok(fetchImpl.calls.length >= 3, `轮询了 ${fetchImpl.calls.length - 1} 次`);
});

test('A37 清理：超龄的删掉', () => {
	const dir = dirOf('prune-age');
	const p = join(dir, 'old.mp4');
	writeFileSync(p, 'x');
	const t = new Date(Date.now() - 10 * 86400000);
	utimesSync(p, t, t);
	const removed = pruneVideos(dir, { keepDays: 3, maxFiles: 20, maxBytes: 500 * 1024 * 1024 });
	assert.equal(removed, 1);
	assert.ok(!existsSync(p), '超龄的删掉');
});

test('A38 清理：超量的从最旧的开始删', () => {
	const dir = dirOf('prune-size');
	const names = ['v0.mp4', 'v1.mp4', 'v2.mp4'];
	names.forEach((n, i) => {
		const p = join(dir, n);
		writeFileSync(p, Buffer.alloc(100, 1));
		const t = new Date(Date.now() - (names.length - i) * 1000); // v2 最新
		utimesSync(p, t, t);
	});
	const removed = pruneVideos(dir, { keepDays: 3, maxFiles: 20, maxBytes: 250 });
	assert.equal(removed, 1);
	assert.ok(!existsSync(join(dir, 'v0.mp4')), '最旧的删掉');
	assert.ok(existsSync(join(dir, 'v1.mp4')));
	assert.ok(existsSync(join(dir, 'v2.mp4')));
});

test('A39 fetch 直接抛异常：不能把英文原文甩给用户', async () => {
	const fetchImpl = async () => {
		const e = new TypeError('fetch failed');
		e.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
		throw e;
	};
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('throw'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NETWORK');
	assert.ok(!r.error.includes('fetch failed'), r.error);
	assert.ok(/[一-龥]/.test(r.error), r.error);
});

test('A40 openai 兼容：视频对象里没有地址时，字节从 /videos/{id}/content 取', async () => {
	const fetchImpl = stubFetch((url, opts, n) => {
		if (n === 1) return jsonRes({ id: 'vid-1' });
		if (n === 2) return jsonRes({ id: 'vid-1', status: 'completed', progress: 100 });
		return bytesRes(MP4);
	});
	const r = await generateVideo(cfgOf({ provider: 'openai-compat' }), { prompt: '一只鱼', outDir: dirOf('oai'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, true, r.error);
	const last = fetchImpl.calls[fetchImpl.calls.length - 1];
	assert.ok(last.url.endsWith('/videos/vid-1/content'), last.url);
	assert.equal(last.opts.headers.Authorization, 'Bearer key-123');
	assert.ok(existsSync(r.file));
});

test('A41 MiniMax 完整流程：成功给的是 file_id，要再问一次要下载地址', async () => {
	const fetchImpl = stubFetch((url, opts, n) => {
		if (n === 1) return jsonRes({ task_id: 'task-1' });
		if (n === 2) return jsonRes({ status: 'Success', file_id: 'file-1', base_resp: { status_code: 0, status_msg: 'success' } });
		if (n === 3) return jsonRes({ file: { file_id: 'file-1', download_url: 'https://cdn.example/v.mp4' }, base_resp: { status_code: 0, status_msg: 'success' } });
		return jsonRes({});
	});
	const r = await generateVideo(cfgOf({ provider: 'minimax' }), { prompt: '一只鱼', outDir: dirOf('mm'), fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: fakeDownload(MP4) });
	assert.equal(r.ok, true, r.error);
	const ask = fetchImpl.calls[2];
	assert.ok(ask.url.includes('/v1/files/retrieve'), ask.url);
	assert.ok(ask.url.includes('file_id=file-1'), ask.url);
});

test('A42 默认下载器自己挡私网：真起一个 127.0.0.1 服务，它一个请求都收不到', async () => {
	let hits = 0;
	const srv = createServer((req, res) => { hits++; res.end('x'); });
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	const port = srv.address().port;
	try {
		const fetchImpl = queueFetch([
			jsonRes({ id: 'task-1' }),
			jsonRes({ status: 'succeeded', content: { video_url: `http://127.0.0.1:${port}/x.mp4` } })
		]);
		// 故意**不注入** downloadImpl：这里测的是 video-gen 自己默认那个下载器挡不挡得住
		const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('default-dl'), fetchImpl, sleep: async () => {}, now: () => 0 });
		assert.equal(r.ok, false, '私网地址不能下载成功');
		assert.equal(hits, 0, `私网服务收到了 ${hits} 个请求`);
	} finally {
		srv.closeAllConnections?.();
		await new Promise((r) => srv.close(r));
	}
});

test('A43 轮询（MiniMax）：Fail 的真实原因在 task.error 里，base_resp 正常也不能吞掉', async () => {
	const v2 = readPoll('minimax', {
		task: { status: 'Fail', error: { code: '1026', message: 'video description contains sensitive content' } },
		base_resp: { status_code: 0, status_msg: 'success' }
	});
	assert.equal(v2.state, 'failed');
	assert.ok(v2.error.includes('sensitive content'), `v2 的失败原因丢了：${v2.error}`);
	assert.ok(!v2.error.includes('对方没说失败原因'), `失败原因被吞成默认文案：${v2.error}`);

	const failed = readPoll('minimax', {
		task: { status: 'Failed', error: { code: '1004', message: 'invalid api key' } },
		base_resp: { status_code: 0 }
	});
	assert.equal(failed.state, 'failed');
	assert.ok(failed.error.includes('invalid api key'), failed.error);

	// 端到端：真实原因要一路带到用户看得见的文案里
	const fetchImpl = queueFetch([
		jsonRes({ task_id: 'task-1' }),
		jsonRes({
			task: { status: 'Fail', error: { code: '1026', message: 'video description contains sensitive content' } },
			base_resp: { status_code: 0, status_msg: 'success' }
		})
	]);
	const r = await generateVideo(cfgOf({ provider: 'minimax' }), { prompt: '一只鱼', outDir: dirOf('mmfail'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'TASK_FAILED');
	assert.ok(r.error.includes('sensitive content'), `失败原因丢了：${r.error}`);
});

test('A44 轮询有硬上限：时钟不动也只能查这么多轮', async () => {
	// pollIntervalMs 配 1ms 也要被钳到 1000ms：不然 maxPolls 会变成六十万轮
	// 时钟故意不动（now 恒为 1000）：预算判断永远不触发，只剩硬上限能收住它
	const budgetMs = 10_000;
	const upper = Math.ceil(budgetMs / 1000) + 2; // 预算 10s、间隔钳到 1s → 上限 12 轮
	let polls = 0;
	const fetchImpl = stubFetch((url, opts, n) => {
		if (n === 1) return jsonRes({ id: 'task-1' });
		polls++;
		// 保险丝：上限被改坏时立刻收场，别把测试挂死（超一轮就够抓）
		if (polls > upper) throw new Error('轮询次数失控');
		return jsonRes({ status: 'running' });
	});
	const r = await generateVideo(cfgOf({ pollIntervalMs: 1, pollBudgetMs: budgetMs }), {
		prompt: '一只鱼', outDir: dirOf('maxpolls'), fetchImpl, sleep: async () => {}, now: () => 1000
	});
	assert.equal(r.ok, false);
	assert.ok(polls <= upper, `轮询了 ${polls} 次，超出硬上限 ${upper}（间隔钳到 1000ms、预算 ${budgetMs}ms 时）`);
	assert.equal(r.code, 'POLL_TIMEOUT', `不该靠报错收场（说明没按上限停）：${r.code}`);
});

test('A45 JWT 形状的 key 也不能漏：通用正则不认它，只能靠「知道自己用的 key」', async () => {
	// MiniMax 官方就是 JWT 风格的 key（不是 sk- 开头），形状兜底正则兜不住
	const key = 'eyJhbGciOiJIUzI1NiJ9.xxx.yyy';
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'failed', error: { message: `Incorrect API key provided: ${key}` } })
	]);
	const r = await generateVideo(cfgOf({ apiKey: key }), { prompt: '一只鱼', outDir: dirOf('scrub-jwt'), fetchImpl, sleep: async () => {}, now: () => 0 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'TASK_FAILED');
	assert.ok(!r.error.includes(key), `文案里带完整 key：${r.error}`);
	assert.ok(!r.error.includes(key.slice(0, 12)), `文案里带 key 前半段：${r.error}`);
});

test('A46 跨源下载不带 key：付费 key 不能发给 provider 回的第三方域名', async () => {
	const net = netStub({ responses: [{ status: 200, body: [MP4] }] });
	const fetchImpl = queueFetch([
		jsonRes({ id: 'task-1' }),
		jsonRes({ status: 'succeeded', content: { video_url: 'https://cdn.example/v.mp4' } })
	]);
	// baseURL 是 https://api.example，下载地址在 cdn.example —— 不同源
	const r = await generateVideo(cfgOf(), { prompt: '一只鱼', outDir: dirOf('cross'), fetchImpl, sleep: async () => {}, now: () => 0, downloadImpl: net.stream });
	assert.equal(r.ok, true, r.error);
	assert.equal(net.seen.length, 1);
	assert.equal(net.seen[0].opts.headers.authorization, undefined, `跨源下载不能带 key：${JSON.stringify(net.seen[0].opts.headers)}`);
	assert.ok(!JSON.stringify(net.seen[0].opts.headers).includes('key-123'), 'key 不能出现在跨源请求头里');
});

test('A47 openai 兼容：size 是官方枚举里的像素尺寸、seconds 是 4/8/12 的字符串', () => {
	// 官方 POST /v1/videos 的 size 枚举只有这四个（没有正方形，别再往里塞 1024x1024）
	const sizes = new Set(['1280x720', '720x1280', '1024x1792', '1792x1024']);
	const want = { '16:9': '1280x720', '9:16': '720x1280', '1:1': '720x1280' };
	for (const ratio of ['16:9', '9:16', '1:1']) {
		const s = buildSubmit('openai-compat', cfgOf({ provider: 'openai-compat', aspectRatio: ratio }), '一只鱼');
		assert.ok(sizes.has(s.body.size), `${ratio} 映射成了非法 size：${s.body.size}`);
		assert.equal(s.body.size, want[ratio], `${ratio} 的 size 映射不对`);
		assert.notEqual(s.body.size, ratio, 'size 不能是比例本身');
		assert.ok(['4', '8', '12'].includes(s.body.seconds), `非法 seconds：${s.body.seconds}`);
		assert.equal(typeof s.body.seconds, 'string', '官方 schema 里 seconds 是字符串枚举，传数字会被 400');
	}
	for (const [sec, expect] of [[2, '4'], [4, '4'], [5, '8'], [8, '8'], [9, '12'], [12, '12']]) {
		const s = buildSubmit('openai-compat', cfgOf({ provider: 'openai-compat', durationSec: sec }), '一只鱼');
		assert.equal(s.body.seconds, expect, `${sec} 秒应吸附到 ${expect}`);
	}
});

test('A48 时长按 provider 收窄：三家的 body 里都是对方认的合法值', () => {
	// 各家限制不同，超出会被对方拒（火山 4~30 / MiniMax 4~15 整数 / openai 只认 4/8/12）
	for (const sec of [4, 5, 8, 12, 15]) {
		const v = buildSubmit('volc', cfgOf({ durationSec: sec }), '一只鱼');
		assert.ok(Number.isInteger(v.body.duration), `火山时长要是整数：${v.body.duration}`);
		assert.ok(v.body.duration >= 4 && v.body.duration <= 12, `火山时长越界：${v.body.duration}`);

		const m = buildSubmit('minimax', cfgOf({ provider: 'minimax', durationSec: sec }), '一只鱼');
		assert.ok(Number.isInteger(m.body.duration), `MiniMax 时长要是整数：${m.body.duration}`);
		assert.ok(m.body.duration >= 4 && m.body.duration <= 15, `MiniMax 时长越界：${m.body.duration}`);

		const o = buildSubmit('openai-compat', cfgOf({ provider: 'openai-compat', durationSec: sec }), '一只鱼');
		assert.ok(['4', '8', '12'].includes(o.body.seconds), `openai seconds 非法：${o.body.seconds}`);
	}
	// 15 秒：火山收窄到 12（Seedance 1.0 pro 的上限），MiniMax 收 15，openai 吸附到 12
	assert.equal(buildSubmit('volc', cfgOf({ durationSec: 15 }), '一只鱼').body.duration, 12, '火山要收窄');
	assert.equal(buildSubmit('minimax', cfgOf({ provider: 'minimax', durationSec: 15 }), '一只鱼').body.duration, 15, 'MiniMax 能到 15');
	assert.equal(buildSubmit('openai-compat', cfgOf({ provider: 'openai-compat', durationSec: 15 }), '一只鱼').body.seconds, '12');
});

test('A49 时长下限 4 秒：2~3 秒火山和 MiniMax 都直接拒，得提前抬上去', () => {
	for (const sec of [0, 1, 2, 3]) {
		assert.equal(videoGenConfig({ durationSec: sec }).durationSec, 4, `${sec} 秒要抬到 4`);
	}
	assert.equal(videoGenConfig({ durationSec: 4 }).durationSec, 4, '4 秒本身合法，别动它');
	assert.equal(videoGenConfig({ durationSec: 15 }).durationSec, 15, '15 秒是 MiniMax 的上限');
	assert.equal(videoGenConfig({ durationSec: 99 }).durationSec, 15, '再大也钳到 15');
});

test('A50 轮询（MiniMax）：v2 的状态和 file_id 都套在 task 里，v1 是平铺', () => {
	// v2（官方 guides/video-generation）：{ task: { status, file_id, content: { url } } }
	const v2 = readPoll('minimax', { task: { status: 'Success', file_id: 'file-v2' } });
	assert.equal(v2.state, 'succeeded');
	assert.equal(v2.fileId, 'file-v2', 'v2 的 file_id 在 task 里');

	const v2url = readPoll('minimax', { task: { status: 'succeeded', content: { url: 'https://cdn.example/v.mp4' } } });
	assert.equal(v2url.state, 'succeeded');
	assert.equal(v2url.url, 'https://cdn.example/v.mp4', 'v2 的地址在 task.content.url');

	// v1（官方 api-reference）：平铺 { status, file_id }
	const v1 = readPoll('minimax', { status: 'Success', file_id: 'file-v1' });
	assert.equal(v1.state, 'succeeded');
	assert.equal(v1.fileId, 'file-v1', 'v1 的 file_id 在顶层');
});

test('A51 readPoll 自己吐出来的失败原因也不能带 key（这一层自己也刷）', () => {
	const key = 'sk-secret-abc-123456';
	const r = readPoll('volc', { status: 'failed', error: { message: `Incorrect API key provided: ${key}` } }, { apiKey: key });
	assert.equal(r.state, 'failed');
	assert.ok(!r.error.includes(key), `readPoll 的返回值里带 key：${r.error}`);
});

test('A52 MiniMax 分辨率：按配置走，不再写死 768P', () => {
	// 官方 resolution 枚举：480P / 768P / 2K（档位跟模型绑着，见 A53）
	for (const res of ['480P', '768P', '2K']) {
		const s = buildSubmit('minimax', cfgOf({ provider: 'minimax', model: 'MiniMax-H3', resolution: res }), '一只鱼');
		assert.equal(s.body.resolution, res, `分辨率没透传：${res}`);
	}
	assert.equal(videoGenConfig({}).resolution, '768P', '默认 768P');
	assert.equal(videoGenConfig({ resolution: '4K' }).resolution, '768P', '白名单外的退回 768P');
	assert.equal(videoGenConfig({ resolution: '2k' }).resolution, '768P', '官方枚举是 2K，大小写不对也退回默认值');
	assert.equal(videoGenConfig({ resolution: ' 768P ' }).resolution, '768P', '两边空格要去掉');
});

test('A53 MiniMax 分辨率跟模型绑着：只有 MiniMax-H3 能要 2K', () => {
	// 官方 schema 原文：H3 支持 768P / 2K；Highspeed / Lite / Max 只有 480P / 768P（2K is not supported）
	assert.equal(minimaxResolutionOk('MiniMax-H3', '2K'), true);
	assert.equal(minimaxResolutionOk('MiniMax-H3', '768P'), true);
	assert.equal(minimaxResolutionOk('MiniMax-H3-Highspeed', '2K'), false);
	assert.equal(minimaxResolutionOk('MiniMax-H3-Lite', '2K'), false);
	assert.equal(minimaxResolutionOk('MiniMax-H3-Max', '2K'), false);
	// 非 2K 一律放行：480P / 768P 四个变体都支持
	for (const m of ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max']) {
		assert.equal(minimaxResolutionOk(m, '768P'), true, m);
		assert.equal(minimaxResolutionOk(m, '480P'), true, m);
	}
	// ⚠️ 品牌名 MiniMax 本身就带 "Max"（Mini + Max）：不能拿 max 子串去判，MiniMax-H3 要放行
	assert.equal(minimaxResolutionOk('MiniMax-H3', '2K'), true, 'MiniMax 自带 Max，别误杀');
	assert.equal(minimaxResolutionOk('minimax-h3-highspeed', '2K'), false, '大小写不敏感');
	assert.equal(minimaxResolutionOk('minimax-h3-max', '2K'), false, '大小写不敏感');
	// 认不出来的模型名不拦（用户可能用别名或自建 endpoint）
	assert.equal(minimaxResolutionOk('my-proxy/h3', '2K'), true);
});

test('A54 分辨率跟模型对不上：一个请求都不发', async () => {
	const fetchImpl = queueFetch([jsonRes({ task_id: 'x' })]);
	const r = await generateVideo(cfgOf({ provider: 'minimax', model: 'MiniMax-H3-Highspeed', resolution: '2K' }), {
		prompt: '一只鱼', outDir: dirOf('mm2k'), fetchImpl, sleep: async () => {}, now: () => 0
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NOT_CONFIGURED');
	assert.ok(r.error.includes('2K'), `文案要说明白是 2K 的问题：${r.error}`);
	assert.equal(fetchImpl.calls.length, 0, '错配不能提交出去让对方拒（提交是花钱的）');
});

test('A55 MiniMax 带比例：官方 t2va 要求给具体比例', () => {
	for (const ratio of ['16:9', '9:16', '1:1']) {
		const s = buildSubmit('minimax', cfgOf({ provider: 'minimax', aspectRatio: ratio }), '一只鱼');
		assert.equal(s.body.ratio, ratio, `比例没透传：${ratio}`);
	}
	// 官方 ratio 枚举：adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 —— 我们这三个都在里面
	const official = new Set(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
	for (const ratio of ['16:9', '9:16', '1:1']) assert.ok(official.has(ratio), `${ratio} 不在官方枚举里`);
});

test('A56 MiniMax 时长是整数：4~15，Max 变体 5~15', () => {
	assert.equal(durationFor('minimax', { durationSec: 5.5 }), 6, '小数要取整（官方 schema 是 integer）');
	assert.ok(Number.isInteger(durationFor('minimax', { durationSec: 5.5 })), '取整后还得是整数');
	assert.equal(durationFor('minimax', { durationSec: 4 }), 4);
	assert.equal(durationFor('minimax', { durationSec: 15 }), 15);
	assert.equal(durationFor('minimax', { durationSec: 2 }), 4, '下限 4');
	assert.equal(durationFor('minimax', { durationSec: 99 }), 15, '上限 15');
	// 官方 schema：MiniMax-H3-Max 是 5–15（4 秒不支持），其余变体是 4–15
	assert.equal(durationFor('minimax', { durationSec: 4, model: 'MiniMax-H3-Max' }), 5, 'Max 不支持 4 秒');
	assert.equal(durationFor('minimax', { durationSec: 4, model: 'MiniMax-H3' }), 4);
	assert.equal(durationFor('minimax', { durationSec: 4, model: 'MiniMax-H3-Lite' }), 4);
	assert.equal(durationFor('minimax', { durationSec: 4, model: 'MiniMax-H3-Highspeed' }), 4);
	// 提交出去的值也得是整数
	const s = buildSubmit('minimax', cfgOf({ provider: 'minimax', durationSec: 5.5 }), '一只鱼');
	assert.ok(Number.isInteger(s.body.duration), `body.duration 要整数：${s.body.duration}`);
});

test('A57 videoErrorText 这一层自己也要洗 key（不经 readPoll 的 detail 也得干净）', () => {
	// 两层防线：readPoll 那层洗一遍，成文案这层再洗一遍。少一层都可能被别处的 detail 带出去
	const key = 'sk-zzzzzz-1234-abcd';
	const t = videoErrorText('SUBMIT_FAILED', `Incorrect API key provided: ${key}`, key);
	assert.ok(!t.includes(key), `文案里带完整 key：${t}`);
	assert.ok(!t.includes(key.slice(0, 8)), `文案里带 key 前半段：${t}`);
	assert.ok(/[一-龥]/.test(t), t);
});

test('A58 readPoll（MiniMax）：失败原因里的 key 也要洗掉', () => {
	const key = 'eyJhbGciOiJIUzI1NiJ9.xxx.yyy';
	const r = readPoll('minimax', { task: { status: 'Fail', error: { message: `Incorrect API key provided: ${key}` } } }, { apiKey: key });
	assert.equal(r.state, 'failed');
	assert.ok(!r.error.includes(key), `minimax 分支带 key：${r.error}`);
	assert.ok(!r.error.includes(key.slice(0, 12)), `minimax 分支带 key 前半段：${r.error}`);
});

