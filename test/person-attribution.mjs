/**
 * 人物关系归因 —— 三个根因的回归测试。
 *
 * ① 署名叫不出人名时回退到「这一轮唯一说话的人」
 *    私聊里模型写了关于**第三者**的事，回退就把第三者的事记到聊天对象名下；
 *    `people[].who` 填第三者时回退加的是**聊天对象**的好感
 *    —— 这就是「把别人的影响加到其他人身上」。
 *
 * ② 抖音身份键一列混着 `douyin:<uid>` / `uid:<uid>` / 裸昵称
 *    认人是按这一列**精确匹配** ⇒ 换个写法就是「新的人」⇒ 同一个人被拆成多行，
 *    各自记一套好感 / 印象 / 记忆。
 *
 * ③ 19 位 uid 过一遍 `Number()` 末位被抹平 ⇒ 又多造一个身份。
 *
 * ⚠ 每组用独立的 DSH_HOME：openDatabase() 复用同一个 soul.db，
 *   共用时前一组建的 person 行会漏进后一组。
 *
 * ⚠ 这里的 uid / 名字都是编的，不对应任何真人（真机库的号不进仓库）。
 */
import assert from 'node:assert/strict';

let seq = 0;
const tmpHome = (tag) => {
	const dir = `${process.env.TEMP || '/tmp'}/fish-soul-test-person-${tag}-${process.pid}-${Date.now()}-${seq++}`;
	process.env.DSH_HOME = dir;
	return dir;
};

tmpHome('init');
const { openDatabase, resolveOrCreatePlatformPerson, normalizeDouyinIdentity, cleanupMergedDouyinNames } = await import('../lib/db.js');
const { ChatJournal, ChatDigester, insertMemory, getMood } = await import('../lib/soul-memory.js');

const ok = (m) => console.log('✓', m);
const now = Date.parse('2026-11-12T12:00:00Z');
const people = (db) => db.prepare('SELECT COUNT(*) n FROM person').get().n;
/** 16 位 uid（双精度下精确） */
const UID16 = '1000000000000001';
/** 19 位 uid（超过 Number.MAX_SAFE_INTEGER，过一遍 Number 末位就没了） */
const UID19 = '9000000000000000001';
/** UID19 过一遍 Number 之后的样子 —— 「截断孪生」 */
const TRUNC19 = String(Number(UID19));

/** 一轮聊天整理：LLM 输出由测试给死，其余依赖都给最小实现。 */
const digesterFor = (db, journal, llm, extra = {}) => new ChatDigester({
	db, clock: { now: () => now }, journal, worker: null,
	callLlm: async () => llm,
	getConfig: () => ({}), related: () => [], findOwnerByName: () => null,
	personaName: () => '鱼', titleOf: () => 'QQ·聊天对象', note: () => {}, log: () => {},
	...extra
});

/** 造一个「聊天对象」（canonical p2），并给他一行 person。 */
const makePartner = (db, name = '聊天对象') => {
	db.prepare(`
		INSERT INTO person (canonical_id, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('p2', ?, 'stranger', 0, ?, ?)
	`).run(name, now, now);
	return 'user:p2';
};

// ───────────────────────── ① 记忆归因 ─────────────────────────

// 私聊里只有聊天对象一个人说话，模型却写了一条关于**第三者**的记忆。
// 旧行为：`ownerOfName('路人甲') ?? single` → 查不到就落到聊天对象名下 ⇒ 路人的事成了聊天对象的事。
{
	tmpHome('A-mem');
	const db = openDatabase();
	const ownerId = makePartner(db);
	const journal = new ChatJournal({ keepRecent: 50 });
	journal.add('private:30001', { who: '聊天对象', ownerId, text: '我朋友路人甲在准备考研' });
	const digester = digesterFor(db, journal, JSON.stringify({
		memories: [
			{ who: '路人甲', content: '路人甲在准备考研', kind: 'fact', importance: 3 },
			{ who: '聊天对象', content: '聊天对象下周要考科目二', kind: 'event', importance: 3 }
		],
		self: [], summary: '聊天对象来聊天', people: []
	}));
	const r = await digester.digest('private:30001');

	const third = db.prepare("SELECT * FROM memory WHERE content LIKE '%考研%'").all();
	assert.equal(third.length, 0, '第三者的记忆不能记到聊天对象名下（宁可不记，不可记错人）');
	assert.equal(r.added, 1, '只有聊天对象自己的那条该记');
	const own = db.prepare("SELECT owner_id FROM memory WHERE content = '聊天对象下周要考科目二'").get();
	assert.equal(own?.owner_id, ownerId, '聊天对象自己的事照记');
	// 小结仍属聊天对象（语义不同：「这段聊天的小结属于聊天对象」）
	const ep = db.prepare("SELECT owner_id FROM memory WHERE kind = 'episode' AND content = '聊天对象来聊天'").get();
	assert.equal(ep?.owner_id, ownerId, '聊完小结仍归聊天对象');
	ok('① 私聊里谈到第三者 → 那个人的记忆不记到聊天对象名下（自己的照记、小结不动）');
}

