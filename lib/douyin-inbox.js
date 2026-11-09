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
   CREATE TABLE IF NOT EXISTS douyin_inbox_gap(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS douyin_inbox_read_intent (cursor_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, started_at INTEGER NOT NULL);`);
  db.prepare("UPDATE douyin_inbox SET status='unknown',error='处理过程中断，可能已产生回复或其他操作',updated_at=? WHERE status='processing'").run(Date.now());
  this.prune();
  this.recoverReads();
 }
 // Persist before opening the conversation: the platform may mark it read before
 // returning data. A surviving intent proves uncertainty, not actual data loss.
 recoverReads() {
  this.db.exec('BEGIN');
  try {
   this.db.prepare("INSERT INTO douyin_inbox_gap(channel_id,reason,created_at) SELECT channel_id,'读取过程中断，抖音可能已标记为已读但消息未入库，请手动检查',? FROM douyin_inbox_read_intent").run(Date.now());
   this.db.exec('DELETE FROM douyin_inbox_read_intent; COMMIT');
  } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 beginRead(key, channelId) {
  this.db.exec('BEGIN');
  try {
   this.db.prepare("INSERT INTO douyin_inbox_gap(channel_id,reason,created_at) SELECT channel_id,'上次读取未完成，抖音可能已标记为已读但消息未入库，请手动检查',? FROM douyin_inbox_read_intent WHERE cursor_key=?").run(Date.now(),key);
   this.db.prepare('INSERT OR REPLACE INTO douyin_inbox_read_intent(cursor_key,channel_id,started_at) VALUES(?,?,?)').run(key,channelId,Date.now());
   this.db.exec('COMMIT');
  } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 failRead(key) {
  this.db.exec('BEGIN');
  try {
   this.db.prepare("INSERT INTO douyin_inbox_gap(channel_id,reason,created_at) SELECT channel_id,'读取失败，抖音可能已标记为已读但消息未入库，请手动检查',? FROM douyin_inbox_read_intent WHERE cursor_key=?").run(Date.now(),key);
   this.db.prepare('DELETE FROM douyin_inbox_read_intent WHERE cursor_key=?').run(key);
   this.db.exec('COMMIT');
  } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 record(key, cursor, messages, gap = null) {
  this.db.exec('BEGIN');
  try {
   const stmt=this.db.prepare("INSERT OR IGNORE INTO douyin_inbox(channel_id,message_id,payload,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?)");
   const now=Date.now();
   for(const m of messages) stmt.run(m.channelId,m.messageId,JSON.stringify(m),now,now);
   if (gap) this.db.prepare('INSERT INTO douyin_inbox_gap(channel_id,reason,created_at) VALUES(?,?,?)').run(gap.channelId,gap.reason,now);
   setKv(this.db,key,cursor);
   this.db.prepare('DELETE FROM douyin_inbox_read_intent WHERE cursor_key=?').run(key);
   this.db.exec('COMMIT');
  } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 /**
  * 收件表保留期。暂停期间每轮轮询都会继续入库，而 UI 只显示前 10 条，
  * 不清理的话表单调增长、用户既清不掉也看不到全貌。
  * 只删已了结的状态（done / dismissed），pending / processing / unknown 一律保留。
  */
 prune(keepMs = 7 * 86_400_000) {
  try {
   this.db.prepare("DELETE FROM douyin_inbox WHERE status IN ('done','dismissed') AND updated_at < ?").run(Date.now() - keepMs);
   this.db.prepare('DELETE FROM douyin_inbox_gap WHERE acknowledged = 1 AND created_at < ?').run(Date.now() - keepMs);
  } catch { /* 卫生工作失败不影响收件 */ }
 }
 next() { return this.db.prepare("SELECT m.id,m.payload FROM douyin_inbox m WHERE m.status='pending' AND NOT EXISTS (SELECT 1 FROM douyin_inbox u WHERE u.channel_id=m.channel_id AND u.id<m.id AND u.status='unknown') ORDER BY m.id LIMIT 1").get() ?? null; }
 /** 一条 unknown 挡住的同会话待处理消息数（给「全部忽略」用）。 */
 blockedBehind(id) {
  const row = this.db.prepare('SELECT channel_id FROM douyin_inbox WHERE id=?').get(id);
  if (row === undefined) return 0;
  return Number(this.db.prepare("SELECT COUNT(*) n FROM douyin_inbox WHERE channel_id=? AND id>? AND status='pending'").get(row.channel_id, id).n);
 }
 /** 一次把所有 unknown 标成 dismissed（用户核实过、不想逐条点）。 */
 dismissAllUnknown() {
  return Number(this.db.prepare("UPDATE douyin_inbox SET status='dismissed',error='用户已核实并全部忽略',updated_at=? WHERE status='unknown'").run(Date.now()).changes);
 }
 /** 一次把所有未确认的缺口提示标成已知晓。 */
 acknowledgeAllGaps() {
  return Number(this.db.prepare('UPDATE douyin_inbox_gap SET acknowledged=1 WHERE acknowledged=0').run().changes);
 }
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
  // 界面只显示前 10 条，所以「还有多少条没显示」要单独给，否则用户以为清完了。
  const unknownTotal=Number(this.db.prepare("SELECT COUNT(*) n FROM douyin_inbox WHERE status='unknown'").get().n);
  const pendingTotal=Number(this.db.prepare("SELECT COUNT(*) n FROM douyin_inbox WHERE status='pending'").get().n);
  return {counts:Object.fromEntries(counts.map(x=>[x.status,x.n])),unknownTotal,pendingTotal,review,gaps,gapCount};
 }
}
