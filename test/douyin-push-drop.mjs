import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpHome } from './_tmp.mjs';

// 🔴 抖音推送路的**静默丢弃**（v0.15.34 引入）。
//
// 症状（真机报障）：uid 和 convId 都解出来了，消息就是不回复，也不进「待核实」。
// 根因是 `consumePushFrames()` 里两行 `continue`，**都没有日志**：
//
//   ① identity === '' → 还不知道自己是谁，整帧丢
//   ② !name → 没有昵称映射，整帧丢（注释写「先等轮询路学到」，
//      但轮询路在已打开的会话上会卡住读超时 → 永远学不到 → 死锁）
//
// 后果：消息在**入库之前**就没了，连 unknown / gap 都进不去。
// 同一个版本，本地能跑（昵称缓存有）、别人跑不了（缓存空）—— 这就是
// 「其他用户还是说有问题」的来源。
//
// 守两条判据：
//   - 丢掉必须**留痕**（纯函数给出原因 + 记账键）
//   - 同一原因**不刷屏**（接线层按原因节流，计数照实累加）

process.env.DSH_HOME = tmpHome('douyin-push-drop-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinChannel, pushFrameVerdict } = await import('../lib/channels/douyin.js');
const { DouyinInbox } = await import('../lib/douyin-inbox.js');

const db = openDatabase();
new DouyinInbox(db).status(); // 建表

const SELF = '1888295424633712';
const PEER = '7702399256389125000';
const CONV = `0:1:${SELF}:${PEER}`;

// ── ① 纯函数：两条丢弃路径各有原因和记账键 ─────────────────────────────────
test('身份缺失 → 不许 ok，必须给出原因和记账键', () => {
  const v = pushFrameVerdict({ identity: '', name: '', convId: CONV, selfUidCount: 0 });
  assert.equal(v.ok, false, '身份缺失不能放行');
  assert.equal(v.reason, 'noIdentity');
  assert.equal(v.stat, 'droppedNoIdentity', '要有可累加的记账键，否则「丢了多少」查不到');
  assert.match(v.message, /身份|自己是谁/, `说明要讲人话：${v.message}`);
  assert.ok(v.message.includes(CONV), '要带上 convId，否则不知道该查哪个会话');
});

test('昵称缺失 → 不许 ok，原因要说清在等什么', () => {
  const v = pushFrameVerdict({ identity: `douyin:${PEER}`, name: '', convId: CONV, selfUidCount: 1 });
  assert.equal(v.ok, false, '昵称缺失不能放行（channelId 按名字拼，发不出去）');
  assert.equal(v.reason, 'noName');
  assert.equal(v.stat, 'droppedNoName');
  assert.match(v.message, /昵称/, `说明要讲人话：${v.message}`);
  assert.ok(v.message.includes(PEER), '要带上 identity，否则不知道该等谁');
});

test('两条都齐 → 放行，并把名字带出来', () => {
  const v = pushFrameVerdict({ identity: `douyin:${PEER}`, name: '主人', convId: CONV, selfUidCount: 1 });
  assert.equal(v.ok, true);
  assert.equal(v.name, '主人');
});

test('空白字符串也算缺失（别让 " " 蒙过去）', () => {
  assert.equal(pushFrameVerdict({ identity: '   ', name: '主人' }).ok, false);
  assert.equal(pushFrameVerdict({ identity: `douyin:${PEER}`, name: '  ' }).ok, false);
});

// ── ② 接线：真 channel 上，丢弃真的会记账 + 告警，且不刷屏 ────────────────
function makeChannel(logs = []) {
  return new DouyinChannel({
    db,
    host: {
      running: true,
      loggedIn: true,
      exclusive: async (_l, fn) => await fn(),
      // events 为空 = drainPushFrames 返回 []，这里直接手工驱动 pushStats
      browser: { events: [], eval: async () => [] },
    },
    getConfig: () => ({ enabled: true }),
    log: (level, msg) => logs.push({ level, msg }),
    onMessage: async () => ({ queued: true }),
    driver: { checkLogin: async () => true, list: async () => ({ ok: true, conversations: [] }) },
    pollRangeMs: [1000, 2000],
  });
}

test('notePushDrop 按原因节流：同一原因 10 分钟内只喊一次，计数照实累加', () => {
  const logs = [];
  const ch = makeChannel(logs);
  ch.pushStats = { runs: 0, frames: 0, stored: 0, droppedNoIdentity: 0, droppedNoName: 0 };

  // 模拟 20 条同因丢包
  for (let i = 0; i < 20; i++) {
    const v = pushFrameVerdict({ identity: '', name: '', convId: CONV, selfUidCount: 0 });
    ch.pushStats[v.stat] += 1;
    ch.notePushDrop(v.reason, v.message);
  }

  assert.equal(ch.pushStats.droppedNoIdentity, 20, '计数必须准（20 条都算）');
  const warns = logs.filter((l) => /身份|自己是谁/.test(l.msg));
  assert.equal(warns.length, 1, `同因丢包只能喊一次，实际 ${warns.length} 次`);
});

test('status() 要把学到的 selfUid 交出来（否则新用户不知道该填什么）', () => {
  // 「主人身份」是唯一要手填的东西，而新用户装好时没有任何途径知道自己的数字 uid。
  // 插件其实能从任意一条私信学到自己是谁（learnSelfUid），但以前 status() 只给
  // 一个布尔 knowsSelfUid，用户看不到那串数字 ⇒ 设置页那句提示是空话。
  const ch = makeChannel([]);
  db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('douyin.selfUid',?)").run(JSON.stringify(SELF));

  const st = ch.status();
  assert.equal(st.identityState.knowsSelfUid, true);
  assert.deepEqual(st.identityState.selfUids, [SELF],
    `status 必须带出 uid 本身，实际 identityState=${JSON.stringify(st.identityState)}`);
});

test('masterUid 不填也能正常回复（跟 B站 一致：主人身份是可选的）', async () => {
  // 兄弟项目（QQ / B站）都是「连上自动拿自己的 uid，主人 UID 只影响主动私信」。
  // 抖音以前把 masterUid 做成必需，于是有个循环依赖：
  //   认主人要 masterUid → 而 person.master.douyin_uid 只有认得出主人才写入
  //   → 新用户永远卡在「先填一个你拿不到的 uid」。
  //
  // 判据：replyAll 开着时，masterUid 留空也必须照常交给模型。
  const { mediaMethods } = await import('../lib/gateway-media.js');
  const enqueued = [];
  const gw = Object.assign(Object.create(mediaMethods), {
    db,
    stopped: false,
    douyin: { connected: true },
    douyinConfig: () => ({
      enabled: true, autoReply: true,
      masterUid: '',              // ← 关键：不填
      allowList: [], replyAll: true, replyWindowMinutes: 10,
    }),
    isPaused: () => false,
    markSeen: () => true,
    resolveDouyinPerson: () => ({ canonical_id: 'stranger', display_name: '路人' }),
    note: () => {},
    enqueue: (m) => enqueued.push(m),
    soul: { memorizeUnanswered: () => {} },
  });

  const r = await gw.onDouyinMessage({
    channelId: `douyin:路人`, chatType: 'private',
    userId: `douyin:${PEER}`,           // 身份键合法（会话 ID 推出来的）
    nickname: '路人', peerName: '路人',
    messageId: 'm-no-master-1', text: '在吗',
    timeMs: Date.now(), convId: CONV,
  });

  assert.equal(r.queued, true, `masterUid 为空也必须照常处理，实际返回 ${JSON.stringify(r)}`);
  assert.equal(enqueued.length, 1, '必须真的排进模型那一轮');
});

test('两种原因各喊各的（节流按原因分，不是全局）', () => {
  const logs = [];
  const ch = makeChannel(logs);
  ch.pushStats = { runs: 0, frames: 0, stored: 0, droppedNoIdentity: 0, droppedNoName: 0 };

  const a = pushFrameVerdict({ identity: '', name: '', convId: CONV, selfUidCount: 0 });
  const b = pushFrameVerdict({ identity: `douyin:${PEER}`, name: '', convId: CONV, selfUidCount: 1 });
  ch.notePushDrop(a.reason, a.message);
  ch.notePushDrop(b.reason, b.message);

  assert.equal(logs.length, 2, `两种原因都要能看见，实际 ${JSON.stringify(logs.map((l) => l.msg))}`);
});

// ── ③ #78：动态角标要能说出「没组装记忆」是哪一种 ──────────────────────────
test('note() 要把 recallMiss 透出去（否则界面只能猜三种可能）', async () => {
  // 用户报「25 条全是没组装记忆」，而界面那句「会话没登记 / 认人失败 / 没走我们的上下文」
  // 把三种完全不同的原因混成一句话，等于没法排查。
  const { ChatGateway } = await import('../lib/gateway.js');
  const gw = Object.create(ChatGateway.prototype);
  gw.decisions = [];
  gw.titleOf = () => 'QQ·测试';

  gw.note('sent', { channelId: 'private:1', text: '嗯', recallAt: 0, recallMiss: 'notMounted' });
  assert.equal(gw.decisions[0].recallMiss, 'notMounted', `没挂上要带原因，实际 ${JSON.stringify(gw.decisions[0])}`);

  gw.decisions = [];
  gw.note('sent', { channelId: 'private:1', text: '嗯', recallAt: 0, recallMiss: 'noSession' });
  assert.equal(gw.decisions[0].recallMiss, 'noSession');

  // 跑过的那一轮不该带 miss（否则界面会同时显示「想起 N」和「没跑」）
  gw.decisions = [];
  gw.note('sent', { channelId: 'private:1', text: '嗯', recallAt: Date.now(), recallMiss: 'noSession' });
  assert.equal(gw.decisions[0].recallMiss, undefined, '跑过的轮次不该带 recallMiss');
  assert.ok(gw.decisions[0].recallAt > 0);
});
