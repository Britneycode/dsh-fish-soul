import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheMessages, clearCache, pickMessages } from '../lib/channels/vendor/douyin-bridge/douyin-api.mjs';
import { readDMViaApi, readDM } from '../lib/channels/vendor/douyin-bridge/douyin-dm.mjs';
import { DatabaseSync } from 'node:sqlite';
import { DouyinChannel } from '../lib/channels/douyin.js';
import { setKv, getKv } from '../lib/db.js';
import { conversationIdentity } from '../lib/douyin-conversation.js';
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs';
import { mediaMethods } from '../lib/gateway-media.js';

const convId = '0:1:100001:200002';
test('旧收件表重放自身消息，在认人和交给模型前结束', async () => {
  const result = await mediaMethods.onDouyinMessage.call({ stopped: false,
    douyin: { selfUids: () => ['100001'] },
    douyinConfig: () => { throw new Error('自身回声不应进入认人和回复流程'); },
  }, { senderId: '100001' });
  assert.deepEqual(result, { done: true, review: '自身消息，不回复' });
});
test('页面加载的其他事件不能挤掉初始化私信响应及完成状态', () => {
  const b = new Browser({});
  const emit = (method, params = {}) => b.handleMessage({ data: JSON.stringify({ method, params }) });
  emit('Network.responseReceived', { requestId: 'init', response: { url: 'https://imapi.douyin.com/v1/message/get_message_by_init', status: 200 } });
  emit('Network.loadingFinished', { requestId: 'init' });
  for (let i = 0; i < 1000; i++) emit('Page.test');
  const hits = b.imResponses(/get_message_by_init/, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].finished, true);
});
function browser() {
  return {
    events: [], imResponses: () => [],
    goto: async () => { throw new Error('已有目标会话新缓存，不应重新导航'); },
    eval: async (script) => {
      if (script.startsWith('Boolean(window.__dyIM')) return true;
      if (script.includes('__dyIM')) return [];
      if (script.includes('localStorage')) return {};
      throw new Error('需要重新读取页面');
    },
  };
}
function seed(at = Date.now(), id = convId) {
  clearCache();
  cacheMessages(convId, [{ convId: id, senderId: '200002', senderName: '', text: '测试消息', seq: '1' }], { at });
}
function response(id, text, { time = 0, count = 1, senderId = '200002' } = {}) {
  const v = (n) => { n = BigInt(n); const b = []; while (n >= 128n) { b.push(Number(n & 127n) | 128); n >>= 7n; } b.push(Number(n)); return Buffer.from(b); };
  const field = (id, n) => Buffer.concat([v(id * 8), v(n)]);
  const bytes = (id, b) => Buffer.concat([v(id * 8 + 2), v(b.length), b]);
  const m = Buffer.concat([bytes(1, Buffer.from(id)), field(2, 1), field(6, 7), field(7, senderId), bytes(8, Buffer.from(JSON.stringify({ text }))), field(10, time), field(17, 1)]);
  return { kind: 'pb', url: 'https://imapi.douyin.com/v1/message/get_by_conversation', b64: bytes(6, bytes(301, Buffer.concat(Array.from({ length: count }, () => bytes(1, m))))).toString('base64') };
}
test('同会话较多的旧历史不能覆盖较少的新消息，响应先后顺序不影响结果', async () => {
  const old = response(convId, '旧历史', { time: 1700000000000, count: 4 });
  const fresh = response(convId, '新的测试消息', { time: 1700000060000 });
  for (const captures of [[fresh, old], [old, fresh]]) {
    clearCache();
    const b = browser(); const fallback = b.eval;
    b.eval = async (script) => script.includes('__dyIM.drain()') ? captures : fallback(script);
    const result = await readDMViaApi({ browser: b, expectConvId: convId });
    assert.deepEqual(result.messages.map(m => m.text), ['新的测试消息']);
  }
  clearCache();
});
test('同一轮同一会话的多份响应要合并，不能只留下最后一条新消息', async () => {
  clearCache();
  const first = response(convId, '先到的新消息', { time: 1700000060000 });
  const second = response(convId, '后到的新消息', { time: 1700000120000 });
  const b = browser();
  const fallback = b.eval;
  b.eval = async (script) => script.includes('__dyIM.drain()')
    ? [first, second]
    : fallback(script);
  const result = await readDMViaApi({ browser: b, expectConvId: convId });
  assert.deepEqual(result.messages.map((m) => m.text), ['先到的新消息', '后到的新消息']);
  clearCache();
});
test('抓到多个会话的响应时只读取指定会话', async () => {
  clearCache();
  const b = browser();
  const fallback = b.eval;
  b.eval = async (script) => script.includes('__dyIM.drain()')
    ? [response('0:1:100001:300003', '其他会话'), response(convId, '目标会话')]
    : fallback(script);
  const result = await readDMViaApi({ browser: b, expectConvId: convId });
  assert.equal(result.ok, true);
  assert.equal(result.convId, convId);
  assert.deepEqual(result.messages.map((m) => m.text), ['目标会话']);
  clearCache();
});
test('未指定目标时合并结果仍只能属于选中的一个会话', () => {
  const captures = [response(convId, '较早会话', { time: 1700000000000 }),
    response('0:1:100001:300003', '较新会话', { time: 1700000060000 })];
  for (const list of [captures, [...captures].reverse()]) {
    const result = pickMessages(list);
    assert.ok(result.messages.every(m => m.convId === result.convId));
  }
});
test('浏览器事件裁剪或刷新后仍消费新推送，同一帧不重复消费', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const inner = Buffer.from(response(convId, '新推送').b64, 'base64');
  const size = []; let n = inner.length;
  while (n >= 128) { size.push((n & 127) | 128); n >>>= 7; } size.push(n);
  const frame = () => ({ method: 'Network.webSocketFrameReceived', params: { requestId: 'test-socket', response: {
    payloadData: Buffer.concat([Buffer.from([0x42, ...size]), inner]).toString('base64'),
  } } });
  try {
    const b = { events: Array.from({ length: 120 }, () => ({ method: 'test' })) };
    const ch = new DouyinChannel({ db, host: { browser: b }, getConfig: () => ({}), log: () => {}, driver: {} });
    await ch.consumePushFrames();
    b.events.splice(0, 100); b.events.push(frame());
    await ch.consumePushFrames();
    assert.equal(ch.pushStats.frames, 1, '裁剪后不能继续使用旧数组下标');
    await ch.consumePushFrames();
    assert.equal(ch.pushStats.frames, 1);
    b.events = [frame()];
    await ch.consumePushFrames();
    assert.equal(ch.pushStats.frames, 2, '导航清空数组后应从新数组开头读取');
  } finally { db.close(); }
});
test('已验证的会话可读取没有昵称的新缓存，不混入未验证 DOM', async () => {
  seed();
  const result = await readDM({ browser: browser(), uname: '测试联系人', expectConvId: convId, minCacheAt: 1 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.via, 'cache');
  assert.equal(result.needsPageRead, true);
  assert.equal(result.convId, convId);
  assert.equal(result.messages[0].text, '测试消息');
});
test('旧缓存或缓存中其他会话不能冒充本轮读取成功', async () => {
  for (const [at, id] of [[1, convId], [Date.now(), '0:1:100001:300003']]) {
    seed(at, id);
    const result = await readDMViaApi({ browser: browser(), uname: '测试联系人', expectConvId: convId, minCacheAt: 2 }).catch(() => ({ ok: false }));
    assert.equal(result.ok, false);
  }
  clearCache();
});
test('通道传递已验证身份及读取时间，换号后不沿用，目标不符不推进游标', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  try {
    setKv(db, 'douyin.selfUid', '100001');
    const options = [];
    const ch = new DouyinChannel({ db, host: {}, getConfig: () => ({}), log: () => {},
      driver: { read: async (_name, opts) => {
        options.push(opts);
        return { ok: true, convId: '0:1:100001:300003', messages: [] };
      } },
    });
    const st = { convId, identity: conversationIdentity(convId, ['100001']), readAt: 123 };
    const args = { c: {}, name: '测试联系人', key: 'test-cursor', st, sig: 'new', unread: true };
    await ch.readConversation(args);
    assert.deepEqual(options[0], { expectConvId: convId, minCacheAt: 123 });
    assert.equal(getKv(db, args.key, null), null);
    assert.match(ch.inbox.status().gaps[0].reason, /身份/);
    setKv(db, 'douyin.selfUid', '900009');
    await ch.readConversation(args);
    assert.equal(options[1].expectConvId, '');
  } finally { db.close(); }
});
test('轮询结束仍显示未恢复的读取故障，恢复后清除，历史缺口保留', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  try {
    const ch = new DouyinChannel({ db, host: { running: true, exclusive: async (_name, fn) => fn() },
      getConfig: () => ({ enabled: true }), driver: {}, log: () => {} });
    ch.consumePushFrames = async () => {};
    ch.pollInner = async () => {};
    ch.inbox.beginRead('douyin.conv.test-cursor', 'douyin:测试联系人');
    ch.inbox.failRead('douyin.conv.test-cursor');
    ch.markReadFailed('douyin.conv.test-cursor');
    await ch.pollOnce();
    assert.match(ch.lastError, /1 个会话/);
    ch.markReadOk('douyin.conv.test-cursor');
    ch.markReadFailed('e2e-conv'); // 遗留探针不属于正式会话，不应持续报警
    await ch.pollOnce();
    assert.equal(ch.lastError, '');
    assert.equal(ch.inbox.status().gaps.length, 1);
  } finally { db.close(); }
});
test('缓存交接保留页面待读标记，完整读取后清除', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  try {
    setKv(db, 'douyin.selfUid', '100001');
    let needsPageRead = true;
    const ch = new DouyinChannel({ db, host: {}, getConfig: () => ({}), log: () => {},
      driver: { read: async () => ({ ok: true, convId, messages: [], needsPageRead }) } });
    const args = { c: {}, name: '测试联系人', key: 'test-cursor', st: null, sig: 'preview', unread: true };
    await ch.readConversation(args);
    const st = getKv(db, args.key, null);
    assert.equal(st.needsPageRead, true);
    needsPageRead = false;
    await ch.readConversation({ ...args, st });
    assert.equal(getKv(db, args.key, null).needsPageRead, undefined);
  } finally { db.close(); }
});
test('接口错误标注 fromMe 时，仍按已知自身 uid 排除自己的回复', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  try {
    setKv(db, 'douyin.selfUid', '100001');
    const messages = [
      { convId, senderId: '100001', fromMe: false, text: '自己的回复', seq: '1', time: Date.now() },
      { convId, senderId: '200002', fromMe: false, text: '对方的新消息', seq: '2', time: Date.now() },
    ];
    const received = [];
    const ch = new DouyinChannel({ db, host: {}, getConfig: () => ({}), log: () => {},
      driver: { read: async () => ({ ok: true, convId, messages }) }, onMessage: async m => { received.push(m.text); return { done: true }; } });
    await ch.readConversation({ c: { unread: 2 }, name: '测试联系人', key: 'test-cursor', st: null, sig: 'new', unread: true });
    assert.deepEqual(received, ['对方的新消息']);
  } finally { db.close(); }
});
test('没有 sec_uid 的自身推送不入库、不触发回复', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  try {
    setKv(db, 'douyin.selfUid', '100001');
    setKv(db, 'douyin.conv.test', { name: '测试联系人', identity: conversationIdentity(convId, ['100001']), convId });
    const raw = Buffer.from(response(convId, '自己的回复', { senderId: '100001', time: Date.now() }).b64, 'base64');
    const size = []; let n = raw.length;
    while (n >= 128) { size.push((n & 127) | 128); n >>>= 7; } size.push(n);
    const events = [{ method: 'Network.webSocketFrameReceived', params: { requestId: 'test', response: {
      payloadData: Buffer.concat([Buffer.from([0x42, ...size]), raw]).toString('base64'),
    } } }];
    const ch = new DouyinChannel({ db, host: { browser: { events } }, getConfig: () => ({}), log: () => {}, driver: {} });
    await ch.consumePushFrames();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM douyin_inbox').get().n, 0);
  } finally { db.close(); }
});
