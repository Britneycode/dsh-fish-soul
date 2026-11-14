// B站白名单：能加 UID、能删、存进 bili.allowList、面板说得清它是干嘛的。
//
// 2026-11-13 查过的现状：白名单输入框从 v0.4.0（B站设置页刚有那天）就在 lib/client.js 里，
// 保存链路也通（biliSaveBody → /channels/bili-config → config.bili.allowList → 网关 trusted 判定）。
// 真正缺的是三件事：
//   ① 面板上那一行只有个光秃秃的输入框，没说白名单是干嘛的 —— 跟上面「主人 UID」长得一样，
//      用的人不知道「在名单里的人不用互关也会回」；
//   ② 编辑方式是逗号还是一行一个没说清，加一个 / 删一个都不直观；
//   ③ 「名单里的人不用互关也回」这条保证没有任何测试兜着（onBiliMessage 一个测试都没有）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-bili-allow-');

const ok = (n) => console.log('✓', n);
const read = (p) => readFileSync(new URL(`../lib/${p}`, import.meta.url), 'utf8');

// ── ① 白名单的作用：名单里的人不用互关也回 ──
{
	const { openDatabase } = await import('../lib/db.js');
	const { ChatGateway } = await import('../lib/gateway.js');

	function makeWorld({ allowList = [], replyMutual = true, masterUid = '' } = {}) {
		const db = openDatabase();
		const config = { bili: { enabled: true, autoReply: true, masterUid, allowList, replyMutual } };
		const gw = new ChatGateway({
			ctx: { get: () => undefined }, db,
			clock: { now: () => Date.now() }, getConfig: () => config, log: () => {},
			// B站通道：只留用得上的两样（自己的 uid、互关查询）—— 4444 跟对方互关
			bili: { client: { uid: '99999' }, isMutual: async (uid) => String(uid) === '4444' },
			soul: { resolveBiliPerson: () => ({ display_name: '路人' }), memorizeUnanswered: () => {} }
		});
		const enqueued = [];
		gw.enqueue = (m) => { enqueued.push(m); };
		return { db, gw, enqueued };
	}
	const inbound = (uid) => ({
		channel: 'bili', chatType: 'private', channelId: `bili:${uid}`, targetId: uid, groupId: null,
		userId: uid, nickname: '路人', peerName: '路人', subType: '', messageId: `m-${uid}`,
		mentioned: true, replyId: null, text: '在吗', images: [], links: [], timeMs: Date.now()
	});

	{
		const { db, gw, enqueued } = makeWorld({ allowList: ['2222'], replyMutual: false });
		await gw.onBiliMessage(inbound('2222'));
		assert.equal(enqueued.length, 1, '白名单里的人：不是主人、也没互关，照样回');
		db.close();
	}
	{
		const { db, gw, enqueued } = makeWorld({ allowList: ['2222'], replyMutual: false });
		await gw.onBiliMessage(inbound('3333'));
		assert.equal(enqueued.length, 0, '不在名单、也不互关 → 只记不回');
		db.close();
	}
	{
		const { db, gw, enqueued } = makeWorld({ allowList: [], replyMutual: true });
		await gw.onBiliMessage(inbound('4444'));
		assert.equal(enqueued.length, 1, '互关的人：照旧回（白名单没开也不影响）');
		db.close();
	}
	{
		// 自己的私信不占白名单
		const { db, gw, enqueued } = makeWorld({ allowList: ['2222'], replyMutual: true });
		await gw.onBiliMessage(inbound('99999'));
		assert.equal(enqueued.length, 0, '自己发的消息不回');
		db.close();
	}
	ok('白名单的作用：在名单里的人不用互关也回');
}

