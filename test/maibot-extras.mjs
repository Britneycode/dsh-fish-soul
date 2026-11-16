// 麦麦的表情包 / 表达方式 / 黑话导入：旧版（emoji/expression/jargon + chat_streams）和新版（images/expressions/jargons + chat_sessions）两代表结构。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMaiBotExtras, previewMaiBotExtras, importMaiBotExtras, emojiName, sniffImage } from '../lib/maibot-extras.js';
import { handleV07Route } from '../lib/routes-v07.js';
import { SlangLearner, slangConfig } from '../lib/slang.js';
import { StickerBox } from '../lib/stickers.js';

const root = mkdtempSync(join(tmpdir(), 'fs-mai-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');
assert.equal(sniffImage(PNG), 'image/png');
assert.equal(sniffImage(GIF), 'image/gif');
assert.equal(sniffImage(Buffer.from('hello world!!')), null);
assert.equal(emojiName('开心,得意', '一只猫'), '开心');
assert.equal(emojiName('', '这是一张表情包，一只猫猫在笑。很开心'), '一只猫猫在笑');

function oldDb() {
	const dir = join(root, 'old', 'MaiBot');
	mkdirSync(join(dir, 'data', 'emoji_registed'), { recursive: true });
	writeFileSync(join(dir, 'data', 'emoji_registed', 'a.png'), PNG);
	writeFileSync(join(dir, 'data', 'emoji_registed', 'b.gif'), GIF);
	const path = join(dir, 'data', 'MaiBot.db');
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE chat_streams (stream_id TEXT, group_id TEXT, group_platform TEXT, platform TEXT, user_id TEXT);
		CREATE TABLE emoji (full_path TEXT, format TEXT, emoji_hash TEXT, description TEXT, emotion TEXT, is_registered INTEGER, is_banned INTEGER, usage_count INTEGER);
		CREATE TABLE expression (situation TEXT, style TEXT, count REAL, last_active_time REAL, chat_id TEXT, rejected INTEGER);
		CREATE TABLE jargon (content TEXT, meaning TEXT, chat_id TEXT, is_global INTEGER, count INTEGER, is_jargon INTEGER);`);
	db.exec(`INSERT INTO chat_streams VALUES ('s1', '123456', 'qq', 'qq', '111'), ('s2', NULL, NULL, 'qq', '222'), ('s3', '999', 'wechat', 'wechat', '333');
		INSERT INTO emoji VALUES ('${join(dir, 'data', 'emoji_registed', 'a.png').replace(/'/g, "''")}', 'png', 'h1', '猫猫笑', '开心,得意', 1, 0, 9),
			('data/emoji_registed/b.gif', 'gif', 'h2', '狗狗叹气', '无语', 1, 0, 5),
			('data/emoji_registed/banned.png', 'png', 'h3', '禁用的', '生气', 1, 1, 50),
			('data/emoji_registed/missing.png', 'png', 'h4', '丢了', '难过', 1, 0, 1);
		INSERT INTO expression VALUES ('被夸了', '先说哪有', 7, 0, 's1', 0), ('想摸鱼', '说一句带薪拉屎', 3, 0, 's2', 0),
			('被拒绝的', '不要', 9, 0, 's1', 1), ('微信里', '不导', 2, 0, 's3', 0), ('不知道哪', '随便', 1, 0, 'zzz', 0),
			('有人问你是谁', '说自己是机器人', 5, 0, 's1', 0);
		INSERT INTO jargon VALUES ('yyds', '永远的神', 's1', 0, 12, 1), ('绝绝子', '很好', 's1', 1, 4, 1), ('待定的', '还没判', 's1', 0, 3, NULL),
			('普通词', '不是黑话', 's1', 0, 3, 0), ('没意思', '', 's1', 0, 3, 1);`);
	db.close();
	return path;
}

function newDb() {
	const dir = join(root, 'new', 'MaiBot');
	mkdirSync(join(dir, 'data', 'images'), { recursive: true });
	writeFileSync(join(dir, 'data', 'images', 'c.png'), PNG);
	const path = join(dir, 'data', 'MaiBot.db');
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE chat_sessions (session_id TEXT, user_id TEXT, group_id TEXT, platform TEXT);
		CREATE TABLE images (image_hash TEXT, description TEXT, full_path TEXT, image_type TEXT, query_count INTEGER, is_registered INTEGER, is_banned INTEGER, no_file_flag INTEGER);
		CREATE TABLE expressions (situation TEXT, style TEXT, count INTEGER, session_id TEXT, checked INTEGER);
		CREATE TABLE jargons (content TEXT, meaning TEXT, session_id_dict TEXT, count INTEGER, is_jargon INTEGER, is_global INTEGER);`);
	db.exec(`INSERT INTO chat_sessions VALUES ('n1', '111', '654321', 'qq');
		INSERT INTO images VALUES ('x', '这是一张表情包，一只猫猫在笑', 'data/images/c.png', 'EMOJI', 3, 1, 0, 0), ('y', '普通图片', 'data/images/c.png', 'IMAGE', 9, 1, 0, 0);
		INSERT INTO expressions VALUES ('打招呼', '说一声来了老弟', 4, 'n1', 1), ('全局场合', '全局说法', 2, NULL, 0);
		INSERT INTO jargons VALUES ('awsl', '啊我死了', '{"n1": 3}', 8, 1, 0), ('xswl', '笑死我了', '{}', 2, 1, 1);`);
	db.close();
	return path;
}

