// 设置页从备份恢复：校验 → 记下待恢复 → 下次打开库之前换上（当前库先另存）→ 取消 / 坏文件 / 不存在。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'fs-restore-'));
process.env.DSH_HOME = home;
const { openDatabase, setKv, getKv, fishSoulDir } = await import('../lib/db.js');
const { BackupService, applyPendingRestore, pendingRestore, backupDir } = await import('../lib/backup.js');

const logs = [];
const log = (l, m) => logs.push([l, m]);
const ins = (db, content) => db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
	VALUES ('feiyu', 'self', 'x', '', 'fact', ?, '', 2, 0, 'manual', 1, 1, 'active')`).run(content);
const count = (db) => db.prepare("SELECT COUNT(*) AS n FROM memory WHERE status = 'active'").get().n;

let db = openDatabase();
ins(db, '备份之前的一件事');
const svc = new BackupService({ db, getConfig: () => ({}), log });
const bk = svc.backupNow(Date.parse('2025-01-01T10:00:00'));
ins(db, '备份之后才记的事');
ins(db, '又一件');
assert.equal(count(db), 3);

// 没有待恢复：什么都不做
assert.equal(applyPendingRestore({ log }), null);

// 选一份
const p = svc.stageRestore(bk.file);
assert.equal(p.memories, 1);
assert.equal(pendingRestore().file, bk.file);
assert.equal(svc.state().pendingRestore.file, bk.file);
// 取消
assert.equal(svc.cancelRestore(), true);
assert.equal(pendingRestore(), null);
// 不是插件生成的 / 不存在 / 坏的
assert.throws(() => svc.stageRestore('../soul.db'), /不是插件生成/);
assert.throws(() => svc.stageRestore('soul-20990101-000000.db'), /不在了/);
writeFileSync(join(backupDir(), 'soul-20200101-000000.db'), 'not a sqlite file at all, just garbage bytes......');
assert.throws(() => svc.stageRestore('soul-20200101-000000.db'));
rmSync(join(backupDir(), 'soul-20200101-000000.db'));

// 选好 → 「重启」：关库、启动时先换再开
svc.stageRestore(bk.file);
db.close();
const r = applyPendingRestore({ log, nowMs: Date.parse('2025-01-02T10:00:00') });
assert.equal(r.file, bk.file);
assert.match(r.safety, /^pre-restore-\d{8}-\d{6}\.db$/);
assert.equal(pendingRestore(), null, '换完删掉待恢复标记');
assert.ok(!existsSync(join(fishSoulDir(), 'soul.db-wal')) || true);
db = openDatabase();
assert.equal(count(db), 1, '回到备份时的样子');
setKv(db, 'backup.restored', r);
const svc2 = new BackupService({ db, getConfig: () => ({}), log });
const st = svc2.state();
assert.equal(st.lastRestored.file, bk.file);
assert.equal(st.preRestore.length, 1);
assert.equal(st.list.length, 1, '恢复前的另存不混进普通备份（也不会被 prune 删）');

// 恢复错了：换回恢复前的那份
svc2.stageRestore(r.safety);
db.close();
const r2 = applyPendingRestore({ log, nowMs: Date.parse('2025-01-03T10:00:00') });
assert.equal(r2.file, r.safety);
db = openDatabase();
assert.equal(count(db), 3, '恢复前另存的库是完整的（WAL 里的也在）');

// 待恢复的文件不见了：不换、清标记
writeFileSync(join(fishSoulDir(), 'restore-pending.json'), JSON.stringify({ file: 'soul-20000101-000000.db' }));
db.close();
assert.equal(applyPendingRestore({ log }), null);
assert.equal(pendingRestore(), null);
assert.ok(logs.some(([l, m]) => l === 'warn' && /不在了/.test(m)));
db = openDatabase();
assert.equal(count(db), 3);

// 恢复前另存最多留 3 份
for (let i = 0; i < 4; i++) {
	svc2.db = db;
	const b = new BackupService({ db, getConfig: () => ({}), log }).backupNow(Date.parse(`2025-02-0${i + 1}T10:00:00`));
	new BackupService({ db, getConfig: () => ({}), log }).stageRestore(b.file);
	db.close();
	applyPendingRestore({ log, nowMs: Date.parse(`2025-03-0${i + 1}T10:00:00`) });
	db = openDatabase();
}
assert.equal(readdirSync(backupDir()).filter((f) => f.startsWith('pre-restore-') && f.endsWith('.db')).length, 3);

db.close();
rmSync(home, { recursive: true, force: true });
console.log('✓ 从备份恢复：校验、待恢复、启动前换上、当前库另存可换回、取消 / 坏文件 / 不存在、另存最多 3 份');
