import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tmpHome } from './_tmp.mjs';

// 设置页去掉两块提示噪音（主人明确要求）：
//   ①「私信可能遗漏 · xxx」+「已知晓」      ← d.channel.inbox.gaps
//   ②「私信待核实 · xxx」+「核实未处理 / 已核实忽略」 ← d.channel.inbox.review
//
// 光删 UI 会留一个坑：**一条 unknown 会挡住同会话后面所有消息**
// （next() 的 NOT EXISTS (... u.status='unknown' AND u.id<m.id)）。
// 面板不再给处理入口 ⇒ unknown 只能自动过期，否则那个会话永久哑掉。
// 同理，没人再点「已知晓」的缺口记录会永远堆在表里。
//
// 后端返回结构不动（gaps / review / counts 都还在），只是面板不渲染。

process.env.DSH_HOME = tmpHome('douyin-inbox-noise-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinInbox } = await import('../lib/douyin-inbox.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');

const db = openDatabase();
const inbox = new DouyinInbox(db);
const HOUR = 3600_000;
const DAY = 86_400_000;
const msg = (id, channelId = 'douyin:noise') => ({ channelId, messageId: id, text: id, timeMs: Date.now() });
const rowOf = (id) => db.prepare('SELECT status,error FROM douyin_inbox WHERE id=?').get(id);
/** 把某条记录的时间戳往前挪 ms 毫秒（用来造「很旧」的记录）。 */
const age = (id, ms) => db.prepare('UPDATE douyin_inbox SET updated_at=? WHERE id=?').run(Date.now() - ms, id);
/** 按消息 id 取行 id（各条消息各用各的会话，别互相挡着 —— 一条 unknown 只挡同会话）。 */
const idsOf = (...messageIds) => Object.fromEntries(
  db.prepare(`SELECT id,message_id FROM douyin_inbox WHERE message_id IN (${messageIds.map(() => '?').join(',')})`).all(...messageIds).map((r) => [r.message_id, r.id]),
);

// ── ① 超期的待核实要自动作废，队列才能继续走 ────────────────────────────────
test('超期没核实的消息自动作废，同会话后面的消息能继续走', () => {
  const box = new DouyinInbox(db);
  box.record('noise-cursor', {}, [msg('n1', 'douyin:noise-1'), msg('n2', 'douyin:noise-1')]);
  const first = box.next();
  box.start(first.id);
  box.settle([first.id], false); // 处理结果不确定 → unknown
  assert.equal(rowOf(first.id).status, 'unknown');
  assert.equal(box.next(), null, '一条 unknown 挡住同会话后面所有消息');

  age(first.id, 25 * HOUR);
  assert.equal(box.expireStaleUnknown(), 1, '超期的那条要自动作废');
  assert.equal(rowOf(first.id).status, 'dismissed');
  assert.match(rowOf(first.id).error, /已自动忽略/, '要写明是自动忽略的');

  const after = box.next();
  assert.ok(after, '过期之后队列要能继续走');
  assert.equal(JSON.parse(after.payload).messageId, 'n2');
});

test('没超期的待核实不自动作废（还有时间核实）', () => {
  const box = new DouyinInbox(db);
  box.record('noise-cursor-fresh', {}, [msg('f1', 'douyin:noise-2'), msg('f2', 'douyin:noise-2')]);
  const first = box.next();
  box.start(first.id);
  box.settle([first.id], false);
  age(first.id, 2 * HOUR);
  assert.equal(box.expireStaleUnknown(), 0, '两小时内的不算超期');
  assert.equal(rowOf(first.id).status, 'unknown');
});

test('待处理 / 处理中的消息不因为过期被清掉', () => {
  const box = new DouyinInbox(db);
  box.record('noise-cursor-alive', {}, [msg('a1', 'douyin:alive-1'), msg('a2', 'douyin:alive-2')]);
  const ids = idsOf('a1', 'a2');
  age(ids.a1, 30 * DAY); // 很旧的待处理
  box.start(ids.a2); // 很旧的处理中
  age(ids.a2, 30 * DAY);
  assert.equal(box.expireStaleUnknown(), 0, '只有 unknown 会被过期');
  assert.equal(rowOf(ids.a1).status, 'pending');
  assert.equal(rowOf(ids.a2).status, 'processing');
});

// ── ② 缺口记录不再无限增长 ────────────────────────────────────────────────
test('没人点「已知晓」的缺口记录超期后清掉，近期的留着', () => {
  const box = new DouyinInbox(db);
  const ins = db.prepare('INSERT INTO douyin_inbox_gap(channel_id,reason,created_at) VALUES(?,?,?)');
  ins.run('douyin:old-gap', '老缺口', Date.now() - 8 * DAY);
  ins.run('douyin:new-gap', '新缺口', Date.now() - 2 * DAY);
  assert.equal(box.pruneGaps(), 1, '只清超期的那条');
  const left = db.prepare('SELECT channel_id FROM douyin_inbox_gap').all().map((r) => r.channel_id);
  assert.ok(left.includes('douyin:new-gap'), '近期的缺口要留着');
  assert.ok(!left.includes('douyin:old-gap'), '超期的缺口要清掉');
});

// ── ③ 轮询里要真的调这两个清理 ────────────────────────────────────────────
/** 造一个只跑到「轮询收尾」的通道：驱动、读队列、自检都打桩。 */
function makeChannel() {
  const ch = new DouyinChannel({
    db,
    host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
    getConfig: () => ({ enabled: true }),
    log: () => {},
    onMessage: async () => ({ done: true }),
    driver: { checkLogin: async () => true, list: async () => ({ ok: true, conversations: [] }) },
  });
  ch.drainInbox = async () => {};
  ch.runCanary = async () => {};
  return ch;
}

test('轮询每轮都会把超期的待核实作废', async () => {
  const box = new DouyinInbox(db);
  box.record('noise-poll', {}, [msg('p1', 'douyin:noise-poll'), msg('p2', 'douyin:noise-poll')]);
  const first = box.next();
  box.start(first.id);
  box.settle([first.id], false);
  age(first.id, 25 * HOUR);

  const ch = makeChannel();
  await ch.pollInner();
  assert.equal(rowOf(first.id).status, 'dismissed', '轮询一轮就该清掉超期的待核实');
});

test('轮询每轮都会清掉没人确认的缺口提示', async () => {
  const ch = makeChannel();
  const calls = [];
  ch.inbox.pruneGaps = () => { calls.push('pruneGaps'); return 0; };
  ch.inbox.expireStaleUnknown = () => { calls.push('expireStaleUnknown'); return 0; };
  await ch.pollInner();
  assert.ok(calls.includes('pruneGaps'), '轮询里要清缺口提示');
  assert.ok(calls.includes('expireStaleUnknown'), '轮询里要过期待核实');
});

// ── ④ 后端返回结构不许变 ───────────────────────────────────────────────────
test('后端返回结构不变：gaps / review / counts 都还在', () => {
  const st = inbox.status();
  assert.ok(Array.isArray(st.gaps), 'gaps 还要返回');
  assert.ok(Array.isArray(st.review), 'review 还要返回');
  assert.ok(st.counts && typeof st.counts === 'object', 'counts 还要返回');
});

// ── ⑤ 面板不再渲染这两块 ───────────────────────────────────────────────────
/** 用假 React 把设置页「抖音」页渲染一遍，收下所有 Row 的标题和按钮。 */
function renderPane(data) {
  const source = readFileSync(new URL('../lib/client.douyin.js', import.meta.url), 'utf8');
  let factory;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f; } } } });
  const { DouyinPane } = factory(() => react);

  const rows = [];
  const buttons = [];
  const notes = [];
  const stub = (name) => (props, ...children) => ({ name, props, children });
  const ui = {
    h: react.createElement,
    Switch: stub('Switch'),
    Button: (props, ...children) => { buttons.push(children); return { name: 'Button', props, children }; },
    IconButton: stub('IconButton'),
    State: stub('State'),
    Tag: stub('Tag'),
    Muted: (text) => { notes.push(String(text)); return { name: 'Muted', props: text }; },
    Row: (props, ...children) => { rows.push(props); return { name: 'Row', props, children }; },
    Group: stub('Group'),
    Input: stub('Input'),
    Num: stub('Num'),
    Area: stub('Area'),
    Select: stub('Select'),
    Item: stub('Item'),
    Seg: stub('Seg'),
    Empty: stub('Empty'),
    Dot: stub('Dot'),
    useForm: (_data, init) => [init(), () => {}, () => {}],
  };
  DouyinPane({ data, refresh: () => {}, notify: () => {}, api: async () => ({ ok: true }), relTime: () => '刚刚', ui });
  return { rows, buttons, notes };
}

