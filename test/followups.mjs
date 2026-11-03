// PR #41 拆出来的三小块：表情包随机抽取 / 站内搜索提词避免重复 / @ 读视频每轮上限。
// 这三块之前只有临时探针验过，没有回归保护 —— 补进 npm test。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-followups-');
process.env.DSH_HOME = home;
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { BiliBrowser } = await import('../lib/browse.js');
const { BiliSocial } = await import('../lib/social.js');

const db = openDatabase();
const clock = { now: () => Date.now(), getRoleDateParts: () => ({ dateStr: '2030-01-01' }) };

// ── 1. listStickers：超过 40 张时随机抽，不是固定取前 40 ──
{
	const ws = join(home, 'ws-stickers');
	const dir = join(ws, '_stickers');
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < 50; i++) writeFileSync(join(dir, `p${String(i).padStart(2, '0')}.png`), '');
	// listStickers 是纯文件操作，不依赖实例状态；用真实原型方法
	const listStickers = ChatGateway.prototype.listStickers;

	const a = listStickers.call({}, ws);
	const b = listStickers.call({}, ws);
	assert.equal(a.length, 40, '50 张只给 40 个名字');
	assert.ok(a.every((f) => f.startsWith('p') && f.endsWith('.png')), '只收图片');
	assert.notDeepEqual(a, b, '两次抽样不完全一样（说明洗过牌，不是固定取前 40）');

	// 多抽几次，确认后 10 张真的能出现（固定 slice 的话永远出现不了）
	const seen = new Set();
	for (let i = 0; i < 12; i++) for (const f of listStickers.call({}, ws)) seen.add(f);
	assert.equal(seen.size, 50, '多抽几次能把 50 张都覆盖到（后面的表情也能进提示词）');

	// 不超过 40 张时原样返回，不洗牌（保持稳定，别让文件名顺序每次跳）
	const ws2 = join(home, 'ws-small');
	const dir2 = join(ws2, '_stickers');
	mkdirSync(dir2, { recursive: true });
	for (let i = 0; i < 7; i++) writeFileSync(join(dir2, `q${i}.png`), '');
	const c = listStickers.call({}, ws2);
	const d = listStickers.call({}, ws2);
	assert.equal(c.length, 7);
	assert.deepEqual(c, d, '≤40 张时顺序稳定');

	// 目录不存在 → 空数组，不抛
	assert.deepEqual(listStickers.call({}, join(home, 'nope')), []);
	console.log('✓ 表情包：>40 张随机抽 40（后面的也能进提示词），≤40 张原样');
}

// ── 2. 站内搜索提词：把最近搜过的告诉模型，别一直搜同一个方向 ──
{
	const drafts = [];
	let reply = '烤冷面';
	const cfg = { enabled: true, browse: { enabled: true, search: true, searchKeywords: [], searchPerDay: 99 } };
	const br = new BiliBrowser({
		db, clock,
		client: { recommend: async () => [], popular: async () => [], followingVideos: async () => [], search: async () => [] },
		getConfig: () => cfg, log: () => {},
		callLlm: async (p) => { drafts.push(p); return reply; },
		persona: () => ({ name: '鱼' }), watchDelayMs: [0, 0]
	});
	db.prepare("INSERT INTO bili_seen (bvid, aid, title, owner_name, source, impression, skipped, liked, memory_id, seen_at, seen_real_at) VALUES ('BVf1','1','烤冷面到底多好吃','UP','recommend','',0,0,0,0,1)").run();

	// 第一次：没有历史，提示词里不该有「别重复」
	assert.equal(await br.nextSearchKeyword(), '烤冷面');
	assert.doesNotMatch(drafts.at(-1), /别重复/, '首次没有历史，不提"别重复"');
	assert.equal(br.recentKeywords()[0], '烤冷面', '第一次搜的词记下来了');

	// 第二次：提示词带上历史，并明确要求换方向
	reply = '猫猫';
	assert.equal(await br.nextSearchKeyword(), '猫猫');
	assert.match(drafts.at(-1), /别重复/, '第二次要求换方向');
	assert.match(drafts.at(-1), /烤冷面/, '把上次搜过的告诉模型');
	assert.deepEqual(br.recentKeywords(), ['猫猫', '烤冷面'], '最新的在最前');

	// 词表模式也记：重复的挪到最前，不重复追加
	cfg.browse.searchKeywords = ['插件'];
	assert.equal(await br.nextSearchKeyword(), '插件');
	assert.equal(br.recentKeywords()[0], '插件', '词表选中的也记');
	assert.equal(br.recentKeywords().filter((x) => x === '插件').length, 1, '同一个词不重复占位');

	// 最多留 5 个，超出的挤掉最旧的
	for (const w of ['a', 'b', 'c', 'd', 'e']) br.noteKeyword(w);
	assert.equal(br.recentKeywords().length, 5, '最多记 5 个');
	assert.equal(br.recentKeywords()[0], 'e', '最新在前');
	assert.equal(br.recentKeywords().includes('烤冷面'), false, '最旧的被挤掉');

	// 空词不记
	const before = br.recentKeywords().length;
	br.noteKeyword('   ');
	assert.equal(br.recentKeywords().length, before, '空词不记');
	console.log('✓ 提词：带最近搜过的词要求换方向，最多记 5 个，同一词不重复占位');
}