// 只有 emoji 表的小库：造「麦麦那边同一条图出现多次」的数据（额度/计数那些场景要用）
function emojiOnlyDb(name, rows) {
	const dir = join(root, name, 'MaiBot');
	mkdirSync(join(dir, 'data', 'emoji_registed'), { recursive: true });
	const path = join(dir, 'data', 'MaiBot.db');
	const db = new DatabaseSync(path);
	db.exec('CREATE TABLE emoji (full_path TEXT, format TEXT, emoji_hash TEXT, description TEXT, emotion TEXT, is_registered INTEGER, is_banned INTEGER, usage_count INTEGER)');
	const ins = db.prepare('INSERT INTO emoji VALUES (?,?,?,?,?,1,0,?)');
	for (const r of rows) {
		const file = join(dir, 'data', 'emoji_registed', r.file);
		writeFileSync(file, r.bytes);
		ins.run(file, String(r.file).split('.').pop(), 'h', String(r.description ?? ''), '', Number(r.usage ?? 1));
	}
	db.close();
	return path;
}

const oldPath = oldDb();
const x = readMaiBotExtras(oldPath);
assert.equal(x.schema, 'old');
assert.deepEqual(x.emojis.map((e) => e.name), ['开心', '无语'], '禁用的、文件不在的跳过；相对路径按麦麦目录找');
assert.ok(x.warnings.some((w) => /找不到/.test(w)));
assert.deepEqual(x.expressions.map((e) => [e.situation, e.channelId]), [['被夸了', 'group:123456'], ['有人问你是谁', 'group:123456'], ['想摸鱼', 'private:222'], ['不知道哪', 'global']]);
assert.ok(x.warnings.some((w) => /不是 QQ/.test(w)));
assert.deepEqual(x.jargons.map((j) => [j.term, j.channelId]), [['yyds', 'group:123456'], ['绝绝子', 'global']], '只要判定是黑话、有意思的');

const pv = previewMaiBotExtras(oldPath, { titleOf: (c) => `T${c}` });
assert.equal(pv.emojis.count, 2); assert.equal(pv.expressions.count, 4); assert.equal(pv.jargons.count, 2);
assert.equal(pv.chats[0].channelId, 'group:123456');

