// 抖音视频发布的 driver 层：本地 Chromium + 本机假「创作者中心」站点。
//
// 不连抖音、不发真作品、不传真视频 —— 站点是本机 HTTP 服务上的假页面。
// 守的是三件真机上踩过、代码里写死了判据的事：
//   ① 等转码只能看 video 元素（有时长 + 源在抖音 CDN 上）；**不能**看「上传中」那行字消失
//      （实测那行字 180 秒都不消，可视频早转好了）；
//   ② 描述框必须用**真鼠标事件**点进去 —— el.click() 点不动这个编辑器（真机踩过）；
//   ③ 发布成功要**两个都**满足：地址跳到 content/manage，且页面上出现「已发布 / 发布成功」。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectBrowsers } from '../lib/browsers.js';
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs';
import { tmpHome } from './_tmp.mjs';
import { douyinSocialDriver } from '../lib/douyin-social.js';

const found = (await detectBrowsers().catch(() => [])).find((b) => b.path);
if (!found) { console.log('- 跳过抖音视频 driver 测试：没找到 Chromium 系浏览器'); process.exit(0); }

// 浏览器的调试口要一个空闲端口：借一个 socket 问一句端口号就还回去
const probe = createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const cdpPort = probe.address().port;
await new Promise((r) => probe.close(r));

// 假站：本机 HTTP 服务，任何路径都回当前这张假页面（driver 会自己导航，所以内容得由服务端给）
let currentHtml = '<!doctype html><meta charset="utf-8"><body></body>';
const site = createServer((req, res) => {
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(currentHtml);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;
const uploadUrl = `${base}/creator-micro/content/upload`;
const manageUrl = `${base}/creator-micro/content/manage`;

const home = tmpHome('dsh-dyviddriver-');
const br = new Browser({ exe: found.path, userDataDir: join(home, 'profile'), port: cdpPort, extraArgs: ['--headless=new', '--no-sandbox'] });
await br.launch();

// 假浏览器：只把「创作者中心这个站点」换成本机那张假页面，其余全是真操作。
// ⚠️ 只替换**站点相关**的两处：导航目标，和导航之后的地址（登录判据读的就是它）。
//    取文件输入框、等转码、真鼠标事件、找发布按钮 —— 全走真 CDP。
let creatorHref = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=1';
const fakeBrowser = {
	get sessionId() { return br.sessionId; },
	eval: async (expr, opts) => (String(expr).trim() === 'location.href' ? creatorHref : br.eval(expr, opts)),
	send: (method, params, sid, timeoutMs) => br.send(method, params, sid, timeoutMs),
	// settleMs 是给真站的脚本留时间；假页面秒开，等 8 秒纯属浪费
	goto: async (url, opts) => br.goto(/creator\.douyin\.com/.test(String(url)) ? uploadUrl : url, { ...opts, settleMs: 0 })
};

// 转码预算压到 4 秒：本机假页面秒好，等 3 分钟是纯浪费
const driver = douyinSocialDriver({ running: true, browser: fakeBrowser }, { transcodeBudgetMs: 4000, waitBudgetMs: 5000, evalTimeoutMs: 8000, gotoTimeoutMs: 15000 });

/** 换一张假页面并导航过去（地址变了也用它）。 */
const show = async (html, url = uploadUrl) => { currentHtml = html; await br.goto(url, { settleMs: 0 }); };

/** 假编辑页：上传口 + 预览视频 + 标题框 + 描述框。 */
const editorHtml = ({ file = true, desc = true, title = true, uploading = true, readyInMs = 0, ready = true } = {}) => `
<!doctype html><meta charset="utf-8"><style>
 body{margin:0;font:14px sans-serif}
 #title{display:block;width:400px;height:24px}
 #desc{display:block;width:400px;height:80px;border:1px solid #ccc}
 video{display:block;width:200px;height:120px;background:#eee}
</style>
${file ? '<input type="file" accept="video/mp4" id="file">' : ''}
<video id="v"></video>
${uploading ? '<div id="up">上传中</div>' : ''}
${title ? '<input id="title" placeholder="填写作品标题">' : ''}
${desc ? '<div id="desc" class="zone-container" contenteditable="true"></div>' : ''}
<script>
 window.__mouse = null;
 const d = document.getElementById('desc');
 if (d) d.addEventListener('mousedown', (e) => { window.__mouse = { x: e.clientX, y: e.clientY }; d.focus(); });
 const v = document.getElementById('v');
 const becomeReady = () => {
   Object.defineProperty(v, 'duration', { value: 7, configurable: true });
   Object.defineProperty(v, 'currentSrc', { value: 'https://video-cn.douyin.com/abc/video.mp4', configurable: true });
 };
 ${ready ? (readyInMs > 0 ? `setTimeout(becomeReady, ${readyInMs});` : 'becomeReady();') : ''}
</script>`;

/** 假作品管理页：一个发布按钮（可再加禁用的诱饵）+ 点击后页面上的字。 */
const publishHtml = ({ after = '已发布', verify = false, buttons = [{ id: 'b1', disabled: false }] } = {}) => `
<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px sans-serif}button{padding:6px 20px}</style>
${buttons.map((b) => `<button id="${b.id}"${b.disabled ? ' disabled' : ''}>发布</button>`).join('')}
${verify ? '<div>请完成验证</div>' : '<div id="state"></div>'}
<script>
 window.__clicked = null;
 ${buttons.map((b) => `document.getElementById('${b.id}').addEventListener('click', () => { window.__clicked = '${b.id}'; const s = document.getElementById('state'); if (s) s.innerText = ${JSON.stringify(after)}; });`).join('\n')}
</script>`;

const mp4 = join(home, 'v1.mp4');
writeFileSync(mp4, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]));

