/**
 * eval 超时上界 —— 巡检 P2（2026-11-15）。
 *
 * 页面 renderer 卡死但 CDP 连接还在时，Runtime.evaluate 永不回包：
 *   · browser.mjs 的 send 默认 60 秒才超时
 *   · douyin-social.js 的 waitFor 每轮各等 60 秒再 catch 掉继续下一轮
 *     ⇒ openMusicPanel 6 轮 = 6 分钟，浏览器锁一直被占，所有页面操作排队
 *
 * 修法：eval 支持 opts.timeoutMs；waitFor 有总预算；每个 eval 传短超时；
 * 多次 eval 的操作（openWork / reply）再加一道整操作的总预算（deadline）。
 *
 * ⚠️ 本文件**只经公开的 driver 行为**断言（douyinSocialDriver），
 *    不 import 任何新导出的内部函数 —— 未修基线上那样写只会红在
 *    「模块没有这个导出」上，证明不了任何行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs'
import { douyinSocialDriver } from '../lib/douyin-social.js'
import { sleep } from '../lib/time-util.js'

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
 * 给了 timeoutMs 就按它超时（跟真 Browser.eval 修好后的行为一致）；
 * 不给就真的永不回包（跟修好前的 browser.mjs 一致：压根不认这个参数）。
 */
function stuckBrowser() {
	const br = { timeouts: [] }
	br.eval = (expr, opts = {}) => {
		if (String(expr) === '1') return Promise.resolve(1) // ensurePageAlive 的探活
		const ms = Number(opts.timeoutMs)
		br.timeouts.push(ms)
		if (ms > 0) {
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

/**
 * 假浏览器：eval 慢 `ms` 才回 —— 正常但慢的页面。
 * 页面比给的 timeoutMs 还慢就按超时算（跟真 Browser.eval 一致）。
 */
function slowBrowser(ms, value = null) {
	const br = { timeouts: [], evals: 0 }
	br.eval = (expr, opts = {}) => {
		const timeout = Number(opts.timeoutMs)
		br.timeouts.push(timeout)
		br.evals++
		return new Promise((resolve, reject) => {
			setTimeout(() => {
				if (timeout > 0 && ms > timeout) reject(new Error(`CDP Runtime.evaluate 超时（${timeout}ms）`))
				else resolve(value)
			}, timeout > 0 ? Math.min(timeout, ms) : ms)
		})
	}
	br.send = () => Promise.resolve({})
	br.goto = async () => ({ url: 'https://www.douyin.com/note/x' })
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

// ── 评论主路径（回作品评论）────────────────────────────────────────────
// 这一组全部经**公开的 driver 行为**断言：作品列表 / 打开作品 / 回评论。

test('等待有总预算：页面秒失败也不该按轮数叠满', async () => {
	// 每次 eval 都秒失败 ⇒ 唯一能截住轮数的只有「总预算」。
	// 没有预算时：tries(6) × gap(1s) = 6 秒；预算 1200ms 时应该 2 轮就收工。
	const br = { evals: 0, timeouts: [] }
	br.goto = async () => ({})
	br.send = async () => ({})
	br.eval = async (expr, opts = {}) => {
		br.evals++
		br.timeouts.push(Number(opts.timeoutMs) || 0)
		throw new Error('页面死了')
	}
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 1200 })
	const t = Date.now()
	const works = await driver.listWorks()
	const spent = Date.now() - t
	assert.deepEqual(works, [], '没作品就是空数组')
	assert.ok(br.evals >= 2, `实际轮询 ${br.evals} 次：预算不该一轮就掐死`)
	assert.ok(br.evals < 6, `实际轮询 ${br.evals} 次：预算没把轮数截断（tries 是 6）`)
	assert.ok(spent < 2500, `实际 ${spent}ms：不该按 tries × gap 叠满`)
	assert.ok(br.timeouts.every((x) => x > 0), `作品列表的 eval 必须带 timeoutMs：${br.timeouts}`)
})

test('等待的语义不变：取到值原样返回 / 空值和出错都算没等到 / 挂死时有界返回', async () => {
	// 取到值 ⇒ 原样带回来，且立刻返回（不用把轮次走完）
	{
		const br = { evals: 0 }
		br.goto = async () => ({})
		br.send = async () => ({})
		br.eval = async () => {
			br.evals++
			return br.evals >= 3 ? [{ id: '7001', title: '晚饭吃了泡面' }] : []
		}
		const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 5000 })
		const works = await driver.listWorks()
		assert.equal(works.length, 1, '等到了就该把值原样带回来')
		assert.equal(works[0].id, '7001')
		assert.ok(br.evals >= 3 && br.evals < 6, `实际轮询 ${br.evals} 次：取到值就该立刻返回`)
	}
	// 空值 ⇒ 算没等到，返回空数组
	{
		const br = { evals: 0 }
		br.goto = async () => ({})
		br.send = async () => ({})
		br.eval = async () => { br.evals++; return [] }
		const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 800 })
		assert.deepEqual(await driver.listWorks(), [], '空列表算没等到')
	}
	// 出错 ⇒ 算没等到，不能把异常抛给调用方
	{
		const br = { evals: 0 }
		br.goto = async () => ({})
		br.send = async () => ({})
		br.eval = async () => { br.evals++; throw new Error('页面死了') }
		const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 800 })
		assert.deepEqual(await driver.listWorks(), [], '出错也算没等到')
	}
	// 挂死 ⇒ 必须有界返回（预算包住这一次调用本身）
	{
		const br = stuckBrowser()
		const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 600 })
		const t = Date.now()
		const works = await within(3000, () => driver.listWorks())
		assert.deepEqual(works, [], '挂死时也必须有界返回')
		assert.ok(Date.now() - t < 3000, '挂死时也必须有界返回')
	}
})

