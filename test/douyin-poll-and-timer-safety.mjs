import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { tmpHome } from './_tmp.mjs';

// 🔴 一批「跑久了才现形」的健壮性缺陷。
//
//  ① 定时器里的 async 没有 catch：宿主没有全局 unhandledRejection 兜底，
//     库被关（插件卸载）/ SQLITE_BUSY 超时 = 进程直接退出。
//     （slang.tick、outbox.schedule、life 的闹钟链）
//  ② life.stop() 之后闹钟链会自我续命：flushDue().finally(armPendingAlarm)
//     无条件重挂 → 卸载后仍然对已停止的 gateway 投递、写已关闭的 db。
//  ③ outbox 一条坏记录（segs 落盘损坏）让整个队列永久瘫痪。
//  ④ 抖音熔断被 unread 完全绕过：恒有未读 + 恒失败 = gap 无界增长。
//  ⑤ MAX_READS_PER_POLL 截断让后几个会话永久饿死（排序不稳定）。
//  ⑥ exclusive 超时只放锁不中断，读和发真的并发动同一个页面。

process.env.DSH_HOME = tmpHome('timer-safety-');
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const db = openDatabase();
// 建表是懒的（DouyinInbox / Outbox 构造时才 CREATE TABLE）：先初始化一次
const { DouyinInbox } = await import('../lib/douyin-inbox.js');
new DouyinInbox(db).status();
const { Outbox: _Ob } = await import('../lib/outbox.js');
new _Ob({ db, channel: { send: async () => '' }, windowMs: () => 0 }).stop?.();

const SELF = '900001';
const PEER = '7702399256389125000';
// 先学出「我是谁」，否则 identity 推不出来会走失败路径（轮转测试就测不到了）
setKv(db, 'douyin.selfUid', SELF);
const CONV = `0:1:${SELF}:${PEER}`;
const keyOf = (name) => `douyin.conv.${createHash('sha1').update(String(name)).digest('hex').slice(0, 16)}`;

// ── ① 定时器 catch ──────────────────────────────────────────────────────────
test('slang 定时器：learn 抛错不会变成未处理拒绝', async () => {
  const { SlangLearner } = await import('../lib/slang.js');
  const s = new SlangLearner({
    db, getConfig: () => ({ enabled: true }), callLlm: async () => { throw new Error('模型炸了'); },
    personaName: () => '飞鱼', titleOf: () => '测试群', log: () => {},
  });
  // 直接调 learn（定时器里就是这么调的），必须返回结构化错误而不是抛出
  s.buffers.set('group:1', { lines: Array.from({ length: 8 }, (_, i) => ({ name: `人${i}`, text: `话${i}`, self: false })), newCount: 8 });
  const r = await s.learn('group:1');
  assert.equal(r.ok, false, 'learn 失败要返回 ok:false，不能抛出去');
  assert.match(String(r.error), /模型炸了/, '要带真实原因（设置页要能显示）');
  assert.equal(s.running, null, 'running 必须被清掉，否则以后永远「正在学别的聊天」');
});

test('outbox：一条 segs 损坏的记录不会让整个队列瘫痪', async () => {
  const { Outbox } = await import('../lib/outbox.js');
  const sent = [];
  const gaveUp = [];
  const ob = new Outbox({
    db, windowMs: () => 10 * 60_000, now: () => Date.now(),
    channel: { connected: true, send: async (_cid, segs) => { sent.push(segs); return 'mid'; } },
    log: () => {}, onSent: () => {}, onGiveUp: (_item, reason) => gaveUp.push(reason),
  });
  db.exec('DELETE FROM outbox');
  // 一条坏的（segs 不是 JSON）+ 一条好的
  db.prepare(`INSERT INTO outbox (channel_id, title, segs, text, next_at, created_at, last_error, conv_id, status, attempts)
    VALUES ('qq:1', 't', '{{{坏掉的', 'x', 0, ?, '', '', 'queued', 0)`).run(Date.now());
  db.prepare(`INSERT INTO outbox (channel_id, title, segs, text, next_at, created_at, last_error, conv_id, status, attempts)
    VALUES ('qq:2', 't', ?, '好', 0, ?, '', '', 'queued', 0)`).run(JSON.stringify([{ type: 'text', data: { text: '好' } }]), Date.now());

  await ob.flush({ force: true }); // 不该抛
  assert.ok(gaveUp.some((r) => /损坏/.test(r)), '坏记录要被告知放弃，而不是静默卡住');
  assert.equal(sent.length, 1, '好记录要照常发出去（以前整轮在同一行抛，两条都发不出）');
});

