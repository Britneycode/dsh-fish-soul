// 世界书：SillyTavern World Info 导入、正则关键词、整词、扫描深度、预算、概率、常驻、开关。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseWorldInfo, matchLore, normalizeEntry, parseRegexKey, loreConfig, WorldBooks } from '../lib/worldinfo.js';
import { handleWorldInfoRoute } from '../lib/routes-worldinfo.js';

// SillyTavern 世界书文件（entries 是对象）
const st = {
	name: '龙之国',
	entries: {
		0: { uid: 0, key: ['/龙(族|人)/'], keysecondary: [], content: '龙族住在北边的山里。', constant: false, order: 100, disable: false },
		1: { uid: 1, key: ['王都'], keysecondary: ['夜里', '晚上'], selective: true, selectiveLogic: 0, content: '王都晚上宵禁。', order: 90 },
		2: { uid: 2, key: [], content: '这个世界有魔法。', constant: true, order: 10, comment: '基础设定' },
		3: { uid: 3, key: ['cat'], matchWholeWords: true, content: 'Cat 是一只猫。', order: 50 },
		4: { uid: 4, key: ['远古'], content: '远古的事。', order: 80, scanDepth: 1 },
		5: { uid: 5, key: ['禁用'], content: '不会出现', disable: true },
		6: { uid: 6, key: ['抽奖'], content: '只有一半概率。', probability: 50, useProbability: true },
		7: { uid: 7, key: ['长条目'], content: '很长'.repeat(400), order: 200 },
		8: { uid: 8, key: [], content: '没关键词也不常驻，丢掉' }
	}
};
const book = parseWorldInfo(JSON.stringify(st), { fileName: 'x.json' });
assert.equal(book.name, '龙之国');
assert.equal(book.entries.length, 8, '没内容 / 没关键词又不常驻的丢掉');
assert.ok(parseRegexKey('/a+b/i') instanceof RegExp);
assert.equal(parseRegexKey('/[坏/'), null);
assert.equal(parseRegexKey('普通'), null);

const E = book.entries;
const names = (hits) => hits.map((e) => e.uid);
// 正则关键词
assert.deepEqual(names(matchLore(E, ['听说龙人来了'], { limit: 10 })), ['2', '0'], '常驻条目每轮都有，排最前');
assert.deepEqual(names(matchLore(E, ['龙'], { limit: 10 })), ['2']);
// 次要关键词
assert.deepEqual(names(matchLore(E, ['王都怎么样'], { limit: 10 })), ['2']);
assert.deepEqual(names(matchLore(E, ['王都晚上'], { limit: 10 })), ['2', '1']);
// 整词
assert.deepEqual(names(matchLore(E, ['my cat is cute'], { limit: 10 })), ['2', '3']);
assert.deepEqual(names(matchLore(E, ['concatenate'], { limit: 10 })), ['2']);
// 扫描深度：全局 2 条；条目 4 自己只看最近 1 条
assert.deepEqual(names(matchLore(E, ['龙族', '随便', '再随便'], { limit: 10, scanDepth: 2 })), ['2'], '超出扫描深度的不算');
assert.deepEqual(names(matchLore(E, ['龙族', '随便', '再随便'], { limit: 10, scanDepth: 3 })), ['2', '0']);
assert.deepEqual(names(matchLore(E, ['远古', '现在'], { limit: 10, scanDepth: 5 })), ['2'], '条目自己的 scanDepth 优先');
assert.deepEqual(names(matchLore(E, ['现在', '远古'], { limit: 10, scanDepth: 5 })), ['2', '4']);
// 禁用
assert.deepEqual(names(matchLore(E, ['禁用'], { limit: 10 })), ['2']);
// 概率
assert.deepEqual(names(matchLore(E, ['抽奖'], { limit: 10, random: () => 0.2 })), ['2', '6']);
assert.deepEqual(names(matchLore(E, ['抽奖'], { limit: 10, random: () => 0.9 })), ['2']);
// 预算：长条目优先级最高但放不下 → 跳过，换后面短的
assert.deepEqual(names(matchLore(E, ['长条目 龙族'], { limit: 10, budgetChars: 100 })), ['2', '0']);
assert.deepEqual(names(matchLore(E, ['长条目 龙族'], { limit: 10, budgetChars: 5000 })), ['2', '7', '0']);
// 条数
assert.equal(matchLore(E, ['长条目 龙族 王都晚上 cat'], { limit: 2 }).length, 2);
// 旧写法：字符串 + 数字上限
assert.deepEqual(names(matchLore(E, '龙族', 4)), ['2', '0']);

