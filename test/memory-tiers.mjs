import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'fs-memory-tier-')); process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { reinforce } = await import('../lib/soul-memory.js');
const { recallSync, memoryTier, memoryTierWeight } = await import('../lib/retrieval.js');
const { bulkMemory } = await import('../lib/memory-bulk.js');
const { tokenizeForBm25 } = await import('../lib/segment.js');
const { handleSoulRoute } = await import('../lib/routes-soul.js');
const db = openDatabase();
try {
 const H=3600000, now=50*86400000;
 const insert=db.prepare(`INSERT INTO memory(owner_id,channel,kind,content,keywords,importance,emotion,created_at,updated_at,status,visibility) VALUES('user:a','qq-private',?,?,?, ?,0,?,?,'active',?)`);
 const add=(kind, content, importance=1, at=now, visibility='normal')=>Number(insert.run(kind,content,tokenizeForBm25(content),importance,at,at,visibility).lastInsertRowid);
 const fresh=add('fact','用户喜欢苹果'); const locked=add('fact','用户喜欢梨'); const high=add('fact','用户喜欢桃子',5); const privateId=add('fact','用户喜欢苹果派',1,now,'private');
 const get=id=>db.prepare('SELECT * FROM memory WHERE id=?').get(id);
 for(const at of [now,now+6*H,now+6*H+1,now+12*H+2]) reinforce(db,[fresh,high],at);
 assert.equal(get(fresh).recall_count,3,'6 小时内去重');assert.equal(get(fresh).importance,3);assert.equal(get(fresh).importance_auto_recalled,1);assert.equal(get(high).importance,5);
 bulkMemory({db,clock:{now:()=>now},worker:{},ids:[locked],action:'importance',value:1});
 for(const at of [now,now+7*H,now+14*H])reinforce(db,[locked],at);
 assert.equal(get(locked).recall_count,3);assert.equal(get(locked).importance,1);assert.equal(get(locked).importance_locked,1);
 db.prepare('UPDATE memory SET importance_locked=0 WHERE id=?').run(locked);reinforce(db,[locked],now+21*H);assert.equal(get(locked).importance,3);
 assert.equal(memoryTier({kind:'weekly',importance:5,created_at:now},now),'weekly');assert.equal(memoryTier({kind:'event',importance:1,created_at:now},now),'recent');assert.equal(memoryTier({kind:'fact',importance:3,created_at:now},now),'longTerm');
 assert.equal(memoryTierWeight('recent',{tierWeights:{recent:99}}),2);assert.equal(memoryTierWeight('weekly',{tierWeights:{weekly:NaN}}),0.9);
 const query={db,clock:{now:()=>now},config:{topK:10},characterId:'feiyu',ownerId:'user:a',query:'苹果',vec:null};
 const before=get(privateId).recall_count;const debug=recallSync({...query,explain:true,excludePrivate:true});assert(debug.recalled.length);assert(debug.recalled.every(x=>x.id!==privateId));assert(debug.recalled.every(x=>typeof x.tierWeight==='number'));assert.equal(get(privateId).recall_count,before,'调试只读');
 assert.equal(recallSync({...query,query:'不存在且无关词语'}).length,0,'无匹配不能被权重凭空召回');
 // 用户编辑私密记忆后仍须保留私密属性与锁定状态。
 let sent;
 const route = async (path, payload, same = true) => {
  sent=null; const result=await handleSoulRoute({method:'POST',path,url:new URL('http://localhost/'+path),req:{},res:{},send:(status,body)=>{sent={status,...body}},readBody:async()=>JSON.stringify(payload),sameOrigin:()=>same,deps:{db,clock:{now:()=>now},worker:{enqueueRealtime(){}},getConfig:()=>({})}});
  assert(result); return sent;
 };
 assert.equal((await route('/inspector/importance-lock',{id:fresh,locked:true},false)).status,403);
 assert.equal((await route('/inspector/importance-lock',{id:fresh,locked:'false'})).ok,false);
 assert.equal((await route('/inspector/importance-lock',{id:fresh,locked:true})).ok,true);assert.equal(get(fresh).importance_locked,1);
 assert.equal((await route('/inspector/importance-lock',{id:fresh,locked:false})).ok,true);assert.equal(get(fresh).importance_locked,0);
 const changed=await route('/inspector/memory-edit',{id:privateId,content:'用户喜欢苹果派与茶',importance:1,kind:'fact'});
 assert(changed.ok && changed.replaced===privateId);assert.equal(get(changed.id).visibility,'private');assert.equal(get(changed.id).importance_locked,1);
 assert(!recallSync({...query,query:'苹果',excludePrivate:true}).some(m=>m.id===changed.id));
 console.log('✓ 三层分类与加权、召回冷却及提升、手动锁定、隐私过滤、只读调试');
} finally { db.close(); rmSync(home,{recursive:true,force:true}); }
