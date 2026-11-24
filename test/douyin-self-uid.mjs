import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DouyinChannel } from '../lib/channels/douyin.js';
import { setKv, getKv } from '../lib/db.js';

const SELF = '900000000000000001';
const PEER = '900000000000000002';
const OTHER = '900000000000000003';
const CONV = `0:1:${SELF}:${PEER}`;
const GROUP_CONV = '900000000000000011:900000000000000012:0';

function world({ selfUid, secUid = '', read, groupNames = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  setKv(db, 'douyin.selfUid', selfUid);
  setKv(db, 'douyin.selfSecUid', secUid);
  const logs = [];
  const ch = new DouyinChannel({
    db, host: {}, getConfig: () => ({ groups: groupNames }), log: (_level, message) => logs.push(String(message)),
    driver: { read: read ?? (async () => ({ ok: true, convId: CONV, messages: [] })) },
    onMessage: async () => ({ queued: true }),
  });
  return { db, ch, logs };
}

function message(senderId, text, { convId = CONV, fromMe = false, convType, senderName, seq, type } = {}) {
  return { convId, senderId, text, fromMe, time: 1700000000000,
    ...(convType === undefined ? {} : { convType }),
    ...(senderName === undefined ? {} : { senderName }),
    ...(seq === undefined ? {} : { seq }),
    ...(type === undefined ? {} : { type }) };
}

test('历史值被 JSON 字符串化带引号时，读成裸数字，自己的消息不再被当群友', async () => {
  const { db, ch, logs } = world({ selfUid: `"${SELF}"`, groupNames: ['测试群'],
    read: async () => ({ ok: true, convId: GROUP_CONV, messages: [
      message(OTHER, '群里有人说', { convId: GROUP_CONV, convType: 2, senderName: '测试群友', seq: '1' }),
      message(SELF, '自己的回复', { convId: GROUP_CONV, convType: 2, senderName: '测试账号', seq: '2', fromMe: false }),
    ] }),
  });
  try {
    assert.deepEqual(ch.selfUids(), [SELF]);
    assert.equal(ch.identityReady(), true);
    assert.equal(ch.status().identityState.knowsSelfUid, true);
    assert.equal(ch.status().identityState.selfUids.join(','), SELF);
    await ch.readConversation({ c: {}, name: '测试群', key: 'issue-192-group', st: null, sig: 'quoted', unread: true });
    assert.equal(logs.some((line) => line.includes('学')), false, '已有有效 uid 时不重复学习');
    const cursor = getKv(db, 'issue-192-group', null);
    assert.ok(cursor?.members, '游标要成功写入');
    assert.equal(cursor.members[SELF], undefined, '带引号 uid 修好后，自己不能学进群名册');
    assert.equal(cursor.members[OTHER], '测试群友');
    assert.equal(ch.readFailCount('issue-192-group'), 0);
  } finally { db.close(); }
});

test('sec_uid 历史值带引号时只剥引号，不套数字校验', () => {
  const { db, ch } = world({ selfUid: '', secUid: '"MS4wLjABAAAAtest"' });
  try {
    assert.deepEqual(ch.selfUids(), ['MS4wLjABAAAAtest']);
    assert.equal(ch.identityReady(), true);
  } finally { db.close(); }
});

test('非纯数字的脏 selfUid 视为未学到，有效新值仍能覆盖写入', () => {
  const { db, ch, logs } = world({ selfUid: '"not-a-uid"' });
  try {
    assert.deepEqual(ch.selfUids(), []);
    assert.equal(ch.identityReady(), false);
    assert.equal(ch.status().identityState.knowsSelfUid, false, '脏值不能让身份闸误以为知道自己是谁');
    ch.learnSelfUid(CONV, [message(PEER, '在吗')]);
    assert.equal(getKv(db, 'douyin.selfUid', ''), SELF, '有效新值必须覆盖无效旧值');
    assert.deepEqual(ch.selfUids(), [SELF]);
    assert.equal(ch.identityReady(), true);
    assert.equal(logs.filter((line) => line.includes('学到')).length, 1);
    ch.learnSelfUid(`0:1:${SELF}:${OTHER}`, [message(OTHER, '又在吗')]);
    assert.equal(getKv(db, 'douyin.selfUid', ''), SELF, '有效值不被后来的会话改写');
  } finally { db.close(); }
});

test('带引号的有效 uid 不阻断读取，自己发的文本不会当作对方消息入库', async () => {
  const { db, ch } = world({ selfUid: `"${SELF}"`,
    read: async () => ({ ok: true, convId: CONV, messages: [
      message(SELF, '自己的话', { seq: '1', fromMe: false }),
      message(PEER, '对方的话', { seq: '2' }),
    ] }),
  });
  try {
    await ch.readConversation({ c: {}, name: '测试联系人', key: 'issue-192-single', st: null, sig: 'quoted', unread: true });
    const rows = db.prepare("SELECT payload FROM douyin_inbox WHERE channel_id='douyin:测试联系人'").all();
    assert.deepEqual(rows.map((r) => JSON.parse(r.payload).text), ['对方的话']);
    assert.equal(getKv(db, 'issue-192-single', null).identity, `douyin:${PEER}`);
  } finally { db.close(); }
});
