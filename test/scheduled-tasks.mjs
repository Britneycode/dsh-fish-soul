// #190：定时任务 —— 面板 CRUD / 排期 / 重试 / 起停 / AI 工具边界 / 网关唤醒接线。
//
// 覆盖的每一格：
//   ① 面板路由（真 HTTP 处理器 + 真 SQLite）：建 → 落库 → 读得回来 → 改 → 关 → 删；
//   ② 输入校验与 sameOrigin：坏输入被拒、跨站 POST 被拒；
//   ③ 排期：间隔 1 分钟 / 20 分钟、仅一次、每天（角色时区）；
//   ④ 重试：发不出去要记错误、退避、任务不丢；同一��到点只投递一次；
//   ⑤ 起停：start 挂闹钟、stop 清闹钟、已停止后不许再挂；
//   ⑥ AI 边界：工具在 CHAT_TOOLS 里，但**没有**建 / 删的入口；
//   ⑦ 网关唤醒：定时任务那一轮给的是用户写的指示，不是「好久没说话」那套。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpHome } from './_tmp.mjs';
import { assertWire } from './_wire.mjs';

const ok = (n) => console.log('✓', n);
process.env.DSH_HOME = tmpHome('dsh-task-');

const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');
const { LifeEngine } = await import('../lib/life.js');
const { ChatGateway, CHAT_TOOLS } = await import('../lib/gateway.js');
const { claimDueTasks, createScheduledTask, deleteScheduledTask, formatLocalDateTime, getScheduledTask, listScheduledTasks, parseLocalDateTime, taskToApi, updateScheduledTask } = await import('../lib/scheduled-tasks.js');

const db = openDatabase();

/** 虚拟钟比真实钟快 10 天：定时任务要是偷偷跟着虚拟钟走，下面几条断言就会红。 */
const REAL_NOW = Date.now();
const clock = {
	now: () => REAL_NOW + 10 * 86_400_000,
	getRoleDateParts: () => ({ dateStr: '2030-01-01', hour: 12, minute: 0 }),
	toRealIntervalMs: (v, min = 1000) => Math.max(min, Math.floor(v / 1_000_000))
};

const cfg = {
	masterQqUin: '10001',
	qq: { enabled: true },
	bili: {},
	douyin: {},
	proactive: {
		enabled: true, dailyMaxCount: 5, activeHours: [8, 24], idleTriggerHours: 6, idleRealGapMinutes: 30,
		scheduleEnabled: true,
		targets: { masterCanonicalId: 'user:master', masterPrivateChannelId: '', selfGroupChannelIds: ['group:88888'] }
	}
};

const delivered = [];
let deliverOk = true;
let onDeliver = null;
const life = new LifeEngine({
	db, clock, getConfig: () => cfg, callLlm: async () => null,
	deliver: async (channelId, reason, meta) => {
		delivered.push({ channelId, reason, meta });
		if (onDeliver !== null) await onDeliver(channelId, reason, meta);
		return deliverOk;
	}
});

const deps = {
	db, clock, embedder: {}, worker: {}, life,
	getConfig: () => cfg,
	saveConfig: (patch) => { cfg = { ...cfg, ...patch }; },
	log: () => {},
	gateway: { workspacePath: () => '/ws', listWorkspaces: () => [], isPaused: () => false },
	channel: { status: () => ({ connected: true }), restart() {} },
	bili: { status: () => ({ loggedIn: false }), restart() {} },
	biliClient: null, browser: null, biliSocial: null,
	douyin: { status: () => ({ running: false }) },
	douyinHost: { browsers: [], status: () => ({ state: 'stopped' }) },
	douyinBrowser: null, douyinSocial: null
};

function mount() {
	let handler = null;
	registerRoutes({
		effect: (fn) => { fn(); },
		webServer: { register: (o) => { handler = o.handler; } }
	}, deps);
	return handler;
}

async function call(path, method = 'GET', body = null, headers = {}) {
	const handler = mount();
	let out = '';
	let code = 0;
	const req = new Readable({
		read() { if (body !== null) this.push(JSON.stringify(body)); this.push(null); }
	});
	req.url = `/api/plugins/fish-soul${path}`;
	req.method = method;
	req.headers = headers;
	const res = { writeHead: (c) => { code = c; }, end: (text) => { out = text; } };
	await handler(req, res);
	return { code, body: out === '' ? null : JSON.parse(out) };
}

