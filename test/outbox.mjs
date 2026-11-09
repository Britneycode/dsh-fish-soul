// QQ 重发队列：没连上排队、连上补发、顺序不乱、超时放弃、可能已发出的不重发。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Outbox, classifySendError } from '../lib/outbox.js';

assert.equal(classifySendError(new Error('QQ 未连接')), 'retry');
assert.equal(classifySendError(new Error('发送失败（retcode 1200）')), 'retry');
assert.equal(classifySendError(new Error('连接已断开')), 'unknown');
assert.equal(classifySendError(new Error('send_group_msg 超时')), 'unknown');

let now = 1_000_000;
const sent = []; const gaveUp = []; const ok = [];
let mode = 'down';
const channel = {
	connected: false,
	async send(cid, segs) {
		if (mode === 'down') throw new Error('QQ 未连接');
		if (mode === 'ambiguous') throw new Error('连接已断开');
		sent.push([cid, segs[0].data.text]);
		return String(sent.length);
	}
};
const db = new DatabaseSync(':memory:');
const box = new Outbox({
	db, channel, windowMs: () => 10 * 60_000, now: () => now,
	onSent: (id, item) => ok.push([id, item.text]),
	onGiveUp: (item, reason) => gaveUp.push([item.text, reason])
});
const seg = (t) => [{ type: 'text', data: { text: t } }];

box.enqueue({ channelId: 'private:1', segs: seg('a'), text: 'a' });
box.enqueue({ channelId: 'private:1', segs: seg('b'), text: 'b' });
box.enqueue({ channelId: 'group:2', segs: seg('c'), text: 'c' });
assert.equal(box.hasQueued('private:1'), true);
assert.equal(box.size(), 3);

// 没连上：不发、不算次数
await box.flush({ force: true });
assert.equal(sent.length, 0);
assert.equal(box.size(), 3);

// 连上了：按顺序补发
channel.connected = true; mode = 'up';
await box.flush({ force: true });
assert.deepEqual(sent, [['private:1', 'a'], ['private:1', 'b'], ['group:2', 'c']]);
assert.equal(box.size(), 0);
assert.equal(ok.length, 3);

// 超过回复时限：放弃
box.enqueue({ channelId: 'private:1', segs: seg('old'), text: 'old' });
now += 11 * 60_000;
await box.flush({ force: true });
assert.equal(box.size(), 0);
assert.match(gaveUp.at(-1)[1], /超过回复时限/);

// 重发时变成"可能已发出"：不再重发，后面的照常
box.enqueue({ channelId: 'private:9', segs: seg('x'), text: 'x' });
mode = 'ambiguous';
await box.flush({ force: true });
assert.equal(box.size(), 0);
assert.match(gaveUp.at(-1)[1], /可能已经发出去了/);

// 一直被拒：退避，重试用完放弃
mode = 'down';
box.enqueue({ channelId: 'private:5', segs: seg('y'), text: 'y' });
for (let i = 0; i < 5; i++) await box.flush({ force: true });
assert.equal(box.size(), 0);
assert.match(gaveUp.at(-1)[1], /重发 5 次都没成功/);

box.stop();

// 断线且已到期时不能用零延迟循环；重连时仍能强制立即发送。
{
 const db2 = new DatabaseSync(':memory:');
 const c = { connected: false, async send() { return 'ok'; } };
 const q = new Outbox({ db: db2, channel: c, windowMs: () => 600_000, now: () => 100_000 });
 q.enqueue({ channelId: 'private:2', segs: seg('offline') });
 db2.prepare("UPDATE outbox SET next_at = ?").run(1);
 let delay;
 q.schedule = (d) => { delay = d; };
 await q.flush();
 assert.ok(delay >= 1000, `断线后不应忙等，delay=${delay}`);
 c.connected = true;
 await q.flush({ force: true });
 assert.equal(q.size(), 0);
 q.stop(); db2.close();
}
// 重启时 sending 是未知结果，绝不可自动重发。
{
 const db2 = new DatabaseSync(':memory:');
 let sends = 0; const warnings = [];
 const c = { connected: true, async send() { sends++; return 'id'; } };
 const q1 = new Outbox({ db: db2, channel: c, windowMs: () => 600_000, now: () => 100_000 });
 q1.enqueue({ channelId: 'private:3', segs: seg('possibly sent'), text: 'possibly sent' });
 db2.prepare("UPDATE outbox SET status = 'sending'").run(); q1.stop();
 const q2 = new Outbox({ db: db2, channel: c, windowMs: () => 600_000, now: () => 100_000, onGiveUp: (item, reason) => warnings.push([item.text, reason]) });
 await q2.flush({ force: true });
 assert.equal(sends, 0);
 assert.equal(db2.prepare('SELECT status FROM outbox').get().status, 'unknown');
 assert.match(warnings[0][1], /可能已经发出/);
 q2.stop(); db2.close();
}
// 发送完成回调出错不能将已发送消息重新标为可重试。
{
 const db2 = new DatabaseSync(':memory:');
 const q = new Outbox({ db: db2, channel: { connected: true, async send() { return 'id'; } }, windowMs: () => 600_000, now: () => 100_000, onSent() { throw Error('未连接'); } });
 q.enqueue({ channelId: 'private:4', segs: seg('sent') });
 await q.flush({ force: true });
 assert.equal(db2.prepare('SELECT status FROM outbox').get().status, 'sent');
 q.stop(); db2.close();
}

// 真实子进程在发送过程中退出，磁盘数据库重开后不可重发。
{
 const { mkdtempSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const { spawnSync } = await import('node:child_process');
 const dir = mkdtempSync(join(tmpdir(), 'fish-outbox-crash-'));
 const path = join(dir, 'test.db');
 try {
  const script = `import { DatabaseSync } from 'node:sqlite';
   import { Outbox } from './lib/outbox.js';
   const db = new DatabaseSync(process.argv[1]);
   const q = new Outbox({ db, channel: { connected: true, async send() { process.exit(0); } }, windowMs: () => 600000 });
   q.enqueue({ channelId: 'private:5', segs: [{ type: 'text', data: { text: 'x' } }] });
   await q.flush({ force: true });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const db2 = new DatabaseSync(path);
  assert.equal(db2.prepare('SELECT status FROM outbox').get().status, 'sending');
  let sends = 0;
  const q = new Outbox({ db: db2, channel: { connected: true, async send() { sends++; } }, windowMs: () => 600_000 });
  await q.flush({ force: true });
  assert.equal(sends, 0);
  assert.equal(db2.prepare('SELECT status FROM outbox').get().status, 'unknown');
  q.stop(); db2.close();
 } finally { rmSync(dir, { recursive: true, force: true }); }
}
// 重发 await 期间同聊天的新消息也应排队，避免插队。
{
 const db2 = new DatabaseSync(':memory:');
 let release; const waiting = new Promise((resolve) => { release = resolve; });
 const q = new Outbox({ db: db2, channel: { connected: true, async send() { await waiting; return 'id'; } }, windowMs: () => 600_000 });
 q.enqueue({ channelId: 'private:6', segs: seg('first') });
 const pending = q.flush({ force: true });
 assert.equal(q.hasQueued('private:6'), true);
 release(); await pending;
 q.stop(); db2.close();
}

console.log('✓ QQ 重发队列：退避、顺序、重连、崩溃恢复及未知状态保护');
