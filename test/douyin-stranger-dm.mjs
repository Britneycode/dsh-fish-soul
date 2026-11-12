import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { tmpHome } from './_tmp.mjs';

// 🔴 抖音陌生人私信冷启动死锁（推送路 / 轮询路互等）。
//
// 真机现象：陌生人第一次发私信，消息永远进不了收件箱。
// 两条路各自都「在等对方」：
//
//   ① 推送路（consumePushFrames）：入库要昵称（channelId 按名字拼），昵称只能从
//      轮询路存下的游标 / DOM 兜底里学到。陌生人没有映射 → `noName` → 整帧 continue，
//      而帧游标已经前移 ⇒ 消息在入库之前就永久消失。
//   ② 轮询路（pollInner）：按 `时间|预览` 变化决定要不要进 todo。基线里已经写过的
//      会话（bootstrap 只记 sig、没有 identity）预览不变就永远排不上；第一次见到的
//      会话如果时间不新鲜（`RECENT_MS` 之外）也永远排不上。排不上就读不到 →
//      没有游标 → 推送路更认不出。
//
// 守四条判据：
//   - 缺昵称的帧**不丢**，先存着（有时限、有上限），轮询路读到之后补入库
//   - 轮询路已经收过的，补入库时**不能重复收**（否则同一条消息回两遍）
//   - 从没读成功过的会话（没游标 / 游标没 identity）**必须**读一次，跟预览变没变无关
//   - 不回归：验证过的会话预览没变就不读；推送路不能覆盖轮询路的窗口游标
//   - 面板不再为「游标已经不在」的孤儿失败计数报警

process.env.DSH_HOME = tmpHome('douyin-stranger-');
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const { DouyinChannel, matchConversationByPreview } = await import('../lib/channels/douyin.js');
const { DouyinInbox } = await import('../lib/douyin-inbox.js');

const db = openDatabase();
new DouyinInbox(db).status(); // 建表

const SELF = '900001';
const STRANGER = '2060933357111416';
const FRIEND = '2874562949425280';
const conv = (peer) => `0:1:${SELF}:${peer}`;
const STRANGER_CONV = conv(STRANGER);
const FRIEND_CONV = conv(FRIEND);
const keyOf = (name) => `douyin.conv.${createHash('sha1').update(String(name)).digest('hex').slice(0, 16)}`;

function reset() {
  db.exec("DELETE FROM kv WHERE key LIKE 'douyin.%'");
  db.exec('DELETE FROM douyin_inbox');
  db.exec('DELETE FROM douyin_inbox_gap');
  db.exec('DELETE FROM douyin_inbox_read_intent');
  setKv(db, 'douyin.selfUid', SELF);
  setKv(db, 'douyin.bootstrapped', true);
}
const inboxRows = () => db.prepare('SELECT payload FROM douyin_inbox ORDER BY id').all().map((r) => JSON.parse(r.payload));

// ── 推送帧构造（和真机同一条路：protobuf 消息 → #8 外壳 → base64）───────────
function varint(n) {
  let v = BigInt(n); const b = [];
  while (v >= 128n) { b.push(Number(v & 127n) | 128); v >>= 7n; }
  b.push(Number(v));
  return Buffer.from(b);
}
const field = (id, n) => Buffer.concat([varint(id * 8), varint(n)]);
const bytesField = (id, buf) => Buffer.concat([varint(id * 8 + 2), varint(buf.length), buf]);

function messageBytes(convId, text, { time = Date.now(), seq = 1, senderId = STRANGER } = {}) {
  return Buffer.concat([
    bytesField(1, Buffer.from(convId)),
    field(2, 1),                                       // 会话类型：单聊
    field(6, 7),                                       // 消息类型：文本
    field(7, senderId),
    bytesField(8, Buffer.from(JSON.stringify({ text }))),
    field(10, time),
    field(17, seq),
  ]);
}

function frameEvent(convId, texts, opts = {}) {
  const list = texts.map((t, i) => messageBytes(convId, t, { ...opts, seq: (opts.seq ?? 1) + i }));
  const inner = bytesField(6, bytesField(301, Buffer.concat(list)));
  return {
    method: 'Network.webSocketFrameReceived',
    params: { requestId: 'sock', response: { payloadData: Buffer.concat([Buffer.from([0x42]), varint(inner.length), inner]).toString('base64') } },
  };
}