// 导入
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const slang = new SlangLearner({ db, callLlm: async () => null, getConfig: () => slangConfig({}), personaName: () => '小鱼', titleOf: (c) => c });
const stickers = new StickerBox({ db, getConfig: () => ({}) });
const ws = join(root, 'ws');
mkdirSync(ws);
let r = await importMaiBotExtras({ dbPath: oldPath, slang, stickers, workspacePath: ws });
assert.equal(r.emojis, 2);
assert.equal(r.expressions, 3, '像「自称机器人」的不收');
assert.equal(r.skipped, 1);
assert.equal(r.terms, 2);
assert.deepEqual(readdirSync(join(ws, '_stickers')).sort(), ['开心.png', '无语.gif']);
// 再导一次：不重复
r = await importMaiBotExtras({ dbPath: oldPath, slang, stickers, workspacePath: ws });
assert.equal(r.emojis, 0); assert.equal(r.emojiDup, 2); assert.equal(r.expressions, 0); assert.equal(r.terms, 0);
const st = slang.state();
const g = st.find((c) => c.channelId === 'group:123456');
assert.equal(g.expressions[0].situation, '被夸了'); assert.equal(g.expressions[0].count, 7); assert.equal(g.expressions[0].from, 'maibot');
const glob = st.find((c) => c.channelId === 'global');
assert.equal(glob.kind, 'global');
assert.deepEqual(glob.terms.map((t) => t.term), ['绝绝子']);
// 全局的补进每个 QQ 聊天的上下文
const lines = slang.contextLines('group:777', '');
assert.ok(lines.some((l) => /绝绝子/.test(l)), '别的群也能用全局的梗');
assert.ok(lines.some((l) => /不知道哪/.test(l)));
const own = slang.contextLines('group:123456', 'yyds');
assert.ok(own.some((l) => /yyds：永远的神/.test(l)));
// 不导表情：只动说法
r = await importMaiBotExtras({ dbPath: oldPath, slang, stickers, workspacePath: null, expressions: false, jargons: false });
assert.ok(r.warnings.some((w) => /工作区/.test(w)));

// 新版表结构
const newPath = newDb();
const y = readMaiBotExtras(newPath);
assert.equal(y.schema, 'new');
assert.deepEqual(y.emojis.map((e) => e.name), ['一只猫猫在笑'], '只要 image_type = emoji');
assert.deepEqual(y.expressions.map((e) => [e.style, e.channelId]), [['说一声来了老弟', 'group:654321'], ['全局说法', 'global']]);
assert.deepEqual(y.jargons.map((j) => [j.term, j.channelId]), [['awsl', 'group:654321'], ['xswl', 'global']]);
r = await importMaiBotExtras({ dbPath: newPath, slang, stickers, workspacePath: ws, maxEmojis: 5 });
assert.equal(r.emojis + r.emojiDup, 1, '同一张图（和旧库那张字节一样）算重复');

