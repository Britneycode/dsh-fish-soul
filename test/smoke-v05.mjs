// v0.5 的冒烟测试（B站 Cookie 续期 + 抖音私信 / 刷视频），由 smoke.mjs 在同一个插件实例上调用。
// 拆成单独文件只是为了让 smoke.mjs 别太长；共用的假宿主 / 假服务从参数传进来。
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function run(t) {
	const { assert, ok, call, sleep, waitFor, turn, at, context, route, db, dy, dyBrowser, dyPush, host, ob, bl, bm, authFile, home, sid1, LifeEngine, VirtualClock } = t;
	let cs;
	let p;

	// 30 B站 Cookie 自动续期：ac_time_value 就是 refresh_token；每天查一次，要刷才刷；新 csrf + 旧 token 确认作废
	{
		const c = new bl.BiliClient();
		await assert.rejects(c.loginWithCookie('SESSDATA=good%2C123; bili_jct=jct1; DedeUserID=999', 'not hex!'), /ac_time_value/);
		const lr = await c.loginWithCookie('SESSDATA=good%2C123; bili_jct=jct1; DedeUserID=999; ac_time_value=0123456789abcdef0123456789abcdef');
		assert.equal(lr.canRenew, true);
		bm.token = '0123456789abcdef0123456789abcdef';
		assert.equal(await c.maybeRenew(), 'fresh', 'B站说不用刷就不刷');
		assert.equal(await c.maybeRenew(), 'skipped', '24 小时内只查一次');
		bm.needRefresh = true; bm.renew.length = 0;
		assert.equal(await c.maybeRenew({ due: true }), 'renewed');
		assert.deepEqual(bm.renew.map((x) => x[0]), ['info', 'correspond', 'refresh', 'confirm']);
		assert.equal(bm.renew[1][1], 'refresh_1700000000123', '用 cookie/info 给的时间戳算 correspondPath');
		assert.deepEqual([bm.renew[2][1].csrf, bm.renew[2][1].refresh_csrf, bm.renew[2][1].source, bm.renew[2][1].refresh_token], ['jct1', 'RCSRF1', 'main_web', bm.token]);
		assert.deepEqual([bm.renew[3][1].csrf, bm.renew[3][1].refresh_token], ['jct2', bm.token], '确认用新 csrf + 旧 token');
		assert.match(bm.renew[3][2], /SESSDATA=good%2C456/);
		const saved = JSON.parse(readFileSync(authFile, 'utf8'));
		assert.deepEqual([saved.cookies.SESSDATA, saved.cookies.bili_jct, saved.refreshToken], ['good%2C456', 'jct2', 'fedcba9876543210fedcba9876543210']);
		// Windows 没有 POSIX 权限位（Node 只能切只读，stat 永远报 0o666/0o444），只在类 Unix 上查 0600
		if (process.platform !== 'win32') assert.equal(statSync(authFile).mode & 0o777, 0o600);
		assert.ok(c.renewStatus().renewedAt > 0);
		// 续期失败：记下原因、提醒主人一次（下次 3 小时后再试）；成功后提醒清掉
		const notes = [];
		const ch = new bl.BiliChannel({ client: c, db, getConfig: () => ({}), notify: (k, t) => notes.push([k, t]) });
		c.renew.checkedAt = 0; bm.token = 'someone-else';
		await ch.renewTick();
		assert.equal(notes.length, 1); assert.equal(notes[0][0], 'bili.renew'); assert.match(notes[0][1], /续期没成功/);
		assert.match(c.renewStatus().renewError, /-111/);
		assert.equal(await c.maybeRenew(), 'skipped', '失败后 3 小时内不再试');
		c.renew.checkedAt = 0; bm.token = 'fedcba9876543210fedcba9876543210';
		await ch.renewTick();
		assert.deepEqual(notes.slice(1), [['bili.auth', null], ['bili.renew', null]]);
		assert.equal(c.renewStatus().renewError, '');
		bm.needRefresh = false;
		c.logout?.();
	}
	ok('B站 Cookie 自动续期：每天查一次、要刷才刷、correspondPath 对得上、新 Cookie 只进 0600 文件；失败提醒一次');

	// ───────────── v0.5：抖音（专用浏览器、私信、自己刷视频）─────────────

	// 31a 抖音纯函数：窗口对齐、指纹（图片签名参数不算）、归一化、会话时间、视频引用
	{
		const dyc = await import('../lib/channels/douyin.js');
		const { findDouyinRefs } = await import('../lib/douyin-browse.js');
		const { splitChannelId, sessionChannelOf } = await import('../lib/gateway.js');
		assert.equal(dyc.newFrom([], ['a', 'b']), 0, '没有窗口：全是新的（调用方再限条数）');
		assert.equal(dyc.newFrom(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e']), 3);
		assert.equal(dyc.newFrom(['x', 'b', 'c'], ['b', 'c', 'd']), 2, '窗口滚动了也对得上');
		assert.equal(dyc.newFrom(['a', 'b', 'c'], ['a', 'b', 'c']), 3, '没有新消息');
		assert.equal(dyc.newFrom(['a', 'b', 'c'], ['p', 'q']), 0, '整个对不上：末尾不认识的一段算新的');
		assert.equal(dyc.newFrom(['a', 'b', 'c'], ['b', 'p', 'q']), 1);
		{
			// 对方连发同一句话：DOM 去重不能把第二条删掉，窗口对比要认出它是新的，ID 也不能撞
			const { dedupeNestedMessages } = await import('../lib/channels/vendor/douyin-bridge/media.mjs');
			const t = (text, y) => ({ fromMe: false, type: 'text', text, media: {}, y });
			const page = [t('可以开始聊天了', 10), t('有刷到什么好看的视频吗', 60), t('撤回', 110), t('你好', 160), t('你好', 166), t('你好', 210)];
			const uniq = dedupeNestedMessages(page);
			assert.deepEqual(uniq.map((m) => m.y), [10, 60, 110, 160, 210], '只合并 y 几乎重合的嵌套节点，连发的同文消息都留着');
			assert.deepEqual(dedupeNestedMessages([t('b', 50), t('a', 0)]).map((m) => m.text), ['a', 'b'], '按 y 排序');
			const prev = uniq.slice(0, 4).map(dyc.messageFingerprint);
			const cur = uniq.map(dyc.messageFingerprint);
			assert.equal(dyc.newFrom(prev, cur), 4, '新的「你好」不会被当成旧的');
			const occ = dyc.occurrenceIndexes(cur);
			assert.deepEqual(occ, [0, 0, 0, 0, 1]);
			assert.deepEqual(dyc.occurrenceIndexes(['a', 'b', 'a', 'a']), [0, 0, 1, 2]);
			assert.notEqual(`${cur[3]}-1-${occ[3]}`, `${cur[4]}-1-${occ[4]}`, '同一分钟两条同文消息 ID 不同');
		}
		const img = (q) => ({ type: 'image', media: { src: `https://p3-pc-sign.douyinpic.com/obj/tos-cn-i-0813/abc~tplv.image?x-expires=${q}&x-signature=zz${q}` } });
		assert.equal(dyc.messageFingerprint(img(1)), dyc.messageFingerprint(img(2)), '图片地址的签名参数会变，不算');
		assert.notEqual(dyc.messageFingerprint({ text: '在吗' }), dyc.messageFingerprint({ text: '在吗', fromMe: true }));
		const nd = (m) => dyc.normalizeDouyinMessage(m, { name: '阿:二', timeMs: 1, messageId: 'm1' });
		assert.deepEqual([nd(img(1)).text, nd(img(1)).images.length, nd(img(1)).channelId], ['【图片】', 1, 'douyin:阿:二']);
		assert.equal(nd({ type: 'emoji', media: { name: '比心' } }).text, '[比心]');
		assert.equal(nd({ type: 'voice', media: { seconds: 3 } }).text, '【语音 3 秒（听不了）】');
		assert.deepEqual([nd({ text: '看看', shareAweme: '7300000000000000009' }).text, nd({ text: '看看', shareAweme: '7300000000000000009' }).links], ['【分享视频】看看', ['https://www.douyin.com/video/7300000000000000009']]);
		assert.equal(nd({ text: '我发的', fromMe: true }), null); assert.equal(nd({ text: '你撤回了一条消息', system: true }), null); assert.equal(nd({ text: '  ' }), null);
		const now = new Date(2030, 0, 2, 10, 0);
		assert.equal(dyc.convTimeMs('03:27', now), new Date(2030, 0, 2, 3, 27).getTime());
		assert.equal(dyc.convTimeMs('23:59', now), new Date(2030, 0, 1, 23, 59).getTime(), '比现在晚的钟点是昨天的');
		assert.equal(dyc.convTimeMs('5分钟前', now), now.getTime() - 300_000);
		assert.equal(dyc.convTimeMs('看不懂', now), 0);
		assert.deepEqual(findDouyinRefs('https://v.douyin.com/AbC12_x/ 和 https://www.douyin.com/video/7300000000000000001?a=1 还有 https://www.douyin.com/jingxuan?modal_id=7300000000000000002 再来 https://www.douyin.com/video/7300000000000000001'),
			{ ids: ['7300000000000000001', '7300000000000000002'], shorts: ['https://v.douyin.com/AbC12_x/'] });
		assert.deepEqual([splitChannelId('douyin:a:b'), sessionChannelOf('douyin:a:b'), sessionChannelOf('bili:1'), sessionChannelOf('group:2')], [['douyin', 'a:b'], 'douyin-private', 'bili-private', 'qq-group']);
	}
	ok('抖音纯函数：窗口对齐（滚动 / 对不上）、指纹不受图片签名影响、归一化跳过自己 / 系统消息、会话时间、视频引用');

	// 31 设置校验 + 启用后先记基线（启用前的消息不当新消息）
	assert.equal((await call('POST', '/channels/douyin-config', { links: ['阿二抖音=qq'] })).json.ok, false);
	assert.equal((await call('POST', '/channels/douyin-config', { masterName: '名'.repeat(41) })).json.ok, false);
	assert.equal((await call('POST', '/channels/douyin-config', { browser: { customPath: join(home, 'nope', 'msedge.exe') } })).json.ok, false);
	assert.equal((await call('POST', '/channels/douyin-config', { browser: { kind: 'Edge!' } })).json.ok, false);
	assert.equal((await call('POST', '/douyin/browse-now', {})).json.ok, false, '总开关没开不能刷');
	assert.equal((await call('POST', '/douyin/browser/start', {})).json.ok, false, '总开关没开不启动浏览器');
	assert.equal(dy.launches, 0);
	dy.msgs.set('主人抖音', [{ fromMe: false, text: '很久以前的话', type: 'text', time: Date.now() - 86_400_000 }, { fromMe: true, text: '我回过了', type: 'text', time: Date.now() - 86_000_000 }]);
	dy.msgs.set('路人', [{ fromMe: false, text: '你好', type: 'text', time: Date.now() - 3600_000 }, { fromMe: false, text: '在吗', type: 'text', time: Date.now() - 3599_000 }]);
	dy.convs.push({ name: '主人抖音', time: '昨天', preview: '我回过了', unread: 0 }, { name: '路人', time: '昨天', preview: '在吗', unread: 2 }, { name: '', time: '', preview: '系统通知', unread: 1 });
	p = await call('POST', '/channels/douyin-config', { enabled: true, autoReply: false, masterName: ' 主人抖音 ', allowList: ['阿二抖音', ' '], links: ['阿二抖音=20002'],
		browse: { enabled: false, perDay: 99, videosPerSession: 9, like: false } });
	assert.equal(p.json.ok, true);
	cs = await call('GET', '/channels/state');
	assert.deepEqual([cs.json.douyin.masterName, cs.json.douyin.allowList, cs.json.douyin.browse.perDay, cs.json.douyin.browse.videosPerSession], ['主人抖音', ['阿二抖音'], 12, 6]);
	const dyBoot = await waitFor(() => db.prepare("SELECT value FROM kv WHERE key = 'douyin.bootstrapped'").get(), 6000);
	assert.ok(dyBoot, '第一轮记基线');
	assert.equal(dy.launches, 1);
	assert.match(dy.launchOpts.userDataDir, /fish-soul[\\/]douyin-browser[\\/]edge$/);
	assert.equal(dy.launchOpts.exe, '/fake/msedge.exe'); assert.ok(dy.launchOpts.extraArgs.includes('--mute-audio')); assert.equal(dy.launchOpts.preloadScripts.length, 1);
	assert.equal(dy.canaries, 1, '启动时自检一次');
	// 窗口：默认藏在后台（启动参数就在屏幕外，连上后再停一次）；显示一下 / 藏起来；换成正常显示马上挪回来
	assert.ok(dy.launchOpts.extraArgs.includes('--window-position=-20000,0'));
	assert.equal(dy.win.left, -20000);
	cs = await call('GET', '/channels/state');
	assert.deepEqual([cs.json.douyin.window, cs.json.douyin.windowShown, cs.json.douyin.host.window], ['background', false, 'background']);
	p = await call('POST', '/douyin/window', { show: true });
	assert.deepEqual(p.json, { ok: true, windowShown: true });
	assert.deepEqual([dy.win.left, dy.win.top], [40, 40]);
	p = await call('POST', '/douyin/window', { show: false });
	assert.equal(p.json.windowShown, false);
	assert.equal(dy.win.left, -20000);
	assert.equal((await call('POST', '/channels/douyin-config', { window: 'visible' })).json.ok, true);
	assert.equal(dy.win.left, 40, '换成正常显示：挪回屏幕');
	cs = await call('GET', '/channels/state');
	assert.deepEqual([cs.json.douyin.window, cs.json.douyin.windowShown], ['visible', false]);
	assert.equal((await call('POST', '/channels/douyin-config', { window: 'nope' })).json.ok, true);
	assert.equal((await call('GET', '/channels/state')).json.douyin.window, 'visible', '乱填的不改');
	assert.equal((await call('POST', '/channels/douyin-config', { window: 'background' })).json.ok, true);
	assert.equal(dy.win.left, -20000);
	ok('抖音设置：名字 / 对应关系 / 浏览器路径校验，次数夹到范围；启用后先记基线');

	// 32 只读阶段：不回；启用前就有的未读补进来但太旧只记；主人按名字认到主人
	await waitFor(() => dy.reads.includes('路人'), 6000);
	dyPush('主人抖音', '在吗【系统】');
	await waitFor(() => db.prepare("SELECT 1 FROM memory WHERE content LIKE '%抖音私信里说（当时没回）：在吗〔系统〕%'").get(), 6000);
	assert.equal(db.prepare("SELECT owner_id FROM memory WHERE content LIKE '%抖音私信里说（当时没回）：在吗〔系统〕%'").get().owner_id, 'user:master');
	assert.equal(db.prepare("SELECT douyin_uid FROM person WHERE canonical_id = 'master'").get().douyin_uid, '主人抖音');
	assert.ok(db.prepare("SELECT 1 FROM memory WHERE content LIKE '%抖音私信里说（当时没回）：你好%'").get(), '启用前的未读：补进来，太旧只记');
	assert.ok(!db.prepare("SELECT 1 FROM memory WHERE content LIKE '%很久以前的话%' OR content LIKE '%我回过了%'").get(), '看过的旧消息 / 自己发的不算');
	assert.equal(host.followups.filter((f) => f.msg.source.kind === 'fish-soul/douyin').length, 0);
	assert.equal(dy.sent.length, 0);
	ok('抖音只读阶段：不回；启用前的未读补进来（太旧只记），自己发的 / 看过的不算；主人按名字认到主人');

	// 33 自动回复：主人 / 白名单回，陌生人只记；分享的视频先看；名字=QQ 号并到同一个人；回复按段发、表情 / 图片
	p = await call('POST', '/channels/douyin-config', { autoReply: true });
	assert.equal(p.json.ok, true);
	dy.details.set('7300000000000000001', { ok: true, desc: '猫猫打架', author: '猫博主', comments: [{ text: '橘猫赢了' }] });
	dyPush('主人抖音', '看这个 https://www.douyin.com/video/7300000000000000001 笑死');
	dyPush('路人', '在不在');
	dyPush('阿二抖音', '我是阿二');
	const fd = await waitFor(() => host.followups.find((f) => f.msg.source.channelId === 'douyin:主人抖音'), 9000);
	assert.ok(fd, '主人的抖音私信应转进会话');
	assert.equal(fd.msg.source.kind, 'fish-soul/douyin');
	assert.equal(fd.msg.content[0].text, '看这个 https://www.douyin.com/video/7300000000000000001 笑死\n【抖音视频：猫猫打架；作者 猫博主；热评：橘猫赢了】');
	assert.ok(host.titles.some(([sid, t]) => sid === fd.id && t === '抖音·主人抖音（主人）'));
	// 向量预取是异步的（lib/index.js prefetchVec 用 void 发起），块里只在预取回来且 query 相同时才融合。
	// "冰美式"和这句抖音消息没有词面重合，纯 BM25 召不回，所以这里等预取落地再看块（断言不变）。
	const dyBlock = await waitFor(() => {
		const t = context.text(at(fd.id));
		return /冰美式/.test(t) ? t : null;
	}, 3000) ?? context.text(at(fd.id));
	assert.match(dyBlock, /抖音私信回复规则/); assert.match(dyBlock, /冰美式/, '主人在 QQ 说过的事在抖音也记得');
	assert.match(dyBlock, /可用：[^\n]*ok\.png[^\n]*wow\.webp/, '浏览器在跑：webp 表情包也能用');
	const fa = await waitFor(() => host.followups.find((f) => f.msg.source.channelId === 'douyin:阿二抖音'), 6000);
	assert.ok(fa, '白名单里的人可以回');
	const pa = db.prepare("SELECT * FROM person WHERE qq_uin = '20002'").get();
	assert.equal(pa.douyin_uid, '阿二抖音');
	assert.equal(db.prepare("SELECT owner_id FROM memory WHERE content LIKE '%我是阿二%'").get()?.owner_id ?? `user:${pa.canonical_id}`, `user:${pa.canonical_id}`);
	await waitFor(() => db.prepare("SELECT 1 FROM memory WHERE content LIKE '%抖音私信里说（当时没回）：在不在%'").get(), 6000);
	assert.equal(host.followups.some((f) => f.msg.source.channelId === 'douyin:路人'), false, '陌生人不回');
	turn(fd.id, '哈哈哈橘猫赢麻了\n\n[比心]\n\n[不存在的表情]\n\n![ok](_stickers/ok.png) ![wow](_stickers/wow.webp) ![偷](../../secret.png)', fd.msg);
	await waitFor(() => dy.sent.length >= 5, 6000);
	assert.deepEqual(dy.sent.slice(0, 4).map((x) => x.slice(0, 2).concat(x[1] === 'image' ? [] : [x[2]])), [
		['主人抖音', 'text', '哈哈哈橘猫赢麻了'], ['主人抖音', 'emoji', '比心'], ['主人抖音', 'text', '[不存在的表情]'], ['主人抖音', 'image']]);
	assert.match(dy.sent[3][2], /_stickers[\\/]ok\.png$/);
	assert.match(dy.sent[4][2], /img-cache[\\/][0-9a-f]{20}\.png$/, 'webp 转成 png 再发');
	assert.equal(readFileSync(dy.sent[4][2]).subarray(0, 4).toString('hex'), '89504e47');
	await sleep(200);
	assert.equal(dy.sent.length, 5, '工作区外的图不发');
	cs = await call('GET', '/channels/state');
	assert.deepEqual(cs.json.sessions.chats.filter((c) => c.channelId.startsWith('douyin:')).map((c) => c.channelId).sort(), ['douyin:主人抖音', 'douyin:阿二抖音']);
	ok('抖音自动回复：主人 / 白名单回、陌生人只记；分享的视频先看；名字=QQ 号并到同一个人；按段发，[表情名] 发表情（没有就当文字），webp 转 png');

	// 34 「回所有能私信她的人」：陌生人也回
	await call('POST', '/channels/douyin-config', { replyAll: true });
	dyPush('路人', '现在能回了吗');
	const fl = await waitFor(() => host.followups.find((f) => f.msg.source.channelId === 'douyin:路人'), 6000);
	assert.ok(fl);
	assert.ok(host.titles.some(([sid, t]) => sid === fl.id && t === '抖音·路人'));
	await call('POST', '/channels/douyin-config', { replyAll: false });
	ok('抖音「回所有能私信她的人」打开后陌生人也回');

	// 35 页面自检没过：自动回复先停（只记不回），QQ 上提醒主人一次；恢复后继续回；掉登录也提醒一次
	const dyNotes = (re) => ob.sends.filter((x) => x.action === 'send_private_msg' && x.params.user_id === 10001 && re.test(x.params.message[0].data.text));
	dy.canaryOk = false;
	let sc = await call('POST', '/douyin/self-check', {});
	assert.equal(sc.json.report.ok, false); assert.deepEqual(sc.json.report.canary.broken, ['私信列表']);
	await call('POST', '/douyin/self-check', {});
	await waitFor(() => dyNotes(/抖音网页好像改版了/).length > 0, 3000);
	assert.equal(dyNotes(/^【鱼的提醒】抖音网页好像改版了/).length, 1, '只提醒一次');
	assert.equal((await call('GET', '/channels/state')).json.douyin.channel.replyPaused, true);
	const nDy = host.followups.length;
	dyPush('主人抖音', '你怎么不理我');
	await waitFor(() => db.prepare("SELECT 1 FROM memory WHERE content LIKE '%抖音私信里说（当时没回）：你怎么不理我%'").get(), 6000);
	assert.equal(host.followups.length, nDy, '自检没过只记不回');
	dy.canaryOk = true;
	sc = await call('POST', '/douyin/self-check', {});
	assert.equal(sc.json.report.ok, true); assert.equal(sc.json.report.list.count, 4);
	assert.equal((await call('GET', '/channels/state')).json.douyin.channel.replyPaused, false);
	dy.loggedIn = false;
	await sleep(700);
	assert.equal(dyNotes(/抖音小号掉登录了/).length, 1, '掉登录提醒一次');
	assert.equal((await call('POST', '/douyin/browse-now', {})).json.error, '抖音还没登录');
	dy.loggedIn = true;
	await waitFor(() => !('douyin.login' in (JSON.parse(db.prepare("SELECT value FROM kv WHERE key = 'notice.sent'").get()?.value ?? '{}'))), 3000);
	ok('抖音页面自检没过：停自动回复（只记不回）、QQ 提醒主人一次，恢复后继续；掉登录提醒一次');

	// 36 设置页：截图 + 点击转发；关浏览器 = 暂停（不会自己再开），点启动才恢复
	const shot = await call('POST', '/douyin/screenshot', {});
	assert.equal(shot.json.ok, true); assert.equal(shot.json.image, `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`); assert.equal(shot.json.width, 1280);
	assert.equal((await call('POST', '/douyin/click', { x: 0.5, y: 0.25 })).json.ok, true);
	assert.deepEqual(dy.clicks.map((c) => c[0]), ['mouseMoved', 'mousePressed', 'mouseReleased']); assert.deepEqual(dy.clicks[1].slice(1), [640, 200]);
	assert.equal((await call('POST', '/douyin/click', { x: 'a', y: 1 })).json.ok, false);
	cs = await call('GET', '/channels/state');
	assert.equal(cs.json.douyin.host.state, 'running'); assert.equal(cs.json.douyin.host.browser.name, 'Microsoft Edge');
	assert.deepEqual(cs.json.douyin.host.browsers.map((b) => b.kind), ['edge']);
	assert.equal((await call('POST', '/douyin/browser/close', {})).json.ok, true);
	assert.equal(dy.quits, 1);
	await sleep(600);
	cs = await call('GET', '/channels/state');
	assert.deepEqual([cs.json.douyin.host.state, cs.json.douyin.host.pausedWhy, dy.launches], ['paused', '你在设置页关掉了抖音浏览器', 1], '暂停时轮询不会把浏览器再开起来');
	assert.equal((await call('POST', '/douyin/browser/start', {})).json.ok, true);
	assert.equal(dy.launches, 2);
	assert.equal((await call('GET', '/channels/state')).json.douyin.host.paused, false);
	ok('抖音设置页：截图 + 点击转发；关浏览器 = 暂停不自启，点启动恢复');

	// 37 自己刷抖音：推荐页跳过直播 / 广告 / 看过的；读详情写感受；划走不记、点赞要模型说了才点
	dy.feed = [
		{ id: '7300000000000000011', title: '正在直播', live: true },
		{ id: '7300000000000000012', title: '深夜食堂', author: '饭博主' },
		{ id: '7300000000000000013', title: '买它', ad: true },
		{ id: '7300000000000000014', title: '周末爬山', author: '山博主' },
		{ id: '7300000000000000015', title: '猫猫睡觉', author: '猫博主' }
	];
	await sleep(400); // 等一轮轮询把登录态刷回来
	await call('POST', '/channels/douyin-config', { browse: { enabled: true, like: true, videosPerSession: 3 } });
	const bn = await call('POST', '/douyin/browse-now', {});
	assert.equal(bn.json.started, true, bn.json.error);
	await waitFor(() => db.prepare('SELECT COUNT(*) n FROM douyin_seen').get().n >= 3, 15000);
	assert.deepEqual(db.prepare('SELECT aweme_id FROM douyin_seen ORDER BY aweme_id').all().map((r) => r.aweme_id), ['7300000000000000012', '7300000000000000014', '7300000000000000015']);
	assert.ok(dy.gotos.includes('https://www.douyin.com/?recommend=1'));
	const dmem = db.prepare("SELECT content, channel_id FROM memory WHERE owner_id = 'self' AND channel = 'douyin' ORDER BY id").all();
	assert.deepEqual(dmem.map((m) => m.content), ['我在抖音刷到饭博主 的视频《深夜食堂》', '我在抖音刷到山博主 的视频《周末爬山》', '我在抖音刷到猫博主 的视频《猫猫睡觉》'], '宿主没模型时只记标题');
	assert.equal(dmem[0].channel_id, 'douyin:video:7300000000000000012');
	assert.equal(dy.likes, 0, '模型没说 [点赞] 不点');
	assert.equal((await call('GET', '/channels/state')).json.douyin.recent.length, 3);
	{
		const { DouyinBrowser } = await import('../lib/douyin-browse.js');
		const prompts = [];
		const llm = async (pr) => { prompts.push(pr); return /无聊/.test(pr) ? '[划走]' : /猫/.test(pr) ? '团子也这么睡，可爱死了 [点赞]' : '想去爬山了'; };
		const fakeHost = { running: true, loggedIn: true, browser: dyBrowser, exclusive: (label, fn) => fn() };
		dy.details.set('7300000000000000022', { ok: true, desc: '小猫晒太阳 #猫', author: '猫博主', tags: ['猫'], comments: [{ text: '好治愈' }] });
		const b = new DouyinBrowser({ db, clock: { now: () => Date.now() }, host: fakeHost, getConfig: () => ({ enabled: true, browse: { enabled: true, videosPerSession: 3, like: true } }),
			callLlm: llm, persona: () => ({ name: '小鱼', brief: '嘴硬' }), dwellMs: [0, 0], settleMs: 0, readDetail: async ({ id }) => dy.details.get(id) ?? { ok: false } });
		dy.feed = [{ id: '7300000000000000012', title: '深夜食堂' }, { id: '7300000000000000021', title: '无聊的会议' }, { id: '7300000000000000022', title: '小猫' }, { id: '7300000000000000023', title: '山顶日出' }];
		const rr = await b.run({});
		assert.deepEqual(rr.watched.map((w) => [w.id, w.skipped, w.liked]), [['7300000000000000021', true, false], ['7300000000000000022', false, true], ['7300000000000000023', false, false]], '看过的不再看');
		assert.match(prompts[0], /^你是「小鱼」。嘴硬/); assert.match(prompts[1], /热评：\n- 好治愈/); assert.match(prompts[1], /话题：猫/);
		assert.equal(dy.likes, 1);
		assert.ok(!db.prepare("SELECT 1 FROM memory WHERE content LIKE '%无聊的会议%'").get(), '划走的不记');
		const qqb = context.text(at(sid1));
		assert.match(qqb, /\[你最近在抖音刷到的（想聊再提，别硬塞）\]\n- 《/);
		assert.match(qqb, /\n- 《山顶日出》：想去爬山了\n/); assert.match(qqb, /\n- 《小猫》（猫博主）：团子也这么睡，可爱死了\n/);
	}
	ok('抖音刷视频：跳过直播 / 广告 / 看过的；读详情写感受；划走不记、点赞要模型说了才点；感受进 QQ 会话上下文');

	// 38 自走层：B站 / 抖音轮着刷（今天刷得少的先），共用 90 虚拟分钟间隔；抖音没登录就让给 B站
	{
		const home4 = mkdtempSync(join(tmpdir(), 'dsh-d-'));
		const prevHome = process.env.DSH_HOME; process.env.DSH_HOME = home4;
		const { openDatabase } = await import('../lib/db.js');
		const ddb = openDatabase(); process.env.DSH_HOME = prevHome;
		let t = Date.parse('2030-01-01T06:00:00Z'); // 14:00 UTC+8 idle
		const dclock = Object.assign(Object.create(VirtualClock.prototype), { scale: 1, now: () => t });
		const runs = []; let ready = false;
		const dlife = new LifeEngine({
			db: ddb, clock: dclock, callLlm: async () => null, deliver: async () => true, browseRealGapMs: 0,
			browse: async () => { runs.push('bili'); }, douyinBrowse: async () => { runs.push('douyin'); }, douyinReady: () => ready,
			getConfig: () => ({ proactive: { dailyMaxCount: 0, targets: { masterPrivateChannelId: '', selfGroupChannelIds: [] } },
				bili: { enabled: true, browse: { perDay: 1 } }, douyin: { enabled: true, browse: { enabled: true, perDay: 2 } } })
		});
		const tick = async () => { await dlife.tick(); await sleep(5); };
		await tick(); assert.deepEqual(runs, ['bili'], '抖音没登录：这轮给 B站');
		ready = true;
		t += 30 * 60_000; await tick(); assert.deepEqual(runs, ['bili'], '两个平台共用间隔');
		t += 61 * 60_000; await tick(); assert.deepEqual(runs, ['bili', 'douyin']);
		t = Date.parse('2030-01-01T12:00:00Z'); await tick(); assert.deepEqual(runs, ['bili', 'douyin', 'douyin'], 'B站今天的份用完了');
		t += 91 * 60_000; await tick(); assert.equal(runs.length, 3, '抖音每天上限 2');
		ddb.close();
	}
	ok('自走层：B站 / 抖音轮着刷、共用间隔；抖音没登录就让给 B站');

	// 39 设置页样式单独一个文件；关掉总开关：停轮询、关浏览器
	{
		let status = 0; let out = ''; let headers = {};
		const req = new (await import('node:stream')).Readable({ read() { this.push(null); } });
		req.url = '/api/plugins/fish-soul/ui/panel.css'; req.method = 'GET'; req.headers = {};
		await route.handler(req, { writeHead: (s, h) => { status = s; headers = h ?? {}; }, setHeader: (k, v) => { headers[k] = v; }, end: (s) => { out = String(s); } });
		assert.equal(status, 200); assert.match(JSON.stringify(headers), /text\/css/); assert.match(out, /\.fs-shot/);
	}
	assert.equal((await call('POST', '/channels/douyin-config', { enabled: false })).json.ok, true);
	cs = await call('GET', '/channels/state');
	assert.deepEqual([cs.json.douyin.enabled, cs.json.douyin.channel.running, cs.json.douyin.host.state, dy.quits], [false, false, 'stopped', 2]);
	ok('设置页样式文件；抖音总开关关掉：停轮询、关浏览器');
}
