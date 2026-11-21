// #151 群里先发图、几秒后再 @ 她：图不该被 backlog 压成「【图片】」三个字。
// 根因：pushBacklog 只存 text，takeBacklog 只交字符串，admitImages 只看本轮 items ——
// 没点名那条的 m.images 在进 backlog 那一刻就丢了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-backlog-img-');
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const db = openDatabase();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const gateway = ({ admitContent = null } = {}) => Object.assign(Object.create(ChatGateway.prototype), {
	db,
	log: () => {},
	diag: null,
	stickers: null,
	random: () => 0.5,
	backlog: new Map(),
	ctx: admitContent === null ? { get: () => null } : { get: () => ({ admitPromptContent: admitContent }) },
	imageDownload: async () => ({ ok: true, bytes: PNG }),
});

test('backlog 条目留住图，takeBacklog 交出 {lines, images}', () => {
	const g = gateway();
	g.pushBacklog({ channelId: 'group:1', nickname: '哈基峰', userId: '100', messageId: 'm1', timeMs: Date.now(), text: '【图片】', images: [{ url: 'https://i0.hdslb.com/bfs/x.jpg' }] });
	const r = g.takeBacklog('group:1', new Set());
	assert.deepEqual(r.lines, ['哈基峰：【图1在下面】']);
	assert.equal(r.images.length, 1, '图要跟文字一起交出来');
	assert.equal(r.images[0].img.url, 'https://i0.hdslb.com/bfs/x.jpg');
	assert.equal(r.images[0].label, '哈基峰的图1');
	assert.equal(r.images[0].m.messageId, 'm1');
});

test('backlog 里没图的纯文字消息不受影响（老契约）', () => {
	const g = gateway();
	g.pushBacklog({ channelId: 'group:2', nickname: '阿四', userId: '101', messageId: 'm9', timeMs: Date.now(), text: '今天下雨了好烦', images: [] });
	const r = g.takeBacklog('group:2', new Set());
	assert.deepEqual(r.lines, ['阿四：今天下雨了好烦']);
	assert.deepEqual(r.images, []);
});

test('文字里带【图片】但 images 是空的，不改标注', () => {
	const g = gateway();
	g.pushBacklog({ channelId: 'group:3', nickname: '阿四', userId: '101', messageId: 'm10', timeMs: Date.now(), text: '【图片】', images: [] });
	const r = g.takeBacklog('group:3', new Set());
	assert.deepEqual(r.lines, ['阿四：【图片】'], '没取到图的消息保持原样（也许 URL 已过期）');
	assert.deepEqual(r.images, []);
});

test('一条消息多张图按序编号，上限取最近两张', () => {
	const g = gateway();
	for (let i = 1; i <= 4; i++) g.pushBacklog({ channelId: 'group:4', nickname: '哈基峰', userId: '100', messageId: `m${i}`, timeMs: Date.now() + i, text: '【图片】', images: [{ url: `https://x.example/${i}.jpg` }] });
	const r = g.takeBacklog('group:4', new Set());
	assert.equal(r.images.length, 2, '最多取最近两张，别把 15 分钟的图全塞进去');
	assert.deepEqual(r.images.map((x) => x.label), ['哈基峰的图1', '哈基峰的图2']);
	// 取的是最近两张（m3、m4）
	assert.deepEqual(r.images.map((x) => x.img.url), ['https://x.example/3.jpg', 'https://x.example/4.jpg']);
});

test('backlog 的图真的进模型（端到端：takeBacklog → admitImages → attachments）', async () => {
	const admitted = [];
	const g = gateway({ admitContent: async (parts) => { admitted.push(...parts); return parts; } });
	g.pushBacklog({ channelId: 'group:5', nickname: '哈基峰', userId: '100', messageId: 'm1', timeMs: Date.now(), text: '【图片】', images: [{ url: 'https://i0.hdslb.com/bfs/x.jpg' }] });
	const backlog = g.takeBacklog('group:5', new Set());
	const content = await g.admitImages('我要不要去', [], 's1', { backlog });
	const imgs = content.filter((p) => p.type === 'image');
	assert.equal(imgs.length, 1, 'backlog 里的图要进模型');
	assert.ok(String(imgs[0].name).includes('m1'), '图块带 messageId，模型能对上是谁发的');
});

test('本轮图和 backlog 图合计不超过 4 张', async () => {
	const g = gateway({ admitContent: async (parts) => parts });
	for (let i = 1; i <= 3; i++) g.pushBacklog({ channelId: 'group:6', nickname: '哈基峰', userId: '100', messageId: `b${i}`, timeMs: Date.now() + i, text: '【图片】', images: [{ url: `https://x.example/b${i}.jpg` }] });
	const backlog = g.takeBacklog('group:6', new Set());
	const items = [
		{ m: { images: [{ url: 'https://x.example/a1.jpg' }, { url: 'https://x.example/a2.jpg' }], messageId: 'a1', nickname: '阿四' } },
		{ m: { images: [{ url: 'https://x.example/a3.jpg' }], messageId: 'a2', nickname: '阿四' } }
	];
	const content = await g.admitImages('看', items, 's1', { backlog });
	assert.equal(content.filter((p) => p.type === 'image').length, 4, '合计顶到 4 张上限');
});

