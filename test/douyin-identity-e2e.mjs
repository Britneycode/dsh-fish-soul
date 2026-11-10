// 抖音私信端到端：会话身份 → 认人 → 授权 → 发送目标。
//
// 这条测的是「修复后私信真的能用，且只用身份授权」，不是某个函数对不对。
// 走的是真实 ChatGateway 的入站处理 + 真实 DouyinChannel 的发送闸门。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('douyin-identity-e2e-');
const { openDatabase, getKv } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');

const SELF = '900001';
const MASTER = '7702399256389125000';   // 主人的抖音 uid
const STRANGER = '1234567890123456789'; // 陌生人
const conv = (peer) => `0:1:${SELF}:${peer}`;

/** 造一套真实的网关 + 通道（只有浏览器驱动是假的）。 */
function makeWorld({ masterUid = `douyin:${MASTER}`, allowList = [], replyAll = false } = {}) {
	const db = openDatabase();
	const sent = [];
	const followups = [];
	const config = {
		qq: { enabled: true }, masterQqUin: '123',
		douyin: { enabled: true, autoReply: true, masterUid, masterName: '未云', allowList, replyAll, replyLink: false }
	};
	const douyin = {
		connected: true,
		send: async (name, parts, convId) => {
			sent.push({ name, parts, convId });
			return { ok: true, delivered: true, parts: parts.map((p) => ({ type: p.type, ok: true, delivered: true })) };
		},
		inbox: { settle: () => {} }
	};
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() }, getConfig: () => config,
		log: () => {}, channel: { connected: true }, douyin,
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	return { db, gw, sent, followups };
}

const inbound = (peer, { nickname = '未云', text = '在吗', convId } = {}) => ({
	channel: 'douyin', chatType: 'private',
	channelId: `douyin:${nickname}`,
	targetId: nickname,
	groupId: null,
	userId: `douyin:${peer}`,
	nickname, peerName: nickname,
	convId: convId ?? conv(peer),
	messageId: `m-${peer}-${Math.random()}`,
	mentioned: true, replyId: null, text, images: [], links: [], timeMs: Date.now()
});

test('主人按会话身份认出来（不是靠昵称）', async () => {
	const { db, gw } = makeWorld();
	const r = await gw.onDouyinMessage(inbound(MASTER));
	assert.equal(r.review, '已交给模型', '主人身份 → 正常处理');
	const row = db.prepare("SELECT * FROM person WHERE douyin_uid = ?").get(`douyin:${MASTER}`);
	assert.ok(row, '按身份建出了 person 行');
	assert.equal(row.canonical_id, 'master', '对上的就是主人');
	db.close();
});

test('同名冒充挡得住：昵称一样、身份不同 → 不是主人', async () => {
	const { db, gw } = makeWorld();
	const r = await gw.onDouyinMessage(inbound(STRANGER, { nickname: '未云' }));
	assert.equal(r.review, '只记不回', '陌生人不回');
	assert.equal(gw.isMasterChannel(`douyin:未云`), false);
	const stranger = db.prepare("SELECT * FROM person WHERE douyin_uid = ?").get(`douyin:${STRANGER}`);
	assert.ok(stranger, '陌生人也有自己的行');
	assert.notEqual(stranger.canonical_id, 'master', '名字一样也绝不能是主人');
	db.close();
});

test('白名单按身份，不按昵称', async () => {
	// 白名单里放的是身份键
	{
		const { db, gw } = makeWorld({ allowList: [`douyin:${STRANGER}`] });
		assert.equal((await gw.onDouyinMessage(inbound(STRANGER, { nickname: '路人甲' }))).review, '已交给模型', '身份在白名单 → 回');
		db.close();
	}
	// 白名单里放昵称不算数（旧配置不会因此生效）
	{
		const { db, gw } = makeWorld({ allowList: ['未云'] });
		assert.equal((await gw.onDouyinMessage(inbound(STRANGER, { nickname: '未云' }))).review, '只记不回', '昵称在白名单不算授权');
		db.close();
	}
});

test('主人身份填错（写成昵称）→ 谁都不是主人，不会误授权', async () => {
	const { db, gw } = makeWorld({ masterUid: '未云' });
	assert.equal((await gw.onDouyinMessage(inbound(MASTER))).review, '只记不回', '主人身份不是合法身份键 → 不授权');
	db.close();
});

test('身份键写进 kv，转达时能反查出目标会话 ID', async () => {
	const db = openDatabase();
	const ch = new DouyinChannel({
		db, host: { running: true, loggedIn: true, exclusive: async (_l, fn) => await fn() },
		typingMs: [1, 1], getConfig: () => ({}),
		driver: {
			read: async () => ({
				ok: true, convId: conv(MASTER),
				messages: [{ fromMe: false, seq: '1', text: '在吗', time: Date.now(), senderId: MASTER, convId: conv(MASTER) }]
			}),
			sendText: async () => ({ ok: true, verified: true }),
		},
		onMessage: async () => ({ done: true })
	});
	await ch.readConversation({ c: { time: '' }, name: '未云', key: 'e2e-conv', st: null, sig: '1', unread: true });
	assert.equal(getKv(db, `douyin.convId.douyin:${MASTER}`, ''), conv(MASTER), '会话身份 → 会话 ID 记下来了');

	// 转达：拿这个 ID 才发得出去
	const { gw } = makeWorld();
	gw.db = db;
	gw.douyin = { connected: true, send: async (name, parts, convId) => ({ ok: true, delivered: true, parts: [{ type: 'text', ok: true, delivered: true }] }) };
	const r = await gw.relayTo('douyin', '替我说一句');
	assert.equal(r.ok, true, '记下会话 ID 之后转达能发出去');
	db.close();
});

test('没有会话 ID 的会话：不发送，并说清原因', async () => {
	// ⚠️ 不能靠改 DSH_HOME 来要一个空库：openDatabase() 在模块加载时就定了路径。
	// 直接用一个干净的 :memory: 库，保证 kv 里确实没有会话 ID。
	const { DatabaseSync } = await import('node:sqlite');
	const fresh = new DatabaseSync(':memory:');
	const { OUTBOX_SQL } = await import('../lib/outbox.js');
	fresh.exec(OUTBOX_SQL);
	// kv 表是 gateway 用到的（masterDouyinConvId 会读）
	fresh.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	const { gw } = makeWorld();
	gw.db = fresh;
	let called = false;
	gw.douyin = { connected: true, send: async () => { called = true; return { ok: true, delivered: true, parts: [] }; } };
	const r = await gw.relayTo('douyin', '替我说一句');
	assert.equal(r.ok, false, '认不出会话就不发');
	assert.equal(called, false, '一个字都没发出去');
	assert.match(r.reason, /认不出你抖音那个会话/, '要说明是认不出会话，不是笼统失败');
	fresh.close();
});

test.after(() => { process.env.DSH_HOME = home; });
