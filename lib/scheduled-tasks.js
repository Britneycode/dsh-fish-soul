/**
 * scheduled-tasks.js —— 用户在设置页排的定时任务（#190）。
 *
 * 和「待办」(pending 表) 是两回事，别混：
 *   pending        = 口头交代的一次性提醒，走**虚拟钟**，受主动开口的配额 / 活跃时段约束；
 *   scheduled_task = 面板上排好的自动化任务，走**真实钟**，不占主动配额、不受活跃时段约束。
 *
 * 时间一律是真实毫秒（epoch ms）：虚拟钟加速（FISH_TIME_SCALE）不该让 20 分钟的任务提前跑。
 * 角色时区固定 UTC+8（和 clock.getRoleDateParts 同一套约定）。
 *
 * 这里只放**纯逻辑 + 落库**（不含定时器）：定时器在 life.js（复用它那套起停 / 闹钟生命周期）。
 */
import { groupsFromSessions } from './group-list.js';

/** 角色时区偏移（UTC+8）。 */
export const ROLE_OFFSET_MS = 8 * 3600_000;

export const RECURRENCE_ONCE = 'once';
export const RECURRENCE_INTERVAL = 'interval';
export const RECURRENCE_DAILY = 'daily';
/** 三种重复方式。面板与 AI 都只认这三个值。 */
export const RECURRENCES = [RECURRENCE_ONCE, RECURRENCE_INTERVAL, RECURRENCE_DAILY];
/** 间隔最小 1 分钟（#190 要「每隔 20 分钟」，20 分钟没问题；再小的间隔没有意义）。 */
export const MIN_INTERVAL_MINUTES = 1;
/** 间隔上限 30 天。 */
export const MAX_INTERVAL_MINUTES = 60 * 24 * 30;

export const TASK_STATUS_ACTIVE = 'active';
export const TASK_STATUS_RUNNING = 'running';
export const TASK_STATUS_COMPLETED = 'completed';

/** 失败重试的退避：1 分钟起，翻倍，封顶 30 分钟。 */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;

const pad2 = (n) => String(n).padStart(2, '0');
const err = (error) => ({ ok: false, error });

/** 角色时区（UTC+8）下的年月日时分。 */
export function roleParts(ms) {
	const d = new Date(Number(ms) + ROLE_OFFSET_MS);
	return {
		year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
		hour: d.getUTCHours(), minute: d.getUTCMinutes()
	};
}

