import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DouyinChannel } from '../lib/channels/douyin.js';
import { setKv, getKv } from '../lib/db.js';
import { mergeMessages } from '../lib/channels/vendor/douyin-bridge/media.mjs';

// 接口快照陈旧时，对方的新话只存在于 DOM 里：readDM 的接口路先返回旧缓存（needsPageRead），
// DOM 路补进来的文本消息没有 senderId / convId，fromMe 靠气泡的 isFromMe 算出。
// 这里按 DOM 路真实产出的形状造消息，并经过真实的 mergeMessages，走真的 readConversation。
const SELF = '900000000000000001';
const PEER = '900000000000000002';
const CONV = `0:1:${SELF}:${PEER}`;
const GROUP_CONV = '900000000000000011:900000000000000012:0';
const MEMBER = '900000000000000031';

const T0 = 1700000000000;

/** 接口路（protobuf）消息：自带 convId + senderId。 */
const apiMsg = (seq, text, extra = {}) => ({ convId: CONV, senderId: PEER, fromMe: false, seq, text, time: T0, ...extra });

/** DOM 路消息：没有 convId / senderId，只有气泡上的 isFromMe 与反解出的时间。 */
const domMsg = (text, { fromMe = false, time = T0 + 60_000, type = 'text', senderName = '测试联系人' } = {}) => (
  { fromMe, type, text, senderName, time, media: {} });

function world({ read, groupNames = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  setKv(db, 'douyin.selfUid', SELF);
  const logs = [];
  const ch = new DouyinChannel({
    db, host: {}, getConfig: () => ({ groups: groupNames }), log: (_level, message) => logs.push(String(message)),
    driver: { read: read ?? (async () => ({ ok: true, convId: CONV, messages: [] })) },
    onMessage: async () => ({ queued: true }),
  });
  return { db, ch, logs };
}

const readArgs = (key, st = null) => ({ c: { time: '' }, name: '测试联系人', key, st, sig: 'new', unread: true });

test('接口快照陈旧：DOM 补进来的单聊纯文本能入库，不被无 senderId 拒掉', async () => {
  // 接口路只有一条旧消息；对方新说的那句只在 DOM 里。
  const messages = mergeMessages([apiMsg('1', '旧的那句')], [domMsg('旧的那句', { time: T0 }), domMsg('接口没拿到的新话')]);
  assert.equal(messages.filter((m) => m.text === '接口没拿到的新话').length, 1, '夹具前提：DOM 那句确实没被合并掉');
  assert.equal(messages.find((m) => m.text === '接口没拿到的新话').senderId, undefined, '夹具前提：DOM 文本没有 senderId');

  const { db, ch } = world({ read: async () => ({ ok: true, convId: CONV, messages, needsPageRead: true }) });
  try {
    await ch.readConversation(readArgs('dom-single'));
    const rows = db.prepare("SELECT payload FROM douyin_inbox WHERE channel_id='douyin:测试联系人' ORDER BY id").all();
    const texts = rows.map((r) => JSON.parse(r.payload).text);
    assert.ok(texts.includes('接口没拿到的新话'), `DOM 补进来的单聊文本要能入库，实际：${JSON.stringify(texts)}`);
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      assert.equal(p.userId, `douyin:${PEER}`, '身份仍来自已验证的会话 ID');
      assert.equal(p.chatType, 'private');
    }
    assert.equal(ch.readFailCount('dom-single'), 0, '这条不该按读失败记账');
  } finally { db.close(); }
});

test('整批都只在 DOM 里：单聊纯文本同样放行，游标推进', async () => {
  const { db, ch } = world({ read: async () => ({ ok: true, convId: CONV, messages: [domMsg('只在页面上的话')], needsPageRead: true }) });
  try {
    await ch.readConversation(readArgs('dom-only'));
    const rows = db.prepare("SELECT payload FROM douyin_inbox WHERE channel_id='douyin:测试联系人'").all();
    assert.deepEqual(rows.map((r) => JSON.parse(r.payload).text), ['只在页面上的话']);
    const cursor = getKv(db, 'dom-only', null);
    assert.equal(cursor.identity, `douyin:${PEER}`, '游标带着已验证的会话身份');
    assert.equal(cursor.needsPageRead, true, '页面待读标记照常交接');
    assert.equal(ch.readFailCount('dom-only'), 0);
  } finally { db.close(); }
});

