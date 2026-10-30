/**
 * imageconv.js —— 发到 B站 / 抖音前的图片整理：B站图床和抖音网页端都只收 png / jpg / gif，
 * 表情包里的 webp 要先转（静态 → png，动图 → gif）。
 *
 * 转换器按顺序找：
 *   ① 宿主自带的 sharp（DSH 桌面版的 dsh-attachment-local 带了一份）；
 *   ② 抖音专用浏览器里用 canvas 转（只能转成 png，动图只留第一帧）；
 *   都没有就不把 webp 表情包给 B站 / 抖音用。
 * 转好的放进插件数据目录 img-cache/（按内容哈希），不动工作区 _stickers/ 里的原文件；转出来超过 5 MB 的不用。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateRoots } from './hostdeps.mjs';

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/** 文件头 → 类型（认不出返回 ''）。 */
export function sniffImage(buf) {
	if (!buf || buf.length < 12) return '';
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
	if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
	if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
	return '';
}

/** webp 是不是动图（VP8X 扩展头的动画位，或者有 ANIM 块）。 */
export function isAnimatedWebp(buf) {
	if (sniffImage(buf) !== 'webp') return false;
	if (buf.toString('ascii', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0) return true;
	return buf.indexOf('ANIM', 12, 'ascii') > 0;
}

/** 宽高（png / gif / jpeg / webp），读不到返回 0。 */
export function imageSize(buf) {
	const t = sniffImage(buf);
	try {
		if (t === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
		if (t === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
		if (t === 'jpeg') {
			let i = 2;
			while (i + 9 < buf.length) {
				if (buf[i] !== 0xff) { i++; continue; }
				const marker = buf[i + 1];
				const len = buf.readUInt16BE(i + 2);
				if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
					return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
				}
				i += 2 + len;
			}
		}
		if (t === 'webp') {
			const chunk = buf.toString('ascii', 12, 16);
			if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
			if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
			if (chunk === 'VP8L') {
				const b = buf.readUInt32LE(21);
				return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
			}
		}
	} catch { /* 头坏了 */ }
	return { width: 0, height: 0 };
}

/** 一个包目录（FISH_SOUL_SHARP 指过来的）里可能的入口：先看 package.json 的 exports / main，再猜老版本的 lib/index.js。 */
function packageEntries(dir) {
	const out = [];
	const pick = (v) => {
		if (typeof v === 'string') return v;
		if (v && typeof v === 'object') return pick(v.import) || pick(v.default) || pick(v.require) || pick(v.node) || '';
		return '';
	};
	try {
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		const exp = pkg.exports;
		const root = exp && typeof exp === 'object' && !Array.isArray(exp) && '.' in exp ? exp['.'] : exp;
		const fromExports = pick(root);
		if (fromExports) out.push(join(dir, fromExports));
		if (typeof pkg.main === 'string' && pkg.main) out.push(join(dir, pkg.main));
	} catch { /* 没有 package.json，直接猜 */ }
	out.push(join(dir, 'lib', 'index.js'), join(dir, 'dist', 'index.mjs'), join(dir, 'dist', 'index.cjs'));
	return [...new Set(out)].filter((f) => existsSync(f));
}

let sharpPromise = null;
let sharpFn = null;
let sharpFrom = '';

/** 找宿主的 sharp（找不到返回 null，只找一次）。 */
export function loadSharp() {
	sharpPromise ??= (async () => {
		const tryImport = async (spec) => {
			try {
				const m = await import(spec);
				const s = m?.default ?? m;
				return typeof s === 'function' ? s : null;
			} catch { return null; }
		};
		const fromEnv = process.env.FISH_SOUL_SHARP;
		if (fromEnv) {
			for (const entry of packageEntries(fromEnv)) {
				const s = await tryImport(pathToFileURL(entry).href);
				if (s) { sharpFrom = fromEnv; return s; }
			}
		}
		let s = await tryImport('sharp');
		if (s) { sharpFrom = 'sharp'; return s; }
		const bases = [];
		if (process.argv[1]) bases.push(process.argv[1]);
		for (const root of candidateRoots()) {
			if (!root) continue;
			bases.push(join(root, 'dsh-attachment-local', 'package.json'), join(root, 'dsh', 'package.json'), join(dirname(root), 'package.json'));
		}
		for (const base of bases) {
			let resolved = '';
			try { resolved = createRequire(base).resolve('sharp'); } catch { continue; }
			s = await tryImport(pathToFileURL(resolved).href);
			if (s) { sharpFrom = resolved; return s; }
		}
		return null;
	})().then((s) => { sharpFn = s; return s; });
	return sharpPromise;
}

/** 同步看一眼：sharp 已经找到了吗（启动时 loadSharp() 先跑一遍）。 */
export function sharpReady() {
	return sharpFn !== null;
}

export function sharpSource() {
	return sharpFrom;
}

/**
 * 图片整理：返回能直接发的 {path, bytes, type, width, height}；发不了返回 null。
 * @param {string} file 本地路径
 * @param {object} opts
 * @param {string} opts.cacheDir 转换结果放这里
 * @param {((bytes: Buffer) => Promise<Buffer|null>)|null} [opts.canvasConvert] 浏览器 canvas 兜底（转 png）
 * @param {(level: string, msg: string) => void} [opts.log]
 */
export async function prepareImage(file, { cacheDir, canvasConvert = null, log = () => {} } = {}) {
	let bytes;
	try {
		if (!existsSync(file) || statSync(file).size > MAX_INPUT_BYTES) return null;
		bytes = readFileSync(file);
	} catch { return null; }
	const type = sniffImage(bytes);
	if (type === '') return null;
	if (type !== 'webp') return { path: file, bytes, type, ...imageSize(bytes) };
	const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 20);
	const animated = isAnimatedWebp(bytes);
	for (const ext of animated ? ['gif', 'png'] : ['png']) {
		const hit = join(cacheDir, `${hash}.${ext}`);
		if (existsSync(hit)) {
			const out = readFileSync(hit);
			return { path: hit, bytes: out, type: ext, ...imageSize(out) };
		}
	}
	let out = null;
	let ext = 'png';
	const sharp = await loadSharp();
	if (sharp !== null) {
		try {
			if (animated) { out = await sharp(bytes, { animated: true }).gif().toBuffer(); ext = 'gif'; } else out = await sharp(bytes).png().toBuffer();
		} catch (error) {
			log('warn', `[fish-soul] sharp 转 webp 失败：${String(error instanceof Error ? error.message : error)}`);
			out = null;
		}
	}
	if (out === null && typeof canvasConvert === 'function') {
		try { out = await canvasConvert(bytes); ext = 'png'; } catch { out = null; }
	}
	if (out === null || sniffImage(out) !== ext) return null;
	if (out.length > MAX_OUTPUT_BYTES) {
		log('warn', `[fish-soul] ${file} 转出来 ${(out.length / 1048576).toFixed(1)} MB，太大不发`);
		return null;
	}
	mkdirSync(cacheDir, { recursive: true });
	const path = join(cacheDir, `${hash}.${ext}`);
	writeFileSync(path, out);
	return { path, bytes: out, type: ext, ...imageSize(out) };
}
