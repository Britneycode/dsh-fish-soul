import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createHash } from 'node:crypto';
import { tmpHome } from './_tmp.mjs';

// 🔴 抖音私信「一条之后全哑 + 回复发不出去 + 图片收不到」的回归测试。
//
// 三个真机级缺陷，都是「看起来在跑、实际没生效」那一类：
//
//  ① 收件箱契约：`onDouyinMessage` 只返回 `{review}`，而 `drainInbox` 要求
//     `{queued}` / `{done}`，否则标 unknown。`next()` 里一条 unknown 会挡住
//     同会话**后面所有**消息 → 第一条之后整个会话哑掉。
//  ② 出站被掐：`sendReply` 里 `platformOf(...)==='douyin' → return false` 恒真，
//     抖音回复永远发不出去；而且它下面用到的 `convId` 声明在函数后半段（TDZ）。
//  ③ 媒体被丢：DOM 路补的图片/表情没有 convId/senderId，被身份过滤一律滤掉。

process.env.DSH_HOME = tmpHome('douyin-inbox-contract-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinChannel, isGroupConversation } = await import('../lib/channels/douyin.js');
const { mediaMethods } = await import('../lib/gateway-media.js');

const db = openDatabase();
// 建表是懒的（DouyinInbox 构造时才 CREATE TABLE）：先初始化一次，后面才能直接 DELETE
const { DouyinInbox } = await import('../lib/douyin-inbox.js');
new DouyinInbox(db).status();

const SELF = '900001';
const PEER = '7702399256389125000';
const CONV = `0:1:${SELF}:${PEER}`;
const keyOf = (name) => `douyin.conv.${createHash('sha1').update(String(name)).digest('hex').slice(0, 16)}`;

/** 造一个真实 DouyinChannel，onMessage 用真实网关方法（不是手写 mock）。 */
function makeChannel(messages, gwOverrides = {}) {
  const gw = Object.assign(Object.create(mediaMethods), {
    db, stopped: false,
    douyin: { connected: true },
    douyinConfig: () => ({ enabled: true, autoReply: true, masterUid: `douyin:${PEER}`, allowList: [], replyAll: true, replyWindowMinutes: 10 }),
    isPaused: () => false, markSeen: () => true,
    resolveDouyinPerson: () => ({ canonical_id: 'master' }),
    note: () => {}, enqueue: () => {},
    soul: { memorizeUnanswered: () => {} },
    ...gwOverrides,
  });
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {},
    onMessage: (m) => gw.onDouyinMessage(m),
    driver: {
      checkLogin: async () => true,
      list: async () => ({ ok: true, conversations: [] }),
      read: async () => ({ ok: true, convId: CONV, messages }),
    },
    pollRangeMs: [1000, 2000],
  });
  return ch;
}

// ── ① 收件箱契约 ────────────────────────────────────────────────────────────
test('onDouyinMessage 交给模型时必须返回 queued（否则标 unknown 挡住后续）', async () => {
  const gw = Object.assign(Object.create(mediaMethods), {
    db, stopped: false, douyin: { connected: true },
    douyinConfig: () => ({ enabled: true, autoReply: true, masterUid: `douyin:${PEER}`, allowList: [], replyAll: true, replyWindowMinutes: 10 }),
    isPaused: () => false, markSeen: () => true,
    resolveDouyinPerson: () => ({ canonical_id: 'master' }),
    note: () => {}, enqueue: () => {}, soul: { memorizeUnanswered: () => {} },
  });
  const m = { channelId: `douyin:未云`, userId: `douyin:${PEER}`, nickname: '未云', text: '在吗', messageId: 's1', timeMs: Date.now(), convId: CONV };
  const r = await gw.onDouyinMessage(m);
  assert.equal(r?.queued, true, '交给模型必须返回 queued，结算由 turn/end 回写');
});

test('三条消息全部进入 processing，没有 unknown（不再一条之后全哑）', async () => {
  db.exec('DELETE FROM douyin_inbox');
  const ch = makeChannel([1, 2, 3].map((i) => ({ fromMe: false, senderId: PEER, convId: CONV, type: 'text', text: `消息${i}`, time: Date.now() + i })));
  await ch.readConversation({ c: {}, name: '未云', key: keyOf('未云'), st: null, sig: 'x', unread: true });

  const rows = db.prepare('SELECT status FROM douyin_inbox ORDER BY id').all();
  assert.equal(rows.length, 3, '三条都入库');
  assert.equal(rows.filter((r) => r.status === 'unknown').length, 0, '不能有 unknown（它会挡住同会话后续）');
  assert.equal(rows.filter((r) => r.status === 'processing').length, 3, '三条都该等 turn/end 回写');
});

