/**
 * routes-v09.js —— v0.9「她的习惯」的路由（routes.js 转进来，契约 36~41）：
 * 习惯开关（心情影响行为 / 去 AI 味 / 合并转发 / 群里冷热 / 小互动 / 每轮判断心情 / 日记）、
 * 每个群的群设定和冷热、按聊天选模型、记忆调试器、现在写一篇日记。
 */
import { listChatSessions } from './db.js';
import { behaviorConfig, chatModelsConfig, resolveChatModel, groupNotes, setGroupNote } from './behavior.js';

const BODY_MAX = 64 * 1024;

export async function handleV09Route({ method, path, req, send, readBody, sameOrigin, deps }) {
	const { db, getConfig, saveConfig, gateway, llmRouter, diary, debugRecall } = deps;
	const post = method === 'POST';
	const body = async () => {
		const raw = await readBody(req);
		if (raw.length > BODY_MAX) throw new Error('请求太大');
		return JSON.parse(raw || '{}');
	};
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };
	const chats = () => {
		const rows = [...listChatSessions(db, 'qq'), ...listChatSessions(db, 'bili'), ...listChatSessions(db, 'douyin')];
		const seen = new Set();
		return rows.filter((r) => !seen.has(r.channel_id) && seen.add(r.channel_id)).map((r) => ({ channelId: r.channel_id, title: r.title || r.channel_id }));
	};
	const groups = () => {
		const notes = groupNotes(db);
		const ids = new Set([...chats().filter((c) => c.channelId.startsWith('group:')).map((c) => c.channelId.slice(6)),
			...(getConfig().qq?.groupAllowList ?? []).map(String), ...Object.keys(notes)]);
		return [...ids].filter(Boolean).map((groupId) => {
			const channelId = `group:${groupId}`;
			const heat = gateway?.heatOf?.(channelId) ?? null;
			return { groupId, channelId, title: gateway?.titleOf?.(channelId, `群 ${groupId}`) ?? channelId, note: notes[groupId]?.text ?? '', noteAt: notes[groupId]?.updatedAt ?? null, heat };
		});
	};
	const modelsState = async () => {
		const raw = getConfig().chatModels;
		const providers = [];
		for (const p of llmRouter?.providers?.() ?? []) providers.push({ ...p, models: await llmRouter.models(p.id) });
		const cfg = chatModelsConfig(raw);
		const known = (p) => providers.length === 0 || providers.some((x) => x.id === p);
		return {
			config: cfg, providers, hostDefault: llmRouter?.hostDefault?.() ?? null,
			chats: chats().map((c) => ({ ...c, override: cfg.overrides.find((o) => o.channelId === c.channelId) ?? null, resolved: resolveChatModel(raw, c.channelId, { known }) }))
		};
	};

	// ── 契约 36：习惯页状态 ──
	if (path === '/behavior/state' && method === 'GET') {
		send(200, { ok: true, config: behaviorConfig(getConfig().behavior), groups: groups(), chatModels: await modelsState(), diary: diary?.state() ?? null });
		return true;
	}
	// ── 契约 37：保存习惯开关（只改传了的；范围不对的夹到上下限）──
	if (path === '/behavior/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const cur = behaviorConfig(getConfig().behavior);
		const merged = { ...cur };
		for (const k of Object.keys(cur)) {
			if (b[k] === undefined) continue;
			merged[k] = typeof cur[k] === 'object' && b[k] !== null && typeof b[k] === 'object' ? { ...cur[k], ...b[k] } : b[k];
		}
		const next = behaviorConfig(merged);
		saveConfig({ behavior: next });
		send(200, { ok: true, config: next });
		return true;
	}
	// ── 契约 38：群设定（空 = 删掉）──
	if (path === '/groups/note' && post) {
		if (!guard()) return true;
		const b = await body();
		const groupId = String(b.groupId ?? '').trim();
		if (!/^\d{1,12}$/.test(groupId)) { send(200, { ok: false, error: '群号不对' }); return true; }
		const note = setGroupNote(db, groupId, b.note);
		send(200, { ok: true, groupId, note });
		return true;
	}
	// ── 契约 39：按聊天选模型（私聊 / 群聊默认；单个聊天 channelId + selection，null = 跟默认）──
	if (path === '/chat-models/config' && post) {
		if (!guard()) return true;
		const b = await body();
		const cur = chatModelsConfig(getConfig().chatModels);
		const next = { ...cur };
		if (b.private !== undefined) next.private = b.private;
		if (b.group !== undefined) next.group = b.group;
		if (Array.isArray(b.overrides)) next.overrides = b.overrides;
		if (typeof b.channelId === 'string' && b.channelId !== '') {
			next.overrides = next.overrides.filter((o) => o.channelId !== b.channelId);
			if (b.selection) next.overrides.push({ channelId: b.channelId, ...b.selection });
		}
		const clean = chatModelsConfig(next);
		saveConfig({ chatModels: clean });
		send(200, { ok: true, ...(await modelsState()) });
		return true;
	}
	// ── 契约 40：记忆调试器（一句话 + 一个人：想起哪些、分数、没想起的为什么）──
	if (path === '/memory/debug' && post) {
		if (!guard()) return true;
		const b = await body();
		const ownerId = String(b.ownerId ?? '');
		const text = String(b.text ?? '').trim();
		if (!/^user:./.test(ownerId) || text === '') { send(200, { ok: false, error: '选一个人、写一句话' }); return true; }
		send(200, { ok: true, ...(await debugRecall({ ownerId, text, inGroup: b.inGroup === true })) });
		return true;
	}
	// ── 契约 41：现在写一篇日记 ──
	if (path === '/diary/write-now' && post) {
		if (!guard()) return true;
		if (!diary) { send(200, { ok: false, error: '日记没起来' }); return true; }
		const entry = await diary.tick({ force: true });
		send(200, entry ? { ok: true, entry, diary: diary.state() } : { ok: false, error: diary.running ? '正在写' : `没写成（${diary.lastFail || '今天没什么可写的'}）` });
		return true;
	}
	return false;
}
