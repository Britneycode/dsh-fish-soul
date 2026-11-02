// 站内搜索来源：BiliClient.search() 的解析 + BiliBrowser.candidates() 里当来源（受开关和每日额度约束）。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-search-'));
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { BiliClient } = await import('../lib/channels/bilibili.js');
const { BiliBrowser } = await import('../lib/browse.js');

const db = openDatabase();
const reqs = [];
const okj = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { 'content-type': 'application/json' } });

const fetchImpl = async (url, init = {}) => {
	const u = new URL(String(url));
	reqs.push({ path: u.pathname, search: u.search, init });
	switch (u.pathname) {
		case '/x/web-interface/wbi/search/type':
			return okj({
				result: [
					{ bvid: 'BVsearch1', aid: 111, title: '<em class="keyword">插件</em> 教程 &amp; 踩坑', author: '某UP' },
					{ bvid: 'BVsearch2', aid: 112, title: '大肥鱼的日常', author: '云大人' },
					{ title: '没有 bvid 的推广位' }
				]
			});
		case '/x/web-interface/nav':
			return okj({ isLogin: true, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } });
		default:
			return new Response(JSON.stringify({ code: -404, message: 'nope' }), { status: 200 });
	}
};

const client = new BiliClient({ fetchImpl, authPath: join(home, 'bili-auth.json') });
client.auth = { cookies: { SESSDATA: 's', bili_jct: 'JCT', DedeUserID: '999', buvid3: 'b3' }, uid: '999', uname: '鱼', refreshToken: '', devId: 'D', savedAt: 0 };

// ── 1. search()：带 wbi、去 HTML 标签、还原实体、丢掉没有 bvid 的 ──
{
	const got = await client.search('插件', 8);
	assert.equal(got.length, 2, '没有 bvid 的丢掉');
	assert.equal(got[0].bvid, 'BVsearch1');
	assert.equal(got[0].title, '插件 教程 & 踩坑', '去掉 <em> 标签、还原 &amp;');
	assert.equal(got[0].owner, '某UP');
	assert.equal(got[0].source, 'search', '来源标成 search');
	assert.equal(got[0].cid, '', '搜索结果没有 cid，靠后面 view 补');
	assert.equal(got[1].aid, '112');

	const hit = reqs.find((r) => r.path === '/x/web-interface/wbi/search/type');
	const q = new URLSearchParams(hit.search);
	assert.equal(q.get('search_type'), 'video');
	assert.equal(q.get('keyword'), '插件');
	assert.ok(q.get('w_rid'), '走了 wbi 签名');

	const before = reqs.length;
	assert.deepEqual(await client.search('   ', 8), [], '空关键词直接返回，不发请求');
	assert.equal(reqs.length, before, '空关键词没有网络请求');
	console.log('✓ search()：只读、wbi、去标签、丢无 bvid');
}

// ── 2. 谁定关键词：填了词表用词表，留空让她自己按最近看过的提 ──
{
	const clock = { now: () => Date.now(), getRoleDateParts: () => ({ dateStr: '2030-01-01' }) };
	const cfg = { enabled: true, browse: { enabled: true, search: true, searchKeywords: ['大肥鱼'], searchPerDay: 5 } };
	let draftReply = '烤冷面';
	const drafts = [];
	const br = new BiliBrowser({
		db, clock, client, getConfig: () => cfg, log: () => {},
		callLlm: async (p) => { drafts.push(p); return draftReply; },
		persona: () => ({ name: '鱼' }), watchDelayMs: [0, 0]
	});
	br.client.followingVideos = async () => [];
	br.client.recommend = async () => [];
	br.client.popular = async () => [];

	// 放一条"看过"，给她提词当原料
	db.prepare("INSERT INTO bili_seen (bvid, aid, title, owner_name, source, impression, skipped, liked, memory_id, seen_at, seen_real_at) VALUES ('BVold1','1','烤冷面到底多好吃','UP','recommend','',0,0,0,0,1)").run();

	// 填了词表 → 用词表，不动模型
	assert.equal(await br.nextSearchKeyword(), '大肥鱼', '有词表就用词表');
	assert.equal(drafts.length, 0, '有词表时不叫模型');

	// 词表留空 → 她自己提
	cfg.browse.searchKeywords = [];
	assert.equal(await br.nextSearchKeyword(), '烤冷面', '词表空时用她提的词');
	assert.equal(drafts.length, 1, '提词只叫一次模型');
	assert.match(drafts[0], /你最近刷到这些视频/, '把最近看过的当原料');
	assert.match(drafts[0], /只输出一个 2-8 字的搜索词/);

	// 模型输出带引号/换行也要能用
	draftReply = '「猫猫」\n（这个应该被忽略）';
	assert.equal(await br.nextSearchKeyword(), '猫猫', '去掉引号、只取第一行');

	// 额度用完 → 不搜，也不叫模型
	const before = drafts.length;
	cfg.browse.searchPerDay = 0;
	assert.equal(await br.nextSearchKeyword(), '', '额度 0 = 不搜');
	assert.equal(drafts.length, before, '没额度时连提词都不叫');

	// 没看过任何视频 → 没原料，不搜
	cfg.browse.searchPerDay = 5;
	db.prepare("DELETE FROM bili_seen").run();
	const noBasis = await br.nextSearchKeyword();
	assert.equal(noBasis, '', '一条都没看过就想不出词');
	console.log('✓ 关键词：词表优先 / 留空她自己提 / 额度与原料都卡住');
}

console.log('\n站内搜索来源全部通过');
