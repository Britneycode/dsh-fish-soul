// 本地页面 + 真 Chromium：只模拟创作者中心，不连接抖音、不发布作品。
//
// 🔴 fixture 按**真机 DOM 结构**造（2026-11-20 在抖音创作者中心发布图文页实测）：
//   div.card-container-*            外层卡
//     ├ div.card-container-left-*   内层左半：song-name 在这里，**没有**按钮
//     └ div.card-container-right-*  右半：「N万人使用」+「使用」按钮在这里
//   旧 fixture 是扁平的（歌名和按钮同层），所以「内层左半也算一行」这个真 bug 测不出来。
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

// 一张真机结构的歌卡：外层卡 → 内层左半(歌名) + 右半(计数 + 使用按钮)
const cardHtml = (name, { apply = true, count = '1479.4万人使用' } = {}) => `
  <div class="card-container-outer">
    <div class="card-container-left">
      <div class="song-info"><div class="top"><div class="song-name">${name}</div></div></div>
    </div>
    <div class="card-container-right">
      <div class="user-count">${count}</div>
      ${apply ? '<button class="semi-button apply-btn">使用</button>' : ''}
    </div>
  </div>`;

async function fixture({ attach = true, removePanel = false, duplicate = false, apply = true, wrap = false, songs = ['晚风心里吹'] } = {}) {
  const inner = songs.map((n) => cardHtml(n, { apply })).join('')
    + (duplicate ? cardHtml('晚风心里吹', { apply }) : '');
  // wrap：模拟抖音在歌卡之上再加一层列表包裹层（类名也带 card-container）。
  const cards = wrap ? `<div class="card-container-list">${inner}</div>` : inner;
  const html = `<!doctype html><meta charset="utf-8"><style>
    .semi-sidesheet { display:none; position:fixed; top:80px; left:20px; width:500px; height:300px; background:#ddd; }
    .semi-sidesheet-content { width:100%; height:100%; }
    .card-container-outer { display:flex; width:480px; padding:5px; }
    .card-container-left { width:300px; height:60px; }
    .card-container-right { width:180px; height:60px; }
    .apply-btn { visibility:hidden; }
    .card-container-outer:hover .apply-btn { visibility:visible; }
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
        document.querySelector('.music-collection-container').innerHTML = ${JSON.stringify(cards)};
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
  assert.equal(list.ok, true);
  // 🔴 真机结构下，一首歌只算**一行**：歌名取 song-name，计数行（N万人使用）不是歌名。
  assert.deepEqual(list.songs, ['晚风心里吹'], '推荐列表里每首歌只出现一次，计数行不能混进来');
  assert.deepEqual(list.counts, { 晚风心里吹: 1 }, '同一首歌不该被判成同名');
  let result = await driver.publishNote({ music: '晚风心里吹' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await br.eval('window.publishCount'), 1, '确认音乐后发布');

  // 计数行不是歌名：多首歌时推荐列表不该混进「N万人使用」
  await fixture({ songs: ['晚风心里吹', '人生路漫漫主歌'] });
  const list2 = await driver.listRecommendedMusic();
  assert.deepEqual(list2.songs, ['晚风心里吹', '人生路漫漫主歌'], '计数行不混进歌名列表');
  assert.deepEqual(list2.counts, { 晚风心里吹: 1, 人生路漫漫主歌: 1 }, '每首歌计数都是 1');

  // 歌卡之上多一层带 card-container 类名的列表包裹层：不能把所有歌塌成一行。
  await fixture({ wrap: true, songs: ['晚风心里吹', '人生路漫漫主歌'] });
  const listWrapped = await driver.listRecommendedMusic();
  assert.deepEqual(listWrapped.songs, ['晚风心里吹', '人生路漫漫主歌'], '包裹层不能让所有歌塌成一行');
  assert.deepEqual(listWrapped.counts, { 晚风心里吹: 1, 人生路漫漫主歌: 1 }, '包裹层下每首歌计数仍是 1');
  await driver.closeMusicPanel();

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

  // 推荐列表里同一首歌常有剪辑版。点第一张「使用」并确认歌名，不能因此整单不发。
  await fixture({ duplicate: true });
  assert.equal((await driver.listRecommendedMusic()).ok, true);
  result = await driver.publishNote({ music: '晚风心里吹', allowDuplicate: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await br.eval('window.publishCount'), 1, '同名时点第一张并确认后要发布');
  await driver.closeMusicPanel();

  await fixture({ duplicate: true, attach: false });
  assert.equal((await driver.listRecommendedMusic()).ok, true);
  result = await driver.publishNote({ music: '晚风心里吹', allowDuplicate: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /未确认/);
  assert.equal(await br.eval('window.publishCount'), 0, '同名但编辑页没确认歌名，仍然不发布');
  await driver.closeMusicPanel();
  console.log('✓ 抖音配乐（本地 Chromium 模拟真机三层卡片结构）：歌名不重复、计数行不混入、正确选歌、未确认/无按钮时不发布、同名点第一张');
} finally {
  await br.quit();
}