/** 音频落盘：只管理本插件生成的文件；不遍历或删除其他文件。 */
import { mkdirSync, lstatSync, readdirSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fishSoulDir } from './db.js';

let incomingClearEpoch = 0;
export const voiceIncomingEpoch = () => incomingClearEpoch;
export const invalidateIncomingVoice = () => { incomingClearEpoch++; };
const MANAGED = /^voice-\d{13}-[0-9a-f-]{36}(?:-(?:original|converted|analysis))?\.(?:mp3|wav|ogg|silk|amr|bin)$/;
export function audioExt(b) {
	if (b.length >= 3 && b.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
	if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
	if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
	if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
	if (b.length >= 10 && b.subarray(0, 10).toString('latin1').includes('SILK')) return 'silk';
	if (b.length >= 6 && b.subarray(0, 6).toString('latin1') === '#!AMR\n') return 'amr';
	return 'bin';
}
export function voiceDir(kind) {
	if (!['in', 'out'].includes(kind)) throw new Error('invalid voice directory');
	return resolve(fishSoulDir(), `voice-${kind}`);
}
function managed(kind, create = false) {
	const dir = voiceDir(kind);
	if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) throw new Error('语音目录不能是链接');
	} catch (e) { if (!create && e.code === 'ENOENT') return []; throw e; }
	return readdirSync(dir).filter((n) => MANAGED.test(n)).flatMap((n) => {
		const p = join(dir, n);
		try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink() ? [{ path: p, mtime: s.mtimeMs, name: n }] : []; } catch { return []; }
	}).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
}
export function saveVoiceFile(kind, bytes, { converted, analysisBytes } = {}) {
	if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('音频为空或过大');
	managed(kind, true);
	const stem = `voice-${Date.now()}-${randomUUID()}`;
	const p = join(voiceDir(kind), `${stem}${kind === 'in' ? (converted ? '-converted' : '-original') : ''}.${audioExt(bytes)}`);
	writeFileSync(p, bytes, { flag: 'wx', mode: 0o600 });
	let input = p;
	if (kind === 'in' && Buffer.isBuffer(analysisBytes) && analysisBytes.length && analysisBytes.length <= 8 * 1024 * 1024) {
		const derived = join(voiceDir(kind), `${stem}-analysis.${audioExt(analysisBytes)}`);
		try { writeFileSync(derived, analysisBytes, { flag: 'wx', mode: 0o600 }); input = derived; } catch { /* 原件仍保留 */ }
	}
	const files = managed(kind);
	const groups = new Map();
	for (const f of files) {
		const key = f.name.slice(0, 56); // voice- + 时间戳 + 连字符 + UUID
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(f);
	}
	const older = [...groups.entries()].filter(([key]) => key !== stem);
	for (const [, group] of older.slice(0, -29)) for (const f of group) unlinkSync(f.path);
	return input;
}
export function clearVoiceFiles(kind) { if (kind === 'in') invalidateIncomingVoice(); const files = managed(kind); for (const f of files) unlinkSync(f.path); return new Set(files.map((f) => f.name.slice(0, 56))).size; }
export function voiceFileList(kind) { return managed(kind).map((f) => f.path); }
export function voiceIncomingCount() { return managed('in').filter((f) => !/-analysis\./.test(f.name)).length; }
export function isAllowedVoiceInput(args, paths) {
	if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || typeof args.input !== 'string' || !Array.isArray(paths) || !paths.includes(args.input)) return false;
	try { return lstatSync(args.input).isFile() && !lstatSync(args.input).isSymbolicLink() && realpathSync(args.input) === args.input && voiceFileList('in').includes(args.input); } catch { return false; }
}
