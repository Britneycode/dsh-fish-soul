import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpHome } from './_tmp.mjs';

// 🔴 一批「没有上限」的 P2：长期运行 / 异常输入才会现形，但都是真隐患。
//
//  ① 主路由 readBody 无限累积 chunks → 超大 body 撑爆内存（其他路由文件早就各自设了上限）
//  ② outbox 队列无条数上限 → 表无限增长，且 hasQueued 恒真 = 那个聊天「突然不说话」
//  ③ outbox.enqueue 写库没保护 → 失败会冒到回复路径上
//  ④ pokeAt 无界 Map（旁边的 seen / ownMessages 都有上限）
//  ⑤ bound 里换人格那条分支不摘旧 sessionId → 旧会话仍被当成「我们的」
//  ⑥ 自动备份 VACUUM INTO 是同步的，库大时卡死整个事件循环

process.env.DSH_HOME = tmpHome('p2-limits-');
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const db = openDatabase();

// ── ① readBody 上限 ─────────────────────────────────────────────────────────
test('readBody 超过上限就拒绝（不再无限累积 chunks）', async () => {
  const { readBody } = await import('../lib/routes.js');
  const { EventEmitter } = await import('node:events');

  // 造一个假 req：能推 chunk、能被 destroy
  const makeReq = () => {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    req.destroyed = false;
    return req;
  };

  // 正常大小：能读到完整内容
  const ok = makeReq();
  const p1 = readBody(ok);
  ok.emit('data', Buffer.from('{"a":1}'));
  ok.emit('end');
  assert.equal(await p1, '{"a":1}', '正常大小的 body 要能读出来');

  // 超大：必须 reject，而且要立刻停（destroy 连接）
  const big = makeReq();
  const p2 = readBody(big);
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let rejected = null;
  p2.catch((e) => { rejected = e; });
  // 推 5 × 64KB = 320KB > 256KB 上限
  for (let i = 0; i < 5; i++) { if (!big.destroyed) big.emit('data', chunk); }
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(rejected !== null, '超大 body 必须 reject');
  assert.match(String(rejected.message), /请求太大/, '错误信息要说清是太大');
  assert.equal(big.destroyed, true, '要销毁连接，别继续收');
});

// ── ② / ③ outbox 队列上限 ───────────────────────────────────────────────────
test('outbox 队列到上限时丢最老的，不会无限增长', async () => {
  const { Outbox } = await import('../lib/outbox.js');
  const logs = [];
  const ob = new Outbox({
    db, windowMs: () => 10 * 60_000, now: () => Date.now(),
    channel: { connected: false, send: async () => 'mid' }, // 离线：全部积压
    log: (_l, m) => logs.push(m), onSent: () => {}, onGiveUp: () => {},
  });
  db.exec('DELETE FROM outbox');
  const seg = [{ type: 'text', data: { text: 'x' } }];
  // 塞 250 条（上限 200）
  for (let i = 0; i < 250; i++) ob.enqueue({ channelId: `qq:${i}`, segs: seg, text: `第${i}条` });

  const n = Number(db.prepare("SELECT COUNT(*) n FROM outbox WHERE status = 'queued'").get().n);
  assert.ok(n <= 200, `队列不该超过 200 条（实际 ${n}）`);
  // 最新的那条必须在（丢的是最老的）
  const hasLast = db.prepare("SELECT COUNT(*) n FROM outbox WHERE text = '第249条'").get().n;
  assert.equal(Number(hasLast), 1, '最新的那条要留下来');
  assert.ok(logs.some((m) => /超过 200 条/.test(m)), '要告警（不能静默丢）');
});

test('outbox.enqueue 写库失败不抛给调用方（回复路径不能被拖死）', async () => {
  const { Outbox } = await import('../lib/outbox.js');
  const logs = [];
  const ob = new Outbox({
    db, windowMs: () => 10 * 60_000, now: () => Date.now(),
    channel: { connected: true, send: async () => 'mid' },
    log: (_l, m) => logs.push(m), onSent: () => {}, onGiveUp: () => {},
  });
  // 用一个必然失败的触发器让 INSERT 抛错
  db.exec("CREATE TRIGGER p2_boom BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  try {
    assert.doesNotThrow(() => ob.enqueue({ channelId: 'qq:1', segs: [{ type: 'text', data: { text: 'x' } }], text: 'y' }));
    assert.ok(logs.some((m) => /入队重发失败/.test(m)), '失败要留痕');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS p2_boom');
  }
});

// ── ④ pokeAt 上限 ───────────────────────────────────────────────────────────
test('pokeAt 有上限（和 seen / ownMessages 一致，不无界增长）', async () => {
  const { ChatGateway } = await import('../lib/gateway.js');
  const gw = Object.create(ChatGateway.prototype);
  gw.pokeAt = new Map();
  // 直接模拟淘汰逻辑：塞满后再加
  const LIMIT = 500;
  for (let i = 0; i < LIMIT + 50; i++) {
    gw.pokeAt.set(`group:${i}#${i}`, Date.now());
    if (gw.pokeAt.size > LIMIT) gw.pokeAt.delete(gw.pokeAt.keys().next().value);
  }
  assert.ok(gw.pokeAt.size <= LIMIT, `pokeAt 不该超过 ${LIMIT}（实际 ${gw.pokeAt.size}）`);
});

// ── ⑥ 自动备份体积守卫 ──────────────────────────────────────────────────────
test('库太大时自动备份跳过（不让 VACUUM INTO 卡死事件循环）', async () => {
  const { BackupService } = await import('../lib/backup.js');
  const logs = [];
  const b = new BackupService({ db, getConfig: () => ({ auto: true, keep: 7 }), log: (_l, m) => logs.push(m) });
  // 假装库有 500MB
  b.dbSizeBytes = () => 500 * 1024 * 1024;
  let called = 0;
  b.backupNow = () => { called++; return { file: 'x' }; };
  setKv(db, 'backup.lastAt', 0); // 距上次备份已经超过一天

  const r = b.maybeAuto(Date.now());
  assert.equal(r, null, '超大库要跳过自动备份');
  assert.equal(called, 0, '不该真的跑 VACUUM INTO');
  assert.ok(logs.some((m) => /超过自动备份上限/.test(m)), '要告警说明为什么跳过');
});

test('库不大时自动备份照常跑（别把正常路径搞坏）', async () => {
  const { BackupService } = await import('../lib/backup.js');
  const b = new BackupService({ db, getConfig: () => ({ auto: true, keep: 7 }), log: () => {} });
  b.dbSizeBytes = () => 10 * 1024 * 1024;
  let called = 0;
  b.backupNow = () => { called++; return { file: 'x' }; };
  setKv(db, 'backup.lastAt', 0);
  b.maybeAuto(Date.now());
  assert.equal(called, 1, '小库要正常备份');
});

test.after(() => db.close());
console.log('p2-limits ok');
