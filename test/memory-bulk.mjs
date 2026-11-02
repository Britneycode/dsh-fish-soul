// 记忆批量操作：勾选 / 按筛选、删除 / 恢复 / 重要度 / 类型 / 私密、dryRun、防误删全部。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'fs-bulk-'));
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { bulkMemory, filterWhere } = await import('../lib/memory-bulk.js');
const db = openDatabase();
const clock = { now: () => 1000 };
const worker = { q: [], enqueueRealtime(id, t) { this.q.push(id); } };
const ins = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
	VALUES ('feiyu', ?, 'qq-private', '', 'fact', ?, '', 2, 0, ?, 1, 1, 'active')`);
const ids = [];
for (let i = 0; i < 6; i++) ids.push(Number(ins.run('user:a', `阿甲的第 ${i} 件事`, i < 4 ? 'history-import' : 'sess-1').lastInsertRowid));
for (let i = 0; i < 3; i++) ids.push(Number(ins.run('user:b', `阿乙喜欢猫 ${i}`, 'manual').lastInsertRowid));
db.prepare('INSERT INTO vec (memory_id, model_id, generation_id, dim, blob) VALUES (?, ?, 1, 1, ?)').run(ids[0], 'm', Buffer.alloc(4));
const active = () => db.prepare("SELECT COUNT(*) AS n FROM memory WHERE status = 'active'").get().n;

// 勾选删除
let r = bulkMemory({ db, clock, worker, ids: [ids[0], ids[1], 99999], action: 'forget' });
assert.deepEqual([r.ok, r.changed], [true, 2]);
assert.equal(active(), 7);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vec WHERE memory_id = ?').get(ids[0]).n, 0, '向量一起清');
// 恢复
r = bulkMemory({ db, clock, worker, ids: [ids[0], ids[1]], action: 'restore' });
assert.equal(r.changed, 2); assert.equal(active(), 9); assert.deepEqual(worker.q, [ids[0], ids[1]], '恢复的重新进向量队列');
// 重要度 / 类型 / 私密
r = bulkMemory({ db, clock, worker, ids: ids.slice(6), action: 'importance', value: 5 });
assert.equal(r.changed, 3);
assert.equal(db.prepare('SELECT importance FROM memory WHERE id = ?').get(ids[6]).importance, 5);
assert.equal(bulkMemory({ db, clock, worker, ids: ids.slice(6), action: 'importance', value: 9 }).ok, false);
assert.equal(bulkMemory({ db, clock, worker, ids: [ids[2]], action: 'kind', value: 'event' }).changed, 1);
assert.equal(bulkMemory({ db, clock, worker, ids: [ids[2]], action: 'kind', value: 'xx' }).ok, false);
assert.equal(bulkMemory({ db, clock, worker, ids: [ids[3]], action: 'visibility', value: 'private' }).changed, 1);
assert.equal(db.prepare('SELECT visibility FROM memory WHERE id = ?').get(ids[3]).visibility, 'private');
assert.equal(bulkMemory({ db, clock, worker, ids: [ids[3]], action: 'nope' }).ok, false);
assert.equal(bulkMemory({ db, clock, worker, ids: [], action: 'forget' }).ok, false);

// 按筛选：防误删全部
r = bulkMemory({ db, clock, worker, filter: {}, action: 'forget' });
assert.equal(r.ok, false);
assert.match(r.error, /至少/);
// dryRun 只数
r = bulkMemory({ db, clock, worker, filter: { ownerId: 'user:a', source: 'history-import' }, action: 'forget', dryRun: true });
assert.deepEqual([r.matched, r.changed], [4, 0]);
assert.equal(active(), 9);
r = bulkMemory({ db, clock, worker, filter: { ownerId: 'user:a', source: 'history-import' }, action: 'forget' });
assert.equal(r.changed, 4); assert.equal(active(), 5);
r = bulkMemory({ db, clock, worker, filter: { q: '猫' }, action: 'visibility', value: 'private', dryRun: true });
assert.equal(r.matched, 3);
r = bulkMemory({ db, clock, worker, filter: { source: 'chat' }, action: 'importance', value: 3 });
assert.equal(r.changed, 2, '「聊天里记的」= 不是导入也不是手动');
// 按筛选恢复（只在删掉 / 过时的里找）
r = bulkMemory({ db, clock, worker, filter: { ownerId: 'user:a', source: 'history-import' }, action: 'restore' });
assert.equal(r.changed, 4); assert.equal(active(), 9);
// 筛选用参数绑定，带引号也不出错
assert.equal(bulkMemory({ db, clock, worker, filter: { q: "'); DROP TABLE memory; --" }, action: 'forget', dryRun: true }).matched, 0);
assert.ok(filterWhere({ ownerId: 'all' }).narrowed === false);

db.close();
rmSync(home, { recursive: true, force: true });
console.log('✓ 记忆批量：勾选 / 筛选、删除清向量、恢复重进队列、重要度 / 类型 / 私密、dryRun、防误删全部');
