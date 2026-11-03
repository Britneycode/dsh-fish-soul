// 测试用临时目录：进程退出时自动删除。
// 之前各测试直接 mkdtempSync 不清理，跑一轮 npm test 就在 TMPDIR 里留一堆目录
// （douyin-browser 每个还带一整个 Edge profile，~110MB）。
import { mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = new Set();
let hooked = false;

/** 由里往外逐个删；哪个删不掉（比如 sqlite 句柄还开着）就跳过它继续删别的，别一个文件卡住整个目录。 */
function wipe(dir) {
	let entries;
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { wipe(p); try { rmdirSync(p); } catch { /* 忽略 */ } } else {
			try { unlinkSync(p); } catch { /* 忽略 */ }
		}
	}
	try { rmdirSync(dir); } catch { /* 忽略 */ }
}

export function tmpHome(prefix) {
	if (!hooked) {
		hooked = true;
		// 上一轮留下的 soul.db 被 sqlite 句柄锁着删不掉（Windows），只留几 K。同前缀的老目录在这里补删：
		// 只碰 5 分钟前的，正在并行跑的测试不会误伤。稳态就不长了。
		const old = Date.now() - 5 * 60 * 1000;
		try {
			for (const e of readdirSync(tmpdir(), { withFileTypes: true })) {
				if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
				const p = join(tmpdir(), e.name);
				try { if (statSync(p).mtimeMs < old) wipe(p); } catch { /* 忽略 */ }
			}
		} catch { /* 忽略 */ }
		// 进程退出时统一删。db 句柄此刻可能还没关，soul.db 这类文件会留下来，下一轮再收。
		process.on('exit', () => {
			for (const d of made) wipe(d);
			made.clear();
		});
	}
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.add(dir);
	return dir;
}