const AT = '2099-01-02T09:00';
const newTask = (over = {}) => ({
	name: '盯服务器', prompt: '看看我的服务器有没有挂', recurrence: 'interval',
	at: AT, intervalMinutes: 20, target: 'private:10001', ...over
});

// ───────────────────────── ① 面板 CRUD（真路由 + 真 SQLite）─────────────────────────
{
	const state = await call('/scheduled-tasks/state');
	assert.equal(state.body.ok, true);
	assert.equal(state.body.tasks.length, 0, '一开始没有任务');
	assert.deepEqual(state.body.destinations.map((d) => d.id), ['private:10001', 'group:88888'],
		'可选目标 = 主人私聊 + 白名单里的自建群（真实存在的会话，不是随便填 id）');

	const created = await call('/scheduled-tasks/create', 'POST', newTask());
	assert.equal(created.body.ok, true, `创建要成功：${created.body.error}`);
	assert.equal(created.body.tasks.length, 1);
	const row = getScheduledTask(db, created.body.created.id);
	assert.equal(row.name, '盯服务器');
	assert.equal(row.prompt, '看看我的服务器有没有挂');
	assert.equal(row.recurrence, 'interval');
	assert.equal(row.interval_minutes, 20);
	assert.equal(row.enabled, 1);
	assert.equal(row.target_channel_id, 'private:10001');
	assert.equal(listScheduledTasks(db).length, 1, '真的落进 soul.db 了');

	const again = await call('/scheduled-tasks/state');
	assert.equal(again.body.tasks.length, 1, '刷新后要读得回来');
	assert.equal(again.body.tasks[0].name, '盯服务器');
	assert.equal(again.body.tasks[0].scheduleLabel, '每隔 20 分钟');
	ok('面板路由：建 → 落库 → 读得回来');
}

// ───────────────────────── ② 输入校验 & sameOrigin ─────────────────────────
{
	const bad = [
		[{ ...newTask({ name: '' }) }, /名称/],
		[{ ...newTask({ prompt: '' }) }, /提示词/],
		[{ ...newTask({ recurrence: 'weekly' }) }, /重复方式/],
		[{ ...newTask({ recurrence: 'interval', intervalMinutes: 0 }) }, /间隔/],
		[{ ...newTask({ recurrence: 'interval', intervalMinutes: -5 }) }, /间隔/],
		[{ ...newTask({ at: '2000-01-01T09:00' }) }, /过了/],
		[{ ...newTask({ at: '不是时间' }) }, /时间/],
		[{ ...newTask({ target: '' }) }, /地方/],
		[{ ...newTask({ target: 'group:99999' }) }, /地方/],
		[{ ...newTask({ target: 'private:99999' }) }, /地方/]
	];
	for (const [body, re] of bad) {
		const r = await call('/scheduled-tasks/create', 'POST', body);
		assert.equal(r.body.ok, false, `非法输入要被拒：${JSON.stringify(body)}`);
		assert.match(r.body.error, re, `要说清哪里不对：${r.body.error}`);
	}
	assert.equal(listScheduledTasks(db).length, 1, '被拒的不能留下半条记录');

	const cross = await call('/scheduled-tasks/create', 'POST', newTask(), { 'sec-fetch-site': 'cross-site' });
	assert.equal(cross.code, 403, '跨站 POST 必须被拒（sameOrigin）');
	const crossToggle = await call('/scheduled-tasks/toggle', 'POST', { id: 1, enabled: false }, { 'sec-fetch-site': 'cross-site' });
	assert.equal(crossToggle.code, 403, '开关也要过 sameOrigin');
	const crossDelete = await call('/scheduled-tasks/delete', 'POST', { id: 1 }, { 'sec-fetch-site': 'cross-site' });
	assert.equal(crossDelete.code, 403, '删除也要过 sameOrigin');
	assert.equal(listScheduledTasks(db).length, 1, '被拒的请求不能改到库');
	ok('非法输入被拒 + 每个 POST 都过 sameOrigin');
}

