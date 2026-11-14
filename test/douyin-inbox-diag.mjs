// 抖音「私信可能遗漏」「私信待核实」：设置页那块提示已经删了（f8a14fe，主人嫌吵），
// 但排查「消息怎么没回」时还得查得到 —— 现在落到系统页「运行日志」（DiagLog）。
//
// 这个测试钉住：
//   ① 读取失败 / 窗口对不齐产生的缺口 → 日志里有「抖音私信可能有遗漏」
//   ② 处理结果不确定（待核实）→ 日志里有「抖音私信待核实」
//   ③ 处理成功不写（每条消息都写会把 200 条缓冲刷爆）
//   ④ 不传 diag 也不炸（收件箱可以单独用）
//   ⑤ 通道把 diag 传下去，端到端查得到
//   ⑥ 两个 key 在 LABELS 里有人话，不是裸机器名
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-inbox-diag-');
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const { DouyinInbox } = await import('../lib/douyin-inbox.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');
const { DiagLog, describeEntry } = await import('../lib/diag-log.js');

const db = openDatabase();
const SELF = '900001';
const PEER = '7702399256389125000';
const keyOf = (name) => `douyin.conv.${createHash('sha1').update(String(name)).digest('hex').slice(0, 16)}`;
const msg = (id, channelId = 'douyin:Re.') => ({ channelId, messageId: id, text: id, timeMs: Date.now() });
// key 带会话后缀（`douyin-inbox-gap:douyin:Re.`），按前缀找
const gaps = (diag) => diag.list().filter((e) => e.key.startsWith('douyin-inbox-gap'));
const unknowns = (diag) => diag.list().filter((e) => e.key.startsWith('douyin-inbox-unknown'));

// ── ① 缺口 → 运行日志 ──────────────────────────────────────────────────────
test('读取失败产生的缺口会记进运行日志', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const box = new DouyinInbox(db, diag);
  box.beginRead('gap-1', 'douyin:Re.');
  box.failRead('gap-1', '读取失败');
  const list = gaps(diag);
  assert.equal(list.length, 1, `要有一条缺口条目，实际 ${JSON.stringify(diag.list())}`);
  assert.equal(list[0].label, '抖音私信可能有遗漏');
  assert.equal(list[0].detail.channelId, 'douyin:Re.');
  assert.match(list[0].detail.reason, /读取失败/);
});

test('不同会话的缺口不合并成一条（要能看出是哪个会话漏了）', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const box = new DouyinInbox(db, diag);
  box.beginRead('gap-a', 'douyin:甲');
  box.failRead('gap-a', '读取失败');
  box.beginRead('gap-b', 'douyin:乙');
  box.failRead('gap-b', '读取失败');
  const list = gaps(diag);
  assert.equal(list.length, 2, `两个会话的缺口要分开记，实际 ${JSON.stringify(list)}`);
  assert.deepEqual(list.map((e) => e.detail.channelId).sort(), ['douyin:乙', 'douyin:甲']);
  assert.ok(list.every((e) => e.label === '抖音私信可能有遗漏'), `key 带会话名也要说人话：${JSON.stringify(list.map((e) => e.label))}`);
});

test('同一个会话反复缺口合并计数（别刷屏）', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const box = new DouyinInbox(db, diag);
  box.beginRead('gap-c1', 'douyin:丙');
  box.failRead('gap-c1', '读取失败');
  box.beginRead('gap-c2', 'douyin:丙');
  box.failRead('gap-c2', '读取失败');
  const list = gaps(diag);
  assert.equal(list.length, 1, `同一个会话不该刷成多条：${JSON.stringify(list)}`);
  assert.equal(list[0].count, 2);
});

test('两个会话交替出现时，同一会话仍合并（别被队尾换 key 拆开）', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const box = new DouyinInbox(db, diag);
  box.record('gap-alt-1', {}, [], { channelId: 'douyin:未云', reason: '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查' });
  box.record('gap-alt-2', {}, [], { channelId: 'douyin:Re.', reason: '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查' });
  box.record('gap-alt-3', {}, [], { channelId: 'douyin:未云', reason: '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查' });
  box.record('gap-alt-4', {}, [], { channelId: 'douyin:Re.', reason: '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查' });
  const list = gaps(diag);
  assert.equal(list.length, 2, `交替出现仍应各留一条：${JSON.stringify(list.map((e) => [e.detail.channelId, e.count]))}`);
  assert.deepEqual(list.map((e) => e.count).sort(), [2, 2]);
});

