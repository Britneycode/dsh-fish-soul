// 抖音专用浏览器：用真的 Chromium（无头）+ 本地假 www.douyin.com（自签证书）跑一遍生命周期和刷视频。
// 找不到 Chromium 系浏览器或 openssl 时跳过（不算失败）。
import https from 'node:https';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok = (name) => console.log('✓', name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = (why) => { console.log(`- 跳过抖音浏览器测试：${why}`); process.exit(0); };

const home = mkdtempSync(join(tmpdir(), 'dsh-dyb-'));
process.env.DSH_HOME = home;
const { detectBrowsers } = await import('../lib/browsers.js');
const found = (await detectBrowsers().catch(() => [])).filter((b) => b.path);
if (found.length === 0) skip('没找到 Chromium 系浏览器');
try {
	execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(home, 'key.pem'), '-out', join(home, 'cert.pem'), '-days', '1', '-subj', '/CN=www.douyin.com'], { stdio: 'ignore' });
} catch { skip('没有 openssl（要给假 www.douyin.com 签证书）'); }

// ── 假 www.douyin.com：推荐页（一条一条换）、视频详情页（点赞会回报）──
const feed = [
	{ id: '7300000000000000031', desc: '正在直播', author: '主播', live: true },
	{ id: '7300000000000000032', desc: '深夜做饭 #美食', author: '饭博主' },
	{ id: '7300000000000000033', desc: '买它买它', author: '品牌', ad: true },
	{ id: '7300000000000000034', desc: '周末爬山 #户外', author: '山博主', noArrow: true },
	{ id: '7300000000000000035', desc: '猫猫睡觉 #猫', author: '猫博主' }
];
const srvLog = { liked: [], paths: [] };
const FEED_HTML = `<!doctype html><meta charset="utf-8"><title>抖音</title><body style="margin:0">
<div id="feed"></div>
<script>
const items = ${JSON.stringify(feed)};
let i = 0;
function render() {
  const v = items[i];
  const f = document.getElementById('feed');
  if (!v) { f.innerHTML = '<p>没有了</p>'; return; }
  f.innerHTML = '<div data-e2e="feed-active-video"><div data-e2e="player-container" class="xgplayer video_' + v.id + '"></div>' +
    '<div data-e2e="video-desc">' + v.desc + '</div><div data-e2e="feed-video-nickname">@' + v.author + '</div>' +
    (v.live ? '<div data-e2e="feed-live">直播中</div>' : '') + (v.ad ? '<div data-e2e="feed-ad">广告</div>' : '') + '</div>' +
    (v.noArrow ? '' : '<button data-e2e="video-switch-next-arrow" onclick="i++;render()">下一个</button>');
}
document.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { i++; render(); } });
render();
</script></body>`;
const videoHtml = (id) => `<!doctype html><meta charset="utf-8"><title>视频</title><body>
<div data-e2e="video-desc">详情 ${id}</div>
<button data-e2e="video-player-digg" onclick="fetch('/liked?id=${id}')">赞</button></body>`;
const srv = https.createServer({ key: readFileSync(join(home, 'key.pem')), cert: readFileSync(join(home, 'cert.pem')) }, (req, res) => {
	const u = new URL(req.url, 'https://www.douyin.com');
	srvLog.paths.push(u.pathname + u.search);
	res.setHeader('content-type', 'text/html; charset=utf-8');
	if (u.pathname === '/liked') { srvLog.liked.push(u.searchParams.get('id')); return res.end('ok'); }
	const m = u.pathname.match(/^\/video\/(\d+)/);
	if (m) return res.end(videoHtml(m[1]));
	res.end(FEED_HTML);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
// 某些环境（安全软件 / 浏览器扩展）会把 www.douyin.com 换成字节的「验证码中间页」，盖掉本地 mock 页面还吃掉点击。
// 用 Fetch 拦截，只对 www.douyin.com 的文档直接返回 mock，其它请求照常走 —— 不动插件代码。
const FEED_HTML_B64 = Buffer.from(FEED_HTML, 'utf8').toString('base64');
const videoHtmlB64 = (id) => Buffer.from(videoHtml(id), 'utf8').toString('base64');
async function fulfillMock(browser) {
	// Document 管导航；XHR 管详情页里 fetch('/liked?id=…')（fetch 不是 Document，得单开一条）
	await browser.send('Fetch.enable', { patterns: [
		{ urlPattern: '*://www.douyin.com/*', resourceType: 'Document', requestStage: 'Request' },
		{ urlPattern: '*://www.douyin.com/*', resourceType: 'XHR', requestStage: 'Request' }
	] }, browser.sessionId);
	browser.onEvent = ((prev) => (msg) => {
		prev?.(msg);
		if (msg.method !== 'Fetch.requestPaused') return;
		const p = msg.params ?? {};
		const url = String(p.request?.url ?? '');
		// 这些请求被 Fetch 拦下（不会真到本地 srv），在这里自己记一笔，等价于原来的 srvLog
		const lm = url.match(/[?&]id=(\d+)/);
		if (url.includes('/liked')) { if (lm) srvLog.liked.push(lm[1]); }
		if (p.resourceType === 'Document') { try { const uo = new URL(url); srvLog.paths.push(uo.pathname + uo.search); } catch { /* 忽略 */ } }
		const vm = url.match(/^https?:\/\/www\.douyin\.com\/video\/(\d+)/);
		const body = vm ? videoHtmlB64(vm[1])
			: url.includes('/liked') ? Buffer.from('ok').toString('base64')
			: FEED_HTML_B64;
		browser.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body }, browser.sessionId).catch(() => {});
	})(browser.onEvent);
}
process.env.FISH_SOUL_DOUYIN_ARGS = `--headless=new --no-sandbox --host-resolver-rules=MAP www.douyin.com 127.0.0.1:${srv.address().port} --ignore-certificate-errors`;