// ───────────────────────── ③ 排期：间隔 1 / 20 分钟、仅一次、每天 ─────────────────────────
{
	const one = await call('/scheduled-tasks/create', 'POST', newTask({ name: '每分钟', intervalMinutes: 1 }));
	assert.equal(one.body.ok, true, one.body.error);
	assert.equal(getScheduledTask(db, one.body.created.id).interval_minutes, 1, '1 分钟要能排（最少 1 分钟）');
	const twenty = await call('/scheduled-tasks/create', 'POST', newTask({ name: '二十分钟', intervalMinutes: 20 }));
	assert.equal(twenty.body.ok, true);
	assert.equal(getScheduledTask(db, twenty.body.created.id).interval_minutes, 20);

	// 仅一次
	const once = await call('/scheduled-tasks/create', 'POST', newTask({ name: '只做一次', recurrence: 'once' }));
	assert.equal(once.body.ok, true, once.body.error);
	const onceRow = getScheduledTask(db, once.body.created.id);
	assert.equal(onceRow.recurrence, 'once');
	assert.equal(onceRow.interval_minutes, null);
	assert.equal(taskToApi(onceRow).scheduleLabel, '仅一次');

	// 每天：角色时区（UTC+8）的下一个 HH:mm
	const daily = await call('/scheduled-tasks/create', 'POST', newTask({ name: '每天早上', recurrence: 'daily', dailyHhmm: '09:30', at: undefined }));
	assert.equal(daily.body.ok, true, daily.body.error);
	const dailyRow = getScheduledTask(db, daily.body.created.id);
	assert.equal(dailyRow.daily_hhmm, '09:30');
	assert.equal(taskToApi(dailyRow).scheduleLabel, '每天 09:30');
	assert.match(taskToApi(dailyRow).nextRunAtLabel, / 09:30$/, '下一次要落在角色时区的 09:30');
	ok('排期：间隔 1 / 20 分钟、仅一次、每天都对');
}

