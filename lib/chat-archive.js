/** Optional local text journal. Only explicitly selected channels; no attachment capture. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync,mkdirSync,chmodSync,openSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { fishSoulDir } from './db.js';
const DAY=86400000;
export class ChatArchive {
 constructor({getConfig,log=()=>{}}){this.getConfig=getConfig;this.log=log;this.db=null;this.error='';this.failures=0;}
 config(){const c=this.getConfig()?.chatArchive ?? {};return {enabled:c.enabled===true,channels:Array.isArray(c.channels)?c.channels.filter(x=>typeof x==='string'&&x.length>0):[],days:Math.max(1,Math.min(3650,Math.floor(Number(c.days)||30)))};}
 open(create=false){if(this.db)return this.db;const path=join(fishSoulDir(),'chat-archive.db');if(!create&&!existsSync(path))return null;mkdirSync(fishSoulDir(),{recursive:true,mode:0o700});if(!existsSync(path)){try {closeSync(openSync(path,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}}chmodSync(path,0o600);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS chat_text(id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, who TEXT NOT NULL, self INTEGER NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS chat_text_channel_at ON chat_text(channel_id,at DESC);');this.db=db;return db;}
 add(channel,line){const cfg=this.config();if(!cfg.enabled||!cfg.channels.includes(channel))return;try {const text=String(line?.text??'').trim();if(!text)return;if(Buffer.byteLength(text,'utf8')>2*1024*1024)throw new Error('文本过长');this.open(true).prepare('INSERT INTO chat_text(channel_id,who,self,content,at) VALUES(?,?,?,?,?)').run(channel,String(line.who??''),line.self===true?1:0,text,Date.now());this.error='';}catch {this.failures++;this.error='聊天存档写入失败';this.log('warn','[fish-soul] 聊天存档写入失败，聊天继续');}}
 prune(){try{const db=this.open();if(!db)return;db.prepare('DELETE FROM chat_text WHERE at < ?').run(Date.now()-this.config().days*DAY);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{this.error='聊天存档清理失败';}}
 state(){let count=0, stored=[];try{const db=this.open();count=Number(db?.prepare('SELECT COUNT(*) n FROM chat_text').get()?.n??0);stored=db?db.prepare('SELECT channel_id AS channel, COUNT(*) AS count FROM chat_text GROUP BY channel_id ORDER BY max(at) DESC LIMIT 100').all():[];}catch{this.error='聊天存档读取失败';}return {ok:true,...this.config(),count,stored,error:this.error,failures:this.failures};}
 list(channel,before=Number.MAX_SAFE_INTEGER){try {const db=this.open();const items=db?db.prepare('SELECT id,channel_id AS channel,who,self,content,at FROM chat_text WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT 50').all(channel,before):[];return {ok:true,items,next:items.length===50?items[items.length-1].id:null};}catch{return {ok:false,error:'读取聊天存档失败'};}}

 /**
  * 给 Dream 用的**只读**取样：某个会话在 [since, until) 之间的原文，最多 limit 条。
  *
  * 为什么要它：Dream 原来只看「她已经总结出来的记忆」，没有原始对话可以核对
  * —— 记忆写错了它也没法发现（Anthropic 那篇《The components of agent memory》里
  * 「Mt. Moon」那个案例：记错一次，后面几轮一路信下去）。原文是唯一的地面真值。
  *
  * 只读、有上限、失败返回空：取样只是锦上添花，不能因为它把 Dream 拖挂。
  * @param {{channel?:string, since:number, until:number, limit?:number}} o
  * @returns {Array<{who:string, self:boolean, content:string, at:number}>}
  */
 sample({ channel = '', since = 0, until = Date.now(), limit = 40 } = {}) {
  try {
   const db = this.open();
   if (!db) return [];
   const n = Math.min(200, Math.max(1, Math.floor(Number(limit) || 40)));
   const rows = channel !== ''
    ? db.prepare('SELECT who,self,content,at FROM chat_text WHERE channel_id=? AND at>=? AND at<? ORDER BY at DESC LIMIT ?').all(channel, since, until, n)
    : db.prepare('SELECT who,self,content,at FROM chat_text WHERE at>=? AND at<? ORDER BY at DESC LIMIT ?').all(since, until, n);
   return rows.map((r) => ({ who: String(r.who ?? ''), self: r.self === 1, content: String(r.content ?? ''), at: Number(r.at) || 0 }));
  } catch { return []; }
 }
 remove(channel){try{const db=this.open();const changed=db?Number(db.prepare('DELETE FROM chat_text WHERE channel_id=?').run(channel).changes):0;db?.exec('PRAGMA wal_checkpoint(TRUNCATE)');return {ok:true,changed};}catch{return {ok:false,error:'清理聊天存档失败'};}}
 start(){this.prune();this.timer=setInterval(()=>this.prune(),3600000);this.timer.unref?.();}
 stop(){clearInterval(this.timer);try{this.db?.close();}catch{}this.db=null;}
}
