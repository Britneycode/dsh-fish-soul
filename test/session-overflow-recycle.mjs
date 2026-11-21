/**
 * 上下文满了 / 撞 400 / 换模型被宿主挡了之后，这个聊天要能自己换一条新会话，不能一直哑掉。
 *
 * 症状（主人报的）：一个对话上下文满了之后，或者不小心触发了 400，再说话她就不回复了。
 *
 * 原因：宿主压缩失败后把原错误放出来，turn/end 是 `{kind:'error', error:{code:'CONTEXT_WINDOW_EXCEEDED'}}`。
 * 我们这边只记一条「这一轮没正常结束」，会话还是同一条 —— 下一条消息又撞同一个错误，
 * 于是那个聊天**永久**不回话，只能人工重启或换人格。
 *
 * 契约：
 *   ① 撞上「上下文超限」或「换模型被宿主挡了」这一类，要么当场换新会话再试一次，要么至少把这条会话标成死的，
 *      下一条消息进来时换新的 —— 不能继续拿它去撞同一个错。
 *   ② 只有这两类才换。普通 provider 抖动（限额 / 超时 / 内容过滤）换会话是害人的：
 *      语境全丢、还白烧一轮。
 *   ③ 换完要说清为什么（运行日志留痕），不能静默重来。
 *   ④ 换模型被挡（MODEL_SWITCH_COMPACTION_FAILED）也是粘性的：模型没换成功，下一轮又会去换、
 *      又撞同一个错 ⇒ 不换会话，那个聊天就永久哑掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-session-overflow-');
process.env.DSH_HOME = home;

const { openDatabase, insertChatSession, getKv } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();
const ok = (m) => console.log('  ✓ ' + m);

/** 最小网关：只要能跑 ensureSession / onSessionEvent 这两条路，可选注入模型信息 / 测量 / 回调。 */
function makeGateway({
	followupError = null,
	chatModels = undefined,
	getConfig = null,
	resolveModelInfo = null,
	measure = null,
	defaultSelection = { provider: 'p0', model: 'm0' },
	onFollowup = null,
	douyinSettle = null,
	douyinSend = null,
	autoUpdateModel = false
} = {}) {
	const created = [];
	const resumed = [];
	const notes = [];
	const diags = [];
	const followups = [];
	const selected = [];
	const sent = [];
	const live = new Map();
	let agentsAvailable = true;
	const gw = new ChatGateway({
		ctx: {
			get: (name) => {
				if (name === 'agents') return agentsAvailable ? agents : null;
				if (name === 'llm') return {
					listProviders: () => [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }],
					...(resolveModelInfo ? { resolveModelInfo } : {})
				};
				if (name === 'tokenMeter') return measure ? { measure } : undefined;
				if (name === 'agentDefaultModel') return { currentSelection: () => defaultSelection };
				return undefined;
			},
			tools: { restrict: () => () => {} }
		},
		db,
		clock: { now: () => Date.now() },
		getConfig: getConfig ?? (() => ({ qq: { enabled: true }, masterQqUin: '10001', ...(chatModels !== undefined ? { chatModels } : {}) })),
		log: () => {},
		diag: { add: (key, detail, level) => diags.push({ key, detail, level }) },
		channel: { connected: true, selfId: '1000', send: async (...args) => { sent.push(args); return '1'; }, isFriend: () => true },
		bili: null,
		douyin: {
			connected: true,
			send: douyinSend ?? (async () => ({ ok: true, delivered: true })),
			inbox: { settle: (...args) => { if (douyinSettle) douyinSettle(...args); } }
		},
		soul: {
			beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {},
			availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [], journalOut: () => {},
			archiveDesktop: () => {}
		},
		note: (kind, info) => { notes.push({ kind, info }); }
	});

	const makeAgent = (id, initOpts) => {
		let curModel = initOpts?.agentOptions ? { ...initOpts.agentOptions } : { ...defaultSelection };
		return {
			id,
			session: { id, requestHeader: () => ({ config: { ...curModel, maxTokens: 100 } }) },
			options: { model: curModel.model ?? 'm' },
			model: {
				current: () => curModel,
				select: (sel) => {
					selected.push({ id, sel });
					if (autoUpdateModel) curModel = { ...sel };
				},
				setCurrent: (sel) => { curModel = { ...sel }; }
			},
			async followup(msg) {
				followups.push({ id, msg });
				if (onFollowup) await onFollowup(id, msg, gw);
				if (followupError !== null) throw followupError;
			}
		};
	};

	const agents = {
		async create(opts) {
			created.push(opts);
			const agent = makeAgent(opts.sessionId, opts);
			live.set(opts.sessionId, agent);
			return { agent, dispose: async () => {} };
		},
		async resume(opts) {
			resumed.push(opts.resumeSessionId);
			const agent = makeAgent(opts.resumeSessionId, opts);
			live.set(opts.resumeSessionId, agent);
			return { agent, dispose: async () => {} };
		},
		get: (id) => live.get(id)
	};

	return { gw, created, resumed, notes, diags, followups, selected, sent, agents, setAgentsAvailable: (v) => { agentsAvailable = v; } };
}

