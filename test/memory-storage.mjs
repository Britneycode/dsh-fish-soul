import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
// Windows 上 chmod 对文件不生效，statSync().mode 恒为 0o666，权限断言只在 POSIX 有意义
const posix=process.platform!=='win32';
const home=mkdtempSync(join(tmpdir(),'fish-store-'));process.env.DSH_HOME=home;
const {openDatabase,fishSoulDir}=await import('../lib/db.js');
const {insertMemory,ChatJournal}=await import('../lib/soul-memory.js');
const {MemoryArchive}=await import('../lib/storage.js');
const {ChatArchive}=await import('../lib/chat-archive.js');
const {BackupService}=await import('../lib/backup.js');
const {handleSoulRoute}=await import('../lib/routes-soul.js');
const db=openDatabase(), now=Date.now();let cfg={};
const getConfig=()=>cfg, saveConfig=p=>{for(const [k,v] of Object.entries(p))cfg[k]={...(cfg[k]||{}),...v}};
const log=[];const storage=new MemoryArchive({db,getConfig,clock:{now:()=>now},log:(...x)=>log.push(x)});
const chats=new ChatArchive({getConfig,log:(...x)=>log.push(x)});
try{
 const id=insertMemory(db,null,{ownerId:'user:a',channel:'private',channelId:'private:a',kind:'fact',content:'用户的私密记忆',private:true},now);
 assert.equal(storage.config().auto,true);assert.equal(chats.state().enabled,false);assert.equal(storage.state().tiers.recent,1);
 const journal=new ChatJournal({onAdd:(c,l)=>chats.add(c,l)});journal.add('private:a',{who:'A',text:'默认不能保存'});assert.equal(chats.state().count,0);
 saveConfig({chatArchive:{enabled:true,channels:['private:a'],days:30}});
 journal.add('private:b',{who:'B',text:'未选择会话'});journal.add('private:a',{who:'A',text:'已选择会话'});
 assert.equal(chats.state().count,1);assert.equal(chats.list('private:a').items[0].content,'已选择会话');
 if(posix)assert.equal(statSync(join(fishSoulDir(),'chat-archive.db')).mode&0o777,0o600);
 chats.db.prepare('UPDATE chat_text SET at=?').run(now-31*86400000);chats.prune();assert.equal(chats.state().count,0);
 journal.add('private:a',{who:'A',text:'新的聊天文本'});assert.equal(chats.state().count,1);
 const snap=await storage.snapshot({force:true});assert.equal(snap.ok,true);assert(storage.list().some(x=>x.file===snap.file));
 assert.equal((await storage.snapshot()).reused,true);assert.equal(db.prepare('SELECT status FROM memory WHERE id=?').get(id).status,'active');
 const gz=readFileSync(join(fishSoulDir(),'archives',snap.file));assert.equal(gunzipSync(gz).subarray(0,15).toString(),'SQLite format 3');
 assert(!gunzipSync(gz).includes(Buffer.from('新的聊天文本')),'单独聊天库不进入记忆快照');
 if(posix)assert.equal(statSync(join(fishSoulDir(),'archives',snap.file)).mode&0o777,0o600);
 storage.noteBudget(90,100,false);storage.noteBudget(90,100,false);storage.noteBudget(60,100,true);assert.equal(storage.state().budget.consecutive,3);
 const backup=new BackupService({db,getConfig:()=>({auto:false}),log:()=>{}});
 const restored=await storage.stageRestore(snap.file,backup);assert.equal(restored.ok,true);assert.equal(restored.pending.memories,1);
 const corrupt=snap.file.replace(/([a-f0-9]{8})\.db\.gz$/,'ffffffff.db.gz');writeFileSync(join(fishSoulDir(),'archives',corrupt),Buffer.from('bad'));
 assert.equal((await storage.stageRestore(corrupt,backup)).ok,false);assert.equal(storage.remove('../bad').ok,false);
 let sent;const deps={db,clock:{now:()=>now},worker:{},backup,getConfig,saveConfig,storage,chatArchive:chats};
 const route=async(method,path,payload={},allowed=true)=>{let url=new URL('http://localhost'+path);sent=null;await handleSoulRoute({method,path:url.pathname,url,req:{},res:{},send:(status,body)=>sent={status,...body},readBody:async()=>JSON.stringify(payload),sameOrigin:()=>allowed,deps});return sent;};
 assert.equal((await route('POST','/chat-archive/config',{enabled:true,channels:['private:a'],days:30},false)).status,403);
 // 2026-11-08 契约变更：channels 留空不再是错误 —— 留空 = 记所有会话（Dream 要靠原文核对记忆）。
 // 仍然拒绝的：格式不对的会话 ID。
 assert.equal((await route('POST','/chat-archive/config',{enabled:true,channels:[],days:30})).ok,true, '留空 = 全记，允许');
 assert.equal((await route('POST','/chat-archive/config',{enabled:true,channels:['乱写的'],days:30})).ok,false, '填了就要合法');
 assert.equal((await route('POST','/chat-archive/config',{enabled:true,channels:['private:1'],days:30})).ok,true);
 assert.equal((await route('POST','/storage/config',{warnMB:1})).ok,false);
 assert.equal((await route('GET','/chat-archive/list?channel=private%3Aa')).items.length,1);
 assert.equal((await route('GET','/storage/search?q=%E7%A7%81%E5%AF%86')).items[0].id,id);
 assert.equal((await route('POST','/chat-archive/delete',{channel:'private:a'},false)).status,403);
 assert.equal((await route('POST','/chat-archive/delete',{channel:'private:a'})).changed,1);
 assert.equal(storage.remove(corrupt).ok,true);
 // 存档份数上限：keep=2 时第三次快照后只留最新 2 份；keep=0 不限；非法值被路由拒绝
 assert.equal((await route('POST','/storage/config',{keep:2})).keep,2);assert.equal(storage.config().keep,2);
 const s2=await storage.snapshot({force:true});assert.equal(s2.ok,true);
 const s3=await storage.snapshot({force:true});assert.equal(s3.ok,true);
 assert.equal(storage.list().length,2);assert(storage.list().some(x=>x.file===s3.file));
 assert.equal((await route('POST','/storage/config',{keep:201})).ok,false);assert.equal((await route('POST','/storage/config',{keep:-1})).ok,false);
 saveConfig({storage:{keep:0}});const s4=await storage.snapshot({force:true});assert.equal(s4.ok,true);assert.equal(storage.list().length,3);
 console.log('✓ 全库无损快照、校验恢复、容量告警、范围限定聊天存档、过期清理、存档份数上限和权限校验');
}finally{storage.stop();chats.stop();db.close();rmSync(home,{recursive:true,force:true});}
