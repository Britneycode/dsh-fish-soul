import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { tmpHome } from './_tmp.mjs';

const ok = (msg) => console.log('✓', msg);

const base = tmpHome('dy-wave12-');
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = base;

const keepAlive = setTimeout(() => {}, 120_000);

try {
	// ── 1. Browser.goto() 不清零单调 seq 游标 ──
	{
		const { Browser } = await import('../lib/channels/vendor/douyin-bridge/browser.mjs');
		const b = new Browser({ exe: '', userDataDir: base });
		b.ready = true;
		b.sessionId = 'S1';
		b.send = async (method) => (method === 'Runtime.evaluate' ? { result: { value: 'https://www.douyin.com/' } } : {});
		b.eval = async () => 'https://www.douyin.com/';
		b.seq = 42;
		b.events = [{ seq: 42, method: 'Network.webSocketFrameReceived' }];
		await b.goto('https://www.douyin.com/', { settleMs: 1 });
		assert.equal(b.seq, 42, 'goto() 后 seq 不能归零，否则旧游标永久落后');
		assert.equal(b.events.length, 0, 'goto() 照常清空 events 缓冲');
		ok('Browser.goto() 保持 seq 单调递增');
	}

	// ── 2. PB 解析：群 convId / 引用上下文 / 分享标题作者 + drainPushFrames 群 & selfSecUid ──
	{
		const { parseMessages } = await import('../lib/channels/vendor/douyin-bridge/douyin-api.mjs');
		const { drainPushFrames } = await import('../lib/channels/vendor/douyin-bridge/douyin-dm.mjs');
		const { mergeMessages, MEDIA } = await import('../lib/channels/vendor/douyin-bridge/media.mjs');

		const encVarint = (n) => {
			let v = BigInt(n);
			const out = [];
			while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
			out.push(Number(v));
			return Buffer.from(out);
		};
		const fVarint = (num, val) => Buffer.concat([encVarint((num << 3) | 0), encVarint(val)]);
		const fBytes = (num, val) => {
			const buf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
			return Buffer.concat([encVarint((num << 3) | 2), encVarint(buf.length), buf]);
		};

		const groupConv = '7512345678901234567:987654321098765432:0';
		const selfSec = 'MS4wLjABAAAAself1234567890';
		const msgPayload = JSON.stringify({
			text: '你看这段',
			desc: '橘猫翻跟头合集',
			author: '小橘日记',
			aweme_id: '7707911549709601777',
			reference_info: { hint: '之前那个搞笑视频呢', ref_message_id: '90071992547409991' },
		});
		const msgNode = Buffer.concat([
			fBytes(1, groupConv),
			fVarint(2, 2),
			fVarint(6, 7),
			fVarint(7, 12345678n),
			fBytes(8, msgPayload),
			fVarint(10, 1700000000000n),
			fBytes(14, selfSec),
			fVarint(17, 101n),
		]);
		const body301 = fBytes(301, fBytes(1, msgNode));
		const respPb = Buffer.concat([fVarint(1, 301), fBytes(4, 'OK'), fBytes(6, body301)]);

		const parsed = parseMessages(respPb, { selfSecUid: selfSec });
		assert.equal(parsed.messages.length, 1);
		const pm = parsed.messages[0];
		assert.equal(pm.convId, groupConv, '新版数字三段群 convId 要解出来');
		assert.equal(pm.fromMe, true, '命中 selfSecUid 要标成 fromMe: true');
		assert.equal(pm.shareTitle, '橘猫翻跟头合集');
		assert.equal(pm.shareAuthor, '小橘日记');
		assert.equal(pm.refText, '之前那个搞笑视频呢');
		assert.equal(pm.refMsgId, '90071992547409991');

		const frontierFrame = fBytes(8, respPb).toString('base64');
		const drained = drainPushFrames({
			events: [{ seq: 1, method: 'Network.webSocketFrameReceived', params: { requestId: 'ws1', response: { payloadData: frontierFrame } } }],
		}, 0, selfSec);
		assert.equal(drained.length, 1, 'drainPushFrames 应接受新群 convId 并传递 selfSecUid');
		assert.equal(drained[0].convId, groupConv);
		assert.equal(drained[0].messages[0].fromMe, true);

		const merged = mergeMessages(
			[{ text: '', mediaType: MEDIA.IMAGE, fromMe: false, shareAweme: '', isSystem: false }],
			[{ type: MEDIA.IMAGE, fromMe: false, media: { src: 'x' }, text: '[图片]' }],
		);
		assert.equal(merged.length, 1, 'DOM 已渲染同类图片气泡时应去掉 PB 空壳占位');
		ok('PB 解析与推送群帧 / mergeMessages');
	}

	// ── 3. DouyinChannel：消息规范化 / learnSelfUid 三态分离 / send alreadyVerified & submitted ──
	{
		const { openDatabase } = await import('../lib/db.js');
		const { DouyinChannel, normalizeDouyinMessage } = await import('../lib/channels/douyin.js');

		const groupNorm = normalizeDouyinMessage(
			{
				type: 'video', fromMe: false, senderId: '888', senderName: '群友A',
				media: { data: 'data:image/png;base64,abc' },
				refText: '早安', refMsgId: '555',
			},
			{ name: '摸鱼群', timeMs: 1000, messageId: 'm1', group: true, convId: '751:1:0' },
		);
		assert.equal(groupNorm.convId, '751:1:0');
		assert.equal(groupNorm.replyId, '555');
		assert.equal(groupNorm.refText, '早安');
		assert.equal(groupNorm.images[0].url, 'data:image/png;base64,abc');

		const shareNorm = normalizeDouyinMessage(
			{ type: 'share', shareAweme: '7707911549709601777', shareAuthor: '小橘', shareTitle: '翻跟头', text: '', fromMe: false },
			{ name: '好友', timeMs: 1000, messageId: 'm2', identity: 'douyin:222', convId: '0:1:111:222' },
		);
		assert.ok(shareNorm.text.includes('小橘 · 翻跟头'), '分享卡应带上作者和标题');

		const voiceNorm = normalizeDouyinMessage(
			{ type: 'text', mediaType: 'voice', mediaHint: '9', text: '', fromMe: false },
			{ name: '好友', timeMs: 1000, messageId: 'm3', identity: 'douyin:222', convId: '0:1:111:222' },
		);
		assert.equal(voiceNorm.text, '【语音 9 秒（听不了）】');

		const db = openDatabase();
		const ch = new DouyinChannel({ db, getConfig: () => ({ enabled: true }), log: () => {}, onMessage: async () => {} });
		ch.learnSelfUid('0:1:111:222', [
			{ senderId: '111', fromMe: true },
			{ senderId: '111', fromMe: null },
		]);
		assert.deepEqual(ch.selfUids(), ['111'], '显式 fromMe=true 与 null 混在同批时，不能误把 111 当对方');

		const sendCalls = [];
		const emojiFallbacks = [];
		ch.host = { running: true, loggedIn: true, exclusive: async (_l, fn) => fn() };
		ch.typingDelay = () => 0;
		ch.driver = {
			sendText: async (...args) => { sendCalls.push(args); return { ok: true, verified: true }; },
			sendEmoji: async () => ({ ok: false, submitted: true, error: '没看到气泡' }),
			sendImage: async () => ({ ok: true, verified: true }),
		};
		await ch.send('张三', [{ type: 'text', text: '第一句' }, { type: 'text', text: '第二句' }], '0:1:111:222');
		assert.equal(sendCalls.length, 2);
		assert.equal(sendCalls[0].length, 3, '首段保持 3 参兼容已有桩');
		assert.deepEqual(sendCalls[1][3], { alreadyVerified: true }, '同锁后续段传 alreadyVerified');

		ch.driver.sendText = async (...args) => { emojiFallbacks.push(args); return { ok: true, verified: true }; };
		const er = await ch.send('张三', [{ type: 'emoji', name: '比心' }], '0:1:111:222');
		assert.equal(er.ok, false);
		assert.equal(emojiFallbacks.length, 0, '表情已点击提交但未回读到时，不得重复发文字兜底');
		db.close();
		ok('DouyinChannel 规范化 / learnSelfUid / send 优化');
	}

	// ── 4. DouyinAdapter：douyin-group: 前缀与多段文本合并返回 ──
	{
		const { DouyinAdapter } = await import('../lib/douyin-adapter.js');
		const sentToNames = [];
		let idx = 0;
		const adapter = new DouyinAdapter({
			db: () => ({}),
			getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
			channel: () => ({
				async send(name, parts) {
					sentToNames.push(name);
					idx++;
					return idx === 1
						? { ok: true, delivered: true, parts: [{ type: 'text', ok: true, delivered: true }] }
						: { ok: true, delivered: false, parts: [{ type: 'text', ok: false, delivered: false }] };
				},
				async shareCard() { return { ok: true, verified: true }; },
			}),
			note: () => {}, log: () => {}, diag: () => {},
		});
		const reply = ['前半句', 'https://www.douyin.com/note/7707911549709601777', '后半句'].join('\n\n');
		const res = await adapter.send({ channel_id: 'douyin-group:我的小群' }, reply, [], '0:1:111:222');
		assert.deepEqual(sentToNames, ['我的小群', '我的小群'], 'douyin-group: 前缀必须剥掉');
		assert.equal(res.parts.length, 2, '多段 flushText 结果要合并而不是被最后一段覆盖');
		assert.equal(res.delivered, true);
		ok('DouyinAdapter douyin-group: 剥前缀与多段合并');
	}

	// ── 5. 评论桥（node:vm）：长整数精度、commentReplies 与 NEEDS_VERIFY ──
	{
		const { COMMENT_BRIDGE_SOURCE, COMMENT_BRIDGE_VERSION, WRITE_ATTEMPTED_UNKNOWN } = await import('../lib/channels/vendor/douyin-bridge/douyin-comment.js');
		assert.ok(COMMENT_BRIDGE_VERSION >= 6);
		const page = {
			window: {},
			document: { cookie: 's_v_web_id=web; UIFID=u1' },
			navigator: { userAgent: 'Chrome/148.0.0.0', language: 'zh-CN', connection: {} },
			screen: { width: 1920, height: 1080 },
			location: { href: 'https://www.douyin.com/note/7707911549709601777', pathname: '/note/7707911549709601777' },
			URLSearchParams, TextEncoder, crypto: globalThis.crypto,
			fetch: async (url) => {
				if (String(url).includes('/comment/list/reply/')) {
					return new Response('{"status_code":0,"comments":[{"cid":90071992547409993,"text":"子评论","user":{"nickname":"乙","uid":90071992547409995},"label_type":1,"reply_id":90071992547409991,"reply_to_reply_id":90071992547409991,"create_time":1700000001}]}', { status: 200 });
				}
				if (String(url).includes('/comment/list/')) {
					return new Response('{"status_code":0,"comments":[{"cid":90071992547409991,"text":"一级评论","user":{"nickname":"甲","uid":90071992547409992},"label_type":0,"reply_comment_total":1,"create_time":1700000000,"image_list":[{}]}]}', { status: 200 });
				}
				return new Response('{"status_code":4,"status_msg":"需要安全校验","verify_data":{"type":"captcha"}}', { status: 200 });
			},
		};
		vm.createContext(page);
		vm.runInContext(COMMENT_BRIDGE_SOURCE, page);
		const br = page.window.__fishComment;
		const cl = await br.commentList({ awemeId: '7707911549709601777' });
		assert.equal(cl.ok, true);
		assert.equal(cl.list[0].cid, '90071992547409991', '17+ 位 cid 精度不能丢失');
		assert.equal(cl.list[0].uid, '90071992547409992', '17+ 位 uid 精度不能丢失');
		assert.equal(cl.list[0].replyTotal, 1);
		assert.equal(cl.list[0].hasImage, true);
		const cr = await br.commentReplies({ awemeId: '7707911549709601777', commentId: '90071992547409991' });
		assert.equal(cr.ok, true);
		assert.equal(cr.list[0].cid, '90071992547409993');
		assert.equal(cr.list[0].labelType, 1);
		const pr = await br.postComment({ awemeId: '7707911549709601777', text: '哈哈' });
		assert.equal(pr.ok, false);
		assert.equal(pr.writeState, WRITE_ATTEMPTED_UNKNOWN);
		assert.equal(pr.code, 'NEEDS_VERIFY');
		ok('douyin-comment 桥大整数精度 / 楼中楼 / NEEDS_VERIFY');
	}

	// ── 6. DouyinSocial：whoIs / per-kind 阻断 / 未登录拦截计费 / pollComments 楼中楼与全Caption ──
	{
		const { openDatabase, setKv, resolveOrCreatePlatformPerson } = await import('../lib/db.js');
		const { DouyinSocial } = await import('../lib/douyin-social.js');

		const db = openDatabase();
		setKv(db, 'douyin.comments.seeded', true);
		setKv(db, 'douyin.selfUid', '10001');
		resolveOrCreatePlatformPerson(db, { platform: 'douyin', platformId: 'douyin:20002', nickname: '老熟人', nowMs: 1000 });
		db.prepare("INSERT INTO social_post(platform, post_id, content, created_at, created_real_at) VALUES('douyin', 'w1', '完整的图文动态内容', 1, 1)").run();

		let genCalled = 0;
		const prompts = [];
		const replyApiCalls = [];
		let domFallbackCalled = 0;

		const social = new DouyinSocial({
			db,
			replyGapMs: 0,
			clock: { now: () => 10_000, getRoleDateParts: () => ({ dateStr: '2026-11-26' }) },
			host: {
				running: true, loggedIn: true,
				browser: { cookies: async () => [{ name: 'guest', value: 'x' }] },
				exclusive: async (_l, fn) => fn(),
			},
			getConfig: () => ({ enabled: true, masterName: '', comments: { enabled: true, perHour: 5, replyChars: 40 }, video: { enabled: true, perDay: 2 } }),
			callLlm: async (p) => { prompts.push(p); return '收到啦'; },
			persona: () => ({ name: '鱼', brief: '' }),
			videoGen: { generate: async () => { genCalled++; return { ok: false }; } },
			log: () => {},
			driver: {
				listWorks: async () => [{ id: 'w1', title: '完整...', kind: 'note' }],
				openWork: async () => ({ ok: true }),
				listComments: async () => [],
				listCommentsApi: async () => [
					{ cid: 'c_self', author: '我自己', uid: '10001', labelType: 0, content: '自己补一句', createTime: Math.floor(Date.now() / 1000), replyTotal: 0, hasImage: false, canReply: true },
					{ cid: 'c_old', author: '路人旧', uid: '30003', labelType: 0, content: '好早之前', createTime: Math.floor((Date.now() - 48 * 3600_000) / 1000), replyTotal: 0, hasImage: false, canReply: true },
					{ cid: 'c_parent', author: '熟人', uid: '20002', labelType: 0, content: '今天真暖和', createTime: Math.floor(Date.now() / 1000), replyTotal: 1, hasImage: false, canReply: true },
				],
				listCommentReplies: async () => [
					{ cid: 'c_sub', author: '新朋友', uid: '40004', labelType: 0, content: '是啊', createTime: Math.floor(Date.now() / 1000), hasImage: true, canReply: true },
				],
				replyApi: async (args, opts) => {
					opts?.onBeforeWrite?.();
					replyApiCalls.push(args);
					if (args.replyToReplyId) return { ok: false, writeState: 'ATTEMPTED_UNKNOWN', code: 'NEEDS_VERIFY', error: '需要验证' };
					return { ok: true, cid: 'r1' };
				},
				reply: async () => { domFallbackCalled++; return { ok: true }; },
			},
		});

		assert.equal(social.whoIs({ mid: 'douyin:10001' }, 'douyin:10001'), '（是你的主人）');
		assert.equal(social.whoIs({ mid: '20002' }, 'douyin:10001'), '（你认识，是老熟人）');
		assert.equal(social.whoIs({ mid: '' }, 'douyin:10001'), '（身份未验证）');

		const jobId = social.beginPost('测试图文', '2026-11-26', 'note');
		social.postJobs.submitting(jobId);
		assert.ok(social.postBlockReason('post') !== '', '图文 unknown 时应挡住图文');
		assert.equal(social.postBlockReason('video'), '', '图文 unknown 不应挡住视频');
		social.postJobs.fail(jobId, 'x');
		social.postJobs.resolveNotPublished(jobId);

		await assert.rejects(() => social.publishVideoWork('拍猫', null), /没登录/);
		assert.equal(genCalled, 0, '创作者中心未登录时绝不扣视频生成额度');

		await social.pollComments();
		assert.equal(replyApiCalls.length, 2, '作者本人和超 24h 旧评论跳过，回复父评论与子评论共 2 次');
		assert.equal(domFallbackCalled, 0, 'NEEDS_VERIFY + ATTEMPTED_UNKNOWN 时绝不退回 DOM 点击');
		assert.ok(prompts[0].includes('完整的图文动态内容') && prompts[0].includes('老熟人'), '应带上 social_post 完整文案和熟人称呼');
		assert.ok(prompts[1].includes('今天真暖和') && prompts[1].includes('[带图片]'), '子评论应带上父评论 target 与带图提示');
		assert.equal(replyApiCalls[1].replyToReplyId, 'c_sub');
		assert.ok(social.blockedUntil > Date.now() && !social.ready, 'NEEDS_VERIFY 后应进入验证退避');
		db.close();
		ok('DouyinSocial 认人 / 分类型阻断 / 未登录护栏 / 评论楼中楼');
	}

	// ── 7. Browse 摘要 & /note/ 链接 & Gateway 群 callNames / backlog / refText / 复读守卫 ──
	{
		const { ALONE_LINK } = await import('../lib/douyin-share-inline.js');
		const { douyinVideoIds } = await import('../lib/douyin-delivery.js');
		const { extractWorkSummary, DouyinBrowser } = await import('../lib/douyin-browse.js');
		const { openDatabase } = await import('../lib/db.js');
		const { mediaMethods } = await import('../lib/gateway-media.js');

		assert.equal(ALONE_LINK.test('https://www.douyin.com/note/7707911549709601777'), true);
		assert.deepEqual(douyinVideoIds('看 https://www.douyin.com/note/7707911549709601777'), ['7707911549709601777']);

		const sum = extractWorkSummary({
			desc: '秋日街拍',
			author: { nickname: '摄影师' },
			text_extra: [{ hashtag_name: '扫街' }],
			music: { title: '稻香', author: 'Jay' },
			images: [{}, {}, {}],
			seo_info: { ocr_content: '转角咖啡店' },
			interaction_stickers: [{ text_info: '{"text":"打卡成功"}' }],
		}, [{ text: '调色好绝' }, { text: '求预设' }]);
		assert.equal(sum.music, '稻香 - Jay');
		assert.equal(sum.imageCount, 3);
		assert.ok(sum.ocr.includes('转角咖啡店') && sum.ocr.includes('打卡成功'));
		assert.deepEqual(sum.topComments, ['调色好绝', '求预设']);

		const db = openDatabase();
		let lockCalls = 0;
		const browse = new DouyinBrowser({
			db,
			clock: { now: () => Date.now() },
			host: { running: false, loggedIn: false, browser: null, exclusive: async (_l, fn) => { lockCalls++; return fn(); } },
			getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 1, like: false, share: false, mode: 'http' } }),
			callLlm: async () => '好看',
			persona: () => ({ name: '鱼', brief: '' }),
			worker: { enqueueRealtime: () => {} },
			log: () => {},
			dwellMs: [1, 2],
			http: {
				isLoggedIn: () => true,
				ensureCookies: async () => true,
				feed: async () => ({ ok: true, list: [{ aweme_id: '9101', desc: '风景', author: { nickname: 'A' } }] }),
				detail: async () => ({ ok: true, detail: { desc: '风景', author: { nickname: 'A' }, music: { title: '风吹麦浪', author: '' }, text_extra: [] } }),
				comments: async () => ({ ok: true, list: [{ text: '美' }] }),
			},
		});
		const brRun = await browse.run({ count: 1 });
		assert.equal(brRun.ok, true);
		assert.equal(lockCalls, 0, '纯 HTTP run() 不应占用浏览器 exclusive 锁');

		const backlogged = [];
		const queued = [];
		const gw = {
			stopped: false,
			douyin: {},
			douyinConfig: () => ({ enabled: true, autoReply: true, groupReply: true, replyAll: true, allowList: [], masterUid: 'douyin:999', callNames: ['小鱼'], replyWindowMinutes: 120 }),
			markSeen: () => true,
			resolveDouyinPerson: () => ({ display_name: '路人乙' }),
			isPaused: () => false,
			pushBacklog: (m) => backlogged.push(m),
			soul: { memorizeUnanswered: () => {} },
			note: () => {},
			enqueue: (m) => queued.push(m),
		};
		await mediaMethods.onDouyinGroupMessage.call(gw, {
			channelId: 'douyin-group:群', userId: 'douyin:123', nickname: '乙',
			messageId: 'g1', text: '大家好呀', timeMs: Date.now(), mentioned: false,
		});
		await mediaMethods.onDouyinGroupMessage.call(gw, {
			channelId: 'douyin-group:群', userId: 'douyin:123', nickname: '乙',
			messageId: 'g2', text: '小鱼在不在', timeMs: Date.now(), mentioned: false,
		});
		assert.equal(backlogged.length, 1, '没叫名字的话应进群聊 backlog');
		assert.equal(queued.length, 1, '叫了 callNames 的话应交给模型回');
		db.close();
		ok('Browse HTTP 解锁与摘要 / /note/ 链接 / 群聊 callNames & backlog');
	}

	// ── 8. 真实 Chromium + CDP + 本机 HTTP 假站端到端验证 ──
	{
		const { detectBrowsers } = await import('../lib/browsers.js');
		const found = (await detectBrowsers().catch(() => [])).find((x) => x.path);
		if (!found) {
			console.log('- 跳过真实 Chromium 端到端测试：未检测到 Chromium 系浏览器');
		} else {
			const { Browser } = await import('../lib/channels/vendor/douyin-bridge/browser.mjs');
			const { enterChat } = await import('../lib/channels/vendor/douyin-bridge/douyin-panel.mjs');
			const { sendDM, __test: dmTest } = await import('../lib/channels/vendor/douyin-bridge/douyin-dm.mjs');
			const { callBridge, installCommentBridge, WRITE_ATTEMPTED_UNKNOWN } = await import('../lib/channels/vendor/douyin-bridge/douyin-comment.js');
			const { douyinSocialDriver } = await import('../lib/douyin-social.js');

			const probe = createServer();
			await new Promise((r) => probe.listen(0, '127.0.0.1', r));
			const cdpPort = probe.address().port;
			await new Promise((r) => probe.close(r));

			let currentHtml = '<!doctype html><meta charset="utf-8"><body>ok</body>';
			const site = createServer((req, res) => {
				const u = String(req.url || '/');
				if (u.startsWith('/aweme/v1/web/comment/list/reply/')) {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end('{"status_code":0,"comments":[{"cid":90071992547409993,"text":"真Chromium子评论","user":{"nickname":"乙","uid":90071992547409995},"label_type":1,"reply_id":90071992547409991,"reply_to_reply_id":90071992547409991,"create_time":1700000001}]}');
					return;
				}
				if (u.startsWith('/aweme/v1/web/comment/list/')) {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end('{"status_code":0,"comments":[{"cid":90071992547409991,"text":"真Chromium父评","user":{"nickname":"甲","uid":90071992547409992},"label_type":0,"reply_comment_total":1,"create_time":1700000000}]}');
					return;
				}
				if (u.startsWith('/aweme/v1/web/comment/publish/')) {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end('{"status_code":4,"status_msg":"需要安全校验","verify_data":{"type":"captcha"}}');
					return;
				}
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end(currentHtml);
			});
			await new Promise((r) => site.listen(0, '127.0.0.1', r));
			const origin = `http://127.0.0.1:${site.address().port}`;

			const br = new Browser({
				exe: found.path,
				userDataDir: join(base, 'chromium-profile'),
				port: cdpPort,
				extraArgs: ['--headless=new', '--no-sandbox'],
			});
			try {
				await br.launch();

				// 8a. goto 后 seq 单调不归零
				currentHtml = '<!doctype html><meta charset="utf-8"><body><p>p1</p></body>';
				await br.goto(`${origin}/p1`, { settleMs: 100 });
				const seq1 = br.eventCursor();
				assert.ok(seq1 > 0, '首次 goto 应积累正的 CDP 事件游标');
				await br.goto(`${origin}/p2`, { settleMs: 100 });
				assert.ok(br.eventCursor() >= seq1, '真 Chromium 二次 goto 后 seq 不能清零');

				// 8b. enterChat 精确匹配「小鱼」优于包含匹配的「小鱼干」，查无此人拒点首行
				currentHtml = `<!doctype html><meta charset="utf-8"><style>
				  body{margin:0}[data-e2e="conversation-item"]{display:flex;width:300px;height:60px;margin:4px}
				</style>
				<div data-e2e="conversation-item" onclick="window.__clicked='小鱼干';window.__showInp('小鱼干')"><div><span data-e2e="conversation-title">小鱼干</span><span class="ConversationItemDesc"> hi</span></div></div>
				<div data-e2e="conversation-item" onclick="window.__clicked='小鱼';window.__showInp('小鱼')"><div><span data-e2e="conversation-title">小鱼</span><span class="ConversationItemDesc"> hey</span></div></div>
				<div id="chat"></div>
				<script>window.__showInp=function(){document.getElementById('chat').innerHTML='<div contenteditable="true" style="width:240px;height:36px;display:block"></div>';};</script>`;
				await br.goto(`${origin}/dm-list`, { settleMs: 100 });
				const enteredExact = await enterChat(br, '小鱼');
				assert.equal(enteredExact, true);
				assert.equal(await br.eval('window.__clicked'), '小鱼', '应精确点中「小鱼」而不是先出现的「小鱼干」');
				await assert.rejects(() => enterChat(br, '不存在的路人'), /找不到会话/, '查不到目标会话时不能点错首行');

				// 8c. sendDM 气泡计数防重（旧同文气泡不能假阳性通过，新气泡多出 1 条才算确认）
				const makeSendHtml = (appendOnEnter) => `<!doctype html><meta charset="utf-8"><style>
				  body{margin:0}.messageMessageBox{display:block;height:32px;margin:8px 0}#inp{width:280px;height:40px;border:1px solid #999}
				</style>
				<div id="list">
				  <div class="messageMessageBox messageBox" data-e2e="message-item"><div class="messageMessageBoxcontentBox isFromMe">收到</div></div>
				</div>
				<div id="inp" contenteditable="true"></div>
				<script>
				  const inp=document.getElementById('inp'), list=document.getElementById('list');
				  inp.addEventListener('keydown', (e)=>{
				    if(e.key==='Enter'){
				      e.preventDefault();
				      inp.innerText='';
				      if (${appendOnEnter ? 'true' : 'false'}) {
				        const d=document.createElement('div');
				        d.className='messageMessageBox messageBox';
				        d.setAttribute('data-e2e','message-item');
				        d.innerHTML='<div class="messageMessageBoxcontentBox isFromMe">收到</div>';
				        list.appendChild(d);
				      }
				    }
				  });
				</script>`;
				currentHtml = makeSendHtml(false);
				await br.goto(`${origin}/dm-no-append`, { settleMs: 100 });
				const fakeSend = await sendDM({ browser: br, text: '收到', alreadyVerified: true });
				assert.equal(fakeSend.ok, false, '列表已有相同旧气泡但回车未多出新气泡时，不得误判成功');

				currentHtml = makeSendHtml(true);
				await br.goto(`${origin}/dm-append`, { settleMs: 100 });
				const realSend = await sendDM({ browser: br, text: '收到', alreadyVerified: true });
				assert.equal(realSend.ok, true);
				assert.equal(realSend.verified, true);

				// 8d. readDMDom 引用剥离 refText 与 >1.5MB 图片 data URL 拦截
				const smallPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
				const hugeData = 'data:image/png;base64,' + 'A'.repeat(1_600_000);
				currentHtml = `<!doctype html><meta charset="utf-8"><style>
				  body{margin:0}[data-e2e="im-dialog"]{width:640px;height:600px}.messageMessageBox{display:block;min-height:48px;margin:20px 0}#inp{width:280px;height:40px}
				</style>
				<div data-e2e="im-dialog">
				  <div data-e2e="conversation-item" style="width:220px;height:48px"><span data-e2e="conversation-title">好友</span></div>
				  <div id="inp" contenteditable="true"></div>
				  <div class="messageMessageBox messageBox" data-e2e="message-item">
				    <div class="messageMessageBoxcontentBox"><div class="MessageItemNewRefMessage">原话内容</div><div>这是回复</div></div>
				  </div>
				  <div class="messageMessageBox messageBox" data-e2e="message-item">
				    <div class="MessageItemImageImageBox" style="width:200px;height:200px"><img src="${smallPng}"></div>
				  </div>
				  <div class="messageMessageBox messageBox" data-e2e="message-item">
				    <div class="MessageItemImageImageBox" style="width:400px;height:400px"><img id="huge"></div>
				  </div>
				</div>
				<script>document.getElementById('huge').setAttribute('src', ${JSON.stringify(hugeData)});</script>`;
				await br.goto(`${origin}/dm-read`, { settleMs: 100 });
				const domRes = await dmTest.readDMDom({ browser: br, limit: 10 });
				assert.equal(domRes.ok, true);
				assert.equal(domRes.messages.length, 3);
				assert.equal(domRes.messages[0].refText, '原话内容');
				assert.equal(domRes.messages[0].text, '这是回复');
				assert.equal(domRes.messages[1].media.data, smallPng);
				assert.equal(domRes.messages[2].media.src, '', '超过 1.5MB 的 data URL 不得写入 media.src');
				assert.equal(domRes.messages[2].media.data, undefined);

				// 8e. douyinSocialDriver：prepareVideo 延迟出现上传框 + publishNote 发布前校验阻断 beforeSubmit
				const mp4 = join(base, 'dummy.mp4');
				writeFileSync(mp4, Buffer.from('00000018667479706d703432', 'hex'));
				let creatorHref = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=1';
				const fakeCreatorBr = {
					get sessionId() { return br.sessionId; },
					eval: async (expr, opts) => (String(expr).trim() === 'location.href' ? creatorHref : br.eval(expr, opts)),
					send: (method, params, sid, timeoutMs) => br.send(method, params, sid, timeoutMs),
					goto: async (_url, opts) => br.goto(`${origin}/creator-mock`, { ...opts, settleMs: 0 }),
				};
				const drv = douyinSocialDriver({ running: true, browser: fakeCreatorBr }, { waitBudgetMs: 6000, transcodeBudgetMs: 4000, evalTimeoutMs: 6000, gotoTimeoutMs: 10000 });

				currentHtml = `<!doctype html><meta charset="utf-8"><style>body{margin:0}#desc{width:300px;height:60px;display:block}#title{width:300px;height:24px;display:block}</style>
				<video id="v"></video><input id="title" placeholder="请输入标题"><div id="desc" contenteditable="true"></div>
				<script>
				  const v=document.getElementById('v');
				  Object.defineProperty(v,'duration',{value:5});
				  Object.defineProperty(v,'currentSrc',{value:'https://v26.douyinvod.com/mock.mp4'});
				  setTimeout(()=>{ const i=document.createElement('input'); i.type='file'; i.accept='video/mp4'; document.body.appendChild(i); }, 800);
				</script>`;
				const preVid = await drv.prepareVideo({ title: '测试', text: '延迟出现上传框的视频', file: mp4 });
				assert.equal(preVid.ok, true, `prepareVideo 应等到延迟挂载的 file input：${preVid.error ?? ''}`);

				creatorHref = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3';
				currentHtml = `<!doctype html><meta charset="utf-8"><style>
				  body{margin:0}.semi-sidesheet-content{position:fixed;top:20px;left:20px;width:300px;height:200px}
				  .card-container{display:flex;width:280px;height:40px}.container-right{width:120px;height:24px}
				</style>
				<div class="container-right"></div>
				<div class="semi-sidesheet-content music-collection-container">
				  <div class="card-container"><span class="song-name">晴天</span><button onclick="document.querySelector('.container-right').innerText='晴天'">使用</button></div>
				</div>`;
				await br.goto(`${origin}/note-no-btn`, { settleMs: 100 });
				let beforeNoteCalls = 0;
				const pubNote = await drv.publishNote({ music: '晴天', beforeSubmit: () => { beforeNoteCalls++; } });
				assert.equal(pubNote.ok, false);
				assert.equal(pubNote.code, 'NO_PUBLISH', pubNote.error ?? '');
				assert.equal(beforeNoteCalls, 0, '找不到发布按钮时绝不能提前调 beforeSubmit()');

				// 8f. 真实 Chromium 页面内跑 douyin-comment.js v6（fetch 走同源本地 mock 服务端）
				currentHtml = '<!doctype html><meta charset="utf-8"><body>note page</body>';
				await br.goto(`${origin}/note/7707911549709601777`, { settleMs: 100 });
				const ins = await installCommentBridge(br);
				assert.equal(ins.ok, true);
				const cl = await callBridge(br, 'commentList', { awemeId: '7707911549709601777' });
				assert.equal(cl.ok, true);
				assert.equal(cl.list[0].cid, '90071992547409991');
				assert.equal(cl.list[0].uid, '90071992547409992');
				const cr = await callBridge(br, 'commentReplies', { awemeId: '7707911549709601777', commentId: '90071992547409991' });
				assert.equal(cr.ok, true);
				assert.equal(cr.list[0].cid, '90071992547409993');
				assert.equal(cr.list[0].labelType, 1);
				const cp = await callBridge(br, 'postComment', { awemeId: '7707911549709601777', text: 'hi' }, { write: true });
				assert.equal(cp.ok, false);
				assert.equal(cp.writeState, WRITE_ATTEMPTED_UNKNOWN);
				assert.equal(cp.code, 'NEEDS_VERIFY');

				ok('真实 Chromium + CDP 端到端：游标 / enterChat / sendDM 防重 / readDMDom / prepareVideo / publishNote / 评论桥');
			} finally {
				await br.close().catch(() => {});
				await new Promise((r) => site.close(r));
			}
		}
	}

	// ── 9. 跨条复读守卫（近义复读 + 敷衍/重复输入不冲掉） & 抖音分享提示词/无损拆卡 ──
	{
		const { readFileSync } = await import('node:fs');
		const { findRepeatedParagraphs, normSentText } = await import('../lib/behavior.js');
		const { ChatGateway } = await import('../lib/gateway.js');
		const { splitDouyinShareParagraph } = await import('../lib/douyin-share-inline.js');

		const now = Date.now();
		const orig = '我刚刚已经帮你看完那个视频了确实挺搞笑的';
		const paraphrase = '我刚刚已经帮你看完那个视频了确实挺好笑的';
		const hist = [{ at: now - 30_000, norm: normSentText(orig) }];
		assert.deepEqual(findRepeatedParagraphs(hist, [paraphrase], { now }), [0], '高相似近义改写也应判为跨条复读');
		assert.deepEqual(findRepeatedParagraphs(hist, ['今晚想吃火锅还是去吃烧烤'], { now }), [], '无关新话不得误杀');

		const noted = [];
		const gw = Object.assign(Object.create(ChatGateway.prototype), {
			note: (kind, ev) => noted.push({ kind, ev }),
			recentSent: new Map(),
			lastInbound: new Map()
		});
		const ch = 'douyin:测试';
		const row = { channel_id: ch, title: '抖音·测试' };
		assert.equal(gw.shouldClearRecentSent(ch, '嗯', 1000), false, '1~2字敷衍语不清最近发过');
		assert.equal(gw.shouldClearRecentSent(ch, '今天看什么视频啊', 1000), true, '新问题允许清空最近发过');
		assert.equal(gw.shouldClearRecentSent(ch, '今天看什么视频啊', 60_000), false, '180s内同句话重推不清最近发过');
		assert.equal(gw.shouldClearRecentSent(ch, '今天看什么视频啊', 200_000), true, '超过180s再问同一句允许清空');

		gw.recentSent.set(ch, [{ at: Date.now() - 240_000, norm: normSentText(orig) }]);
		const kept = gw.dropRepeats(row, [paraphrase]);
		assert.deepEqual(kept, [], '4分钟内（5分钟窗口）近义复读应被 dropRepeats 拦下');
		assert.ok(noted.some((n) => n.kind === 'filtered' && String(n.ev?.reason ?? '').includes('跨条复读')));

		const mdSplit = splitDouyinShareParagraph('[猫跳舞](https://www.douyin.com/video/7707911549709601777)');
		assert.deepEqual(mdSplit, [
			{ kind: 'text', text: '猫跳舞' },
			{ kind: 'link', url: 'https://www.douyin.com/video/7707911549709601777' }
		]);

		const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
		assert.ok(indexSrc.includes('分享视频时把链接单独放一段'), '私信规则提示词应包含独立成段要求');
		assert.ok(indexSrc.includes('把链接单独放一段、再空一行'), '最近刷到提示词应包含独立成段要求');
		ok('跨条近义复读拦截 + 敷衍/重推免清 + 抖音独立成段分享规则与拆段');
	}
} finally {
	clearTimeout(keepAlive);
	if (prevHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = prevHome;
}

console.log('\ndouyin-wave12-fixes ok');
