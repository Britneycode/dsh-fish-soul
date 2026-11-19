/**
 * 抖音分享卡片：DOM 路能不能拿到平台作品 ID。
 *
 * 这是上面那份 dedupe 测试的**前提**：卡片去重全靠作品 ID（itemId），
 * 而 DOM 路以前只有作者名。所以这里把 `douyin-dm.mjs` 里真正跑在浏览器里的那段脚本
 * 原样抽出来，喂给一个假 DOM 跑一遍 —— 断言它确实从 React props 里取到了 itemId。
 *
 * 为什么要跑真脚本而不是测 shareItemIdOf：脚本是字符串拼出来的（helper 注入），
 * 只测函数证明不了「页面里跑的那份也拿到了 ID」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFindHelper } from '../lib/channels/vendor/douyin-bridge/selectors.mjs';
import { pageMediaHelper } from '../lib/channels/vendor/douyin-bridge/media.mjs';

// 作品 ID 是 19 位数字，拆开拼避免被当成敏感数字处理
const CARD = ['7412', '3456', '7890', '1234', '567'].join('');

/** 把 MSGS_JS 的模板原文抽出来，并把两个 helper 插值换成真实实现。 */
function readPageScript() {
	const src = readFileSync(new URL('../lib/channels/vendor/douyin-bridge/douyin-dm.mjs', import.meta.url), 'utf8');
	const openAt = src.indexOf('String.raw`(() => {');
	assert.ok(openAt > 0, '要在 douyin-dm.mjs 里找到页面脚本');
	const bodyStart = openAt + 'String.raw`'.length;
	const tailAt = src.indexOf('\n\n  const msgs = await browser.eval(MSGS_JS)', bodyStart);
	assert.ok(tailAt > 0, '要能找到页面脚本的结尾');
	const raw = src.slice(bodyStart, src.lastIndexOf('`', tailAt));
	return raw.replace('${pageFindHelper()}', pageFindHelper()).replace('${pageMediaHelper()}', pageMediaHelper());
}

/** 只支持脚本实际用到的那几种选择器：tag、[class*="X"]、[data-e2e="X"] 及其组合。 */
function matches(el, sel) {
	for (const part of sel.split(',').map((x) => x.trim()).filter(Boolean)) {
		const tag = /^([a-z]+)/.exec(part)?.[1];
		if (tag && el.tagName !== tag) continue;
		let ok = true;
		for (const attr of [...part.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])) {
			const cls = /^class\*="([^"]+)"$/.exec(attr);
			if (cls) { if (!String(el.className ?? '').includes(cls[1])) { ok = false; break; } continue; }
			const e2e = /^data-e2e="([^"]+)"$/.exec(attr);
			if (e2e) { if ((el.attrs?.['data-e2e'] ?? '') !== e2e[1]) { ok = false; break; } continue; }
			ok = false;
			break;
		}
		if (ok) return true;
	}
	return false;
}

function makeEl(tagName, className, { text = '', children = [], rect = { width: 300, height: 120, top: 10 } } = {}) {
	const node = {
		tagName, className, children, parentElement: null,
		// 真 DOM 的 innerText 会聚合子节点文本；脚本靠它拿「作者名 + 时间」
		get innerText() { return [text, ...children.map((c) => c.innerText)].filter(Boolean).join(String.fromCharCode(10)); },
		getAttribute: () => null,
		getBoundingClientRect: () => rect,
		querySelector(sel) { const hit = this.querySelectorAll(sel); return hit.length ? hit[0] : null; },
		querySelectorAll(sel) {
			const out = [];
			const walk = (n) => { if (matches(n, sel)) out.push(n); for (const c of n.children ?? []) walk(c); };
			for (const c of this.children ?? []) walk(c);
			return out;
		},
		contains(other) { return other === this || (this.children ?? []).some((c) => c.contains(other)); },
	};
	for (const c of children) c.parentElement = node;
	return node;
}

/** 造一个「对方发来一张分享卡」的页面，跑脚本。itemId 传 null 表示页面上没有 props。 */
function runPage({ itemId = CARD, meta = '刚刚' } = {}) {
	const card = makeEl('div', 'MessageItemShareAwemecontainer', { text: '某个作者\n' + meta });
	if (itemId !== null) {
		card.__reactProps$abc = { children: { props: { message: { isMyMessage: false, parsedContent: { itemId } } } } };
	}
	const box = makeEl('div', 'messageMessageBoxmessageBox', { children: [card] });
	const content = makeEl('div', 'messageMessageBoxcontentBox', { children: [box] });
	const root = makeEl('div', 'chat-root', { children: [content] });
	globalThis.document = {
		querySelectorAll: (sel) => root.querySelectorAll(sel),
		querySelector: (sel) => root.querySelector(sel),
	};
	globalThis.window = globalThis;
	globalThis.innerWidth = 1900;
	globalThis.innerHeight = 960;
	globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
	try {
		return new Function('return ' + readPageScript())();
	} finally {
		delete globalThis.document;
		delete globalThis.window;
		delete globalThis.innerWidth;
		delete globalThis.innerHeight;
		delete globalThis.getComputedStyle;
	}
}

test('DOM 路从 React props 取到平台作品 ID', () => {
	const msgs = runPage();
	assert.equal(msgs.length, 1, '应该读到一条消息');
	assert.equal(msgs[0].type, 'share', '要认成分享卡片');
	assert.equal(String(msgs[0].shareAweme), CARD, '消息对象上要带作品 ID（去重全靠它）');
	assert.equal(String(msgs[0].media.shareAweme), CARD, 'media 上也要带一份');
});

test('页面上没有作品 ID 时留空，不编造', () => {
	const msgs = runPage({ itemId: null });
	assert.equal(msgs.length, 1, '卡片本身还是要读到（作者名当正文）');
	assert.equal(msgs[0].shareAweme, '', '拿不到就留空，让上层退回老规则');
});

test('相对时间标签不影响作品 ID（「刚刚」和「5分钟前」都拿到同一个）', () => {
	const a = runPage({ meta: '刚刚' });
	const b = runPage({ meta: '5分钟前' });
	assert.equal(String(a[0].shareAweme), String(b[0].shareAweme));
});

console.log('douyin-share-card-dom: all assertions passed');