// 署名为空 ≠ 第三者：模型没写名字、这一轮只有一个人说话 ⇒ 默认是他。
{
	tmpHome('A-empty');
	const db = openDatabase();
	const ownerId = makePartner(db);
	const journal = new ChatJournal({ keepRecent: 50 });
	journal.add('private:30002', { who: '聊天对象', ownerId, text: '下周要去体检' });
	const digester = digesterFor(db, journal, JSON.stringify({
		memories: [{ who: '', content: '下周要去体检', kind: 'event', importance: 3 }],
		self: [], summary: '', people: []
	}));
	const r = await digester.digest('private:30002');
	assert.equal(r.added, 1, '署名空着（模型没写名字）时仍归这一轮唯一说话的人');
	const row = db.prepare("SELECT owner_id FROM memory WHERE content = '下周要去体检'").get();
	assert.equal(row?.owner_id, ownerId);
	ok('① 署名空着 → 仍归这一轮唯一说话的人（只有「有名字但查不到」才算第三者）');
}

// ───────────────────────── ① 好感归因 ─────────────────────────

// `people[].who` 填第三者 → 旧行为把**聊天对象**的好感加了。
{
	tmpHome('A-aff');
	const db = openDatabase();
	const ownerId = makePartner(db);
	const before = db.prepare("SELECT affinity FROM person WHERE canonical_id = 'p2'").get();
	const journal = new ChatJournal({ keepRecent: 50 });
	journal.add('private:30003', { who: '聊天对象', ownerId, text: '我朋友路人甲最近状态不好' });
	const digester = digesterFor(db, journal, JSON.stringify({
		memories: [], self: [], summary: '',
		people: [{ who: '路人甲', affinity: 5, mood: '担心', moodReason: '他状态不好' }]
	}));
	const r = await digester.digest('private:30003');

	const after = db.prepare("SELECT affinity FROM person WHERE canonical_id = 'p2'").get();
	assert.deepEqual(after.affinity, before.affinity, '聊天对象的好感不能被别人的影响改动');
	assert.equal(getMood(db, ownerId, now), null, '情绪也不该落到聊天对象头上');
	assert.equal(r.people.length, 0, '第三者的好感不结算');
	ok('① `people[].who` 填第三者 → 聊天对象的好感 / 情绪都不变');
}

// 正向：好感照常加给这一轮真的说过话的人。
{
	tmpHome('A-aff-ok');
	const db = openDatabase();
	const ownerId = makePartner(db);
	const journal = new ChatJournal({ keepRecent: 50 });
	journal.add('private:30004', { who: '聊天对象', ownerId, text: '今天心情不错' });
	const digester = digesterFor(db, journal, JSON.stringify({
		memories: [], self: [], summary: '',
		people: [{ who: '聊天对象', affinity: 3 }]
	}));
	const r = await digester.digest('private:30004');
	assert.equal(r.people.length, 1, '本人说话 → 好感照常结算');
	const after = db.prepare("SELECT affinity FROM person WHERE canonical_id = 'p2'").get();
	assert.equal(after.affinity, 13, '好感 +3（stranger 基线 10）');
	ok('① 正向：本人说话 → 好感照常加（没把修复做过头）');
}

// ───────────────────────── ② 身份键归一 ─────────────────────────

