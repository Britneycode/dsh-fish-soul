/**
 * attachments.js —— QQ 附件（文件消息）处理：文本类直接读进正文，看不了的格式存到插件数据目录再报路径。
 *
 * 只碰白名单目录里的文件（工作区 / 插件数据目录）：路径不在里面、文件已经没了、读失败，
 * 一律保留原来的【文件：名字】占位，不往提示词里塞来路不明的东西。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { isInside } from './gateway-util.js';

/** 能直接读进提示词的扩展名。 */
const TEXT_EXT = new Set(['.txt', '.md', '.log', '.csv', '.json']);
/** 超过这个大小就不读（提示词放不下）。 */
const MAX_TEXT_BYTES = 256 * 1024;
/** 直读最多读前多少字节。 */
const MAX_READ_BYTES = 8 * 1024;
/** 二进制落盘单文件上限（超过就保留占位）。 */
const MAX_BINARY_BYTES = 32 * 1024 * 1024;
/** 正文里附件的占位（onebot.js 生成的）；用户自己打的【】会被换成〔〕，撞不上。 */
const PLACEHOLDER_RE = /【文件[^】]*】/g;

/** 附件开关：读文本 / 存二进制。 */
export function attachmentConfig(cfg) {
	const a = cfg?.attachments ?? {};
	return { readText: a.readText !== false, saveBinary: a.saveBinary === true };
}

/** 文件名里不能有的字符（Windows 也不能有），顺手去掉开头的小点。 */
function safeName(name) {
	return String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 60);
}

/** 读前 8KB；切在多字节字符中间会多出一个替换字符，丢掉。 */
function readHead(abs) {
	const buf = readFileSync(abs);
	const truncated = buf.length > MAX_READ_BYTES;
	const slice = buf.subarray(0, MAX_READ_BYTES);
	// 先检测是否合法 UTF-8；非法就抛异常（调用方 catch 保留占位）
	new TextDecoder('utf-8', { fatal: true }).decode(slice);
	const text = slice.toString('utf8');
	// 切在多字节字符中间会多出一个替换字符（U+FFFD），丢掉
	const clean = text.length > 0 && text.codePointAt(text.length - 1) === 0xfffd ? text.slice(0, -1) : text;
	return { text: clean, truncated };
}

/**
 * fileId 路线（SnowLuma 这类不给 path 的）：get_private_file_url 换直链 → 下载 → 按扩展名读进正文或落盘。
 * 拿不到链接 / 下载失败 / 超上限：返回 null 保留占位。
 */
async function handleDownload(f, ctx, meta) {
	const { name, ext, size, label, warn } = meta;
	const fileId = String(f?.fileId ?? '').trim();
	const fileHash = String(f?.fileHash ?? '').trim();
	if (typeof ctx.fetchFile !== 'function') { warn('没有文件下载通道'); return null; }
	if (size > MAX_BINARY_BYTES) { warn('太大了，没拉'); return null; }
	let bytes = null;
	try {
		bytes = await ctx.fetchFile({ fileId, fileHash, url: String(f?.url ?? '') });
	} catch {
		warn('下载失败');
		return null;
	}
	if (bytes === null || bytes.length === 0) { warn('没拉到内容'); return null; }
	if (bytes.length > MAX_BINARY_BYTES) { warn('太大了，没拉'); return null; }

	if (TEXT_EXT.has(ext)) {
		if (!ctx.readText) return null;
		if (bytes.length > MAX_TEXT_BYTES) { warn('太大了，没读'); return null; }
		const slice = bytes.subarray(0, MAX_READ_BYTES);
		try { new TextDecoder('utf-8', { fatal: true }).decode(slice); } catch { warn('不是有效 UTF-8'); return null; }
		const text = slice.toString('utf8');
		const clean = text.length > 0 && text.codePointAt(text.length - 1) === 0xfffd ? text.slice(0, -1) : text;
		ctx.read.push(label);
		const body = bytes.length > MAX_READ_BYTES ? `${clean}\n…（内容太长，只读了前 8KB）` : clean;
		return `【文件 ${label} 内容】\n${body}`;
	}

	if (!ctx.saveBinary) return null;
	const dir = String(ctx.dataDir ?? '');
	if (dir === '') { warn('没有存放目录'); return null; }
	const base = safeName(name);
	const dest = join(dir, `${safeName(ctx.messageId) || 'file'}-${base !== '' ? base : '附件'}`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(dest, bytes);
	} catch {
		warn('存不下来');
		return null;
	}
	ctx.saved.push(dest);
	return `【文件 ${label}：我看不了这种格式，已存到 ${dest}】`;
}

/**
 * 一个附件怎么处理：返回替换占位的新文本，处理不了返回 null（占位原样留着）。
 * SnowLuma 这类不给本地 path 的：先用 fetchFile（get_private_file_url 换链接再下载）拿到 bytes 再走同一套逻辑。
 * @param {{name?: string, path?: string, url?: string, size?: number, fileId?: string, fileHash?: string}} f
 * @param {object} ctx
 */