const chat = { channelId: 'private:30001', chatType: 'private', targetId: '30001', title: '某人' };

/** 造一条「这一轮撞了上下文超限」的 turn/end。 */
const overflowTurnEnd = (gw, sessionId) => {
	gw.onSessionEvent({ id: sessionId }, { type: 'user/message', data: { message: { id: 'm1', source: { kind: 'fish-soul/qq', channelId: chat.channelId } } } });
	gw.onSessionEvent({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } } } });
};

test('撞上上下文超限：下一条消息要换一条新会话（不能继续用死的那条）', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30001'");
	const { gw, created, resumed } = makeGateway();
	const first = await gw.ensureSession(chat);
	assert.equal(created.length, 1, '第一次要新建会话');
	const firstName = first.id;

	overflowTurnEnd(gw, firstName);

	const second = await gw.ensureSession(chat);
	assert.notEqual(second.id, firstName, '撞过上下文超限的会话不能再用来接新消息');
	assert.equal(resumed.length, 0, '死会话不该被恢复回来（恢复回来还是满的）');
	assert.equal(created.length, 2, '应该新建第二条会话');
	ok('超限后自动换新会话');
});

test('换了之后旧会话标成 retired，查会话不会再查到它', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30002'");
	const { gw } = makeGateway();
	const chat2 = { ...chat, channelId: 'private:30002', targetId: '30002' };
	const first = await gw.ensureSession(chat2);
	overflowTurnEnd(gw, first.id);
	await gw.ensureSession(chat2);
	const row = db.prepare("SELECT status FROM chat_session WHERE session_id = ?").get(first.id);
	assert.equal(row?.status, 'retired', '死会话要标 retired，否则重启后又被捡回来');
	ok('旧会话 retired');
});

test('普通失败（限额 / 超时 / 内容过滤）不换会话 —— 换了语境全丢还白烧一轮', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30003'");
	const chat3 = { ...chat, channelId: 'private:30003', targetId: '30003' };

	for (const reason of [
		{ kind: 'error', error: { code: 'QUOTA', message: 'quota exceeded' } },
		{ kind: 'error', error: { code: 'TIMEOUT', message: 'timeout' } },
		{ kind: 'error', error: { code: 'HTTP_400', message: 'invalid api key' } },
		{ kind: 'error', error: { code: 'HTTP_400', message: 'bad request: invalid parameter' } },
		// 同一个 MODEL_SWITCH_COMPACTION_FAILED，但内层是「摘要模型临时挂了」—— 可恢复，不该换会话
		{ kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message: 'Cannot switch to p/m: context compaction failed: summarization failed: 502 Bad Gateway. The previous request model is preserved; retry or select a model with a larger context window.' } },
		{ kind: 'max-tokens' },
		{ kind: 'aborted', reason: { kind: 'user' } },
		{ kind: 'blocked' }
	]) {
		db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30003'");
		const { gw, created } = makeGateway();
		const first = await gw.ensureSession(chat3);
		gw.onSessionEvent({ id: first.id }, { type: 'user/message', data: { message: { id: 'm1', source: { kind: 'fish-soul/qq', channelId: chat3.channelId } } } });
		gw.onSessionEvent({ id: first.id }, { type: 'turn/end', data: { reason } });
		const again = await gw.ensureSession(chat3);
		assert.equal(again.id, first.id, `${JSON.stringify(reason)} 不该换会话`);
		assert.equal(created.length, 1, `${JSON.stringify(reason)} 不该新建会话`);
	}
	ok('其它失败原因不误换会话');
});

test('超限这一轮要留痕（运行日志能看出为什么换）', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30004'");
	const chat4 = { ...chat, channelId: 'private:30004', targetId: '30004' };
	const { gw, notes } = makeGateway();
	const first = await gw.ensureSession(chat4);
	overflowTurnEnd(gw, first.id);
	await gw.ensureSession(chat4);
	const hit = gw.decisions.find((d) => /上下文/.test(String(d.reason ?? '')));
	assert.ok(hit, `运行日志要记下为什么换会话，实际：${JSON.stringify(gw.decisions.slice(0, 3))}`);
	assert.equal(hit.kind, 'session');
	assert.equal(hit.channelId, chat4.channelId, '要指到那个聊天上');
	ok('换会话留痕');
});

/** 造一条「换模型被宿主的压缩闸门挡了」的 turn/end。 */
const switchBlockedTurnEnd = (gw, sessionId, channelId) => {
	gw.onSessionEvent({ id: sessionId }, { type: 'user/message', data: { message: { id: 'm1', source: { kind: 'fish-soul/qq', channelId } } } });
	gw.onSessionEvent({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message: 'Cannot switch to p/m: context compaction failed: summary is not smaller than the shadowed content (1027 estimated framed tokens >= 1018). The previous request model is preserved; retry or select a model with a larger context window.' } } } });
};

