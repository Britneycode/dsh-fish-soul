// 麦麦的表情包 / 表达方式 / 黑话导入：旧版（emoji/expression/jargon + chat_streams）和新版（images/expressions/jargons + chat_sessions）两代表结构。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMaiBotExtras, previewMaiBotExtras, importMaiBotExtras, emojiName, sniffImage } from '../lib/maibot-extras.js';
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
let r = importMaiBotExtras({ dbPath: oldPath, slang, stickers, workspacePath: ws });
assert.equal(r.emojis, 2);
assert.equal(r.expressions, 3, '像「自称机器人」的不收');
assert.equal(r.skipped, 1);
assert.equal(r.terms, 2);
assert.deepEqual(readdirSync(join(ws, '_stickers')).sort(), ['开心.png', '无语.gif']);
// 再导一次：不重复
r = importMaiBotExtras({ dbPath: oldPath, slang, stickers, workspacePath: ws });
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
r = importMaiBotExtras({ dbPath: oldPath, slang, stickers, workspacePath: null, expressions: false, jargons: false });
assert.ok(r.warnings.some((w) => /工作区/.test(w)));

// 新版表结构
const newPath = newDb();
const y = readMaiBotExtras(newPath);
assert.equal(y.schema, 'new');
assert.deepEqual(y.emojis.map((e) => e.name), ['一只猫猫在笑'], '只要 image_type = emoji');
assert.deepEqual(y.expressions.map((e) => [e.style, e.channelId]), [['说一声来了老弟', 'group:654321'], ['全局说法', 'global']]);
assert.deepEqual(y.jargons.map((j) => [j.term, j.channelId]), [['awsl', 'group:654321'], ['xswl', 'global']]);
r = importMaiBotExtras({ dbPath: newPath, slang, stickers, workspacePath: ws, maxEmojis: 5 });
assert.equal(r.emojis + r.emojiDup, 1, '同一张图（和旧库那张字节一样）算重复');

assert.throws(() => readMaiBotExtras(join(root, 'nope.db')), /找不到/);
rmSync(root, { recursive: true, force: true });
console.log('✓ 麦麦表情 / 表达方式 / 黑话：两代表结构、按聊天分、全局补进所有聊天、过滤、不重复');
