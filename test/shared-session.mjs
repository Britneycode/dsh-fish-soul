// #78 第 2 步：同一个人的 B站 / 抖音 私信并进 QQ 私聊那个会话。
//
// 为什么要测：会话一共享，认错人就会串号（把别人的私聊接进来最贵）。
// 这里钉住四条边界：能算出 QQ 号才并、QQ 关着不并、群一律不并、并了以后旧会话不再被查到。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('shared-session-');
const { openDatabase, findChatSession, insertChatSession } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();
const ok = (n) => console.log('✓', n);
const created = [];

/** 假的宿主：agents 只记下 create 的入参，resume 一调就报错（这几种情况都该新建）。 */
function gateway(cfg) {
	const agents = {
		get: () => undefined,
		async resume() { throw new Error('不该恢复会话'); },
		async create(opts) {
			created.push(opts);
			return { agent: { id: opts.sessionId, session: { id: opts.sessionId }, options: opts.agentOptions, async followup() {} } };
		}
	};
	const reg = { create: async (path, title) => ({ path, title, attachSession: async () => {} }), list: () => [] };
	return new ChatGateway({
		ctx: {
			get: (n) => (n === 'agents' ? agents
				: n === 'workspaceRegistry' ? reg
					: n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'ds', model: 'ds-chat' }) } : undefined),
			tools: { get: () => ({}) }
		},
		db, clock: { now: () => Date.now() }, getConfig: () => cfg, log: () => {},
		channel: { connected: true, selfId: '1000', send: async () => '1', groupName: async () => '', getMessage: async () => null, isFriend: () => true },
		soul: { beginTurn() {}, nowLabel: () => '现在', resolvePerson() { return null; }, memorizeUnanswered() {}, personaName: () => '小鱼', recallInfo: () => [] }
	});
}

const cfg = {
	qq: { enabled: true }, masterQqUin: '875692618',
	bili: { enabled: true, masterUid: '172195454', links: ['172195454=875692618', '3777=66666666'] },
	douyin: { enabled: true, masterName: '主人', links: ['小鱼干=12345678'] }
};

const biliChat = (uid) => ({ channelId: `bili:${uid}`, chatType: 'private', targetId: uid, title: '某人的昵称' });

{
	// 1. B站 主人 关联了 QQ：会话开成 QQ 私聊那个，B站 自己不另开
	const gw = gateway(cfg);
	const agent = await gw.ensureSession(biliChat('172195454'));
	const row = gw.chatForSession(agent.id);
	assert.equal(row.channel_id, 'private:875692618', 'B站 私信要用 QQ 私聊那个会话');
	assert.equal(findChatSession(db, 'bili', 'bili:172195454'), null, 'B站 不该再有自己的会话');
	assert.match(row.title, /^QQ·/, '标题按 QQ 那边起（不叫 B站·…）');
	assert.equal(gw.ownerChannelOf(agent), 'private:875692618', '模型 / 暂停这些跟着主通道走');
	ok('B站 私信关联了 QQ → 用同一个人的 QQ 会话，不另开会话');
}

{
	// 2. 抖音 配了「昵称 = QQ 号」对应表：并进对应的那个 QQ 会话
	const gw = gateway(cfg);
	const agent = await gw.ensureSession({ channelId: 'douyin:小鱼干', chatType: 'private', targetId: '小鱼干', title: '' });
	assert.equal(gw.chatForSession(agent.id).channel_id, 'private:12345678');
	assert.equal(findChatSession(db, 'douyin', 'douyin:小鱼干'), null, '抖音 不该再单开一个会话');
	ok('抖音 配了对应表 → 并进对应的 QQ 私聊会话');
}

{
	// 3. 算不出 QQ 号（没配对应表）：还是各聊各的，别猜
	const gw = gateway(cfg);
	const agent = await gw.ensureSession(biliChat('1999'));
	assert.equal(gw.chatForSession(agent.id).channel_id, 'bili:1999', '没关联就该自己一个会话');
	ok('没配「B站 UID = QQ 号」→ 各平台各一个会话，不瞎并');
}

{
	// 4. QQ 关着：不并（并了会往一个 QQ 连不上的会话里塞 B站 的话）
	const gw = gateway({ ...cfg, qq: { enabled: false } });
	const agent = await gw.ensureSession(biliChat('172195454'));
	assert.equal(gw.chatForSession(agent.id).channel_id, 'bili:172195454');
	ok('QQ 没开 → B站 不并进 QQ 会话');
}

{
	// 5. 群一律不并：群里的话不能流进私聊
	const gw = gateway(cfg);
	assert.equal(gw.personKeyOf({ channelId: 'group:88888', chatType: 'group' }), '');
	assert.equal(gw.personKeyOf({ channelId: 'douyin-group:某个群', chatType: 'group' }), '');
	const agent = await gw.ensureSession({ channelId: 'group:88888', chatType: 'group', targetId: '88888', title: '' });
	assert.equal(gw.chatForSession(agent.id).channel_id, 'group:88888');
	ok('群聊不共享会话（只有同一个人的私聊共享）');
}

