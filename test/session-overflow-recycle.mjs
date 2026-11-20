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
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-session-overflow-');
process.env.DSH_HOME = home;

const { openDatabase, insertChatSession, getKv } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();
const ok = (m) => console.log('  ✓ ' + m);

/** 最小网关：只要能跑 ensureSession / onSessionEvent 这两条路。 */
function makeGateway({ followupError = null, chatModels = undefined } = {}) {
	const created = [];
	const resumed = [];
	const notes = [];
	const live = new Map();
	const gw = new ChatGateway({
		ctx: {
			get: (name) => (name === 'agents' ? agents : undefined),
			tools: { restrict: () => () => {} }
		},
		db,
		clock: { now: () => Date.now() },
		getConfig: () => ({ qq: { enabled: true }, masterQqUin: '10001', ...(chatModels !== undefined ? { chatModels } : {}) }),
		log: () => {},
		channel: { connected: true, selfId: '1000', send: async () => '1', isFriend: () => true },
		bili: null,
		douyin: null,
		soul: {
			beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {},
			availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [], journalOut: () => {}
		},
		note: (kind, info) => { notes.push({ kind, info }); }
	});

	const makeAgent = (id) => ({
		id, session: { id }, options: { model: 'm' },
		async followup() { if (followupError !== null) throw followupError; }
	});

	const agents = {
		async create(opts) {
			created.push(opts);
			const agent = makeAgent(opts.sessionId);
			live.set(opts.sessionId, agent);
			return { agent, dispose: async () => {} };
		},
		async resume(opts) {
			resumed.push(opts.resumeSessionId);
			const agent = makeAgent(opts.resumeSessionId);
			live.set(opts.resumeSessionId, agent);
			return { agent, dispose: async () => {} };
		},
		get: (id) => live.get(id)
	};
	// 让 ChatGateway 里的 service(ctx,'agents') 拿得到
	gw.ctx.get = (name) => (name === 'agents' ? agents : undefined);

	return { gw, created, resumed, notes };
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

test('换会话要沿用同一个工作区（人设卡 / 板块都在那儿）', async () => {
	db.exec("DELETE FROM chat_session WHERE channel_id = 'private:30009'");
	const chat9 = { ...chat, channelId: 'private:30009', targetId: '30009' };
	const { gw, created } = makeGateway();
	const first = await gw.ensureSession(chat9);
	switchBlockedTurnEnd(gw, first.id, chat9.channelId);
	await gw.ensureSession(chat9);
	assert.equal(created[1].meta.cwd, created[0].meta.cwd, '换会话不能把工作区换掉');
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
console.log('session-overflow-recycle: all assertions passed');