// ── ② life 闹钟链 ───────────────────────────────────────────────────────────
test('life.stop() 之后闹钟链不再自我续命', async () => {
  const { LifeEngine } = await import('../lib/life.js');
  const created = [];
  const realSetTimeout = globalThis.setTimeout;
  // 拦截 setTimeout：只记录，不真跑（避免测试里真的等 15 分钟）
  globalThis.setTimeout = (fn, ms) => { created.push(ms); const t = { fn, ms, unref() { return t; } }; return t; };
  globalThis.clearTimeout = () => {};
  try {
    const life = new LifeEngine({
      db, clock: { now: () => Date.now(), toRealIntervalMs: (v) => v, realMsToVirtual: (v) => v },
      getConfig: () => ({ proactive: { enabled: true } }), callLlm: async () => null,
      deliver: async () => true, log: () => {},
    });
    life.start();
    const before = created.length;
    life.stop();
    // stop 之后 armPendingAlarm 必须直接 return（不新建闹钟）
    life.armPendingAlarm();
    assert.equal(created.length, before, 'stop() 之后不能再挂新闹钟');
    assert.equal(life.stopped, true, 'stop 要立旗');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// ── ④ 熔断封顶 ──────────────────────────────────────────────────────────────
test('抖音：连续失败够多次后，有未读也不再绕过熔断（gap 不再无界增长）', async () => {
  const { DouyinChannel } = await import('../lib/channels/douyin.js');
  db.exec('DELETE FROM douyin_inbox');
  const key = keyOf('未云');
  let reads = 0;
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => ({ queued: true }),
    driver: {
      checkLogin: async () => true,
      list: async () => ({ ok: true, conversations: [{ name: '未云', unread: 1, time: '23:59', preview: '有新消息' }] }),
      read: async () => { reads++; return { ok: false, error: '拿不到会话 ID' }; },
    },
  });
  ch.lastCanaryAt = Date.now();
  setKv(db, 'douyin.bootstrapped', true);
  // 模拟「已经连续失败 3 次，且刚刚失败过」
  setKv(db, `douyin.retry.${key}`, Date.now());
  setKv(db, `douyin.fails.${key}`, 3);

  await ch.pollInner().catch(() => {});
  assert.equal(reads, 0, '连续失败到上限后，即使有未读也要熔断（否则 gap 每轮涨一条）');
});

test('抖音：失败次数没到上限时，有未读仍要绕过熔断（真消息不能被挡）', async () => {
  const { DouyinChannel } = await import('../lib/channels/douyin.js');
  db.exec('DELETE FROM douyin_inbox');
  const key = keyOf('未云');
  let reads = 0;
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => ({ queued: true }),
    driver: {
      checkLogin: async () => true,
      list: async () => ({ ok: true, conversations: [{ name: '未云', unread: 1, time: '23:59', preview: '有新消息' }] }),
      read: async () => { reads++; return { ok: false, error: '拿不到会话 ID' }; },
    },
  });
  ch.lastCanaryAt = Date.now();
  setKv(db, 'douyin.bootstrapped', true);
  setKv(db, `douyin.retry.${key}`, Date.now());
  setKv(db, `douyin.fails.${key}`, 1); // 只失败过一次

  await ch.pollInner().catch(() => {});
  assert.ok(reads >= 1, '失败次数少时，真新消息仍要尝试读');
});

// ── ⑤ 轮转 ──────────────────────────────────────────────────────────────────
test('抖音：会话多于单轮上限时按「最久没读」轮转，不会饿死后几个', async () => {
  const { DouyinChannel } = await import('../lib/channels/douyin.js');
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const readCount = new Map(names.map((n) => [n, 0]));
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => ({ queued: true }),
    driver: {
      checkLogin: async () => true,
      list: async () => ({ ok: true, conversations: names.map((n) => ({ name: n, unread: 1, time: '23:59', preview: 'x' })) }),
      read: async (name) => {
        readCount.set(name, (readCount.get(name) ?? 0) + 1);
        const conv = `0:1:${SELF}:${PEER}`;
        return { ok: true, convId: conv, messages: [] };
      },
    },
  });
  ch.lastCanaryAt = Date.now();
  setKv(db, 'douyin.bootstrapped', true);
  // 跑 3 轮（每轮上限 5 个，8 个会话）
  for (let i = 0; i < 3; i++) await ch.pollInner().catch(() => {});

  const never = names.filter((n) => (readCount.get(n) ?? 0) === 0);
  assert.equal(never.length, 0, `不该有会话一次都没被读过（实际没读的：${never.join(',')}）`);
});

// ── ⑥ exclusive ─────────────────────────────────────────────────────────────
test('exclusive 超时后不放锁，避免下一件事和它并发动同一个页面', async () => {
  const { DouyinHost } = await import('../lib/channels/douyin.js');
  const order = [];
  // exclusive() 在宿主类上（管浏览器那把锁），不在通道上
  const h = new DouyinHost({ db, getConfig: () => ({ enabled: true }), log: () => {} });
  h.tidyWindow = async () => {};
  let slowStillRunning = false;

  // 第一件事：慢，超过 maxMs
  const slow = h.exclusive('慢读', async () => {
    slowStillRunning = true;
    order.push('slow:start');
    await new Promise((r) => setTimeout(r, 60));
    order.push('slow:end');
    slowStillRunning = false;
  }, { maxMs: 10 }).catch(() => { order.push('slow:timeout'); });

  // 第二件事：必须在第一件**真的跑完**之后才开始
  const fast = h.exclusive('发送', async () => {
    order.push(`fast:start(slow还在跑=${slowStillRunning})`);
  }, { maxMs: 5000 });

  await Promise.all([slow, fast]);
  // 判据一：调用方要能及时拿到超时（不能陪着一起等）
  assert.ok(order.includes('slow:timeout'), `调用方要及时拿到超时（实际顺序：${order.join(' → ')}）`);
  // 判据二：慢操作必须真的跑完（不是被丢下不管）
  assert.ok(order.includes('slow:end'), `慢操作要真的收尾（实际顺序：${order.join(' → ')}）`);
  // 判据三（关键）：第二件事开始时，慢操作已经结束了
  assert.equal(slowStillRunning, false, '第二件事不能在慢操作还在动页面时开始');
  const fastIdx = order.findIndex((x) => x.startsWith('fast:start'));
  const slowEndIdx = order.indexOf('slow:end');
  assert.ok(fastIdx > slowEndIdx, `第二件事必须排在收尾之后（实际顺序：${order.join(' → ')}）`);
});

test.after(() => db.close());
console.log('timer-safety ok');