// 同一个 uid 的三种写法（`uid:x` / `douyin:x` / 裸数字）→ 只能有一行 person。
{
	tmpHome('B-formats');
	const db = openDatabase();
	const a = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: `uid:${UID16}`, nickname: '群友0001', nowMs: 1000 });
	const b = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: `douyin:${UID16}`, nickname: '群友0001', nowMs: 2000 });
	const c = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID16, nickname: '群友0001', nowMs: 3000 });
	assert.equal(a.canonical_id, b.canonical_id, '`uid:x` 与 `douyin:x` 是同一个人');
	assert.equal(b.canonical_id, c.canonical_id, '裸数字与 `douyin:x` 是同一个人');
	assert.equal(people(db), 1, '同一个人不能被拆成多行');
	assert.equal(a.douyin_uid, `douyin:${UID16}`, '身份键统一成 douyin:<uid>');
	ok('② 同一 uid 的三种写法 → 只有一行 person，身份键统一成 douyin:<uid>');
}

// 库里已经躺着老格式的行（`uid:<id>`）→ 归一后要认成同一个人（原地改键，不搬家）。
{
	tmpHome('B-legacy');
	const db = openDatabase();
	db.prepare(`
		INSERT INTO person (canonical_id, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('legacy', ?, '群友0001', 'stranger', 3, ?, ?)
	`).run(`uid:${UID16}`, now, now);
	const r = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: `douyin:${UID16}`, nickname: '群友0001', nowMs: 2000 });
	assert.equal(r.canonical_id, 'legacy', '老格式的行认成同一个人');
	assert.equal(r.douyin_uid, `douyin:${UID16}`, '老行的键原地改成新格式');
	assert.equal(people(db), 1, '不能新建一行');
	ok('② 库里已有 `uid:<id>` 老行 → 归一后认成同一个人（原地改键）');
}

// 两种写法同时存在（历史遗留拆成两行）→ 并成一行，记忆跟着走。
{
	tmpHome('B-merge');
	const db = openDatabase();
	db.prepare(`
		INSERT INTO person (canonical_id, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('old', ?, '群友0001', 'stranger', 3, ?, ?)
	`).run(`uid:${UID16}`, now, now);
	db.prepare(`
		INSERT INTO person (canonical_id, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('new', ?, '群友0001', 'stranger', 115, ?, ?)
	`).run(`douyin:${UID16}`, now, now);
	insertMemory(db, null, {
		ownerId: 'user:old', channel: 'douyin-private', channelId: `douyin:${UID16}`,
		kind: 'fact', content: '老行上的一条记忆', importance: 2, sourceSession: 'chat'
	}, now);

	const r = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: `douyin:${UID16}`, nickname: '群友0001', nowMs: 2000 });
	assert.equal(people(db), 1, '拆成两行的同一个人要并成一行');
	assert.equal(r.canonical_id, 'new', '保留新格式那一行');
	assert.equal(r.interaction_count, 119, '互动次数加起来（3 + 115 + 本次 1）');
	const moved = db.prepare("SELECT owner_id FROM memory WHERE content = '老行上的一条记忆'").get();
	assert.equal(moved?.owner_id, 'user:new', '记忆跟着走，不能留在被摘掉的那行上');
	ok('② 同一个人被拆成两行 → 并成一行，记忆 / 互动次数跟着走');
}

// 裸昵称：还原不出 uid ⇒ 原样保留，同一个名字还是同一个人，但不硬套到某个 uid 上。
{
	tmpHome('B-nickname');
	const db = openDatabase();
	const a = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: '路人甲', nickname: '路人甲', nowMs: 1000 });
	const b = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: '路人甲', nickname: '路人甲', nowMs: 2000 });
	assert.equal(a.canonical_id, b.canonical_id, '同一个名字还是同一个人');
	assert.equal(a.douyin_uid, '路人甲', '裸昵称原样保留（还原不出 uid）');
	assert.equal(people(db), 1);
	ok('② 裸昵称：同一个名字还是同一个人，但不硬套成 douyin:<uid>');
}