test('纵深闸保留：单聊里无 senderId 的自己气泡、未知归属、第三方 sender 仍被拒', async () => {
  const messages = mergeMessages([apiMsg('1', '旧的那句')], [
    domMsg('旧的那句', { time: T0 }),
    domMsg('我发的', { fromMe: true }),
    { ...domMsg('不知道谁发的'), fromMe: null },
    domMsg('对方的话'),
  ]);
  // 接口路自带 senderId 的消息：第三方 uid 不属于本会话，必须丢弃
  messages.push({ convId: CONV, senderId: '900000000000000099', fromMe: false, seq: '2', text: '第三方的消息', time: T0 + 30_000 });
  const { db, ch } = world({ read: async () => ({ ok: true, convId: CONV, messages, needsPageRead: true }) });
  try {
    await ch.readConversation(readArgs('dom-gate'));
    const texts = db.prepare("SELECT payload FROM douyin_inbox WHERE channel_id='douyin:测试联系人'").all().map((r) => JSON.parse(r.payload).text);
    assert.equal(texts.includes('我发的'), false, '自己发的不能当作对方消息');
    assert.equal(texts.includes('不知道谁发的'), false, 'fromMe 未知且无 sender：归属不明，不放行');
    assert.equal(texts.includes('第三方的消息'), false, '第三方 sender 不属于本会话');
    assert.equal(texts.includes('对方的话'), true);
  } finally { db.close(); }
});

test('群聊反例：无 senderId 的纯文本仍被拒，不借单聊这条放行', async () => {
  // 群会话：接口路给了一条带 sender 的消息，DOM 补进来的纯文本没有 senderId。
  // 群里发言人必须能对上，不能靠「convId 已验证 + fromMe=false」混进来。
  const messages = mergeMessages([
    { convId: GROUP_CONV, convType: 2, senderId: MEMBER, senderName: '测试群友', fromMe: false, seq: '1', text: '群里的旧话', time: T0 },
  ], [domMsg('群里的旧话', { time: T0, senderName: '测试群友' }), domMsg('没有发送者的群消息', { senderName: '' })]);
  assert.equal(messages.find((m) => m.text === '没有发送者的群消息').senderId, undefined, '夹具前提：这条没有 senderId');

  const { db, ch } = world({ groupNames: ['测试群'], read: async () => ({ ok: true, convId: GROUP_CONV, messages, needsPageRead: true }) });
  try {
    await ch.readConversation({ c: { time: '' }, name: '测试群', key: 'dom-group', st: null, sig: 'new', unread: true });
    const texts = db.prepare("SELECT payload FROM douyin_inbox WHERE channel_id='douyin-group:测试群'").all().map((r) => JSON.parse(r.payload).text);
    assert.equal(texts.includes('没有发送者的群消息'), false, '群聊里无 senderId 的文本不能入库');
    assert.equal(texts.includes('群里的旧话'), true, '带 sender 的群消息照常入库');
  } finally { db.close(); }
});

test('放行只针对文本：单聊里无 senderId 的非文本不走这条，仍由既有媒体分支处理', async () => {
  // 非文本（语音 / 图片 / 表情）无 senderId 时，由上面既有的媒体分支放行，不借本 PR 这条文本放行。
  // 这条用例钉住「文本放行」的作用范围：把它扩到非文本也不会改变这里的入库结果。
  const { db, ch } = world({ read: async () => ({ ok: true, convId: CONV, messages: [
    { fromMe: false, type: 'voice', text: '', time: T0, media: { seconds: 3 } },
  ], needsPageRead: true }) });
  try {
    await ch.readConversation(readArgs('dom-nontext'));
    const rows = db.prepare("SELECT payload FROM douyin_inbox WHERE channel_id='douyin:测试联系人'").all();
    assert.equal(rows.length, 1, '非文本无 sender 由既有媒体分支放行，行为与本 PR 无关');
    assert.equal(JSON.parse(rows[0].payload).userId, `douyin:${PEER}`);
  } finally { db.close(); }
});

test('群聊里连昵称都没有的无 sender 文本也不入库', async () => {
  const { db, ch } = world({ groupNames: ['测试群'], read: async () => ({ ok: true, convId: GROUP_CONV, messages: [domMsg('完全认不出是谁', { senderName: '' })], needsPageRead: true }) });
  try {
    await ch.readConversation({ c: { time: '' }, name: '测试群', key: 'dom-group-bare', st: null, sig: 'new', unread: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM douyin_inbox WHERE channel_id='douyin-group:测试群'").get().n, 0);
  } finally { db.close(); }
});
