/**
 * backup.js —— soul.db 备份（v0.6）：养了半年的"她"不能因为一次误删 / 硬盘坏掉就没了。
 *
 *  - `VACUUM INTO` 拷一份完整、一致的库（WAL 模式下也安全，不用停插件）到 $DSH_HOME/fish-soul/backups/；
 *  - 打开自动备份时每天一份（真实时间，插件启动 1 分钟后先看一眼），只留最近 keep 份；
 *  - 恢复不在插件里做：停掉 DSH，把备份文件改名成 soul.db 覆盖回去即可（设置页给出路径）。
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fishSoulDir, getKv, setKv } from './db.js';

const DAY_MS = 24 * 3600_000;
const CHECK_MS = 3600_000;
const NAME_RE = /^soul-\d{8}-\d{6}\.db$/;

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

	/** 现有备份，新的在前。 */
	list() {
		const dir = backupDir();
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((f) => NAME_RE.test(f)).map((f) => {
			const st = statSync(join(dir, f));
			return { file: f, size: st.size, at: st.mtimeMs };
		}).sort((a, b) => (a.file < b.file ? 1 : -1));
	}

	state() {
		const cfg = this.config();
		return { ...cfg, dir: backupDir(), lastAt: Number(getKv(this.db, 'backup.lastAt', 0)) || null, list: this.list().slice(0, 10) };
	}
}