const { openDatabase } = await import('../lib/db.js');
const { DouyinHost } = await import('../lib/channels/douyin.js');
const { DouyinBrowser } = await import('../lib/douyin-browse.js');
const { prepareImage, sniffImage, imageSize } = await import('../lib/imageconv.js');
const db = openDatabase();
const PORT = 47000 + Math.floor(Math.random() * 900);
const pref = { browser: { kind: found[0].kind, customPath: '' } };
const notes = [];
const host = new DouyinHost({ db, port: PORT, getConfig: () => pref, notify: (k, t) => notes.push([k, t]) });
/** 另开一条 CDP 连接，模拟用户在浏览器里的操作。 */
async function userCdp(method, params = {}) {
	const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
	const ws = new WebSocket(v.webSocketDebuggerUrl);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	const p = new Promise((r) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }; });
	ws.send(JSON.stringify({ id: 1, method, params }));
	const out = await Promise.race([p, sleep(3000)]);
	try { ws.close(); } catch { /* 已断 */ }
	return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

try {
	// 1 启动：自己的 profile、打开抖音首页；截图 + 点击转发；canvas 把 webp 转 png
	assert.equal(await host.start(), true, host.lastError);
	assert.equal(host.status().state, 'running');
	await fulfillMock(host.browser);
	assert.match(String(await host.browser.eval('location.href')), /^https:\/\/www\.douyin\.com\//);
	const shot = await host.screenshot();
	assert.equal(shot.jpeg.subarray(0, 2).toString('hex'), 'ffd8'); assert.ok(shot.width > 0 && shot.height > 0);
	// 内联 onclick 里的反斜杠转义（\'）不会被 HTML 解析，会变非法 JS；改用 addEventListener + 无引号 join()。
	// 且要盖在最顶层（高 z-index + pointer-events），否则抖音风控 iframe 会把这次点击吃掉。
	await host.browser.eval(`(() => {
		const el = document.createElement('div');
		el.id = 'hit';
		el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:auto';
		el.addEventListener('click', (e) => { el.dataset.at = [e.clientX, e.clientY].join(); });
		document.body.appendChild(el);
	})()`);
	assert.equal(await host.click(0.5, 0.5), true);
	assert.equal(await host.browser.eval(`document.getElementById('hit').dataset.at`), `${Math.round(shot.width / 2)},${Math.round(shot.height / 2)}`);
	const webp = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
	const png = await host.canvasConvert(webp);
	assert.equal(sniffImage(png), 'png'); assert.deepEqual(imageSize(png), { width: 1, height: 1 });
	const { writeFileSync } = await import('node:fs');
	writeFileSync(join(home, 'wow.webp'), webp);
	const img = await prepareImage(join(home, 'wow.webp'), { cacheDir: join(home, 'img-cache'), canvasConvert: (b) => host.canvasConvert(b) });
	assert.equal(img.type, 'png'); assert.match(img.path, /img-cache/);
	ok('抖音浏览器启动：打开抖音、截图、点击转发到页面；webp 在浏览器里转成 png');

	// 1b 窗口：默认后台 = 停在屏幕外；被最小化了下次动页面前停回去（不弹到屏幕上）；显示一下 / 藏起来；正常显示模式按原样拉回屏幕
	{
		const { PARK_LEFT, ensureWindowVisible } = await import('../lib/channels/vendor/douyin-bridge/douyin-panel.mjs');
		const b = host.browser;
		const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId });
		const bounds = async () => (await b.send('Browser.getWindowBounds', { windowId })).bounds;
		assert.equal(host.status().window, 'background');
		assert.ok(host.extraArgs().includes(`--window-position=${PARK_LEFT},0`));
		let bd = await bounds();
		assert.equal(bd.left, PARK_LEFT, JSON.stringify(bd));
		assert.equal(bd.windowState, 'normal');
		// 用户最小化 → 下一次动页面前：恢复成 normal 但还在屏幕外
		await userCdp('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
		await sleep(300);
		assert.equal((await bounds()).windowState, 'minimized');
		assert.equal(await host.exclusive('测试', async () => 1), 1);
		bd = await bounds();
		assert.equal(bd.windowState, 'normal'); assert.equal(bd.left, PARK_LEFT);
		// 拖回屏幕里 → ensureWindowVisible（私信每次都调）停回去
		await b.send('Browser.setWindowBounds', { windowId, bounds: { left: 10, top: 10 } });
		assert.equal(await ensureWindowVisible(b), true);
		assert.equal((await bounds()).left, PARK_LEFT);
		assert.equal(await ensureWindowVisible(b), false, '停好了就不再动');
		// 显示一下：挪回屏幕，动页面也不再藏；藏起来：停回去
		assert.equal(await host.showWindow(), true);
		assert.equal((await bounds()).left, 40);
		assert.equal(host.status().windowShown, true);
		await host.exclusive('测试', async () => 1);
		assert.equal((await bounds()).left, 40);
		await host.hideWindow();
		assert.equal((await bounds()).left, PARK_LEFT);
		// 正常显示模式：原来的行为（屏幕外的拉回来）
		pref.window = 'visible';
		assert.ok(!host.extraArgs().some((a) => a.startsWith('--window-position')));
		await host.exclusive('测试', async () => 1);
		assert.equal((await bounds()).left, PARK_LEFT, '正常显示模式下动页面不挪窗口');
		await ensureWindowVisible(b);
		assert.ok((await bounds()).left >= 0, '正常显示：屏幕外的拉回来');
		delete pref.window;
		await host.exclusive('测试', async () => 1);
		assert.equal((await bounds()).left, PARK_LEFT);
	}
	ok('抖音浏览器窗口：默认停在屏幕外；被最小化 / 拖回来会在动页面前停回去；显示一下 / 藏起来；正常显示模式照旧');

	// 2 刷推荐页：跳过直播 / 广告；箭头没了就按 ↓；详情页里点赞
	host.loggedIn = true;
	const prompts = [];
	const b = new DouyinBrowser({
		db, clock: { now: () => Date.now() }, host, getConfig: () => ({ enabled: true, browse: { enabled: true, videosPerSession: 3, like: true } }),
		callLlm: async (pr) => { prompts.push(pr); return /猫/.test(pr) ? '团子也这么睡 [点赞]' : '看饿了'; }, persona: () => ({ name: '小鱼', brief: '' }),
		dwellMs: [200, 300], settleMs: 1000,
		readDetail: async ({ browser, id }) => { await browser.goto(`https://www.douyin.com/video/${id}`, { settleMs: 1000 }); return { ok: true, desc: feed.find((f) => f.id === id).desc, author: feed.find((f) => f.id === id).author }; }
	});
	const rr = await b.run({});
	assert.equal(rr.ok, true);
	assert.deepEqual(rr.watched.map((w) => [w.id, w.author, w.liked]), [['7300000000000000032', '饭博主', false], ['7300000000000000034', '山博主', false], ['7300000000000000035', '猫博主', true]]);
	await sleep(300);
	assert.deepEqual(srvLog.liked, ['7300000000000000035'], '只点模型说了 [点赞] 的那条');
	assert.ok(srvLog.paths.includes('/?recommend=1'));
	assert.match(prompts[0], /文案：深夜做饭 #美食/);
	ok('刷抖音（真浏览器）：推荐页跳过直播 / 广告，箭头不在就按 ↓，详情页里点赞');

	// 3 用户关了标签页 = 暂停（浏览器还开着），自动流程不会再开；点「启动」恢复
	assert.equal((await userCdp('Target.closeTarget', { targetId: host.browser.targetId }))?.result?.success, true);
	await sleep(2500);
	assert.deepEqual([host.status().state, host.paused, host.status().pausedWhy], ['paused', true, '你把抖音标签页关了']);
	assert.equal(await host.start(), false, '暂停中：自动流程不重开');
	assert.equal(await host.start({ resume: true }), true);
	assert.match(String(await host.browser.eval('location.href')), /douyin\.com/);
	ok('关标签页 = 暂停，不会自己再开；点启动恢复');

	// 4 用户关了整个浏览器 = 暂停
	await userCdp('Browser.close');
	// 浏览器进程退出比 Browser.close 慢（Windows 上常要一两秒），轮询等它真的变成暂停再断言
	let browserClosed = false;
	for (let i = 0; i < 40 && !browserClosed; i++) {
		await sleep(200);
		const st = host.status();
		browserClosed = st.state === 'paused' && st.pausedWhy === '你把抖音浏览器关了';
	}
	assert.deepEqual([host.status().state, host.status().pausedWhy], ['paused', '你把抖音浏览器关了']);
	assert.equal(await host.start({ resume: true }), true);
	ok('关整个浏览器 = 暂停；点启动重新打开');

	// 5 浏览器崩了（进程被杀）：不是暂停，30 秒后自动重连
	const pid = host.browser.proc?.pid;
	assert.ok(pid > 0);
	process.kill(pid, 'SIGKILL');
	await sleep(3500);
	assert.equal(host.paused, false);
	assert.equal(host.state, 'error'); assert.match(host.lastError, /30 秒后自动重连（第 1 次）/); assert.ok(host.retryTimer !== null);
	ok('浏览器崩了：不当成用户关的，排队自动重连');

	// 6 插件卸载只断开（浏览器留着），新实例直接连上；设置页「关闭浏览器」真的关
	assert.equal(await host.start({ resume: true }), true);
	const pid2 = host.browser.proc?.pid;
	host.dispose();
	await sleep(500);
	assert.equal(alive(pid2), true, 'dispose 不关浏览器');
	const host2 = new DouyinHost({ db, port: PORT, getConfig: () => pref });
	assert.equal(await host2.start(), true);
	assert.equal(host2.running, true);
	await host2.closeBrowser();
	// 进程退出比 Browser.close 慢（Windows 上常要一两秒），等它真的没了再断言
	let died = false;
	for (let i = 0; i < 40 && !died; i++) { await sleep(200); died = !alive(pid2); }
	assert.deepEqual([host2.status().state, host2.paused, died], ['paused', true, true]);
	ok('插件卸载只断开、新实例直接连上；设置页关闭 = 真关 + 暂停');
	console.log('\n抖音浏览器测试全部通过');
} finally {
	try { host.dispose(); } catch { /* 已断 */ }
	srv.close();
}
process.exit(0);
