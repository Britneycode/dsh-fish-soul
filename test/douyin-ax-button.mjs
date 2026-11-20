// 「使用」按钮语义定位的三个专项用例（独立文件，每个用例用全新页面，互不干扰）。
//
// 为什么单独一个文件：现有 test/douyin-music.mjs 已经跑了 10+ 条用例、共用同一个
// 浏览器页面（靠 document.write 重置）。往里加用例会引入跨用例状态问题，
// 而那些用例本身要守的是别的契约。这里每条用例都 document.write 全新页面 + 独立断言。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { detectBrowsers } from '../lib/browsers.js';
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs';
import { tmpHome } from './_tmp.mjs';
import { douyinSocialDriver } from '../lib/douyin-social.js';

const found = (await detectBrowsers().catch(() => [])).find(b => b.path);
if (!found) { console.log('- 跳过：没找到 Chromium 系浏览器'); process.exit(0); }
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const br = new Browser({ exe: found.path, userDataDir: join(tmpHome('dsh-dyaxbtn-'), 'profile'), port, extraArgs: ['--headless=new', '--no-sandbox'] });
await br.launch();
const driver = douyinSocialDriver({ running: true, browser: br });

const SONG = '晚风心里吹';

// 真机三层结构。plainClass：按钮**不带** apply-btn 类名（只有语义定位能找到）。
const card = (name, { plainClass = false, noButton = false } = {}) => `
  <div class="card-container-outer">
    <div class="card-container-left">
      <div class="song-info"><div class="top"><div class="song-name">${name}</div></div></div>
    </div>
    <div class="card-container-right">
      <div class="user-count">1479.4万人使用</div>
      ${noButton ? '' : `<button class="semi-button${plainClass ? '' : ' apply-btn'}">使用</button>`}
    </div>
  </div>`;

async function page({ plainClass = false, decoy = false, delayMs = 0, attach = true } = {}) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    .semi-sidesheet { display:none; position:fixed; top:80px; left:20px; width:500px; height:300px; background:#ddd; }
    .semi-sidesheet-content { width:100%; height:100%; }
    .card-container-outer { display:flex; width:480px; padding:5px; }
    .card-container-left { width:300px; height:60px; }
    .card-container-right { width:180px; height:60px; }
    .apply-btn { visibility:hidden; }
    .card-container-outer:hover .apply-btn { visibility:visible; }
    /* 无类名的按钮也要靠 hover 才出现，模拟真机 */
    .card-container-right > button { visibility:hidden; }
    .card-container-outer:hover .card-container-right > button { visibility:visible; }
  </style>
  ${decoy ? '<div id="decoy-toolbar"><button id="decoy">使用</button></div>' : ''}
  <div class="music-row"><span class="current"></span><div class="container-right"><span id="open">选择音乐</span></div></div>
  <div id="preview"></div>
  <div class="semi-sidesheet"><div class="semi-sidesheet-content"><input placeholder="搜索音乐"><span>推荐</span>
  <div class="music-collection-container"></div></div></div>
  <button id="publish">发布</button><div id="result"></div>
  <script>
    window.publishCount = 0;
    window.decoyClicks = 0;
    window.clickedText = '';
    var decoyEl = document.querySelector('#decoy');
    if (decoyEl) decoyEl.onclick = function () { window.decoyClicks++; };
    document.querySelector('#open').onclick = function () {
      setTimeout(function () {
        var sheet = document.querySelector('.semi-sidesheet');
        if (!sheet) return;
        sheet.style.display = 'block';
        setTimeout(function () {
          // 延迟期：卡片**没有按钮**（不是 display:none —— 那样 hover 一来就可见，考验不到重试）
          var bind = function () {
            var btns = document.querySelectorAll('.music-collection-container button');
            for (var j = 0; j < btns.length; j++) {
              btns[j].onclick = function () {
                window.clickedText = (this.innerText || '').trim();
                ${attach ? "document.querySelector('.current').innerText = " + JSON.stringify(SONG) + ";" : ''}
                document.querySelector('.semi-sidesheet').style.display = 'none';
              };
            }
          };
          var box = document.querySelector('.music-collection-container');
          box.innerHTML = ${JSON.stringify(card(SONG, { plainClass, noButton: delayMs > 0 }))};
          if (${delayMs} > 0) {
            // 只在**第一次 hover 之后**才开始计时插入 —— 否则面板打开到 publishNote
            // 之间的时间就把延迟吃完了，waitFor 的重试根本没被考验。
            var started = false;
            var startDelay = function () {
              if (started) return; started = true;
              setTimeout(function () {
                box.innerHTML = ${JSON.stringify(card(SONG, { plainClass }))};
                bind();
              }, ${delayMs});
            };
            document.addEventListener('mousemove', startDelay, { once: true });
          }
          if (!(${delayMs} > 0)) bind();
        }, 300);
      }, 200);
    };
    document.querySelector('#publish').onclick = function () { window.publishCount++; document.querySelector('#result').innerText = '发布成功'; };
  </script>`;
  await br.eval(`document.open(); document.write(${JSON.stringify(html)}); document.close(); true`);
  // 等页面脚本装好
  await new Promise(r => setTimeout(r, 120));
}

try {
  // 用例 A：按钮**没有** apply-btn 类名 —— 只有语义定位（role+name）才找得到。
  await page({ plainClass: true });
  const la = await driver.listRecommendedMusic();
  assert.equal(la.ok, true, 'A: 推荐列表读得到');
  let r = await driver.publishNote({ music: SONG });
  assert.equal(r.ok, true, 'A: 按钮无 apply-btn 类名时也要能配乐成功：' + JSON.stringify(r));
  assert.equal(await br.eval('window.publishCount'), 1, 'A: 配乐成功后要发布');
  assert.equal(await br.eval('window.clickedText'), '使用', 'A: 点到的是「使用」按钮');
  await driver.closeMusicPanel();

  // 用例 B：页面别处有一个可见的「使用」（DOM 顺序在前）—— 绝不能点到它。
  await page({ decoy: true });
  assert.equal((await driver.listRecommendedMusic()).ok, true, 'B: 推荐列表读得到');
  r = await driver.publishNote({ music: SONG });
  assert.equal(await br.eval('window.decoyClicks'), 0, 'B: 绝不能点到页面别处的「使用」按钮');
  assert.equal(r.ok, true, 'B: 有诱饵时仍要点对目标卡：' + JSON.stringify(r));
  assert.equal(await br.eval('window.publishCount'), 1, 'B: 点对目标卡后要发布');
  await driver.closeMusicPanel();

  // 用例 C：按钮延迟 700ms 才出现 —— waitFor 的重试必须真的生效。
  //   曾因 findApplyButton 返回 {ok:false}（truthy）⇒ waitFor 第一轮就返回 ⇒ 竞态没被吸收。
  await page({ delayMs: 700 });
  assert.equal((await driver.listRecommendedMusic()).ok, true, 'C: 推荐列表读得到');
  r = await driver.publishNote({ music: SONG });
  assert.equal(r.ok, true, 'C: 按钮晚 700ms 出现也要等到：' + JSON.stringify(r));
  assert.equal(await br.eval('window.publishCount'), 1, 'C: 等到按钮后要发布');
  await driver.closeMusicPanel();

  console.log('✓ 「使用」按钮语义定位：无哈希类名 / 页面有诱饵按钮 / 按钮延迟出现');
} finally {
  await br.quit();
}