test('换模型被挡（模型切换压缩失败）：下一条消息要换一条新会话', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30005'");
	const chat5 = { ...chat, channelId: 'private:30005', targetId: '30005' };
	const { gw, created, resumed } = makeGateway();
	const first = await gw.ensureSession(chat5);
	assert.equal(created.length, 1, '第一次要新建会话');
	switchBlockedTurnEnd(gw, first.id, chat5.channelId);
	const second = await gw.ensureSession(chat5);
	assert.notEqual(second.id, first.id, '换模型被挡的会话不能继续用来接新消息（下一轮还会撞同一个错）');
	assert.equal(resumed.length, 0, '死会话不该被恢复回来');
	assert.equal(created.length, 2, '应该新建第二条会话');
	const row = db.prepare("SELECT status FROM chat_session WHERE session_id = ?").get(first.id);
	assert.equal(row?.status, 'retired', '旧会话要标 retired，否则重启后又被捡回来');
	ok('换模型被挡后自动换新会话');
});

test('换模型被挡这一轮也要留痕（运行日志能看出为什么换）', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30006'");
	const chat6 = { ...chat, channelId: 'private:30006', targetId: '30006' };
	const { gw } = makeGateway();
	const first = await gw.ensureSession(chat6);
	switchBlockedTurnEnd(gw, first.id, chat6.channelId);
	await gw.ensureSession(chat6);
	const hit = gw.decisions.find((d) => /换模型/.test(String(d.reason ?? '')));
	assert.ok(hit, `运行日志要记下为什么换会话，实际：${JSON.stringify(gw.decisions.slice(0, 3))}`);
	assert.equal(hit.kind, 'session');
	assert.equal(hit.channelId, chat6.channelId, '要指到那个聊天上');
	ok('换模型被挡留痕');
});

test('重启后也认得这条会话坏了（名单在 kv 里，不只在内存）', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30007'");
	const chat7 = { ...chat, channelId: 'private:30007', targetId: '30007' };
	const before = makeGateway();
	const first = await before.gw.ensureSession(chat7);
	switchBlockedTurnEnd(before.gw, first.id, chat7.channelId);
	// 换个全新的网关实例：内存名单是空的，只剩 kv
	const after = makeGateway();
	const second = await after.gw.ensureSession(chat7);
	assert.notEqual(second.id, first.id, '重启后（内存名单空了）也要认得这条会话坏了，换新的');
	ok('kv 名单跨实例生效');
});

test('换出来的新会话要直接建在目标模型上（不然下一轮又去切、又失败）', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30008'");
	const chat8 = { ...chat, channelId: 'private:30008', targetId: '30008' };
	const { gw, created } = makeGateway({ chatModels: { private: { provider: 'p1', model: 'm1' } } });
	const first = await gw.ensureSession(chat8);
	switchBlockedTurnEnd(gw, first.id, chat8.channelId);
	await gw.ensureSession(chat8);
	assert.equal(created.length, 2, '应该新建第二条会话');
	assert.deepEqual(created[1].agentOptions, { provider: 'p1', model: 'm1' }, '新会话要直接建在目标模型上');
	ok('新会话带目标模型');
});

test('换会话要沿用原来那条会话的工作区（人设卡 / 板块都在那儿）', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30009'");
	const chat9 = { ...chat, channelId: 'private:30009', targetId: '30009' };
	const { gw, created } = makeGateway();
	const first = await gw.ensureSession(chat9);
	// 这条会话的工作区是单独指定的（人设卡 / 板块都在那儿）——换会话不能把它换回默认的那个
	const custom = join(home, 'ws-custom');
	db.prepare("UPDATE chat_session SET workspace_path = ? WHERE session_id = ?").run(custom, first.id);
	switchBlockedTurnEnd(gw, first.id, chat9.channelId);
	await gw.ensureSession(chat9);
	assert.equal(created[1].meta.cwd, custom, '换会话要沿用这条会话自己的工作区');
	ok('工作区不变');
});
test('两种坏法都踩过的会话，换完要把两个名单都清干净（别留残条目）', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30010'");
	const chat10 = { ...chat, channelId: 'private:30010', targetId: '30010' };
	const { gw } = makeGateway();
	const first = await gw.ensureSession(chat10);
	// 先撞上下文超限、再撞换模型被挡 —— 同一个会话、两个名单都有它
	gw.onSessionEvent({ id: first.id }, { type: 'user/message', data: { message: { id: 'm1', source: { kind: 'fish-soul/qq', channelId: chat10.channelId } } } });
	gw.onSessionEvent({ id: first.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } } } });
	switchBlockedTurnEnd(gw, first.id, chat10.channelId);
	await gw.ensureSession(chat10);
	const overflow = JSON.parse(String(getKv(db, 'session.overflowed', '[]') ?? '[]'));
	const blocked = JSON.parse(String(getKv(db, 'session.switchBlocked', '[]') ?? '[]'));
	assert.ok(!overflow.includes(first.id), '上下文超限那个名单要清干净');
	assert.ok(!blocked.includes(first.id), '换模型被挡那个名单也要清干净（只清一个会留下残条目）');
	ok('两个名单都清干净');
});

