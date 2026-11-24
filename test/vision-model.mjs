/**
 * 识图模型（feature=vision）—— 用户反馈「聊天模型不支持识图，得单独写插件」。
 *
 * 配了「模型 · 识图」后：用户发的图先用视觉模型描述成文字，再把文字喂会话模型，图不塞给会话模型。
 * 没配 = 老行为（图原样塞给会话模型）。描述失败 = 退回原图（比丢图强）。
 *
 * 盯的是「结果落到哪」：attachments.admitPromptContent 收到的 parts 里是文字还是图块。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-vision-model-');
process.env.DSH_HOME = home;
const { ChatGateway } = await import('../lib/gateway.js');
const { FEATURES } = await import('../lib/llm.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

/** 假网关：attachments 记录收到的 parts；vision 可配；getConfig 决定 models.vision 有没有。 */
function fakeGateway({ vision = null, visionCfg = null } = {}) {
	const admitted = { parts: null };
	const g = Object.assign(Object.create(ChatGateway.prototype), {
		ctx: { get: () => ({ admitPromptContent: async (parts) => { admitted.parts = parts; return parts; } }) },
		log: () => {},
		diag: { add: () => {} },
		notes: [],
		stickers: null,
		vision,
		imageDownload: async () => ({ ok: true, bytes: PNG }),
		getConfig: () => ({ models: visionCfg === null ? {} : { vision: visionCfg } }),
	});
	g.note = (k, i) => g.notes.push({ k, i });
	return { g, admitted };
}

const items = [{ m: { images: [{ url: 'https://example.com/a.png' }], messageId: 'm1', nickname: 'n' } }];

test('FEATURES 里有 vision，设置页才有「识图」那一栏', () => {
	assert.ok(FEATURES.some(([id]) => id === 'vision'), 'llm.FEATURES 必须含 vision');
});

test('没配识图模型：图原样塞给会话模型（老行为一字不变）', async () => {
	const { g, admitted } = fakeGateway({ vision: async () => '不该被调', visionCfg: null });
	const out = await g.admitImages('看图', items, 's1');
	assert.ok(Array.isArray(out.parts ?? out));
	const parts = out.parts ?? out;
	assert.equal(parts.filter((p) => p.type === 'image').length, 1, '没配 vision 必须还是喂图块');
	assert.equal(parts.filter((p) => p.type === 'text' && /【图】/.test(p.text)).length, 0, '没配 vision 不该有描述文字');
	assert.equal(admitted.parts.filter((p) => p.type === 'image').length, 1);
});

test('配了识图模型：喂的是「【图】描述」文字，不再喂图块', async () => {
	const seen = [];
	const vision = async (prompt, images) => { seen.push({ prompt, images }); return '一只橘猫趴在键盘上'; };
	const { g, admitted } = fakeGateway({ vision, visionCfg: { provider: 'p', model: 'vl' } });
	const out = await g.admitImages('看图', items, 's1');
	const parts = out.parts ?? out;
	assert.equal(parts.filter((p) => p.type === 'image').length, 0, '配了 vision 就不该再把图块塞给会话模型');
	const desc = parts.find((p) => p.type === 'text' && p.text.startsWith('【图】'));
	assert.ok(desc, `要有【图】描述，实际 parts=${JSON.stringify(parts.map((p) => p.type + ':' + (p.text ?? '').slice(0, 20)))}`);
	assert.match(desc.text, /【图】一只橘猫趴在键盘上/);
	assert.equal(seen.length, 1, '识图模型要被调一次');
	assert.equal(seen[0].images[0].data, PNG.toString('base64'), '识图模型拿到的是原图 base64');
	assert.equal(seen[0].images[0].mediaType, 'image/png');
	assert.equal(admitted.parts.filter((p) => p.type === 'image').length, 0, '交给宿主的 parts 里也不该有图块');
});

test('识图模型回了空 / 抛错：退回原图，不丢图', async () => {
	for (const vision of [async () => '', async () => { throw new Error('boom'); }, async () => null]) {
		const { g } = fakeGateway({ vision, visionCfg: { provider: 'p', model: 'vl' } });
		const out = await g.admitImages('看图', items, 's1');
		const parts = out.parts ?? out;
		assert.equal(parts.filter((p) => p.type === 'image').length, 1, `vision 失败（${vision.toString().slice(0, 30)}）必须退回原图`);
	}
});

test('被引用的图也走识图，前缀标「被引用的图」', async () => {
	const vision = async () => '一张梗图';
	const { g } = fakeGateway({ vision, visionCfg: { provider: 'p', model: 'vl' } });
	const out = await g.admitImages('看图', [], 's1', { quotedImages: [{ img: { url: 'https://example.com/q.png' }, m: { messageId: 'q1', nickname: 'x' }, quoted: true }] });
	const parts = out.parts ?? out;
	assert.ok(parts.some((p) => p.type === 'text' && /^【被引用的图】一张梗图/.test(p.text)), '被引用的图描述要带前缀');
	assert.equal(parts.filter((p) => p.type === 'image').length, 0);
});

test('配置里只填了 provider 没填 model：当没配，走老行为', async () => {
	const { g } = fakeGateway({ vision: async () => 'x', visionCfg: { provider: 'p', model: '' } });
	const out = await g.admitImages('看图', items, 's1');
	assert.equal((out.parts ?? out).filter((p) => p.type === 'image').length, 1);
});
