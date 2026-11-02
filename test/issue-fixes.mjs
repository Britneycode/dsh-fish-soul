// #26 / #27：配置文件防丢、聊完自动记不重复、联网工具不被筛掉、B站 @我的 / 收藏 / 弹幕。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-issues-'));
process.env.DSH_HOME = home;
const { readConfigFile, saveConfigFile } = await import('../lib/index.js');
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const sm = await import('../lib/soul-memory.js');
const { ChatGateway, WEB_TOOLS } = await import('../lib/gateway.js');
const { BiliClient, sampleDanmaku } = await import('../lib/channels/bilibili.js');
const { BiliBrowser } = await import('../lib/browse.js');
const { BiliSocial } = await import('../lib/social.js');

// ── 1. 配置文件：BOM 能读、坏文件拒绝保存且原样不动、正常合并不丢 accessToken ──
{
	const p = join(home, 'cfg.json');
	writeFileSync(p, '\uFEFF' + JSON.stringify({ qq: { accessToken: 'TOKEN43', wsUrl: 'ws://x' }, embedding: { apiKey: 'k' } }), 'utf8');
	assert.equal(readConfigFile(p).ok, true, '带 BOM 也能读');
	saveConfigFile({ qq: { enabled: true, interject: { enabled: true } } }, p);
	const after = JSON.parse(readFileSync(p, 'utf8'));
	assert.equal(after.qq.accessToken, 'TOKEN43', '保存 QQ 页不丢令牌');
	assert.equal(after.embedding.apiKey, 'k');
	assert.equal(after.qq.enabled, true);
	const broken = '{ "qq": { "accessToken": "T", }, }';
	writeFileSync(p, broken, 'utf8');
	assert.equal(readConfigFile(p).ok, false);
	assert.throws(() => saveConfigFile({ qq: { enabled: false } }, p), /格式不对/);
	assert.equal(readFileSync(p, 'utf8'), broken, '读不懂的文件不覆盖');
	writeFileSync(p, '[1,2]', 'utf8');
	assert.equal(readConfigFile(p).ok, false, '最外层不是对象');
	assert.deepEqual(readConfigFile(join(home, 'none.json')), { ok: true, value: {} });
	console.log('✓ 配置文件：BOM、坏文件拒绝覆盖、合并不丢 accessToken');
}

const db = openDatabase();

// ── 2. 聊完自动记：「我」说的只记一份（self），同一轮里同义句不写两遍 ──
{
	const out = {
		memories: [
			{ who: '我', kind: 'event', content: '我刚下课就瘫着刷B站美食区。', importance: 2 },
			{ who: '阿锋', kind: 'fact', content: '阿锋想吃加肠加蛋的烤冷面', importance: 2 },
			{ who: '阿锋', kind: 'fact', content: '阿锋想吃加肠加蛋的烤冷面。', importance: 2 },
			{ who: '阿树', kind: 'event', content: '我暗示想跟他一起去吃烤冷面', importance: 2 }
		],
		self: [{ content: '我刚下课就瘫着刷B站美食区', importance: 2 }, { content: '我暗示想跟他一起去吃烤冷面。', importance: 2 }],
		summary: ''
	};
	const dg = new sm.ChatDigester({ db, clock: { now: () => Date.now() }, journal: new sm.ChatJournal(), worker: null, getConfig: () => ({ enabled: true }),
		callLlm: async () => JSON.stringify(out), related: () => [], personaName: () => '阿树' });
	const prompts = [];
	const dg2 = new sm.ChatDigester({ db, clock: { now: () => Date.now() }, journal: new sm.ChatJournal(), worker: null, getConfig: () => ({ enabled: true }),
		callLlm: async (x) => { prompts.push(x); return '{}'; }, related: () => [], personaName: () => '阿树' });
	await dg.run('bili:576', [{ who: '阿锋', ownerId: 'user:576', text: '下课了吗' }, { self: true, text: '刚下课，瘫着刷美食区' }]);
	const rows = db.prepare("SELECT owner_id, content FROM memory WHERE channel_id = 'bili:576' AND kind <> 'episode'").all();
	const count = (re) => rows.filter((r) => re.test(r.content)).length;
	assert.equal(count(/刷B站美食区/), 1, '「我」说的只记一份');
	assert.equal(rows.find((r) => /刷B站美食区/.test(r.content)).owner_id, 'self', '记在她自己名下，不落到对方');
	assert.equal(count(/加肠加蛋/), 1, '同一轮同义句只写一次');
	assert.equal(count(/暗示/), 1, '人格名署名也当她自己');
	await dg2.run('bili:576', [{ who: '阿锋', ownerId: 'user:576', text: '在吗' }]);
	assert.match(prompts[0], /"我"自己说的、做的只放 self/);
	assert.equal(sm.sameMeaning('我刚下课就瘫着刷B站美食区。', '我刚下课就瘫着刷B站美食区'), true);
	assert.equal(sm.sameMeaning('今天吃了烤冷面', '明天要去考试'), false);
	console.log('✓ 聊完自动记：她自己说的只记一份、同轮同义句去重');
}

