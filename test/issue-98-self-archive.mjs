// #98: 鱼自己删除的记忆也能分页找到、恢复，不混进别人的记忆。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { readFileSync } from 'node:fs';
process.env.DSH_HOME = tmpHome('fish-self-archive-');
const { openDatabase } = await import('../lib/db.js');
const { handleSoulRoute } = await import('../lib/routes-soul.js');
const db = openDatabase();
const clock = { now: () => 5000 };
const worker = { queued: [], enqueueRealtime(id) { this.queued.push(id); } };
const insert = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status) VALUES ('feiyu', ?, 'self', '', 'fact', ?, '', 2, 0, 'manual', 1, ?, ?)`);
for (let i = 0; i < 35; i++) insert.run('self', `鱼的记忆 ${i}`, i + 1, 'archived');
insert.run('user:other', '别人的记忆', 999, 'archived');
insert.run('self', '有效记忆', 999, 'active');
async function call(method, path, payload = {}) {
 let result;
 const url = new URL('http://localhost' + path);
 const handled = await handleSoulRoute({ method, path: url.pathname, url, req: {}, res: {}, send: (status, body) => { result = {status, ...body}; }, readBody: async () => JSON.stringify(payload), sameOrigin: () => true, deps: { db, clock, worker } });
 assert.equal(handled, true); return result;
}
const first = await call('GET','/inspector/self-outdated?offset=0');
assert.equal(first.total, 35); assert.equal(first.items.length, 30);
assert(first.items.every(m => m.ownerId === 'self' && m.status === 'archived'));
const second = await call('GET','/inspector/self-outdated?offset=30');
assert.equal(second.items.length, 5); assert.equal(second.total, 35);
assert(!second.items.some(m => first.items.some(n => n.id === m.id)));
const target = second.items[0];
assert.equal((await call('POST','/inspector/memory-restore',{id:target.id})).ok,true);
assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(target.id).status,'active');
assert.deepEqual(worker.queued,[target.id]);
const ui = readFileSync(new URL('../lib/client.soul.js', import.meta.url), 'utf8');
assert.match(ui, /\/inspector\/self-outdated/); assert.match(ui, /选择人物/);
db.close(); console.log('✓ #98 她自己的旧记忆可分页查找和恢复');
