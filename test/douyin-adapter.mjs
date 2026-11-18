/**
 * 抖音适配器（PR2）的白盒测试。
 *
 * 契约测试（douyin-contract.mjs）走网关公开方法证明「行为没变」；
 * 这里补的是「新文件本身对不对」：依赖方向、身份解析的两级规则、适配器与网关的接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-adapter-');
const { openDatabase, setKv } = await import('../lib/db.js');
const { DouyinAdapter, adapterOf } = await import('../lib/douyin-adapter.js');

// ── 依赖方向：适配器不得 import gateway*.js ──────────────────
test('适配器不 import 任何 gateway 模块（依赖只能朝下）', () => {
	const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'douyin-adapter.js'), 'utf8');
	const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
	assert.ok(imports.length > 0, '应该能解析出 import');
	// gateway-util.js 是共享工具（不是网关本体），允许
	const bad = imports.filter((p) => /gateway(-|\.)/.test(p) && !/gateway-util\.js$/.test(p));
	assert.deepEqual(bad, [], `适配器不能反向依赖网关：${bad.join(', ')}`);
});

// ── 身份解析的两级规则 ───────────────────────────────────────
const MASTER_UID = '7000000000000000001';
const PEER_UID = '1234567890123456789';
const CONV = `0:1:900001:${PEER_UID}`;
const convKey = (name) => `douyin.conv.${createHash('sha1').update(String(name)).digest('hex').slice(0, 16)}`;

test('拿不到真实 uid 就返回空串：昵称本身不是身份', async () => {
	const db = openDatabase();
	const ad = new DouyinAdapter({ db, getConfig: () => ({ masterQqUin: '12345678', douyin: { masterName: '未云', links: ['未云=12345678'] } }) });
	// 只有昵称、userId 为空、游标里也没有身份 → 不并会话
	assert.equal(ad.douyinUinOf({ channelId: 'douyin:未云' }), '', '昵称算不出 QQ 号');
	// 有昵称、有配置、但 uid 是昵称形状 → 同样不并
	assert.equal(ad.douyinUinOf({ channelId: 'douyin:未云', userId: '未云' }), '', '昵称形状的 userId 不是身份');
});

test('真实 uid + 主人配置 → 认得出；名字改了也认得出', async () => {
	const db = openDatabase();
	const ad = new DouyinAdapter({ db, getConfig: () => ({ masterQqUin: '12345678', douyin: { masterUid: `douyin:${MASTER_UID}`, masterName: '未云', links: [] } }) });
	assert.equal(ad.douyinUinOf({ channelId: 'douyin:未云', userId: `douyin:${MASTER_UID}` }), '12345678');
	// 改了昵称（channel_id 变了）但 uid 不变 → 靠 userId 认出来
	assert.equal(ad.douyinUinOf({ channelId: 'douyin:改了个名字', userId: `douyin:${MASTER_UID}` }), '12345678');
});

test('昵称匹配只挂候选，不自动绑定（冒充者改名也只能挂候选）', async () => {
	const db = openDatabase();
	setKv(db, 'douyin.uinCandidate.未云', null);
	const ad = new DouyinAdapter({ db, getConfig: () => ({ masterQqUin: '12345678', douyin: { masterName: '未云', masterUid: '', links: ['未云=12345678'] } }) });
	// 冒充者的 uid 与主人不同，但昵称相同 → 挂候选、不并
	assert.equal(ad.douyinUinOf({ channelId: 'douyin:未云', userId: `douyin:${PEER_UID}` }), '', '昵称匹配不自动绑');
	const cands = ad.douyinUinCandidates();
	assert.ok(cands.some((c) => c.name === '未云' && c.uid === PEER_UID), '要挂出候选给主人看');
	// 未确认前，绑定表仍然是空
	assert.equal(ad.douyinUinBinding(PEER_UID), '');
});

test('主人确认之后，绑定表生效且优先于昵称', async () => {
	const db = openDatabase();
	const ad = new DouyinAdapter({ db, getConfig: () => ({ masterQqUin: '12345678', douyin: { masterName: '未云', masterUid: '', links: ['未云=12345678'] } }) });
	ad.bindDouyinUin(PEER_UID, '12345678');
	assert.equal(ad.douyinUinBinding(PEER_UID), '12345678');
	// 昵称改成别的，绑定表照样认
	assert.equal(ad.douyinUinOf({ channelId: 'douyin:随便什么名字', userId: `douyin:${PEER_UID}` }), '12345678');
	// 别的人用同名，uid 不同 → 不进绑定表 → 不并
	assert.equal(ad.douyinUinOf({ channelId: 'douyin:随便什么名字', userId: 'douyin:999999999' }), '');
});

test('会话游标里的身份是唯一可信来源：没有游标就不猜', async () => {
	const db = openDatabase();
	const ad = new DouyinAdapter({ db, getConfig: () => ({ masterQqUin: '12345678', douyin: { masterUid: `douyin:${MASTER_UID}`, links: [] } }) });
	// 没游标 → 空
	assert.equal(ad.douyinIdentityOfChannel('douyin:某人'), '');
	// 只有昵称形状的 identity → 不认
	setKv(db, convKey('某人'), { name: '某人', convId: CONV, identity: '某人' });
	assert.equal(ad.douyinIdentityOfChannel('douyin:某人'), '', '游标里的昵称也不能当身份');
	// 真实 uid 形状 → 认
	setKv(db, convKey('某人'), { name: '某人', convId: CONV, identity: `douyin:${PEER_UID}` });
	assert.equal(ad.douyinIdentityOfChannel('douyin:某人'), `douyin:${PEER_UID}`);
});

// ── verifyInbound：只给结论，不做授权 ───────────────────────
test('verifyInbound：自身回声挡掉、身份键非法挡掉、合法放行', () => {
	const db = openDatabase();
	const ad = new DouyinAdapter({ db, getConfig: () => ({ douyin: {} }) });
	assert.equal(ad.verifyInbound({ userId: `douyin:${PEER_UID}`, senderId: '900001' }, ['900001']).done, true, '自身回声');
	assert.match(ad.verifyInbound({ userId: '未云' }, []).review, /身份/, '昵称身份被挡');
	assert.equal(ad.verifyInbound({ userId: `douyin:${PEER_UID}` }, []).ok, true, '合法身份放行');
	// 明确：verifyInbound 不判 master / 白名单
	assert.equal(ad.verifyInbound({ userId: `douyin:${MASTER_UID}` }, []).identity, `douyin:${MASTER_UID}`, '主人也走同一条放行');
});

// ── 能力声明 ───────────────────────────────────────────────
test('capabilities 只声明能力，不做事', () => {
	const ad = new DouyinAdapter({ getConfig: () => ({}), db: new DatabaseSync(':memory:') });
	assert.deepEqual(ad.capabilities, { proactive: 'share-only', crossPlatformReply: false, hostTools: false });
	assert.equal(ad.platform, 'douyin');
});

// ── 接线：网关构造时真的建了适配器 ─────────────────────────
test('ChatGateway 构造后 douyinAdapter 已就位，且跟着 gw.db 换库', async () => {
	const { ChatGateway } = await import('../lib/gateway.js');
	const db = openDatabase();
	const gw = new ChatGateway({
		ctx: { get: () => undefined }, db, clock: { now: () => Date.now() },
		getConfig: () => ({ masterQqUin: '12345678', douyin: { enabled: true, masterUid: `douyin:${MASTER_UID}` } }),
		log: () => {}, channel: { connected: true },
		soul: { memorizeUnanswered: () => {}, recallInfo: () => ({ memories: [], at: 0, unknown: false }) }
	});
	assert.ok(gw.douyinAdapter instanceof DouyinAdapter, '构造时就建好了');
	// 换库要跟着换（老测试 `gw.db = fresh` 的用法）
	const fresh = new DatabaseSync(':memory:');
	fresh.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	gw.db = fresh;
	assert.equal(await gw.masterDouyinConvId(), '', '换库后读到的是新库（没有会话 ID）');
});

console.log('douyin-adapter ok');