test('超过时限的旧消息标 done（不是 unknown），不挡同会话后续消息', async () => {
  db.exec('DELETE FROM douyin_inbox');
  // 一条 1 小时前的旧消息 + 一条刚到的：旧的会被判 stale 只记不回。
  // 2026-11-11 真机：重启后积压旧消息条条超时限 → 条条落 unknown → 每条都挡住
  // 下一条，新消息进得来但永远轮不到处理，连 dismiss 六条才放行。
  const old = Date.now() - 60 * 60 * 1000;
  const ch = makeChannel([
    { fromMe: false, senderId: PEER, convId: CONV, type: 'text', text: '旧消息', time: old },
    { fromMe: false, senderId: PEER, convId: CONV, type: 'text', text: '新消息', time: Date.now() },
  ]);
  await ch.readConversation({ c: {}, name: '未云', key: keyOf('未云'), st: null, sig: 'x', unread: true });

  const rows = db.prepare('SELECT status FROM douyin_inbox ORDER BY id').all();
  assert.equal(rows.length, 2, '两条都入库');
  assert.equal(rows[0].status, 'done', '超时限旧消息是「确定不处理」，标 done 不标 unknown');
  assert.equal(rows[1].status, 'processing', '新消息没被挡住，正常交给模型等回写');
});

// ── ② 出站 ──────────────────────────────────────────────────────────────────
test('抖音回合的回复要真的发出去（不能无条件早退）', async () => {
  const { ChatGateway } = await import('../lib/gateway.js');
  let douyinCalls = 0;
  const gw = Object.create(ChatGateway.prototype);
  Object.assign(gw, {
    db, log: () => {}, stopped: false,
    douyin: { connected: true }, bili: null,
    bound: new Map([['s', { channel_id: `douyin:未云`, title: '抖音·未云', workspace_path: 'D:/tmp' }]]),
    outbox: { hasQueued: () => false, enqueue: () => {} },
    recentSent: new Map(), turnMood: new Map(), interjectTurns: new Map(),
    paused: new Set(), stickers: null, replyTarget: () => 'source',
    douyinConfig: () => ({ masterUid: `douyin:${PEER}`, masterName: '未云', enabled: true }),
    biliConfig: () => ({}), voiceConfig: () => ({ enabled: false }), embeddingModel: () => ({}),
    moodOf: () => ({ delay: 1 }), moodPick: (_p, t) => t, cleanOut: (t) => t,
    firstDelay: () => 0, sleep: async () => {}, random: () => 0.5,
    soul: { recallInfo: () => ({ memories: [], at: 0, unknown: false }), journalOut: () => {} },
    note: () => {}, dmImages: async () => [], relayDmVoice: async (t) => String(t ?? ''),
    sendDouyin: async (_row, _text, _imgs, conv) => { douyinCalls++; return conv ? { ok: true, delivered: true } : { ok: false, delivered: false, error: '缺 convId' }; },
  });
  const st = { channelId: `douyin:未云`, convId: CONV, text: '这是她的回复', images: [], messageIds: [], inboxIds: [] };
  const r = await gw.sendReply('s', st);
  assert.equal(r, true, '抖音回复要成功');
  assert.equal(douyinCalls, 1, 'sendDouyin 必须真的被调用（原来这里被早退拦死）');
});

