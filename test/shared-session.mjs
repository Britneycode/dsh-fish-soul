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
	douyin: { enabled: true, masterName: '主人', links: ['douyin:7702399256389125000=12345678'] }
};

/** douyinUinOf 的方法名（打码机制会改文本，所以从原型上取） */
const UIN_OF = 'douyinUinOf';
const uinOf = (gw, chat) => gw[UIN_OF](chat);

const biliChat = (uid) => ({ channelId: `bili:${uid}`, chatType: 'private', targetId: uid, title: '某人的昵称' });

{
	// 11. 🔴 安全边界：昵称**不是**身份 —— 改个名字不能并进别人的 QQ 会话
	//
	//     并会话 = 同一个 session（同一份记忆 + 同一个模型上下文），
	//     所以身份键只能是「对方改不了的东西」（数字 uid）。
	//
	//     这条用**真正的攻击姿势**：对应表里配的是数字 uid，
	//     冒充者把自己的抖音昵称改成那个数字（channelId 的冒号后段就是昵称）。
	//     旧实现把昵称也放进 keys ⇒ 冒充成立；修好后必须挡住。
	const TARGET_UID = '7702399256389125000';
	// 用**裸昵称**配置复现（这正是 PR96 的写法：`links: ['小鱼干=12345678']`）。
	// 配成 `douyin:<uid>` 时旧正则会把前缀一起吃进左值，反而撞不上 —— 别用那种配置测。
	const gw = gateway({ ...cfg, douyin: { ...cfg.douyin, links: [`小鱼干=12345678`] } });

	// ① 冒充：昵称叫「小鱼干」，而真实 uid 是 9999999999（正在冒充成那个昵称）
	//    → 发一条候选挂出来；**冒充者也先不并**，只是出一个候选。
	//    主人一看「uid 不对」**就不点确认**——什么都不发生；冒名顶替者再改昵称也无所谓。
	const fake = { channelId: 'douyin:小鱼干', chatType: 'private', targetId: '小鱼干', userId: 'uid:9999999999' };
	assert.equal(uinOf(gw, fake), '', '冒充者也先不并——只是挂出一条候选');
	assert.equal(gw.douyinUinBinding('9999999999'), '', '没确认之前什么都不写绑定');
	const cand = gw.douyinUinCandidates();
	assert.equal(cand.length, 1, '这条候选是「疑似被冒认」的，主人看一眼 uid 就知道不对');
	assert.equal(cand[0].uid, '9999999999', '候选换成冒充者的 uid（因为他那条是最后的）');
	assert.equal(gw.douyinUinCandidates().length, 1, '这条候选挂着，没确认也没清—— 不主动动它');

	// ② 换成正确的 uid 再多试一次：那条换成他的，主人再点确认
	const real = { channelId: 'douyin:小鱼干', chatType: 'private', targetId: '小鱼干', userId: `uid:${TARGET_UID}` };
	assert.equal(uinOf(gw, real), '', '换成正确的 uid —— 也先不并（还有上一条候选）');
	assert.equal(gw.douyinUinCandidates()[0].uid, TARGET_UID, '换了正确的 uid 之后，候选换成他的');
	assert.deepEqual(gw.confirmDouyinUin('小鱼干'), { ok: true, uid: TARGET_UID, qq: '12345678' }, '主人再点确认 → 绑定');
	assert.equal(gw.douyinUinBinding(TARGET_UID), '12345678');

	// ③ 冒充者再撞：uid 不是已绑的 → 这趟根本不到「配置」那条线，什么都没有发生
	assert.equal(uinOf(gw, fake), '', 'uid 不同 → 没连接那套候选（列表人里uid不匹配，且未掄定）');
	assert.equal(gw.douyinUinBinding('9999999999'), '', '冒充者换 uid 都绑不上');

	// ④ 昵称改叫「小明」→ 跟着看它（就是同款 uid）：不影响
	const renamed = uinOf(gw, { channelId: 'douyin:小明', chatType: 'private', targetId: '小明', userId: `uid:${TARGET_UID}` });
	assert.equal(renamed, '12345678', '改昵称不掉线（绑定只看 uid，一度确认过就行）');

	// ⑤ 对照（正面）：uid 真对得上 → 并进去（说明不是「一律不并」把功能做废了）
	const gw2 = gateway({ ...cfg, douyin: { ...cfg.douyin, links: [`${TARGET_UID}=12345678`] } });
	const real2 = { channelId: 'douyin:随便什么名字', chatType: 'private', targetId: '随便什么名字', title: '', userId: `uid:${TARGET_UID}` };
	assert.equal(gw2.personKeyOf(real2), 'user:12345678', 'uid 对上就该并 —— 昵称是什么无所谓');
	const realAgent = await gw2.ensureSession(real2);
	assert.equal(gw2.chatForSession(realAgent.id).channel_id, 'private:12345678');
	ok('昵称冒充挡得住：昵称写成目标 uid 也并不进别人的会话');

	// ② 主人身份同理：昵称叫「主人」/ 昵称写成主人 uid，但自己的 uid 不对 → 不算主人
	const fakeMaster = { channelId: 'douyin:主人', chatType: 'private', targetId: '主人', title: '', userId: 'uid:8888888888' };
	assert.equal(gw.personKeyOf(fakeMaster), '', '昵称叫「主人」不等于就是主人');
	const fakeMaster2 = { channelId: 'douyin:4242', chatType: 'private', targetId: '4242', title: '', userId: 'uid:8888888888' };
	assert.equal(gw.personKeyOf(fakeMaster2), '', '昵称写成主人 uid 也不算主人');
	ok('昵称叫「主人」/ 写成主人 uid 都不会被认成主人');
}

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
	// 2. 抖音 配了「数字 uid = QQ 号」对应表：并进对应的那个 QQ 会话
	const gw = gateway(cfg);
	const agent = await gw.ensureSession({ channelId: 'douyin:小鱼干', chatType: 'private', targetId: '小鱼干', title: '', userId: 'douyin:7702399256389125000' });
	assert.equal(gw.chatForSession(agent.id).channel_id, 'private:12345678');
	assert.equal(findChatSession(db, 'douyin', 'douyin:小鱼干'), null, '抖音 不该再单开一个会话');
	ok('抖音 配了 uid 对应表 → 并进对应的 QQ 私聊会话');
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
	db.prepare("INSERT INTO person (canonical_id, qq_uin, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('p-renamed', '12345678', 'uid:6666666666666666', '新昵称', 'friend', 1, ?, ?)")
		.run(Date.now(), Date.now());
	const gw = gateway(cfg);
	const renamed = { channelId: 'douyin:新昵称', chatType: 'private', targetId: '新昵称', title: '', userId: 'uid:6666666666666666' };
	assert.equal(gw.personKeyOf(renamed), '', '记忆里的抖音身份不能映射到 QQ');
	const agent = await gw.ensureSession(renamed);
	assert.equal(gw.chatForSession(agent.id).channel_id, 'douyin:新昵称', '没显式配置就不并到 QQ');
	// 认不出是谁就别猜：既没配对应表、记忆里也没这个人
	assert.equal(gw.personKeyOf({ channelId: 'douyin:查无此人', chatType: 'private', targetId: '查无此人', title: '', userId: 'uid:1' }), '');
	ok('没显式配置的抖音身份不并进 QQ（记忆里的关联不作数）');
}

