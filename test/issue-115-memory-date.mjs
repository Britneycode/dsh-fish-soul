import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
process.env.DSH_HOME = tmpHome('fish-memory-date-');
const {openDatabase} = await import('../lib/db.js');
const {handleSoulRoute} = await import('../lib/routes-soul.js');
const {registerRoutes} = await import('../lib/routes.js');
const {importMemories} = await import('../lib/importer.js');
const db=openDatabase(), clock={now:()=>Date.parse('2026-11-15T12:00:00Z')}, worker={enqueueRealtime(){}};
const add=db.prepare("INSERT INTO memory(owner_id,channel,channel_id,kind,content,created_at,updated_at,status,visibility) VALUES('self','manual','','fact',?,?,?,'active','private')");
const old=Number(add.run('旧事',Date.parse('2026-11-13T12:00:00Z'),clock.now()).lastInsertRowid);
const newer=Number(add.run('新事',Date.parse('2026-11-14T12:00:00Z'),clock.now()).lastInsertRowid);
const inserted=Number(add.run('补记',clock.now(),clock.now()).lastInsertRowid);
let handler; registerRoutes({effect:fn=>fn(),webServer:{register:o=>handler=o.handler}},{db,clock,worker,getConfig:()=>({}),saveConfig(){}});
async function list(){let obj;await handler({method:'GET',url:'/api/plugins/fish-soul/inspector/overview',headers:{},on(){}},{writeHead(){},end(s){obj=JSON.parse(s)}});if (!obj.memories) throw Error(JSON.stringify(obj));return obj.memories;}
async function edit(body){let result;const path='/inspector/memory-edit';await handleSoulRoute({method:'POST',path,url:new URL('http://localhost'+path),req:{},res:{},send:(_,b)=>result=b,readBody:async()=>JSON.stringify(body),sameOrigin:()=>true,deps:{db,clock,worker}});return result;}
assert.deepEqual((await list()).map(x=>x.content),['补记','新事','旧事']);
assert.equal((await edit({id:inserted,sortDate:'2026-11-13'})).ok,true);
assert.deepEqual((await list()).map(x=>x.content),['新事','补记','旧事']);
let row=db.prepare('SELECT * FROM memory WHERE id=?').get(inserted);assert.equal(row.created_at,clock.now());assert.equal(row.sort_date,'2026-11-13');assert.equal(row.visibility,'private');
assert.equal((await edit({id:inserted,sortDate:'2026-02-30'})).ok,false);
let change=await edit({id:inserted,content:'补记改过'});assert.equal(change.ok,true);row=db.prepare('SELECT * FROM memory WHERE id=?').get(change.id);assert.equal(row.sort_date,'2026-11-13');assert.equal(row.created_at,clock.now());assert.equal(row.visibility,'private');
let json='';await handleSoulRoute({method:'GET',path:'/export/memories',url:new URL('http://localhost/export/memories'),req:{},res:{writeHead(){},end(s){json=s}},send(){},readBody(){},sameOrigin:()=>true,deps:{db,clock,worker}});
const exported=JSON.parse(json).find(x=>x.content==='补记改过');assert.equal(exported.sortDate,'2026-11-13');
exported.content='导回的新内容'; assert.equal(importMemories({db,clock,worker,items:[exported]}).inserted,1);assert.equal(db.prepare("SELECT sort_date FROM memory WHERE content='导回的新内容'").get().sort_date,'2026-11-13');
assert.equal((await edit({id:change.id,sortDate:null})).ok,true);assert.equal(db.prepare('SELECT sort_date FROM memory WHERE id=?').get(change.id).sort_date,null);
db.close();console.log('✓ #115 调整日期、稳定排序、创建时间、版本和导入导出');
