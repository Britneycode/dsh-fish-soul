// 本地页面 + 真 Chromium：只模拟创作者中心，不连接抖音、不发布作品。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { detectBrowsers } from '../lib/browsers.js';
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs';
import { tmpHome } from './_tmp.mjs';
import { douyinSocialDriver } from '../lib/douyin-social.js';

const found = (await detectBrowsers().catch(() => [])).find(b => b.path);
if (!found) { console.log('- 跳过抖音配乐测试：没找到 Chromium 系浏览器'); process.exit(0); }
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const br = new Browser({ exe: found.path, userDataDir: join(tmpHome('dsh-dymusic-'), 'profile'), port, extraArgs: ['--headless=new', '--no-sandbox'] });
await br.launch();
const driver = douyinSocialDriver({ running: true, browser: br });

async function fixture({ apply = true, attach = true, duplicate = false, removePanel = false } = {}) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    .semi-sidesheet { display:none; position:fixed; top:80px; left:20px; width:500px; height:300px; background:#ddd; }
    .semi-sidesheet-content { width:100%; height:100%; }
    .card-container { height:60px; padding:5px; }
    .apply-btn { visibility:hidden; }
    .card-container:hover .apply-btn { visibility:visible; }
  </style>
  <div class="music-row"><span class="current"></span><div class="container-right"><span id="open">选择音乐</span></div></div>
  <div id="preview">晚风心里吹</div>
  <div class="semi-sidesheet"><div class="semi-sidesheet-content"><input placeholder="搜索音乐"><span>推荐</span>
  <div class="music-collection-container"></div></div></div>
  <button id="publish">发布</button><div id="result"></div>
  <script>
    window.publishCount = 0;
    document.querySelector('#open').onclick = () => setTimeout(() => {
      document.querySelector('.semi-sidesheet').style.display = 'block';
      setTimeout(() => {
        document.querySelector('.music-collection-container').innerHTML = '<div class="card-container"><span class="song-name">晚风心里吹</span>${apply ? '<button class="apply-btn">使用</button>' : ''}</div>${duplicate ? '<div class="card-container"><span class="song-name">晚风心里吹</span><button class="apply-btn">使用</button></div>' : ''}';
        for (const b of document.querySelectorAll('.apply-btn')) b.onclick = () => {
          ${attach ? "document.querySelector('.current').innerText = '晚风心里吹';" : ''}
          ${removePanel ? "document.querySelector('.semi-sidesheet').remove();" : "document.querySelector('.semi-sidesheet').style.display = 'none';"}
        };
      }, 400);
    }, 250);
    document.querySelector('#publish').onclick = () => { window.publishCount++; document.querySelector('#result').innerText = '发布成功'; };
  </script>`;
  await br.eval(`document.open(); document.write(${JSON.stringify(html)}); document.close(); true`);
}

try {
  await fixture();
  const list = await driver.listRecommendedMusic();
  assert.deepEqual(list, { ok: true, songs: ['晚风心里吹'] }, '等待面板与推荐歌曲异步加载');
  let result = await driver.publishNote({ music: '晚风心里吹' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await br.eval('window.publishCount'), 1, '确认音乐后发布');

  await fixture({ attach: false, removePanel: true });
  assert.equal((await driver.listRecommendedMusic()).ok, true);
  result = await driver.publishNote({ music: '晚风心里吹' });
  assert.equal(result.ok, false);
  assert.match(result.error, /未确认/);
  assert.equal(await br.eval('window.publishCount'), 0, '预览文字或关闭抽屉不能当作配乐成功');

  await fixture({ apply: false });
  assert.equal((await driver.listRecommendedMusic()).ok, true);
  result = await driver.publishNote({ music: '晚风心里吹' });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有出现使用按钮/);
  assert.equal(await br.eval('window.publishCount'), 0, '找不到使用按钮不发布');

  await fixture();
  assert.equal((await driver.listRecommendedMusic()).ok, true);
  result = await driver.publishNote({ music: '' });
  assert.equal(result.ok, false);
  assert.equal(await br.eval('window.publishCount'), 0, '没有选出歌曲不发布');

  await fixture({ duplicate: true });
  assert.equal((await driver.listRecommendedMusic()).ok, true);
  result = await driver.publishNote({ music: '晚风心里吹' });
  assert.equal(result.ok, false);
  assert.match(result.error, /同名/);
  assert.equal(await br.eval('window.publishCount'), 0, '同名歌曲不盲选');
  await driver.closeMusicPanel();
  console.log('✓ 抖音配乐（本地 Chromium 模拟页面）：异步加载、正确选歌、未确认/无按钮/同名时不发布');
} finally {
  await br.quit();
}
