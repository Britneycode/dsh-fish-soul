// #99: 编辑生成新版本不能改变创建时间相同的记忆相对顺序。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
process.env.DSH_HOME = tmpHome('fish-memory-order-');
const { openDatabase } = await import('../lib/db.js');
const { handleSoulRoute } = await import('../lib/routes-soul.js');
const { registerRoutes } = await import('../lib/routes.js');
const db = openDatabase(); const clock = { now: () => 5000 }; const worker = { enqueueRealtime() {} };
const add = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status) VALUES ('feiyu', 'self', 'self', '', 'fact', ?, '', 2, 0, 'manual', ?, 1, 'active')`);
add.run('更旧', 90); add.run('甲', 100); const id = Number(add.run('乙', 100).lastInsertRowid); add.run('丙', 100); add.run('更新', 110);
let handler;
registerRoutes({ effect: fn => fn(), webServer: { register: o => { handler = o.handler; } } }, {db, clock, worker, getConfig: () => ({}), saveConfig: () => {}});
async function list() {
 let obj; await handler({ method: 'GET', url: '/api/plugins/fish-soul/inspector/overview', headers: {}, on() {} }, {writeHead(){}, end(text){obj=JSON.parse(text)}}); return obj.memories.map(x => x.content);
}
async function edit(id, content) {
 let obj; const path='/inspector/memory-edit'; await handleSoulRoute({method:'POST',path,url:new URL('http://localhost'+path),req:{},res:{},send:(status,body)=>{obj=body},readBody:async()=>JSON.stringify({id,content}),sameOrigin:()=>true,deps:{db,clock,worker}}); assert.equal(obj.ok,true); return obj.id;
}
const before = await list();
const next = await edit(id,'乙修改');
assert.deepEqual(await list(), before.map(x=>x==='乙'?'乙修改':x),'同时间戳的第一次编辑应保留位置');
await edit(next,'乙再次修改');
assert.deepEqual(await list(),before.map(x=>x==='乙'?'乙再次修改':x),'多次编辑也保留位置');
db.close(); console.log('✓ #99 同时间戳多次编辑顺序稳定');