test('TargetPressureConfigError 类永久切换失败也触发换新会话，502 临时错仍不换', async () => {
	const chat11 = { ...chat, channelId: 'private:30011', targetId: '30011' };
	const permanentMsgs = [
		'Cannot switch to p1/m1: context compaction failed: compaction-basic: no context capacity for p1/m1; configure contextWindow on that adapter model. The previous request model is preserved; retry or select a model with a larger context window.',
		'Cannot switch to p1/m1: context compaction failed: compaction-basic: p1/m1 reserves 65536 completion tokens and 65536 headroom tokens of its 8192-token context window, leaving no pressure budget. The previous request model is preserved; retry or select a model with a larger context window.',
		'Cannot switch to p1/m1: context compaction failed: BasicCompactionConfig: p1/m1 retainTokens (4000) must be less than threshold tokens 3000. The previous request model is preserved; retry or select a model with a larger context window.'
	];
	for (const message of permanentMsgs) {
		db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30011'");
		const { gw, created } = makeGateway();
		const first = await gw.ensureSession(chat11);
		gw.onSessionEvent({ id: first.id }, { type: 'user/message', data: { message: { id: 'm1', source: { kind: 'fish-soul/qq', channelId: chat11.channelId } } } });
		gw.onSessionEvent({ id: first.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message } } } });
		const second = await gw.ensureSession(chat11);
		assert.notEqual(second.id, first.id, `永久配置失败应该换会话：${message}`);
		assert.equal(created.length, 2);
	}
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30011'");
	const { gw, created } = makeGateway();
	const first = await gw.ensureSession(chat11);
	gw.onSessionEvent({ id: first.id }, { type: 'user/message', data: { message: { id: 'm1', source: { kind: 'fish-soul/qq', channelId: chat11.channelId } } } });
	gw.onSessionEvent({ id: first.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message: 'Cannot switch to p1/m1: context compaction failed: summarization failed: 502 Bad Gateway.' } } } });
	const again = await gw.ensureSession(chat11);
	assert.equal(again.id, first.id, '502 临时失败不能误换会话');
	assert.equal(created.length, 1);
	ok('TargetPressureConfigError 换会话，502 不误换');
});

test('换模型前预检：超窗或缺失 contextWindow 直接换新会话，未超窗原地保留', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30012'");
	const chat12 = { ...chat, channelId: 'private:30012', targetId: '30012' };
	let cfg = { qq: { enabled: true }, masterQqUin: '10001' };
	let modelInfo = { context: { contextWindow: 4000 }, defaultMaxTokens: 500 };
	let totalTokens = 3200;
	const { gw, created, selected, diags } = makeGateway({
		getConfig: () => cfg,
		resolveModelInfo: async () => modelInfo,
		measure: () => ({ totalTokens })
	});

	const s1 = await gw.ensureSession(chat12);
	// 切到目标模型 p1/m1，刚好触 threshold=3200 -> 预检直接换新会话且不调 m.select
	cfg = { ...cfg, chatModels: { private: { provider: 'p1', model: 'm1' } } };
	const s2 = await gw.ensureSession(chat12);
	assert.notEqual(s2.id, s1.id, '超阈值应在 ensureSession 直接换新会话');
	assert.equal(created.length, 2);
	assert.deepEqual(created[1].agentOptions, { provider: 'p1', model: 'm1' });
	assert.equal(selected.length, 0, '直接建在目标模型上，不该先切旧会话');
	assert.ok(diags.some((d) => d.key === 'session-switch-preflight' && d.detail.reason === 'over-threshold'));

	// 缺失 contextWindow 时也直接预检换新会话
	cfg = { ...cfg, chatModels: { private: { provider: 'p2', model: 'm2' } } };
	modelInfo = { context: undefined };
	const s3 = await gw.ensureSession(chat12);
	assert.notEqual(s3.id, s2.id, '没有 contextWindow 应直接换新会话');
	assert.equal(created.length, 3);
	assert.ok(diags.some((d) => d.key === 'session-switch-preflight' && d.detail.reason === 'no-context-window'));

	// 未超阈值时原地保留同一会话
	cfg = { ...cfg, chatModels: { private: { provider: 'p1', model: 'm1' } } };
	modelInfo = { context: { contextWindow: 32000 }, defaultMaxTokens: 1000 };
	totalTokens = 1000;
	const s4 = await gw.ensureSession(chat12);
	assert.equal(s4.id, s3.id, '未超阈值应保留原会话原地切换');
	assert.equal(created.length, 3);
	ok('换模型前预检超窗 / 缺窗口直接换新，未超窗保留');
});