// ───────────────────────── ④ 重试 & 不重复投递 ─────────────────────────
{
	// 造一条「已经到点」的间隔任务
	const task = createScheduledTask(db, {
		name: '到点的任务', prompt: '跑一下', recurrence: 'interval', intervalMinutes: 20,
		nextRunAt: REAL_NOW - 1000, dailyHhmm: null, target: 'private:10001'
	}, { now: REAL_NOW - 1000 });

	// 认领是原子的：同一条只能被一个闹钟拿到
	const first = claimDueTasks(db, REAL_NOW);
	assert.equal(first.length, 1, '第一次认领拿到这条');
	assert.equal(claimDueTasks(db, REAL_NOW).length, 0, '认领过就不能再被拿到（不会投递两次）');

	// 真正要防的竞态：认领成功、但还没投递完时，状态已经是 running。
	// 这时另一个闹钟**直接按 id**去改也必须改不动（UPDATE 的 WHERE 要带 status = 'active'）。
	// 上面那条顺序调用测不到这个 —— SELECT 在第一步就把 running 的行过滤掉了。
	{
		const race = db.prepare("SELECT status FROM scheduled_task WHERE id = ?").get(task.id);
		assert.equal(race.status, 'running', '前提：认领后状态是 running');
		const stolen = db.prepare("UPDATE scheduled_task SET status = 'running', updated_at = ? WHERE id = ? AND status = 'active'").run(REAL_NOW, task.id);
		assert.equal(stolen.changes, 0, '已经是 running 的行，按 id 也改不动（原子认领成立）');

	// 上面的写法只能证明「带条件的 UPDATE 不会误改」。要证明「不带条件会误改」——
	// 也就是这条条件真的必要 —— 必须正反都跑一次（纯顺序场景里 SELECT 会先挡住，测不出差别）。
	const without = db.prepare("UPDATE scheduled_task SET status = 'running', updated_at = ? WHERE id = ?").run(REAL_NOW, task.id);
	assert.equal(without.changes, 1, '去掉条件时这条确实能被改到 —— 所以 AND status = ? 不是多余的');
	}
	db.prepare("UPDATE scheduled_task SET status = 'active' WHERE id = ?").run(task.id);

	// 投递失败 → 记错误 + 退避 + 任务留着
	deliverOk = false;
	delivered.length = 0;
	await life.flushScheduledTasks();
	let row = getScheduledTask(db, task.id);
	assert.equal(delivered.length, 1, '到点要投递一次');
	assert.equal(delivered[0].meta.origin, 'scheduled', '走的必须是定时任务这条路');
	assert.equal(delivered[0].reason, '跑一下', '投递的理由就是用户写的唤醒提示词');
	assert.equal(row.enabled, 1, '失败也要留着（不能把任务关掉）');
	assert.equal(row.status, 'active');
	assert.equal(row.attempts, 1, '失败次数要记下来');
	assert.equal(row.last_error, '没发出去', '错误要存下来给面板看');
	assert.ok(row.next_run_at > REAL_NOW, '要退避之后才重试');

	// 还没到重试时间 → 不重复发
	const before = delivered.length;
	await life.flushScheduledTasks();
	assert.equal(delivered.length, before, '没到重试时间不能再发一次');

	// 成功一次 → 按「本来该跑的那一刻」往后推 20 分钟；错过的时段跳过不补跑
	deliverOk = true;
	db.prepare('UPDATE scheduled_task SET next_run_at = ? WHERE id = ?').run(REAL_NOW - 1000, task.id);
	await life.flushScheduledTasks();
	row = getScheduledTask(db, task.id);
	assert.equal(row.status, 'active');
	assert.equal(row.attempts, 0, '成功了就清掉失败次数');
	assert.equal(row.last_error, '', '成功了就清掉错误');
	assert.ok(row.next_run_at >= REAL_NOW + 19 * 60_000, '下一次要从该跑的那一刻往后推 20 分钟');

	// 仅一次的任务跑完 → 完成并关掉
	const onceTask = createScheduledTask(db, {
		name: '只跑一次', prompt: '做一下', recurrence: 'once',
		nextRunAt: REAL_NOW - 1000, dailyHhmm: null, intervalMinutes: null, target: 'private:10001'
	}, { now: REAL_NOW - 1000 });
	await life.flushScheduledTasks();
	const onceRow = getScheduledTask(db, onceTask.id);
	assert.equal(onceRow.status, 'completed', '仅一次的任务跑完就是完成了');
	assert.equal(onceRow.enabled, 0, '跑完就关掉');
	ok('失败退避重试 + 成功重排 + 不重复投递 + 仅一次跑完即完成');

{
	// A. 投递层必须自己查白名单 —— 面板建/改时虽然校验过，但任务落库后白名单可能收紧，
	//    改库或未来新入口也可能写出非法 target。直接把库里的 target 改成不在白名单的值，
	//    投递时必须被拦，不允许真发出去。
	const bad = createScheduledTask(db, {
		name: '坏目标', prompt: '别发', recurrence: 'interval', intervalMinutes: 20,
		nextRunAt: REAL_NOW - 1000, dailyHhmm: null, target: 'private:10001'
	}, { now: REAL_NOW - 1000 });
	db.prepare("UPDATE scheduled_task SET target_channel_id = 'group:66666' WHERE id = ?").run(bad.id);
	db.prepare('UPDATE scheduled_task SET status = ?, next_run_at = ? WHERE id = ?').run('active', REAL_NOW - 1, bad.id);
	deliverOk = true;
	delivered.length = 0;
	await life.flushScheduledTasks();
	assert.equal(delivered.length, 0, '目标不在白名单 → 一条都不能发出去');
	const badRow = getScheduledTask(db, bad.id);
	assert.ok(badRow.last_error.includes('不在白名单'), `要记下原因，实际：${badRow.last_error}`);
	assert.equal(badRow.status, 'active', '拦住也不能直接完成，要走失败退避');
	ok('投递层白名单：落库后目标被改成非法值也拦得住');

	// B. 重排要按「投递完成的那一刻」算。模拟 deliver 耗时：认领时刻是 T，deliver 里把钟拨到 T+90s。
	//     间隔 1 分钟的任务：若用认领时刻算，next = T+60s，而完成时刻 T+90s 已经过了它，
	//     下一轮会立刻再跑。修复后按固定步长跳过已过去的槽位，next 严格晚于 T+90s 且保持步长对齐。
	const slow = createScheduledTask(db, {
		name: '慢投递', prompt: '慢慢发', recurrence: 'interval', intervalMinutes: 1,
		nextRunAt: REAL_NOW - 1, dailyHhmm: null, target: 'private:10001'
	}, { now: REAL_NOW - 1 });
	db.prepare('UPDATE scheduled_task SET status = ?, next_run_at = ? WHERE id = ?').run('active', REAL_NOW - 1, slow.id);
	const realNow = Date.now;
	let doneAt = 0;
	onDeliver = () => {
		const t = realNow() + 90_000;
		doneAt = t;
		Date.now = () => t;
	};
	try {
		delivered.length = 0;
		await life.flushScheduledTasks();
	} finally {
		onDeliver = null;
		Date.now = realNow;
	}
	const slowRow = getScheduledTask(db, slow.id);
	assert.ok(doneAt > 0, 'deliver 要被走到');
	assert.ok(slowRow.next_run_at > doneAt && slowRow.next_run_at <= doneAt + 60_000,
		`下一次必须严格晚于投递完成时刻且对齐步长（(${doneAt}, ${doneAt + 60_000}]），实际 ${slowRow.next_run_at}`);
	ok('重排用投递完成时刻：deliver 耗时压过下一个点也不会立刻重跑');

	// C. 投递期间并发改表或删任务：不能用认领前快照把新排期覆写掉。
	const editedStr = formatLocalDateTime(Date.now() + 10 * 60_000);
	const editedAt = parseLocalDateTime(editedStr);

	const concInterval = createScheduledTask(db, {
		name: '并发改间隔', prompt: '跑', recurrence: 'interval', intervalMinutes: 20,
		nextRunAt: REAL_NOW - 1, dailyHhmm: null, target: 'private:10001'
	}, { now: REAL_NOW - 1 });
	onDeliver = () => {
		updateScheduledTask(db, concInterval.id, { at: editedStr }, { now: Date.now() });
	};
	try {
		await life.flushScheduledTasks();
	} finally {
		onDeliver = null;
	}
	const concIntervalRow = getScheduledTask(db, concInterval.id);
	assert.equal(concIntervalRow.status, 'active');
	assert.equal(concIntervalRow.next_run_at, editedAt, '间隔任务投递期间被改期，完成写回不能用旧快照覆写');

	const concOnce = createScheduledTask(db, {
		name: '并发改单次', prompt: '跑', recurrence: 'once',
		nextRunAt: REAL_NOW - 1, dailyHhmm: null, intervalMinutes: null, target: 'private:10001'
	}, { now: REAL_NOW - 1 });
	onDeliver = () => {
		updateScheduledTask(db, concOnce.id, { at: editedStr }, { now: Date.now() });
	};
	try {
		await life.flushScheduledTasks();
	} finally {
		onDeliver = null;
	}
	const concOnceRow = getScheduledTask(db, concOnce.id);
	assert.equal(concOnceRow.status, 'active', '单次任务投递期间被改期，不能被旧快照标成 completed');
	assert.equal(concOnceRow.enabled, 1);
	assert.equal(concOnceRow.next_run_at, editedAt);

	const concDel = createScheduledTask(db, {
		name: '并发删除', prompt: '跑', recurrence: 'once',
		nextRunAt: REAL_NOW - 1, dailyHhmm: null, intervalMinutes: null, target: 'private:10001'
	}, { now: REAL_NOW - 1 });
	onDeliver = () => {
		deleteScheduledTask(db, concDel.id);
	};
	try {
		await life.flushScheduledTasks();
	} finally {
		onDeliver = null;
	}
	assert.equal(getScheduledTask(db, concDel.id), undefined, '投递期间被删除的任务不能出错或被重新写回');
	ok('投递期间并发改期 / 删除不被认领前快照覆写');

	// D. 每天任务滞后超过 24 小时后投递完成，下一次必须跳到严格晚于当前的 HH:mm。
	const overdueDaily = createScheduledTask(db, {
		name: '滞后每日', prompt: '早安', recurrence: 'daily',
		nextRunAt: REAL_NOW - 3 * 86_400_000, dailyHhmm: '09:30', intervalMinutes: null, target: 'private:10001'
	}, { now: REAL_NOW - 3 * 86_400_000 });
	await life.flushScheduledTasks();
	const dailyDoneRow = getScheduledTask(db, overdueDaily.id);
	assert.equal(dailyDoneRow.status, 'active');
	assert.ok(dailyDoneRow.next_run_at > Date.now(), '滞后多日的 daily 任务重排后必须严格晚于现在');
	ok('滞后多日的 daily 任务重排不会落回过去');
}
}

