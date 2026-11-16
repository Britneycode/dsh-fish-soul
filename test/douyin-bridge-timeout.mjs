/**
 * 桥调用 / eval 的超时上界 —— 巡检 P2 遗留（2026-11-16）。
 *
 * 上一轮（2026-11-15）给 browser.eval / goto / commentBridgeReady /
 * installCommentBridge / callBridge 都加了 timeoutMs，但**调用方没往下传**：
 *   · lib/douyin-browse.js 的 DouyinBrowser 压根没有 timing 参数
 *     ⇒ activeVideo / next 的 8 轮 changed() / ensureRecommend 全吃默认 60 秒，
 *       页面卡死时 next() 一次就 8 × 60 秒，浏览器独占锁被占住。
 *   · lib/douyin-social.js 的 emojiCodes() 也没传 tm.evalTimeoutMs。
 *
 * 本文件只经**公开入口**断言行为（DouyinBrowser 的方法 / douyinSocialDriver），
 * 不 import 任何新导出的内部函数 —— 未修基线上那样写只会红在
 * 「模块没有这个导出」上，证明不了任何行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpHome } from './_tmp.mjs'

// lib/time-util.js 的 sleep 是 unref 的。本文件里有永远 pending 的 promise
// （模拟页面卡死），事件循环会以为没事可做直接结束 ⇒ await 永不 resolve（0.1 秒假红）。
// 挂一个非 unref 的定时器把事件循环钉住，after 里清掉（2026-11-15 commit 897dd42 同款）。
const keepAlive = setInterval(() => {}, 1000)
test.after(() => clearInterval(keepAlive))

const { DouyinBrowser } = await import('../lib/douyin-browse.js')
const { douyinSocialDriver } = await import('../lib/douyin-social.js')

// ── 测试库：记忆表 + douyin_seen（浏览器那套要写记忆）──
const home = tmpHome('dsh-dybto-')
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const { openDatabase } = await import('../lib/db.js')
const db = openDatabase()
process.env.DSH_HOME = prevHome
db.exec(`CREATE TABLE IF NOT EXISTS douyin_seen (aweme_id TEXT PRIMARY KEY, title TEXT, author TEXT, impression TEXT, skipped INTEGER, liked INTEGER, memory_id INTEGER, seen_at INTEGER, seen_real_at INTEGER)`)

/** 等 fn 出结果；超过 ms 就算失败（页面卡死时不该无限等）。 */
async function within(ms, fn) {
	let timer
	try {
		return await Promise.race([
			Promise.resolve().then(fn),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 还没返回`)), ms) }),
		])
	} finally {
		clearTimeout(timer)
	}
}

/**
 * 假浏览器：renderer 卡死、CDP 连接还在。
 * 给了 timeoutMs 就按它超时（真 Browser.eval 修好后的行为一致）；
 * 不给就真的永不回包（修好前的 browser.mjs：压根不认这个参数）。
 * alive(expr) 里命中的表达式照常返回（模拟「这一条命令还能回」）。
 */
function stuckBrowser({ alive = () => false } = {}) {
	const br = { evals: [], sends: [], gotos: [] }
	br.sessionId = 'S1'
	br.addPreloadScript = () => {}
	br.eval = (expr, opts = {}) => {
		const ms = Number(opts.timeoutMs) || 0
		br.evals.push({ expr: String(expr), ms })
		if (alive(String(expr))) return Promise.resolve(true)
		if (ms > 0) {
			return new Promise((_, reject) => {
				setTimeout(() => reject(new Error(`CDP Runtime.evaluate 超时（${ms}ms）`)), ms)
			})
		}
		return new Promise(() => {}) // 永不回包
	}
	br.send = (method, params, sessionId, timeoutMs) => {
		const ms = Number(timeoutMs) || 0
		br.sends.push({ method, ms })
		if (ms > 0) {
			return new Promise((_, reject) => {
				setTimeout(() => reject(new Error(`CDP ${method} 超时（${ms}ms）`)), ms)
			})
		}
		return new Promise(() => {})
	}
	br.goto = async (url, opts = {}) => {
		const ms = Number(opts.timeoutMs) || 0
		br.gotos.push({ url, ms })
		if (ms > 0) throw new Error(`导航超时（${ms}ms）：${url}`)
		return { url }
	}
	return br
}

/** 正常页面：eval / send 立刻回。点「下一条」故意失败 ⇒ 走键盘那条路（send 才有上限可查）。 */
function healthyBrowser() {
	const br = { evals: [], sends: [], gotos: [] }
	br.sessionId = 'S1'
	br.addPreloadScript = () => {}
	br.eval = async (expr, opts = {}) => {
		const s = String(expr)
		br.evals.push({ expr: s, ms: Number(opts.timeoutMs) || 0 })
		if (/^window\.__fishComment \?/.test(s)) return 5 // 桥已装（COMMENT_BRIDGE_VERSION）
		if (/__fishComment\.digg\b/.test(s)) return { ok: true, digged: true, confirmed: true }
		if (/__fishComment\.collect\b/.test(s)) return { ok: true, collected: true, confirmed: true }
		if (/video-switch-next-arrow/.test(s)) return false
		if (/feed-active-video/.test(s)) return { ok: true, id: '7300000000000000099', live: false, ad: false, title: '文案', author: '作者' }
		if (/video-player-digg/.test(s)) return true
		return { ok: true }
	}
	br.send = async (method, params, sessionId, timeoutMs) => {
		br.sends.push({ method, ms: Number(timeoutMs) || 0 })
		return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }
	}
	br.goto = async (url, opts = {}) => {
		br.gotos.push({ url, ms: Number(opts.timeoutMs) || 0 })
		return { url }
	}
	return br
}

/** 一条 DouyinBrowser（假浏览器 + 假宿主）。timing 不传 = 用默认。 */
function mk(browser, { timing, http = null } = {}) {
	return new DouyinBrowser({
		db,
		clock: { now: () => Date.now() },
		host: { running: true, loggedIn: true, browser, exclusive: async (_l, fn) => fn() },
		getConfig: () => ({ browse: { enabled: true, perDay: 3, videosPerSession: 3, like: true, collect: true, share: false, mode: 'browser' } }),
		callLlm: async () => '好看 [点赞][收藏]',
		persona: () => ({ name: '鱼', brief: '' }),
		worker: { enqueueRealtime: () => {} },
		log: () => {},
		dwellMs: [1, 2],
		readDetail: async () => ({ ok: true, desc: '文案', author: '作者', tags: [], comments: [] }),
		http,
		timing,
	})
}

const evalTimeouts = (br) => br.evals.map((e) => e.ms)
const sendTimeouts = (br) => br.sends.map((s) => s.ms)

// ── ① 刷推荐那条路：activeVideo / next ───────────────────────────────

test('页面卡死时 activeVideo 有界返回（不能等满 60 秒）', async () => {
	const br = stuckBrowser()
	const inst = mk(br, { timing: { evalTimeoutMs: 200 } })
	const t = Date.now()
	const v = await within(3000, () => inst.activeVideo(br))
	assert.equal(v, null, '读不到就是 null')
	assert.ok(Date.now() - t < 3000, '必须有界返回')
	assert.ok(br.evals.length > 0, '得真的发过 eval')
	assert.ok(evalTimeouts(br).every((ms) => ms > 0 && ms <= 200), `eval 必须带 timeoutMs：${evalTimeouts(br)}`)
})

test('页面卡死时 next() 有界返回（不能 8 轮 × 60 秒）', async () => {
	const br = stuckBrowser()
	const inst = mk(br, { timing: { evalTimeoutMs: 200, nextBudgetMs: 900 } })
	const t = Date.now()
	const moved = await within(4000, () => inst.next(br, '111'))
	assert.equal(moved, false, '划不动就是 false')
	assert.ok(Date.now() - t < 4000, '必须有界返回')
	assert.ok(evalTimeouts(br).every((ms) => ms > 0 && ms <= 200), `eval 必须带 timeoutMs：${evalTimeouts(br)}`)
	assert.ok(sendTimeouts(br).every((ms) => ms > 0 && ms <= 200), `send 也得带上限：${sendTimeouts(br)}`)
})

test('页面卡死时 next() 的 changed 循环有总预算（轮数不能乘成 8 分钟）', async () => {
	// 点「下一条」能回，但读当前视频永远不回来 ⇒ 真的走 changed() 的轮询循环
	const br = stuckBrowser({ alive: (expr) => /video-switch-next-arrow/.test(expr) })
	const inst = mk(br, { timing: { evalTimeoutMs: 200, nextBudgetMs: 900 } })
	const t = Date.now()
	const moved = await within(4000, () => inst.next(br, '111'))
	assert.equal(moved, false)
	assert.ok(Date.now() - t < 4000, '必须有界返回')
	const reads = br.evals.filter((e) => /feed-active-video/.test(e.expr)).length
	assert.ok(reads < 8, `读当前视频的轮数要有总预算兜着，实际 ${reads} 轮`)
	assert.ok(evalTimeouts(br).every((ms) => ms > 0 && ms <= 200), `eval 必须带 timeoutMs：${evalTimeouts(br)}`)
})

test('页面卡死时 ensureRecommend 有界返回', async () => {
	const br = stuckBrowser()
	const inst = mk(br, { timing: { evalTimeoutMs: 200 } })
	const t = Date.now()
	const ok = await within(3000, () => inst.ensureRecommend(br))
	assert.equal(ok, false, '进不去就是 false')
	assert.ok(Date.now() - t < 3000, '必须有界返回')
	assert.ok(evalTimeouts(br).every((ms) => ms > 0 && ms <= 200), `eval 必须带 timeoutMs：${evalTimeouts(br)}`)
	assert.ok(sendTimeouts(br).every((ms) => ms > 0 && ms <= 200), `send 也得带上限：${sendTimeouts(br)}`)
})

// ── ② 写操作桥：点赞 / 收藏 ──────────────────────────────────────────

test('页面卡死时 browserWatch 的点赞/收藏桥调用有界返回', async () => {
	const br = stuckBrowser()
	const inst = mk(br, { timing: { evalTimeoutMs: 200 } })
	const t = Date.now()
	const w = await within(4000, () => inst.browserWatch({ id: '9001', title: 't', author: 'a' }, true, false))
	assert.ok(w, '要有结果')
	assert.equal(w.liked, false, '没赞上就是 false')
	assert.equal(w.collected, false, '没收藏上就是 false')
	assert.ok(Date.now() - t < 4000, '必须有界返回')
	assert.ok(evalTimeouts(br).every((ms) => ms > 0 && ms <= 200), `桥调用的 eval 必须带 timeoutMs：${evalTimeouts(br)}`)
})

test('页面卡死时 httpWatch 的收藏桥调用有界返回', async () => {
	const br = stuckBrowser()
	const http = {
		isLoggedIn: () => true,
		ensureCookies: async () => true,
		detail: async () => ({ ok: true, detail: { desc: '文案', author: { nickname: '作者' }, text_extra: [] } }),
		comments: async () => ({ ok: true, list: [] }),
		collect: async () => ({ ok: true, statusCode: 0, statusMsg: '' }),
	}
	const inst = mk(br, { timing: { evalTimeoutMs: 200 }, http })
	const t = Date.now()
	const w = await within(4000, () => inst.httpWatch({ id: '9002', title: 't', author: 'a' }, false, false))
	assert.ok(w, '要有结果')
	assert.equal(w.collected, false, '没收藏上就是 false')
	assert.ok(Date.now() - t < 4000, '必须有界返回')
	assert.ok(evalTimeouts(br).every((ms) => ms > 0 && ms <= 200), `桥调用的 eval 必须带 timeoutMs：${evalTimeouts(br)}`)
})

// ── ③ 表情码清单（douyin-social 的 emojiCodes）─────────────────────────

test('页面卡死时 emojiCodes 有界返回', async () => {
	const br = stuckBrowser()
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200 })
	const list = await within(3000, () => driver.emojiCodes())
	assert.deepEqual(list, [], '读不到就是空数组')
	assert.ok(br.evals.length > 0, '得真的发过 eval')
	assert.ok(evalTimeouts(br).every((ms) => ms > 0 && ms <= 200), `eval 必须带 timeoutMs：${evalTimeouts(br)}`)
})

// ── ④ 正常页面：行为一点没变 ──────────────────────────────────────────

test('页面正常时行为不变：activeVideo / next / 点赞收藏桥照旧', async () => {
	const br = healthyBrowser()
	const inst = mk(br) // 不传 timing ⇒ 用默认
	const v = await inst.activeVideo(br)
	assert.equal(v?.id, '7300000000000000099', '当前视频要读得到')
	assert.equal(await inst.next(br, '111'), true, '划到下一条要成功')
	const w = await inst.browserWatch({ id: '9003', title: 't', author: 'a' }, true, false)
	assert.equal(w.liked, true, '桥确认赞上了')
	assert.equal(w.collected, true, '桥确认收藏上了')
})

test('默认 timing 也是短超时（不传 timing 不能退回 60 秒）', async () => {
	const br = healthyBrowser()
	const inst = mk(br)
	await inst.activeVideo(br)
	await inst.next(br, '111')
	assert.ok(br.evals.length > 0, '得真的发过 eval')
	assert.ok(evalTimeouts(br).every((ms) => ms > 0 && ms <= 12_000), `默认 eval 超时不该是 60 秒：${evalTimeouts(br)}`)
	assert.ok(br.sends.length > 0, '得真的发过 send')
	assert.ok(sendTimeouts(br).every((ms) => ms > 0 && ms <= 12_000), `默认 send 超时不该是 60 秒：${sendTimeouts(br)}`)
})
