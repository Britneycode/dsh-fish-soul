/**
 * 抖音私信：`ok`（动作做了）和 `delivered`（回读到证据）必须是两件事。
 *
 * 为什么要有这个：
 *   抖音风控会**静默吞消息** —— Enter 按了、UI 没报错，但消息根本没进会话。
 *   以前 send() 只返回一个布尔 allOk，被吞的时候照样 true，
 *   动态页写着「已发」，对方其实什么都没收到。
 *
 * 契约：
 *   ① driver 回了 verified:true → ok + delivered 都是 true
 *   ② driver 回了 ok:true 但没有 verified → **ok=true、delivered=false**（这条是关键）
 *   ③ driver 报错 → 两个都是 false
 *   ④ 多段里只要有一段真送到，delivered 就是 true
 *   ⑤ 上层记的 kind 要能区分：sent / unconfirmed / failed
 */
import assert from 'node:assert/strict';

const home = `${process.env.TEMP || '/tmp'}/fish-soul-test-dydeliv-${process.pid}-${Date.now()}`;
process.env.DSH_HOME = home;

const { DouyinChannel } = await import('../lib/channels/douyin.js');

const ok = (msg) => console.log(`✓ ${msg}`);

// 发送现在要求目标会话 ID（没有就拒绝发送，见 lib/douyin-conversation.js）。
// 这个测试关心的是三态回执，不是身份判定，所以给一个固定会话。
const CONV = '0:1:900001:100001';

// ⚠️ 必须自己保活进程。
//    douyin.js 里的 sleep 是 `setTimeout(...).unref()` —— unref 的定时器**不让 Node 保活**，
//    所以「只等这个定时器」的时候 Node 会认为没事可做，直接退出进程，
//    send() 的 promise 永远不 resolve（top-level await 报 unsettled）。
//    生产里不用管：宿主自己有 WS / 轮询 / HTTP 服务器挂着，进程一直在。
const keepAlive = setInterval(() => {}, 1000);

/** 造一个只有 send() 在跑、浏览器不参与的通道。 */
function makeChannel(driverFor) {
	const ch = Object.create(DouyinChannel.prototype);
	ch.host = { running: true, exclusive: async (_label, fn) => fn() };
	ch.driver = driverFor();
	// ⚠️ 不能用 [0,0]：douyin.js 里的 sleep 是 `setTimeout(...).unref()`，
	//    毫秒为 0 时定时器不进事件循环，Node 认为没事可做就直接退出，
	//    send() 的 promise 永远不 resolve（top-level await 报 unsettled）。
	//    给 1 毫秒就正常。生产里这个值来自配置，不会是 0。
	ch.typingMs = [1, 2];
	ch.sendChain = Promise.resolve();
	ch.log = () => {};
	return ch;
}

// ── ① 回读到了 ──
{
	const ch = makeChannel(() => ({ sendText: async () => ({ ok: true, verified: true }) }));
	const r = await ch.send('某人', [{ type: 'text', text: '你好' }], CONV);
	assert.equal(r.ok, true, '动作成功');
	assert.equal(r.delivered, true, '回读到了就是 delivered');
	ok('driver 回 verified → ok + delivered');
}

// ── ② 动作成功但没回读（被风控吞）──
{
	const ch = makeChannel(() => ({ sendText: async () => ({ ok: true }) }));
	const r = await ch.send('某人', [{ type: 'text', text: '这是一条很长的消息' }], CONV);
	assert.equal(r.ok, true, '动作确实做了 —— ok 不能是 false');
	assert.equal(r.delivered, false, '没有回读证据 ⇒ delivered 必须是 false');
	ok('动作成功但没回读 → ok=true / delivered=false（以前这里会是 true）');
}

// ── ③ 报错 ──
{
	const ch = makeChannel(() => ({ sendText: async () => ({ ok: false, error: '进不去会话' }) }));
	const r = await ch.send('某人', [{ type: 'text', text: '你好' }], CONV);
	assert.equal(r.ok, false, '报错时 ok 是 false');
	assert.equal(r.delivered, false, '报了错更不可能 delivered');
	assert.equal(r.parts[0].error, '进不去会话', '错误原因要留下来');
	ok('driver 报错 → ok/delivered 都 false，原因保留');
}

