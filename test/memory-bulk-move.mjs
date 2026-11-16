// 批量「搬给谁」：把勾选 / 符合筛选的记忆搬到另一个人名下（含「她自己」）。
//
// 🔴 搬 owner 会撞上 memory 表的 weekly_protect 触发器（BEFORE UPDATE：owner_id 一变就 ABORT）。
//    所以搬必须走「摘触发器 - 搬 - 按原定义重建」这一套（db.js 的 withoutWeeklyProtect），
//    搬完（含抛错）触发器还得在 —— 周记照样不能被编辑。
//
// 另：派生周记（kind='weekly'）跟其它批量动作一样不许被改，搬 owner 也不能绕过这条。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('memory-bulk-move-');
const { openDatabase } = await import('../lib/db.js');
const { bulkMemory } = await import('../lib/memory-bulk.js');
const { registerRoutes } = await import('../lib/routes.js');

const db = openDatabase();
const clock = { now: () => 1000 };
const worker = { q: [], enqueueRealtime(id) { this.q.push(id); } };
const NOW = 1000;

db.prepare(`INSERT INTO person (canonical_id, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
	VALUES (?, ?, 'stranger', 1, ?, ?)`).run('p_a', '阿甲', NOW, NOW);
db.prepare(`INSERT INTO person (canonical_id, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
	VALUES (?, ?, 'stranger', 1, ?, ?)`).run('p_b', '阿乙', NOW, NOW);