// ───────────────────────── ⑤ 虚拟钟加速不该让任务提前跑 ─────────────────────────
{
	const row = getScheduledTask(db, listScheduledTasks(db).find((t) => t.name === '到点的任务').id);
	const delay = life.nextScheduledTaskDelay();
	assert.ok(delay === null || delay > 0, '下一次还没到（真实钟）');
	// 虚拟钟已经快 10 天了，但任务的时间是真实钟算的：延迟不可能是负的、也不该是 10 天
	assert.ok(delay !== null && delay < 3600_000, `延迟要按真实钟算（虚拟钟快了 10 天），实际 ${delay}`);
	assert.ok(row.next_run_at > REAL_NOW, '排期存的是真实毫秒');
	ok('定时任务走真实钟：虚拟钟加速不会让它提前跑');
}

// ───────────────────────── ⑥ 起停接线 ─────────────────────────
{
	life.start();
	assert.notEqual(life.taskAlarm, null, 'start 之后要挂上定时任务的闹钟');
	life.stop();
	assert.equal(life.taskAlarm, null, 'stop 要清掉闹钟');
	// 已停止：再 flush 也不投递、也不把闹钟续上
	deliverOk = true;
	const before = delivered.length;
	await life.flushScheduledTasks();
	assert.equal(delivered.length, before, '停了以后不许再投递');
	assert.equal(life.taskAlarm, null, '已停止后不许再挂闹钟');
	ok('起停：start 挂闹钟 / stop 清闹钟 / 停了不再续上');
}

