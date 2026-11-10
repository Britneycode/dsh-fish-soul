import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { tmpHome } from './_tmp.mjs';

// 🔴 抖音私信「读失败死循环 gap」的回归测试。
//
// 真机踩到的坑：抖音网页版私信只在首次进会话时请求接口，轮询时 hook 抓不到
// → convId 空 → 读失败 → failRead 记 gap。但失败后游标没推进 → 会话永远
// 「有变化」→ 每轮重试 → 每轮失败 → gap 死循环（实测每 ~1 分钟一对）。
//
// 修法：失败时在**独立 kv**（`douyin.retry.<key>`）记失败时间，`pollInner`
// 在熔断窗口（5 分钟）内不再重读；有真新消息（unread）时绕过熔断。
// 独立 kv 不碰游标 —— 游标语义是「读到哪了」，失败不该动它。

process.env.DSH_HOME = tmpHome('douyin-read-fail-retry-');
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');

const db = openDatabase();
const SELF = '900001';
const PEER = '7702399256389125000';
const keyOf = (name) => `douyin.conv.${createHash('sha1').update(String(name)).digest('hex').slice(0, 16)}`;

// 与 lib/channels/douyin.js 里 FAIL_RETRY_MS 保持一致
const FAIL_RETRY_MS = 5 * 60_000;

/** 复刻 pollInner 的 todo 判定逻辑（纯函数，方便钉住熔断语义）。 */
function shouldRead({ st, sig, unread, now, lastFailedAt }) {
  const changed = st === null || st.sig !== sig;
  const failedRecently = lastFailedAt > 0 && now - lastFailedAt < FAIL_RETRY_MS;
  // 真新消息永远读；无新消息但有变化时，熔断窗口内不读
  return unread || (changed && !failedRecently);
}

test('熔断语义：失败后窗口内不重读，窗口过重试，unread 绕过', () => {
  const now = Date.now();
  const st = { sig: '旧' };
  const sig = '新';
  // 1. 无失败标记、有变化 → 读
  assert.equal(shouldRead({ st, sig, unread: false, now, lastFailedAt: 0 }), true, '正常变化要读');
  // 2. 刚失败过（窗口内）→ 不读
  assert.equal(shouldRead({ st, sig, unread: false, now, lastFailedAt: now - 60_000 }), false, '窗口内不重读');
  // 3. 窗口过了（>5 分钟）→ 重试
  assert.equal(shouldRead({ st, sig, unread: false, now, lastFailedAt: now - 6 * 60_000 }), true, '窗口过了要重试');
  // 4. unread 即使窗口内也读
  assert.equal(shouldRead({ st, sig, unread: true, now, lastFailedAt: now - 1000 }), true, '有真新消息绕过熔断');
});

test('读失败 → 独立 kv 记失败时间，游标不动', async () => {
  const key = keyOf('未云');
  setKv(db, key, { name: '未云', sig: '旧', window: [] });
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => ({ done: true }),
    driver: { read: async () => ({ ok: false, error: '拿不到会话 ID' }) },
  });
  await ch.readConversation({ c: {}, name: '未云', key, st: getKv(db, key, null), sig: '新', unread: false });

  // 失败时间在独立 kv
  const retry = Number(getKv(db, `douyin.retry.${key}`, 0) ?? 0);
  assert.ok(retry > 0, `失败时间要写进 douyin.retry.<key>（实际: ${retry}）`);
  // 游标本身不动（旧契约：失败不推进游标）
  const after = getKv(db, key, null);
  assert.equal(after.sig, '旧', '游标不该被推进');
  assert.equal(Number(after?.failedAt ?? 0), 0, '游标里不该混入 failedAt');
});

test('读成功后清掉失败标记，游标推进', async () => {
  const key = keyOf('未云');
  setKv(db, key, { name: '未云', sig: '旧', window: [] });
  setKv(db, `douyin.retry.${key}`, Date.now() - 1000);
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => ({ done: true }),
    driver: {
      read: async () => {
        const convId = `0:1:${SELF}:${PEER}`;
        return { ok: true, convId, messages: [{ fromMe: false, senderId: PEER, convId, text: '在吗', time: Date.now() }] };
      },
    },
  });
  const st = getKv(db, key, null);
  await ch.readConversation({ c: {}, name: '未云', key, st, sig: '新', unread: true });

  assert.equal(Number(getKv(db, `douyin.retry.${key}`, 0) ?? 0), 0, '成功路径要清掉失败标记');
  assert.equal(getKv(db, key, null).sig, '新', '成功路径要推进游标');
});

test('pollInner 用独立 kv 的失败时间做熔断', async () => {
  const key = keyOf('未云');
  setKv(db, key, { name: '未云', sig: '旧', window: [] });
  setKv(db, `douyin.retry.${key}`, Date.now()); // 刚失败
  const ch = new DouyinChannel({
    db, host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => ({ done: true }),
    driver: { read: async () => { throw new Error('不该被读'); } },
  });
  const lastFailedAt = ch.lastReadFailedAt(key);
  assert.ok(lastFailedAt > 0, `要能从独立 kv 读到失败时间（实际: ${lastFailedAt}）`);
  // 用复刻的判定：刚失败 + 有变化 → 不读
  const st = getKv(db, key, null);
  const sig = `${new Date().getHours()}:${new Date().getMinutes()}|新预览`;
  assert.equal(shouldRead({ st, sig, unread: false, now: Date.now(), lastFailedAt }), false, 'pollInner 的熔断判定要拒绝重读');
});

test.after(() => db.close());
console.log('douyin-read-fail-retry ok');
