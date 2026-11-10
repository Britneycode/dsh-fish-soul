/**
 * 抖音私信：认人从「昵称」换成「会话身份」。
 *
 * 演进史（三个方案，后一个推翻前一个，留在这里免得走回头路）：
 *   ① 最初：`userId = 会话名`（= 抖音昵称）。主人改名就认不出，别人起同名就能冒充。
 *   ② 中间：改用单条消息的 `senderId`。比昵称强，但**无法证明它属于当前会话** ——
 *      切会话时抓到的响应可能属于别的会话，于是「这条消息的发送者」和
 *      「我正要回复的那个人」可以是两个人。所以整条私信链路被停用过。
 *   ③ 现在：用**会话 ID**（`0:1:<我方uid>:<对方uid>`）。它自带双方 uid，
 *      平台在每条消息上都给，所以「这条消息属于哪个会话、对方是谁」可以独立确认。
 *      昵称和单条 senderId 都只作展示/辅助，不再参与授权。
 *
 * 契约：
 *   ① 有会话 ID 且能推出对端 → userId = `douyin:<对方uid>`（稳定，与昵称无关）
 *   ② 没有会话 ID / 推不出对端 → 返回 null（不猜，上层隔离）
 *   ③ channelId 仍然按会话名 —— 出口靠它找会话，不能跟着变成 ID
 *   ④ 改名后仍是同一个人（核心收益）
 *   ⑤ 旧昵称记录不被自动迁移，也不授予主人权限
 */
import assert from 'node:assert/strict';

// ⚠️ 每组用独立的 DSH_HOME：openDatabase() 会复用同一个 soul.db，
//    共用一个库时前一组建的 person 行会漏进后一组。
let seq = 0;
const tmpHome = (tag) => {
	const dir = `${process.env.TEMP || '/tmp'}/fish-soul-test-dyuid-${tag}-${process.pid}-${Date.now()}-${seq++}`;
	process.env.DSH_HOME = dir;
	return dir;
};
tmpHome('init');

const { normalizeDouyinMessage } = await import('../lib/channels/douyin.js');
const { openDatabase, findPersonByDouyin } = await import('../lib/db.js');

const ok = (msg) => console.log(`✓ ${msg}`);

const SELF = '7702399256389125000';
const PEER = '1234567890123456789';
const CONV = `0:1:${SELF}:${PEER}`;

const msg = (extra = {}) => ({
	fromMe: false, system: false, unsupported: false,
	type: 'text', text: '你好', kind: 7, time: Date.now(),
	...extra
});

// ── ① 有会话 ID → 用会话身份 ──
{
	const n = normalizeDouyinMessage(msg({ senderId: PEER, convId: CONV }), {
		name: '未云', timeMs: Date.now(), messageId: 'm1', identity: `douyin:${PEER}`, convId: CONV
	});
	assert.equal(n.userId, `douyin:${PEER}`, '认人用会话身份（对方 uid）');
	assert.equal(n.peerName, '未云', '会话名单独留着');
	assert.equal(n.convId, CONV, '会话 ID 要带出去，发送前靠它校验目标');
	assert.equal(n.channelId, 'douyin:未云', 'channelId 必须还是会话名（出口靠它找人）');
	ok('有会话 ID → userId=douyin:<对方uid>，channelId 仍是会话名');
}

// ── ② 没有会话 ID → 不猜（旧方案在这里会退回昵称/单条 senderId）──
{
	assert.equal(normalizeDouyinMessage(msg(), { name: '未云', timeMs: Date.now(), messageId: 'm2' }), null,
		'没有会话 ID 就返回 null，不退回昵称');
	assert.equal(normalizeDouyinMessage(msg({ senderId: PEER }), { name: '未云', timeMs: Date.now(), messageId: 'm3' }), null,
		'只有单条 senderId 也不够 —— 它证明不了属于当前会话');
	ok('没有会话 ID → 返回 null（不退回昵称，也不信单条 senderId）');
}

