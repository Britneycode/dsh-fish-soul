/**
 * backup.js —— soul.db 备份（v0.6）：养了半年的"她"不能因为一次误删 / 硬盘坏掉就没了。
 *
 *  - `VACUUM INTO` 拷一份完整、一致的库（WAL 模式下也安全，不用停插件）到 $DSH_HOME/fish-soul/backups/；
 *  - 打开自动备份时每天一份（真实时间，插件启动 1 分钟后先看一眼），只留最近 keep 份；
 *  - 恢复（设置页点「恢复到这份」）：先校验备份能打开、结构对、quick_check 通过，记一个 restore-pending.json；
 *    下次插件启动、打开 soul.db 之前换上去（运行中的库被很多模块拿着，不在跑着的时候硬换）。换之前把当前的库
 *    VACUUM INTO 另存成 backups/pre-restore-时间.db（恢复错了还能换回来，最多留 3 份），再删掉旧的 -wal / -shm。
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fishSoulDir, getKv, setKv } from './db.js';

const DAY_MS = 24 * 3600_000;
const CHECK_MS = 3600_000;
const NAME_RE = /^soul-\d{8}-\d{6}\.db$/;
const PRE_RE = /^pre-restore-\d{8}-\d{6}\.db$/;
const PRE_KEEP = 3;
const REQUIRED_TABLES = ['memory', 'person', 'kv'];

function pendingPath() {
	return join(fishSoulDir(), 'restore-pending.json');
}

/** 等着下次启动换上去的备份（没有 = null）。 */
export function pendingRestore() {
	try { return JSON.parse(readFileSync(pendingPath(), 'utf8')); } catch { return null; }
}

/** 备份文件能不能用：打得开、quick_check 通过、有记忆 / 人物 / kv 表。返回 { memories, persons }。 */
export function inspectBackup(path) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const check = db.prepare('PRAGMA quick_check').get();
		const ok = Object.values(check ?? {})[0];
		if (ok !== 'ok') throw new Error(`备份文件损坏（${String(ok).slice(0, 60)}）`);
		const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
		const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
		if (missing.length > 0) throw new Error(`不像 soul.db 的备份（缺表 ${missing.join('、')}）`);
		return {
			memories: db.prepare("SELECT COUNT(*) AS n FROM memory WHERE status = 'active'").get().n,
			persons: db.prepare('SELECT COUNT(*) AS n FROM person').get().n
		};
	} finally {
		db.close();
	}
}

/**
 * 插件启动时、openDatabase() 之前调：有待恢复的备份就换上去。
 * @returns {{file: string, safety: string|null, at: number} | null}
 */
export function applyPendingRestore({ log = () => {}, nowMs = Date.now() } = {}) {
	const pending = pendingRestore();
	if (pending === null) return null;
	const dir = backupDir();
	const src = join(dir, String(pending.file ?? ''));
	const target = join(fishSoulDir(), 'soul.db');
	const drop = () => rmSync(pendingPath(), { force: true });
	if (!(NAME_RE.test(pending.file) || PRE_RE.test(pending.file)) || !existsSync(src)) {
		log('warn', `[fish-soul] 要恢复的备份 ${pending.file} 不在了，没换`);
		drop();
		return null;
	}
	try {
		inspectBackup(src);
	} catch (error) {
		log('error', `[fish-soul] 要恢复的备份 ${pending.file} 校验失败，没换：${String(error instanceof Error ? error.message : error)}`);
		drop();
		return null;
	}
	// 当前的库先另存一份（VACUUM INTO 连 WAL 里没合并的也带上；库坏到打不开就原样拷文件）
	let safety = null;
	if (existsSync(target)) {
		mkdirSync(dir, { recursive: true });
		let name = `pre-restore-${stamp(nowMs)}.db`;
		for (let i = 1; existsSync(join(dir, name)); i++) name = `pre-restore-${stamp(nowMs + i * 1000)}.db`;
		const out = join(dir, name);
		try {
			const cur = new DatabaseSync(target);
			try { cur.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); } finally { cur.close(); }
		} catch {
			copyFileSync(target, out);
			if (existsSync(`${target}-wal`)) copyFileSync(`${target}-wal`, `${out}-wal`);
		}
		safety = name;
	}
	const tmp = `${target}.restoring`;
	copyFileSync(src, tmp);
	rmSync(`${target}-wal`, { force: true });
	rmSync(`${target}-shm`, { force: true });
	renameSync(tmp, target);
	drop();
	// 恢复前的另存只留最近几份
	try {
		const pres = readdirSync(dir).filter((f) => PRE_RE.test(f)).sort().reverse();
		for (const f of pres.slice(PRE_KEEP)) { rmSync(join(dir, f), { force: true }); rmSync(join(dir, `${f}-wal`), { force: true }); }
	} catch { /* 下次再删 */ }
	log('info', `[fish-soul] 已从备份 ${pending.file} 恢复 soul.db${safety ? `（恢复前的库另存为 ${safety}）` : ''}`);
	return { file: pending.file, safety, at: nowMs };
}

