// v0.6 的冒烟测试（聊天记录导入、记忆纠正 / 人物画像、群里插话、戳一戳 / 撤回、暂停、动态、备份导出），
// 由 smoke.mjs 在同一个插件实例上最后调用；共用的假宿主 / 假服务从参数传进来。
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function run(t) {
	const { assert, ok, call, sleep, waitFor, context, db, host, ob, services, agents, workspaceRegistry, inbox, at } = t;
	const gwMod = await import('../lib/gateway.js');
	const hi = await import('../lib/history-import.js');
	let p;

	// 40 纯函数：打字停顿、插话分数、插话配置
	{
		const { typingDelayMs, interjectScore, interjectConfig } = gwMod;
		assert.equal(typingDelayMs('', () => 0), 600);
		assert.equal(typingDelayMs('一二三四五六七八九十', () => 0.5), 1050);
		assert.equal(typingDelayMs('x'.repeat(300), () => 1), 4500);
		assert.ok(Math.abs(interjectScore({ text: '周末去撸猫吗', base: 0.05, keywords: ['猫'] }) - 0.45) < 1e-9, '话题 + 提问');
		assert.ok(Math.abs(interjectScore({ text: '哈哈', base: 0.05 }) - 0.015) < 1e-9, '太短打三折');
		assert.ok(Math.abs(interjectScore({ text: '今天天气不错', base: 0.2, relation: 'friend', busyCount: 9 }) - 0.15) < 1e-9, '熟人 +0.1、刷屏减半');
		assert.deepEqual(interjectConfig(undefined), { enabled: false, chance: 0.05, cooldownMinutes: 15, maxPerHour: 3, keywords: [] });
		const c = interjectConfig({ enabled: true, chance: 5, maxPerHour: 2.7, cooldownMinutes: -3, keywords: [' 猫 ', '', 3] });
		assert.deepEqual([c.enabled, c.chance, c.maxPerHour, c.cooldownMinutes, c.keywords], [true, 1, 2, 0, ['猫', '3']]);
	}
	ok('v0.6 纯函数：打字停顿按字数、插话分数（话题 / 熟人 / 提问 / 刷屏 / 太短）、插话默认关');

	// 41 解析：QQ txt（两种表头顺序）、SillyTavern、消息 JSON、记忆 JSON、认不出的
	const qqTxt = [
		'消息记录（此消息记录为文本格式，不支持重新导入）', '',
		'================================================================', '消息分组:我的好友',
		'================================================================', '消息对象:阿四',
		'================================================================', '',
		'2024-03-01 20:00:00 阿四(40004)', '我最近在学吉他', '手指好疼', '',
		'2024-03-01 20:01:00 我', '坚持住', '',
		'2024-03-02 21:00:00 阿四(40004)', '我家狗豆豆今天拆家了', ''
	].join('\r\n');
	{
		const a = hi.parseHistoryText(qqTxt, { fileName: '阿四.txt' });
		assert.equal(a.format, 'qq-txt');
		assert.equal(a.chats.length, 1); assert.equal(a.chats[0].kind, 'private'); assert.equal(a.chats[0].title, '阿四');
		assert.deepEqual(a.chats[0].messages.map((m) => [m.name, m.qq, m.self, m.text]), [
			['阿四', '40004', false, '我最近在学吉他\n手指好疼'], ['我', '', true, '坚持住'], ['阿四', '40004', false, '我家狗豆豆今天拆家了']]);
		assert.equal(a.chats[0].messages[0].timeMs, Date.parse('2024-03-01T20:00:00+08:00'));
		const b = hi.parseQqTxt('消息对象:摸鱼群(123456)\n阿五(50005) 2024-1-2 3:04:05\n早\n阿六(60006) 2024-1-2 3:05:00\n早啊\n');
		assert.equal(b.chats[0].kind, 'group', '两个以上的人在说话就是群'); assert.equal(b.chats[0].groupId, '123456');
		const st = hi.parseHistoryText([
			JSON.stringify({ user_name: '主人', character_name: '鱼' }),
			JSON.stringify({ name: '主人', is_user: true, mes: '晚安', send_date: 'January 1, 2024 11:00pm' }),
			JSON.stringify({ name: '鱼', is_user: false, mes: '晚安呀' })
		].join('\n'), { fileName: 'chat.jsonl' });
		assert.equal(st.format, 'sillytavern');
		assert.deepEqual(st.chats[0].messages.map((m) => [m.name, m.self]), [['主人', false], ['鱼', true]], 'SillyTavern 里角色那边是她自己');
		const j = hi.parseHistoryText(JSON.stringify({ chatInfo: { name: '老群', type: 'group', id: '777000' }, messages: [
			{ sender: { name: '阿七', uin: '70007' }, content: { text: '有人吗' }, time: 1704067200 },
			{ sender: { name: '阿八', uin: '80008' }, content: '在', timestamp: 1704067260000 }] }));
		assert.equal(j.format, 'json-messages'); assert.equal(j.chats[0].kind, 'group'); assert.equal(j.chats[0].messages[0].timeMs, 1704067200000);
		const mem = hi.parseHistoryText(JSON.stringify([{ qqUin: '40004', content: '阿四怕黑', kind: 'fact' }]));
		assert.equal(mem.format, 'memories'); assert.equal(mem.memories.length, 1);
		assert.equal(hi.parseHistoryText('随便写点什么').format, 'unknown');
	}
	ok('聊天记录解析：QQ txt 两种表头 / 私聊群聊判断、SillyTavern、消息 JSON、记忆 JSON 自动识别');

	// 42 麦麦数据库：只读、只取 QQ 平台、person_info 的印象直接变记忆
	{
		const dir = mkdtempSync(join(tmpdir(), 'dsh-mai-'));
		const path = join(dir, 'MaiBot.db');
		const m = new DatabaseSync(path);
		m.exec(`CREATE TABLE mai_messages (timestamp REAL, processed_plain_text TEXT, user_id TEXT, user_nickname TEXT, user_cardname TEXT,
			chat_id TEXT, chat_info_group_id TEXT, user_platform TEXT);
			CREATE TABLE person_info (user_id TEXT, platform TEXT, person_name TEXT, memory_points TEXT, impression TEXT);`);
		const ins = m.prepare('INSERT INTO mai_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
		ins.run(1704067200.5, '今晚吃火锅', '90009', '阿九', '', 'c1', '555000', 'qq');
		ins.run(1704067300, '好啊', '91001', '小十', '十哥', 'c1', '555000', 'qq');
		ins.run(1704067400, 'hello', 'wx1', 'w', '', 'c2', '', 'wechat');
		m.prepare('INSERT INTO person_info VALUES (?, ?, ?, ?, ?)').run('90009', 'qq', '阿九', JSON.stringify(['喜好:喜欢吃辣:1.0', '经历:去过西藏:0.5']), '');
		m.close();
		const r = hi.readMaiBotDb(path);
		assert.equal(r.format, 'maibot');
		assert.equal(r.chats.length, 1); assert.equal(r.chats[0].kind, 'group');
		assert.deepEqual(r.chats[0].messages.map((x) => [x.name, x.qq, x.text]), [['阿九', '90009', '今晚吃火锅'], ['十哥', '91001', '好啊']]);
		assert.deepEqual(r.memories.map((x) => x.content), ['阿九：喜欢吃辣', '阿九：去过西藏']);
		assert.match(r.warnings[0], /1 条不是 QQ/);
		assert.throws(() => hi.readMaiBotDb(join(dir, 'nope.db')));
	}
	ok('麦麦数据库：只读打开、只取 QQ 平台消息、印象直接变记忆');

	// 43 导入聊天记录（路由）：预览认人 → 模型提炼 → 带出处的记忆、去重、关系只升不降 → 自动整理出印象
	const llmCalls = [];
	let dreamReply = null;
	services.llm = {
		listProviders: () => [],
		async *stream({ messages }) {
			const prompt = String(messages[0].content);
			llmCalls.push(prompt);
			if (/从里面提取/.test(prompt)) {
				yield { type: 'text-delta', text: '好的：' };
				yield { type: 'text-delta', text: JSON.stringify({ memories: [
					{ content: '阿四 2024 年 3 月开始学吉他', kind: 'fact', importance: 3 },
					{ content: '阿四家的狗叫豆豆，会拆家', kind: 'fact', importance: 2 },
					{ content: '阿四练琴练到手指疼', kind: 'event', importance: 2, emotion: -1 },
					{ content: '阿四 2024 年 3 月开始学吉他', kind: 'fact' },
					{ content: '短' }], relation: 'friend' }) };
				return;
			}
			if (/整理「/.test(prompt)) {
				yield { type: 'text-delta', text: JSON.stringify(dreamReply ?? { missedPending: [], suggestedRelationStage: null, profile: '阿四：在学吉他的朋友，养了条叫豆豆的狗', outdated: [] }) };
			}
		}
	};
	const asi = () => db.prepare("SELECT * FROM person WHERE qq_uin = '40004'").get();
	let ownerA;
	try {
		p = await call('POST', '/import/history/preview', { text: qqTxt, fileName: '阿四.txt' });
		assert.equal(p.json.ok, true); assert.equal(p.json.format, 'qq-txt'); assert.equal(p.json.messageCount, 3);
		const sp = p.json.speakers;
		assert.deepEqual(sp.map((s) => [s.name, s.qq, s.self, s.count]), [['阿四', '40004', false, 2], ['我', '', true, 1]]);
		assert.equal(p.json.estimate.calls, 1);
		p = await call('POST', '/import/history/start', { previewId: p.json.previewId, selfKeys: sp.filter((s) => s.self).map((s) => s.key), mapping: {} });
		assert.equal(p.json.ok, true); assert.equal(p.json.job.status, 'running');
		let job;
		for (let i = 0; i < 100; i++) { job = (await call('GET', '/import/history/state')).json.job; if (job.status !== 'running') break; await sleep(50); }
		assert.equal(job.status, 'done', JSON.stringify(job.errors));
		assert.deepEqual([job.inserted, job.duplicates, job.total, job.done], [3, 1, 1, 1]);
		assert.match(llmCalls[0], /你和「阿四」过去的私聊记录，2024-03-01 ~ 2024-03-02/);
		assert.match(llmCalls[0], /\] 小鱼：坚持住/, '她自己说的话用人格名');
		ownerA = `user:${asi().canonical_id}`;
		const rows = db.prepare("SELECT * FROM memory WHERE owner_id = ? AND source_session = 'history-import' ORDER BY id").all(ownerA);
		assert.equal(rows.length, 3);
		assert.match(rows[0].evidence, /^导入：阿四\.txt · 阿四 · 2024-03-01 ~ 2024-03-02$/);
		assert.equal(rows[0].created_at, Date.parse('2024-03-02T21:00:00+08:00'), '记忆的时间是聊天的时间');
		assert.equal(rows[0].channel_id, 'private:40004');
		assert.equal(asi().relation_stage, 'friend');
		assert.ok(asi().interaction_count >= 2);
		// 导入完 ≥3 条自动整理一次 → 印象
		const pr = (await call('GET', `/inspector/person?ownerId=${encodeURIComponent(ownerA)}`)).json;
		assert.equal(pr.ok, true); assert.match(pr.profile.text, /豆豆/); assert.equal(pr.profile.by, 'dream'); assert.equal(pr.counts.fact, 2);
		// 同一份再导一次：全是重复
		p = await call('POST', '/import/history/preview', { text: qqTxt, fileName: '阿四.txt' });
		p = await call('POST', '/import/history/start', { previewId: p.json.previewId, selfKeys: [], mapping: {} });
		for (let i = 0; i < 100; i++) { job = (await call('GET', '/import/history/state')).json.job; if (job.status !== 'running') break; await sleep(50); }
		assert.deepEqual([job.status, job.inserted, job.duplicates], ['done', 0, 4]);
		p = await call('POST', '/import/history/start', { previewId: 'gone' });
		assert.equal(p.json.ok, false);
		p = await call('POST', '/import/history/preview', { text: '随便写点什么' });
		assert.equal(p.json.ok, false);
	} finally { /* llm 留到下面整理用 */ }
	ok('导入聊天记录：预览认出她自己、模型提炼成带出处和原时间的记忆、去重、关系升级、导入完自动写印象');

	// 44 记忆纠正：改内容 = 新写一条 + 旧的留档可恢复；手动加；人物画像锁定后 Dream 不覆盖；Dream 标过时
	{
		const old = db.prepare("SELECT * FROM memory WHERE owner_id = ? AND content LIKE '%学吉他%' AND status = 'active'").get(ownerA);
		p = await call('POST', '/inspector/memory-edit', { id: old.id, content: '阿四 2024 年 3 月开始学尤克里里' });
		assert.equal(p.json.ok, true); assert.equal(p.json.replaced, old.id);
		const edited = db.prepare('SELECT * FROM memory WHERE id = ?').get(p.json.id);
		assert.deepEqual([edited.source_session, edited.status, edited.created_at], ['manual', 'active', old.created_at]);
		assert.match(edited.evidence, /原来是：阿四 2024 年 3 月开始学吉他/);
		assert.deepEqual(Object.values(db.prepare('SELECT status, superseded_by FROM memory WHERE id = ?').get(old.id)), ['superseded', edited.id]);
		let pr = (await call('GET', `/inspector/person?ownerId=${encodeURIComponent(ownerA)}`)).json;
		assert.ok(pr.outdated.some((x) => x.id === old.id));
		p = await call('POST', '/inspector/memory-edit', { id: edited.id, importance: 5, kind: 'event' });
		assert.deepEqual(Object.values(db.prepare('SELECT importance, kind FROM memory WHERE id = ?').get(edited.id)), [5, 'event']);
		assert.equal((await call('POST', '/inspector/memory-edit', { id: edited.id, content: '  ' })).json.ok, false);
		assert.equal((await call('POST', '/inspector/memory-restore', { id: old.id })).json.ok, true);
		assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(old.id).status, 'active');
		p = await call('POST', '/inspector/memory-add', { ownerId: ownerA, content: '阿四说不学吉他了，改学架子鼓', kind: 'event', importance: 3 });
		const added = db.prepare('SELECT * FROM memory WHERE id = ?').get(p.json.id);
		assert.deepEqual([added.source_session, added.channel_id], ['manual', 'private:40004']);
		assert.equal((await call('POST', '/inspector/memory-add', { ownerId: 'user:nobody', content: 'x' })).json.ok, false);
		// 主人自己写的印象 = 锁定，Dream 不动它
		p = await call('POST', '/inspector/person', { ownerId: ownerA, displayName: '四哥', relationStage: 'close', profile: '四哥：主人的大学室友' });
		assert.deepEqual([p.json.profile.by, p.json.profile.locked], ['user', true]);
		assert.deepEqual(Object.values(db.prepare('SELECT display_name, relation_stage FROM person WHERE canonical_id = ?').get(ownerA.slice(5))), ['四哥', 'close']);
		assert.equal((await call('POST', '/inspector/person', { ownerId: ownerA, relationStage: 'boss' })).json.ok, false);
		dreamReply = { missedPending: [], suggestedRelationStage: null, profile: '不该写进去', outdated: [{ id: old.id, by: added.id, reason: '不学吉他了' }, { id: added.id, by: old.id }] };
		const nCalls = llmCalls.length;
		p = await call('POST', '/inspector/dream', { ownerId: ownerA });
		assert.equal(p.json.ok, true); assert.equal(p.json.profile.text, '四哥：主人的大学室友', '锁定的印象 Dream 不覆盖');
		assert.doesNotMatch(llmCalls[nCalls], /"profile"/, '锁定时不让模型写印象');
		assert.match(llmCalls[nCalls], new RegExp(`#${added.id}\\[\\d{4}-\\d{2}-\\d{2}\\] 阿四说不学吉他了`));
		assert.deepEqual(Object.values(db.prepare('SELECT status, superseded_by FROM memory WHERE id = ?').get(old.id)), ['outdated', added.id]);
		assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(added.id).status, 'active', '新的推不翻旧的就不算');
		const log = (await call('GET', '/activity')).json.dreamLog;
		assert.equal(log[0].ownerId, ownerA); assert.deepEqual(log[0].outdated.map((x) => x.id), [old.id]);
		// 解锁后 Dream 可以重写
		await call('POST', '/inspector/person', { ownerId: ownerA, profileLocked: false });
		dreamReply = { missedPending: [], suggestedRelationStage: null, profile: '四哥：大学室友，在学架子鼓，养了狗豆豆', outdated: [] };
		p = await call('POST', '/inspector/dream', { ownerId: ownerA });
		assert.deepEqual([p.json.profile.text, p.json.profile.by, p.json.profile.locked], ['四哥：大学室友，在学架子鼓，养了狗豆豆', 'dream', false]);
		assert.equal((await call('POST', '/inspector/dream', { ownerId: 'user:nobody' })).json.ok, false);
		// 聊天时她看得到这份印象；"相关记忆"带出处
		inbox('40004', '我的鼓到了', null);
		assert.match(context.text(at('p40004')), /\[你对 .+ 的印象\] 四哥：大学室友，在学架子鼓/);
		const ov = (await call('GET', `/inspector/overview?ownerId=${encodeURIComponent(ownerA)}`)).json;
		const im = ov.memories.find((m) => /豆豆/.test(m.content));
		assert.match(im.evidence, /^导入：阿四\.txt/); assert.equal(im.source, '导入（聊天记录）');
		assert.equal(ov.memories.find((m) => m.id === added.id).source, '主人手动加的');
	}
	delete services.llm;
	ok('记忆纠正：改内容留旧档可恢复、手动加、主人写的印象锁定不被覆盖、Dream 标过时（新推翻旧才算）、印象进上下文');

	// 45 暂停（设置页 + 主人 QQ 命令）、动态
	{
		const conn = ob.conns[ob.conns.length - 1];
		const cs = (await call('GET', '/channels/state')).json;
		assert.equal(cs.qq.connected, true);
		assert.equal(cs.qq.interject.enabled, false, '插话默认关');
		p = await call('POST', '/sessions/pause', { channelId: 'private:10001', minutes: 30 });
		assert.equal(p.json.ok, true); assert.ok(p.json.until > Date.now() + 29 * 60_000);
		assert.equal((await call('POST', '/sessions/pause', { channelId: 'whatever' })).json.ok, false);
		const chats = (await call('GET', '/channels/state')).json.sessions.chats;
		assert.equal(chats.find((c) => c.channelId === 'private:10001')?.paused, true);
		const nF = host.followups.length;
		conn.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001, message_id: 9601, sender: { nickname: '主人' }, message: [{ type: 'text', data: { text: '暂停的时候说的话' } }] });
		await sleep(600);
		assert.equal(host.followups.length, nF, '暂停中不回');
		let act = (await call('GET', '/activity')).json;
		assert.equal(act.decisions[0].kind, 'paused'); assert.equal(act.decisions[0].text, '暂停的时候说的话');
		assert.deepEqual(act.paused.map((x) => x.channelId), ['private:10001']);
		// 主人发命令：不经过模型，直接回一句
		const nS = ob.sends.length;
		conn.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001, message_id: 9602, sender: { nickname: '主人' }, message: [{ type: 'text', data: { text: '/鱼 继续' } }] });
		await waitFor(() => ob.sends.length > nS);
		assert.equal(ob.sends[nS].params.message[0].data.text, '好，我回来了');
		assert.deepEqual((await call('GET', '/activity')).json.paused, []);
		conn.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001, message_id: 9603, sender: { nickname: '主人' }, message: [{ type: 'text', data: { text: '/鱼 暂停 2小时' } }] });
		await waitFor(() => ob.sends.length > nS + 1);
		assert.equal(ob.sends[nS + 1].params.message[0].data.text, '好，我先安静 2 小时');
		act = (await call('GET', '/activity')).json;
		assert.ok(act.paused[0].until > Date.now() + 119 * 60_000);
		assert.equal(act.decisions[0].kind, 'command');
		assert.equal(host.followups.length, nF, '命令不转进会话');
		// 不是主人发的命令：当普通消息
		conn.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 20002, message_id: 9604, sender: { nickname: '老友' }, message: [{ type: 'text', data: { text: '/鱼 暂停' } }] });
		await waitFor(() => host.followups.length > nF);
		assert.match(host.followups[nF].msg.content[0].text, /\/鱼 暂停/);
		await call('POST', '/sessions/pause', { channelId: 'private:10001', minutes: 0 });
		assert.deepEqual((await call('GET', '/activity')).json.paused, []);
		assert.ok(act.decisions.some((d) => d.kind === 'reply' || d.kind === 'sent' || d.kind === 'memorize'));
	}
	ok('暂停：设置页 / 主人发"/鱼 暂停 2小时""/鱼 继续"，暂停中只记不回；别人发命令当普通话；动态里看得到每次决定');

	// 46 备份 / 导出
	{
		p = await call('POST', '/backup/now', {});
		assert.equal(p.json.ok, true); assert.match(p.json.file, /^soul-\d{8}-\d{6}\.db$/); assert.ok(existsSync(p.json.path));
		const copy = new DatabaseSync(p.json.path, { readOnly: true });
		assert.ok(copy.prepare("SELECT COUNT(*) n FROM memory WHERE source_session = 'history-import'").get().n >= 3, '备份是完整的库');
		copy.close();
		let st = (await call('GET', '/backup/state')).json;
		assert.equal(st.auto, true, '自动备份默认开'); assert.ok(st.list.length >= 1); assert.ok(st.lastAt > 0);
		await call('POST', '/backup/config', { keep: 1 });
		await call('POST', '/backup/now', {});
		st = (await call('GET', '/backup/state')).json;
		assert.equal(st.keep, 1); assert.equal(st.list.length, 1, '只留最近 keep 份');
		await call('POST', '/backup/config', { keep: 7, auto: true });
		const ex = await call('GET', '/export/memories');
		assert.ok(Array.isArray(ex.json));
		const item = ex.json.find((x) => x.qqUin === '40004' && /豆豆/.test(x.content));
		assert.ok(item); assert.match(item.evidence, /导入：阿四\.txt/);
		// 导出的文件能原样导回（全是重复）
		p = await call('POST', '/import/memories', { items: ex.json.slice(0, 20) });
		assert.equal(p.json.inserted, 0);
	}
	ok('备份 / 导出：立刻备份（完整的库）、只留最近 N 份、导出记忆带出处且能原样导回');

	// 47 群里插话 / 叫名字 / 戳一戳 / 撤回 / 群里的主人命令（独立网关，假渠道）
	{
		const qq = { enabled: true, batchMs: 60, followUpCount: 3, followUpSeconds: 120, interject: { enabled: false } };
		const sent = []; const turns = []; const memo = [];
		const ctx3 = { get: (n) => services[n], agents, workspaceRegistry, tools: { get: () => ({}) } };
		const gw = new gwMod.ChatGateway({
			ctx: ctx3, db, clock: { now: () => Date.now() }, getConfig: () => ({ qq, masterQqUin: '10001' }), log: () => {},
			channel: { connected: true, selfId: '1000', send: async (cid, segs) => { sent.push([cid, segs]); return String(8000 + sent.length); }, groupName: async () => '测试群', getMessage: async () => null, isFriend: () => true },
			soul: {
				beginTurn: (id, x) => turns.push({ id, ...x }), nowLabel: () => '现在', resolvePerson: () => null,
				memorizeUnanswered: (_p, m) => memo.push(m.text), availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => []
			}
		});
		gw.random = () => 0.5;
		let mid = 9700;
		const g = (group, user, text, extra = []) => gw.onEvent({ post_type: 'message', message_type: 'group', group_id: group, user_id: user, message_id: ++mid,
			sender: { card: `u${user}` }, message: [...extra, { type: 'text', data: { text } }] });
		const fups = (cid) => host.followups.filter((f) => f.msg.source?.channelId === cid);

		// 插话关着：不点名的话只攒着；打开后（概率 100%）插一句，带上刚才攒的话，不引用
		await g(991, 20002, '今天下雨了好烦');
		await sleep(150);
		assert.equal(fups('group:991').length, 0);
		qq.interject = { enabled: true, chance: 1, cooldownMinutes: 0, maxPerHour: 2 };
		await g(991, 30003, '有没有人推荐个电影');
		await waitFor(() => fups('group:991').length === 1);
		assert.equal(turns.at(-1).interject, true);
		assert.deepEqual(turns.at(-1).backlog, ['u20002：今天下雨了好烦']);
		assert.equal(gw.decisions[0].kind, 'interject'); assert.match(gw.decisions[0].reason, /自己想插一句（100%）/);
		assert.equal(gw.replyTo.has(fups('group:991')[0].id), false, '插话不引用');
		await g(991, 30003, '真的没人吗大家');
		await waitFor(() => fups('group:991').length === 2);
		await g(991, 30003, '好吧那我自己找');
		await sleep(200);
		assert.equal(fups('group:991').length, 2, '每小时上限');
		// 睡着了不插
		gw.interjects.clear();
		gw.soul.availability = () => 'sleeping';
		await g(991, 30003, '有人一起打游戏吗');
		await sleep(150);
		assert.equal(fups('group:991').length, 2);
		gw.soul.availability = () => 'idle';
		// 冷却：刚说过话就不插
		qq.interject.cooldownMinutes = 10;
		gw.lastSpoke.set('group:991', Date.now());
		assert.equal(gw.interjectChance({ channelId: 'group:991', text: '有人一起打游戏吗', userId: '1' }, null, gw.qqConfig()), 0);
		qq.interject = { enabled: false };

		// 叫她名字 = 点名（默认用人格名，≥2 字）；设置了 callNames 就用设置的
		await g(992, 20002, '小鱼你在吗');
		await waitFor(() => fups('group:992').length === 1);
		assert.equal(gw.decisions[0].reason, '叫了她的名字');
		assert.equal(turns.at(-1).interject, false);
		qq.callNames = ['鱼鱼'];
		await g(992, 20002, '我先走了', []);
		gw.follow.clear();
		await sleep(150);
		const before992 = fups('group:992').length;
		await g(992, 20002, '小鱼还在吗');
		await sleep(200);
		assert.equal(fups('group:992').length, before992, '设置了称呼就不再认人格名');
		await g(992, 20002, '鱼鱼晚安');
		await waitFor(() => fups('group:992').length === before992 + 1);
		delete qq.callNames;

		// 戳一戳她 = 点名；一分钟内同一个人再戳不算；戳别人不管
		const poke = (target, user = 30003) => gw.onEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 993, user_id: user, target_id: target, time: Math.floor(Date.now() / 1000) });
		await poke(1000);
		await waitFor(() => fups('group:993').length === 1);
		assert.match(fups('group:993')[0].msg.content[0].text, /戳了戳你/);
		assert.equal(gw.replyTo.has(fups('group:993')[0].id), false, '戳一戳没有消息可引用');
		await poke(1000); await poke(55555, 20002);
		await sleep(200);
		assert.equal(fups('group:993').length, 1);

		// 撤回：还没转进会话的那条就不回了
		qq.batchMs = 300;
		await g(994, 20002, '你好呀', [{ type: 'at', data: { qq: '1000' } }]);
		const recalled = String(mid);
		await gw.onEvent({ post_type: 'notice', notice_type: 'group_recall', group_id: 994, user_id: 20002, operator_id: 20002, message_id: recalled });
		await sleep(500);
		assert.equal(fups('group:994').length, 0);
		assert.equal(gw.decisions[0].kind, 'recalled');
		qq.batchMs = 60;

		// 主人在群里发命令：只管这个群
		await g(995, 10001, '/鱼 暂停 30分钟');
		await waitFor(() => sent.some(([c]) => c === 'group:995'));
		assert.equal(sent.find(([c]) => c === 'group:995')[1][0].data.text, '好，我先安静 30 分钟');
		assert.equal(gw.isPaused('group:995'), true); assert.equal(gw.isPaused('group:994'), false);
		await g(995, 20002, '鱼你还在吗', [{ type: 'at', data: { qq: '1000' } }]);
		await sleep(200);
		assert.equal(fups('group:995').length, 0); assert.ok(memo.includes('鱼你还在吗'), '暂停中点名也只记');
		assert.equal(await gw.triggerProactive('group:995', '想说话了'), false, '暂停中不主动');
		await g(995, 10001, '/鱼 继续');
		await waitFor(() => !gw.isPaused('group:995'));
		await g(995, 20002, '回来啦', [{ type: 'at', data: { qq: '1000' } }]);
		await waitFor(() => fups('group:995').length === 1);
		gw.stop?.();
	}
	ok('群：插话（默认关、概率、带上刚才的话、不引用、每小时上限、睡觉 / 冷却不插）、叫名字算点名、戳一戳、撤回不回、群里暂停命令');
}
