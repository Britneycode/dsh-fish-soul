/**
 * time-util.js —— 时间相关的极小共享工具（零依赖）。
 */

/**
 * 等一会儿。定时器 unref，不让这个等待挡住 Node 进程退出
 *（后台轮询里 sleep 时，宿主要退出就退，别被一条 sleep 吊住）。
 */
export const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** 两位补零：1 → '01'（备份文件名 / 时间戳格式化共用）。 */
export function pad2(n) {
	return String(n).padStart(2, '0');
}

/** 本地时间 YYYYMMDD-HHmmss（备份目录名）。 */
export function stampLocal(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 本地时间 YYYYMMDD（导出文件名）。 */
export function dateCompact(d = new Date()) {
	return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}