async function handleOne(f, ctx) {
	const name = String(f?.name ?? '').trim();
	const rawPath = String(f?.path ?? '').trim();
	const abs = rawPath === '' ? '' : resolve(rawPath);
	const ext = extname(name !== '' ? name : rawPath).toLowerCase();
	const size = Number(f?.size) || 0;
	const label = name !== '' ? name : rawPath !== '' ? basename(rawPath) : '未命名';
	const warn = (why) => ctx.log?.('warn', `[fish-soul] 附件没读进去（${why}）：${label}`);

	// SnowLuma 路线：没有本地 path，但有 fileId——先用 OneBot API 换链接下载
	const fileId = String(f?.fileId ?? '').trim();
	if (abs === '' && fileId !== '') return await handleDownload(f, ctx, { name, ext, size, label, warn });

	if (abs === '') { warn('没有本地路径'); return null; }
	if (!ctx.roots.some((root) => isInside(root, abs))) { warn('路径不在允许的目录里'); return null; }
	if (!existsSync(abs)) { warn('文件不在了'); return null; }

	// P0 修复：白名单和源文件都做 realpath，防符号链接 / Windows junction 绕过
	let realRoots;
	try { realRoots = ctx.roots.filter((r) => { try { realpathSync.native(r); return true; } catch { return false; } }).map((r) => realpathSync.native(r)); } catch { realRoots = []; }
	let realAbs;
	try { realAbs = realpathSync.native(abs); } catch { warn('解析真实路径失败'); return null; }
	if (!realRoots.some((root) => isInside(root, realAbs))) { warn('真实路径越界（符号链接/junction）'); return null; }

	if (TEXT_EXT.has(ext)) {
		if (!ctx.readText) return null; // 开关关着：跟以前一样，只留占位
		if (size > MAX_TEXT_BYTES) { warn('太大了，没读'); return null; }
		let st;
		try { st = statSync(realAbs); } catch { warn('拿不到文件信息'); return null; }
		if (!st.isFile()) { warn('不是文件'); return null; }
		if (st.size > MAX_TEXT_BYTES) { warn('太大了，没读'); return null; }
		let head;
		try { head = readHead(realAbs); } catch { warn('读取失败'); return null; }
		ctx.read.push(label);
		const body = head.truncated ? `${head.text}\n…（内容太长，只读了前 8KB）` : head.text;
		return `【文件 ${label} 内容】\n${body}`;
	}

	if (!ctx.saveBinary) return null; // 不存二进制：跟以前一样，只留占位
	// P1 修复：二进制也设上限，防大文件占满磁盘
	if (size > MAX_BINARY_BYTES) { warn('二进制太大，没存'); return null; }
	let bst;
	try { bst = statSync(realAbs); } catch { warn('拿不到文件信息'); return null; }
	if (!bst.isFile()) { warn('不是普通文件'); return null; }
	if (bst.size > MAX_BINARY_BYTES) { warn('二进制太大，没存'); return null; }
	const dir = String(ctx.dataDir ?? '');
	if (dir === '') { warn('没有存放目录'); return null; }
	const base = safeName(name) !== '' ? safeName(name) : safeName(basename(realAbs));
	const dest = join(dir, `${safeName(ctx.messageId) || 'file'}-${base !== '' ? base : '附件'}`);
	try {
		mkdirSync(dir, { recursive: true });
		copyFileSync(realAbs, dest);
	} catch {
		warn('存不下来');
		return null;
	}
	ctx.saved.push(dest);
	return `【文件 ${label}：我看不了这种格式，已存到 ${dest}】`;
}

/**
 * 把附件处理进消息正文：占位换成内容（或存下来的路径），处理不了的占位原样留着。
 * @param {string} text 原正文（里面有【文件：名字】占位）
 * @param {Array<{name?: string, path?: string, url?: string, size?: number}>} files 附件（顺序与占位一致）
 * @param {{readText?: boolean, saveBinary?: boolean, roots?: string[], dataDir?: string, messageId?: string, log?: (level: string, msg: string) => void}} opts
 * @returns {{text: string, read: string[], saved: string[]}} read = 读进正文的附件名，saved = 落盘的绝对路径
 */
export async function applyAttachments(text, files, opts = {}) {
	const src = String(text ?? '');
	const list = Array.isArray(files) ? files : [];
	if (list.length === 0) return { text: src, read: [], saved: [] };
	const marks = [...src.matchAll(PLACEHOLDER_RE)];
	if (marks.length === 0) return { text: src, read: [], saved: [] };
	const ctx = { readText: true, saveBinary: false, roots: [], dataDir: '', messageId: '', log: () => {}, ...opts };
	const read = [];
	const saved = [];
	ctx.read = read;
	ctx.saved = saved;
	const repl = await Promise.all(marks.map((mark, i) => (list[i] === undefined ? null : handleOne(list[i], ctx))));
	// 从后往前替换，前面占位的位置不受影响
	let out = src;
	for (let i = repl.length - 1; i >= 0; i--) {
		if (repl[i] === null) continue;
		const at = marks[i].index;
		out = out.slice(0, at) + repl[i] + out.slice(at + marks[i][0].length);
	}
	return { text: out, read, saved };
}
