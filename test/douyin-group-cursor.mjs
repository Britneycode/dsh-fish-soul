import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DouyinChannel } from '../lib/channels/douyin.js';
import { setKv, getKv } from '../lib/db.js';

const SELF = '900000000000000001';
const PEER = '900000000000000002';
const PRIVATE_CONV = `0:1:${SELF}:${PEER}`;
const GROUP_CONV = '900000000000000011:900000000000000012:0';
const OTHER_GROUP_CONV = '900000000000000021:900000000000000022:0';
const MEMBER = '900000000000000031';

function world({ read, groupNames = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const logs = [];
  const ch = new DouyinChannel({
    db, host: {}, getConfig: () => ({ groups: groupNames }), log: (_level, message) => logs.push(String(message)),
    driver: { read: read ?? (async () => ({ ok: true, convId: GROUP_CONV, messages: [] })) },
    onMessage: async () => ({ queued: true }),
  });
  return { db, ch, logs };
}

const groupMsg = (seq, text, { convId = GROUP_CONV, senderId = MEMBER, senderName = '测试群友' } = {}) => ({
  fromMe: false, seq, text, time: 1700000000000, senderId, senderName, convId, convType: 2,
});

/** 一个被污染的群游标：group:true，但 convId 是另一个私聊会话的单聊形状。 */
const polluted = () => ({
  name: '测试群', sig: 'old', convId: PRIVATE_CONV, identity: `group:${PRIVATE_CONV}`,
  window: ['stale-print'], readAt: 123, group: true, members: { [MEMBER]: '测试群友' },
});

test('群游标挂着单聊 convId：不拿错 ID 读取，清空固定后重新捕获真正的群', async () => {
  const reads = [];
  const { db, ch } = world({ read: async (_name, opts) => {
    reads.push(opts);
    return { ok: true, convId: GROUP_CONV, messages: [groupMsg('1', '群里的新消息')] };
  } });
  try {
    setKv(db, 'douyin.conv.polluted', polluted());
    await ch.readConversation({ c: {}, name: '测试群', key: 'douyin.conv.polluted', st: polluted(), sig: 'new', unread: true });

    assert.equal(reads.length, 1, '必须真的走到驱动读取');
    assert.equal(reads[0].expectConvId, '', '污染的单聊 convId 不能被当成固定目标传给驱动');
    const cursor = getKv(db, 'douyin.conv.polluted', null);
    assert.equal(cursor.convId, GROUP_CONV, '游标换成重新捕获到的真群 ID');
    assert.equal(cursor.identity, `group:${GROUP_CONV}`);
    assert.equal(cursor.group, true);
    const rows = db.prepare("SELECT payload FROM douyin_inbox WHERE channel_id='douyin-group:测试群'").all();
    assert.deepEqual(rows.map((r) => JSON.parse(r.payload).text), ['群里的新消息']);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM douyin_inbox WHERE channel_id='douyin:测试群'").get().n, 0, '不能进单聊频道');
  } finally { db.close(); }
});

test('驱动只会返回那个污染的单聊 ID：fail-closed 拒绝，不推进游标，不入库', async () => {
  const { db, ch, logs } = world({ read: async () => ({ ok: true, convId: PRIVATE_CONV, messages: [
    { fromMe: false, seq: '9', text: '私聊的内容', time: 1700000000000, senderId: PEER, convId: PRIVATE_CONV },
  ] }) });
  try {
    setKv(db, 'douyin.conv.polluted', polluted());
    await ch.readConversation({ c: {}, name: '测试群', key: 'douyin.conv.polluted', st: polluted(), sig: 'new', unread: true });

    assert.equal(getKv(db, 'douyin.conv.polluted', null).convId, PRIVATE_CONV, '读失败时游标不能被推进');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM douyin_inbox WHERE channel_id='douyin-group:测试群'").get().n, 0, '私聊内容不能进群频道');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM douyin_inbox WHERE channel_id='douyin:测试群'").get().n, 0, '也不能借单聊频道入库');
    assert.equal(ch.readFailCount('douyin.conv.polluted'), 1, '按读失败记账');
    assert.ok(logs.some((line) => line.includes('群聊游标')), '要留一条能定位问题的日志');
  } finally { db.close(); }
});

test('合法群游标（identity: group:<convId>）仍然钉住自己的 convId，不受影响', async () => {
  const reads = [];
  const { db, ch } = world({ read: async (_name, opts) => {
    reads.push(opts);
    return { ok: true, convId: OTHER_GROUP_CONV, messages: [] };
  } });
  try {
    const st = { name: '测试群', sig: 'old', convId: GROUP_CONV, identity: `group:${GROUP_CONV}`, window: ['p'], readAt: 123, group: true };
    await ch.readConversation({ c: {}, name: '测试群', key: 'douyin.conv.legal', st, sig: 'new', unread: true });

    assert.equal(reads[0].expectConvId, GROUP_CONV, '合法群的 convId 固定不能丢（串会话防线）');
    assert.equal(getKv(db, 'douyin.conv.legal', null), null, '读到别的群 ID 时仍然拒绝');
    assert.equal(ch.readFailCount('douyin.conv.legal'), 1);
  } finally { db.close(); }
});

test('污染游标的 group 标记不会让随后读到的单聊 ID 被当成群', async () => {
  const { db, ch } = world({ read: async () => ({ ok: true, convId: GROUP_CONV, messages: [] }) });
  try {
    setKv(db, 'douyin.conv.polluted', polluted());
    await ch.readConversation({ c: {}, name: '测试群', key: 'douyin.conv.polluted', st: polluted(), sig: 'new', unread: true });
    assert.equal(getKv(db, 'douyin.conv.polluted', null).group, true, '重新捕获到真群后仍是群');
  } finally { db.close(); }
});