const panelData = {
  douyin: {
    enabled: true,
    autoReply: true,
    masterName: '', masterUid: '', allowList: [], groups: [], callNames: [],
    browserPref: { kind: 'edge', customPath: '' },
    browse: { perDay: 3, videosPerSession: 3, enabled: false, mode: 'http', share: false, shareInDm: false, frames: false, framesPerDay: 2 },
    post: { perDay: 1, enabled: false },
    comments: { perHour: 4, enabled: false, emoji: false },
    social: { recent: [] },
    host: { state: 'stopped', browsers: [] },
    channel: {
      identityBlocked: false,
      identityState: { selfUids: ['999'], disabledByFlag: false },
      inbox: {
        counts: { processing: 1, unknown: 12, pending: 2 },
        gaps: [{ id: 1, channelId: 'douyin:Re.', reason: '读取过程中断，请手动检查' }],
        gapCount: 12,
        review: [{ id: 5, channelId: 'douyin:Re.', text: '在吗' }],
        unknownTotal: 12,
        pendingTotal: 2,
      },
    },
  },
};

test('设置页不再渲染「私信可能遗漏」「私信待核实」', () => {
  const { rows } = renderPane(panelData);
  const titles = rows.map((r) => String(r?.title ?? ''));
  for (const bad of ['私信可能遗漏', '私信待核实', '遗漏提示', '条待核实']) {
    assert.ok(!titles.some((t) => t.includes(bad)), `不该再出现「${bad}」：${JSON.stringify(titles)}`);
  }
});

