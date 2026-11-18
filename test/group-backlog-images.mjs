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
	imageDownload: async () => PNG,
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
	assert.ok(String(content[0].text).includes('哈基峰：【图1在下面】'), '文本行指到图');
	assert.ok(String(content[0].text).includes('没叫你，只作参考'), '保留「只作参考」语义');
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
