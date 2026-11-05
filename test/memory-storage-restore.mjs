import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const home=mkdtempSync(join(tmpdir(),'fish-archive-restore-'));process.env.DSH_HOME=home;
const {openDatabase}=await import('../lib/db.js');
const {insertMemory}=await import('../lib/soul-memory.js');
const {MemoryArchive}=await import('../lib/storage.js');
const {BackupService,applyPendingRestore,backupDir}=await import('../lib/backup.js');
let db;
try{
 db=openDatabase(); const now=Date.now(); const add=text=>insertMemory(db,null,{ownerId:'self',channel:'self',kind:'fact',content:text},now);
 add('恢复前旧记录'); const archive=new MemoryArchive({db,getConfig:()=>({})});const snap=await archive.snapshot({force:true});assert(snap.ok);add('存档之后的新记录');
 const backup=new BackupService({db,getConfig:()=>({auto:false}),log:()=>{}});assert.equal((await archive.stageRestore(snap.file,backup)).ok,true);db.close();db=null;
 const restored=applyPendingRestore();assert(restored?.safety);assert(existsSync(join(backupDir(),restored.safety)));
 const saved=new DatabaseSync(join(backupDir(),restored.safety),{readOnly:true});assert.equal(saved.prepare("SELECT COUNT(*) n FROM memory WHERE content='存档之后的新记录'").get().n,1);saved.close();
 db=openDatabase();assert.equal(db.prepare("SELECT COUNT(*) n FROM memory WHERE content='恢复前旧记录'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM memory WHERE content='存档之后的新记录'").get().n,0);
 console.log('✓ 压缩存档重启恢复、恢复前当前库另存与内容完整性');
}finally{db?.close();rmSync(home,{recursive:true,force:true});}
