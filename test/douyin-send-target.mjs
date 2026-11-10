// 抖音私信发送目标校验：昵称只能用来「找会话」，不能证明「打开的就是这个人」。
//
// 这是「发错人」那条链路的最后一道闸门，所以单独测：
//   · 没有会话 ID  → 一个字都不发
//   · 有会话 ID    → 一路传到驱动层，由 ensureTargetChat/sendDM 逐段校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-send-target-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');
const db = openDatabase();

const SELF = '999';
const PEER = '123';
const CONV = `0:1:${SELF}:${PEER}`;
const OTHER = '0:1:999:555';

// 通道里的 sleep 是 unref 的（不拖住宿主退出）。CI 上 4 vCPU 被别的套件抢满时，
// 事件循环会认为「没事可做」直接结束 → 测试里的 await 永远不 resolve →
// 「Promise resolution is still pending but the event loop has already resolved」。
// 光靠 typingMs=[1,1] 不够（那只是让 timer 非 0，仍然 unref）。
// 这里挂一个**非 unref** 的 keep-alive，把事件循环钉住，让结论只取决于代码逻辑。
const keepAlive = setInterval(() => {}, 1000);
test.after(() => { clearInterval(keepAlive); db.close(); });

/** 造一个通道，把驱动收到的参数全记下来。 */
function makeChannel() {
	const calls = [];
	const ch = new DouyinChannel({
		// exclusive 就是「浏览器锁」：真宿主里串行化页面操作，测试里直接执行
		db, host: { running: true, loggedIn: true, exclusive: async (_label, fn) => await fn() },
		// 打字延迟归零（用 [1,1] 而不是 [0,0]：sleep 是 unref 的，全 0 时 Node
		// 可能认为没事可做直接退出，promise 永不 resolve —— 见 MEMORY 里那条坑）
		typingMs: [1, 1],
		getConfig: () => ({}),
		driver: {
			sendText: async (name, text, convId) => { calls.push({ via: 'text', name, text, convId }); return { ok: true, verified: true }; },
			sendImage: async (name, file, convId) => { calls.push({ via: 'image', name, file, convId }); return { ok: true, verified: true }; },
			sendEmoji: async (name, emoji, convId) => { calls.push({ via: 'emoji', name, emoji, convId }); return { ok: true, verified: true }; },
		},
		onMessage: async () => ({ done: true }),
	});
	return { ch, calls };
}

test('没有会话 ID 就拒绝发送（不猜、不退回昵称）', async () => {
	const { ch, calls } = makeChannel();
	for (const bad of ['', '   ', '不是会话ID', '0:2:7300']) {
		await assert.rejects(
			() => ch.send('某个昵称', [{ type: 'text', text: '你好' }], bad),
			/没有确认过身份/,
			`会话 ID「${bad}」不该被接受`
		);
	}
	assert.equal(calls.length, 0, '一条都没发出去');
});

test('有会话 ID 时把它一路传到驱动层（逐段校验目标）', async () => {
	const { ch, calls } = makeChannel();
	const r = await ch.send('某个昵称', [{ type: 'text', text: '你好' }], CONV);
	assert.equal(r.ok, true);
	assert.deepEqual(calls.map((c) => [c.via, c.convId]), [['text', CONV]], '文字：会话 ID 传下去了');

	await ch.send('某个昵称', [{ type: 'image', path: '/tmp/x.png' }], CONV);
	assert.deepEqual(calls.at(-1), { via: 'image', name: '某个昵称', file: '/tmp/x.png', convId: CONV });

	await ch.send('某个昵称', [{ type: 'emoji', name: '比心' }], CONV);
	assert.equal(calls.at(-1).convId, CONV, '表情：会话 ID 传下去了');
});

test('表情面板没这个名字时退回文字，会话 ID 不能丢', async () => {
	const { ch, calls } = makeChannel();
	ch.driver.sendEmoji = async (name, emoji, convId) => { calls.push({ via: 'emoji-miss', name, emoji, convId }); return { ok: false, error: '面板里没这个名字' }; };
	await ch.send('某个昵称', [{ type: 'emoji', name: '不存在的表情' }], CONV);
	const fallback = calls.at(-1);
	assert.equal(fallback.via, 'text', '退回了文字');
	assert.equal(fallback.convId, CONV, '兜底那条也要带会话 ID —— 否则最后一步等于没校验');
});

test('多段消息每段都带同一个会话 ID（中途切会话也挡得住）', async () => {
	const { ch, calls } = makeChannel();
	await ch.send('某个昵称', [
		{ type: 'text', text: '第一段' },
		{ type: 'text', text: '第二段' },
		{ type: 'text', text: '第三段' },
	], CONV);
	assert.equal(calls.length, 3);
	assert.ok(calls.every((c) => c.convId === CONV), '每一段都校验，不是只校验第一段');
});

test('目标会话换了就发不出去（模拟驱动层拒绝）', async () => {
	const { ch, calls } = makeChannel();
	ch.driver.sendText = async (name, text, convId) => {
		calls.push({ via: 'text', convId });
		// 模拟 ensureTargetChat 的结论：当前打开的是别的会话
		if (convId !== CONV) return { ok: false, error: `当前会话不是目标会话（期望 ${convId}，实际 ${OTHER}）` };
		return { ok: true, verified: true };
	};
	const r = await ch.send('某个昵称', [{ type: 'text', text: '你好' }], OTHER);
	assert.equal(r.ok, false, '目标不符就不算成功');
	assert.equal(r.delivered, false);
});

