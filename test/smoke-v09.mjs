// v0.9 的冒烟测试（"她的习惯"）：心情影响行为、去 AI 味、合并转发、群设定、按聊天选模型、群里冷热、
// 记忆调试器、每日日记、小互动、每轮判断心情。由 smoke.mjs 最后调用，共用假宿主。
export async function run(t) {
	const { assert, ok, call, sleep, waitFor, context, db, services, workspaceRegistry, inbox, at, mod } = t;
	const bh = await import('../lib/behavior.js');
	const sm = await import('../lib/soul-memory.js');
	const gwMod = await import('../lib/gateway.js');
	let p;

	// 90 纯函数
	{
		const c = bh.behaviorConfig(undefined);
		assert.deepEqual([c.moodAffects, c.outFilter.enabled, c.forward.enabled, c.heat.enabled, c.interactions.pokeBack, c.interactions.react, c.turnMood.enabled, c.diary.enabled, c.diary.qzone],
			[true, true, true, true, true, false, false, true, false], '默认：每轮判断心情 / 表情回应 / QQ 空间关，其余开');
		assert.equal(bh.behaviorConfig({ outFilter: { maxChars: 5 }, diary: { hour: 3 } }).outFilter.maxChars, 60, '夹到下限');
		assert.equal(bh.behaviorConfig({ diary: { hour: 3 } }).diary.hour, 18);
		const angry = bh.moodProfile({ tone: '慵懒', mood: { label: '生气', level: 2 } });
		assert.ok(angry.delay > 2 && angry.interject < 0.3 && angry.sticker < 0.3, '懒 + 生气：回得慢、不想插话、不发表情包');
		assert.match(angry.hint, /懒洋洋.*生气/);
		const happy = bh.moodProfile({ mood: { label: '开心', level: 1 } });
		assert.ok(happy.delay < 1 && happy.interject > 1 && happy.sticker > 1, '开心：反过来（情绪弱的时候幅度小）');
		assert.ok(happy.interject < bh.moodProfile({ mood: { label: '开心', level: 3 } }).interject);
		assert.deepEqual(bh.moodProfile({}), { delay: 1, interject: 1, sticker: 1, voice: 1, tone: '', mood: '', hint: '' });
		assert.equal(bh.firstDelayMs(happy, () => 0.5), 0);
		assert.ok(bh.firstDelayMs(angry, () => 0.5) === 6000, '最多等 6 秒');

		let r = bh.deAi('作为一个AI助手，我觉得**这个**不错。\n\n首先，你要多喝水。其次，早点睡。最后，希望对你有帮助！');
		assert.equal(r.text, '我觉得这个不错。\n\n你要多喝水。早点睡。');
		assert.deepEqual(r.changes, ['markdown', 'AI 自称', '客套收尾', '首先其次']);
		r = bh.deAi('## 推荐\n- 火锅\n- 烧烤\n\n[点这里](https://x.cn) 看');
		assert.equal(r.text, '推荐\n火锅\n烧烤\n\n点这里 https://x.cn 看', 'markdown 链接去壳但留下网址（分享视频要用）');
		assert.equal(bh.deAi('[https://b23.tv/x](https://b23.tv/x)').text, 'https://b23.tv/x');
		assert.deepEqual(bh.deAi('首先我想说你好棒').changes, [], '只出现一次"首先"不算列条目');
		assert.deepEqual(bh.deAi('如果你还有其他问题，随时问我。'), { text: '', changes: ['客套收尾', '整段都是套话'] });
		assert.equal(bh.deAi('好呀\n\n[语音] 晚安').text, '好呀\n\n[语音] 晚安', '正常的话不动');
		r = bh.deAi(`${'今天天气很好。'.repeat(10)}\n\n${'我们去公园吧。'.repeat(10)}`, { maxChars: 100 });
		assert.ok([...r.text].length <= 100 && /。$/.test(r.text) && r.changes.includes('太长截短'), '太长截到句末');

		// 动作描写 / 新套话 / 破折号 / 自定义（参考 MaiBot、Humanizer-zh）
		assert.deepEqual(bh.deAi('（轻轻叹了口气）好吧，听你的'), { text: '好吧，听你的', changes: ['动作描写'] });
		assert.equal(bh.deAi('*揉了揉眼睛* 刚醒').text, '刚醒');
		assert.equal(bh.deAi('（眼睛亮了起来）真的吗').text, '真的吗');
		for (const x of ['今天好累（小声）', '哈哈哈（bushi）', '我在家（大概三点到）', '(｡•́︿•̀｡) 好难过', '（我昨天吃了火锅）', '想出去玩随时找我', '让我们看看谁先到', '我们只改了标题——正文没动']) {
			assert.deepEqual(bh.deAi(x).changes, [], `不误伤：${x}`);
		}
		assert.deepEqual(bh.deAi('这个*很*重要'), { text: '这个很重要', changes: ['markdown'] });
		assert.deepEqual(bh.deAi('好问题！其实我也不知道'), { text: '其实我也不知道', changes: ['客服腔'] });
		assert.equal(bh.deAi('我理解你的感受，确实挺烦的').text, '确实挺烦的');
		assert.equal(bh.deAi('让我们来看看这个问题：其实很简单').text, '其实很简单');
		assert.equal(bh.deAi('以下是我的建议：早点睡').text, '早点睡');
		assert.equal(bh.deAi('有什么问题欢迎随时找我哦～').text, '');
		assert.deepEqual(bh.deAi('结果出来了——答案揭晓了——没考上'), { text: '结果出来了，答案揭晓了，没考上', changes: ['破折号'] });
		assert.deepEqual(bh.deAi('说实话吧，真的绝绝子', { extra: ['说实话吧，', '/绝绝子+/', '/[/'] }), { text: '真的', changes: ['自定义'] }, '字面 + 正则，写错的正则跳过');
		const oc = bh.behaviorConfig({ outFilter: { extra: '  说实话吧\n\n说实话吧\n宝子们 ' } }).outFilter;
		assert.deepEqual([oc.split, oc.extra], [true, ['说实话吧', '宝子们']], '拆条默认开；额外说法去空去重');

		// 拆成几条（参考 MaiBot / AstrBot 的分段回复）
		const sc = (x, v) => bh.splitChat(x, { random: () => v });
		assert.deepEqual(sc('我没有生气。', 0.9), { text: '我没有生气', changes: [] }, '一句：只去句号');
		assert.deepEqual(sc('今天去公园了。人好多啊！不过还挺开心的。你呢？', 0.9), { text: '今天去公园了。人好多啊！\n\n不过还挺开心的\n\n你呢？', changes: ['拆成 3 条'] }, '一段最多 3 条');
		assert.equal(sc('今天去公园了。人好多啊！不过还挺开心的。你呢？', 0.1).text, '今天去公园了。人好多啊！不过还挺开心的。你呢？', '随机并回去');
		assert.equal(sc('他说「好的。我知道了。」然后就走了。', 0.9).text, '他说「好的。我知道了。」然后就走了', '引号里不拆');
		assert.equal(sc('[语音] 晚安。好梦。', 0.9).text, '[语音] 晚安。好梦。', '语音段不拆');
		assert.equal(sc('哈哈哈。。。', 0.9).text, '哈哈哈。。。', '省略号式的句号留着');
		assert.equal(sc('第一行。\n第二行。', 0.9).text, '第一行。\n第二行。', '多行的段不拆');
		assert.equal(sc('a。b。c\n\nd。e。f\n\ng。h\n\ni', 0.9).text.split('\n\n').length, 5, '整条最多 5 条');

		const fl = bh.forwardLines({ messages: [
			{ sender: { nickname: '阿二' }, message: [{ type: 'text', data: { text: '今晚吃啥' } }] },
			{ type: 'node', data: { nickname: '阿三', content: [{ type: 'image', data: {} }, { type: 'forward', data: { id: 'x' } }] } },
			{ sender: { card: '小四' }, content: '火锅！' }
		] }, { maxLines: 2 });
		assert.deepEqual(fl, ['阿二：今晚吃啥', '阿三：【图片】【合并转发】', '……（后面还有 1 条）']);

		const heat = new bh.GroupHeat();
		const hc = bh.behaviorConfig({}).heat;
		const t0 = Date.now();
		assert.equal(heat.state('g', hc, 0, t0).state, 'diving');
		for (let i = 0; i < 6; i++) heat.observe('g', `u${i % 3}`, t0 - i * 1000);
		assert.deepEqual([heat.state('g', hc, 0, t0).state, heat.state('g', hc, 0, t0).factor], ['hot', 1.8], '两分钟内 6 条、3 个人 = 热闹');
		assert.equal(heat.state('g', hc, 0, t0 + 200_000).state, 'diving', '过了窗口就凉了');
		const cool = heat.state('g', hc, t0 - 60_000, t0);
		assert.equal(cool.state, 'cooling'); assert.ok(cool.factor > 0.2 && cool.factor < 0.3, '刚说完话：从两成慢慢恢复');

		const cm = { private: { provider: 'ds', model: 'chat' }, group: { provider: 'gone', model: 'x' }, overrides: [{ channelId: 'group:1', provider: 'sf', model: 'qwen' }, { channelId: 'bad', provider: 'a', model: 'b' }] };
		assert.equal(bh.chatModelsConfig(cm).overrides.length, 1);
		const known = (p2) => p2 !== 'gone';
		assert.deepEqual(bh.resolveChatModel(cm, 'group:1', { known }), { provider: 'sf', model: 'qwen', from: 'chat' });
		assert.equal(bh.resolveChatModel(cm, 'group:2', { known }), null, '群聊默认的提供方没了 → 跟 DSH 默认');
		assert.deepEqual(bh.resolveChatModel(cm, 'private:5', { known }).from, 'private');
		assert.deepEqual(bh.resolveChatModel(cm, 'bili:5', { known }).model, 'chat', 'B站 / 抖音私信也按私聊默认');

		const now = Date.now();
		sm.setMood(db, 'user:t90', { label: '开心' }, now);
		assert.equal(sm.markMoodSaid(db, 'user:t90', now), true, '新情绪：流露一次');
		assert.equal(sm.markMoodSaid(db, 'user:t90', now), false, '之后不再说');
		sm.setMood(db, 'user:t90', { label: '开心', reason: '又夸她了' }, now);
		assert.equal(sm.markMoodSaid(db, 'user:t90', now), false, '同一个情绪加深也不重复说');
		sm.setMood(db, 'user:t90', { label: '委屈' }, now);
		assert.equal(sm.markMoodSaid(db, 'user:t90', now), true, '换了情绪重新算');
		assert.equal(sm.markMoodSaid(db, 'user:nobody', now), false);
	}
	// 吐槽 / 反问里的「我是AI」不算自称
	for (const x of ['你怀疑我是AI 我还怀疑你是来查户口的呢', '谁说我是AI啊', '我是AI吗？你猜']) assert.deepEqual(bh.deAi(x).changes, [], x);
	assert.ok(bh.deAi('我是一个AI助手，很高兴为你服务。今天想聊点啥').changes.includes('AI 自称'));
	// 自己的名字前缀去掉（别人的不动、不吞空行）；检索词补单字（「考试」对上「考高数」）
	assert.equal(bh.stripSelfName('鱼：啊？咋了\n\n 小鱼 ： 我也不知道\n阿二：在吗\n鱼丸：好', ['鱼', '小鱼']), '啊？咋了\n\n 我也不知道\n阿二：在吗\n鱼丸：好');
	{
		const seg = await import('../lib/segment.js');
		const { terms: q, weights } = seg.queryForBm25('明天就要考试了');
		assert.ok(q.includes('考试') && q.includes('考') && !q.includes('了') && weights.get('考') < 1 && !weights.has('考试'));
		const docs = [{ id: 1, keywords: seg.tokenizeForBm25('阿二下周三要考高数'), updated_at: 0, importance: 3 }, { id: 2, keywords: seg.tokenizeForBm25('阿二喜欢吃火锅'), updated_at: 0, importance: 3 }];
		assert.equal(seg.bm25Search(docs, q, 0, 50, { weights })[0]?.id, 1, '只靠关键词也能从「考试」想起「考高数」');
	}
	ok('习惯 · 纯函数：心情 → 行为倍率、去 AI 味（markdown / AI 自称 / 客套 / 首先其次 / 太长截短）、去掉自己的名字前缀、检索词补单字、合并转发、群里冷热、按聊天选模型、情绪只说一次');

	// 91 网关：独立网关 + 假渠道（OneBot 扩展接口会失败的先试、记住不支持的）
	{
		const qq = { enabled: true, batchMs: 30, followUpCount: 0, followUpSeconds: 60, interject: { enabled: false } };
		const cfg = { qq, masterQqUin: '10001', behavior: { interactions: { pokeBackChance: 1, react: true, reactChance: 1 } }, chatModels: {} };
		const sent = []; const turns = []; const calls = []; const fups = []; const created = []; const selects = []; const live = new Map();
		let mood = bh.NEUTRAL_MOOD; let judged = [];
		const agents3 = {
			async create(opts) {
				created.push(opts);
				const a = { id: opts.sessionId, session: { id: opts.sessionId },
					model: { cur: opts.agentOptions ?? null, current() { return this.cur; }, select(s) { selects.push([opts.sessionId, s]); this.cur = s; } },
					async followup(msg) { fups.push({ id: opts.sessionId, msg }); } };
				live.set(opts.sessionId, a);
				return { agent: a };
			},
			async resume() { throw new Error('不恢复'); },
			get: (id) => live.get(id)
		};
		const forward = { messages: [{ sender: { nickname: '阿二' }, message: [{ type: 'text', data: { text: '周末去爬山' } }] }, { sender: { nickname: '阿三' }, message: [{ type: 'text', data: { text: '我不去' } }] }] };
		const channel = {
			connected: true, selfId: '1000', isFriend: () => true, groupName: async () => '测试群', getMessage: async () => null,
			send: async (cid, segs) => { sent.push([cid, segs]); return String(7000 + sent.length); },
			call: async (action, params) => {
				calls.push([action, params]);
				if (action === 'get_forward_msg') return forward;
				if (action === 'send_poke') throw new Error('不支持的动作（retcode 1404）');
				if (action === 'group_poke' || action === 'set_msg_emoji_like') return null;
				throw new Error('unknown action（retcode 1404）');
			}
		};
		const ctx3 = { get: (n) => (n === 'agents' ? agents3 : n === 'workspaceRegistry' ? workspaceRegistry : undefined), agents: agents3, workspaceRegistry, tools: { get: () => ({}) } };
		const gw = new gwMod.ChatGateway({
			ctx: ctx3, db, clock: { now: () => Date.now() }, getConfig: () => cfg, log: () => {}, channel,
			soul: {
				beginTurn: (id, x) => turns.push({ id, ...x }), nowLabel: () => '现在', resolvePerson: (m) => ({ canonical_id: `p${m.userId}`, display_name: m.nickname, relation_stage: 'friend' }),
				memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [],
				moodFor: () => mood, judgeMood: async (...a) => { judged.push(a); }
			}
		});
		gw.random = () => 0.5;
		const waits = [];
		gw.sleep = async (ms) => { if (ms > 0) waits.push(ms); };
		let mid = 9900;
		const g = (group, user, text, extra = []) => gw.onEvent({ post_type: 'message', message_type: 'group', group_id: group, user_id: user, message_id: ++mid,
			sender: { card: `u${user}` }, message: [...extra, { type: 'text', data: { text } }] });
		const fupsOf = (cid) => fups.filter((f) => f.msg.source?.channelId === cid);
		const AT = [{ type: 'at', data: { qq: '1000' } }];

		// 合并转发：点名时展开一层；表情回应点在叫她的那条上
		await g(9901, 20002, '你看看这个', [...AT, { type: 'forward', data: { id: 'fw1' } }]);
		await waitFor(() => fupsOf('group:9901').length === 1);
		const text1 = fupsOf('group:9901')[0].msg.content[0].text;
		assert.match(text1, /【合并转发（2 条）：\n阿二：周末去爬山\n阿三：我不去\n】你看看这个/);
		assert.ok(calls.some(([a, x]) => a === 'set_msg_emoji_like' && x.message_id === mid), '表情回应');
		assert.equal(gw.decisions.find((d) => d.kind === 'react')?.channelId, 'group:9901');
		// 按聊天选模型：新会话用设置里的；已经开着的会话切过去；清掉切回 DSH 默认
		assert.equal(created.at(-1).agentOptions, undefined, '没设置 = 跟 DSH 默认（这里没有默认模型服务）');
		const sid1 = fupsOf('group:9901')[0].id;
		cfg.chatModels = { group: { provider: 'ds', model: 'ds-group' }, overrides: [{ channelId: 'group:9902', provider: 'ds', model: 'ds-special' }] };
		await g(9902, 20002, '在吗', AT);
		await waitFor(() => fupsOf('group:9902').length === 1);
		assert.deepEqual(created.at(-1).agentOptions, { provider: 'ds', model: 'ds-special' }, '单个聊天指定的优先');
		await g(9901, 20002, '还在吗', AT);
		await waitFor(() => fupsOf('group:9901').length === 2);
		assert.deepEqual(selects.at(-1), [sid1, { provider: 'ds', model: 'ds-group' }], '开着的会话切到群聊默认');

		// 去 AI 味 + 心情：生气时第一条多等、表情包不发、连发间隔变长
		mood = bh.moodProfile({ mood: { label: '生气', level: 2 } });
		gw.random = () => 0.9;
		await g(9903, 20002, '你怎么不理我', AT);
		await waitFor(() => fupsOf('group:9903').length === 1);
		const sid3 = fupsOf('group:9903')[0].id;
		sent.length = 0; waits.length = 0;
		await gw.sendReply(sid3, { text: '作为一个AI，我没有生气。\n\n**哼**，不想理你 ![ok](_stickers/ok.png)\n\n希望对你有帮助！', images: [] });
		assert.deepEqual(sent.map(([, segs]) => segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('')), ['我没有生气', '哼，不想理你'], '去掉 AI 自称、markdown、客套，句尾句号去掉');
		assert.equal(sent.flatMap(([, segs]) => segs).filter((s) => s.type === 'image').length, 0, '生气：表情包没发');
		assert.ok(waits[0] >= 3000, '第一条之前多等了一会儿');
		assert.ok(gw.decisions.some((d) => d.kind === 'filtered' && /去 AI 味：AI 自称、markdown|去 AI 味：markdown、AI 自称/.test(d.reason)));
		assert.ok(gw.decisions.some((d) => d.kind === 'filtered' && /这张表情包没发/.test(d.reason)));
		sent.length = 0;
		assert.equal(await gw.sendReply(sid3, { text: '我是一个AI语言模型。', images: [] }), true);
		assert.equal(sent.length, 0, '整段都是 AI 自称：不发');
		cfg.behavior.outFilter = { enabled: false };
		await gw.sendReply(sid3, { text: '我是一个AI语言模型。', images: [] });
		assert.equal(sent.length, 1, '关掉去 AI 味就原样发');
		cfg.behavior.outFilter = { enabled: true };
		mood = bh.NEUTRAL_MOOD; gw.random = () => 0.9;
		sent.length = 0;
		await gw.sendReply(sid3, { text: '（歪着头想了想）今天去公园了。人好多啊！你呢？', images: [] });
		assert.deepEqual(sent.map(([, segs]) => segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('')), ['今天去公园了', '人好多啊！', '你呢？'], '去掉动作描写、拆成三条');
		assert.ok(gw.decisions.some((d) => d.kind === 'filtered' && /动作描写、拆成 3 条/.test(d.reason)));
		cfg.behavior.outFilter = { enabled: true, split: false };
		sent.length = 0;
		await gw.sendReply(sid3, { text: '今天去公园了。人好多啊！', images: [] });
		assert.equal(sent.length, 1, '关掉拆条就不拆');
		cfg.behavior.outFilter = { enabled: true };
		mood = bh.NEUTRAL_MOOD; gw.random = () => 0.5;

		// 戳一戳：戳回去（send_poke 不支持 → group_poke），不支持的接口记住了就不再试
		const poke = (user) => gw.onEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 9904, user_id: user, target_id: 1000, time: Math.floor(Date.now() / 1000) });
		await poke(30003);
		await waitFor(() => calls.some(([a]) => a === 'group_poke'));
		assert.deepEqual(calls.filter(([a]) => /poke/.test(a)).map(([a]) => a), ['send_poke', 'group_poke']);
		await poke(40004);
		await waitFor(() => calls.filter(([a]) => a === 'group_poke').length === 2);
		assert.equal(calls.filter(([a]) => a === 'send_poke').length, 1, '不支持的不再调');
		cfg.behavior.interactions.pokeBack = false;
		await poke(50005);
		await sleep(100);
		assert.equal(calls.filter(([a]) => a === 'group_poke').length, 2, '关掉就不戳回去');

		// 私聊"正在输入"（不支持就记住）；每轮判断心情（开了才调）
		const pm = (text) => gw.onEvent({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 20002, message_id: ++mid, sender: { nickname: '阿二' }, message: [{ type: 'text', data: { text } }] });
		await pm('早');
		await waitFor(() => fupsOf('private:20002').length === 1);
		assert.ok(calls.some(([a, x]) => a === 'set_input_status' && x.user_id === 20002));
		assert.equal(judged.length, 0, '每轮判断心情默认关');
		cfg.behavior.turnMood = { enabled: true };
		await pm('我今天被老板骂了');
		await waitFor(() => fupsOf('private:20002').length === 2);
		assert.equal(judged.length, 1); assert.equal(judged[0][2], '我今天被老板骂了');
		assert.equal(calls.filter(([a]) => a === 'set_input_status').length, 1, 'set_input_status 不支持：只试一次');
		assert.deepEqual(created.find((c) => fupsOf('private:20002')[0].id === c.sessionId)?.agentOptions, undefined, '私聊没设置默认');

		// 群里冷热：热闹时插话概率翻倍，她说完话冷却
		qq.interject = { enabled: true, chance: 0.2, cooldownMinutes: 0, maxPerHour: 30 };
		const msg = { channelId: 'group:9905', text: '有没有人推荐个电影看', userId: '1' };
		const base = gw.interjectChance(msg, null, gw.qqConfig());
		for (let i = 0; i < 6; i++) await g(9905, 20000 + (i % 3), `聊天${i}`);
		assert.equal(gw.heatOf('group:9905').state, 'hot');
		assert.ok(Math.abs(gw.interjectChance(msg, null, gw.qqConfig()) - base * 1.8) < 1e-9, '热闹 ×1.8');
		gw.lastSpoke.set('group:9905', Date.now());
		assert.equal(gw.heatOf('group:9905').state, 'cooling');
		assert.ok(gw.interjectChance(msg, null, gw.qqConfig()) < base * 0.25, '刚说完话：冷却');
		gw.lastSpoke.delete('group:9905');
		mood = bh.moodProfile({ mood: { label: '生气', level: 2 } });
		assert.ok(gw.interjectChance(msg, null, gw.qqConfig()) < base * 1.8 * 0.35, '生气时不太想插话');
		mood = bh.NEUTRAL_MOOD;
		gw.random = () => 0;
		await g(9905, 20001, '大家周末干嘛');
		await waitFor(() => fupsOf('group:9905').length === 1);
		assert.match(gw.decisions.find((d) => d.kind === 'interject').reason, /自己想插一句（\d+%） · 群里正热闹/);
		gw.stop?.();
	}
	ok('习惯 · 网关：合并转发展开、表情回应、按聊天选模型（新会话 / 开着的会话切换）、去 AI 味（整段套话不发）、生气时慢回不发表情包、戳回去（不支持的接口记住）、正在输入、每轮判断心情、群里热闹 / 冷却');

	// 92 路由 + 上下文：习惯开关、群设定、按聊天选模型、记忆调试器、日记、情绪只说一次
	{
		p = await call('GET', '/behavior/state');
		assert.equal(p.json.ok, true);
		assert.equal(p.json.config.turnMood.enabled, false);
		assert.ok(p.json.groups.some((x) => x.groupId === '9901' && x.heat?.state), '有会话的群都列出来（带冷热）');
		p = await call('POST', '/behavior/config', { outFilter: { maxChars: 99999 }, turnMood: { enabled: true }, bogus: 1 });
		assert.deepEqual([p.json.config.outFilter.maxChars, p.json.config.outFilter.enabled, p.json.config.turnMood.enabled, p.json.config.bogus], [2000, true, true, undefined]);
		p = await call('POST', '/behavior/config', { turnMood: { enabled: false } });
		assert.equal(p.json.config.outFilter.maxChars, 2000, '只改传了的');
		await call('POST', '/behavior/config', { outFilter: { maxChars: 300 } });

		// 群设定：只进那个群的上下文
		assert.equal((await call('POST', '/groups/note', { groupId: 'abc', note: 'x' })).json.ok, false);
		p = await call('POST', '/groups/note', { groupId: '777', note: '这是考研群，别聊游戏；大家叫你"鱼老师"' });
		assert.equal(p.json.ok, true);
		inbox('20002', '今天复习了吗', 777);
		assert.match(context.text(at('g777')), /\[你在这个群（主人写的，只在这个群适用[^\]]*\] 这是考研群，别聊游戏/);
		inbox('20002', '今天复习了吗', 778);
		assert.doesNotMatch(context.text(at("g778")), /你在这个群（主人写的/);
		assert.equal((await call('GET', '/behavior/state')).json.groups.find((x) => x.groupId === '777').note.slice(0, 5), '这是考研群');

		// 按聊天选模型
		p = await call('POST', '/chat-models/config', { private: { provider: 'ds', model: 'ds-chat' }, channelId: 'private:10001', selection: { provider: 'ds', model: 'ds-r1' } });
		assert.equal(p.json.ok, true);
		assert.deepEqual(p.json.config.private, { provider: 'ds', model: 'ds-chat' });
		assert.deepEqual(p.json.chats.find((c) => c.channelId === 'private:10001')?.resolved, { provider: 'ds', model: 'ds-r1', from: 'chat' });
		p = await call('POST', '/chat-models/config', { private: null, channelId: 'private:10001', selection: null });
		assert.deepEqual([p.json.config.private, p.json.config.overrides.length], [null, 0], '清空 = 跟 DSH 默认');

		// 记忆调试器：想起的带分数，没想起的说原因；群里不想起私聊的
		const owner = `user:${db.prepare("SELECT canonical_id FROM person WHERE qq_uin = '20002'").get().canonical_id}`;
		assert.equal((await call('POST', '/memory/debug', { ownerId: owner, text: '' })).json.ok, false);
		p = await call('POST', '/memory/debug', { ownerId: owner, text: '高数考试准备得怎么样' });
		assert.equal(p.json.ok, true);
		const hit = p.json.recalled.find((m) => /考高数/.test(m.content));
		assert.ok(hit && hit.why === '想起来了' && hit.score > 0 && hit.rank >= 1 && hit.bm25Rank >= 1 && typeof hit.when === 'string');
		assert.ok(p.json.others.every((m) => m.why !== '想起来了'));
		const priv = sm.insertMemory(db, null, { ownerId: owner, channel: 'qq-private', kind: 'fact', content: '阿二偷偷说高数挂过一次', importance: 3, private: true }, Date.now());
		p = await call('POST', '/memory/debug', { ownerId: owner, text: '高数挂科', inGroup: true });
		assert.ok(!p.json.recalled.some((m) => m.id === priv));
		assert.equal(p.json.excluded.find((m) => m.id === priv)?.why, '私聊里说的，群里不想起');
		p = await call('POST', '/memory/debug', { ownerId: owner, text: '高数挂科' });
		assert.ok(p.json.recalled.some((m) => m.id === priv), '私聊里能想起');

		// 情绪只说一次
		sm.setMood(db, owner, { label: '想念', reason: '好几天没聊' }, (await call('GET', '/life/state')).json.clock.virtualNowMs);
		inbox('20002', '我回来啦');
		assert.match(context.text(at('p20002')), /想念（好几天没聊）.*这轮可以自然地流露一次/);
		inbox('20002', '你在干嘛');
		assert.match(context.text(at('p20002')), /想念.*已经表现过了，别再提/);
		assert.match(context.text(at('p20002')), /\[你现在的状态\] .*有点想对方/, '心情 → 状态提示');

		// 日记：现在写一篇（假模型）→ 她自己的私密记忆 + 明天想聊的；第二天跟那个人私聊时提醒
		const name = db.prepare("SELECT display_name FROM person WHERE qq_uin = '20002'").get().display_name;
		services.llm = { listProviders: () => [], async *stream() { yield { type: 'text-delta', text: JSON.stringify({ diary: '今天陪大家复习高数，有点累但挺开心。', topics: [{ who: name, topic: '问问他高数复习到哪了' }] }) }; } };
		try {
			p = await call('POST', '/diary/write-now', {});
		} finally { delete services.llm; }
		assert.equal(p.json.ok, true, JSON.stringify(p.json));
		assert.match(p.json.entry.diary, /复习高数/);
		const row = db.prepare("SELECT * FROM memory WHERE owner_id = 'self' AND kind = 'diary' ORDER BY id DESC LIMIT 1").get();
		assert.equal(row.visibility, 'private', '日记是私密的（群里不会想起）');
		assert.match(row.content, /的日记：今天陪大家复习高数/);
		assert.equal(p.json.diary.entries[0].id, row.id);
		assert.equal(p.json.diary.topics.items[0].ownerId, owner);
		inbox('20002', '晚上好');
		assert.match(context.text(at('p20002')), /\[昨晚日记里想跟 .+ 聊的\] 问问他高数复习到哪了/);
		assert.equal((await call('GET', '/activity')).json.decisions.find((d) => d.kind === 'diary')?.title, '日记');
		// 到点才写、一天一篇
		const { diary } = mod.testHooks.soul;
		const { setKv } = await import('../lib/db.js');
		setKv(db, 'diary.last', '');
		assert.equal(await diary.tick(), null, '还没到点 / 今天没聊过就不写（取决于虚拟时间）');
		// 模型常见的坏 JSON：字符串里直接换行、正文里英文引号、包在思考段 / 代码块里 → 照样写成
		const fake = (text) => { services.llm = { listProviders: () => [], async *stream() { yield { type: 'text-delta', text }; } }; };
		for (const [label, text, want] of [
			['换行', '{"diary":"今天下雨。\n晚上吃了面，挺好。","topics":[]}', /今天下雨。\n晚上吃了面/],
			['引号', '<think>格式 {"diary":...}</think>```json\n{"diary":"她说"好"然后就睡了","topics":[]}\n```', /她说"好"然后就睡了/],
			['截断', '{"diary":"今天一整天都在发呆，傍晚出去走了走，风挺大', /傍晚出去走了走/]
		]) {
			fake(text);
			try { p = await call('POST', '/diary/write-now', {}); } finally { delete services.llm; }
			assert.equal(p.json.ok, true, `${label}：${JSON.stringify(p.json)}`);
			assert.match(p.json.entry.diary, want, label);
		}
		// 写不成要说清楚是哪一步：没回 / 格式不对
		fake('');
		try { p = await call('POST', '/diary/write-now', {}); } finally { delete services.llm; }
		assert.equal(p.json.ok, false);
		assert.match(p.json.error, /模型没回/);
		// 推理模型把答案留在思考里、正文是空的：日记照样能用；空的话说清楚空在哪
		services.llm = { listProviders: () => [], async *stream() { yield { type: 'reasoning-delta', text: '想想……{"diary":"今天在思考里写完了日记。","topics":[]}' }; yield { type: 'finish', finishReason: 'stop' }; } };
		try { p = await call('POST', '/diary/write-now', {}); } finally { delete services.llm; }
		assert.equal(p.json.ok, true, JSON.stringify(p.json));
		assert.match(p.json.entry.diary, /在思考里写完了/);
		services.llm = { listProviders: () => [], async *stream() { yield { type: 'reasoning-delta', text: '嗯……' }; yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8000 } }; yield { type: 'finish', finishReason: 'length' }; } };
		try { p = await call('POST', '/diary/write-now', {}); } finally { delete services.llm; }
		assert.match(p.json.error, /只有思考.*输出 8000 token.*结束原因 length/, p.json.error);
		fake('{"mood":"开心"}');
		try { p = await call('POST', '/diary/write-now', {}); } finally { delete services.llm; }
		assert.match(p.json.error, /不是要的格式/);

		// 每轮判断心情：把握够才改，同一个情绪不重复记
		const notes = [];
		const judge = bh.makeMoodJudge({ db, clock: { now: () => Date.now() }, getConfig: () => ({ behavior: { turnMood: { enabled: true, minConfidence: 0.7 } } }),
			personaName: () => '小鱼', recentLines: () => [], note: (k, x) => notes.push([k, x]),
			callLlm: async (prompt) => (/被老板骂/.test(prompt) ? '{"mood":"担心","intensity":2,"confidence":0.9,"reason":"他挨骂了"}' : '{"mood":"开心","confidence":0.3}') });
		assert.equal((await judge('user:t92', '阿二', '我今天被老板骂了', 'private:1')).changed, true);
		assert.equal(sm.getMood(db, 'user:t92', Date.now()).label, '担心');
		assert.equal((await judge('user:t92', '阿二', '哈哈哈', 'private:1')).changed, false, '把握不够不改');
		assert.equal((await judge('user:t92', '阿二', '我今天被老板骂了', 'private:1')).changed, false, '已经是这个情绪');
		assert.equal(notes.length, 1); assert.match(notes[0][1].reason, /情绪变成「担心」（把握 90%）：他挨骂了/);
	}
	ok('习惯 · 路由 / 上下文：开关（只改传了的、夹范围）、群设定只进那个群、按聊天选模型、记忆调试器（分数 / 没想起的原因 / 群里不想起私聊的）、情绪只流露一次、日记（私密记忆 + 第二天想聊的）、每轮判断心情（把握门槛）');
}
