// 抖音私信并发发送：整条发送流程必须独占浏览器锁。
//
// 病根（真机 2026-11-12，宿主 0.15.54）：
//   `send()` 以前只把「每一段的发送动作」放进 exclusive。段与段之间、
//   以及第一段之前的打字停顿，浏览器锁是放开的 —— 轮询（读私信）正好插进来
//   readDM → enterChat：进别的会话，**会话列表跟着滚到那儿**。
//   抖音的会话列表是虚拟滚动的（只有眼前那几个在 DOM 里），
//   `enterChat` 只在眼前的会话里找目标，找不到就抛「找不到会话「X」」。
//   ⇒ 下一段发不出去，整条回复判「回复没发出去（发送失败）」。
//
// 这里用假 host.exclusive（跟真宿主一样是 FIFO 互斥）+ 假页面 + 假驱动复现这条链路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-send-exclusive-');
const { openDatabase } = await import('../lib/db.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');
const db = openDatabase();

const SELF = '999';
const CONV_A = `0:1:${SELF}:111`;   // 甲
const CONV_B = `0:1:${SELF}:222`;   // 乙
const CONV_C = `0:1:${SELF}:333`;   // 丙

// 通道里的 sleep 是 unref 的（不拖住宿主退出）。CI 上 4 vCPU 被别的套件抢满时，
// 事件循环会认为「没事可做」直接结束 → 测试里的 await 永远不 resolve。
// 挂一个**非 unref** 的 keep-alive，把事件循环钉住，让结论只取决于代码逻辑。
const keepAlive = setInterval(() => {}, 1000);
test.after(() => { clearInterval(keepAlive); db.close(); });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 假 host：跟真宿主 DouyinHost.exclusive 一样是 FIFO 互斥 ——
 * 同一时间只有一件事在动页面，后来的排在后面。
 */
function makeHost() {
	const timeline = [];
	let lock = Promise.resolve();
	return {
		running: true,
		loggedIn: true,
		timeline,
		exclusive(label, fn) {
			timeline.push(`要锁+${label}`);
			const p = lock.then(async () => {
				timeline.push(`拿到+${label}`);
				try {
					return await fn();
				} finally {
					timeline.push(`放锁+${label}`);
				}
			});
			lock = p.then(() => {}, () => {});
			return p;
		},
	};
}

/**
 * 假页面：会话列表（虚拟滚动）+ 当前打开的会话。
 *
 *  · 列表按视觉顺序排，**只有眼前的那几个渲染在 DOM 里**（真机的虚拟列表）。
 *  · 读一个会话 = 进那个会话 + 列表滚到那儿 ⇒ 别的会话被滚出眼前。
 *  · 进会话只能点「眼下的」会话；点不到就是真机上的「找不到会话「X」」。
 */
function makePage() {
	const page = {
		list: [
			{ name: '甲', convId: CONV_A },
			{ name: '乙', convId: CONV_B },
			{ name: '丙', convId: CONV_C },
		],
		view: 2,        // 眼前能看到几个
		top: 0,         // 列表滚到第几个了
		current: '',    // 当前打开的会话（空 = 没进过会话）
	};
	/** 点会话项进会话。目标不在眼下 → 点不到（真机：虚拟列表没渲染它）。 */
	page.click = (name) => {
		const row = page.list.slice(page.top, page.top + page.view).find((r) => r.name.includes(name));
		if (!row) return false;
		page.current = row.convId;
		return true;
	};
	/** 读一个会话：进会话 + 列表滚到那儿（真机：刚读过的会话排最前，列表跟着滚）。 */
	page.read = (name) => {
		const i = page.list.findIndex((r) => r.name.includes(name));
		if (i < 0) return false;
		page.top = i;
		page.current = page.list[i].convId;
		return true;
	};
	return page;
}

/**
 * 假驱动：照着真驱动的形状来 ——
 *   · 已经在目标会话里就直接发（`ensureTargetChat` 的 already-here 快路径）；
 *   · 否则点会话项进会话，再校验会话 ID；
 *   · 点不到 → 真驱动的 enterChat 会**抛**「找不到会话「X」」（`sendDM` 不接，冒到上层）。
 */
function makeDriver(page, events, onSend = () => {}) {
	const sendTo = async (via, name, value, convId) => {
		events.push(`${via}|${name}|${value}`);
		await sleep(1);
		onSend(value);
		if (page.current === convId) return { ok: true, verified: true };
		if (!page.click(name)) throw new Error(`找不到会话「${name}」`);
		if (page.current !== convId) {
			return { ok: false, error: `当前会话不是目标会话（期望 ${convId}，实际 ${page.current}）` };
		}
		return { ok: true, verified: true };
	};
	return {
		sendText: (name, text, convId) => sendTo('text', name, text, convId),
		sendImage: (name, file, convId) => sendTo('image', name, file, convId),
		sendEmoji: (name, emoji, convId) => sendTo('emoji', name, emoji, convId),
	};
}

/** 造一个通道：打字延迟压到最小，事件记进 events。 */
function makeChannel(host, page, events, onSend) {
	return new DouyinChannel({
		db,
		host,
		// 打字延迟归零附近（用 [1,1] 而不是 [0,0]：sleep 是 unref 的，全 0 时
		// Node 可能认为没事可做直接退出，promise 永不 resolve —— 见 MEMORY 里那条坑）
		typingMs: [1, 1],
		getConfig: () => ({}),
		driver: makeDriver(page, events, onSend),
		onMessage: async () => ({ done: true }),
	});
}

test('轮询插进两段之间时，整条回复照样发得出去', async () => {
	const host = makeHost();
	const page = makePage();
	const events = [];
	let firstSent = null;
	const firstDone = new Promise((resolve) => { firstSent = resolve; });
	const ch = makeChannel(host, page, events, (value) => { if (value === '一') firstSent(); });

	const sending = ch.send('甲', [
		{ type: 'text', text: '一' },
		{ type: 'text', text: '二' },
	], CONV_A);
	// 第一段已经发出去了 —— 这时候轮询插进来读别的会话（真机上一直是这样）
	await firstDone;
	const polling = host.exclusive('读私信', async () => { page.read('丙'); });

	const r = await sending;
	await polling;

	assert.equal(r.ok, true, `两段都得发出去：${JSON.stringify(r.parts)}`);
	assert.equal(r.delivered, true);
	assert.deepEqual(events, ['text|甲|一', 'text|甲|二']);
});

test('两个会话并发发送：第二个等第一个整条发完才开始', async () => {
	const host = makeHost();
	const page = makePage();
	const events = [];
	const ch = makeChannel(host, page, events);

	const a = ch.send('甲', [
		{ type: 'text', text: '甲一' },
		{ type: 'text', text: '甲二' },
	], CONV_A);
	const b = ch.send('乙', [{ type: 'text', text: '乙一' }], CONV_B);
	const [ra, rb] = await Promise.all([a, b]);

	assert.equal(ra.ok, true, `甲那两条要发出去：${JSON.stringify(ra.parts)}`);
	assert.equal(rb.ok, true, `乙那条要发出去：${JSON.stringify(rb.parts)}`);
	assert.deepEqual(events, ['text|甲|甲一', 'text|甲|甲二', 'text|乙|乙一'], '乙不能插进甲的两段中间');
});