const ins = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
	VALUES ('feiyu', ?, 'qq-private', ?, ?, '', 2, 0, 'manual', ?, ?, 'active')`);
const seed = (owner, kind, content) => Number(ins.run(owner, kind, content, NOW, NOW).lastInsertRowid);
const ownerOf = (id) => db.prepare('SELECT owner_id FROM memory WHERE id = ?').get(id).owner_id;

// 一篇由 sourceId 衍生的周记（weekly_source 指向来源 + 周记自己的向量）
const seedDerivedWeekly = (sourceId) => {
	const weeklyId = Number(db.prepare(`INSERT INTO memory (character_id, owner_id, channel, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status)
		VALUES ('feiyu', 'user:p_a', 'qq-private', 'weekly', '阿甲的周记', '', 2, 0, 'weekly', ?, ?, 'active')`).run(NOW, NOW).lastInsertRowid);
	db.prepare('INSERT INTO weekly_source (summary_id, source_id) VALUES (?, ?)').run(weeklyId, sourceId);
	db.prepare("INSERT INTO vec(memory_id, model_id, dim, generation_id, blob) VALUES (?, 'test', 1, 1, x'00')").run(weeklyId);
	return weeklyId;
};
const weeklyState = (id) => db.prepare('SELECT status, valid_to FROM memory WHERE id = ?').get(id);
const vecCount = (id) => db.prepare('SELECT COUNT(*) n FROM vec WHERE memory_id = ?').get(id).n;

let ids = null;
function reset() {
	db.exec('DELETE FROM memory');
	ids = {
		fact: seed('user:p_a', 'fact', '阿甲喜欢猫'),
		event: seed('user:p_a', 'event', '阿甲昨天加班'),
		other: seed('user:p_b', 'fact', '阿乙喜欢狗'),
		self: seed('self', 'fact', '我自己买了咖啡'),
		weekly: seed('user:p_a', 'weekly', '阿甲的周记'),
	};
	worker.q.length = 0;
}

test('按 ids 搬：选中的换了主人，没选中的原地不动', () => {
	reset();
	const r = bulkMemory({ db, clock, worker, ids: [ids.fact, ids.event], action: 'owner', value: 'user:p_b' });
	assert.deepEqual([r.ok, r.matched, r.changed], [true, 2, 2]);
	assert.equal(ownerOf(ids.fact), 'user:p_b');
	assert.equal(ownerOf(ids.event), 'user:p_b');
	assert.equal(ownerOf(ids.other), 'user:p_b', '没选中的那条本来就在阿乙名下，不该被动');
	assert.equal(ownerOf(ids.self), 'self', '没选中的不该动');
	assert.equal(ownerOf(ids.weekly), 'user:p_a', '周记没被选中，不该动');
	assert.deepEqual(worker.q, [], '内容没变，不用重新算向量');
	assert.equal(
		db.prepare('SELECT updated_at FROM memory WHERE id = ?').get(ids.fact).updated_at, NOW,
		'搬主人不该动 updated_at：遗忘曲线的起点是它，动了等于把旧记忆说成刚记的',
	);
});

test('按筛选搬：符合条件的那一批都换了主人', () => {
	reset();
	const r = bulkMemory({ db, clock, worker, filter: { ownerId: 'user:p_a' }, action: 'owner', value: 'user:p_b' });
	assert.equal(r.changed, 2, '阿甲名下的两条普通记忆都搬走');
	assert.equal(ownerOf(ids.fact), 'user:p_b');
	assert.equal(ownerOf(ids.event), 'user:p_b');
	assert.equal(ownerOf(ids.other), 'user:p_b', '不在筛选范围内的不动');
	assert.equal(ownerOf(ids.weekly), 'user:p_a', '周记不搬');
});

test('可以搬到「她自己」', () => {
	reset();
	const r = bulkMemory({ db, clock, worker, ids: [ids.fact], action: 'owner', value: 'self' });
	assert.equal(r.changed, 1);
	assert.equal(ownerOf(ids.fact), 'self');
	assert.equal(ownerOf(ids.event), 'user:p_a', '没选中的不动');
});

test('周记不搬（派生周记不许被改）', () => {
	reset();
	const r = bulkMemory({ db, clock, worker, ids: [ids.fact, ids.weekly], action: 'owner', value: 'user:p_b' });
	assert.equal(r.matched, 1, '周记不计入要搬的几条');
	assert.equal(r.changed, 1);
	assert.equal(ownerOf(ids.weekly), 'user:p_a', '周记留在原地');
	assert.equal(db.prepare('SELECT kind FROM memory WHERE id = ?').get(ids.weekly).kind, 'weekly');
});

// 🔴 搬 owner 的副作用：来源记忆改了 owner → weekly_source_changed 触发器把它的周记标废。
//    周记一旦标废就回不来了（weekly_protect 挡着改回 active），而提示只写「搬给了 N 条」——
//    用户点一次，相关周记就永久从检索里消失。所以 owner 变了不算「来源内容变了」。
test('搬来源记忆的 owner：派生周记照样有效（不标废、向量不删）', () => {
	reset();
	const src = ids.fact;
	const weeklyId = seedDerivedWeekly(src);
	assert.equal(weeklyState(weeklyId).status, 'active', '前置：周记一开始是有效的');
	assert.equal(vecCount(weeklyId), 1, '前置：周记带着向量');
	const r = bulkMemory({ db, clock, worker, ids: [src], action: 'owner', value: 'user:p_b' });
	assert.equal(r.changed, 1);
	assert.equal(ownerOf(src), 'user:p_b', '前置：记忆确实搬走了（不然下面这些断言等于没测）');
	assert.equal(weeklyState(weeklyId).status, 'active', '搬主人不改内容，周记不该被标废');
	assert.equal(weeklyState(weeklyId).valid_to, null, '周记不该被写 valid_to');
	assert.equal(vecCount(weeklyId), 1, '周记的向量不该被删');
});

test('来源内容变了：周记照样被标废、向量被删（这条不能被一起放过）', () => {
	reset();
	const src = ids.fact;
	const weeklyId = seedDerivedWeekly(src);
	db.prepare('UPDATE memory SET content = ?, updated_at = ? WHERE id = ?').run('阿甲喜欢狗', NOW + 1, src);
	assert.equal(weeklyState(weeklyId).status, 'outdated', '内容变了 → 周记该失效');
	assert.equal(vecCount(weeklyId), 0, '内容变了 → 周记的向量该删');
});

test('老库的旧触发器定义：openDatabase 会把它换成新的', () => {
	reset();
	// 造一个老库：weekly_source_changed 还是旧定义（owner_id 在 OF 列表里）
	db.exec('DROP TRIGGER IF EXISTS weekly_source_changed');
	db.exec(`CREATE TRIGGER weekly_source_changed AFTER UPDATE OF content,status,valid_to,visibility,owner_id,channel,channel_id,kind,about ON memory
		WHEN OLD.content IS NOT NEW.content OR OLD.status IS NOT NEW.status OR OLD.valid_to IS NOT NEW.valid_to OR OLD.visibility IS NOT NEW.visibility OR OLD.owner_id IS NOT NEW.owner_id OR OLD.channel IS NOT NEW.channel OR OLD.channel_id IS NOT NEW.channel_id OR OLD.kind IS NOT NEW.kind OR OLD.about IS NOT NEW.about
		BEGIN
		 UPDATE memory SET status='outdated', valid_to=NEW.updated_at, updated_at=NEW.updated_at WHERE id IN (SELECT summary_id FROM weekly_source WHERE source_id=OLD.id) AND status='active';
		 DELETE FROM vec WHERE memory_id IN (SELECT summary_id FROM weekly_source WHERE source_id=OLD.id);
		END;`);
	const ofColumns = () => (/AFTER UPDATE OF ([^\s]+) ON/.exec(
		db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'weekly_source_changed'").get().sql) ?? ['', ''])[1].split(',');
	assert.ok(ofColumns().includes('owner_id'), '前置：造出来的确实是旧定义');

	// 旧定义下搬 owner 确实会把周记标废（这正是那个副作用）
	const src = ids.fact;
	const weeklyId = seedDerivedWeekly(src);
	bulkMemory({ db, clock, worker, ids: [src], action: 'owner', value: 'user:p_b' });
	assert.equal(weeklyState(weeklyId).status, 'outdated', '前置：旧定义确实会标废周记');

	// 走一次 openDatabase（= 重启一次）：迁移该把定义换成新的
	const db2 = openDatabase();
	db2.close();
	assert.ok(!ofColumns().includes('owner_id'), '老库的触发器定义必须被换掉（迁移没生效）');

	// 换掉之后再搬：周记不再被标废
	reset();
	const src2 = ids.fact;
	const weeklyId2 = seedDerivedWeekly(src2);
	bulkMemory({ db, clock, worker, ids: [src2], action: 'owner', value: 'user:p_b' });
	assert.equal(weeklyState(weeklyId2).status, 'active', '换完定义后搬 owner 不该标废周记');
	assert.equal(vecCount(weeklyId2), 1, '换完定义后周记的向量不该被删');
});

test('搬的整段在一个事务里：weekly_protect 不会对别的连接短暂缺席', { skip: typeof db.function !== 'function' ? '需要 node:sqlite 的 db.function（node ≥ 22.13）' : false }, () => {
	reset();
	// 另一个连接：事务提交之前，它看到的还是提交前的状态
	const db2 = openDatabase();
	let seen = null;
	db.function('probe_weekly_protect', () => {
		seen = !!db2.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'weekly_protect'").get();
		return 0;
	});
	db.exec('CREATE TRIGGER probe BEFORE UPDATE ON memory BEGIN SELECT probe_weekly_protect(); END;');
	try {
		bulkMemory({ db, clock, worker, ids: [ids.fact], action: 'owner', value: 'user:p_b' });
	} finally {
		db.exec('DROP TRIGGER IF EXISTS probe');
		db2.close();
	}
	assert.equal(seen, true, '搬的过程中 weekly_protect 不能对别的连接消失（那一瞬间谁都能改周记）');
});

test('dryRun 只数不改', () => {
	reset();
	const r = bulkMemory({ db, clock, worker, ids: [ids.fact, ids.event], action: 'owner', value: 'user:p_b', dryRun: true });
	assert.deepEqual([r.ok, r.matched, r.changed], [true, 2, 0]);
	assert.equal(ownerOf(ids.fact), 'user:p_a', 'dryRun 不能改');
	assert.equal(ownerOf(ids.event), 'user:p_a');
});

test('搬完 weekly_protect 还在：周记照样不能被编辑', () => {
	reset();
	const r = bulkMemory({ db, clock, worker, ids: [ids.fact], action: 'owner', value: 'user:p_b' });
	// 先钉住「真的搬了」：不然这条断言在「压根没搬」时也会通过，等于没测到触发器。
	assert.equal(r.ok, true);
	assert.equal(r.changed, 1);
	assert.equal(ownerOf(ids.fact), 'user:p_b');
	assert.throws(
		() => db.prepare("UPDATE memory SET content = '篡改' WHERE kind = 'weekly'").run(),
		/weekly summary cannot be edited/,
		'搬完必须重建 weekly_protect，否则周记就变成可篡改的了',
	);
});

test('搬的时候 weekly_protect 是摘掉的（否则会被当场打穿）', () => {
	reset();
	// 只要搬的时候 weekly_protect 还在，这条触发器就把 UPDATE 打回去
	db.exec(`CREATE TRIGGER guard BEFORE UPDATE ON memory
		WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'weekly_protect') > 0
		BEGIN SELECT RAISE(ABORT, 'weekly_protect still there'); END;`);
	try {
		const r = bulkMemory({ db, clock, worker, ids: [ids.fact], action: 'owner', value: 'user:p_b' });
		assert.equal(r.ok, true, '搬的时候 weekly_protect 必须已经摘掉');
		assert.equal(r.changed, 1);
		assert.equal(ownerOf(ids.fact), 'user:p_b');
	} finally {
		db.exec('DROP TRIGGER IF EXISTS guard');
	}
});

test('搬的过程抛错，触发器也要恢复（try/finally）', () => {
	reset();
	// 让搬运本身必然失败：memory 上加一个无条件 ABORT 的触发器
	db.exec("CREATE TRIGGER boom BEFORE UPDATE ON memory BEGIN SELECT RAISE(ABORT, 'boom'); END;");
	try {
		assert.throws(() => bulkMemory({ db, clock, worker, ids: [ids.fact], action: 'owner', value: 'user:p_b' }), /boom/, '搬运动作本身该抛错');
	} finally {
		db.exec('DROP TRIGGER IF EXISTS boom');
	}
	assert.throws(
		() => db.prepare("UPDATE memory SET content = '篡改' WHERE kind = 'weekly'").run(),
		/weekly summary cannot be edited/,
		'异常路径也必须把触发器恢复回来',
	);
});

test('非法目标被拒，记忆不动', () => {
	reset();
	// 先证明这个动作本身是认的：否则「被拒」可能只是因为不认识这个动作，测不到校验。
	const ok = bulkMemory({ db, clock, worker, ids: [ids.fact], action: 'owner', value: 'user:p_b' });
	assert.equal(ok.ok, true, '合法目标要能搬');
	assert.equal(ownerOf(ids.fact), 'user:p_b');
	reset();
	const bad = ['', '   ', null, undefined, 123, {}, 'x'.repeat(65), 'user:ghost', 'p_a', 'user:', 'user:p a'];
	for (const value of bad) {
		const r = bulkMemory({ db, clock, worker, ids: [ids.fact], action: 'owner', value });
		assert.equal(r.ok, false, `目标 ${JSON.stringify(value)} 该被拒`);
		assert.equal(typeof r.error, 'string');
	}
	assert.equal(ownerOf(ids.fact), 'user:p_a', '被拒的目标不能搬走任何记忆');
});

test('HTTP 入口 POST /inspector/bulk：value 得真的透传过去', async () => {
	reset();
	let handler = null;
	registerRoutes(
		{ effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } },
		{ db, clock, worker, getConfig: () => ({}), saveConfig() {} },
	);
	assert.ok(handler, '路由要注册得上');
	const post = async (payload) => {
		const raw = JSON.stringify(payload);
		let out = null;
		const req = {
			method: 'POST',
			url: '/api/plugins/fish-soul/inspector/bulk',
			headers: {},
			destroy() {},
			on(ev, fn) {
				if (ev === 'data') fn(Buffer.from(raw));
				if (ev === 'end') fn();
				return this;
			},
		};
		await handler(req, { writeHead() {}, end(s) { out = JSON.parse(s); } });
		return out;
	};
	const dry = await post({ ids: [ids.fact], action: 'owner', value: 'user:p_b', dryRun: true });
	assert.equal(dry.ok, true, 'dryRun 要过');
	assert.equal(dry.matched, 1);
	assert.equal(ownerOf(ids.fact), 'user:p_a', 'dryRun 不能改');
	const r = await post({ ids: [ids.fact], action: 'owner', value: 'user:p_b' });
	assert.equal(r.ok, true, `真搬要过：${JSON.stringify(r)}`);
	assert.equal(r.changed, 1);
	assert.equal(ownerOf(ids.fact), 'user:p_b', 'value 没透传到 bulkMemory，记忆就还在原地');
});

test('记忆页批量模式要有「搬到谁」的入口', () => {
	const ui = readFileSync(new URL('../lib/client.soul.js', import.meta.url), 'utf8');
	assert.match(ui, /runBulk\("owner", moveTo/, '批量模式要能按人搬');
	assert.match(ui, /aria-label": "搬到谁"/, '要有一个选目标的下拉');
	assert.match(ui, /符合筛选的都搬给/, '要能按当前筛选整批搬');
});

test.after(() => db.close());
console.log('memory-bulk-move ok');