{
	// 6. 升级前 B站 自己那个会话：并进 QQ 后标 retired + 记下并到了哪儿，之后不再被查到
	const gw = gateway(cfg);
	const old = insertChatSession(db, {
		channel: 'bili', channelId: 'bili:3777', sessionId: 'old-bili-3777',
		workspacePath: process.env.DSH_HOME, title: 'B站·某人', nowMs: Date.now() - 86_400_000
	});
	assert.equal(old.channel_id, 'bili:3777');
	const agent = await gw.ensureSession(biliChat('3777'));
	const row = gw.chatForSession(agent.id);
	assert.equal(row.channel_id, 'private:66666666', '新会话开在 QQ 那边');
	const after = db.prepare('SELECT * FROM chat_session WHERE session_id = ?').get('old-bili-3777');
	assert.equal(after.status, 'retired', '旧 B站 会话要退役');
	assert.equal(after.merged_into, row.session_id, '要记下并进了哪个会话');
	assert.equal(findChatSession(db, 'bili', 'bili:3777'), null, '退役后查会话查不到它');
	ok('升级前 B站 自己那个会话：退役并记下并到哪儿，聊天记录不删');
}

{
	// 7. 模型跟会话主通道走：B站 的消息不能把同一个会话的模型来回换（换一次 KV cache 就废一次）
	const withModels = { ...cfg, chatModels: { overrides: [
		{ channelId: 'bili:172195454', provider: 'ds', model: 'bili-model' },
		{ channelId: 'private:875692618', provider: 'ds', model: 'qq-model' }
	] } };
	const gw = gateway(withModels);
	const agent0 = await gw.ensureSession(biliChat('172195454'));
	const selected = [];
	const agent = { id: agent0.id, model: { current: () => ({ provider: 'ds', model: 'default-model' }), select: (s) => selected.push(s) } };
	gw.applyChatModelFor(agent, 'bili:172195454');
	assert.deepEqual(selected, [{ provider: 'ds', model: 'qq-model' }], '共享会话按 QQ 那边配的模型走');
	ok('共享会话的模型跟着主通道（QQ）走，B站 的模型配置不改它');
}

{
	// 8. 同一批消息只开一个会话：两个平台同时进来不会各建一个
	created.length = 0;
	const gw = gateway(cfg);
	const [a, b] = await Promise.all([gw.ensureSession(biliChat('172195454')), gw.ensureSession({ channelId: 'private:875692618', chatType: 'private', targetId: '875692618', title: '' })]);
	assert.equal(a.id, b.id, '两个通道同时来消息也只有一个会话');
	assert.equal(created.length, 1);
	ok('QQ 和 B站 同时进来：只建一个会话');
}

{
	// 9. 主人不用配对应表：B站 主人 UID / 抖音 主人 ID 就是 masterQqUin 那个人
	const gw = gateway({ qq: { enabled: true }, masterQqUin: '5550001', bili: { enabled: true, masterUid: '4242', links: [] }, douyin: { enabled: true, masterName: '主人', masterUid: 'douyin:4242', links: [] } });
	assert.equal(gw.personKeyOf(biliChat('4242')), 'user:5550001');
	assert.equal(gw.personKeyOf({ channelId: 'douyin:主人', chatType: 'private', userId: 'uid:4242' }), 'user:5550001');
	assert.equal(gw.personKeyOf(biliChat('4243')), '', '不是主人、又没配对应表 → 算不出是谁');
	const agent = await gw.ensureSession(biliChat('4242'));
	assert.equal(gw.chatForSession(agent.id).channel_id, 'private:5550001');
	const dw = gateway({ qq: { enabled: true }, masterQqUin: '5550001', bili: { enabled: true, masterUid: '', links: [] }, douyin: { enabled: true, masterUid: 'douyin:4242', links: [] } });
	const da = await dw.ensureSession({ channelId: 'douyin:主人', chatType: 'private', targetId: '主人', title: '', userId: 'uid:4242' });
	assert.equal(dw.chatForSession(da.id).channel_id, 'private:5550001', '抖音 主人 ID 对上也能并');
	ok('B站 主人 UID / 抖音 主人 ID 都可按已有配置并到 QQ');
}

{
	// 10. 抖音 改了昵称、对应表对不上：**不**退回记忆里查到的关联（昵称可改、没验过，不能拿来并会话）
	db.prepare("INSERT INTO person (canonical_id, qq_uin, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('p-renamed', '12345678', 'uid:7702399256389125000', '新昵称', 'friend', 1, ?, ?)")
		.run(Date.now(), Date.now());
	const gw = gateway(cfg);
	const renamed = { channelId: 'douyin:新昵称', chatType: 'private', targetId: '新昵称', title: '', userId: 'uid:7702399256389125000' };
	assert.equal(gw.personKeyOf(renamed), '', '记忆里的抖音身份不能映射到 QQ');
	const agent = await gw.ensureSession(renamed);
	assert.equal(gw.chatForSession(agent.id).channel_id, 'douyin:新昵称', '没显式配置就不并到 QQ');
	// 认不出是谁就别猜：既没配对应表、记忆里也没这个人
	assert.equal(gw.personKeyOf({ channelId: 'douyin:查无此人', chatType: 'private', targetId: '查无此人', title: '', userId: 'uid:1' }), '');
	ok('没显式配置的抖音身份不并进 QQ（记忆里的关联不作数）');
}

console.log('shared-session ok');