// ── ④ 多段里有一段送到 ──
{
	let n = 0;
	const ch = makeChannel(() => ({
		sendText: async () => {
			n += 1;
			// 第一段被吞、第二段成功
			return n === 1 ? { ok: true } : { ok: true, verified: true };
		}
	}));
	const r = await ch.send('某人', [{ type: 'text', text: '一' }, { type: 'text', text: '二' }], CONV);
	assert.equal(r.ok, true, '两段动作都做了');
	assert.equal(r.delivered, true, '只要有一段送到就算 delivered');
	assert.equal(r.parts.length, 2, '两段都要有明细');
	assert.equal(r.parts[0].delivered, false, '第一段没回读');
	assert.equal(r.parts[1].delivered, true, '第二段回读到了');
	ok('多段：逐段明细，任一段送到就 delivered');
}

// ── ⑤ 表情走 sendEmoji 的 verified ──
{
	const ch = makeChannel(() => ({
		sendEmoji: async () => ({ ok: true, verified: true, name: '比心' }),
		sendText: async () => ({ ok: true, verified: true })
	}));
	const r = await ch.send('某人', [{ type: 'emoji', name: '比心' }], CONV);
	assert.equal(r.ok, true);
	assert.equal(r.delivered, true, '表情也有回读（数气泡）');
	ok('表情：sendEmoji 的 verified 也算 delivered');
}

// ── ⑥ 表情面板没这个名字 → 走文字兜底，仍有 verified ──
{
	const ch = makeChannel(() => ({
		sendEmoji: async () => ({ ok: false, error: '没有叫「捂脸」的表情' }),
		sendText: async () => ({ ok: true, verified: true })
	}));
	const r = await ch.send('某人', [{ type: 'emoji', name: '捂脸' }], CONV);
	assert.equal(r.ok, true, '兜底发文字要算成功');
	assert.equal(r.delivered, true, '兜底那条也回读了');
	ok('表情找不到 → 当文字发，回读照样成立');
}

// ── ⑦ 浏览器没在跑 ──
{
	const ch = makeChannel(() => ({}));
	ch.host = { running: false, exclusive: async (_l, fn) => fn() };
	await assert.rejects(() => ch.send('某人', [{ type: 'text', text: 'x' }], CONV), /没在运行/);
	ok('浏览器没跑 → 明确抛错（不是静默 false）');
}

// ── ⑧ 上层两种记法：kind 要分得开 ──
{
	// 直接查源码：这两行是「动作做了但可能被吞」唯一的落点。
	// 用真网关跑一轮代价太大（要造会话 + 模型），而且这里要守的就是这个映射本身。
	const { readFileSync } = await import('node:fs');
	const gw = readFileSync(new URL('../lib/gateway.js', import.meta.url), 'utf8');
	assert.match(gw, /const kind = !ok \? 'failed' : \(delivered \? 'sent' : 'unconfirmed'\)/,
		'要按 ok / delivered 分出 sent / unconfirmed / failed 三种');

	const ui = readFileSync(new URL('../lib/client.soul.js', import.meta.url), 'utf8');
	assert.match(ui, /unconfirmed: \["[^"]+", "warning"\]/,
		'动态页要认 unconfirmed，否则显示的是原始英文 key');

	const media = readFileSync(new URL('../lib/gateway-media.js', import.meta.url), 'utf8');
	assert.match(media, /delivered: false, parts: \[\]/, 'sendDouyin 要有结构化的失败返回');
	// 契约变更（2026-11-10）：不再是「一律不发」，而是「没有目标会话 ID 就不发」。
	// 真实防线是 sendDouyin 里那条会话 ID 校验（DouyinChannel.send 还会再挡一道）。
	assert.match(media, /没有确认过这个抖音会话的身份/, '未确认目标不能发送');
	assert.match(media, /const target = String\(convId/, 'sendDouyin 必须真的用到目标会话 ID');
	ok('上层：sent / unconfirmed / failed 三态齐全，UI 认得新 kind');
}

clearInterval(keepAlive);
console.log('\ndouyin-delivered ok');