/** 造一个真 DouyinChannel：只有浏览器 / 驱动是假的。 */
function makeChannel({ rows = [], conversations = [], read = null, onMessage = async () => ({ done: true }), logs = [] } = {}) {
  const browser = { events: [], eval: async () => rows };
  const reads = [];
  const ch = new DouyinChannel({
    db,
    host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn(), browser },
    getConfig: () => ({ enabled: true }),
    log: (level, msg) => logs.push({ level, msg }),
    onMessage,
    driver: {
      checkLogin: async () => true,
      list: async () => ({ ok: true, conversations }),
      read: async (name, opts) => { reads.push({ name, opts }); return read === null ? { ok: true, convId: conv(STRANGER), messages: [] } : read(name, opts); },
    },
    pollRangeMs: [1000, 2000],
  });
  ch.lastCanaryAt = Date.now();   // 跳过自检（自检要开面板，这里是假的）
  ch.reads = reads;
  return ch;
}

// ── ① 预览匹配纯函数：证据规则（唯一命中才算认出来）────────────────────────
test('预览匹配：只发一条短消息（以前要求 >=2 字符）也能认出昵称', () => {
  assert.equal(matchConversationByPreview([{ name: '陌生人', preview: '在吗' }], ['在吗']), '陌生人');
});

test('预览匹配：命中多行就是歧义，宁可不认（不猜昵称）', () => {
  const rows = [{ name: '甲', preview: '在吗' }, { name: '乙', preview: '在吗' }];
  assert.equal(matchConversationByPreview(rows, ['在吗']), '', '两行都像，不能挑一个凑合');
});

test('预览匹配：先用最长的文本（短文本容易撞到别的会话）', () => {
  const rows = [{ name: '甲', preview: '好的' }, { name: '乙', preview: '好的，我晚上八点到' }];
  assert.equal(matchConversationByPreview(rows, ['好的', '好的，我晚上八点到']), '乙');
});

test('预览匹配：没有文本 / 没有会话行 / 空预览 → 不认', () => {
  assert.equal(matchConversationByPreview([{ name: '甲', preview: '在吗' }], []), '');
  assert.equal(matchConversationByPreview([], ['在吗']), '');
  assert.equal(matchConversationByPreview([{ name: '甲', preview: '' }], ['在吗']), '');
  assert.equal(matchConversationByPreview([{ name: '  ', preview: '在吗' }], ['在吗']), '');
});

// ── ② 推送路：缺昵称不丢，轮询路读到之后补入库 ─────────────────────────────
test('推送帧缺昵称：先存着不丢，轮询路学到昵称后补进收件箱并交给模型', async () => {
  reset();
  const delivered = [];
  // DOM 里只有别的会话 → 兜底认不出来
  const ch = makeChannel({ rows: [{ name: '另一个会话', preview: '晚安' }], onMessage: async (m) => { delivered.push(m); return { done: true }; } });
  ch.host.browser.events = [frameEvent(STRANGER_CONV, ['在吗'])];
  await ch.consumePushFrames();

  assert.equal(inboxRows().length, 0, '没昵称时不能入库（channelId 按名字拼，名字错了就发给别人）');
  assert.equal(ch.pushStats.parked, 1, `缺昵称的帧要留下来等下一轮，实际 parked=${ch.pushStats.parked}`);

  // 轮询路读到这个会话：游标带上 name + identity（readAt 早于这批帧到达 → 这批还没收过）
  setKv(db, keyOf('陌生人'), {
    name: '陌生人', sig: '11/04|10分钟内在线', convId: STRANGER_CONV,
    identity: `douyin:${STRANGER}`, window: ['h1'], readAt: Date.now() - 60_000,
  });
  ch.host.browser.events = [];       // 这一轮没有新帧：靠「待补队列」把上一轮的补上
  await ch.consumePushFrames();
  await ch.drainInbox();             // 收件箱是异步排空的，这里等它跑完再断言交付

  const rows = inboxRows();
  assert.equal(rows.length, 1, '昵称学到之后，攒下的消息必须补进收件箱');
  assert.equal(rows[0].text, '在吗');
  assert.equal(rows[0].channelId, 'douyin:陌生人');
  assert.equal(rows[0].userId, `douyin:${STRANGER}`, '认人靠会话身份，不靠昵称');
  assert.equal(ch.parkedPush.size, 0, '补完要从待补队列里删掉');
  assert.deepEqual(delivered.map((m) => m.text), ['在吗'], '陌生人这条路必须真的走到模型（这才是「进得了收件箱」）');
  assert.equal(getKv(db, `douyin.name.douyin:${STRANGER}`, null), null, '没有 DOM 证据就不能写 douyin.name（不猜昵称）');
});