// 角色卡 character_book 写法也认
const card = { data: { name: '卡', character_book: { entries: [{ keys: ['猫'], secondary_keys: ['名字'], selective: true, extensions: { selectiveLogic: 3, case_sensitive: true }, content: 'x', insertion_order: 5 }] } } };
const cb = parseWorldInfo(card);
assert.equal(cb.entries[0].logic, 3); assert.equal(cb.entries[0].caseSensitive, true); assert.equal(cb.entries[0].order, 5);
assert.throws(() => parseWorldInfo('{"a":1}'), /entries/);
assert.throws(() => parseWorldInfo('not json'), /JSON/);
assert.equal(normalizeEntry(null), null);
assert.deepEqual(loreConfig({ scanDepth: 999, budgetChars: 1 }), { scanDepth: 50, budgetChars: 100, maxEntries: 6 });

// 存储 + 开关
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const wb = new WorldBooks({ db });
const b1 = wb.import(JSON.stringify(st), { fileName: 'x.json' });
assert.equal(wb.activeEntries().length, 8);
assert.equal(wb.activeEntries()[0].book, '龙之国');
assert.equal(wb.summary()[0].regex, 1); assert.equal(wb.summary()[0].constant, 1);
wb.setEnabled(b1.id, false);
assert.equal(wb.activeEntries().length, 0, '关掉就不生效');
wb.setEnabled(b1.id, true);

// 路由
let cfg = {};
const deps = { worldBooks: wb, persona: { lore: [normalizeEntry({ keys: ['周一'], content: '周一是金鱼' })] }, getConfig: () => ({ lore: cfg }), saveConfig: async (p) => { cfg = p.lore; } };
const run = async (method, path, body, origin = true) => {
	let out = null;
	await handleWorldInfoRoute({ method, path, req: {}, readBody: async () => JSON.stringify(body ?? {}), sameOrigin: () => origin, send: (code, payload) => { out = { code, payload }; }, deps });
	return out;
};
let r = await run('GET', '/worldinfo/state');
assert.equal(r.payload.books.length, 1); assert.equal(r.payload.cardEntries, 1);
r = await run('POST', '/worldinfo/test', { text: '周一呢\n龙族呢' });
assert.deepEqual(r.payload.hits.map((x) => x.book).sort(), ['人格卡', '龙之国', '龙之国']);
assert.equal(r.payload.hits[0].constant, true);
r = await run('POST', '/worldinfo/config', { scanDepth: 1 });
assert.equal(cfg.scanDepth, 1);
r = await run('POST', '/worldinfo/test', { text: '周一呢\n龙族呢' });
assert.deepEqual(r.payload.hits.map((x) => x.book), ['龙之国', '龙之国'], '扫描深度 1 只看最后一行');
await assert.rejects(run('POST', '/worldinfo/import', { text: 'bad' }), /JSON/, '解析失败抛给上层兜底成 {ok:false}');
r = await run('POST', '/worldinfo/delete', { id: b1.id }, false);
assert.equal(r.code, 403);
r = await run('POST', '/worldinfo/delete', { id: b1.id });
assert.equal(r.payload.books.length, 0);
console.log('✓ 世界书：ST 文件导入、正则 / 整词 / 次要关键词、扫描深度、预算、概率、常驻、开关、试一试');
