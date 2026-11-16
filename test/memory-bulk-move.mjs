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