// ── 3. @ 读视频：一轮最多读 3 个，回复条数不受影响 ──
{
	const nowS = Math.floor(Date.now() / 1000);
	let viewCalls = 0;
	const readAids = [];
	const sent = [];
	let atItems = [];
	const cfg = { enabled: true, masterUid: '999', comments: { enabled: true, perHour: 99, atMe: true, atReadVideo: true } };
	const social = new BiliSocial({
		db, clock,
		client: {
			uid: '999', loggedIn: true, authInvalid: false,
			replyFeed: async () => [], atFeed: async () => atItems,
			viewByAid: async (aid) => { viewCalls++; readAids.push(String(aid)); return { bvid: 'BVr', aid: String(aid), cid: '22', title: 't', desc: 'd', tname: '' }; },
			subtitleText: async () => 'sub',
			replyComment: async (x) => { sent.push(x); return '1'; }
		},
		getConfig: () => cfg, log: () => {}, callLlm: async () => '看完了', replyGapMs: 0, postRealGapMs: 0
	});
	const at = (id, time) => ({
		id: `at:${id}`, kind: 'at', mid: '555', name: '阿锋', type: 1, oid: String(9000 + id),
		rpid: String(100 + id), root: '100', title: '视频', content: '@鱼 看看', target: '', time, uri: '', isComment: true
	});

	// 第一次只记位置，不回也不读
	atItems = [at(1, nowS - 10)];
	await social.pollComments();
	assert.equal(viewCalls, 0, '第一次只记位置，不读视频');
	assert.equal(sent.length, 0, '第一次不回');

	// 一起来了 6 条新 @：最多读 3 个，但 6 条都要回
	atItems = [at(1, nowS - 10), ...Array.from({ length: 6 }, (_, i) => at(10 + i, nowS + i))];
	viewCalls = 0; sent.length = 0; readAids.length = 0;
	await social.pollComments();
	assert.equal(viewCalls, 3, '一轮最多读 3 个视频（每条 2 次接口调用）');
	assert.equal(sent.length, 6, '回复条数不受读视频上限影响，6 条都回');
	assert.deepEqual(readAids, ['9010', '9011', '9012'], '读的是最早那 3 条，顺序稳定');

	// 关掉开关 → 一个都不读，但照常回（注意每条评论的 id 只能回一次，所以要用新 id）
	cfg.comments.atReadVideo = false;
	atItems = [at(1, nowS - 10), ...Array.from({ length: 6 }, (_, i) => at(10 + i, nowS + i)), ...Array.from({ length: 2 }, (_, i) => at(50 + i, nowS + 20 + i))];
	viewCalls = 0; sent.length = 0;
	await social.pollComments();
	assert.equal(viewCalls, 0, '关着不读视频');
	assert.equal(sent.length, 2, '关着照常回新评论');

	// 动态（type 11）不读：只有视频才有简介 / 字幕。同样用没回过的 id
	cfg.comments.atReadVideo = true;
	atItems = [at(1, nowS - 10), ...Array.from({ length: 6 }, (_, i) => at(10 + i, nowS + i)),
		...Array.from({ length: 2 }, (_, i) => ({ ...at(70 + i, nowS + 30 + i), type: 11 }))];
	viewCalls = 0; sent.length = 0;
	await social.pollComments();
	assert.equal(viewCalls, 0, 'type=11（动态）不读视频，它没有简介 / 字幕');
	assert.equal(sent.length, 2, '动态照常回');
	console.log('✓ @ 读视频：一轮最多 3 个、回复不受影响、关着不读、type=11 不读');
}

console.log('\nPR #41 拆分出的三块全部通过');