test('窗口对不齐产生的缺口会记进运行日志', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const box = new DouyinInbox(db, diag);
  box.record('gap-2', {}, [], { channelId: 'douyin:未云', reason: '消息窗口无法完整对齐或超过补收条数，可能有遗漏，请手动检查' });
  const list = gaps(diag);
  assert.equal(list.length, 1, `要有一条缺口条目，实际 ${JSON.stringify(diag.list())}`);
  assert.equal(list[0].detail.channelId, 'douyin:未云');
  assert.match(list[0].detail.reason, /窗口无法完整对齐/);
});

// ── ② 待核实 → 运行日志 ────────────────────────────────────────────────────
test('处理结果不确定（待核实）会记进运行日志', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const box = new DouyinInbox(db, diag);
  box.record('unk-1', {}, [msg('u1', 'douyin:待核实')]);
  const row = box.next();
  box.start(row.id);
  box.settle([row.id], false, '未取得处理确认，请核实');
  const list = unknowns(diag);
  assert.equal(list.length, 1, `要有一条待核实条目，实际 ${JSON.stringify(diag.list())}`);
  assert.equal(list[0].label, '抖音私信待核实');
  assert.equal(list[0].detail.channelId, 'douyin:待核实');
  assert.equal(list[0].detail.count, 1);
  assert.match(list[0].detail.error, /未取得处理确认/);
});

test('不同会话的待核实也分开记', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const box = new DouyinInbox(db, diag);
  box.record('unk-2', {}, [msg('x1', 'douyin:丁'), msg('x2', 'douyin:戊')]);
  const a = box.next();
  box.start(a.id);
  const b = box.next();
  box.start(b.id);
  box.settle([a.id, b.id], false, '未取得处理确认，请核实');
  const list = unknowns(diag);
  assert.equal(list.length, 2, `两个会话的待核实要分开记，实际 ${JSON.stringify(list)}`);
  assert.deepEqual(list.map((e) => e.detail.channelId).sort(), ['douyin:丁', 'douyin:戊']);
  assert.deepEqual(list.map((e) => e.detail.count).sort(), [1, 1]);
});

// ── ③ 正常收到私信不写日志 ────────────────────────────────────────────────
test('处理成功不写运行日志（每条消息都写会把 200 条缓冲刷爆）', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const box = new DouyinInbox(db, diag);
  box.record('ok-1', {}, [msg('o1', 'douyin:正常')]);
  const row = box.next();
  box.start(row.id);
  box.settle([row.id], true);
  assert.equal(diag.list().filter((e) => e.key.startsWith('douyin-inbox-')).length, 0, '正常消息不该进运行日志');
});

// ── ④ 不传 diag 也能用 ────────────────────────────────────────────────────
test('不传 diag 也能用（收件箱可以单独用）', () => {
  const box = new DouyinInbox(db);
  box.record('nd-1', {}, [msg('n1', 'douyin:单独用')]);
  const row = box.next();
  box.start(row.id);
  box.settle([row.id], false, '处理结果不确定，请核实');
  box.beginRead('nd-2', 'douyin:单独用');
  box.failRead('nd-2');
});

// ── ⑤ 端到端：通道把 diag 传下去 ──────────────────────────────────────────
test('通道读失败时，运行日志里查得到缺口', async () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const key = keyOf('未云');
  setKv(db, key, { name: '未云', sig: '旧', window: [] });
  const ch = new DouyinChannel({
    db, diag,
    host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => ({}),
    driver: { read: async () => ({ ok: false, error: '拿不到会话 ID' }) },
  });
  await ch.readConversation({ c: {}, name: '未云', key, st: getKv(db, key, null), sig: '新', unread: false });
  const list = gaps(diag);
  assert.equal(list.length, 1, `读失败要留下缺口条目，实际 ${JSON.stringify(diag.list())}`);
  assert.equal(list[0].detail.channelId, 'douyin:未云');
});

