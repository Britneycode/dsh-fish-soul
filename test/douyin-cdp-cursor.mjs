/**
 * 抖音 CDP 事件游标 —— 「能看到消息，但读会话拿不到 convId」的回归测试。
 *
 * 根因：调用方拿 `browser.events.length` 当事件游标存起来，之后 `imResponses` 用
 * `this.events.slice(since)` 取「游标之后」的事件。但那个数组：
 *   · 有 800 上限，超了就 `splice(0, 400)` 裁掉前半（事件多时必然发生）
 *   · `goto()` 会把它整个清空（确保面板 / reload 兜底都会走）
 * 两种情况之后，长度快照跟数组下标就脱钩了 —— `slice(since)` 取到空区间或错位区间，
 * 会话接口的响应明明在缓冲里却被静默漏掉。
 *
 * 后果链：`captureImBodies` 恒空 → `pickMessages` 无数据 → 解不出 convId →
 * `readConversation` 判「会话身份缺失」拒绝处理 → 面板显示「上次读取失败」，
 * 而主人明明能在抖音里看到消息。
 *
 * 修法：每个事件带一个**单调递增序号**（`browser.seq`），调用方用它当游标。
 * 序号只增不减，裁剪和清空都不影响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Browser, eventsSince, eventCursorOf } from '../lib/channels/vendor/douyin-bridge/browser.mjs';

const IM = 'https://imapi.douyin.com/v1/message/get_by_conversation';

/** 造一个真 Browser，用 handleMessage 灌事件（走真实的序号 / 裁剪逻辑）。 */
function mkBrowser() {
  const b = new Browser({});
  return {
    b,
    emit: (method, params = {}) => b.handleMessage({ data: JSON.stringify({ method, params }) }),
    im: (id = 'x') => {
      b.handleMessage({ data: JSON.stringify({ method: 'Network.responseReceived', params: { requestId: id, response: { url: IM, status: 200 } } }) });
      b.handleMessage({ data: JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: id } }) });
    },
  };
}

test('事件超过 800 被裁剪后，游标之后的新响应仍能取到', () => {
  const { b, emit, im } = mkBrowser();
  for (let i = 0; i < 700; i++) emit('Page.test');
  const since = eventCursorOf(b);
  // 冲过 800 上限 → 触发 splice(0, 400)，下标整体前移
  for (let i = 0; i < 200; i++) emit('Page.test');
  im('after-trim');
  const hits = b.imResponses(/get_by_conversation/, since);
  assert.equal(hits.length, 1, '裁剪后游标之后的新响应不能丢（这是「拿不到 convId」的根因之一）');
  assert.equal(hits[0].finished, true, 'loadingFinished 要跟上');
});

/**
 * 把「旧写法为什么会漏」量成数字 —— 修法不允许回退。
 *
 * 上面几条走新 API（`eventCursorOf`），把 lib 改回去时它们红在「导入不到」，
 * 那是**导入层**的红，证明不了「旧写法真的会丢响应」。这条不依赖新导出：
 * 用旧代码里就有的 `events.length` + `events.slice()` 直接量出漏响应这件事。
 * 谁把 `imResponses` 写回 `this.events.slice(since)` 的语义，这条就会红。
 */
test('旧写法（events.length 当游标 + slice）会漏掉会话接口响应', () => {
  const { b, emit, im } = mkBrowser();
  for (let i = 0; i < 700; i++) emit('Page.test');
  const lengthCursor = b.events.length;      // ← 旧写法
  const seqCursor = b.seq;                   // ← 新写法
  for (let i = 0; i < 200; i++) emit('Page.test');   // 冲过 800 上限 → splice(0,400)
  im('after-trim');
  assert.equal(b.events.slice(lengthCursor).filter((e) => e.method === 'Network.responseReceived').length, 0,
    '旧写法（长度当下标）在裁剪后取到空区间 —— 会话接口响应就在缓冲里却读不到');
  assert.equal(eventCursorOf(b) > seqCursor, true, '新游标只增不减，裁剪/清空都不受影响');
  assert.equal(b.imResponses(/get_by_conversation/, seqCursor).length, 1, '用新游标取得到');
});