test('dispatch 撞粘性失败时当轮自动换新会话重试 1 次，且不提前把抖音私信判失败', async () => {
	// Case A: 首次失败 -> 自动换新会话重试成功，只结算 1 次 ok:true
	db.exec("DELETE FROM chat_session WHERE channel_id = 'douyin:测试人'");
	const settlesA = [];
	const { gw, created, followups } = makeGateway({
		douyinSettle: (ids, isOk, why) => settlesA.push({ ids, ok: isOk, why }),
		onFollowup: async (sid, msg, inst) => {
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			if (followups.length === 1) {
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message: 'Cannot switch to p1/m1: context compaction failed: summary is not smaller than the shadowed content (1027 estimated framed tokens >= 1018).' } } } });
			} else {
				inst.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到啦' }] } } });
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
			}
		}
	});
	const conv = '0:1:111:222';
	await gw.dispatch('douyin:测试人', [{ m: { userId: 'uid:222', nickname: '测试人', messageId: 'dy-1', chatType: 'private', targetId: '测试人', inboxId: 42, convId: conv, text: '你好', images: [], timeMs: Date.now() }, person: null }]);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(created.length, 2, '当轮重试应建出第 2 条新会话');
	assert.equal(followups.length, 2, '同一条消息应在两条会话上各发 1 次');
	assert.notEqual(followups[0].id, followups[1].id);
	assert.equal(settlesA.length, 1, '首次失败等待重试期间不能结算');
	assert.deepEqual(settlesA[0], { ids: [42], ok: true, why: '' });

	// Case B: 重试后第 2 次仍失败 -> 最多试 1 次，不死循环，结算 ok:false
	db.exec("DELETE FROM chat_session WHERE channel_id = 'douyin:测试人2'");
	const settlesB = [];
	const g2 = makeGateway({
		douyinSettle: (ids, isOk, why) => settlesB.push({ ids, ok: isOk, why }),
		onFollowup: async (sid, msg, inst) => {
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } } } });
		}
	});
	await g2.gw.dispatch('douyin:测试人2', [{ m: { userId: 'uid:333', nickname: '测试人2', messageId: 'dy-2', chatType: 'private', targetId: '测试人2', inboxId: 99, convId: conv, text: '你好', images: [], timeMs: Date.now() }, person: null }]);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(g2.created.length, 2, '第 2 条失败后停止当轮重试');
	assert.equal(g2.followups.length, 2);
	assert.equal(settlesB.length, 1);
	assert.equal(settlesB[0].ok, false, '第 2 次也失败后必须落 ok:false');
	ok('dispatch 当轮仅重试 1 次且收件箱结算不早产');
});

test('triggerProactive 撞上下文超限时当轮换新会话重试并把原 Promise 解析为 true', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30014'");
	const { gw, created, followups, sent } = makeGateway({
		onFollowup: async (sid, msg, inst) => {
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			if (followups.length === 1) {
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } } } });
			} else {
				inst.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在干嘛呀' }] } } });
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
			}
		}
	});
	const delivered = await gw.triggerProactive('private:30014', '想找你说话');
	assert.equal(delivered, true, '换新会话重试成功后原 Promise 应返回 true');
	assert.equal(created.length, 2);
	assert.equal(followups.length, 2);
	assert.equal(sent.length, 1);
	ok('triggerProactive 当轮换新会话重试成功');
});

