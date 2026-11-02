// 第二步审查的 7 个问题：备份恢复丢 WAL、续传模型全挂标完成、世界书正则 ReDoS、预览日期、import_job 清理、空时间段、扫描深度。
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const home = mkdtempSync(join(tmpdir(), 'fs-review-'));
process.env.DSH_HOME = home;
const { openDatabase, fishSoulDir } = await import('../lib/db.js');
const { BackupService, applyPendingRestore, backupDir } = await import('../lib/backup.js');
const { HistoryImporter, buildEras, coverageOf } = await import('../lib/history-import.js');
const { matchLore, setRegexWarn } = await import('../lib/worldinfo.js');
const { ChatJournal } = await import('../lib/soul-memory.js');
const ok = (s) => console.log(`  ✓ ${s}`);

// P0-1：库打不开时的兜底拷贝（库 + WAL）→ 选它恢复 → 换回后 WAL 里的数据还在
{
	const src = join(home, 'walsrc.db');
	const w = new DatabaseSync(src);
	w.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
	w.exec("CREATE TABLE memory (id INTEGER PRIMARY KEY, content TEXT, status TEXT); CREATE TABLE person (id INTEGER); CREATE TABLE kv (k TEXT); CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42); INSERT INTO memory (content, status) VALUES ('只在 WAL 里', 'active');");
	assert.ok(existsSync(`${src}-wal`));
	// 和 backup.js 的兜底一样：原样拷库文件 + -wal（不关连接，WAL 不会合并）
	const { mkdirSync } = await import('node:fs');
	mkdirSync(backupDir(), { recursive: true });
	const out = join(backupDir(), 'pre-restore-20261102-000000.db');
	copyFileSync(src, out);
	copyFileSync(`${src}-wal`, `${out}-wal`);
	w.close();
	const db = openDatabase();
	const svc = new BackupService({ db, getConfig: () => ({}), log: () => {} });
	assert.equal(svc.stageRestore('pre-restore-20261102-000000.db').memories, 1, '校验时 WAL 里的也算上');
	db.close();
	const r = applyPendingRestore({ log: () => {}, nowMs: Date.parse('2026-11-03T00:00:00') });
	assert.equal(r.file, 'pre-restore-20261102-000000.db');
	const back = new DatabaseSync(join(fishSoulDir(), 'soul.db'));
	assert.equal(back.prepare('SELECT x FROM t').get().x, 42, '最后一次 checkpoint 之后的写入不丢');
	back.close();
	for (const x of ['', '-wal', '-shm']) rmSync(join(fishSoulDir(), `soul.db${x}`), { force: true });
	ok('P0-1 带 WAL 的另存能完整换回（合并 WAL / 连 WAL 一起拷）');
}

