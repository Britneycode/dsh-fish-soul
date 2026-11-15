// #119：记忆列表要能翻页，批量要能改事件日期。默认仍是前 100 条。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
process.env.DSH_HOME = tmpHome('issue-119-');
const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');
const { bulkMemory } = await import('../lib/memory-bulk.js');
const db = openDatabase();
const clock = { now: () => Date.parse('2026-11-15T12:00:00Z') };
const worker = { enqueueRealtime() {} };
const ins = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, created_at, updated_at, status, visibility)
	VALUES ('feiyu', 'self', 'manual', '', 'fact', ?, ?, ?, 'active', 'private')`);
for (let i = 0; i < 250; i++) ins.run(`记忆 ${String(i).padStart(3, '0')}`, Date.parse('2026-11-01T00:00:00Z') + i * 1000, clock.now());
let handler;
registerRoutes({ effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } }, { db, clock, worker, getConfig: () => ({}), saveConfig() {} });
async function get(path) {
	let obj;
	await handler({ method: 'GET', url: `/api/plugins/fish-soul${path}`, headers: {}, on() {} }, { writeHead() {}, end(s) { obj = JSON.parse(s); } });
	return obj;
}
const first = await get('/inspector/overview');
assert.equal(first.matchedTotal, 250);
assert.equal(first.memories.length, 100, '没带 offset 时仍只回前 100 条');
assert.equal(first.offset, 0);
assert.equal(first.memories[0].content, '记忆 249', '新的排在前面');
const page = await get('/inspector/overview?offset=200&limit=100');
assert.equal(page.memories.length, 50, '最后一页只剩剩下的');
assert.equal(page.memories.at(-1).content, '记忆 000');
assert.equal(page.memories[0].content, '记忆 049');
const overlap = new Set(first.memories.map((m) => m.id));
assert.equal(page.memories.some((m) => overlap.has(m.id)), false, '翻页不能重复第一页');
const bad = await get('/inspector/overview?offset=-5');
assert.equal(bad.offset, 0, '负偏移夹回 0');

const ids = page.memories.slice(0, 2).map((m) => m.id);
const createdBefore = db.prepare('SELECT created_at FROM memory WHERE id = ?').get(ids[0]).created_at;
assert.equal(bulkMemory({ db, clock, worker, ids, action: 'sortDate', value: '2026-02-30' }).ok, false);
const set = bulkMemory({ db, clock, worker, ids, action: 'sortDate', value: '2026-01-02' });
assert.equal(set.changed, 2);
assert.equal(db.prepare('SELECT sort_date FROM memory WHERE id = ?').get(ids[0]).sort_date, '2026-01-02');
assert.equal(db.prepare('SELECT created_at FROM memory WHERE id = ?').get(ids[0]).created_at, createdBefore, '创建时间不动');
const cleared = bulkMemory({ db, clock, worker, ids: [ids[0]], action: 'sortDate', value: null });
assert.equal(cleared.changed, 1);
assert.equal(db.prepare('SELECT sort_date FROM memory WHERE id = ?').get(ids[0]).sort_date, null);
const weekly = Number(db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, created_at, updated_at, status)
	VALUES ('feiyu', 'self', 'manual', '', 'weekly', '周记', ?, ?, 'active')`).run(clock.now(), clock.now()).lastInsertRowid);
assert.equal(bulkMemory({ db, clock, worker, ids: [weekly], action: 'sortDate', value: '2026-01-03' }).changed, 0, '周记不改日期');
db.close();
console.log('issue-119-memory-page ok');
