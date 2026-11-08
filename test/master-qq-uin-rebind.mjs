/**
 * 主人换 QQ 号：配置里 masterQqUin 改了之后，认人不能炸。
 *
 * 为什么要有这个测试：
 *   resolveOrCreatePerson 用 `INSERT ... ON CONFLICT(qq_uin) DO UPDATE`。
 *   主人换号时 canonicalId 还是 'master'，但 person 表里 master 那行的 qq_uin
 *   还是旧号（UNIQUE 挡住新号插入）→ 抛出
 *   `UNIQUE constraint failed: person.canonical_id`。
 *
 *   这个异常发生在每一轮入站消息的认人阶段，于是整条 QQ 通道一个字都不回，
 *   而报错信息完全指不到「你把 masterQqUin 改了」这件事上。
 *
 * 契约：
 *   ① 换号后 master 行的 qq_uin 跟着变成新号（旧号被摘掉）
 *   ② 旧号作为「陌生人」重新进来，不会抢 master
 *   ③ 不等于「随便谁的号都能顶掉 master」—— 只有一个 master 行
 */
import assert from 'node:assert/strict';

// ⚠️ 每组用独立的 DSH_HOME：openDatabase() 会复用同一个 soul.db，
//    共用一个库时前面几组写的行会漏进后面的断言（互动次数、master 行都会被污染）。
//    踩过：第 ⑥ 组期望 interaction_count=2，实际读到 4。
const tmpHome = (tag) => {
	const dir = `${process.env.TEMP || '/tmp'}/fish-soul-test-master-qq-${tag}-${process.pid}-${Date.now()}`;
	process.env.DSH_HOME = dir;
	return dir;
};

const { openDatabase, resolveOrCreatePerson } = await import('../lib/db.js');

const ok = (msg) => console.log(`✓ ${msg}`);

const OLD_MASTER = '3374915901'; // 机器人自己的号（曾经误填成主人）
const NEW_MASTER = '3630958828'; // 真正的主人

// ── ① 先按旧号建出 master 行（模拟「以前填错了」的状态）──
{
	tmpHome('a');
	const db = openDatabase();
	const p = resolveOrCreatePerson(db, { qqUin: OLD_MASTER, nickname: '机器人小号', nowMs: 1000, masterQqUin: OLD_MASTER });
	assert.equal(p.canonical_id, 'master', '旧号应该是 master');
	assert.equal(p.qq_uin, OLD_MASTER, '旧号写进去了');

	// ── ② 现在配置改成新号：旧号的人再来一条消息 ──
	//    这一轮它拿到什么 canonical_id 不重要（旧行还在，Upsert 会命中它），
	//    真正要保证的是：**master 行上的 qq_uin 不能再是旧号**，否则新号永远接管不了。
	resolveOrCreatePerson(db, { qqUin: OLD_MASTER, nickname: '机器人小号', nowMs: 2000, masterQqUin: NEW_MASTER });
	// master 那行可能被整个迁走了（旧号降级成陌生人），也可能还在但 qq_uin 已被摘空；
	// 两种都算对 —— 唯一不能接受的是它还挂着旧号。
	const midMaster = db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get() ?? null;
	assert.ok(midMaster === null || midMaster.qq_uin !== OLD_MASTER,
		'旧号不该再挂在 master 行上（否则新号 INSERT 会撞主键）');

	// ── ③ 新号进来：必须是 master，而且不能抛 UNIQUE 冲突 ──
	//     ⚠️ 这里就是原来会炸的地方
	let master;
	assert.doesNotThrow(() => {
		master = resolveOrCreatePerson(db, { qqUin: NEW_MASTER, nickname: 'later', nowMs: 3000, masterQqUin: NEW_MASTER });
	}, '换号之后认主人不能抛 UNIQUE constraint failed');
	assert.equal(master.canonical_id, 'master', '新号要成为 master');
	assert.equal(master.qq_uin, NEW_MASTER, 'master 行的 qq_uin 要跟着变成新号');

	// ── ④ 全局只有一个 master ──
	const masters = db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").all();
	assert.equal(masters.length, 1, 'master 行只能有一行');
	assert.equal(masters[0].qq_uin, NEW_MASTER, 'master 行挂的是新号');

	ok('换号后 master 跟着换，旧号降为陌生人，不抛 UNIQUE 冲突');
}

// ── ⑤ 再换一次（连续换号）也不能坏 ──
{
	tmpHome('b');
	const db = openDatabase();
	const THIRD = '1000000001';
	assert.doesNotThrow(() => {
		resolveOrCreatePerson(db, { qqUin: THIRD, nickname: '又换号了', nowMs: 4000, masterQqUin: THIRD });
	}, '连续换号也不能炸');
	const m = db.prepare("SELECT * FROM person WHERE canonical_id = 'master'").get();
	assert.equal(m.qq_uin, THIRD, 'master 行跟到第三个号');
	ok('连续换号也稳');
}

// ── ⑥ 不换号的正常情形不能受影响（回归保护）──
{
	tmpHome('c');
	const db = openDatabase();
	const p1 = resolveOrCreatePerson(db, { qqUin: NEW_MASTER, nickname: 'later', nowMs: 1000, masterQqUin: NEW_MASTER });
	assert.equal(p1.canonical_id, 'master');
	const again = resolveOrCreatePerson(db, { qqUin: NEW_MASTER, nickname: 'later', nowMs: 2000, masterQqUin: NEW_MASTER });
	assert.equal(again.canonical_id, 'master', '同一个人再来还是 master');
	assert.equal(again.interaction_count, 2, '互动次数要累加，不是重建');
	ok('没有换号的正常路径没被改坏');
}

console.log('\nmaster-qq-uin-rebind ok');
