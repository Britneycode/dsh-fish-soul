// 短链（v.douyin.com/xxx）也能变成原生卡片（2026-11-19 修）。
//
// 以前：`douyinVideoIds` 只认 `douyin.com/video/<数字>`，短链取不到作品 ID ⇒ 留在文字里。
// 现在：短链跳一次拿作品 ID，再发卡片；拿不到就照旧当文字（**不猜**）。
import assert from 'node:assert/strict';

import { resolveDouyinShortLink } from '../lib/douyin-short-link.js';
import { DouyinAdapter } from '../lib/douyin-adapter.js';

const ok = (m) => console.log('✓', m);

// ── 1. 纯函数：完整链接不发请求直接给 id ──
{
	const r = await resolveDouyinShortLink('https://www.douyin.com/video/7707911549709601777', {
		fetchImpl: async () => { throw new Error('不该发请求'); },
	});
	assert.equal(r, '7707911549709601777', '完整链接直接返回 id，不发请求');
	ok('完整链接：不发请求直接给 id');
}

// ── 2. 短链跟随重定向拿 id ──
{
	const calls = [];
	const r = await resolveDouyinShortLink('https://v.douyin.com/abc123', {
		fetchImpl: async (url) => {
			calls.push(url);
			return { headers: { get: () => 'https://www.douyin.com/video/7707911549709601777?from=share' } };
		},
	});
	assert.equal(r, '7707911549709601777', '从 Location 里解出作品 ID');
	assert.equal(calls.length, 1, '一次重定向就够');
	ok('短链：一次重定向拿到 id');
}

// ── 3. 多次跳转 ──
{
	const r = await resolveDouyinShortLink('https://v.douyin.com/abc123', {
		fetchImpl: async (url) => {
			if (url.includes('v.douyin.com')) return { headers: { get: () => 'https://www.iesdouyin.com/share/video/7707911549709601777/' } };
			return { headers: { get: () => 'https://www.douyin.com/video/7707911549709601777' } };
		},
	});
	assert.equal(r, '7707911549709601777', '跟着跳转两次也能拿到');
	ok('多次跳转：跟着走，拿到为止');
}

// ── 4. 🔴 拿不到就返回空，不猜 ──
{
	const cases = [
		async () => { throw new Error('网络断了'); },
		async () => ({ headers: { get: () => null } }),                    // 没有 Location
		async () => ({ headers: { get: () => 'https://www.douyin.com/' } }), // 跳了但没作品 ID
	];
	for (const f of cases) {
		assert.equal(await resolveDouyinShortLink('https://v.douyin.com/abc', { fetchImpl: f }), '', '拿不到就该是空串');
	}
	assert.equal(await resolveDouyinShortLink(''), '', '空地址直接空串');
	ok('拿不到：返回空串，不猜（猜错就是发错视频）');
}

// ── 5. 端到端：聊天里发短链 → 变成卡片 ──
{
	const cards = [];
	const texts = [];
	const adapter = new DouyinAdapter({
		db: () => ({}),
		getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
		inbox: () => null,
		channel: () => ({
			async shareCard(p) { cards.push(p); return { ok: true, verified: true }; },
			async send(name, parts) {
				texts.push(...parts.filter((p) => p.type === 'text').map((p) => p.text));
				return { ok: true, delivered: true, parts: [] };
			},
		}),
		sendText: async () => ({ ok: false }),
		note: () => {}, log: () => {}, diag: () => {},
	});
	// 替换解析器（真实解析要发网络请求）
	adapter.resolveShortLink = async () => '7707911549709601777';
	await adapter.send({ channel_id: 'douyin:未云' }, 'https://v.douyin.com/abc123', [], '0:1:123:456');
	assert.equal(cards.length, 1, '短链要变成卡片');
	assert.equal(cards[0].videoId, '7707911549709601777');
	assert.deepEqual(texts, [], '变成卡片就不该再发文字');
	ok('端到端：短链 → 卡片');
}

// ── 6. 🔴 短链解析不出来 ⇒ 退回文字，链接不能丢 ──
{
	const cards = [];
	const texts = [];
	const adapter = new DouyinAdapter({
		db: () => ({}),
		getConfig: () => ({ douyin: { enabled: true, shareCard: true } }),
		inbox: () => null,
		channel: () => ({
			async shareCard(p) { cards.push(p); return { ok: true, verified: true }; },
			async send(name, parts) {
				texts.push(...parts.filter((p) => p.type === 'text').map((p) => p.text));
				return { ok: true, delivered: true, parts: [] };
			},
		}),
		sendText: async () => ({ ok: false }),
		note: () => {}, log: () => {}, diag: () => {},
	});
	adapter.resolveShortLink = async () => ''; // 解析不出来
	const link = 'https://v.douyin.com/abc123';
	await adapter.send({ channel_id: 'douyin:未云' }, link, [], '0:1:123:456');
	assert.equal(cards.length, 0, '拿不到作品 ID 就不发卡片');
	assert.deepEqual(texts, [link], '🔴 链接要原样发文字，不能丢');
	ok('解析失败：退回文字，链接不丢');
}

console.log('抖音短链发卡片：测试全部通过');
