/**
 * stickers.js —— 收藏别人发的表情包。
 *
 * 网关把每轮转进会话的图片（字节 + 是不是表情）记在这里；模型在回复里写一行 [收藏表情:名字]，
 * 就把这轮（或最近 10 分钟内）对方发的那张表情存到工作区 _stickers/名字.扩展名，以后能用 ![名字](_stickers/…) 发。
 * 同一张图（sha1）只存一次；每天最多存 perDay 张；_stickers 里最多 300 张。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getKv, setKv } from './db.js';

export const COLLECT_RE = /\[(?:收藏表情|存表情)\s*[:：]\s*([^\]\n]{1,30})\]/g;
const RECENT_MS = 10 * 60_000;
const DIR_CAP = 300;
const EXT = { 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 回复里的 [收藏表情:名字] 抠出来（发出去的文字里去掉）。 */
export function parseCollect(text) {
	const names = [];
	const out = String(text ?? '').replace(COLLECT_RE, (_m, name) => { names.push(name.trim()); return ''; })
		.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
	return { text: out, names };
}

/** 文件名用的名字：去掉路径符号和空白，≤20 字。 */
export function stickerName(raw) {
	const s = [...String(raw ?? '').trim().replace(/\.(png|jpe?g|gif|webp)$/i, '').replace(/[\\/:*?"<>|\s.\u0000-\u001f]+/g, '').replace(/^_+/, '')].slice(0, 20).join('');
	return s;
}

export function stickerConfig(raw) {
	const v = raw ?? {};
	const n = Number(v.perDay);
	return { collect: v.collect !== false, perDay: Number.isFinite(n) ? Math.min(100, Math.max(0, Math.floor(n))) : 10 };
}

export class StickerBox {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => ReturnType<typeof stickerConfig>} deps.getConfig
	 */
	constructor({ db, getConfig, log }) {
		Object.assign(this, { db, getConfig });
		this.log = log ?? (() => {});
		this.recent = new Map(); // sessionId → [{ bytes, mediaType, sticker, summary, from, at }]
	}

	/** 网关：这轮转进会话的一张图。 */
	remember(sessionId, img) {
		if (!img?.bytes || !EXT[img.mediaType]) return;
		const list = (this.recent.get(sessionId) ?? []).filter((x) => Date.now() - x.at < RECENT_MS);
		list.push({ ...img, at: Date.now() });
		this.recent.set(sessionId, list.slice(-4));
		if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value);
	}

	collected() {
		return getKv(this.db, 'stickers.collected', []) ?? [];
	}

	/**
	 * 存最近一张（优先表情）为 名字.扩展名。
	 * @returns {{ok: boolean, file?: string, reason?: string}}
	 */
	collect(sessionId, rawName, workspacePath, { from = '' } = {}) {
		const cfg = this.getConfig();
		if (!cfg.collect) return { ok: false, reason: '收藏表情包关着' };
		const name = stickerName(rawName);
		if (name === '') return { ok: false, reason: '名字不能用' };
		const list = (this.recent.get(sessionId) ?? []).filter((x) => Date.now() - x.at < RECENT_MS);
		const img = [...list].reverse().find((x) => x.sticker) ?? list[list.length - 1];
		if (!img) return { ok: false, reason: '最近没有能存的表情' };
		const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
		const today = getKv(this.db, `stickers.day.${day}`, 0) ?? 0;
		if (today >= cfg.perDay) return { ok: false, reason: '今天存够了' };
		const hash = createHash('sha1').update(img.bytes).digest('hex');
		const all = this.collected();
		const dup = all.find((x) => x.hash === hash && x.workspacePath === workspacePath);
		if (dup && existsSync(join(workspacePath, '_stickers', dup.file))) return { ok: false, reason: `已经存过了（${dup.file}）`, file: dup.file };
		const dir = join(workspacePath, '_stickers');
		mkdirSync(dir, { recursive: true });
		if (readdirSync(dir).length >= DIR_CAP) return { ok: false, reason: '表情包太多了，先删几张' };
		let file = `${name}.${EXT[img.mediaType]}`;
		for (let i = 2; existsSync(join(dir, file)); i++) file = `${name}${i}.${EXT[img.mediaType]}`;
		writeFileSync(join(dir, file), img.bytes);
		setKv(this.db, `stickers.day.${day}`, today + 1);
		all.unshift({ file, hash, workspacePath, from: String(from).slice(0, 24), summary: String(img.summary ?? '').slice(0, 30), at: Date.now() });
		setKv(this.db, 'stickers.collected', all.slice(0, DIR_CAP));
		this.recent.set(sessionId, list.filter((x) => x !== img));
		return { ok: true, file };
	}

	/** 设置页删一张她收藏的（只删她自己收藏的，不碰主人放的）。 */
	remove(file, workspacePath) {
		const all = this.collected();
		const hit = all.find((x) => x.file === file && x.workspacePath === workspacePath);
		if (!hit) return false;
		try { unlinkSync(join(workspacePath, '_stickers', hit.file)); } catch { /* 已经没了 */ }
		setKv(this.db, 'stickers.collected', all.filter((x) => x !== hit));
		return true;
	}
}
