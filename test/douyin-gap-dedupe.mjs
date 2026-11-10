import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpHome } from './_tmp.mjs';

// 同一会话反复读失败时，设置页不该刷出一长串重复的「私信可能遗漏」。
// 2026-11-11 真机：未云和 Re. 各堆了五六条，全是同一句原因。
process.env.DSH_HOME = tmpHome('douyin-gap-dedupe-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinInbox } = await import('../lib/douyin-inbox.js');

const db = openDatabase();
const inbox = new DouyinInbox(db);

test('同一会话连续失败只留一条未确认的遗漏提示', () => {
  for (let i = 0; i < 5; i++) {
    inbox.beginRead('k1', 'douyin:未云');
    inbox.failRead('k1');
  }
  const n = db.prepare("SELECT COUNT(*) n FROM douyin_inbox_gap WHERE channel_id='douyin:未云' AND acknowledged=0").get().n;
  assert.equal(n, 1, '五次失败只该有一条提示');
});

test('不同会话各自留一条', () => {
  inbox.beginRead('k2', 'douyin:Re.');
  inbox.failRead('k2');
  const rows = db.prepare("SELECT channel_id FROM douyin_inbox_gap WHERE acknowledged=0 ORDER BY channel_id").all();
  assert.deepEqual(rows.map((r) => r.channel_id), ['douyin:Re.', 'douyin:未云']);
});

test('已知晓之后再失败，会重新记一条', () => {
  db.prepare("UPDATE douyin_inbox_gap SET acknowledged=1 WHERE channel_id='douyin:未云'").run();
  inbox.beginRead('k1', 'douyin:未云');
  inbox.failRead('k1');
  const n = db.prepare("SELECT COUNT(*) n FROM douyin_inbox_gap WHERE channel_id='douyin:未云' AND acknowledged=0").get().n;
  assert.equal(n, 1, '旧的已知晓了，新失败要能再提示');
});