// ── ③ 群聊现状（有昵称就用昵称；与私信策略不同，如实记下来）──
{
	const n = normalizeDouyinMessage(msg({ senderId: '123456789', senderName: '群友' }), {
		name: '某个群', timeMs: Date.now(), messageId: 'm3',
		group: true, members: { '123456789': '群友' }
	});
	assert.equal(n.userId, '群友', '群聊有昵称时用昵称');
	assert.match(n.channelId, /^douyin-group:/, '群聊 channelId 是 douyin-group:');

	const n2 = normalizeDouyinMessage(msg({ senderId: '123456789' }), {
		name: '某个群', timeMs: Date.now(), messageId: 'm4',
		group: true, members: {}
	});
	assert.equal(n2.userId, 'uid:123456789', '群聊没有昵称时退回 uid:<id>');

	// ⚠️ 已知不一致：群聊「有昵称→用昵称」，私信「用会话身份」。
	//    后果：同一个人在群里和私信里会分成两条 person 行。
	//    这是**故意保留的**：群聊那条路的语义是「按人分开攒话」，
	//    贸然改会让现有群的发言记录全部对不上人。留给后续单独处理。
	ok('群聊：有昵称用昵称、无昵称退回 uid:<id>（与私信策略不同，已知且有意）');
}

// ── ④ 改名后仍是同一个人（核心收益）──
{
	tmpHome('rename');
	const db = openDatabase();
	const { resolveOrCreatePlatformPerson } = await import('../lib/db.js');
	const ID = `douyin:${PEER}`;

	// 第一次：叫「未云」
	const a = resolveOrCreatePlatformPerson(db, {
		platform: 'douyin', platformId: ID, nickname: '未云', nowMs: 1000
	});
	assert.ok(a !== null, '第一次要建出人来');

	// 改名成「鱼鱼鱼」后再来 —— 同一个身份键，必须是同一行
	const b = resolveOrCreatePlatformPerson(db, {
		platform: 'douyin', platformId: ID, nickname: '鱼鱼鱼', nowMs: 2000
	});
	assert.equal(b.canonical_id, a.canonical_id, '改名后必须是同一个人（不能新建一行）');
	assert.equal(b.display_name, '鱼鱼鱼', '名字要跟着更新');

	const rows = db.prepare("SELECT * FROM person WHERE douyin_uid = ?").all(ID);
	assert.equal(rows.length, 1, '同一个身份键只能有一行');
	ok('改名后仍是同一行 —— 这是身份绑定最大的收益');
}

// 同名冒充：两个人用同一个昵称，但会话 ID 不同 → 必须是两个人
{
	tmpHome('same-name');
	const db = openDatabase();
	const { resolveOrCreatePlatformPerson } = await import('../lib/db.js');
	const A = 'douyin:111', B = 'douyin:222';
	const a = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: A, nickname: '未云', nowMs: 1000 });
	const b = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: B, nickname: '未云', nowMs: 2000 });
	assert.notEqual(a.canonical_id, b.canonical_id, '同名不同 ID 必须是两个人');
	ok('同名冒充挡得住：昵称相同、会话身份不同 → 两个人');
}

// 昵称不能安全迁移成身份：上层必须隔离，旧记录原样保留。
{
	tmpHome('no-migrate'); const db = openDatabase();
	db.prepare("INSERT INTO person (canonical_id, qq_uin, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('master','123','未云','未云','close',5,1,1)").run();
	const { ChatGateway } = await import('../lib/gateway.js');
	const gw = new ChatGateway({ ctx: { get: () => undefined }, db, clock: { now: () => Date.now() }, getConfig: () => ({ masterQqUin: '123', douyin: { masterName: '未云', links: ['未云=123'] } }), log: () => {}, channel: {}, soul: {} });
	// 昵称仍是「未云」、但身份键是 douyin:<uid> → 不能因为名字对上就认主人
	const r = await gw.onDouyinMessage({ channelId: 'douyin:未云', peerName: '未云', userId: `douyin:${PEER}`, convId: CONV });
	assert.ok(r === undefined || !/主人/.test(String(r.review ?? '')), '名字对上不等于主人');
	assert.equal(findPersonByDouyin(db, '未云').canonical_id, 'master', '旧记录原样保留');
	assert.equal(findPersonByDouyin(db, `douyin:${PEER}`), null, '不自动把新身份并进旧记录');
	assert.equal(gw.isMasterChannel('douyin:未云'), false);
	db.close(); ok('旧昵称记录不被自动迁移，也不授予主人权限');
}

console.log('\ndouyin-uid-binding ok');