// ───────────────────────── ⑦ 路由改了 → 闹钟要重排（assertWire）─────────────────────────
{
	const fresh = new LifeEngine({
		db, clock, getConfig: () => cfg, callLlm: async () => null,
		deliver: async () => true
	});
	const savedLife = deps.life;
	deps.life = fresh;
	try {
		const wire = await assertWire({
			run: async () => {
				fresh.taskAlarm = null; // 每次从零开始：这一轮挂上了没有
				await call('/scheduled-tasks/create', 'POST', newTask({ name: '接线任务' }));
				return fresh.taskAlarm !== null;
			},
			target: () => fresh,
			method: 'armTaskAlarm',
			pick: (armed) => armed,
			why: '#190 建了任务以后闹钟必须重排，否则新任务要等下一个 tick 才生效'
		});
		assert.equal(wire.wired, true, '建完任务必须挂上闹钟');
		assert.equal(wire.cut, false, '剪断以后就不该挂 —— 说明这条接线真的被覆盖到了');
	} finally {
		deps.life = savedLife;
	}
	ok('路由 → 闹钟：接线被 assertWire 验过');
}

// ───────────────────────── ⑧ AI 工具边界：能看能改，不能建不能删 ─────────────────────────
{
	assert.ok(CHAT_TOOLS.includes('scheduled_tasks_list'), 'list 工具要在 CHAT_TOOLS 里（鱼的会话里才看得到）');
	assert.ok(CHAT_TOOLS.includes('scheduled_tasks_update'), 'update 工具要在 CHAT_TOOLS 里');

	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	const registered = [...src.matchAll(/name:\s*'(scheduled_[a-z_]+)'/g)].map((m) => m[1]);
	assert.deepEqual([...new Set(registered)].sort(), ['scheduled_tasks_list', 'scheduled_tasks_update'],
		'AI 那边只该有「看」和「改」两个工具');
	assert.ok(!registered.some((n) => /create|delete|remove|add/.test(n)), '不许有建 / 删的工具');

	const m = src.match(/name:\s*'scheduled_tasks_update'[\s\S]{0,4000}?\}\)\),\s*'dsh-fish-soul: scheduled_tasks_update'\)/);
	assert.ok(m, 'update 工具要真的注册');
	const body = m[0];
	assert.ok(!/\b(delete|create|remove|action)\b/.test(body), 'update 工具的参数里不能藏「建 / 删」的入口');
	for (const key of ['name', 'prompt', 'recurrence', 'at', 'intervalMinutes', 'dailyHhmm', 'enabled']) {
		assert.ok(body.includes(`${key}:`), `update 工具要能改 ${key}`);
	}

	// 工具真的能改（走工具用的那个函数，且带 allowedTarget 边界）
	const target = listScheduledTasks(db).find((t) => t.name === '盯服务器');
	const groupTask = createScheduledTask(db, {
		name: '群任务', prompt: '群里好', recurrence: 'interval', intervalMinutes: 20,
		nextRunAt: Date.now() + 600_000, dailyHhmm: null, target: 'group:88888'
	}, { now: Date.now() });
	const deniedGroup = updateScheduledTask(db, groupTask.id, { prompt: '篡改' }, { now: Date.now(), allowedTarget: 'private:10001' });
	assert.equal(deniedGroup.ok, false, 'AI 工具边界必须拒绝修改发往群聊的任务');
	assert.equal(getScheduledTask(db, groupTask.id).prompt, '群里好', '被拒后群任务提示词不能变动');

	const deniedTarget = updateScheduledTask(db, target.id, { target: 'group:88888' }, { now: Date.now(), allowedTarget: 'private:10001' });
	assert.equal(deniedTarget.ok, false, 'AI 工具边界不允许改发往的目标');
	assert.equal(getScheduledTask(db, target.id).target_channel_id, 'private:10001');

	const res = updateScheduledTask(db, target.id, { name: '改了名', enabled: false }, { now: Date.now(), allowedTarget: 'private:10001' });
	assert.equal(res.ok, true, res.error);
	assert.equal(getScheduledTask(db, target.id).name, '改了名');
	assert.equal(getScheduledTask(db, target.id).enabled, 0, '关掉要真的关掉');
	const again = updateScheduledTask(db, target.id, { prompt: '' }, { now: Date.now(), allowedTarget: 'private:10001' });
	assert.equal(again.ok, false, '空的提示词要被拒');
	assert.ok(body.includes('allowedTarget:') && body.includes('life.masterChannel('), 'index.js 必须把主人私聊目标传入 allowedTarget');
	assert.ok(!body.includes("'target'"), 'index.js 的 update 字段白名单不能包含 target');
	ok('AI 工具：能看能改主人私聊任务，不能改群任务 / 目标 / 建删');
}