test('作品页永久 pending 时有界返回，不霸着浏览器锁', async () => {
	const br = stuckBrowser()
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, openWorkBudgetMs: 1000 })
	const t = Date.now()
	const r = await within(4000, () => driver.openWork({ id: 'x', kind: 'note' }))
	const spent = Date.now() - t
	assert.equal(r.ok, false)
	assert.ok(String(r.error ?? '').length > 0, '失败要说清原因')
	assert.ok(br.timeouts.length > 0, 'openWork 的 eval 必须带 timeoutMs')
	assert.ok(br.timeouts.every((x) => x > 0 && x <= 200), `openWork 的 eval 超时不该超过给的上限：${br.timeouts}`)
	assert.ok(spent < 3000, `实际 ${spent}ms，openWork 必须有界返回`)
})

test('回评论永久 pending 时有界返回，不霸着浏览器锁', async () => {
	const br = stuckBrowser()
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, replyBudgetMs: 1000 })
	const r = await within(4000, () => driver.reply({ author: '燕燕', content: '好看' }, '谢谢'))
	assert.equal(r.ok, false)
	assert.ok(String(r.error ?? '').length > 0, '失败要说清原因')
	assert.ok(br.timeouts.length > 0, 'reply 的 eval 必须带 timeoutMs')
	assert.ok(br.timeouts.every((x) => x > 0 && x <= 200), `reply 的 eval 超时不该超过给的上限：${br.timeouts}`)
})

test('正常慢页面仍能成功：单次接近 evalTimeoutMs、多轮累计接近预算也不误判失败', async () => {
	// 每次 eval 都要 150ms（上限 200ms）；第 2 轮才出列表。
	// 累计 150 + 1000(轮间等待) + 150 = 1300ms，预算 1400ms ⇒ 刚好压在预算内。
	const br = { n: 0, timeouts: [], evals: 0 }
	br.goto = async () => ({})
	br.send = async () => ({})
	br.eval = async (expr, opts = {}) => {
		br.evals++
		const timeout = Number(opts.timeoutMs) || 0
		br.timeouts.push(timeout)
		await sleep(150)
		br.n++
		return br.n >= 2 ? [{ id: '7001', title: '慢加载的作品' }] : []
	}
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 1400 })
	const t = Date.now()
	const works = await driver.listWorks()
	const spent = Date.now() - t
	assert.equal(works.length, 1, '慢页面但在预算内就该成功')
	assert.equal(works[0].id, '7001')
	assert.ok(br.evals >= 2, `实际轮询 ${br.evals} 次`)
	assert.ok(spent < 1400, `实际 ${spent}ms`)
	assert.ok(br.timeouts.every((x) => x >= 150), `单次 eval 的超时不能砍掉合法的慢加载：${br.timeouts}`)
})

test('正常慢页面仍能成功：openWork 的整操作总预算别把慢加载判死', async () => {
	// 评论区一开始是折叠的：第 1 次读到「没打开」，点开图标后第 2 次才读到「已打开」。
	// 每次 eval 150ms（上限 200ms），整个操作约 1.5 秒，预算 5 秒。
	let reads = 0
	const br = { timeouts: [], clicks: 0 }
	br.goto = async () => ({})
	br.send = async (method) => { if (method === 'Input.dispatchMouseEvent') br.clicks++ }
	br.eval = async (expr, opts = {}) => {
		const timeout = Number(opts.timeoutMs) || 0
		br.timeouts.push(timeout)
		await sleep(150)
		const s = String(expr)
		if (s.includes('comment-input-inner-container') && s.includes('getBoundingClientRect')) {
			reads++
			return { box: reads >= 2, inDom: true, items: 0, btn: true, url: 'https://www.douyin.com/note/x' }
		}
		if (s.includes('feed-comment-icon')) return { x: 10, y: 10 }
		return null
	}
	const driver = douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, openWorkBudgetMs: 5000 })
	const r = await within(6000, () => driver.openWork({ id: 'x', kind: 'note' }))
	assert.equal(r.ok, true, r.error)
	assert.ok(br.clicks >= 1, '折叠时点过评论图标')
	assert.ok(br.timeouts.length > 0 && br.timeouts.every((x) => x >= 150), `单次 eval 的超时不能砍掉合法的慢加载：${br.timeouts}`)
})
