// 短链（v.douyin.com/xxx）也能变成原生卡片（2026-11-19 修）。
//
// 以前：`douyinVideoIds` 只认 `douyin.com/video/<数字>`，短链取不到作品 ID ⇒ 留在文字里。
// 现在：短链跳一次拿作品 ID，再发卡片；拿不到就照旧当文字（**不猜**）。
import assert from 'node:assert/strict';

import { resolveDouyinShortLink } from '../lib/douyin-short-link.js';
import { DouyinAdapter } from '../lib/douyin-adapter.js';
import { DouyinBrowser } from '../lib/douyin-browse.js';

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

// ── 7. 🔴 SSRF 防护：非抖音域名 / 非 HTTPS / 内网与回环地址一律拒发请求 ──
{
	const badInputs = [
		'http://v.douyin.com/abc',
		'http://127.0.0.1:8080/video/7707911549709601777',
		'http://169.254.169.254/latest/meta-data',
		'https://v.douyin.com@127.0.0.1/abc',
		'https://v.douyin.com.evil.com/video/7707911549709601777',
		'https://v.douyin.com:8443/abc',
		'https://evil.com/video/7707911549709601777',
	];
	let calls = 0;
	for (const url of badInputs) {
		const r = await resolveDouyinShortLink(url, {
			fetchImpl: async () => { calls++; return { headers: { get: () => 'https://www.douyin.com/video/7707911549709601777' } }; },
		});
		assert.equal(r, '', `非法入口应直接拒绝: ${url}`);
	}
	assert.equal(calls, 0, '非法入口不得发起任何网络请求');
	ok('SSRF 防护：非法初始地址拒发请求');
}

// ── 8. 🔴 SSRF 防护：恶意重定向不得跟跳或提 ID ──
{
	const evilLocations = [
		'http://127.0.0.1:8080/video/7707911549709601777',
		'http://169.254.169.254/a',
		'https://evil.com/video/7707911549709601777',
	];
	for (const loc of evilLocations) {
		const visited = [];
		const r = await resolveDouyinShortLink('https://v.douyin.com/abc', {
			fetchImpl: async (u) => {
				visited.push(u);
				return { headers: { get: () => loc } };
			},
		});
		assert.equal(r, '', `恶意重定向应拦截: ${loc}`);
		assert.equal(visited.length, 1, '命中非法 Location 后不得继续下一跳');
	}
	ok('SSRF 防护：恶意重定向全部拦截');
}

// ── 9. DouyinBrowser.resolveShort 收口复用 resolveDouyinShortLink ──
{
	const visited = [];
	const fakeBrowser = {
		fetch: async (u) => {
			visited.push(u);
			if (u.endsWith('/ok')) return { headers: { get: () => 'https://www.iesdouyin.com/share/note/7707911549709601777/' } };
			return { headers: { get: () => 'http://127.0.0.1:8080/x' } };
		},
	};
	const id = await DouyinBrowser.prototype.resolveShort.call(fakeBrowser, 'https://v.douyin.com/ok');
	assert.equal(id, '7707911549709601777', 'DouyinBrowser.resolveShort 应正确解析 iesdouyin note');
	const blocked = await DouyinBrowser.prototype.resolveShort.call(fakeBrowser, 'https://v.douyin.com/evil');
	assert.equal(blocked, '', 'DouyinBrowser.resolveShort 也必须拦截内网重定向');
	assert.equal(visited.length, 2, '各只发起 1 次合法请求，拦截后不发第二跳');
	ok('DouyinBrowser.resolveShort：收口复用且受 SSRF 守卫保护');
}

console.log('抖音短链发卡片：测试全部通过');