test('连续换新会话仍超限在 2 次后熔断，换模型 / 成功轮次 / 手动重置都能解锁', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30015'");
	const chat15 = { ...chat, channelId: 'private:30015', targetId: '30015' };
	let cfg = { qq: { enabled: true }, masterQqUin: '10001' };
	const { gw, created, diags } = makeGateway({ getConfig: () => cfg });

	const s1 = await gw.ensureSession(chat15);
	overflowTurnEnd(gw, s1.id);
	const s2 = await gw.ensureSession(chat15); // 第 1 次回收
	overflowTurnEnd(gw, s2.id);
	const s3 = await gw.ensureSession(chat15); // 第 2 次回收
	overflowTurnEnd(gw, s3.id);

	await assert.rejects(() => gw.ensureSession(chat15), /连续换新会话/, '第 3 次起必须熔断拒绝');
	assert.equal(created.length, 3, '熔断后绝不能继续建第 4 条空会话');
	assert.ok(diags.some((d) => d.key === 'session-recycle-breaker'));
	assert.ok(gw.decisions.some((n) => n.kind === 'failed' && /连续换新会话/.test(n.reason)));

	// 解锁 1：换到另一个目标模型
	cfg = { ...cfg, chatModels: { private: { provider: 'p1', model: 'm1' } } };
	const s4 = await gw.ensureSession(chat15);
	assert.notEqual(s4.id, s3.id, '换模型后熔断应解锁');

	// 再把 p1/m1 熔断一次（s4 本身是切换后的第 1 次回收，s5 是第 2 次），测解锁 2：手动 resetSession
	overflowTurnEnd(gw, s4.id);
	const s5 = await gw.ensureSession(chat15);
	overflowTurnEnd(gw, s5.id);
	await assert.rejects(() => gw.ensureSession(chat15), /连续换新会话/);
	const resetRes = await gw.resetSession(chat15.channelId, '测试重置');
	assert.notEqual(resetRes.sessionId, s5.id, '手动 resetSession 应清熔断并新建会话');

	// 解锁 3：正常完成一轮会清空计数，允许再次连续回收 2 次
	const s7 = await gw.ensureSession(chat15);
	overflowTurnEnd(gw, s7.id);
	const s8 = await gw.ensureSession(chat15); // 计数=1
	gw.onSessionEvent({ id: s8.id }, { type: 'user/message', data: { message: { id: 'm-ok', source: { kind: 'fish-soul/qq', channelId: chat15.channelId } } } });
	gw.onSessionEvent({ id: s8.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	await new Promise((r) => setTimeout(r, 15));
	overflowTurnEnd(gw, s8.id);
	const s9 = await gw.ensureSession(chat15); // 重置后计数=1
	overflowTurnEnd(gw, s9.id);
	const s10 = await gw.ensureSession(chat15); // 重置后计数=2，未在 1 次就误熔断
	assert.notEqual(s10.id, s9.id);
	ok('连续回收熔断 + 换模型 / 手动重置 / 成功轮次解锁');
});

test('清掉 chatModels 覆盖后若切换临时失败，下一轮仍会重试切回默认，确认切回后再摘标记', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30018'");
	const chat18 = { ...chat, channelId: 'private:30018', targetId: '30018' };
	let cfg = { qq: { enabled: true }, masterQqUin: '10001', chatModels: { private: { provider: 'p1', model: 'm1' } } };
	const { gw, selected } = makeGateway({ getConfig: () => cfg, autoUpdateModel: false });
	const agent = await gw.ensureSession(chat18);
	// Turn 1: 登记过 _modelApplied
	gw.applyChatModelFor(agent, chat18.channelId);
	assert.equal(gw._modelApplied.has(agent.id), true);

	// 清掉覆盖，且第一次 m.select 后 m.current() 仍停在 p1/m1（模拟宿主压缩临时挂了保留原模型）
	cfg = { qq: { enabled: true }, masterQqUin: '10001' };
	gw.applyChatModelFor(agent, chat18.channelId);
	assert.equal(selected.length, 1);
	assert.deepEqual(selected[0].sel, { provider: 'p0', model: 'm0' });
	assert.equal(gw._modelApplied.has(agent.id), true, 'current 未变化前不能提前摘掉 _modelApplied');

	// Turn 3: 下一轮仍要重试切回 p0/m0
	gw.applyChatModelFor(agent, chat18.channelId);
	assert.equal(selected.length, 2);

	// 模拟切回真正生效，再调一次不重发 select 且清掉 _modelApplied
	agent.model.setCurrent({ provider: 'p0', model: 'm0' });
	gw.applyChatModelFor(agent, chat18.channelId);
	assert.equal(selected.length, 2, 'current 已是默认模型时不再调 select');
	assert.equal(gw._modelApplied.has(agent.id), false, '确认切回后再清理标记');
	ok('_modelApplied 切回默认重试与清理逻辑正确');
});