// ── 3. 联网工具：全局表里查不到也放行；收窄报错时去掉联网工具重试 ──
{
	const fake = { ctx: { tools: { get: (n) => (n.startsWith('fish_') || n === 'remember' ? {} : undefined) } }, log: () => {} };
	const allow = ChatGateway.prototype.allowedTools.call(fake, null);
	for (const n of WEB_TOOLS) assert.ok(allow.includes(n), `${n} 不被筛掉`);
	const calls = [];
	const agentCtx = { tools: { restrict: ({ allow: a }) => { calls.push(a); if (a.includes('web_search')) throw new Error('unknown tool web_search'); } } };
	const gw = Object.assign(Object.create(ChatGateway.prototype), fake, { ctx: { ...fake.ctx } });
	await gw.setupAgent(agentCtx);
	assert.equal(calls.length, 2, '报错后重试一次');
	assert.ok(!calls[1].includes('web_search'));
	console.log('✓ 联网工具：查不到也放行，宿主不认时退回');
}

// ── 4. B站：@我的 归一化、收藏、弹幕抽样、评论区 @ 也回（默认关）──
{
	const reqs = [];
	const st = { at: [], reply: [] };
	const okj = (data) => new Response(JSON.stringify({ code: 0, message: '0', data }), { headers: { 'content-type': 'application/json' } });
	const dmXml = '<?xml version="1.0"?><i>' + ['哈哈哈', '前方高能', '哈哈哈', '好可爱&amp;好看', '1', '泪目'].map((t, i) => `<d p="${i * 10}.5,1,25,16777215,0,0,x,1">${t}</d>`).join('') + '</i>';
	const fetchImpl = async (url, init = {}) => {
		const u = new URL(url);
		reqs.push({ path: u.pathname, q: u.searchParams, init });
		switch (u.pathname) {
			case '/x/msgfeed/at': return okj({ items: st.at });
			case '/x/msgfeed/reply': return okj({ items: st.reply });
			case '/x/v2/reply/add': return okj({ rpid_str: 'r1' });
			case '/x/v3/fav/folder/created/list-all': return okj({ list: [{ id: 3001, attr: 1 }, { id: 3000, attr: 0 }] });
			case '/x/v3/fav/resource/deal': return okj({});
			case '/x/v1/dm/list.so': return new Response(dmXml);
			case '/x/web-interface/view': return okj({ bvid: 'BV1', aid: 11, cid: 22, title: '烤冷面教程', desc: '', owner: { name: 'UP' }, stat: { view: 1 } });
			case '/x/player/wbi/v2': return okj({ subtitle: { subtitles: [] } });
			case '/x/v2/reply/wbi/main': return okj({ replies: [] });
			case '/x/web-interface/nav': return okj({ isLogin: true, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } });
			default: return new Response(JSON.stringify({ code: -404, message: 'nope' }));
		}
	};
	const client = new BiliClient({ fetchImpl, authPath: join(home, 'bili-auth.json') });
	client.auth = { cookies: { SESSDATA: 's', bili_jct: 'JCT', DedeUserID: '999', buvid3: 'b3' }, uid: '999', uname: '鱼', refreshToken: '', devId: 'D', savedAt: 0 };
	const nowS = Math.floor(Date.now() / 1000);
	st.at = [
		{ id: 71, user: { mid: 555, nickname: '路人' }, item: { type: 'reply', business_id: 1, subject_id: 9001, source_id: 81, root_id: 80, title: '别人的视频', source_content: '@鱼 你看这个' }, at_time: nowS - 50 },
		{ id: 72, user: { mid: 556 }, item: { type: 'dynamic', business_id: 17, subject_id: 1, source_id: 2 }, at_time: nowS }
	];
	const at = await client.atFeed();
	assert.equal(at.length, 1, '只要评论区里的 @');
	assert.deepEqual({ id: at[0].id, kind: at[0].kind, type: at[0].type, oid: at[0].oid, rpid: at[0].rpid, root: at[0].root }, { id: 'at:71', kind: 'at', type: 1, oid: '9001', rpid: '81', root: '80' });

	await client.favorite('11');
	const fav = reqs.find((r) => r.path === '/x/v3/fav/resource/deal');
	assert.equal(new URLSearchParams(fav.init.body).get('add_media_ids'), '3000', '收进默认收藏夹');
	assert.equal(new URLSearchParams(fav.init.body).get('rid'), '11');
	await client.favorite('12');
	assert.equal(reqs.filter((r) => r.path === '/x/v3/fav/folder/created/list-all').length, 1, '收藏夹 id 记住了');

	const dm = await client.danmaku('22', 12);
	assert.deepEqual(dm, ['哈哈哈', '前方高能', '好可爱&好看', '泪目'], '去重、去太短、解实体');
	assert.equal(sampleDanmaku(Array.from({ length: 100 }, (_, i) => ({ t: i, text: `弹幕${i}` })), 4).length, 4);

	// 刷视频：开了收藏才问、模型说 [收藏] 才收、每天有上限；弹幕进提示
	const clock = { now: () => Date.now(), getRoleDateParts: () => ({ dateStr: '2030-01-01' }) };
	const cfg = { enabled: true, browse: { enabled: true, favorite: false, favoritePerDay: 1 } };
	const prompts = [];
	const br = new BiliBrowser({ db, clock, client, getConfig: () => cfg, callLlm: async (p) => { prompts.push(p); return '学到了，下次自己做 [收藏]'; }, watchDelayMs: [0, 0] });
	let w = await br.watch({ bvid: 'BV1' }, false, false, br.cfg().favorite);
	assert.equal(w.favorited, false, '默认关');
	assert.doesNotMatch(prompts[0], /\[收藏\]/);
	assert.match(prompts[0], /弹幕（按时间抽了几条）：哈哈哈/);
	db.prepare("DELETE FROM bili_seen").run();
	cfg.browse.favorite = true;
	w = await br.watch({ bvid: 'BV1' }, false, false, true);
	assert.equal(w.favorited, true);
	assert.match(prompts[1], /\[收藏\]/);
	assert.equal(w.impression.includes('[收藏]'), false);
	assert.equal(br.recent(1)[0].favorited, true);
	assert.equal(br.favoritedToday(), 1);
	db.prepare("DELETE FROM bili_seen").run();
	const favBefore = reqs.filter((r) => r.path === '/x/v3/fav/resource/deal').length;
	w = await br.watch({ bvid: 'BV1' }, false, false, true);
	assert.equal(w.favorited, false, '今天收够了');
	assert.equal(reqs.filter((r) => r.path === '/x/v3/fav/resource/deal').length, favBefore);
	cfg.browse.danmaku = false;
	db.prepare("DELETE FROM bili_seen").run();
	await br.watch({ bvid: 'BV1' }, false, false, false);
	assert.doesNotMatch(prompts.at(-1), /弹幕/, '关了就不看弹幕');

	// 评论区 @：默认不看；开了 atMe 第一次只记位置，之后新的 @ 才回
	const scfg = { enabled: true, masterUid: '777', comments: { enabled: true, perHour: 5 } };
	const sprompts = [];
	const social = new BiliSocial({ db, clock, client, getConfig: () => scfg, callLlm: async (p) => { sprompts.push(p); return '哈哈看到了'; }, replyGapMs: 0, postRealGapMs: 0 });
	await social.pollComments();
	assert.equal(reqs.filter((r) => r.path === '/x/msgfeed/at').length, 1, '没开 atMe 不看 @（只有上面客户端测的那一次）');
	scfg.comments.atMe = true;
	await social.pollComments();
	assert.ok(getKv(db, 'bili.comments.atCursor', null), '第一次只记位置');
	assert.equal(reqs.filter((r) => r.path === '/x/v2/reply/add').length, 0);
	st.at = [{ id: 73, user: { mid: 557, nickname: '新朋友' }, item: { type: 'reply', business_id: 1, subject_id: 9002, source_id: 91, root_id: 0, title: '猫猫视频', source_content: '@鱼 快来看' }, at_time: nowS + 5 }, ...st.at];
	const r = await social.pollComments();
	assert.equal(r.replied, 1);
	const add = new URLSearchParams(reqs.filter((x) => x.path === '/x/v2/reply/add').at(-1).init.body);
	assert.deepEqual([add.get('oid'), add.get('root'), add.get('parent'), add.get('type')], ['9002', '91', '91', '1']);
	assert.match(sprompts.at(-1), /@ 了你，在别人的视频《猫猫视频》下面/);
	console.log('✓ B站：@我的、收藏（默认关 / 每天上限）、弹幕抽样');
}
process.exit(0);
