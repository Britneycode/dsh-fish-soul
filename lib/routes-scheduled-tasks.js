/**
 * routes-scheduled-tasks.js —— 设置页「日常 → 定时任务」（#190）。
 *
 *   GET  /scheduled-tasks/state    任务列表 + 能选的发到哪儿（真实的已有会话，不是随便填个 id）
 *   POST /scheduled-tasks/create   { name, prompt, recurrence, at, intervalMinutes, dailyHhmm, target }
 *   POST /scheduled-tasks/update   { id, ...只给要改的字段 }
 *   POST /scheduled-tasks/toggle   { id, enabled }
 *   POST /scheduled-tasks/delete   { id }
 *
 * 建与删只在这里 —— 用户本人在面板上操作。AI 那边只有「看」和「改」（lib/index.js 注册的工具），
 * 没有建 / 删，也不给能建 / 删的参数。
 *
 * 发到哪儿：只给「主人私聊」和「主动开口白名单里的自建群」，并且再过一遍白名单校验
 * （life.isWhitelisted）—— 面板不该能填出一个不该收主动消息的地方。
 */
import {
	createScheduledTask, deleteScheduledTask, listScheduledTasks, scheduledTaskDestinations,
	scheduledTaskGroupNames, taskToApi, updateScheduledTask, validateTaskInput
} from './scheduled-tasks.js';

/** 面板能选的发到哪儿。 */
function destinationsOf(deps) {
	const proactive = deps.getConfig?.()?.proactive ?? {};
	const masterChannelId = typeof deps.life?.masterChannel === 'function' ? deps.life.masterChannel(proactive) : '';
	const selfGroupChannelIds = proactive.targets?.selfGroupChannelIds ?? [];
	return scheduledTaskDestinations({
		masterChannelId,
		selfGroupChannelIds,
		groupNames: scheduledTaskGroupNames(deps.db)
	});
}

/**
 * 这个目标能不能发：不在可选列表里就不行；在列表里还要过一遍主动开口白名单。
 */
function targetAllowed(deps, target, destinations) {
	if (!destinations.some((d) => d.id === target)) return false;
	const proactive = deps.getConfig?.()?.proactive ?? {};
	if (typeof deps.life?.isWhitelisted === 'function') return deps.life.isWhitelisted(target, proactive) === true;
	return true;
}

export async function handleScheduledTaskRoute({ method, path, req, send, readBody, sameOrigin, deps }) {
	if (!path.startsWith('/scheduled-tasks/')) return false;
	const { db } = deps;
	const guard = () => { if (!sameOrigin(req)) { send(403, { ok: false, error: 'forbidden' }); return false; } return true; };
	const readJson = async () => {
		const raw = await readBody(req);
		try { return JSON.parse(raw || '{}'); } catch { return null; }
	};
	const state = () => {
		const destinations = destinationsOf(deps);
		const now = Date.now();
		return {
			ok: true,
			tasks: listScheduledTasks(db).map((t) => taskToApi(t, { destinations, now })),
			destinations
		};
	};
	/** 改完要让闹钟重排：新建 / 改时间 / 开关都要重挂。 */
	const rearm = () => {
		try { deps.life?.armTaskAlarm?.(); } catch (error) {
			deps.log?.('warn', `[fish-soul] 定时任务重排闹钟失败：${String(error instanceof Error ? error.message : error)}`);
		}
	};

	if (path === '/scheduled-tasks/state' && method === 'GET') { send(200, state()); return true; }
	if (method !== 'POST') return false;
	if (!guard()) return true;
	const b = await readJson();
	if (b === null) { send(200, { ok: false, error: '请求体不是 JSON' }); return true; }
	const destinations = destinationsOf(deps);

	if (path === '/scheduled-tasks/create') {
		const target = String(b.target ?? '').trim();
		if (!targetAllowed(deps, target, destinations)) { send(200, { ok: false, error: '回复发到的地方不在可选列表里' }); return true; }
		const checked = validateTaskInput({ ...b, target }, { now: Date.now() });
		if (!checked.ok) { send(200, { ok: false, error: checked.error }); return true; }
		const task = createScheduledTask(db, checked.value, { now: Date.now() });
		rearm();
		send(200, { ...state(), created: taskToApi(task, { destinations }) });
		return true;
	}

	if (path === '/scheduled-tasks/update') {
		const patch = {};
		for (const key of ['name', 'prompt', 'recurrence', 'at', 'intervalMinutes', 'dailyHhmm', 'enabled', 'target']) {
			if (b[key] !== undefined) patch[key] = b[key];
		}
		if (patch.target !== undefined) {
			const target = String(patch.target).trim();
			if (!targetAllowed(deps, target, destinations)) { send(200, { ok: false, error: '回复发到的地方不在可选列表里' }); return true; }
			patch.target = target;
		}
		const res = updateScheduledTask(db, b.id, patch, { now: Date.now() });
		if (!res.ok) { send(200, { ok: false, error: res.error }); return true; }
		rearm();
		send(200, { ...state(), updated: taskToApi(res.task, { destinations }) });
		return true;
	}

	if (path === '/scheduled-tasks/toggle') {
		const res = updateScheduledTask(db, b.id, { enabled: b.enabled === true }, { now: Date.now() });
		if (!res.ok) { send(200, { ok: false, error: res.error }); return true; }
		rearm();
		send(200, { ...state(), updated: taskToApi(res.task, { destinations }) });
		return true;
	}

	if (path === '/scheduled-tasks/delete') {
		if (!deleteScheduledTask(db, b.id)) { send(200, { ok: false, error: '没有这个任务' }); return true; }
		rearm();
		send(200, state());
		return true;
	}

	return false;
}