test('中途 goto() 清空事件后，游标之后的新响应仍能取到', () => {
  const { b, emit, im } = mkBrowser();
  for (let i = 0; i < 50; i++) emit('Page.test');
  const since = eventCursorOf(b);
  // goto() 干的事：清空事件 + 清空 messageResponses（真 Browser 的 goto 就这么写）
  b.events = [];
  b.messageResponses.clear();
  im('after-goto');
  assert.equal(b.imResponses(/get_by_conversation/, since).length, 1,
    '导航清空事件后，游标之后的新响应不能丢（ensurePanel / reload 兜底都会导航）');
});

test('游标只增不减：清空事件也不回退', () => {
  const { b, emit } = mkBrowser();
  for (let i = 0; i < 5; i++) emit('Page.test');
  const before = eventCursorOf(b);
  b.events = [];
  emit('Page.test');
  assert.ok(eventCursorOf(b) > before, '游标必须单调递增，不能因为 events 被清空就退回去');
});

test('正常情况（不裁剪不重置）行为不变', () => {
  const { b, emit, im } = mkBrowser();
  for (let i = 0; i < 50; i++) emit('Page.test');
  const since = eventCursorOf(b);
  im('normal');
  assert.equal(b.imResponses(/get_by_conversation/, since).length, 1);
  // 游标之前的事件不该被重复取出
  assert.equal(b.imResponses(/get_by_conversation/, eventCursorOf(b)).length, 0);
});

test('eventsSince：带序号按序号筛，不带序号（假 browser）退回下标语义', () => {
  const withSeq = [{ __seq: 1, n: 'a' }, { __seq: 5, n: 'b' }, { __seq: 9, n: 'c' }];
  assert.deepEqual(eventsSince(withSeq, 5).map((e) => e.n), ['c'], '序号 5 之后只剩 9');
  assert.deepEqual(eventsSince(withSeq, 0).map((e) => e.n), ['a', 'b', 'c'], '游标 0 = 全都要');
  // 老测试手造的假 browser：没 __seq，since 本来就是下标
  const plain = [{ n: 'a' }, { n: 'b' }, { n: 'c' }];
  assert.deepEqual(eventsSince(plain, 1).map((e) => e.n), ['b', 'c'], '没有序号时按下标切');
});

test('eventCursorOf：真 Browser 用序号，假 browser 退回数组长度', () => {
  const { b, emit } = mkBrowser();
  emit('Page.test');
  assert.equal(eventCursorOf(b), b.seq, '真 Browser 返回单调序号');
  assert.equal(eventCursorOf({ events: [1, 2, 3] }), 3, '假 browser（没有 eventCursor）退回长度，保持原语义');
  assert.equal(eventCursorOf(null), 0);
});

test('裁剪后调用方仍能拿到「进会话这一段」的响应（端到端形状）', () => {
  // 复刻 readDMViaApi 的用法：进会话前取游标 → 中间一堆页面事件把它挤出缓冲 → 取响应
  const { b, emit, im } = mkBrowser();
  for (let i = 0; i < 500; i++) emit('Page.test');
  const evSince = eventCursorOf(b);          // 进会话前
  for (let i = 0; i < 600; i++) emit('Page.test');  // 进会话期间的噪声（抖音页面很吵）
  im('conversation-open');                    // 进会话触发的会话接口响应
  for (let i = 0; i < 100; i++) emit('Page.test');
  const hits = b.imResponses(/get_by_conversation/, evSince);
  assert.equal(hits.length, 1, '进会话这一段的会话接口响应必须取得回来，否则解不出 convId');
  assert.equal(hits[0].requestId, 'conversation-open');
});