export function backupDir() {
	return join(fishSoulDir(), 'backups');
}

function stamp(ms) {
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class BackupService {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => {auto?: boolean, keep?: number}} deps.getConfig
	 * @param {(level: string, msg: string) => void} [deps.log]
	 */
	constructor({ db, getConfig, log }) {
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.timer = null;
		this.first = null;
	}

	config() {
		const c = this.getConfig() ?? {};
		const keep = Math.floor(Number(c.keep));
		return { auto: c.auto !== false, keep: Number.isFinite(keep) ? Math.min(60, Math.max(1, keep)) : 7 };
	}

	start() {
		const check = () => { try { this.maybeAuto(); } catch (error) { this.log('warn', `[fish-soul] 自动备份失败：${String(error instanceof Error ? error.message : error)}`); } };
		this.first = setTimeout(check, 60_000);
		this.first.unref?.();
		this.timer = setInterval(check, CHECK_MS);
		this.timer.unref?.();
	}

	stop() {
		clearTimeout(this.first);
		clearInterval(this.timer);
		this.first = null;
		this.timer = null;
	}

	/** 自动备份打开、且距上次备份满一天：备一份。 */
	maybeAuto(nowMs = Date.now()) {
		const cfg = this.config();
		if (!cfg.auto) return null;
		const last = Number(getKv(this.db, 'backup.lastAt', 0)) || 0;
		if (nowMs - last < DAY_MS) return null;
		return this.backupNow(nowMs);
	}

	/** 立刻备一份；返回 { file, path, size, at }。 */
	backupNow(nowMs = Date.now()) {
		const dir = backupDir();
		mkdirSync(dir, { recursive: true });
		let name = `soul-${stamp(nowMs)}.db`;
		for (let i = 1; existsSync(join(dir, name)); i++) name = `soul-${stamp(nowMs + i * 1000)}.db`;
		const path = join(dir, name);
		// VACUUM INTO 的目标路径不能用参数绑定，只能拼字符串：路径是我们自己生成的，单引号转义一下兜底
		this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
		setKv(this.db, 'backup.lastAt', nowMs);
		this.prune();
		const size = statSync(path).size;
		this.log('info', `[fish-soul] 已备份 soul.db → ${path}（${Math.round(size / 1024)} KB）`);
		return { file: name, path, size, at: nowMs };
	}

	/** 只留最近 keep 份（只动我们自己生成的 soul-YYYYMMDD-HHMMSS.db）。 */
	prune() {
		const { keep } = this.config();
		const files = this.list();
		for (const f of files.slice(keep)) {
			try { unlinkSync(join(backupDir(), f.file)); } catch { /* 下次再删 */ }
		}
	}

	/** 现有备份，新的在前（只是自动 / 手动备份；恢复前的另存见 preRestoreList）。 */
	list() {
		return this.files(NAME_RE);
	}

	preRestoreList() {
		return this.files(PRE_RE).map((f) => ({ ...f, preRestore: true }));
	}

	files(re) {
		const dir = backupDir();
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((f) => re.test(f)).map((f) => {
			const st = statSync(join(dir, f));
			return { file: f, size: st.size, at: st.mtimeMs };
		}).sort((a, b) => (a.file < b.file ? 1 : -1));
	}

	/** 选一份备份，下次启动时换上去（先校验）。 */
	stageRestore(file) {
		const name = String(file ?? '');
		if (!(NAME_RE.test(name) || PRE_RE.test(name))) throw new Error('不是插件生成的备份文件');
		const path = join(backupDir(), name);
		if (!existsSync(path)) throw new Error('这份备份不在了');
		const info = inspectBackup(path);
		const pending = { file: name, at: Date.now(), ...info };
		writeFileSync(pendingPath(), JSON.stringify(pending), 'utf8');
		this.log('info', `[fish-soul] 已选好要恢复的备份 ${name}（${info.memories} 条记忆），重启 DSH 后换上`);
		return pending;
	}

	cancelRestore() {
		const had = pendingRestore() !== null;
		rmSync(pendingPath(), { force: true });
		return had;
	}

	state() {
		const cfg = this.config();
		return {
			...cfg, dir: backupDir(), lastAt: Number(getKv(this.db, 'backup.lastAt', 0)) || null, list: this.list().slice(0, 10),
			preRestore: this.preRestoreList(), pendingRestore: pendingRestore(), lastRestored: getKv(this.db, 'backup.restored', null)
		};
	}
}
