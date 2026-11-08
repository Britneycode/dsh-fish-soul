/**
 * 抖音私信：认人从「昵称」换成「真实用户 ID」。
 *
 * 为什么要有这个：
 *   以前单聊的 userId 硬编码成会话名（= 抖音昵称），于是「主人是谁」靠昵称比对 ——
 *   主人一改昵称就认不出来，别人起个同名就能冒充。
 *   实测（2026-11-08 真机）：接口路**是给 senderId 的**（如 7702399256389125000），
 *   只有 DOM 路没有。所以能稳就稳。
 *
 * 契约：
 *   ① 有 senderId → userId = `uid:<id>`（跟群聊那条路的格式一致，不拆人）
 *   ② 没 senderId（DOM 路）→ 退回会话名，不能崩
 *   ③ channelId 仍然按会话名 —— 出口靠它找会话，不能跟着变成 ID
 *   ④ 改名后仍然是同一个人（这是本次改动的核心收益）
 *   ⑤ 老库里的昵称键能平滑迁到 ID 键，记忆不丢、不新增一行
 */
import assert from 'node:assert/strict';

// ⚠️ 每组用独立的 DSH_HOME：openDatabase() 会复用同一个 soul.db，
//    共用一个库时前一组建的 person 行会漏进后一组（第 ④ 组建了同名 ID，
//    第 ⑤ 组的「迁移前新键必须查不到」就不成立了）。
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

const msg = (extra = {}) => ({
	fromMe: false, system: false, unsupported: false,
	type: 'text', text: '你好', kind: 7, time: Date.now(),
	...extra
});

// ── ① 有 senderId → 用 uid:<id> ──
{
	const n = normalizeDouyinMessage(msg({ senderId: '7702399256389125000' }), {
		name: '未云', timeMs: Date.now(), messageId: 'm1'
	});
	assert.equal(n.userId, 'uid:7702399256389125000', '有 senderId 就用 ID');
	assert.equal(n.peerName, '未云', '会话名单独留着');
	assert.equal(n.channelId, 'douyin:未云', 'channelId 必须还是会话名（出口靠它找人）');
	ok('有 senderId → userId=uid:<id>，channelId 仍是会话名');
}

// ── ② 没有 senderId → 退回会话名 ──
{
	const n = normalizeDouyinMessage(msg(), { name: '未云', timeMs: Date.now(), messageId: 'm2' });
	assert.equal(n.userId, '未云', 'DOM 路没有 senderId，退回名字');
	assert.equal(n.peerName, '未云');
	ok('没有 senderId → 退回会话名，不崩');
}

// ── ③ 群聊现状（有昵称就用昵称；这跟私信的新策略不同，如实记下来）──
{
	const n = normalizeDouyinMessage(msg({ senderId: '123456789', senderName: '群友' }), {
		name: '某个群', timeMs: Date.now(), messageId: 'm3',
		group: true, members: { '123456789': '群友' }
	});
	assert.equal(n.userId, '群友', '群聊有昵称时用昵称');
	assert.match(n.channelId, /^douyin-group:/, '群聊 channelId 是 douyin-group:');

	// 只有 ID、没有昵称时才用 uid: 前缀
	const n2 = normalizeDouyinMessage(msg({ senderId: '123456789' }), {
		name: '某个群', timeMs: Date.now(), messageId: 'm4',
		group: true, members: {}
	});
	assert.equal(n2.userId, 'uid:123456789', '群聊没有昵称时退回 uid:<id>');

	// ⚠️ 已知不一致：群聊「有昵称→用昵称」，私信「有 ID→用 ID」。
	//    后果：同一个人在群里（按昵称）和私信里（按 ID）会分成两条 person 行。
	//    这是**故意保留的**：群聊那条路的语义是「按人分开攒话」，
	//    贸然改会让现有群的发言记录全部对不上人。留给后续单独处理。
	ok('群聊：有昵称用昵称、无昵称退回 uid:<id>（与私信策略不同，已知且有意）');
}