// 接线守卫：#151 的图能不能到模型，取决于 dispatchInner 有没有把 backlog 交给 admitImages。
// 只测 admitImages 自己收得到参数是不够的 —— 生产代码里没人传，等于死代码。
test('接线：dispatchInner 真的把 backlog 交给 admitImages', async () => {
	const seen = [];
	const g = gateway({ admitContent: async (parts) => parts });
	g.admitImages = async (text, items, sid, opts) => { seen.push(opts); return [{ type: 'text', text }]; };
	g.takeBacklog = () => ({ lines: [], images: [{ img: { url: 'https://x.example/1.jpg' }, m: { messageId: 'b1', nickname: 'n' }, label: 'n的图1' }] });
	g.videoNotes = async () => [];
	g.applyChatModelFor = () => {};
	g.typing = () => {};
	g.judgeTurn = async () => {};
	g.moodOf = () => ({ mood: '平静', tone: '平静', delay: 1, interject: 1, voice: 1 });
	g.replyChannelFor = () => 'group:9';
	g.workspacePath = () => home;
	g.bound = new Map();
	g.turns = new Map();
	g.turnMood = new Map();
	g.interjectTurns = new Set();
	g.soul = { beginTurn: () => {}, journalOut: () => {} };
	g.diag = null;
	g.random = () => 0.5;
	g.channel = { send: async () => '1' };
	g.outbox = { hasQueued: () => false, enqueue: () => {} };
	g.voiceGuardReady = false;
	g.getConfig = () => ({ qq: { enabled: true }, voice: {} });
	g.qqConfig = () => ({ enabled: true });
	const agent = { id: 'sess-1', followup: async () => {} };
	const m = { channel: 'qq', chatType: 'group', channelId: 'group:9', targetId: '9', groupId: '9', userId: '100', nickname: '哈基峰', messageId: 'm1', mentioned: true, text: '我要不要去', images: [], links: [], timeMs: Date.now() };
	await g.dispatchInner('group:9', [{ m, person: null, interject: false }], agent);
	assert.equal(seen.length, 1, 'admitImages 要被调用一次');
	assert.equal(seen[0]?.backlog?.images?.length, 1, 'backlog 的图必须真的传下去（只测 admitImages 收得到参数证明不了接线）');
});


test('引用消息里的图会进入模型（dispatchInner → 取引用 → admitImages → attachments）', async () => {
	const admitted = [];
	const g = gateway({ admitContent: async (parts) => { admitted.push(...parts); return parts; } });
	g.ownMessages = new Map();
	g.ownMessagesByChannel = new Map();
	g.channel = {
		selfId: '1000',
		getMessage: async (id) => ({
			message_id: id,
			message_type: 'group',
			group_id: 9,
			sender: { user_id: '20002', nickname: '阿四' },
			message: [{ type: 'image', data: { url: 'https://x.example/quoted.png' } }]
		})
	};
	g.videoNotes = async () => [];
	g.applyChatModelFor = () => {};
	g.typing = () => {};
	g.judgeTurn = async () => {};
	g.moodOf = () => ({ mood: '平静', tone: '平静', delay: 1, interject: 1, voice: 1 });
	g.replyChannelFor = () => 'group:9';
	g.workspacePath = () => home;
	g.bound = new Map();
	g.turns = new Map();
	g.turnMood = new Map();
	g.interjectTurns = new Set();
	g.soul = { beginTurn: () => {}, journalOut: () => {} };
	g.voiceGuardReady = false;
	g.getConfig = () => ({ qq: { enabled: true }, voice: {} });
	g.qqConfig = () => ({ enabled: true });
	let followup;
	const agent = { id: 'sess-quoted-image', followup: async (msg) => { followup = msg; } };
	const m = {
		channel: 'qq', chatType: 'group', channelId: 'group:9', targetId: '9', groupId: '9',
		userId: '20002', nickname: '阿四', messageId: 'm-quoted-image', mentioned: true,
		replyId: 'quoted-image-1', text: '这啥', images: [], links: [], timeMs: Date.now()
	};
	await g.dispatchInner('group:9', [{ m, person: null, interject: false }], agent);
	assert.ok(followup, '这一轮要真的进入会话');
	assert.equal(followup.content[0].text, '阿四：【引用 阿四：【图片】】这啥', '引用原文和当前问题都要保留');
	assert.equal(admitted.filter((p) => p.type === 'image').length, 1, '被引用消息里的图要真的交给模型');
	assert.equal(admitted.find((p) => p.type === 'image').data, PNG.toString('base64'), '下载得到的原始图片字节不能变');
	assert.ok(admitted.find((p) => p.type === 'image').name.startsWith('qq-quoted-image-1-'), '图片名要能对上被引用的消息');
	assert.ok(admitted.some((p) => p.type === 'text' && p.text.includes('被引用')), '要告诉模型哪张图来自引用');
});
