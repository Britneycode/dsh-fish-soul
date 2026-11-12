// #78：她刷的视频要能被想起来。
//
// 真机症状（2026-11-12）：用户今天问「你刚才刷到什么视频了」，她说想不起来。
// 检索测试里那条记忆是能召回的，问题出在两处：
//   ① 瞬态块的窗口只有 1 个虚拟日 —— 昨天刷的今天就查不到
//   ② sendReply 读 recalledAt 时，下一轮的 beginTurn 已经把 sessions 那条记录换掉了
//
// 这个测试钉住 ①；② 靠 turn state 传递，见 index.js 的 recallInfo。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('recall-window-78-');
const { openDatabase } = await import('../lib/db.js');
const { BiliBrowser } = await import('../lib/browse.js');

const db = openDatabase();
const ok = (n) => console.log('✓', n);

const DAY = 86_400_000;
// 虚拟钟固定在一个点上，方便算「1 个虚拟日之前」和「2 个虚拟日之前」
const NOW = 1_800_000_000_000;
const clock = { now: () => NOW };

const browser = new BiliBrowser({
  db, clock, log: () => {},
  client: { replyComment: async () => {}, },
  getConfig: () => ({ browse: {} })
});

const insertSeen = (bvid, title, impression, seenAt) => {
  db.prepare(`INSERT INTO bili_seen (bvid, aid, title, owner_name, source, impression, skipped, liked, memory_id, seen_at, seen_real_at)
              VALUES (?, '1', ?, 'UP', 'recommend', ?, 0, 0, 0, ?, ?)`).run(bvid, title, impression, seenAt, seenAt);
};

{
  // 昨天刷的（1.5 个虚拟日之前）：以前查不到，现在要能查到
  insertSeen('BVyesterday', '昨天的视频', '挺有意思的', NOW - 1.5 * DAY);
  const lines = browser.contextLines();
  assert.equal(lines.length, 1, '昨天刷的今天也要能想起来（窗口 2 个虚拟日）');
  assert.match(lines[0], /昨天的视频/, '要带上标题');
  ok('昨天刷的视频今天还能想起来（#78 窗口从 1 个虚拟日放宽到 2 个）');
}

{
  // 前天刷的（2.5 个虚拟日之前）：超出窗口，不该出现
  insertSeen('BVold', '前天的视频', '老掉牙了', NOW - 2.5 * DAY);
  const lines = browser.contextLines();
  assert.equal(lines.length, 1, '超出 2 个虚拟日的就不该再塞进瞬态块');
  assert.doesNotMatch(lines.join('\n'), /前天的视频/, '老视频别一直挂着');
  ok('超出窗口的老视频不会一直占着瞬态块');
}

{
  // 默认条数从 2 提到 3：刷得多的时候能多想起几条
  db.prepare("DELETE FROM bili_seen").run();
  for (const i of [1, 2, 3]) insertSeen(`BVn${i}`, `第${i}条`, '有意思', NOW - i * 1000);
  const lines = browser.contextLines();
  assert.equal(lines.length, 3, '默认给 3 条（以前 2 条，刷多了容易想不起来）');
  ok('默认注入 3 条（刷得多的时候不至于一条都提不起来）');
}

{
  // 没感受的（impression 为空）不注入 —— 老行为不能变
  db.prepare("DELETE FROM bili_seen").run();
  insertSeen('BVnoimp', '没感受的视频', '', NOW - 1000);
  assert.equal(browser.contextLines().length, 0, '没写感受的不该塞进瞬态块');
  ok('没写感受的视频仍然不注入（老契约不变）');
}

console.log('recall-window-78 ok');