// ── ④ 改名后仍是同一个人（核心收益）──
{
	tmpHome('rename');
	const db = openDatabase();
	const { resolveOrCreatePlatformPerson } = await import('../lib/db.js');
	const ID = 'uid:7702399256389125000';

	// 第一次：叫「未云」
	const a = resolveOrCreatePlatformPerson(db, {
		platform: 'douyin', platformId: ID, nickname: '未云', nowMs: 1000
	});
	assert.ok(a !== null, '第一次要建出人来');

	// 改名成「鱼鱼鱼」后再来 —— 同一个 ID，必须是同一行
	const b = resolveOrCreatePlatformPerson(db, {
		platform: 'douyin', platformId: ID, nickname: '鱼鱼鱼', nowMs: 2000
	});
	assert.equal(b.canonical_id, a.canonical_id, '改名后必须是同一个人（不能新建一行）');
	assert.equal(b.display_name, '鱼鱼鱼', '名字要跟着更新');

	const rows = db.prepare("SELECT * FROM person WHERE douyin_uid = ?").all(ID);
	assert.equal(rows.length, 1, '同一个 ID 只能有一行');
	ok('改名后仍是同一行 —— 这是改成 ID 绑定最大的收益');
}

// ── ⑤ 老昵称键平滑迁到 ID 键 ──
{
	tmpHome('migrate');
	// 模拟老库：douyin_uid 存的是昵称「未云」，而且还挂着主人身份
	const db = openDatabase();
	db.prepare(`INSERT INTO person (canonical_id, qq_uin, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('master', '3630958828', '未云', '未云', 'close', 5, 1, 1)`).run();
	db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
		VALUES ('feiyu', 'user:master', 'douyin', 'douyin:未云', 'fact', '主人喜欢喝冰美式', '', 3, 0, '', 1, 1, 'active')`).run();

	// 老键查得到
	assert.ok(findPersonByDouyin(db, '未云') !== null, '老昵称键能查到人');

	// 迁移逻辑（跟 resolveDouyinPerson 里那段一致）：新键没人用就搬过去
	const NEW_ID = 'uid:7702399256389125000';
	const byOld = findPersonByDouyin(db, '未云');
	const byNew = findPersonByDouyin(db, NEW_ID);
	assert.ok(byOld !== null && byNew === null, '迁移前：老键有、新键无');
	db.prepare('UPDATE person SET douyin_uid = ? WHERE canonical_id = ?').run(NEW_ID, byOld.canonical_id);

	// 迁移后：新键能找到人，而且是 master 那行
	const migrated = findPersonByDouyin(db, NEW_ID);
	assert.ok(migrated !== null, '迁移后新键能查到');
	assert.equal(migrated.canonical_id, 'master', '主人身份没丢');
	assert.equal(findPersonByDouyin(db, '未云'), null, '老键已经让位');

	// 记忆还在，owner 没变
	const mem = db.prepare("SELECT * FROM memory WHERE content LIKE '%冰美式%'").get();
	assert.ok(mem !== undefined, '记忆没丢');
	assert.equal(mem.owner_id, 'user:master', '记忆还挂在主人身上');
	ok('老昵称键 → ID 键：主人身份和记忆都不丢');
}

// ── ⑥ 上层判定用的是会话名（不能跟着变成 uid:）──
{
	const { readFileSync } = await import('node:fs');
	const gw = readFileSync(new URL('../lib/gateway-media.js', import.meta.url), 'utf8');
	// 主人 / 白名单 / 找会话 都必须是 peer（会话名），不是 m.userId
	assert.match(gw, /const peer = m\.peerName \|\| m\.userId/, '要取出会话名');
	assert.match(gw, /peer === cfg\.masterName/, '判主人要按会话名');
	assert.match(gw, /cfg\.allowList\.includes\(peer\)/, '白名单要按会话名');
	assert.match(gw, /this\.douyinLinks\(\)\.get\(peer\)/, '「抖音名=QQ号」对照要按会话名');
	ok('上层：判主人 / 白名单 / 对照表都用会话名，只有认人用 ID');
}

console.log('\ndouyin-uid-binding ok');