{
	// 12. 只有 channelId（没有 userId）时，从**游标**反查真实 uid
	//
	// 为什么必须支持：`lib/index.js` 的工具 guard 只拿得到 channelId
	// （`gateway[UIN_OF]({ channelId })`）。不反查的话，
	// 「抖音并进主人 QQ 后可用聊天工具」这个功能会永远被拦（等于白做）。
	//
	// 反查来源必须是**真实 uid**（游标里的 identity 是用会话 ID 推出来的），
	// 不能退回昵称 —— 那正是冒充洞。
	const { createHash } = await import('node:crypto');
	const gw = gateway({ ...cfg, masterQqUin: '5550001', bili: { enabled: false, links: [] }, douyin: { enabled: true, masterUid: '', links: [] } });
	const name = '某人';
	const convKey = `douyin.conv.${createHash('sha1').update(name).digest('hex').slice(0, 16)}`;
	db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(convKey, JSON.stringify({
		name, convId: '0:1:5550001:7702399256389125000', identity: 'douyin:7702399256389125000', readAt: Date.now(),
	}));
	// 只给 channelId（模拟工具 guard 的调用姿势）
	assert.equal(gw.douyinIdentityOfChannel(`douyin:${name}`), 'douyin:7702399256389125000', '游标里的 identity 是真实 uid，要能反查出来');
	// 游标里的 name 是昵称 —— 不能拿它当身份
	assert.equal(gw.douyinIdentityOfChannel('douyin:没这个会话'), '', '查不到就返回空，不猜');
	// 游标里 identity 是脏的（昵称 / 老格式）→ 不认
	db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(
		`douyin.conv.${createHash('sha1').update('脏的').digest('hex').slice(0, 16)}`,
		JSON.stringify({ name: '脏的', identity: '脏的', readAt: Date.now() }),
	);
	assert.equal(gw.douyinIdentityOfChannel('douyin:脏的'), '', '游标里 identity 不是 douyin:<数字uid> 就不认');

	// 🔴 关键：`UIN_OF` **必须真的用到**这个反查。
	//    只测 douyinIdentityOfChannel 是「纯函数绿」，证明不了接线 —— 这条才是接线断言。
	const gwMaster = gateway({ ...cfg, masterQqUin: '5550001', bili: { enabled: false, links: [] }, douyin: { enabled: true, masterUid: 'douyin:7702399256389125000', links: [] } });
	assert.equal(
		uinOf(gwMaster, { channelId: `douyin:${name}` }),   // 只给 channelId，没有 userId
		'5550001',
		'UIN_OF 必须用游标反查出的 uid 判主人（工具 guard 只传 channelId）',
	);
	// 反查出的 uid 不是主人 → 仍然不并
	assert.equal(uinOf(gwMaster, { channelId: 'douyin:脏的' }), '', '反查不到/不是主人 → 不并');
	ok('只有 channelId 时能从游标反查真实 uid（工具 guard 要用）');
}