// ── #118：导入的表情也要看图打标 ──
// 导进来的表情没标签就进不了「按感觉挑」的池子（那边只认有标签的）⇒ 导入这条路也得打标。
// 麦麦的描述常常是整句（「这是一张表情包，一只猫猫在笑」）→ 捡不出标签 → 只能靠看图。
{
	const ws2 = join(root, 'ws-vision');
	mkdirSync(ws2);
	const seen = [];
	const vision = async (prompt, images) => {
		assert.ok(Array.isArray(images) && images.length === 1, '一次只看一张图');
		seen.push(images[0].name);
		return '卖萌、可爱';
	};
	const tagged = await importMaiBotExtras({ dbPath: newPath, slang, stickers, workspacePath: ws2, vision });
	assert.equal(tagged.emojis, 1, '导入了一张');
	const row = stickers.collected().find((x) => x.workspacePath === ws2);
	assert.deepEqual(row.tags, ['卖萌', '可爱'], '标签真写进 kv 里了（不是「函数被调用了」）');
	assert.equal(row.tagsBy, 'vision', '来源标成 vision');
	assert.equal(tagged.emojiTagged, 1, '打上标签的张数要报出来');
	assert.deepEqual(seen, ['一只猫猫在笑.png'], '模型确实被叫去看这张图了');

	// 不给 vision：只导入、不打标（跟以前一样）
	const ws3 = join(root, 'ws-plain');
	mkdirSync(ws3);
	const plain = await importMaiBotExtras({ dbPath: newPath, slang, stickers, workspacePath: ws3 });
	assert.equal(plain.emojis, 1);
	assert.deepEqual(stickers.collected().find((x) => x.workspacePath === ws3).tags, [], '没给 vision 就不打标');
	assert.equal(plain.emojiTagged, 0, '没给 vision 就不打标');

	// 重复导入的老表情也接着打标（它可能一直都没标签 —— 就是主人现在这批）
	const again = await importMaiBotExtras({ dbPath: newPath, slang, stickers, workspacePath: ws3, vision });
	assert.equal(again.emojis, 0, '重复的不再存一遍');
	assert.equal(again.emojiDup, 1, '是重复');
	assert.equal(again.emojiTagged, 1, '重复导入的老表情也接着打标');
	assert.deepEqual(stickers.collected().find((x) => x.workspacePath === ws3).tags, ['卖萌', '可爱'], '标签真写进 kv 里了');

	// 已经有标签的重复表情：不再问模型，也不能算成「这次看图打上的」（否则面板的数字在骗人）
	const seenBefore = seen.length;
	const third = await importMaiBotExtras({ dbPath: newPath, slang, stickers, workspacePath: ws3, vision });
	assert.equal(third.emojiTagged, 0, '本来就有标签的不能算成这次打上的');
	assert.equal(seen.length, seenBefore, '已经有标签的不再问模型');
}

// ── #118：重复导入的老表情不能把「看图打标」的额度吃光 ──
// 额度是留给「真要问模型」的那几次的：已经有标签的老表情，tagByVision 会直接返回旧标签、
// 根本不问模型 —— 它们一分额度都不该吃。否则额度被老表情吃光，真正要打标的新图一张都轮不上
// （导多少遍都不收敛，跟 #118 修的是同一个症状）。
{
	const wsB = join(root, 'ws-budget');
	mkdirSync(wsB);
	// 库里先有一张带标签的老表情（麦麦那边有 3 条同图的记录 → 导入时全是重复）
	const old = stickers.importImage({ bytes: GIF, mediaType: 'image/gif', name: 'old.gif', workspacePath: wsB, from: '测试', tags: ['柴犬'] });
	assert.equal(old.ok, true, '老表情先入库');
	const budgetPath = emojiOnlyDb('budget', [
		{ file: 'old.gif', bytes: GIF, usage: 9 },
		{ file: 'old.gif', bytes: GIF, usage: 8 },
		{ file: 'old.gif', bytes: GIF, usage: 7 },
		{ file: 'new.png', bytes: PNG, usage: 1 }
	]);
	let asked = 0;
	const res = await importMaiBotExtras({
		dbPath: budgetPath, slang, stickers, workspacePath: wsB,
		vision: async () => { asked++; return '卖萌、可爱'; },
		maxEmojis: 3
	});
	assert.equal(res.emojiDup, 3, '老表情那 3 条都是重复');
	assert.equal(res.emojis, 1, '新图还是导进去了');
	const fresh = stickers.collected().find((x) => x.workspacePath === wsB && x.file !== old.file);
	assert.ok(fresh, '新图入库了');
	assert.deepEqual(fresh.tags, ['卖萌', '可爱'], '额度被老表情吃光的话，这张新图就永远打不上标签');
	assert.equal(fresh.tagsBy, 'vision');
	assert.equal(res.emojiTagged, 1, '只有新图算「这次打上的」');
	assert.equal(asked, 1, '模型只被叫去看那张新图（老表情有标签，不该问）');
}