test('DSH 桌面端打字轮次失败记 failed 动态不记 dsh，成功轮次照常记 dsh', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30019'");
	const chat19 = { ...chat, channelId: 'private:30019', targetId: '30019' };
	const { gw } = makeGateway();
	const agent = await gw.ensureSession(chat19);

	gw.onSessionEvent({ id: agent.id }, { type: 'user/message', data: { message: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '桌面问一句' }] } } });
	gw.onSessionEvent({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_SWITCH_COMPACTION_FAILED', message: 'Cannot switch to p1/m1: context compaction failed: summary is not smaller than the shadowed content (1027 estimated framed tokens >= 1018).' } } } });
	assert.equal(gw.decisions.filter((d) => d.kind === 'dsh').length, 0, '失败的桌面端轮次不该记成 dsh 正常对话');
	const failedNote = gw.decisions.find((d) => d.kind === 'failed');
	assert.ok(failedNote && /DSH 桌面端/.test(failedNote.reason), '失败的桌面端轮次要记进 failed');

	gw.decisions.length = 0;
	gw.onSessionEvent({ id: agent.id }, { type: 'user/message', data: { message: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '再问一句' }] } } });
	gw.onSessionEvent({ id: agent.id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回你啦' }] } } });
	gw.onSessionEvent({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
	assert.equal(gw.decisions.filter((d) => d.kind === 'dsh').length, 1, '正常完成的桌面端轮次照常记 dsh');
	ok('DSH 桌面端失败/成功动态区分正确');
});

test('主人发 /鱼 新会话 命令立即换新会话并回复确认', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30020'");
	const chat20 = { ...chat, channelId: 'private:30020', targetId: '30020' };
	const { gw, created, sent } = makeGateway({ getConfig: () => ({ qq: { enabled: true }, masterQqUin: '30020' }) });
	const first = await gw.ensureSession(chat20);
	const handled = await gw.handleCommand({ channelId: 'private:30020', userId: '30020', nickname: '主人', text: '/鱼 新会话' });
	assert.equal(handled, true);
	assert.equal(created.length, 2);
	const oldRow = db.prepare('SELECT status FROM chat_session WHERE session_id = ?').get(first.id);
	assert.equal(oldRow?.status, 'retired');
	assert.equal(sent.length, 1);
	assert.match(sent[0][1][0].data.text, /换了一条新会话/);
	ok('/鱼 新会话 命令生效');
});

test('resetSession 失败时保留原会话与工作区，/鱼 新会话 失败不抛未捕获异常并回复提示', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30021'");
	const customWs = join(home, 'ws-preserve-on-reset-fail');
	const chat21 = { ...chat, channelId: 'private:30021', targetId: '30021' };
	const { gw, agents, sent, setAgentsAvailable } = makeGateway({ getConfig: () => ({ qq: { enabled: true }, masterQqUin: '30021' }) });
	const first = await gw.createSession(chat21, customWs);

	// 1. agents 不可用时，resetSession 拒绝且原会话与 workspace_path 完好无损
	setAgentsAvailable(false);
	await assert.rejects(() => gw.resetSession('private:30021'), /agents/);
	const afterNoAgents = db.prepare('SELECT session_id, status, workspace_path FROM chat_session WHERE session_id = ?').get(first.id);
	assert.equal(afterNoAgents?.status, 'active', 'agents 不可用时不能把原会话标成 retired');
	assert.equal(afterNoAgents?.workspace_path, customWs, '原工作区必须完整保留');
	assert.equal(gw.bound.has(first.id), true, '原会话必须仍在 bound 中');

	// /鱼 新会话 在 agents 不可用时不抛异常，回复失败提示并保持原会话活跃
	const handled = await gw.handleCommand({ channelId: 'private:30021', userId: '30021', nickname: '主人', text: '/鱼 新会话' });
	assert.equal(handled, true);
	assert.equal(sent.length, 1);
	assert.match(sent[0][1][0].data.text, /失败/);

	// 2. agents.create 抛错时同样不能破坏原会话
	setAgentsAvailable(true);
	agents.create = async () => { throw new Error('create failed'); };
	await assert.rejects(() => gw.resetSession('private:30021'), /create failed/);
	const afterCreateErr = db.prepare('SELECT status, workspace_path FROM chat_session WHERE session_id = ?').get(first.id);
	assert.equal(afterCreateErr?.status, 'active');
	assert.equal(afterCreateErr?.workspace_path, customWs);
	assert.equal(gw.bound.has(first.id), true);
	ok('resetSession 失败不破坏原会话与工作区');
});

test('多条消息合并到同一失败轮次时，全部重试并正确结算所有抖音收件箱与主动等待方', async () => {
	// 1. 两批抖音私信合并到同一个 turn/end
	db.exec("DELETE FROM chat_session WHERE channel_id = 'douyin:合并测试A'");
	const settled1 = [];
	let count1 = 0;
	const g1 = makeGateway({
		douyinSettle: (ids, isOk) => settled1.push({ ids, ok: isOk }),
		onFollowup: async (sid, msg, inst) => {
			count1++;
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			if (count1 === 2) {
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } } } });
			} else if (count1 >= 3) {
				inst.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `回复${count1}` }] } } });
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
			}
		}
	});
	const conv = '0:1:555:666';
	await g1.gw.dispatch('douyin:合并测试A', [{ m: { userId: 'uid:666', nickname: '合并测试A', messageId: 'm-c1', chatType: 'private', targetId: '合并测试A', inboxId: 101, convId: conv, text: '第一句', images: [], timeMs: Date.now() }, person: null }]);
	await g1.gw.dispatch('douyin:合并测试A', [{ m: { userId: 'uid:666', nickname: '合并测试A', messageId: 'm-c2', chatType: 'private', targetId: '合并测试A', inboxId: 102, convId: conv, text: '第二句', images: [], timeMs: Date.now() }, person: null }]);
	await new Promise((r) => setTimeout(r, 50));
	const okIds1 = settled1.filter((s) => s.ok === true).flatMap((s) => s.ids).sort((a, b) => a - b);
	assert.deepEqual(okIds1, [101, 102], `两条合并消息都要重试并结算成功，实际：${JSON.stringify(settled1)}`);
	assert.equal(settled1.some((s) => s.ok === false), false, '合并重试成功时不能提前判失败');

	// 2. 共享会话上 dispatch + triggerProactive 合并到同一失败 turn/end
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30023'");
	const settled2 = [];
	let count2 = 0;
	const g2 = makeGateway({
		getConfig: () => ({ qq: { enabled: true }, masterQqUin: '30023', douyin: { enabled: true, masterName: '合并测试B', masterUid: 'douyin:777' } }),
		douyinSettle: (ids, isOk) => settled2.push({ ids, ok: isOk }),
		onFollowup: async (sid, msg, inst) => {
			count2++;
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			if (count2 === 2) {
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } } } });
			} else if (count2 >= 3) {
				inst.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `回复${count2}` }] } } });
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
			}
		}
	});
	await g2.gw.dispatch('douyin:合并测试B', [{ m: { userId: 'uid:777', nickname: '合并测试B', messageId: 'm-c3', chatType: 'private', targetId: '合并测试B', inboxId: 103, convId: conv, text: '先发一句', images: [], timeMs: Date.now() }, person: null }]);
	const proactiveOk = await g2.gw.triggerProactive('private:30023', '顺便主动说一句');
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(proactiveOk, true, '合并在后面的主动开口也要完成重试并返回 true');
	assert.deepEqual(settled2.filter((s) => s.ok === true).flatMap((s) => s.ids), [103], '抖音消息也要随重试结算 ok:true');
	ok('多消息合并失败轮次全部重试并正确结算');
});