try {
	// ── V1：传文件 → 等转码 → 填标题描述 ───────────────────────────────────
	await show(editorHtml({ readyInMs: 1200 }));
	let r = await driver.prepareVideo({ title: '厨房的蒸汽', text: '蒸汽糊住了窗', file: mp4 });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(await br.eval("document.querySelector('#file').files[0].name"), 'v1.mp4', '文件要真的投到上传口上');
	assert.equal(await br.eval("document.querySelector('#title').value"), '厨房的蒸汽', '标题要进标题框');
	assert.equal(await br.eval("document.querySelector('#desc').innerText.trim()"), '蒸汽糊住了窗', '描述要进描述框');
	const mouse = await br.eval('window.__mouse');
	assert.ok(mouse, '描述框必须用真鼠标事件点进去（el.click() 点不动）');
	const rect = await br.eval("(() => { const r = document.querySelector('#desc').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()");
	assert.ok(mouse.x >= rect.left && mouse.x <= rect.left + rect.w && mouse.y >= rect.top && mouse.y <= rect.top + rect.h,
		`鼠标要点在描述框上（实际 ${mouse.x},${mouse.y}；框 ${rect.left},${rect.top} ${rect.w}x${rect.h}）`);

	// ── V2：「上传中」那行字不消，也得能过（真机：180 秒都不消） ───────────────
	await show(editorHtml({ readyInMs: 800, uploading: true }));
	r = await driver.prepareVideo({ title: '标题', text: '正文', file: mp4 });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.ok(String(await br.eval('document.body.innerText')).includes('上传中'), '这行字还在 —— 判据不能靠它');

	// ── V3：转码一直没出来 → 明确报超时，不能干等 ──────────────────────────
	await show(editorHtml({ ready: false }));
	r = await driver.prepareVideo({ title: '标题', text: '正文', file: mp4 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'TRANSCODE_TIMEOUT', r.error);

	// ── V4：地址跑到登录页 → 没登录 ─────────────────────────────────────────
	creatorHref = 'https://www.douyin.com/login';
	await show(editorHtml({}));
	r = await driver.prepareVideo({ title: '标题', text: '正文', file: mp4 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NOT_LOGGED_IN', r.error);
	creatorHref = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=1';

	// ── V5：页面上没有上传口 → 明确报出来 ───────────────────────────────────
	await show(editorHtml({ file: false }));
	r = await driver.prepareVideo({ title: '标题', text: '正文', file: mp4 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NO_UPLOAD', r.error);

	// ── V6：没有描述框 → 明确报出来 ─────────────────────────────────────────
	await show(editorHtml({ desc: false }));
	r = await driver.prepareVideo({ title: '标题', text: '正文', file: mp4 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NO_EDITOR', r.error);

	// ── V7：发布成功：点最后一个可用的「发布」，beforeSubmit 在点之前 ────────
	await show(publishHtml({ buttons: [{ id: 'disabledOne', disabled: true }, { id: 'realOne', disabled: false }] }), manageUrl);
	let submitted = false;
	r = await driver.publishVideo({ beforeSubmit: async () => { submitted = true; } });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(await br.eval('window.__clicked'), 'realOne', '要点最后一个没禁用的「发布」');
	assert.equal(submitted, true, '点发布前要先持久化（beforeSubmit）');

	// ── V8：地址到了但页面上没有「已发布」→ 不能算成功 ─────────────────────
	await show(publishHtml({ after: '审核中' }), manageUrl);
	r = await driver.publishVideo({ beforeSubmit: async () => {} });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NOT_CONFIRMED', r.error);

	// ── V9：有「已发布」但地址不在 content/manage → 也不能算成功 ───────────
	await show(publishHtml({ after: '已发布' }), uploadUrl);
	r = await driver.publishVideo({ beforeSubmit: async () => {} });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NOT_CONFIRMED', r.error);

	// ── V10：页面要验证码 → 报 NEEDS_VERIFY（且不调用 beforeSubmit） ─────────────
	await show(publishHtml({ verify: true }), manageUrl);
	let v10Sub = false;
	r = await driver.publishVideo({ beforeSubmit: async () => { v10Sub = true; } });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NEEDS_VERIFY', r.error);
	assert.equal(v10Sub, false, '点发布前被验证码拦住，不该触发 beforeSubmit');

	// ── V11：没有「发布」按钮 → 明确报出来（且不调用 beforeSubmit） ────────────
	await show(publishHtml({ buttons: [] }), manageUrl);
	let v11Sub = false;
	r = await driver.publishVideo({ beforeSubmit: async () => { v11Sub = true; } });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'NO_PUBLISH', r.error);
	assert.equal(v11Sub, false, '没找到可用发布按钮前，不该触发 beforeSubmit');

	console.log('✓ 抖音视频 driver：等转码只看 video 元素（「上传中」不消也放行）、描述框用真鼠标事件、发布成功要地址和「已发布」同时成立');
} finally {
	try { await br.close(); } catch { /* 关不掉就算了 */ }
	site.close();
}