test('设置页不再给这两块留处理按钮', () => {
  const { buttons } = renderPane(panelData);
  const labels = buttons.flat().filter((c) => typeof c === 'string');
  for (const bad of ['已知晓', '全部已知晓', '核实未处理，重新处理', '已核实，忽略', '已核实，全部忽略']) {
    assert.ok(!labels.includes(bad), `不该再有「${bad}」按钮：${JSON.stringify(labels)}`);
  }
  const src = readFileSync(new URL('../lib/client.douyin.js', import.meta.url), 'utf8');
  for (const route of ['/douyin/inbox-gap-ack', '/douyin/inbox-resolve', '/douyin/inbox-dismiss-all']) {
    assert.ok(!src.includes(route), `面板不该再调 ${route}`);
  }
});

test('「主人身份」的说明不再指向已经删掉的待核实列表', () => {
  const { rows } = renderPane(panelData);
  const master = rows.find((r) => String(r?.title ?? '').includes('主人身份'));
  assert.ok(master, '主人身份那一行要还在');
  assert.ok(!String(master.desc ?? '').includes('私信待核实'), '说明里不该再让人去待核实列表里看 uid');
});

test('「正在处理 N 条」保留（那是处理中计数，不是那两块噪音）', () => {
  const { notes } = renderPane(panelData);
  assert.ok(notes.some((t) => t.includes('正在处理')), '处理中计数要留着');
});
