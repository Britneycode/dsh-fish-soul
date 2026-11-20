// 群消息里把「谁是主人」标出来：模型读消息行时直接看到「名字（主人）：…」，
// 不用依赖旁边那个关系块（关系块在 person 行没挂上 master 时不标）。
// 标注按 userId 对 masterQqUin，昵称照旧 sanitize（冒号/换行会被剥掉），
// 「（主人）」是插件加的，对方昵称打不出全角括号照样混不进来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-master-tag-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();

const gateway = (masterQqUin = '10001') => {
	const g = Object.assign(Object.create(ChatGateway.prototype), {
		db,
		log: () => {},
		diag: null,
		stickers: null,
		random: () => 0.5,
		backlog: new Map(),
		ctx: { get: () => null },
		getConfig: () => ({ masterQqUin }),
	});
	return g;
};

const dispatchable = (g) => Object.assign(g, {
	admitImages: async (text) => [{ type: 'text', text }],
	videoNotes: async () => [],
	quoteLine: async () => '',
	applyChatModelFor: () => {},
	typing: () => {},
	judgeTurn: async () => {},
	moodOf: () => ({ mood: '平静', tone: '平静', delay: 1, interject: 1, voice: 1 }),
	replyChannelFor: () => 'group:9',
	workspacePath: () => home,
	bound: new Map(),
	turns: new Map(),
	turnMood: new Map(),
	interjectTurns: new Set(),
	soul: { beginTurn: () => {}, journalOut: () => {} },
	channel: { send: async () => '1' },
	outbox: { hasQueued: () => false, enqueue: () => {} },
	voiceGuardReady: false,
	qqConfig: () => ({ enabled: true }),
});

const mk = (userId, nickname, text, messageId) => ({
	m: { channel: 'qq', chatType: 'group', channelId: 'group:9', targetId: '9', groupId: '9', userId, nickname, messageId, mentioned: true, text, images: [], links: [], timeMs: Date.now() },
	person: null, interject: false,
});

test('本轮群消息：主人的话带（主人），别人的不带', async () => {
	const g = dispatchable(gateway('10001'));
	const seen = [];
	const agent = { id: 'sess-tag-1', followup: async (p) => { seen.push(p); } };
	await g.dispatchInner('group:9', [
		mk('10001', '未云', '今天天气不错', 'm1'),
		mk('20002', '阿四', '是啊', 'm2'),
	], agent);
	assert.equal(seen.length, 1, '要真的进会话一轮');
	const content = String(seen[0].content?.[0]?.text ?? '');
	assert.ok(content.includes('未云（主人）：今天天气不错'), `主人那行要标出来，实际：${content}`);
	assert.ok(content.includes('阿四：是啊'), `别人那行不带标，实际：${content}`);
});

test('masterQqUin 没配时谁都不标', async () => {
	const g = dispatchable(gateway(''));
	const seen = [];
	const agent = { id: 'sess-tag-2', followup: async (p) => { seen.push(p); } };
	await g.dispatchInner('group:9', [mk('10001', '未云', 'hi', 'm2')], agent);
	const content = String(seen[0]?.content?.[0]?.text ?? '');
	assert.ok(content.includes('未云：hi'), `没配主人号就不该有标注，实际：${content}`);
	assert.ok(!content.includes('（主人）'), '没配主人号时不该出现（主人）');
});

test('接线：pushBacklog 存的名字带（主人），backlog 行因此带标', async () => {
	const g = gateway('10001');
	g.pushBacklog({ channelId: 'group:7', nickname: '未云', userId: '10001', messageId: 'b1', timeMs: Date.now(), text: '我回来了', images: [] });
	g.pushBacklog({ channelId: 'group:7', nickname: '阿四', userId: '20002', messageId: 'b2', timeMs: Date.now(), text: '哦', images: [] });
	const r = g.takeBacklog('group:7', new Set());
	assert.ok(r.lines.some((l) => l === '未云（主人）：我回来了'), `backlog 里主人那行要带标，实际：${JSON.stringify(r.lines)}`);
	assert.ok(r.lines.some((l) => l === '阿四：哦'), `backlog 里别人那行不带标，实际：${JSON.stringify(r.lines)}`);
});

test('接线：dispatchInner 本轮批的 backlog 经 beginTurn 进瞬态块，主人行带标', async () => {
	// 主人先说了句话没点名（进 backlog），然后别人 @ 她触发一轮。
	// backlog 不走 followup content，是 beginTurn 的参数 → buildContextBlock 的「刚才群里在聊」。
	const g = dispatchable(gateway('10001'));
	g.pushBacklog({ channelId: 'group:9', nickname: '未云', userId: '10001', messageId: 'old1', timeMs: Date.now(), text: '刚才那个视频不错', images: [] });
	const turns = [];
	g.soul = { beginTurn: (sid, p) => { turns.push(p); }, journalOut: () => {} };
	const agent = { id: 'sess-tag-3', followup: async () => {} };
	await g.dispatchInner('group:9', [mk('20002', '阿四', '@鱼 你觉得呢', 'm3')], agent);
	assert.equal(turns.length, 1, 'beginTurn 要被调一次');
	const lines = turns[0]?.backlog?.lines ?? [];
	assert.ok(lines.some((l) => l === '未云（主人）：刚才那个视频不错'), `backlog 主人行要带标，实际：${JSON.stringify(lines)}`);
});
