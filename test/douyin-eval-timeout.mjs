/**
 * eval 超时上界 —— 巡检 P2（2026-11-15）。
 *
 * 页面 renderer 卡死但 CDP 连接还在时，Runtime.evaluate 永不回包：
 *   · browser.mjs 的 send 默认 60 秒才超时
 *   · douyin-social.js 的 waitFor 每轮各等 60 秒再 catch 掉继续下一轮
 *     ⇒ openMusicPanel 6 轮 = 6 分钟，浏览器锁一直被占，所有页面操作排队
 *
 * 修法：eval 支持 opts.timeoutMs；waitFor 有总预算；音乐/发布路径逐个 eval 传短超时。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs'
import { douyinSocialDriver } from '../lib/douyin-social.js'

// lib/time-util.js 的 sleep 是 unref 的。本文件里有永远 pending 的 promise，
// 事件循环会以为没事可做直接结束 ⇒ await 永不 resolve（0.1 秒假红）。
// 挂一个非 unref 的定时器把事件循环钉住，after 里清掉（2026-11-15 commit 897dd42 同款）。
const keepAlive = setInterval(() => {}, 1000)
test.after(() => clearInterval(keepAlive))

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
 * 假浏览器：探活（eval('1')）成功，之后所有 eval 都「永不回包」——
 * 模拟 renderer 卡死、CDP 连接还在。
 * 给了 timeoutMs 就按它超时（跟真 Browser.eval 修好后的行为一致）。
 */
function stuckBrowser() {
	const br = { timeouts: [] }
	br.eval = (expr, opts = {}) => {
		if (String(expr) === '1') return Promise.resolve(1) // ensurePageAlive 的探活
		const ms = Number(opts.timeoutMs)
		if (ms > 0) {
			br.timeouts.push(ms)
			return new Promise((_, reject) => {
				setTimeout(() => reject(new Error(`CDP Runtime.evaluate 超时（${ms}ms）`)), ms)
			})
		}
		return new Promise(() => {}) // 永不回包
	}
	br.send = () => Promise.resolve({})
	br.goto = async () => ({ url: 'https://creator.douyin.com/creator-micro/content/upload' })
	return br
}

test('eval 把 timeoutMs 透传给 send；不给就还是 60 秒', async () => {
	const br = new Browser({ exe: 'x', userDataDir: 'y', port: 1 })
	br.ready = true
	br.sessionId = 'S1'
	const seen = []
	br.send = (method, params, sessionId, timeoutMs) => {
		seen.push({ method, timeoutMs })
		return Promise.resolve({ result: { value: 7 } })
	}
	assert.equal(await br.eval('1'), 7)
	assert.equal(seen[0].method, 'Runtime.evaluate')
	assert.equal(seen[0].timeoutMs, 60_000, '默认 60 秒不变，别影响其他调用方')
	await br.eval('1', { timeoutMs: 12_000 })
	assert.equal(seen[1].timeoutMs, 12_000)
})

test('页面卡死时 eval 在 timeoutMs 内报错，不空等 60 秒', async () => {
	const br = new Browser({ exe: 'x', userDataDir: 'y', port: 1 })
	br.ready = true
	br.sessionId = 'S1'
	br.ws = { readyState: 1, send() {} } // CDP 连着，但回包永远不来
	const t = Date.now()
	await assert.rejects(() => br.eval('1', { timeoutMs: 300 }), /超时/)
	const spent = Date.now() - t
	assert.ok(spent < 5000, `实际 ${spent}ms，必须远小于 send 的 60 秒`)
})

test('waitFor 有总预算：fn 永远 pending 时到点返回 null', async () => {
	const { waitFor } = await import('../lib/douyin-social.js')
	const t = Date.now()
	const v = await waitFor(() => new Promise(() => {}), { tries: 20, gapMs: 50, budgetMs: 200 })
	const spent = Date.now() - t
	assert.equal(v, null)
	assert.ok(spent < 3000, `实际 ${spent}ms，不能按「每轮 60 秒 × N 轮」叠加`)
})

test('waitFor 正常语义不变：取到值就返回 / 出错或空值算没等到', async () => {
	const { waitFor } = await import('../lib/douyin-social.js')
	assert.equal(await waitFor(async () => 'ok', { tries: 3, gapMs: 10 }), 'ok')
	assert.equal(await waitFor(async () => null, { tries: 3, gapMs: 10 }), null)
	assert.equal(await waitFor(async () => { throw new Error('炸了') }, { tries: 2, gapMs: 10 }), null)
})

test('页面卡死时抓推荐音乐有界返回（不占锁 6 分钟）', async () => {
	const br = stuckBrowser()
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 1000 })
	const r = await within(3000, () => driver.listRecommendedMusic())
	assert.equal(r.ok, false)
	assert.ok(String(r.error ?? '').length > 0, '失败要说清原因')
	assert.ok(br.timeouts.length > 0, '逐页面的 eval 必须带 timeoutMs，不然还是 60 秒一轮')
	assert.ok(Math.max(...br.timeouts) <= 200, `eval 超时不该超过给的上限：${br.timeouts}`)
})

test('页面卡死时配乐选歌有界返回（不空等）', async () => {
	const br = stuckBrowser()
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 1000 })
	const r = await within(3000, () => driver.publishNote({ music: '晚风心里吹' }))
	assert.equal(r.ok, false)
	assert.ok(br.timeouts.length > 0, '选歌的 eval 也得有 timeoutMs')
})

test('页面卡死时传图/填标题有界返回（不空等）', async () => {
	const br = stuckBrowser()
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 1000 })
	const r = await within(3000, () => driver.prepareNote({ title: '标题', text: '正文', file: '/tmp/x.png' }))
	assert.equal(r.ok, false)
	assert.ok(br.timeouts.length > 0, '编辑页的 eval 也得有 timeoutMs')
})