// ── ② 设置页能加 UID / 删 UID（整份保存）──
{
	const vm = await import('node:vm');
	let factory;
	const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Component: class {} };
	vm.runInNewContext(read('client.js'), { window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f; } } }, console });
	const plugin = factory((name) => { assert.equal(name, 'react'); return react; });
	const { biliSaveBody } = plugin.__test;
	const form = {
		masterUid: '', allowList: '', links: '', replyWindowMinutes: 120,
		perDay: 3, videosPerSession: 3, favoritePerDay: 2, searchKeywords: '', searchPerDay: 2,
		frames: false, framesPerDay: 1, framesPerDayChat: 10,
		maxLinks: 3, subtitleChars: 1200, comment: false, commentPerDay: 1, descChars: 300, hotCommentChars: 80,
		postPerDay: 1, commentsPerHour: 6, commentsReplyChars: 40, commentReplyPerDay: 1
	};
	{
		const { body } = biliSaveBody({ ...form, allowList: '1111\n2222' }, {});
		assert.deepEqual([...body.allowList], ['1111', '2222'], '加了两个 UID → 数组里两个');
	}
	{
		const { body } = biliSaveBody({ ...form, allowList: '1111' }, {});
		assert.deepEqual([...body.allowList], ['1111'], '删掉一个 UID → 数组里只剩一个');
	}
	{
		const { body } = biliSaveBody({ ...form, allowList: '' }, {});
		assert.deepEqual([...body.allowList], [], '清空 → 空数组');
	}
	ok('设置页：能加 UID、能删 UID');
}

// ── ③ 存进 bili.allowList，面板回显得出来 ──
{
	const { registerRoutes } = await import('../lib/routes.js');
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	const API = '/api/plugins/fish-soul';
	let handler = null;
	const ctx = {
		effect: (fn) => { fn(); },
		webServer: { register: (o) => { handler = o.handler; return () => {}; } }
	};
	let config = {};
	const deps = {
		db,
		clock: { getRoleDateParts: () => ({ dateStr: '2026-01-01' }) },
		embedder: {}, worker: {},
		life: { browseState: () => ({ count: 0 }) },
		getConfig: () => config,
		saveConfig: (patch) => { config = { ...config, ...patch }; },
		log: () => {},
		channel: { restart: () => {}, status: () => ({ connected: false }) },
		bili: { restart: () => {}, status: () => ({ loggedIn: false }) },
		douyin: { start: () => {}, stop: () => {}, status: () => ({ running: false }) },
		douyinHost: { browsers: [], status: () => ({ state: 'stopped' }), rescan: () => {} },
		douyinBrowser: { status: () => ({ running: false }), recent: () => [] },
		douyinSocial: { status: () => null }
	};
	registerRoutes(ctx, deps);

	const call = (method, path, body) => new Promise((resolve) => {
		const raw = body === undefined ? '' : JSON.stringify(body);
		const req = {
			method, url: API + path, headers: {},
			on(evt, cb) { if (evt === 'data' && raw !== '') cb(Buffer.from(raw)); if (evt === 'end') cb(); },
			destroy() {}
		};
		const res = { writeHead() {}, end(text) { resolve(JSON.parse(text)); } };
		handler(req, res);
	});

	await call('POST', '/channels/bili-config', { allowList: ['1111', '2222'] });
	assert.deepEqual(config.bili.allowList, ['1111', '2222'], '存进 bili.allowList');
	const st = await call('GET', '/channels/state');
	assert.deepEqual(st.bili.allowList, ['1111', '2222'], '面板回显得出来');
	// 别的设置项保存时不能把白名单冲掉
	await call('POST', '/channels/bili-config', { autoReply: true });
	assert.deepEqual(config.bili.allowList, ['1111', '2222'], '保存别的设置时不冲掉白名单');
	db.close();
	ok('存储：bili.allowList 存得下、回显得出、别的设置冲不掉它');
}

// ── ④ 面板上要说明白名单是干嘛的 ──
{
	const client = read('client.js');
	assert.match(client, /Row\(\{ title: "白名单"[^}]*desc: "[^"]*互关[^"]*"/,
		'白名单那一行要写明：在名单里的人不用互关也会回');
	assert.match(client, /Row\(\{ title: "白名单"[\s\S]{0,300}?Area\(\{ value: form\.allowList/,
		'白名单改成一行一个（跟抖音页、跟本页的「同一个人」一样）');
	ok('面板：白名单这一行说得清自己是干嘛的');
}

console.log('bili-allowlist ok');
