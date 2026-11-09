/** 发布确认前的持久化记录。unknown 不自动重发，必须由用户核实。 */
export class DouyinPostJobs {
 constructor(db) {
  this.db = db;
  db.exec(`CREATE TABLE IF NOT EXISTS douyin_post_job (
   id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, role_date TEXT NOT NULL,
   status TEXT NOT NULL, card_path TEXT NOT NULL DEFAULT '', music TEXT NOT NULL DEFAULT '',
   error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.prepare("UPDATE douyin_post_job SET status='unknown', error='上次提交中断，结果未知，请先核实', updated_at=? WHERE status='submitting'").run(Date.now());
  db.prepare("UPDATE douyin_post_job SET status='failed', error='发布准备中断，未提交', updated_at=? WHERE status='preparing'").run(Date.now());
 }
 pending() { return this.db.prepare("SELECT * FROM douyin_post_job WHERE status IN ('submitting','unknown') ORDER BY id LIMIT 1").get() ?? null; }
 begin(text, roleDate) {
  if (this.pending()) throw Error('有作品提交结果未知，请先核实后处理');
  return Number(this.db.prepare("INSERT INTO douyin_post_job(text,role_date,status,created_at,updated_at) VALUES (?,?,'preparing',?,?)").run(text,roleDate,Date.now(),Date.now()).lastInsertRowid);
 }
 prepared(id, card, music) { this.db.prepare("UPDATE douyin_post_job SET card_path=?, music=?, updated_at=? WHERE id=? AND status='preparing'").run(card,music,Date.now(),id); }
 submitting(id) {
  const r=this.db.prepare("UPDATE douyin_post_job SET status='submitting',updated_at=? WHERE id=? AND status='preparing'").run(Date.now(),id);
  if (Number(r.changes)!==1) throw Error('发布任务状态异常，停止发布');
 }
 confirm(id) {
  const r=this.db.prepare("UPDATE douyin_post_job SET status='confirmed',error='',updated_at=? WHERE id=? AND status='submitting'").run(Date.now(),id);
  if (Number(r.changes)!==1) throw Error('发布任务状态异常，需核实');
 }
 fail(id, error) {
  this.db.prepare("UPDATE douyin_post_job SET status=CASE status WHEN 'submitting' THEN 'unknown' ELSE 'failed' END, error=?,updated_at=? WHERE id=? AND status IN ('preparing','submitting')").run(String(error).slice(0,300),Date.now(),id);
 }
 resolvePublished(id) {
  return Number(this.db.prepare("UPDATE douyin_post_job SET status='confirmed_manual',error='用户核实已发布',updated_at=? WHERE id=? AND status='unknown'").run(Date.now(),id).changes) === 1;
 }
 resolveNotPublished(id) {
  return Number(this.db.prepare("UPDATE douyin_post_job SET status='not_published',error='用户核实未发布',updated_at=? WHERE id=? AND status='unknown'").run(Date.now(),id).changes) === 1;
 }
}