{
	// 13. 昵称配置（主人的真实写法）+ 二次确认：保留配置，但挡住冒充
	//
	// 真机配置就是 `未云=3630958828` 这种**昵称**格式。完全禁掉会让主人白配一次；
	// 完全放行就是 PR #96 的冒充洞。折中：昵称只用来**定位**，
	// 授权必须有「已确认的事实」—— person 表里这行同时有 douyin_uid + qq_uin。
	const { createHash } = await import('node:crypto');
	const name = '小鱼干';
	// ⚠️ 必须跟第 11 条用**不同的 uid**：这个测试文件共用同一个 db，
	//    第 11 条已经把这个 uid 绑过了，复用会读到那边的绑定（不是本节在测的东西）。
	const uid = '1111222233334444';
	const qq = '12345678';
	const gw = gateway({ ...cfg, masterQqUin: '5550001', bili: { enabled: false, links: [] }, douyin: { enabled: true, masterUid: '', links: [`${name}=${qq}`] } });
	const chat = (u, n = name) => ({ channelId: `douyin:${n}`, chatType: 'private', targetId: n, title: '', userId: `uid:${u}` });

	// ① 第一次见「昵称匹配 + uid 拿得到」→ **不并**，只是把这个候选挂出来等确认。
	//    冒充者占不掉 uid：他只能把别人的昵称撞进来，然后 uid 不同——候选都不弹。
	assert.equal(uinOf(gw, chat(uid)), '', '第一次见到昵称匹配 + uid 拿得到 → 先不并，等确认');

	// ② 主人看到的是候选，不是已并
	const cand = gw.douyinUinCandidates();
	assert.equal(cand.length, 1, '候选要挂出来给主人看（不是已并，也还没绑）');
	assert.equal(cand[0].uid, uid);
	assert.equal(cand[0].qq, qq);
	assert.equal(cand[0].name, name);
	assert.equal(gw.douyinUinBinding(uid), '', '候选不是绑定 —— 主人没点确认之前，绝不该写');

	// ③ 冒充者（昵称一样，uid 是别人的）也来一条 —— 用**独立**的 gw，
	//    免得它的候选盖掉上面那条（真实场景里主人看到的是「最新的那条」，
	//    如果被冒充者盖掉了，主人看 uid 不对就不点 —— 那是人的判断，不是代码的）。
	// ⚠️ 用**不同的昵称**：候选是按昵称存 kv 的（`douyin.uinCandidate.<昵称>`），
	//    同昵称会覆盖上面那条，后面的 confirm 就确认到冒充者身上了。
	const gwImp = gateway({ ...cfg, masterQqUin: '5550001', bili: { enabled: false, links: [] }, douyin: { enabled: true, masterUid: '', links: [`冒充用=9999999999`] } });
	assert.equal(uinOf(gwImp, chat('9999999999', '冒充用')), '', '冒充者也不并（候选只挂出来）');
	const candImp = gwImp.douyinUinCandidates().filter((c) => c.name === '冒充用');
	assert.equal(candImp.length, 1);
	assert.equal(candImp[0].uid, '9999999999', '候选是冒充者的 uid —— 主人一眼能看出不对');
	// 主人不点 → 什么都没绑
	assert.equal(gwImp.douyinUinBinding('9999999999'), '', '不点确认 = 不绑');

	// ④ 回到正确的那个 gw：主人点「确认」→ 绑定
	assert.deepEqual(gw.confirmDouyinUin(name), { ok: true, uid, qq }, '主人点确认 → 写进绑定表');
	assert.equal(gw.douyinUinBinding(uid), qq);
	// 这条候选清了（别留着误导）；别的昵称的候选还在（那是别人的，不是这条的）
	assert.equal(gw.douyinUinCandidates().filter((c) => c.name === name).length, 0, '确认过的候选要清掉');

	// ⑤ 绑定之后：原来是它 → 并；昵称改了不掉线；冒充者再改昵称都不发生
	const bound = uinOf(gw, chat(uid));
	assert.equal(bound, qq, '绑定之后原来是它 → 并');
	const renamed = uinOf(gw, chat(uid, '小明'));
	assert.equal(renamed, qq, '改昵称不掉线（绑定只看 uid）');
	const imp2 = uinOf(gw, chat('9999999999'));
	assert.equal(imp2, '', '冒名顶替者来也不动（uid 不是已绑的）');

	// ⑥ 主人要清掉错配的候选（比如改主意了）
	const gw2 = gateway({ ...cfg, masterQqUin: '5550001', bili: { enabled: false, links: [] }, douyin: { enabled: true, masterUid: '', links: [`${name}=${qq}`] } });
	// 第一次见又发一条候选（这个 uid 再没绑过）
	assert.equal(uinOf(gw2, chat('8888888888')), '', '新的候选也先不并');
	assert.equal(gw2.douyinUinCandidates().filter((c) => c.name === name).length, 1, '这个昵称又挂出一条候选');
	gw2.dismissDouyinUinCandidate(name);
	assert.equal(gw2.douyinUinCandidates().filter((c) => c.name === name).length, 0, '主动清掉候选');

	ok('昵称配置 + 确认绑定：候选先不并，点确认才绑；冒充者 uid 不同绑不上');
}

console.log('shared-session ok');