// ── #118：面板报的张数按文件算，不按记录算 ──
// 同一个文件在麦麦那边可能有多条记录（导入一条 + 重复一条）：只有 1 张图被打上标签，
// 报成 2 张就是在骗人。
{
	const wsC = join(root, 'ws-count');
	mkdirSync(wsC);
	const samePath = emojiOnlyDb('same', [
		{ file: 'a.png', bytes: PNG, usage: 9 },
		{ file: 'a.png', bytes: PNG, usage: 8 }
	]);
	const res = await importMaiBotExtras({ dbPath: samePath, slang, stickers, workspacePath: wsC, vision: async () => '卖萌、可爱', maxEmojis: 5 });
	assert.equal(res.emojis, 1, '一张图只导进去一次');
	assert.equal(res.emojiDup, 1, '第二条是重复');
	assert.equal(res.emojiTagged, 1, '同一张文件只算一张（不是两条记录两张）');
	const row = stickers.collected().find((x) => x.workspacePath === wsC);
	assert.deepEqual(row.tags, ['卖萌', '可爱'], '标签真写进 kv 里了');
}

// 描述里带标签词的：走 summary 路径（没问模型），面板上仍是这一张有标签 → 记 1
{
	const wsS = join(root, 'ws-summary');
	mkdirSync(wsS);
	const sumPath = emojiOnlyDb('summary', [
		{ file: 'a.png', bytes: PNG, usage: 9, description: '柴犬笑' },
		{ file: 'a.png', bytes: PNG, usage: 8, description: '柴犬笑' }
	]);
	let asked = 0;
	const res = await importMaiBotExtras({ dbPath: sumPath, slang, stickers, workspacePath: wsS, vision: async () => { asked++; return '卖萌、可爱'; }, maxEmojis: 5 });
	assert.equal(res.emojis, 1);
	assert.equal(res.emojiDup, 1);
	assert.equal(res.emojiTagged, 1, 'summary 捡出标签的，这一张也算有标签');
	assert.equal(asked, 0, 'summary 已经够用，不必问模型');
	const row = stickers.collected().find((x) => x.workspacePath === wsS);
	assert.deepEqual(row.tags, ['柴犬笑'], '标签来自 summary');
	assert.equal(row.tagsBy, 'summary');
}

assert.throws(() => readMaiBotExtras(join(root, 'nope.db')), /找不到/);

// ── #118：面板点「导入」这条路也要打标 ──
// 路由得把看图能力传下去、并且等导入跑完再回（不等就只回一个 ok，面板显示「导入了 undefined 张」）
{
	const ws4 = join(root, 'ws-route');
	mkdirSync(ws4);
	let sent = null;
	await handleV07Route({
		method: 'POST', path: '/import/maibot-extras/apply', url: new URL('http://localhost/import/maibot-extras/apply'),
		req: {}, res: {}, send: (status, obj) => { sent = { status, ...obj }; },
		readBody: async () => JSON.stringify({ dbPath: newPath }), sameOrigin: () => true,
		deps: {
			db, getConfig: () => ({}), saveConfig: () => {}, stickers, slang,
			gateway: { workspacePath: () => ws4, titleOf: (c) => c },
			llmRouter: { call: async () => '卖萌、可爱' }
		}
	});
	assert.equal(sent.ok, true);
	assert.equal(sent.emojis, 1, '路由要等导入跑完再回（不等就只回一个 ok，面板显示「导入了 undefined 张」）');
	assert.equal(sent.emojiTagged, 1, '打上标签的张数要报出来');
	const row = stickers.collected().find((x) => x.workspacePath === ws4);
	assert.deepEqual(row.tags, ['卖萌', '可爱'], '标签真写进 kv 里了（路由要把 vision 传下去）');
}

rmSync(root, { recursive: true, force: true });
console.log('✓ 麦麦表情 / 表达方式 / 黑话：两代表结构、按聊天分、全局补进所有聊天、过滤、不重复');
console.log('✓ 麦麦导入的表情也看图打标（kv 里真的有了标签）');
console.log('✓ 重复导入的老表情不吃打标额度，真正要打标的新图照样打上（#118）');
console.log('✓ 打上标签的张数按文件算，同图两条记录只算一张');