test('抖音内容不能借 QQ 通道泄露（隔离闸仍然有效）', async () => {
  const { ChatGateway } = await import('../lib/gateway.js');
  let qqCalls = 0;
  const gw = Object.create(ChatGateway.prototype);
  Object.assign(gw, {
    db, log: () => {}, stopped: false,
    douyin: { connected: true }, bili: null,
    // 会话绑定的是 QQ，但这一轮来自抖音 → 设置页选了「一律回 QQ」时才会走到这
    bound: new Map([['s', { channel_id: 'qq:12345', title: 'QQ', workspace_path: 'D:/tmp' }]]),
    outbox: { hasQueued: () => false, enqueue: () => {} },
    recentSent: new Map(), turnMood: new Map(), interjectTurns: new Map(),
    paused: new Set(), stickers: null, replyTarget: () => 'qq',
    douyinConfig: () => ({ masterUid: `douyin:${PEER}`, masterName: '未云', enabled: true }),
    biliConfig: () => ({}), voiceConfig: () => ({ enabled: false }), embeddingModel: () => ({}),
    moodOf: () => ({ delay: 1 }), moodPick: (_p, t) => t, cleanOut: (t) => t,
    firstDelay: () => 0, sleep: async () => {}, random: () => 0.5,
    soul: { recallInfo: () => ({ memories: [], at: 0, unknown: false }), journalOut: () => {} },
    note: () => {}, dmImages: async () => [], relayDmVoice: async (t) => String(t ?? ''),
    channel: { send: async () => { qqCalls++; return 'mid'; } },
    sendDouyin: async () => ({ ok: true, delivered: true }),
  });
  const st = { channelId: `douyin:未云`, convId: CONV, text: '抖音内容', images: [], messageIds: [], inboxIds: [] };
  const r = await gw.sendReply('s', st);
  assert.equal(r, false, '抖音回合不能借 QQ 通道发出去');
  assert.equal(qqCalls, 0, '一条都不能发到 QQ');
});

// ── ③ 媒体消息 ──────────────────────────────────────────────────────────────
test('DOM 路补的图片 / 表情要能进来（它们没有 convId / senderId）', async () => {
  db.exec('DELETE FROM douyin_inbox');
  const ch = makeChannel([
    { fromMe: false, senderId: PEER, convId: CONV, type: 'text', text: '你好', time: Date.now() },
    { fromMe: false, type: 'image', text: '', media: { data: 'https://p3.douyinpic.com/a.jpg' }, senderName: '未云', y: 100 },
    { fromMe: false, type: 'emoji', text: '', media: { name: '比心', data: 'https://p3.douyinpic.com/e.png' }, senderName: '未云', y: 200 },
  ]);
  await ch.readConversation({ c: {}, name: '未云', key: keyOf('未云'), st: null, sig: 'x', unread: true });

  const rows = db.prepare('SELECT payload FROM douyin_inbox ORDER BY id').all().map((r) => JSON.parse(r.payload));
  assert.ok(rows.some((m) => m.images?.some((i) => String(i.url).includes('.jpg'))), '图片要进来');
  assert.ok(rows.some((m) => m.images?.some((i) => i.sticker === true)), '表情要进来');
});

test('别的会话的消息不能混进来（串会话 / 冒充防护）', async () => {
  db.exec('DELETE FROM douyin_inbox');
  const ch = makeChannel([
    { fromMe: false, senderId: PEER, convId: CONV, type: 'text', text: '你好', time: Date.now() },
    // 自带身份，但属于**另一个**会话 —— senderBelongsToConversation 单独挡不住
    { fromMe: false, senderId: '888888888888888888', convId: `0:1:${SELF}:888888888888888888`, type: 'text', text: '我是骗子', time: Date.now() },
  ]);
  await ch.readConversation({ c: {}, name: '未云', key: keyOf('未云'), st: null, sig: 'x', unread: true });

  const rows = db.prepare('SELECT payload FROM douyin_inbox ORDER BY id').all().map((r) => JSON.parse(r.payload));
  assert.ok(!rows.some((m) => String(m.text ?? '').includes('骗子')), '别的会话的消息不能入库');
});

// ── 判群 ────────────────────────────────────────────────────────────────────
test('单聊不会被昵称误判成群（DOM 媒体消息只有 senderName）', () => {
  const msgs = [
    { fromMe: false, senderId: PEER, convId: CONV, type: 'text', text: '你好' },
    { fromMe: false, type: 'image', text: '', senderName: '未云' },
  ];
  assert.equal(isGroupConversation(msgs, { name: '未云', groups: [] }), false, '同一个人 + 他的昵称不能被数成两个 peer');
  // 真的两个人还是要判成群
  const realGroup = [
    { fromMe: false, senderId: '111', type: 'text', text: 'a' },
    { fromMe: false, senderId: '222', type: 'text', text: 'b' },
  ];
  assert.equal(isGroupConversation(realGroup, { name: '某群', groups: [] }), true, '两个不同的人仍判成群');
});

test.after(() => db.close());
console.log('douyin-inbox-contract ok');
