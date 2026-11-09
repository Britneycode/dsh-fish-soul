// 优化必须与旧路径一致：候选/隐私/不同世代/分数相同排序和补偿均不变。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'fish-retrieval-filter-')); process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { vectorRanks, recallSync, normalizeToBlob, blobToF32 } = await import('../lib/retrieval.js');
const db = openDatabase();
try {
 const insert = db.prepare("INSERT INTO memory(character_id,owner_id,channel,kind,content,keywords,created_at,updated_at,visibility,about,status,valid_to) VALUES(?,?,'qq','fact',?,'苹果',1,1,?,?,?,?)");
 const v = db.prepare("INSERT INTO vec(memory_id,model_id,dim,generation_id,blob) VALUES(?,'m',2,?,?)");
 const specs=[['feiyu','self','a','normal',null,'active',null,1,[1,0]],['feiyu','user:x','b','private',null,'active',null,1,[1,0]],['feiyu','user:y','c','normal','user:x','active',null,1,[0,1]],['feiyu','user:y','d','private','user:x','active',null,1,[1,0]],['feiyu','user:x','e','normal',null,'archived',null,1,[1,0]],['feiyu','user:x','f','normal',null,'active',1,1,[1,0]],['other','user:x','g','normal',null,'active',null,1,[1,0]],['feiyu','user:x','h','normal',null,'active',null,2,[1,0]],['feiyu','user:x','pending','normal',null,'active',null,null,null]];
 for (const [character,owner,content,visibility,about,status,valid,gen,vector] of specs) {let id=insert.run(character,owner,content,visibility,about,status,valid).lastInsertRowid;if(gen!==null)v.run(id,gen,normalizeToBlob(vector));}
 db.prepare("INSERT INTO vec_meta(id,model_id,dim,generation_id,built_at,status) VALUES(1,'m',2,1,1,'ready')").run();
 const args={db,embedder:{embed:async()=>({vectors:[[1,0]]})},characterId:'feiyu',ownerId:'user:x',query:'苹果',embeddingCfg:{model:'m'}};
 const valid=new Set(db.prepare("SELECT id FROM memory WHERE character_id=? AND status='active' AND valid_to IS NULL AND (owner_id IN ('self',?) OR (about=? AND visibility='normal'))").all('feiyu','user:x','user:x').map(x=>x.id));
 const old=db.prepare('SELECT memory_id,blob FROM vec WHERE generation_id=? AND dim=?').all(1,2).filter(x=>valid.has(x.memory_id)).map(x=>({id:x.memory_id,sim:blobToF32(x.blob)[0]})).sort((a,b)=>b.sim-a.sim).slice(0,50);
 const result=await vectorRanks(args);
 assert.deepEqual([...result.ranks],[...old.map((x,i)=>[x.id,i+1])]);
 // 模拟旧版不加候选过滤的 vectorizedIds 查询，比较最终召回与解释。
 const proxy = { prepare(sql) { if (sql.includes('SELECT memory_id FROM vec WHERE generation_id = ?')) return { all: (generation) => db.prepare('SELECT memory_id FROM vec WHERE generation_id = ?').all(generation) }; return db.prepare(sql); } };
 for(const excludePrivate of [false,true]) for(const explain of [false,true]) {
  const common={clock:{now:()=>100},config:{topK:10},characterId:'feiyu',ownerId:'user:x',query:'苹果',vec:result,excludePrivate,explain};
  assert.deepEqual(recallSync({db,...common}),recallSync({db:proxy,...common}));
 }
 console.log('✓ 向量候选过滤：排序、世代、私密与补偿等价');
} finally { db.close(); rmSync(home,{recursive:true,force:true}); }
