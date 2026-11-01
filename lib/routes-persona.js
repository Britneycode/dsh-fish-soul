/**
 * routes-persona.js —— 设置页「人格」的路由（routes.js 转进来）：
 * 看现在的人格、内置模板、换模板 / 保存编辑过的卡 / 导入角色卡（JSON / PNG）、撤销上一次更换。
 * 还有「她慢慢长出来的变化」（growth.js）：看 / 确认 / 删 / 自己加 / 清空 / 开关。
 * 换完立刻热加载（下一轮就用新人格）；fresh = 正在聊的聊天下一条消息起开新会话（记忆在 soul.db，不受影响）。
 */
import { fishSoulDir, setKv } from './db.js';
import { editGrowth, growthConfig, growthState } from './growth.js';
import { PERSONA_TEMPLATES, personaTemplate } from './persona-templates.js';
import { canUndoPersona, normalizeCard, parsePngCard, readPersonaCard, savePersonaCard, undoPersona } from './persona.js';

const BODY_MAX = 8 * 1024 * 1024; // PNG 角色卡可能有几 MB

export async function handlePersonaRoute({ method, path, req, send, readBody, sameOrigin, deps }) {
	if (!path.startsWith('/persona/')) return false;
	const { db, persona, reloadPersona, getConfig = () => ({}), saveConfig = () => {}, log = () => {} } = deps;
	const dir = deps.personaDir ?? fishSoulDir();
	const body = async () => {
		const raw = await readBody(req);
		if (raw.length > BODY_MAX) throw new Error('文件太大（最多 8MB）');
		return JSON.parse(raw || '{}');
	};
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };
	const state = () => {
		const disk = readPersonaCard(dir);
		return {
			ok: true,
			current: {
				name: persona?.name ?? '', source: persona?.source ?? 'builtin', anchor: persona?.anchor ?? '', routine: persona?.routine ?? '',
				template: persona?.template ?? null, perspective: persona?.perspective ?? [], loreCount: persona?.lore?.length ?? 0, chars: String(persona?.staticText ?? '').length,
				card: disk?.card ?? null
			},
			templates: PERSONA_TEMPLATES.map(({ id, title, tagline, tags, card }) => ({ id, title, tagline, tags, card })),
			canUndo: canUndoPersona(dir),
			growth: { config: growthConfig(getConfig().growth), items: growthState(db) }
		};
	};
	const done = (fresh, what) => {
		reloadPersona?.();
		if (fresh === true) setKv(db, 'persona.freshAfter', Date.now());
		log('info', `[fish-soul] 人格${what}：${persona?.name ?? ''}${fresh === true ? '（正在聊的下一条起开新会话）' : ''}`);
		send(200, state());
	};

	if (path === '/persona/state' && method === 'GET') { send(200, state()); return true; }

	if (path === '/persona/apply' && method === 'POST') {
		if (!guard()) return true;
		let card;
		try {
			const b = await body();
			if (typeof b.templateId === 'string' && b.templateId !== '') {
				card = personaTemplate(b.templateId);
				if (card === null) { send(400, { ok: false, error: '没有这个模板' }); return true; }
				card.data.extensions.fish_soul.template = b.templateId;
				card = normalizeCard(card);
			} else if (typeof b.png === 'string' && b.png !== '') {
				card = normalizeCard(parsePngCard(Buffer.from(b.png.replace(/^data:[^,]*,/, ''), 'base64')));
			} else {
				card = normalizeCard(b.card);
			}
			savePersonaCard(dir, card);
			done(b.fresh, '已更换');
		} catch (error) {
			send(400, { ok: false, error: String(error instanceof Error ? error.message : error) });
		}
		return true;
	}

	if (path === '/persona/growth' && method === 'POST') {
		if (!guard()) return true;
		try {
			const b = await body();
			if (b.enabled !== undefined || b.autoApply !== undefined) {
				const g = {};
				for (const k of ['enabled', 'autoApply']) if (b[k] !== undefined) g[k] = b[k] === true;
				saveConfig({ growth: g });
			}
			if (typeof b.action === 'string') editGrowth(db, { action: b.action, id: b.id, target: b.target, text: b.text });
			send(200, state());
		} catch (error) {
			send(400, { ok: false, error: String(error instanceof Error ? error.message : error) });
		}
		return true;
	}

	if (path === '/persona/undo' && method === 'POST') {
		if (!guard()) return true;
		try {
			const b = await body();
			undoPersona(dir);
			done(b.fresh, '已撤销到上一个');
		} catch (error) {
			send(400, { ok: false, error: String(error instanceof Error ? error.message : error) });
		}
		return true;
	}

	return false;
}