test('消息处理没把握时，运行日志里查得到「待核实」', async () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  const key = keyOf('Re.');
  setKv(db, key, { name: 'Re.', sig: '旧', window: [] });
  const ch = new DouyinChannel({
    db, diag,
    host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => ({}),
    driver: {
      read: async () => {
        const convId = `0:1:${SELF}:${PEER}`;
        return { ok: true, convId, messages: [{ fromMe: false, senderId: PEER, convId, text: '在吗', time: Date.now() }] };
      },
    },
  });
  await ch.readConversation({ c: {}, name: 'Re.', key, st: getKv(db, key, null), sig: '新', unread: true });
  const list = unknowns(diag);
  assert.equal(list.length, 1, `处理没把握要留下待核实条目，实际 ${JSON.stringify(diag.list())}`);
  assert.equal(list[0].label, '抖音私信待核实');
});

// ── ⑥ 人话 + 说明 ─────────────────────────────────────────────────────────
test('这两个 key 在运行日志里有人话，不是裸机器名', () => {
  const diag = new DiagLog({ db, now: () => Date.now() });
  diag.add('douyin-inbox-gap', {});
  diag.add('douyin-inbox-unknown', {});
  const labels = diag.list().map((e) => e.label);
  assert.ok(labels.includes('抖音私信可能有遗漏'), `缺「抖音私信可能有遗漏」：${JSON.stringify(labels)}`);
  assert.ok(labels.includes('抖音私信待核实'), `缺「抖音私信待核实」：${JSON.stringify(labels)}`);
});

test('中文说明里能看到「几条」「为什么」', () => {
  const text = describeEntry({ key: 'douyin-inbox-unknown', detail: { channelId: 'douyin:Re.', count: 2, error: '未取得处理确认' }, count: 1 });
  assert.match(text, /聊天 douyin:Re\./, `要说清是哪个会话：${text}`);
  assert.match(text, /2 条/, `要说清几条：${text}`);
  assert.match(text, /未取得处理确认/, `要说清为什么：${text}`);
});

// ── ⑦ 面板上的「运行日志」页要说人话 ──────────────────────────────────────
/** 用假 React 把设置页「系统 → 运行日志」渲染一遍，收下画出来的文字。 */
function renderDiagPane(entries) {
  const source = readFileSync(new URL('../lib/client.diag.js', import.meta.url), 'utf8');
  let factory;
  let preset = null;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    // useState(false) 是「看原始」开关，useState(null) 是数据 —— 只给数据塞预设值
    useState: (v) => [v === null ? preset : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f; } } } });
  const { DiagPane } = factory(() => react);
  const stub = (name) => (props, ...children) => ({ name, props, children });
  const ui = {
    h: react.createElement,
    Group: stub('Group'), Tag: stub('Tag'), Button: stub('Button'),
    Muted: (text) => ({ name: 'Muted', props: text }),
  };
  preset = { entries };
  return DiagPane({ api: async () => ({ ok: true }), notify: () => {}, ui });
}

test('「运行日志」页上能看到抖音那两条提示', () => {
  const tree = renderDiagPane([
    { at: Date.now(), key: 'douyin-inbox-gap', label: '抖音私信可能有遗漏', level: 'warn', detail: { channelId: 'douyin:Re.', reason: '读取失败' }, count: 1 },
    { at: Date.now(), key: 'douyin-inbox-unknown', label: '抖音私信待核实', level: 'warn', detail: { channelId: 'douyin:Re.', count: 2, error: '未取得处理确认，请核实' }, count: 1 },
  ]);
  const text = JSON.stringify(tree);
  assert.ok(text.includes('抖音私信可能有遗漏'), `要显示标题：${text}`);
  assert.ok(text.includes('读取失败'), `要显示缺口原因：${text}`);
  assert.ok(text.includes('2 条'), `要显示几条：${text}`);
  assert.ok(text.includes('未取得处理确认'), `要显示为什么待核实：${text}`);
});

test.after(() => db.close());
console.log('douyin-inbox-diag ok');