// ───────────────────────── ⑨ 网关唤醒：定时任务那一轮给的是用户的指示 ─────────────────────────
{
	function makeGateway() {
		const gw = new ChatGateway({
			ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
			getConfig: () => cfg, log: () => {},
			channel: { connected: true, selfId: '1000', send: async () => 'mid-1', isFriend: () => true },
			bili: { connected: false, send: async () => {}, sendImage: async () => {} },
			soul: {
				beginTurn: () => {}, nowLabel: () => '现在是 2099-01-01 09:00', resolvePerson: () => null,
				memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼',
				recallInfo: () => [], journalOut: () => {}
			}
		});
		gw.sleep = async () => {};
		gw.applyChatModelFor = () => {};
		gw.workspacePath = () => '/ws';
		return gw;
	}
	async function proactiveText(meta, reason) {
		const gw = makeGateway();
		const captured = [];
		gw.ensureSession = async () => ({
			id: 'sess-1',
			followup: async (msg) => {
				captured.push(msg);
				const w = gw.waiters.get(msg.id);
				if (w !== undefined) { gw.waiters.delete(msg.id); w.resolve(true); }
			}
		});
		const done = await gw.triggerProactive('private:10001', reason, meta);
		return { done, text: captured[0]?.content?.[0]?.text ?? '', source: captured[0]?.source };
	}

	const sched = await proactiveText(
		{ origin: 'scheduled', taskId: 7, taskName: '盯服务器', prompt: '看看我的服务器有没有挂' },
		'看看我的服务器有没有挂'
	);
	assert.equal(sched.done, true, '定时任务这一轮要真的跑完');
	assert.match(sched.text, /定时任务/, '要标出这是定时任务');
	assert.match(sched.text, /盯服务器/, '要带上任务名');
	assert.match(sched.text, /看看我的服务器有没有挂/, '要给用户写的那句唤醒指示');
	assert.ok(!sched.text.includes('像平时聊天一样自然'), '定时任务不该用「像平时聊天一样自然」那套');
	assert.ok(!sched.text.includes('好久没说话'), '定时任务不该用「好久没说话」的措辞');
	assert.equal(sched.source.origin, 'scheduled', 'source 上要带着来源');

	const idle = await proactiveText({ origin: 'idle' }, '好久没说话了，随便聊聊');
	assert.match(idle.text, /像平时聊天一样自然/, '其它来源的老措辞不能被改');
	assert.match(idle.text, /好久没说话了/, '其它来源的措辞不能被改');
	ok('网关唤醒：定时任务给用户指示，其它来源措辞不变');
}

db.close();
console.log('✓ #190：定时任务全套断言通过');
