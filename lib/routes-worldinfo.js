/**
 * routes-worldinfo.js —— 世界书（单独导入的 SillyTavern World Info）：
 *   GET  /worldinfo/state            已导入的书、配置（扫描深度 / 条数 / 字数预算）
 *   POST /worldinfo/import  {text, fileName}
 *   POST /worldinfo/toggle  {id, enabled}
 *   POST /worldinfo/delete  {id}
 *   POST /worldinfo/config  {scanDepth?, maxEntries?, budgetChars?}
 *   POST /worldinfo/test    {text}   输几句话（一行一条），看会带上哪些条目（人格卡 + 打开的书）
 */
import { loreConfig, matchLore } from './worldinfo.js';

const BODY_MAX = 8 * 1024 * 1024;

export async function handleWorldInfoRoute({ method, path, req, send, readBody, sameOrigin, deps }) {
	if (!path.startsWith('/worldinfo/')) return false;
	const { worldBooks, persona, getConfig, saveConfig } = deps;
	const post = method === 'POST';
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };
	const body = async () => {
		const raw = await readBody(req);
		if (raw.length > BODY_MAX) throw new Error('文件太大（上限 8 MB）');
		return JSON.parse(raw || '{}');
	};
	const state = () => ({ ok: true, config: loreConfig(getConfig().lore), books: worldBooks?.summary() ?? [], cardEntries: persona?.lore?.length ?? 0 });
	if (!worldBooks) { send(200, { ok: false, error: '世界书没起来' }); return true; }

	if (path === '/worldinfo/state' && method === 'GET') { send(200, state()); return true; }
	if (!post) return false;
	if (!guard()) return true;
	const b = await body();
	if (path === '/worldinfo/import') {
		const book = worldBooks.import(String(b.text ?? ''), { fileName: String(b.fileName ?? '') });
		send(200, { ...state(), imported: { id: book.id, name: book.name, entries: book.entries.length } });
		return true;
	}
	if (path === '/worldinfo/toggle') {
		send(200, worldBooks.setEnabled(String(b.id ?? ''), b.enabled === true) ? state() : { ok: false, error: '没有这本世界书' });
		return true;
	}
	if (path === '/worldinfo/delete') {
		send(200, worldBooks.remove(String(b.id ?? '')) ? state() : { ok: false, error: '没有这本世界书' });
		return true;
	}
	if (path === '/worldinfo/config') {
		const cur = loreConfig(getConfig().lore);
		const next = loreConfig({ ...cur, ...Object.fromEntries(['scanDepth', 'maxEntries', 'budgetChars'].filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) });
		await saveConfig({ lore: next });
		send(200, state());
		return true;
	}
	if (path === '/worldinfo/test') {
		const lines = String(b.text ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
		const cfg = loreConfig(getConfig().lore);
		const hits = matchLore([...(persona?.lore ?? []).map((e) => ({ ...e, book: '人格卡' })), ...worldBooks.activeEntries()], lines, { ...cfg, random: () => 0 });
		send(200, { ok: true, hits: hits.map((e) => ({ book: e.book ?? '', keys: e.keys, constant: e.constant === true, comment: e.comment ?? '', content: e.content.slice(0, 200), chars: e.content.length })), config: cfg });
		return true;
	}
	return false;
}
