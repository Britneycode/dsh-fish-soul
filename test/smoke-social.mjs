// 自己发动态 / 作品、回评论区（v0.10，social.js + douyin-social.js）。由 smoke.mjs 调用。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function run(t) {
	const { assert, ok, call } = t;
	const { BiliClient } = await import('../lib/channels/bilibili.js');
	const { BiliSocial, cleanSocialText } = await import('../lib/social.js');
	const { LifeEngine } = await import('../lib/life.js');
	const { VirtualClock } = await import('../lib/clock.js');
	const { openDatabase, getKv, setKv } = await import('../lib/db.js');

	const home = mkdtempSync(join(tmpdir(), 'dsh-social-'));
	const prevHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
	const db = openDatabase(); process.env.DSH_HOME = prevHome;
	db.prepare("INSERT INTO person (canonical_id, display_name, bili_uid, first_seen_at, last_seen_at) VALUES ('p1', '阿二', '888', 0, 0)").run();

	// ── 假 B站：记下请求，回复我的列表可改 ──
	const reqs = [];
	const fs = { feed: [], createFail: false, replyFail: false };
	const fetchImpl = async (url, init = {}) => {
		const u = new URL(url);
		reqs.push({ path: u.pathname, q: u.searchParams, init });
		const okj = (data) => new Response(JSON.stringify({ code: 0, message: '0', data }), { headers: { 'content-type': 'application/json' } });
		switch (u.pathname) {
			case '/x/dynamic/feed/create/dyn':
				return fs.createFail ? new Response(JSON.stringify({ code: 4126117, message: '发布频率过高' })) : okj({ dyn_id_str: `9${reqs.length}` });
			case '/x/msgfeed/reply': return okj({ cursor: { is_end: true }, items: fs.feed });
			case '/x/v2/reply/add':
				return fs.replyFail ? new Response(JSON.stringify({ code: 12015, message: '需要验证码' })) : okj({ rpid_str: `r${reqs.length}` });
			default: return new Response(JSON.stringify({ code: -404, message: 'nope' }));
		}
	};
	const client = new BiliClient({ fetchImpl, authPath: join(home, 'bili-auth.json') });
	client.auth = { cookies: { SESSDATA: 's', bili_jct: 'JCT', DedeUserID: '999', buvid3: 'b3' }, uid: '999', uname: '鱼', refreshToken: '', devId: 'D', savedAt: 0 };

	// 1. 客户端：发动态（JSON + csrf + t.bilibili.com）、回复我的归一化、回评论表单
	{
		const id = await client.createDynamic('今天的云好像棉花糖');
		const r = reqs.at(-1);
		assert.equal(r.path, '/x/dynamic/feed/create/dyn');
		assert.equal(r.q.get('csrf'), 'JCT');
		assert.equal(r.init.method, 'POST');
		assert.equal(r.init.headers['Content-Type'], 'application/json');
		assert.equal(r.init.headers.Referer, 'https://t.bilibili.com/');
		assert.equal(r.init.headers.Origin, 'https://t.bilibili.com');
		const body = JSON.parse(r.init.body);
		assert.equal(body.dyn_req.content.contents[0].raw_text, '今天的云好像棉花糖');
		assert.match(body.dyn_req.upload_id, /^999_\d+_\d{4}$/);
		assert.ok(/^9\d+$/.test(id));
		await assert.rejects(client.createDynamic('  '), /空/);

		fs.feed = [
			{ id: 501, user: { mid: 888, nickname: '阿二B站' }, item: { business_id: 17, subject_id: 777000, source_id: 61, root_id: 0, title: '今天的云', source_content: '真的像！', target_reply_content: '' }, reply_time: 1000 },
			{ id: 0, user: { mid: 1 }, item: {} }
		];
		const feed = await client.replyFeed();
		assert.equal(feed.length, 1, '缺字段的条目丢掉');
		assert.deepEqual({ ...feed[0], uri: undefined }, { id: '501', mid: '888', name: '阿二B站', type: 17, oid: '777000', rpid: '61', root: '61', title: '今天的云', content: '真的像！', target: '', time: 1000, uri: undefined });
		await client.replyComment({ type: 17, oid: '777000', root: '61', parent: '61', message: '嘿嘿' });
		const f = new URLSearchParams(reqs.at(-1).init.body);
		assert.deepEqual(Object.fromEntries(f), { type: '17', oid: '777000', root: '61', parent: '61', message: '嘿嘿', plat: '1', csrf: 'JCT' });
		assert.equal(reqs.at(-1).init.headers['Content-Type'], 'application/x-www-form-urlencoded');
		assert.equal(cleanSocialText('动态：“今天好困 #日常# @某人 https://x.cn/a”', 100), '今天好困');
	}
	ok('B站客户端：发动态 / 回复我的 / 回评论');

	// 2. 发动态：开关、次数、间隔、[不发]、写进自己的记忆和动态
	let vt = Date.parse('2030-01-01T06:30:00Z'); // 14:30 UTC+8
	const clock = Object.assign(Object.create(VirtualClock.prototype), { scale: 1, now: () => vt });
	const cfg = { enabled: true, masterUid: '777', post: { enabled: false, perDay: 1 }, comments: { enabled: false, perHour: 2 } };
	const notes = [];
	let llmOut = '刚刷到一只猫在晒太阳，好想变成它';
	const prompts = [];
	const social = new BiliSocial({
		db, clock, client, getConfig: () => cfg, callLlm: async (p) => { prompts.push(p); return typeof llmOut === 'function' ? llmOut(p) : llmOut; },
		persona: () => ({ name: '鱼', brief: '一个爱睡觉的女生' }), note: (k, x) => notes.push([k, x]), replyGapMs: 0, postRealGapMs: 0, random: () => 0
	});
	const parts = clock.getRoleDateParts();
	assert.equal(social.maybePost({ parts, slot: { availability: 'idle' }, mood: '慵懒' }), false, '默认关');
	cfg.post.enabled = true;
	assert.equal(social.maybePost({ parts: { ...parts, hour: 3 }, slot: null }), false, '不在活跃时段');
	assert.equal(social.maybePost({ parts, slot: { availability: 'sleeping' } }), false, '睡着不发');
	assert.equal(social.maybePost({ parts, slot: { availability: 'idle', activity: '在家躺着' }, mood: '慵懒' }), true);
	const until = Date.now() + 2000;
	while (social.posting && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
	assert.match(prompts.at(-1), /慵懒/);
	assert.match(prompts.at(-1), /在家躺着/);
	assert.match(prompts.at(-1), /\[不发\]/);
	const row = db.prepare('SELECT * FROM social_post').get();
	assert.equal(row.content, '刚刷到一只猫在晒太阳，好想变成它');
	assert.ok(db.prepare("SELECT 1 FROM memory WHERE owner_id = 'self' AND content LIKE '我在B站发了条动态：%'").get(), '记进自己的记忆');
	assert.equal(social.postState(parts.dateStr).count, 1);
	assert.equal(social.maybePost({ parts, slot: { availability: 'idle' } }), false, '今天发够了');
	cfg.post.perDay = 3;
	assert.equal(social.maybePost({ parts, slot: { availability: 'idle' } }), false, '离上一条不到 3 小时');
	vt += 4 * 3600_000;
	const p2 = clock.getRoleDateParts();
	assert.equal(new BiliSocial({ db, clock, client, getConfig: () => cfg, callLlm: async () => '', random: () => 0.99, postRealGapMs: 0 }).maybePost({ parts: p2, slot: null }), false, '随机没抽中');
	llmOut = '[不发]';
	let r = await social.post({ parts: p2 });
	assert.equal(r.skipped, true);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM social_post').get().n, 1);
	assert.equal(social.postState(p2.dateStr).tries, 2, '[不发] 也算试过一次');
	// 再发一条：上一条出现在提示里免得重复；接口报错记 lastError
	llmOut = '晚饭吃了泡面';
	fs.createFail = true;
	r = await social.post({ parts: p2, force: true });
	assert.equal(r.ok, false);
	assert.match(social.lastError, /发布频率过高/);
	assert.match(prompts.at(-1), /刚刷到一只猫在晒太阳/);
	fs.createFail = false;
	r = await social.post({ parts: p2, force: true });
	assert.equal(r.ok, true);
	assert.ok(notes.some(([k, x]) => k === 'post' && x.text === '晚饭吃了泡面'));
	assert.equal(social.status().post.recent[0].content, '晚饭吃了泡面');
	// 生活引擎每 tick 问一次
	const asked = [];
	const life = new LifeEngine({ db, clock, getConfig: () => ({ proactive: { enabled: false, activeHours: [8, 24] } }), callLlm: async () => null, deliver: async () => false, social: (x) => asked.push(x) });
	await life.tick();
	assert.equal(asked.length, 1);
	assert.equal(asked[0].parts.dateStr, p2.dateStr);
	assert.deepEqual(asked[0].activeHours, [8, 24]);
	ok('自己发动态：默认关 / 活跃时段 / 醒着 / 每天条数 / 间隔 / [不发] / 记忆 / 每 tick 问一次');

	// 3. 回评论：第一次只记位置；自己的不回；[不回]；每小时上限；认识的人 / 主人；失败记下
	{
		const nowS = Math.floor(Date.now() / 1000);
		const item = (id, mid, name, content, time, extra = {}) => ({ id, user: { mid, nickname: name }, item: { business_id: 17, subject_id: 777000, source_id: id * 10, root_id: 0, title: '晚饭吃了泡面', source_content: content, target_reply_content: '', ...extra }, reply_time: time });
		fs.feed = [item(1, 555, '路人甲', '旧评论', nowS - 100)];
		assert.equal((await social.pollComments()).ok, false, '默认关');
		cfg.comments.enabled = true;
		const before = reqs.length;
		r = await social.pollComments();
		assert.equal(r.ok, true);
		assert.equal(r.replied, 0, '第一次只记位置，不回旧的');
		assert.ok(getKv(db, 'bili.comments.cursor', null));
		assert.equal(reqs.slice(before).filter((x) => x.path === '/x/v2/reply/add').length, 0);

		llmOut = (p) => (/加微信/.test(p) ? '[不回]' : /主人/.test(p) ? '收到主人～' : /阿二/.test(p) ? '你也来啦' : '谢谢你');
		fs.feed = [
			item(5, 999, '鱼', '我自己的楼中楼', nowS - 5),
			item(4, 666, '广告号', '加微信领福利', nowS - 40),
			item(3, 888, '阿二B站', '泡面加蛋了吗', nowS - 20, { root_id: 30, source_id: 31, target_reply_content: '晚饭吃了泡面' }),
			item(2, 777, '主人B站', '早点睡', nowS - 30),
			item(1, 555, '路人甲', '旧评论', nowS - 100)
		];
		r = await social.pollComments();
		assert.deepEqual([r.replied, r.skipped], [2, 1], '每小时上限 2：主人和阿二回了，广告不回');
		const adds = reqs.filter((x) => x.path === '/x/v2/reply/add').slice(-2).map((x) => Object.fromEntries(new URLSearchParams(x.init.body)));
		assert.equal(adds[0].message, '收到主人～');
		assert.equal(adds[0].parent, '20');
		assert.equal(adds[1].message, '你也来啦');
		assert.deepEqual([adds[1].root, adds[1].parent], ['30', '31'], '楼中楼：root 是楼主，parent 是对方那条');
		assert.match(prompts.find((p) => /泡面加蛋/.test(p)), /你认识，是阿二/);
		assert.match(prompts.find((p) => /泡面加蛋/.test(p)), /ta 回的是你说的：晚饭吃了泡面/);
		assert.ok(!prompts.some((p) => /我自己的楼中楼/.test(p)), '自己的不回');
		assert.equal(db.prepare("SELECT status FROM social_reply WHERE notify_id = '5'").get().status, 'skipped');
		// 再看一次：都处理过了，不重复回
		const n = reqs.filter((x) => x.path === '/x/v2/reply/add').length;
		r = await social.pollComments();
		assert.equal(reqs.filter((x) => x.path === '/x/v2/reply/add').length, n, '不重复回');
		// 新评论但这小时额度满了：先不处理，过了一小时再回
		fs.feed = [item(6, 555, '路人甲', '好可爱', nowS)];
		r = await social.pollComments();
		assert.equal(r.replied, 0, '额度满了先不回');
		assert.equal(db.prepare("SELECT 1 FROM social_reply WHERE notify_id = '6'").get(), undefined, '留着下次');
		db.prepare("UPDATE social_reply SET created_real_at = created_real_at - 7200000").run();
		fs.replyFail = true;
		r = await social.pollComments();
		assert.equal(db.prepare("SELECT status FROM social_reply WHERE notify_id = '6'").get().status, 'failed');
		assert.match(social.lastError, /需要验证码/);
		fs.replyFail = false;
		const st = social.status();
		assert.equal(st.comments.recent[0].status, 'failed');
		assert.ok(!st.comments.recent.some((x) => x.content === '旧评论'), '旧评论不出现在列表里');
		assert.ok(notes.some(([k, x]) => k === 'comment' && /回了 阿二B站/.test(x.reason)));
		// 超过一天的不回
		fs.feed = [item(7, 555, '路人甲', '很久以前', nowS - 2 * 86400)];
		setKv(db, 'bili.comments.cursor', { time: 0 });
		r = await social.pollComments();
		assert.equal(db.prepare("SELECT status FROM social_reply WHERE notify_id = '7'").get().status, 'stale');
	}
	ok('回评论：第一次不回旧的 / 自己的不回 / [不回] / 每小时上限 / 楼中楼 / 认识的人 / 失败记下 / 不重复 / 太旧不回');

	// 5. 抖音：发图文（画卡片 → 创作者中心），回作品评论（第一次只记、作者自己的不回、要验证就停）
	{
		const { DouyinSocial, noteTitle, commentKey } = await import('../lib/douyin-social.js');
		const { readFileSync, existsSync } = await import('node:fs');
		assert.equal(noteTitle('今天下雨了。好想睡觉'), '今天下雨了');
		assert.equal(noteTitle('一'.repeat(30)), '一'.repeat(20));
		assert.notEqual(commentKey('1', 'a', 'b'), commentKey('1', 'a', 'c'));
		const locks = [];
		const host = { running: true, loggedIn: true, exclusive: async (label, fn) => { locks.push(label); return await fn(); } };
		const dcfg = { enabled: true, masterName: '主人抖音', post: { enabled: true, perDay: 1 }, comments: { enabled: false, perHour: 2 } };
		const dyd = { published: [], replies: [], publishResult: { ok: true }, replyResult: () => ({ ok: true }), works: [{ id: '7001', kind: 'note', title: '晚饭吃了泡面' }], comments: new Map(), opened: 0 };
		const driver = {
			renderCard: async (text, foot) => { dyd.card = [text, foot]; return Buffer.from('89504e470d0a1a0a', 'hex'); },
			publishNote: async (x) => { dyd.published.push({ ...x, png: existsSync(x.file) ? readFileSync(x.file).subarray(0, 4).toString('hex') : '' }); return dyd.publishResult; },
			listWorks: async () => dyd.works,
			openWork: async (w) => { dyd.opened++; return { ok: dyd.comments.has(w.id) }; },
			listComments: async () => (dyd.comments.get('7001') ?? []).map((c, i) => ({ i, canReply: true, isAuthor: false, ...c })),
			reply: async (cm, text) => { const r = dyd.replyResult(cm); if (r.ok) dyd.replies.push([cm.author, text]); return r; }
		};
		const dnotes = [];
		const notify = [];
		let dyOut = '下雨天适合躺着\n什么都不想干';
		const dsocial = new DouyinSocial({
			db, clock, host, driver, getConfig: () => dcfg, callLlm: async (p) => { prompts.push(p); return typeof dyOut === 'function' ? dyOut(p) : dyOut; },
			persona: () => ({ name: '鱼', brief: '' }), note: (k, x) => dnotes.push([k, x]), notify: (k, t) => notify.push([k, t]),
			replyGapMs: 0, postRealGapMs: 0, random: () => 0, cardDir: join(home, 'cards')
		});
		let r = await dsocial.post({ force: true });
		assert.equal(r.ok, true, r.error);
		assert.match(prompts.at(-1), /文字卡片/);
		assert.equal(dyd.card[0], '下雨天适合躺着\n什么都不想干');
		assert.match(dyd.card[1], /^\d{4}\.\d{2}\.\d{2}$/);
		assert.deepEqual([dyd.published[0].title, dyd.published[0].text, dyd.published[0].png], ['下雨天适合躺着', '下雨天适合躺着\n什么都不想干', '89504e47']);
		assert.ok(locks.includes('发抖音图文'), '在浏览器锁里发');
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM social_post WHERE platform = 'douyin'").get().n, 1);
		assert.ok(db.prepare("SELECT 1 FROM memory WHERE owner_id = 'self' AND content LIKE '我在抖音发了条图文：%'").get());
		assert.equal(dsocial.postState(clock.getRoleDateParts().dateStr).count, 1, '和 B站 分开计数');
		// 创作者中心没登录：提醒主人；要验证：6 小时内不再试
		dyd.publishResult = { ok: false, code: 'NOT_LOGGED_IN', error: '创作者中心没登录' };
		r = await dsocial.post({ force: true });
		assert.equal(r.ok, false);
		assert.ok(notify.some(([k]) => k === 'douyin.creator'));
		dyd.publishResult = { ok: false, code: 'NEEDS_VERIFY', error: '抖音要验证' };
		r = await dsocial.post({ force: true });
		assert.ok(dsocial.blockedUntil > Date.now());
		assert.ok(notify.some(([k, t]) => k === 'douyin.verify' && /验证/.test(t)));
		assert.equal(dsocial.ready, false);
		assert.match((await dsocial.post({ force: true })).error, /验证/);
		dsocial.blockedUntil = 0;
		dyd.publishResult = { ok: true };

		// 评论：关着不看；第一次只记；之后回新的
		assert.equal((await dsocial.pollComments()).ok, false);
		dcfg.comments.enabled = true;
		dyd.comments.set('7001', [{ author: '路人乙', content: '旧评论' }]);
		r = await dsocial.pollComments();
		assert.deepEqual([r.ok, r.replied], [true, 0], '第一次只记');
		assert.equal(dyd.replies.length, 0);
		dyOut = (p) => (/引流/.test(p) ? '[不回]' : /主人/.test(p) ? '嗯嗯知道啦' : '哈哈谢谢');
		dyd.comments.set('7001', [
			{ author: '鱼', content: '我自己说的', isAuthor: true },
			{ author: '路人乙', content: '旧评论' },
			{ author: '主人抖音', content: '早点睡' },
			{ author: '营销号', content: '主页引流' },
			{ author: '路人丙', content: '好可爱' },
			{ author: '路人丁', content: '再来一条' }
		]);
		r = await dsocial.pollComments();
		assert.deepEqual([r.replied, r.skipped], [2, 1], '每小时 2 条：主人 + 路人丙，营销号不回，路人丁等下次');
		assert.deepEqual(dyd.replies, [['主人抖音', '嗯嗯知道啦'], ['路人丙', '哈哈谢谢']]);
		assert.match(prompts.findLast((p) => /早点睡/.test(p)), /是你的主人/);
		assert.match(prompts.findLast((p) => /早点睡/.test(p)), /在你的图文《晚饭吃了泡面》下面/);
		assert.ok(!prompts.some((p) => /我自己说的/.test(p)), '作者自己的不回');
		// 额度恢复后：页面被换掉了就重开再回；要验证就停下、不记，验证完再回
		db.prepare("UPDATE social_reply SET created_real_at = created_real_at - 7200000 WHERE platform = 'douyin'").run();
		let tries = 0;
		dyd.replyResult = () => (++tries === 1 ? { ok: false, code: 'NOT_FOUND' } : { ok: false, code: 'NEEDS_VERIFY', error: '抖音要验证（短信 / 滑块）才能发评论' });
		const opened = dyd.opened;
		r = await dsocial.pollComments();
		assert.equal(tries, 2);
		assert.equal(dyd.opened, opened + 2, '没找到就重开一次');
		assert.ok(dsocial.blockedUntil > Date.now());
		assert.equal(db.prepare("SELECT 1 FROM social_reply WHERE platform = 'douyin' AND content = '再来一条'").get(), undefined, '要验证的那条留着');
		assert.equal((await dsocial.pollComments()).ok, false, '等验证期间不看');
		dsocial.blockedUntil = 0;
		dyd.replyResult = () => ({ ok: true });
		r = await dsocial.pollComments();
		assert.equal(r.replied, 1);
		assert.deepEqual(dyd.replies.at(-1), ['路人丁', '哈哈谢谢']);
		assert.ok(dsocial.status().comments.recent.some((x) => x.name === '路人丁' && x.status === 'replied'));
	}
	ok('抖音：发图文（卡片 + 标题 + 描述）/ 创作者中心没登录提醒 / 要验证就停 6 小时 / 回作品评论（第一次只记、作者不回、每小时上限、重开页面）');

	// 6. 抖音刷到的分享：能发抖音私信就发给抖音里的主人，不然走 QQ；抖音私信只放行分享
	{
		let dyTarget = 'douyin:主人抖音';
		const sent = [];
		const scfg = { masterQqUin: '10001', proactive: { enabled: true, activeHours: [0, 24], shareMaxPerDay: 5 } };
		const life2 = new LifeEngine({ db, clock, getConfig: () => scfg, callLlm: async () => null, deliver: async (c, reason, meta) => { sent.push([c, meta.origin]); return true; }, douyinShareTarget: () => dyTarget });
		db.prepare("DELETE FROM pending").run();
		setKv(db, 'share.day', null);
		let q = life2.queueShare({ platform: '抖音', title: '猫', author: 'UP', url: 'https://www.douyin.com/video/1', impression: '好笑' });
		assert.equal(q.ok, true, q.error);
		const row = db.prepare('SELECT channel, channel_id FROM pending WHERE id = ?').get(q.id);
		assert.deepEqual([row.channel, row.channel_id], ['douyin-private', 'douyin:主人抖音']);
		assert.equal(life2.isWhitelisted('douyin:主人抖音', scfg.proactive, 'share'), true);
		assert.equal(life2.isWhitelisted('douyin:主人抖音', scfg.proactive, 'user'), false, '抖音私信只放行分享');
		assert.equal(life2.isWhitelisted('douyin:别人', scfg.proactive, 'share'), false);
		await life2.tick();
		assert.deepEqual(sent.at(-1), ['douyin:主人抖音', 'share']);
		db.prepare("DELETE FROM pending").run();
		dyTarget = '';
		q = life2.queueShare({ platform: '抖音', title: '狗', author: '', url: 'https://www.douyin.com/video/2', impression: '可爱' });
		assert.equal(db.prepare('SELECT channel_id FROM pending WHERE id = ?').get(q.id).channel_id, 'private:10001', '抖音没连上就发 QQ');
		db.prepare("DELETE FROM pending").run();

		// 网关：抖音只在分享、发给主人、抖音连着时才主动开口
		const { ChatGateway } = await import('../lib/gateway.js');
		let dyConnected = false;
		const gw = new ChatGateway({
			ctx: { get: () => undefined, tools: { get: () => ({}) } }, db, clock: { now: () => Date.now() },
			getConfig: () => ({ douyin: { enabled: true, autoReply: true, masterName: '主人抖音' } }), log: () => {},
			channel: { connected: false }, douyin: { get connected() { return dyConnected; } },
			soul: { beginTurn() {}, nowLabel: () => '现在', resolvePerson() { return null; }, memorizeUnanswered() {} }
		});
		gw.ensureSession = async () => { throw new Error('到建会话这一步了'); };
		assert.equal(await gw.triggerProactive('douyin:主人抖音', 'x', { origin: 'share' }), false, '抖音没连上');
		dyConnected = true;
		assert.equal(await gw.triggerProactive('douyin:主人抖音', 'x', { origin: 'idle' }), false, '不是分享不主动');
		assert.equal(await gw.triggerProactive('douyin:别人', 'x', { origin: 'share' }), false, '只发给主人');
		await assert.rejects(gw.triggerProactive('douyin:主人抖音', 'x', { origin: 'share' }), /到建会话这一步了/);
	}
	ok('抖音刷到的分享：发到抖音私信里的主人（连不上就发 QQ）；抖音私信只放行分享');

	// 4. 设置页：保存开关和数量，状态里带出来
	if (call) {
		let p = await call('POST', '/channels/bili-config', { post: { enabled: true, perDay: 9 }, comments: { enabled: true, perHour: 4 } });
		assert.equal(p.json.ok, true);
		p = await call('GET', '/channels/state');
		const b = p.json.bili;
		assert.deepEqual(b.post, { enabled: true, perDay: 5 }, '每天最多 5 条');
		assert.deepEqual(b.comments, { enabled: true, perHour: 4 });
		assert.ok(b.social && b.social.post && Array.isArray(b.social.comments.recent));
		p = await call('POST', '/channels/bili-config', { post: { enabled: false }, comments: { enabled: false } });
		assert.equal(p.json.ok, true);
		p = await call('POST', '/bili/post-now', {});
		assert.equal(p.json.ok, false);
		p = await call('POST', '/channels/douyin-config', { post: { enabled: true, perDay: 2 }, comments: { enabled: true, perHour: 99 }, browse: { shareInDm: false } });
		assert.equal(p.json.ok, true);
		p = await call('GET', '/channels/state');
		const d = p.json.douyin;
		assert.deepEqual([d.post, d.comments, d.browse.shareInDm], [{ enabled: true, perDay: 2 }, { enabled: true, perHour: 30 }, false]);
		assert.ok(d.social && Array.isArray(d.social.post.recent));
		p = await call('POST', '/channels/douyin-config', { post: { enabled: false }, comments: { enabled: false }, browse: { shareInDm: true } });
		assert.equal(p.json.ok, true);
		p = await call('POST', '/douyin/post-now', {});
		assert.equal(p.json.ok, false);
		ok('设置页：发动态 / 回评论开关和数量（B站 / 抖音）');
	}
}