test('轮询路已经收过这批消息：补入库时不能再收一遍（否则同一条消息回两遍）', async () => {
  reset();
  const ch = makeChannel({ rows: [] });
  ch.host.browser.events = [frameEvent(STRANGER_CONV, ['在吗'], { time: Date.now() - 5_000 })];
  await ch.consumePushFrames();
  assert.equal(ch.pushStats.parked, 1);

  // 轮询路在这批帧**之后**读过这个会话（readAt 晚于消息时间）→ 历史里已经收到了
  setKv(db, keyOf('陌生人'), {
    name: '陌生人', sig: 'x', convId: STRANGER_CONV,
    identity: `douyin:${STRANGER}`, window: ['h1'], readAt: Date.now(),
  });
  ch.host.browser.events = [];
  await ch.consumePushFrames();

  assert.equal(inboxRows().length, 0, '轮询路收过的不能再收一遍');
  assert.equal(ch.parkedPush.size, 0, '判过之后也要从待补队列里删掉');
});

test('待补的帧不能无限攒：过期就丢，并且记在账上', async () => {
  reset();
  const logs = [];
  const ch = makeChannel({ rows: [], logs });
  ch.host.browser.events = [frameEvent(STRANGER_CONV, ['在吗'])];
  await ch.consumePushFrames();
  assert.equal(ch.pushStats.parked, 1);

  for (const entry of ch.parkedPush.values()) entry.at -= 11 * 60_000;  // 假装过了 11 分钟
  ch.host.browser.events = [];
  await ch.consumePushFrames();

  assert.equal(ch.parkedPush.size, 0, '过期要清掉（否则进程里一直攒）');
  assert.ok((ch.pushStats.droppedNoName ?? 0) >= 1, '真丢了要能看见（账上有数）');
  assert.ok(logs.some((l) => /昵称/.test(l.msg)), `过期丢包要留痕，实际日志：${JSON.stringify(logs.map((l) => l.msg))}`);
});

// ── ③ 轮询路：没验证过的会话必须读一次 ─────────────────────────────────────
test('推送帧缺昵称但 DOM 预览能对上：当场学昵称、当场入库，不靠轮询路', async () => {
  reset();
  const ch = makeChannel({ rows: [{ name: '陌生人', preview: '在吗' }] });
  ch.host.browser.events = [frameEvent(STRANGER_CONV, ['在吗'])];
  await ch.consumePushFrames();

  const rows = inboxRows();
  assert.equal(rows.length, 1, 'DOM 里能对上就该立刻收（这是打破互等的第一条路）');
  assert.equal(rows[0].channelId, 'douyin:陌生人');
  assert.equal(getKv(db, `douyin.name.douyin:${STRANGER}`, null), '陌生人',
    '有 DOM 证据才写 douyin.name —— 学到之后下一帧不用再读 DOM');
  assert.equal(ch.pushStats.parked, 0, '当场认出来就不该进待补队列');
});

test('轮询路：基线里没有身份、预览也没变的会话，仍然要读（否则永远学不到昵称）', async () => {
  reset();
  const name = '陌生人';
  // bootstrap 只记 sig + window，没有 identity
  setKv(db, keyOf(name), { name, sig: '11/04|10分钟内在线', window: [] });
  const ch = makeChannel({ conversations: [{ name, unread: 0, time: '11/04', preview: '10分钟内在线' }] });

  await ch.pollInner();

  assert.equal(ch.reads.length, 1, `没身份就必须读一次，实际读了 ${ch.reads.length} 次`);
});

test('轮询路：第一次见到的会话，时间再旧也要读一次（不能因为「不新鲜」就永远不读）', async () => {
  reset();
  const name = '新来的';
  const ch = makeChannel({
    conversations: [{ name, unread: 0, time: '10月16日', preview: '你好' }],
    read: async () => ({ ok: true, convId: conv(STRANGER), messages: [] }),
  });

  await ch.pollInner();

  assert.equal(ch.reads.length, 1, `新会话第一次出现就要读，实际读了 ${ch.reads.length} 次`);
  const st = getKv(db, keyOf(name), null);
  assert.equal(st?.identity, `douyin:${STRANGER}`, '读成功一次就该把身份记进游标');
});

test('轮询路：验证过的会话预览没变就不读（不回归已有会话）', async () => {
  reset();
  const name = '未云';
  setKv(db, keyOf(name), {
    name, sig: '15:26|在线', convId: FRIEND_CONV, identity: `douyin:${FRIEND}`,
    window: ['h1', 'h2'], readAt: Date.now() - 60_000,
  });
  const ch = makeChannel({ conversations: [{ name, unread: 0, time: '15:26', preview: '在线' }] });

  await ch.pollInner();

  assert.equal(ch.reads.length, 0, '没变化、已验证的会话不该被重读（会把已读和补收都搞乱）');
});

