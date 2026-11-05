/** Verified, lossless snapshots of the whole memory database; never deletes live data. */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, renameSync, chmodSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fishSoulDir, getKv, setKv } from './db.js';
import { backupDir } from './backup.js';
import { stampLocal } from './time-util.js';
const MB=1024*1024, WEEK=7*86400000;
const ARCHIVE=/^memory-\d{8}-\d{6}-[a-f0-9]{8}\.db\.gz$/;
function safeSize(path) { try { return statSync(path).size; } catch { return 0; } }
async function hash(path) { const h=createHash('sha256'); for await(const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); }
const dir=()=>join(fishSoulDir(),'archives');
export class MemoryArchive {
 constructor({db,getConfig,clock={now:()=>Date.now()},isIdle=()=>true,log=()=>{}}) { Object.assign(this,{db,getConfig,clock,isIdle,log});this.running=false;this.lastError='';this.budget={samples:0,consecutive:0,lastRatio:0}; }
 config() { const c=this.getConfig()?.storage ?? {};return {auto:c.auto!==false, warnMB:Math.max(50,Math.min(1048576,Number(c.warnMB)||1024)),freeMB:Math.max(50,Math.min(1048576,Number(c.freeMB)||512))}; }
 list() { if(!existsSync(dir()))return [];return readdirSync(dir()).filter(x=>ARCHIVE.test(x)).map(file=>({file,size:safeSize(join(dir(),file))})).sort((a,b)=>b.file.localeCompare(a.file)); }
 state() {
  const cfg=this.config(), files=this.list(), dbPath=join(fishSoulDir(),'soul.db');
  const databaseBytes=['','-wal','-shm'].reduce((n,s)=>n+safeSize(dbPath+s),0);
  const archivesBytes=files.reduce((n,f)=>n+f.size,0);
  const backupsBytes=existsSync(backupDir())?readdirSync(backupDir()).reduce((n,f)=>n+safeSize(join(backupDir(),f)),0):0;
  const chatBytes=['','-wal','-shm'].reduce((n,s)=>n+safeSize(join(fishSoulDir(),'chat-archive.db')+s),0);
  let freeBytes=null; try { const fs=statfsSync(fishSoulDir()); freeBytes=Number(fs.bavail)*Number(fs.bsize); } catch {}
  const used=databaseBytes+archivesBytes+backupsBytes+chatBytes;
  const now=this.clock.now();
  const t=this.db.prepare(`SELECT SUM(CASE WHEN kind='weekly' THEN 1 ELSE 0 END) weekly,
   SUM(CASE WHEN kind<>'weekly' AND importance<3 AND created_at>? THEN 1 ELSE 0 END) recent,
   SUM(CASE WHEN kind<>'weekly' AND (importance>=3 OR created_at<=?) THEN 1 ELSE 0 END) longTerm
   FROM memory WHERE character_id='feiyu' AND status='active' AND valid_to IS NULL`).get(now-7*86400000,now-7*86400000);
  const tiers={weekly:Number(t.weekly||0),recent:Number(t.recent||0),longTerm:Number(t.longTerm||0)};
  return {ok:true,...cfg,databaseBytes,archivesBytes,backupsBytes,chatBytes,freeBytes,usedBytes:used,warning:used>=cfg.warnMB*MB || (freeBytes!==null&&freeBytes<cfg.freeMB*MB),files,last:getKv(this.db,'archive.last',null),error:this.lastError,running:this.running,tiers,budget:{...this.budget}};
 }
 noteBudget(used,budget,truncated) { if(!(budget>0))return;const ratio=Math.max(0,used/budget);this.budget.samples++;this.budget.lastRatio=Math.round(ratio*100)/100;this.budget.consecutive=truncated||ratio>=0.9?this.budget.consecutive+1:0; }
 async snapshot({force=false}={}) {
  if(this.running) return {ok:false,error:'存档正在生成'};
  const last=getKv(this.db,'archive.last',null);if(!force&&last&&Date.now()-last.at<5*60_000&&existsSync(join(dir(),last.file)))return {ok:true,...last,reused:true};
  this.running=true;let raw='',tmp='',verify='';
  try {
   mkdirSync(dir(),{recursive:true,mode:0o700});chmodSync(dir(),0o700);
   const free=statfsSync(dir()); const dbPath=join(fishSoulDir(),'soul.db'); const size=['','-wal'].reduce((n,s)=>n+safeSize(dbPath+s),0);
   if(Number(free.bavail)*Number(free.bsize)<size*3+16*MB)throw new Error('磁盘剩余空间不足');
   const name=`memory-${stampLocal(Date.now())}-${randomBytes(4).toString('hex')}.db.gz`;
   raw=join(dir(),`.${name}.raw`);tmp=join(dir(),`.${name}.tmp`);verify=join(dir(),`.${name}.verify`);
   this.db.exec(`VACUUM INTO '${raw.replace(/'/g,"''")}'`);chmodSync(raw,0o600);
   await pipeline(createReadStream(raw),createGzip({level:6}),createWriteStream(tmp,{mode:0o600,flags:'wx'}));
   await pipeline(createReadStream(tmp),createGunzip(),createWriteStream(verify,{mode:0o600,flags:'wx'}));
   if(await hash(raw)!==await hash(verify))throw new Error('存档校验失败');
   const check=new DatabaseSync(verify,{readOnly:true});try {const row=check.prepare('PRAGMA quick_check').get();if(Object.values(row??{})[0]!=='ok')throw new Error('数据库校验失败');}finally{check.close();}
   renameSync(tmp,join(dir(),name));const result={file:name,at:Date.now(),size:safeSize(join(dir(),name)),originalSize:safeSize(raw)};
   setKv(this.db,'archive.last',result);this.lastError='';return {ok:true,...result};
  } catch(e) { this.lastError='存档失败，请检查磁盘空间和权限';this.log('warn','[fish-soul] '+this.lastError);return {ok:false,error:this.lastError}; }
  finally { for(const x of [raw,tmp,verify]) if(x)try { rmSync(x,{force:true}); } catch { this.log('warn','[fish-soul] 存档临时文件清理失败'); } this.running=false; }
 }
 start() {
  const check=()=>{try {const last=getKv(this.db,'archive.last',null);if(this.config().auto && this.isIdle() && (!last||Date.now()-last.at>=WEEK))void this.snapshot();}catch{this.lastError='自动存档检查失败';this.log('warn','[fish-soul] '+this.lastError);}};
  this.first=setTimeout(check,60000);this.timer=setInterval(check,3600000);this.first.unref?.();this.timer.unref?.();
 }
 stop(){clearTimeout(this.first);clearInterval(this.timer);}
 async stageRestore(file,backup) {
  if(!ARCHIVE.test(file)||!existsSync(join(dir(),file)))return {ok:false,error:'存档不存在'};
  mkdirSync(backupDir(),{recursive:true,mode:0o700});let name=`soul-${stampLocal(Date.now())}.db`,i=0;
  while(existsSync(join(backupDir(),name)))name=`soul-${stampLocal(Date.now()+(++i)*1000)}.db`;
  const path=join(backupDir(),name);
  try {await pipeline(createReadStream(join(dir(),file)),createGunzip(),createWriteStream(path,{mode:0o600,flags:'wx'})); const pending=backup.stageRestore(name);return {ok:true,pending};}
  catch {rmSync(path,{force:true});return {ok:false,error:'存档损坏或无法恢复'};}
 }
 remove(file) {if(!ARCHIVE.test(file)||!existsSync(join(dir(),file)))return {ok:false,error:'存档不存在'};rmSync(join(dir(),file));return {ok:true};}
}