// 逗号拼接（历史上把一整段对话里好几个人拼成了一个身份）→ 只清理，不合并。
{
	tmpHome('B-merged-list');
	const db = openDatabase();
	db.prepare(`
		INSERT INTO person (canonical_id, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('p_re', '路人甲', '路人甲', 'stranger', 35, ?, ?)
	`).run(now, now);
	db.prepare(`
		INSERT INTO person (canonical_id, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('p_other', 'douyin:999', '乙乙乙', 'stranger', 2, ?, ?)
	`).run(now, now);
	db.prepare(`
		INSERT INTO person (canonical_id, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('p_merged', ?, ?, 'stranger', 2, ?, ?)
	`).run('路人甲, 乙乙乙, 丙丙丙', '路人甲, 乙乙乙, 丙丙丙', now, now);

	const cleaned = cleanupMergedDouyinNames(db);
	assert.equal(cleaned.length, 1, '把几个人拼一起的脏身份要清掉');
	assert.equal(cleaned[0].canonicalId, 'p_merged');
	assert.equal(db.prepare("SELECT COUNT(*) n FROM person WHERE douyin_uid LIKE '%,%'").get().n, 0, '不能再留逗号拼接的身份');
	assert.equal(db.prepare("SELECT COUNT(*) n FROM person WHERE canonical_id = 'p_re'").get().n, 1, '干净的那两个身份不受影响');
	ok('② 逗号拼接的脏身份 → 清掉（只清理不合并：并到谁头上都是把别人的往来记到他头上）');
}

// 带逗号的真名字不该被误判成「好几个人」。
{
	tmpHome('B-comma-name');
	const db = openDatabase();
	db.prepare(`
		INSERT INTO person (canonical_id, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('p_comma', 'Bob, Jr.', 'Bob, Jr.', 'stranger', 1, ?, ?)
	`).run(now, now);
	const cleaned = cleanupMergedDouyinNames(db);
	assert.equal(cleaned.length, 0, '带逗号的真名字不是「好几个人拼一起」');
	assert.equal(db.prepare("SELECT COUNT(*) n FROM person WHERE canonical_id = 'p_comma'").get().n, 1);
	ok('② 带逗号的真名字不会被误清（判据要认得出「这几段各自都是已知的人」）');
}

// ───────────────────────── ③ 19 位 uid 不能被 Number 截断 ─────────────────────────

{
	assert.notEqual(TRUNC19, UID19, '这个例子本身要能被 Number 截断，否则测不到东西');
	assert.equal(TRUNC19, '9000000000000000000');
	assert.equal(normalizeDouyinIdentity(UID19), `douyin:${UID19}`, '归一不能把 19 位 uid 截断');
	assert.equal(normalizeDouyinIdentity(`uid:${UID19}`), `douyin:${UID19}`, '`uid:` 前缀的 19 位 uid 也不能截断');
	assert.equal(normalizeDouyinIdentity(`douyin:${UID19}`), `douyin:${UID19}`);
	ok('③ 归一保留 19 位 uid 的全部数字（不经过 Number）');
}

{
	tmpHome('C-store');
	const db = openDatabase();
	const r = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID19, nickname: '主人', nowMs: 1000 });
	assert.equal(r.douyin_uid, `douyin:${UID19}`, '库里存的必须是完整的 19 位');
	assert.notEqual(r.douyin_uid, `douyin:${TRUNC19}`, '不能是被 Number 抹平的版本');
	ok('③ 19 位 uid 入库保持完整（没被 Number 截断）');
}

{
	// 库里已经躺着被 Number 抹过一遍的孪生行（`uid:<截断版>`）→ 正确 uid 来了要认成同一个人。
	tmpHome('C-twin');
	const db = openDatabase();
	db.prepare(`
		INSERT INTO person (canonical_id, douyin_uid, display_name, relation_stage, interaction_count, first_seen_at, last_seen_at)
		VALUES ('p_trunc', ?, '群友0000', 'stranger', 12, ?, ?)
	`).run(`uid:${TRUNC19}`, now, now);
	insertMemory(db, null, {
		ownerId: 'user:p_trunc', channel: 'douyin-group', channelId: 'douyin-group:某群',
		kind: 'fact', content: '截断行上的一条记忆', importance: 2, sourceSession: 'chat'
	}, now);

	const r = resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: UID19, nickname: '主人', nowMs: 2000 });
	assert.equal(r.canonical_id, 'p_trunc', '截断孪生要认成同一个人');
	assert.equal(r.douyin_uid, `douyin:${UID19}`, '键改回完整的 19 位');
	assert.equal(people(db), 1, '不能多出一行');
	const moved = db.prepare("SELECT owner_id FROM memory WHERE content = '截断行上的一条记忆'").get();
	assert.equal(moved?.owner_id, 'user:p_trunc', '记忆留在同一个人名下（是同一个人，不是搬家）');
	ok('③ 库里已有的截断孪生行 → 正确 uid 来了认成同一个人（不多出一行）');
}

console.log('\nperson-attribution ok');