/** 角色时区下的 'YYYY-MM-DDTHH:mm'（datetime-local 控件就是这个格式）。 */
export function formatLocalDateTime(ms) {
	const p = roleParts(ms);
	return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 角色时区下的 'YYYY-MM-DD HH:mm'（给人看的）。 */
export function formatLocalLabel(ms) {
	const p = roleParts(ms);
	return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * 面板传来的 'YYYY-MM-DDTHH:mm' → 真实毫秒（按角色时区 UTC+8 解释）。
 * 认不出来返回 null。
 */
export function parseLocalDateTime(raw) {
	const s = String(raw ?? '').trim().replace(' ', 'T');
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
	if (m === null) return null;
	const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
	const hour = Number(m[4]); const minute = Number(m[5]);
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
	const at = Date.UTC(year, month - 1, day, hour, minute) - ROLE_OFFSET_MS;
	// 2 月 30 日这种会被 Date.UTC 滚到下个月 —— 回读一次挡住
	const back = roleParts(at);
	if (back.year !== year || back.month !== month || back.day !== day) return null;
	return at;
}

/** 'HH:mm' → {hour, minute}；不认返回 null。 */
export function parseHhmm(raw) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
	if (m === null) return null;
	const hour = Number(m[1]); const minute = Number(m[2]);
	if (hour > 23 || minute > 59) return null;
	return { hour, minute };
}

/**
 * 严格晚于 afterMs 的下一次「每天 HH:mm」（角色时区）。
 * afterMs 本身是一次触发时，返回**第二天**那一次。
 */
export function nextDailyOccurrenceMs(hhmm, afterMs) {
	const t = parseHhmm(hhmm);
	if (t === null) return null;
	const p = roleParts(afterMs);
	let at = Date.UTC(p.year, p.month - 1, p.day) - ROLE_OFFSET_MS + t.hour * 3600_000 + t.minute * 60_000;
	while (at <= afterMs) at += 86_400_000;
	return at;
}

/**
 * 排期：从输入算出「下一次什么时候跑」。
 *
 * @param {string} recurrence once | interval | daily
 * @param {object} raw        面板 / AI 传来的字段（at / intervalMinutes / dailyHhmm）
 * @param {object} o
 * @param {number} o.now      真实当前毫秒
 * @param {object} [o.fallback] 已有任务的值（改任务时当兜底）
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function scheduleFrom(recurrence, raw, { now, fallback = null }) {
	if (recurrence === RECURRENCE_DAILY) {
		let hhmm = String(raw?.dailyHhmm ?? '').trim();
		if (hhmm === '' && raw?.at !== undefined && String(raw?.at ?? '').trim() !== '') {
			const at = parseLocalDateTime(raw.at);
			if (at !== null) {
				const p = roleParts(at);
				hhmm = `${pad2(p.hour)}:${pad2(p.minute)}`;
			}
		}
		if (hhmm === '' && fallback?.dailyHhmm) hhmm = String(fallback.dailyHhmm);
		if (parseHhmm(hhmm) === null) return err('每天的时间要写成 HH:mm');
		return { ok: true, value: { dailyHhmm: hhmm, intervalMinutes: null, nextRunAt: nextDailyOccurrenceMs(hhmm, now) } };
	}
	const rawAt = raw?.at;
	const hasAt = rawAt !== undefined && rawAt !== null && String(rawAt).trim() !== '';
	let at = null;
	if (hasAt) at = parseLocalDateTime(rawAt);
	else if (fallback?.nextRunAt !== undefined && fallback?.nextRunAt !== null) at = Number(fallback.nextRunAt);
	if (at === null) return err('时间要写成 YYYY-MM-DDTHH:mm');
	if (hasAt && at <= now) return err('时间已经过了');
	let intervalMinutes = null;
	if (recurrence === RECURRENCE_INTERVAL) {
		const rawMinutes = raw?.intervalMinutes;
		const given = rawMinutes === undefined || rawMinutes === null || String(rawMinutes).trim() === ''
			? fallback?.intervalMinutes : Number(rawMinutes);
		if (!Number.isFinite(given)) return err('间隔分钟数不对');
		intervalMinutes = Math.floor(Number(given));
		if (intervalMinutes < MIN_INTERVAL_MINUTES) return err(`间隔最少 ${MIN_INTERVAL_MINUTES} 分钟`);
		if (intervalMinutes > MAX_INTERVAL_MINUTES) return err(`间隔最多 ${MAX_INTERVAL_MINUTES} 分钟`);
	}
	return { ok: true, value: { dailyHhmm: null, intervalMinutes, nextRunAt: at } };
}

/**
 * 新建任务的入参校验。
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateTaskInput(raw, { now = Date.now() } = {}) {
	const name = String(raw?.name ?? '').trim();
	if (name === '') return err('任务名称不能为空');
	if (name.length > 40) return err('任务名称太长（最多 40 字）');
	const prompt = String(raw?.prompt ?? '').trim();
	if (prompt === '') return err('唤醒提示词不能为空');
	if (prompt.length > 500) return err('唤醒提示词太长（最多 500 字）');
	const recurrence = String(raw?.recurrence ?? '').trim();
	if (!RECURRENCES.includes(recurrence)) return err('重复方式只能是「仅一次」「每隔 N 分钟」「每天」');
	const target = String(raw?.target ?? '').trim();
	if (target === '') return err('要选一个回复发到的地方');
	const schedule = scheduleFrom(recurrence, raw, { now });
	if (!schedule.ok) return schedule;
	return { ok: true, value: { name, prompt, recurrence, target, ...schedule.value } };
}

/**
 * 改任务的入参校验（只校验传了的字段）。
 * @param {object} row 已有任务（DB 行）
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateTaskPatch(patch, row, { now = Date.now() } = {}) {
	const value = {};
	if (patch?.name !== undefined) {
		const name = String(patch.name).trim();
		if (name === '') return err('任务名称不能为空');
		if (name.length > 40) return err('任务名称太长（最多 40 字）');
		value.name = name;
	}
	if (patch?.prompt !== undefined) {
		const prompt = String(patch.prompt).trim();
		if (prompt === '') return err('唤醒提示词不能为空');
		if (prompt.length > 500) return err('唤醒提示词太长（最多 500 字）');
		value.prompt = prompt;
	}
	if (patch?.target !== undefined) {
		const target = String(patch.target).trim();
		if (target === '') return err('要选一个回复发到的地方');
		value.target = target;
	}
	const recurrence = patch?.recurrence === undefined ? row.recurrence : String(patch.recurrence).trim();
	if (!RECURRENCES.includes(recurrence)) return err('重复方式只能是「仅一次」「每隔 N 分钟」「每天」');
	value.recurrence = recurrence;
	const schedule = scheduleFrom(recurrence, patch, {
		now,
		fallback: { nextRunAt: row.next_run_at, intervalMinutes: row.interval_minutes, dailyHhmm: row.daily_hhmm }
	});
	if (!schedule.ok) return schedule;
	Object.assign(value, schedule.value);
	if (patch?.enabled !== undefined) value.enabled = patch.enabled === true ? 1 : 0;
	// 改没改进「排期」——只有排期变了才重排下一次
	value.scheduleChanged = patch?.recurrence !== undefined || patch?.at !== undefined ||
		patch?.intervalMinutes !== undefined || patch?.dailyHhmm !== undefined;
	return { ok: true, value };
}

export function listScheduledTasks(db) {
	return db.prepare('SELECT * FROM scheduled_task ORDER BY id ASC').all();
}

export function getScheduledTask(db, id) {
	const n = Number(id);
	if (!Number.isInteger(n) || n <= 0) return undefined;
	return db.prepare('SELECT * FROM scheduled_task WHERE id = ?').get(n);
}

export function createScheduledTask(db, input, { now = Date.now() } = {}) {
	const info = db.prepare(`
		INSERT INTO scheduled_task
			(name, prompt, enabled, recurrence, next_run_at, interval_minutes, daily_hhmm,
			 target_channel_id, status, attempts, last_error, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?)
	`).run(
		input.name, input.prompt, input.enabled === false ? 0 : 1, input.recurrence,
		input.nextRunAt, input.intervalMinutes, input.dailyHhmm, input.target,
		TASK_STATUS_ACTIVE, now, now
	);
	return getScheduledTask(db, info.lastInsertRowid);
}

/** 重新打开（enabled 0 → 1）时按重复方式重排下一次。 */
function rearmNextRunAt(row, now) {
	if (row.recurrence === RECURRENCE_DAILY) return nextDailyOccurrenceMs(row.daily_hhmm, now) ?? now;
	if (row.recurrence === RECURRENCE_INTERVAL) return now + (row.interval_minutes ?? MIN_INTERVAL_MINUTES) * 60_000;
	return now; // 仅一次：重新打开 = 立刻跑一次
}

/**
 * 改任务。改排期会重排下一次并把「已完成」的任务救回来；手动关掉的不动（enabled 保持 0）。
 * @returns {{ok: true, task: object} | {ok: false, error: string}}
 */
export function updateScheduledTask(db, id, patch, { now = Date.now() } = {}) {
	const row = getScheduledTask(db, id);
	if (row === undefined) return { ok: false, error: '没有这个任务' };
	const checked = validateTaskPatch(patch, row, { now });
	if (!checked.ok) return checked;
	const v = checked.value;
	const wasEnabled = row.enabled === 1;
	const enabled = v.enabled === undefined ? row.enabled : v.enabled;
	let nextRunAt = v.nextRunAt;
	let status = row.status;
	if (v.scheduleChanged) {
		// 排期改了 = 重新排上：已完成的任务回到 active，没关过的照旧保持关着
		if (status === TASK_STATUS_COMPLETED) status = TASK_STATUS_ACTIVE;
	} else if (enabled === 1 && !wasEnabled) {
		nextRunAt = rearmNextRunAt(row, now);
		if (status === TASK_STATUS_COMPLETED) status = TASK_STATUS_ACTIVE;
	}
	db.prepare(`
		UPDATE scheduled_task SET name = ?, prompt = ?, enabled = ?, recurrence = ?, next_run_at = ?,
		  interval_minutes = ?, daily_hhmm = ?, target_channel_id = ?, status = ?, attempts = 0,
		  last_error = '', updated_at = ?
		WHERE id = ?
	`).run(
		v.name ?? row.name, v.prompt ?? row.prompt, enabled, v.recurrence ?? row.recurrence, nextRunAt,
		v.intervalMinutes === undefined ? row.interval_minutes : v.intervalMinutes,
		v.dailyHhmm === undefined ? row.daily_hhmm : v.dailyHhmm,
		v.target ?? row.target_channel_id, status, now, row.id
	);
	return { ok: true, task: getScheduledTask(db, row.id) };
}

export function deleteScheduledTask(db, id) {
	const row = getScheduledTask(db, id);
	if (row === undefined) return false;
	db.prepare('DELETE FROM scheduled_task WHERE id = ?').run(row.id);
	return true;
}

/**
 * 原子认领到点的任务：只有把 status 从 active 改成 running 成功的那几条才算拿到。
 *
 * 单进程里也这么做，是为了「同一个任务不会被两个闹钟各发一次」——
 * UPDATE 的 WHERE 带 status='active'，并发下只有一个能改成 running。
 *
 * @returns {object[]} 认领到的任务行
 */
export function claimDueTasks(db, now, limit = 5) {
	const rows = db.prepare(`
		SELECT * FROM scheduled_task
		WHERE enabled = 1 AND status = ? AND next_run_at IS NOT NULL AND next_run_at <= ?
		ORDER BY next_run_at ASC LIMIT ?
	`).all(TASK_STATUS_ACTIVE, now, limit);
	const claimed = [];
	for (const row of rows) {
		// WHERE 必须带 status = ?：只有「此刻仍是 active」的那一行才被改成 running，
		// 并发下另一个闹钟改不动（changes = 0），同一个任务不会被发两次。
		const res = db.prepare(`
			UPDATE scheduled_task SET status = ?, updated_at = ?
			WHERE id = ? AND status = ?
		`).run(TASK_STATUS_RUNNING, now, row.id, TASK_STATUS_ACTIVE);
		if (res.changes === 1) claimed.push(row);
	}
	return claimed;
}

/**
 * 跑完之后重排下一次。
 *
 *  - 仅一次：跑完就完成、关掉；
 *  - 每隔 N 分钟：从**本来该跑的那一刻**往后推 N 分钟，中间错过的时段直接跳过（不补跑）；
 *  - 每天：推到下一个「角色日历上的 HH:mm」。
 */
export function completeScheduledTask(db, task, now) {
	if (task.recurrence === RECURRENCE_ONCE) {
		db.prepare("UPDATE scheduled_task SET status = ?, enabled = 0, attempts = 0, last_error = '', updated_at = ? WHERE id = ?")
			.run(TASK_STATUS_COMPLETED, now, task.id);
		return { nextRunAt: null, done: true };
	}
	let nextRunAt = null;
	if (task.recurrence === RECURRENCE_INTERVAL) {
		const step = (task.interval_minutes ?? MIN_INTERVAL_MINUTES) * 60_000;
		nextRunAt = Number(task.next_run_at) + step;
		while (nextRunAt <= now) nextRunAt += step; // 错过的时段跳过，不补跑
	} else {
		nextRunAt = nextDailyOccurrenceMs(task.daily_hhmm, Number(task.next_run_at)) ?? now + 86_400_000;
	}
	db.prepare(`
		UPDATE scheduled_task SET status = ?, next_run_at = ?, attempts = 0, last_error = '', updated_at = ?
		WHERE id = ?
	`).run(TASK_STATUS_ACTIVE, nextRunAt, now, task.id);
	return { nextRunAt, done: false };
}

/**
 * 跑失败：任务留着（enabled 不动），记下错误，退避后重试。
 */
export function failScheduledTask(db, task, message, now) {
	const attempts = Number(task.attempts ?? 0) + 1;
	const backoff = Math.min(RETRY_BASE_MS * (2 ** (attempts - 1)), RETRY_MAX_MS);
	const nextRunAt = now + backoff;
	db.prepare(`
		UPDATE scheduled_task SET status = ?, attempts = ?, last_error = ?, next_run_at = ?, updated_at = ?
		WHERE id = ?
	`).run(TASK_STATUS_ACTIVE, attempts, String(message ?? '').slice(0, 300), nextRunAt, now, task.id);
	return { attempts, nextRunAt, backoff };
}

/** 进程重启时把「跑到一半」的任务退回队列（上次是崩在投递中途）。 */
export function recoverRunningTasks(db, now = Date.now()) {
	db.prepare("UPDATE scheduled_task SET status = ?, updated_at = ? WHERE status = ?")
		.run(TASK_STATUS_ACTIVE, now, TASK_STATUS_RUNNING);
}

/**
 * 面板能选的发到哪儿：主人私聊 + 已在白名单里的自建群。
 * 传进来的是白名单本身 —— 面板不给「随便填个群号」的机会。
 *
 * @param {object} o
 * @param {string} o.masterChannelId 主人私聊会话 id（private:<QQ>）
 * @param {string[]} o.selfGroupChannelIds 白名单里的自建群
 * @param {Map<string,string>} [o.groupNames] 群 id → 群名（来自 chat_session）
 */
export function scheduledTaskDestinations({ masterChannelId, selfGroupChannelIds, groupNames = new Map() }) {
	const out = [];
	const master = String(masterChannelId ?? '').trim();
	if (master !== '') out.push({ id: master, label: '主人私聊', kind: 'private' });
	const groups = Array.isArray(selfGroupChannelIds) ? selfGroupChannelIds : [];
	const seen = new Set([master]);
	for (const raw of groups) {
		const id = String(raw ?? '').trim();
		if (id === '' || seen.has(id)) continue;
		if (!id.startsWith('group:')) continue; // 只发 QQ 群（其它平台的主动通道另有限制）
		seen.add(id);
		const name = String(groupNames.get(id) ?? '').trim();
		out.push({ id, label: name === '' ? id : `${name}（${id.slice('group:'.length)}）`, kind: 'group' });
	}
	return out;
}

/** 群里她说过话的那些群（群名从会话标题抠）—— 用来给白名单里的群配名字。 */
export function scheduledTaskGroupNames(db) {
	const map = new Map();
	for (const g of groupsFromSessions(db)) map.set(`group:${g.id}`, g.name);
	return map;
}

/** 排期的人话（面板与 AI 都用它）。 */
export function scheduleLabel(task) {
	if (task.recurrence === RECURRENCE_INTERVAL) return `每隔 ${task.interval_minutes ?? MIN_INTERVAL_MINUTES} 分钟`;
	if (task.recurrence === RECURRENCE_DAILY) return `每天 ${task.daily_hhmm ?? ''}`;
	return '仅一次';
}

/** 一行状态（AI 的 list 工具与面板都用它）。 */
export function taskStateLabel(task, now = Date.now()) {
	if (task.status === TASK_STATUS_COMPLETED) return '已完成';
	if (task.enabled !== 1) return '已关闭';
	if (task.next_run_at === null || task.next_run_at === undefined) return '没有排期';
	const overdue = task.next_run_at <= now;
	return `${overdue ? '已到点' : '下一次'} ${formatLocalLabel(task.next_run_at)}`;
}

/** DB 行 → 接口形状。 */
export function taskToApi(task, { destinations = [], now = Date.now() } = {}) {
	const target = String(task.target_channel_id ?? '');
	const dest = destinations.find((d) => d.id === target);
	return {
		id: task.id,
		name: task.name,
		prompt: task.prompt,
		enabled: task.enabled === 1,
		recurrence: task.recurrence,
		intervalMinutes: task.interval_minutes ?? null,
		dailyHhmm: task.daily_hhmm ?? null,
		nextRunAt: task.next_run_at ?? null,
		nextRunAtLabel: task.next_run_at === null || task.next_run_at === undefined ? '' : formatLocalLabel(task.next_run_at),
		nextRunAtInput: task.next_run_at === null || task.next_run_at === undefined ? '' : formatLocalDateTime(task.next_run_at),
		scheduleLabel: scheduleLabel(task),
		target,
		targetLabel: dest?.label ?? target,
		status: task.status,
		stateLabel: taskStateLabel(task, now),
		attempts: task.attempts ?? 0,
		lastError: task.last_error ?? '',
		createdAt: task.created_at,
		updatedAt: task.updated_at
	};
}