test('agent.followup 既发 turn/end 又 reject，或直接 reject 不发 turn/end 时都能安全换新会话重试', async () => {
	const overflowErr = Object.assign(new Error('context length exceeded'), { code: 'CONTEXT_WINDOW_EXCEEDED' });

	// 1. 既发 turn/end(error) 又 reject：不重复报错、不丢重试成功结果
	db.exec("DELETE FROM chat_session WHERE channel_id = 'douyin:双报测试'");
	const settlesBoth = [];
	let step1 = 0;
	const gBoth = makeGateway({
		douyinSettle: (ids, isOk) => settlesBoth.push({ ids, ok: isOk }),
		onFollowup: async (sid, msg, inst) => {
			step1++;
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			if (step1 === 1) {
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } } } });
				throw overflowErr;
			}
			inst.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好了' }] } } });
			inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
		}
	});
	const conv = '0:1:888:999';
	await gBoth.gw.dispatch('douyin:双报测试', [{ m: { userId: 'uid:999', nickname: '双报测试', messageId: 'm-b1', chatType: 'private', targetId: '双报测试', inboxId: 201, convId: conv, text: '你好', images: [], timeMs: Date.now() }, person: null }]);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(gBoth.created.length, 2);
	assert.deepEqual(settlesBoth, [{ ids: [201], ok: true }], '不能在 followup reject 时提前结算 ok:false');

	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30024'");
	let step1p = 0;
	const gBothP = makeGateway({
		onFollowup: async (sid, msg, inst) => {
			step1p++;
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			if (step1p === 1) {
				inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } } } });
				throw overflowErr;
			}
			inst.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '主动好了' }] } } });
			inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
		}
	});
	assert.equal(await gBothP.gw.triggerProactive('private:30024', '试一下'), true, 'triggerProactive 在双报时也要通过重试返回 true');

	// 2. followup 直接 reject 不发 turn/end：dispatch 与 triggerProactive 都要当场换新会话重试 1 次
	db.exec("DELETE FROM chat_session WHERE channel_id = 'douyin:直拒测试'");
	const settlesDirect = [];
	let step2 = 0;
	const gDirect = makeGateway({
		douyinSettle: (ids, isOk) => settlesDirect.push({ ids, ok: isOk }),
		onFollowup: async (sid, msg, inst) => {
			step2++;
			if (step2 === 1) throw overflowErr;
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			inst.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '重试成功' }] } } });
			inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
		}
	});
	await gDirect.gw.dispatch('douyin:直拒测试', [{ m: { userId: 'uid:111', nickname: '直拒测试', messageId: 'm-d1', chatType: 'private', targetId: '直拒测试', inboxId: 202, convId: conv, text: '你好', images: [], timeMs: Date.now() }, person: null }]);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(gDirect.created.length, 2);
	assert.deepEqual(settlesDirect, [{ ids: [202], ok: true }]);

	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30025'");
	let step2p = 0;
	let observedRetryKey = '';
	const gDirectP = makeGateway({
		onFollowup: async (sid, msg, inst) => {
			step2p++;
			if (step2p === 1) throw overflowErr;
			const w = inst.waiters.get(msg.id);
			observedRetryKey = w?.key ?? '';
			inst.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { id: msg.id, source: msg.source } } });
			inst.onSessionEvent({ id: sid }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '主动重试成功' }] } } });
			inst.onSessionEvent({ id: sid }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
		}
	});
	assert.equal(await gDirectP.gw.triggerProactive('private:30025', '直接 reject 重试'), true);
	assert.equal(observedRetryKey, gDirectP.followups[1].msg.id, '复用 waiter 时 key 要同步更新为新轮次 msgId');
	ok('followup reject 双路径重试与 waiter key 更新正确');
});

console.log('session-overflow-recycle: all assertions passed');
