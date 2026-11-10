import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpHome } from './_tmp.mjs';

// 🔴 收尾的边界 / 死分支 / 未处理拒绝。
//
//  ① `newFrom` 同指纹连发：对方连发两句一模一样的话，第二句被当成「已读过」
//     → 真机里很常见（「在吗」「在吗」「在吗」），后面两句全收不到
//  ② `selfSecUid` 是死分支：字段从来没被赋过值，那段永远是空
//  ③ 定时器 / 裸 `void` 的 async 没 catch：没有全局 unhandledRejection 兜底 = 进程退出

process.env.DSH_HOME = tmpHome('leftover-');
const keepAlive = setInterval(() => {}, 1000); // 钉住事件循环（CI 4 vCPU 抢满时防止提前结束）

const { newFrom } = await import('../lib/channels/douyin.js');
const { openDatabase, setKv, getKv } = await import('../lib/db.js');
const db = openDatabase();

// ── ① newFrom 连发 ──────────────────────────────────────────────────────────
test('对方连发同一句话：第二句必须算新消息（不能当已读）', () => {
  assert.equal(newFrom(['在'], ['在', '在']), 1, 'prev 一条、cur 两条 → 新的从下标 1 开始');
  assert.equal(newFrom(['在', '在'], ['在', '在', '在']), 2, 'prev 两条、cur 三条 → 新的从下标 2 开始');
});

test('连发之后真的没有新消息时，仍然返回 cur.length', () => {
  assert.equal(newFrom(['在', '在', '在'], ['在', '在', '在']), 3, '一模一样的三条 = 没有新的');
  assert.equal(newFrom(['在', '在'], ['在', '在']), 2, '一模一样的两条 = 没有新的');
});

test('连发 + 后面跟一句新话', () => {
  assert.equal(newFrom(['在', '在'], ['在', '在', '在', '好']), 2, '第三条「在」和「好」都是新的');
});

test('普通路径不能被改坏（回归）', () => {
  assert.equal(newFrom(['a', 'b'], ['a', 'b', 'c']), 2, '普通新增');
  assert.equal(newFrom(['a', 'b'], ['c', 'd']), 0, '全是新的');
  assert.equal(newFrom(['a', 'b'], ['x', 'y', 'z']), 0, '窗口滚走');
  assert.equal(newFrom([], ['a', 'b']), 0, '第一次读');
  assert.equal(newFrom(['a', 'b', 'c'], ['b', 'c', 'd']), 2, '尾部两条对齐');
});

// ── ② selfSecUid 死分支 ─────────────────────────────────────────────────────
test('sec_uid 从 kv 读得到（不再是永不赋值的死字段）', async () => {
  const { DouyinChannel } = await import('../lib/channels/douyin.js');
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true }, getConfig: () => ({ enabled: true }),
    log: () => {}, onMessage: async () => ({ queued: true }),
    driver: { checkLogin: async () => true, list: async () => ({ ok: true, conversations: [] }) },
  });
  setKv(db, 'douyin.selfUid', '');
  setKv(db, 'douyin.selfSecUid', 'MS4wLjABAAAAtest');
  assert.deepEqual(ch.selfUids(), ['MS4wLjABAAAAtest'], 'sec_uid 要能被 selfUids 用上');

  // 数字 uid 优先，且同一个值不重复出现
  setKv(db, 'douyin.selfUid', '900001');
  assert.deepEqual(ch.selfUids(), ['900001', 'MS4wLjABAAAAtest'], '数字 uid 在前，sec_uid 补充');

  setKv(db, 'douyin.selfSecUid', '900001');
  assert.deepEqual(ch.selfUids(), ['900001'], '两个来源同一个值时不重复');
});

test('两个都空时 selfUids 为空（上层据此拒绝处理，不猜）', async () => {
  const { DouyinChannel } = await import('../lib/channels/douyin.js');
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true }, getConfig: () => ({ enabled: true }),
    log: () => {}, onMessage: async () => ({ queued: true }),
    driver: { checkLogin: async () => true, list: async () => ({ ok: true, conversations: [] }) },
  });
  setKv(db, 'douyin.selfUid', '');
  setKv(db, 'douyin.selfSecUid', '');
  assert.deepEqual(ch.selfUids(), []);
  assert.equal(ch.identityReady(), false, '不知道我是谁就不能处理');
});

// ── ③ 定时器 catch ──────────────────────────────────────────────────────────
test('retrieval 定时器：tick 抛错不会变成未处理拒绝', async () => {
  const { VectorWorker } = await import('../lib/retrieval.js');
  const w = Object.create(VectorWorker.prototype);
  w.timer = null;
  w.log = () => {};
  w.tick = async () => { throw new Error('索引炸了'); };
  // start 之后手动触发一次回调（不真等 500ms）
  const realSetInterval = globalThis.setInterval;
  let cb = null;
  globalThis.setInterval = (fn) => { cb = fn; return { unref() {} }; };
  try {
    w.start();
    assert.ok(cb !== null, 'start 要挂上定时器');
    assert.doesNotThrow(() => cb(), '回调本身不能同步抛');
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test('soul-memory 定时器：check 抛错不会变成未处理拒绝', async () => {
  const { ChatDigester } = await import('../lib/soul-memory.js');
  const d = Object.create(ChatDigester.prototype);
  d.timer = null;
  d.log = () => {};
  d.check = async () => { throw new Error('整理炸了'); };
  const realSetInterval = globalThis.setInterval;
  let cb = null;
  globalThis.setInterval = (fn) => { cb = fn; return { unref() {} }; };
  try {
    d.start();
    assert.doesNotThrow(() => cb(), '回调本身不能同步抛');
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});

test('推送帧的消息 fromMe 是 null 时也能学到自己的 uid', async () => {
  const { DouyinChannel } = await import('../lib/channels/douyin.js');
  const { conversationIdentity } = await import('../lib/douyin-conversation.js');
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true }, getConfig: () => ({ enabled: true }),
    log: () => {}, onMessage: async () => ({ queued: true }),
    driver: { checkLogin: async () => true, list: async () => ({ ok: true, conversations: [] }) },
  });
  setKv(db, 'douyin.selfUid', '');
  const convId = '0:1:2874562949425280:7702399256389125169';
  // 推送帧解出来的形状：fromMe 是 null（帧里没有 sec_uid 可比对），senderId 是会话一侧
  ch.learnSelfUid(convId, [{ convId, senderId: '7702399256389125169', fromMe: null, text: '在吗' }]);
  assert.equal(getKv(db, 'douyin.selfUid', ''), '2874562949425280', '另一侧就是我');
  assert.equal(conversationIdentity(convId, ch.selfUids()), 'douyin:7702399256389125169', '推出对方身份');
});

test.after(() => { clearInterval(keepAlive); db.close(); });
console.log('leftover ok');
