import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
// 用法：node test/bench-retrieval.mjs <源码绝对目录> <条数> [one-owner]
// 本地合成数据；不包含远程 embedding 网络延迟。
const root = process.argv[2], total = Number(process.argv[3]);
if (!root || !Number.isSafeInteger(total) || total < 1) throw Error('传入源码目录和正整数条数');
const home = mkdtempSync(join(tmpdir(), 'fish-bench-')); process.env.DSH_HOME = home;
const { openDatabase } = await import(root+'/lib/db.js');
const { vectorRanks, normalizeToBlob } = await import(root+'/lib/retrieval.js');
const db = openDatabase();
try {
 db.exec('BEGIN');
 const mem = db.prepare("INSERT INTO memory (character_id,owner_id,channel,kind,content,keywords,created_at,updated_at,visibility,about) VALUES ('feiyu',?,'qq','fact','text','test',1,1,?,?)");
 const vec = db.prepare("INSERT INTO vec(memory_id,model_id,dim,generation_id,blob) VALUES(?,'bench',8,1,?)");
 const blob = normalizeToBlob([1,0,0,0,0,0,0,0]);
 for(let i=0;i<total;i++){const r=mem.run(process.argv[4] === 'one-owner' || i%100===0?'user:target':`user:${i%999}`,i%3===0?'private':'normal',i%1000===1?'user:target':null);vec.run(r.lastInsertRowid,blob);}
 db.exec('COMMIT'); db.prepare("INSERT INTO vec_meta(id,model_id,dim,generation_id,built_at,status) VALUES(1,'bench',8,1,1,'ready')").run();
 const args={db,embedder:{embed:async()=>({vectors:[[1,0,0,0,0,0,0,0]]})},characterId:'feiyu',ownerId:'user:target',query:'test',embeddingCfg:{model:'bench'}};
 const out=[];for(let i=0;i<7;i++){let t=performance.now();let r=await vectorRanks(args);let ms=performance.now()-t;if(i)out.push(ms);if(!r)throw Error('no result');}
 out.sort((a,b)=>a-b);console.log(JSON.stringify({total,candidate:db.prepare("SELECT COUNT(*) n FROM memory WHERE owner_id='user:target' OR (about='user:target' AND visibility='normal')").get().n,medianMs:+out[3].toFixed(1),maxMs:+out.at(-1).toFixed(1),sampleCount:out.length}));
} finally { db.close(); rmSync(home,{recursive:true,force:true}); }
