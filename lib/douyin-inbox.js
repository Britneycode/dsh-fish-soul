import { setKv } from './db.js';

/** Durable handoff. Processing interrupted after callback starts is ambiguous. */
export class DouyinInbox {
 constructor(db) {
  this.db = db;
  db.exec(`CREATE TABLE IF NOT EXISTS douyin_inbox (
   id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
   payload TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(channel_id, message_id)
  ); CREATE INDEX IF NOT EXISTS douyin_inbox_status_id ON douyin_inbox(status,id);
   CREATE TABLE IF NOT EXISTS douyin_inbox_gap(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);`);
  db.prepare("UPDATE douyin_inbox SET status='unknown',error='处理过程中断，可能已产生回复或其他操作',updated_at=? WHERE status='processing'").run(Date.now());
 }
 record(key, cursor, messages, gap = null) {
  this.db.exec('BEGIN');
  try {
   const stmt=this.db.prepare("INSERT OR IGNORE INTO douyin_inbox(channel_id,message_id,payload,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?)");
   const now=Date.now();
   for(const m of messages) stmt.run(m.channelId,m.messageId,JSON.stringify(m),now,now);
   if (gap) this.db.prepare('INSERT INTO douyin_inbox_gap(channel_id,reason,created_at) VALUES(?,?,?)').run(gap.channelId,gap.reason,now);
   setKv(this.db,key,cursor);
   this.db.exec('COMMIT');
  } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 next() { return this.db.prepare("SELECT m.id,m.payload FROM douyin_inbox m WHERE m.status='pending' AND NOT EXISTS (SELECT 1 FROM douyin_inbox u WHERE u.channel_id=m.channel_id AND u.id<m.id AND u.status='unknown') ORDER BY m.id LIMIT 1").get() ?? null; }
 start(id) { return Number(this.db.prepare("UPDATE douyin_inbox SET status='processing',error='',updated_at=? WHERE id=? AND status='pending'").run(Date.now(),id).changes)===1; }
 settle(ids, ok, error='') {
  const q=this.db.prepare("UPDATE douyin_inbox SET status=?,error=?,updated_at=? WHERE id=? AND status='processing'");
  for(const id of ids) q.run(ok?'done':'unknown',ok?'':String(error || '处理结果不确定，请核实').slice(0,300),Date.now(),id);
 }
 resolve(id, action) {
  if (!['retry','dismiss'].includes(action)) return false;
  return Number(this.db.prepare("UPDATE douyin_inbox SET status=?,error=?,updated_at=? WHERE id=? AND status='unknown'").run(action==='retry'?'pending':'dismissed',action==='retry'?'用户核实后重新处理':'用户已核实并忽略',Date.now(),id).changes)===1;
 }
 acknowledgeGap(id) { return Number(this.db.prepare('UPDATE douyin_inbox_gap SET acknowledged=1 WHERE id=? AND acknowledged=0').run(id).changes)===1; }
 status() {
  const counts=this.db.prepare("SELECT status,COUNT(*) AS n FROM douyin_inbox WHERE status IN ('pending','processing','unknown') GROUP BY status").all();
  const review=this.db.prepare("SELECT id,payload,error FROM douyin_inbox WHERE status='unknown' ORDER BY id LIMIT 10").all().map(r=>{
   let m={};try {m=JSON.parse(r.payload);} catch { /* present error, not raw blob */ }
   return {id:r.id, channelId:m.channelId??'', text:String(m.text??'').slice(0,200),confidence:m.idConfidence??'heuristic',error:r.error};
  });
  const gaps=this.db.prepare('SELECT id,channel_id AS channelId,reason FROM douyin_inbox_gap WHERE acknowledged=0 ORDER BY id LIMIT 10').all();
  const gapCount=this.db.prepare('SELECT COUNT(*) n FROM douyin_inbox_gap WHERE acknowledged=0').get().n;
  return {counts:Object.fromEntries(counts.map(x=>[x.status,x.n])),review,gaps,gapCount};
 }
}