test('轮询路：永远验证不了的会话（读不出 convId）失败到上限后停手，不会每 5 分钟开一次会话', async () => {
  reset();
  const name = '认不出的';
  const key = keyOf(name);
  // 游标在但没身份；失败窗口已经过了（> 5 分钟），所以熔断窗口本身挡不住
  setKv(db, key, { name, sig: '11/04|x', window: [] });
  setKv(db, `douyin.retry.${key}`, Date.now() - 10 * 60_000);
  setKv(db, `douyin.fails.${key}`, 3);
  setKv(db, `douyin.readAt.${key}`, Date.now() - 10 * 60_000);
  const ch = makeChannel({ conversations: [{ name, unread: 0, time: '11/04', preview: 'x' }] });

  await ch.pollInner();

  assert.equal(ch.reads.length, 0, '连续失败到上限就停手（否则每 5 分钟插一条 gap）');
});

test('轮询路：连续读失败到上限的会话，不再每轮硬读（熔断仍然生效）', async () => {
  reset();
  const name = '读不到的';
  const key = keyOf(name);
  setKv(db, key, { name, sig: '11/04|x', window: [] });   // 没身份
  setKv(db, `douyin.retry.${key}`, Date.now());            // 刚失败过
  setKv(db, `douyin.fails.${key}`, 3);                     // 且已经连续失败 3 次
  const ch = makeChannel({ conversations: [{ name, unread: 0, time: '11/04', preview: 'x' }] });

  await ch.pollInner();

  assert.equal(ch.reads.length, 0, '熔断窗口内不重读（否则每轮插一条 gap）');
});

// ── ④ 推送路不能覆盖轮询路的游标 ───────────────────────────────────────────
test('推送路入库不能清掉游标里的窗口 / sig（否则下一轮轮询把同几条再收一遍）', async () => {
  reset();
  const name = '未云';
  const key = keyOf(name);
  setKv(db, key, {
    name, sig: '15:26|在线', convId: FRIEND_CONV, identity: `douyin:${FRIEND}`,
    window: ['h1', 'h2'], readAt: Date.now() - 1000,
  });
  const ch = makeChannel({ rows: [] });
  ch.host.browser.events = [frameEvent(FRIEND_CONV, ['在吗'], { senderId: FRIEND, seq: 9 })];
  await ch.consumePushFrames();

  const st = getKv(db, key, null);
  assert.deepEqual(st.window, ['h1', 'h2'], '窗口不能被推送路清掉');
  assert.equal(st.sig, '15:26|在线', 'sig 不能被推送路清掉');
  assert.equal(st.identity, `douyin:${FRIEND}`);
  assert.equal(inboxRows().length, 1, '消息本身照常入库');
});

// ── ⑤ 孤儿失败计数：面板不再为「游标已经不在」的计数报警 ───────────────────
test('面板只报还活着的会话；游标没了的失败计数要清掉', async () => {
  reset();
  const orphan = 'douyin.conv.orphan0000000000';
  setKv(db, `douyin.fails.${orphan}`, 1);
  setKv(db, `douyin.retry.${orphan}`, Date.now() - 2 * 3600_000);
  setKv(db, `douyin.readAt.${orphan}`, Date.now() - 2 * 3600_000);
  // 一条真的（游标在）
  const live = keyOf('未云');
  setKv(db, live, { name: '未云', sig: 'x', convId: FRIEND_CONV, identity: `douyin:${FRIEND}`, window: ['h'], readAt: Date.now() });
  setKv(db, `douyin.fails.${live}`, 1);
  setKv(db, `douyin.retry.${live}`, Date.now());

  const ch = makeChannel();
  ch.consumePushFrames = async () => {};
  ch.pollInner = async () => {};
  await ch.pollOnce();

  assert.equal(getKv(db, `douyin.fails.${orphan}`, null), null, '孤儿计数要清掉');
  assert.equal(getKv(db, `douyin.retry.${orphan}`, null), null);
  assert.equal(getKv(db, `douyin.fails.${live}`, null), 1, '活着的会话计数不能动');
  assert.match(ch.lastError, /1 个会话/, `面板要说清是哪个还失败着，实际：${JSON.stringify(ch.lastError)}`);
});

test.after(() => db.close());
console.log('douyin-stranger-dm ok');