// P0-2：继续时模型全挂 → 出错、停在原地、还能继续
{
	const db = openDatabase();
	const clock = { now: () => Date.parse('2025-01-01T00:00:00Z') };
	const worker = { enqueueRealtime() {} };
	const lines = [];
	for (let i = 0; i < 40; i++) lines.push(`2024-01-0${1 + (i % 5)} 08:00:${String(i).padStart(2, '0')} 阿甲(10001)`, `第 ${i} 条 ${'今天发生了好多事情，'.repeat(30)}`, '');
	let mode = 'hang';
	let n = 0;
	const llm = (_p, o) => {
		n++;
		if (mode === 'null') return Promise.resolve(null);
		if (n === 2) return new Promise((_r, rej) => o?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
		return Promise.resolve(JSON.stringify({ memories: [{ content: `第 ${n} 次提炼出来的事情`, kind: 'fact' }], relation: 'friend' }));
	};
	const mk = () => new HistoryImporter({ db, clock, worker, callLlm: llm, personaName: () => '小鱼', masterQq: () => '', selfQq: () => '' });
	const a = mk();
	const pv = a.preview({ text: lines.join('\n'), fileName: 'x.txt' });
	const job = a.start({ previewId: pv.previewId, maxCalls: 2 });
	assert.equal(job.total, 2);
	await new Promise((r) => setTimeout(r, 80));
	const b = mk();
	assert.deepEqual([b.state().status, b.state().done], ['interrupted', 1]);
	mode = 'null';
	b.resume(job.id);
	await b.idle();
	const st = b.state();
	assert.deepEqual([st.status, st.done, st.total, st.resumable], ['error', 1, 2, true]);
	ok('P0-2 继续时模型没回：标出错、不算完成、还能再继续');

	// P1-5：导完 / 放弃的清掉 plan，只留最近 20 份
	for (let i = 0; i < 25; i++) db.prepare("INSERT INTO import_job (id, status, file_name, file_hash, format, plan, progress, created_at, updated_at) VALUES (?, 'done', '', '', '', '{\"big\":1}', '{}', ?, ?)").run(`old${i}`, i, i);
	b.pruneJobs();
	assert.equal(db.prepare('SELECT COUNT(*) n FROM import_job').get().n, 20);
	assert.equal(db.prepare("SELECT COUNT(*) n FROM import_job WHERE status = 'done' AND plan != ''").get().n, 0);
	assert.equal(db.prepare('SELECT status FROM import_job WHERE id = ?').get(job.id).status, 'error', '没跑完的保留');
	ok('P1-5 import_job：导完的清 plan，总数有上限');
	db.close();
}

// P0-3：灾难性回溯的正则限时、超时后停用
{
	const warned = [];
	setRegexWarn((k) => warned.push(k));
	const lore = [{ keys: ['/^(a+)+$/'], content: '坏' }, { keys: ['/喵+/'], content: '好' }];
	const t = Date.now();
	const hits = matchLore(lore, ['a'.repeat(35) + 'b'], { limit: 4 });
	assert.ok(Date.now() - t < 1000, `不能卡住（用了 ${Date.now() - t}ms）`);
	assert.deepEqual(hits.map((e) => e.content), []);
	assert.deepEqual(warned, ['/^(a+)+$/']);
	const t2 = Date.now();
	assert.deepEqual(matchLore(lore, ['a'.repeat(35) + 'b 喵喵'], { limit: 4 }).map((e) => e.content), ['好']);
	assert.ok(Date.now() - t2 < 50, '停用后不再跑');
	ok('P0-3 世界书正则限时 30ms，超时就停用并记日志');
}

// P1-4 / P1-6：预览的逐段起点不算时间段总结；超长单行的时间段不是空的
{
	const persons = [{ name: 'a', qq: '1', dropped: { chunks: 3, chars: 1 }, chunks: [{ era: true, startMs: 0 }, { startMs: 5000 }] }];
	assert.equal(coverageOf(persons).topTruncated[0].keptFromMs, 5000);
	const long = 'x'.repeat(4000);
	const eras = buildEras([1, 2, 3].map((i) => ({ chatTitle: 't', kind: 'private', channelId: '', startMs: i, endMs: i, text: `${long}\n` })));
	assert.equal(eras.length, 3);
	assert.ok(eras.every((e) => e.text.trim().length > 1000), '不交空白段给模型');
	assert.equal(buildEras([{ chatTitle: 't', kind: 'private', startMs: 1, endMs: 1, text: '\n' }]).length, 0, '没内容的时间段跳过');
	ok('P1-4 逐段起点取第一段非总结；P1-6 超长单行截断、空时间段不调用');
}

// P1-7：聊天日志能给世界书 50 句
{
	const j = new ChatJournal({ keepRecent: 50 });
	for (let i = 0; i < 60; i++) j.add('c', { who: 'a', text: `第${i}句` });
	assert.equal(j.recent('c', 50).length, 50);
	ok('P1-7 扫描深度 50 真能拿到 50 句');
}
rmSync(home, { recursive: true, force: true });
console.log('review-fixes ok');
