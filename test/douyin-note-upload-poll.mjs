/**
 * prepareNote 上传入口轮询 —— 2026-11-22/23 真机偶发 NO_UPLOAD 回归。
 *
 * 创作者中心页慢时，切完「发布图文」页签 sleep(1500) 后 input[type=file] 还没挂上 DOM，
 * 旧实现一次性查询查不到就报「没找到上传图片的地方（可能改版了）」直接放弃。
 * 同一 URL 隔天发布成功 ⇒ 间歇性、非改版。
 * 修法：waitFor 轮询等 input 挂上 + 按文案兜底找触发点。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { douyinSocialDriver } from '../lib/douyin-social.js'

// lib/time-util.js 的 sleep 是 unref 的：CI 上事件循环可能提前结束（douyin-page-alive.mjs 同款修法）
const keepAlive = setInterval(() => {}, 1000)
test.after(() => clearInterval(keepAlive))

/** send 记账 + 按 script 控制结果；eval / goto 按需配置 */
function fakeBrowser({ uploadAfter = 0 } = {}) {
	const br = { sessionId: 'S1', sends: [], evals: [], gots: 0, navigated: 0 }
	br.eval = (expr, { timeoutMs } = {}) => {
		br.evals.push({ expr, timeoutMs })
		if (/location\.href/.test(expr)) return Promise.resolve('https://creator.douyin.com/creator-micro/content/upload?default-tab=3')
		if (/发布图文/.test(expr)) return Promise.resolve(true)
		return Promise.resolve(true)
	}
	br.goto = async (url, opts = {}) => { br.navigated++; return url }
	br.send = (method, params = {}) => {
		br.sends.push({ method, params })
		if (method === 'Runtime.evaluate' && /input\[type=.?file/.test(params.expression)) {
			br.gots++
			if (br.gots > uploadAfter) return Promise.resolve({ result: { objectId: 'OBJ-1' } })
			return Promise.resolve({ result: {} }) // 查到了但没 objectId = 页面还没挂上
		}
		return Promise.resolve({ result: {} })
	}
	return br
}

function makeDriver(br) {
	return douyinSocialDriver({ running: true, browser: br }, { evalTimeoutMs: 200, waitBudgetMs: 5000 })
}

test('input 前 2 轮没挂上：轮询等到第 3 轮，走 DOM.setFileInputFiles，不再报 NO_UPLOAD', async () => {
	const br = fakeBrowser({ uploadAfter: 2 })
	const driver = makeDriver(br)
	const r = await driver.prepareNote({ title: 't', text: 'x', file: 'C:/tmp/a.png' })
	assert.equal(r.ok, true, `慢页面应当等到 input 挂上，实际：${JSON.stringify(r)}`)
	assert.ok(br.gots >= 3, `至少查了 3 轮，实际 ${br.gots}`)
	assert.ok(br.sends.some((s) => s.method === 'DOM.setFileInputFiles' && s.params.objectId === 'OBJ-1'), '拿到 objectId 后必须真的传图')
})

test('input 立刻就有：不轮询直接传（第 1 轮就拿到）', async () => {
	const br = fakeBrowser({ uploadAfter: 0 })
	const driver = makeDriver(br)
	const r = await driver.prepareNote({ title: 't', text: 'x', file: 'C:/tmp/a.png' })
	assert.equal(br.gots, 1, `input 直接在就该只查一轮，实际 ${br.gots}`)
	assert.ok(r.ok !== false)
})

test('一直查不到：预算耗尽后才报 NO_UPLOAD（不是一次就放弃）', async () => {
	const br = fakeBrowser({ uploadAfter: 999 })
	const driver = makeDriver(br)
	const t = Date.now()
	const r = await driver.prepareNote({ title: 't', text: 'x', file: 'C:/tmp/a.png' })
	assert.equal(r.ok, false)
	assert.equal(r.code, 'NO_UPLOAD')
	assert.ok(br.gots >= 3, `必须轮询多轮再放弃，实际只查了 ${br.gots} 轮`)
	assert.ok(Date.now() - t < 30_000, '不能超过 waitFor 总预算量级')
})

// ── 「读不回来」≠「读到空」（2026-11-27）────────────────────────────────────
// 原来判定写 .catch(() => '')：eval 超时/断连都返回空串 ⇒ !/上传中/.test('') 恒真
// ⇒ 没读完页面就报上传成功。页面被验证码 iframe 卡死时正好走这条路。
test('eval 一直读不回来：报 UPLOAD_UNKNOWN，不谎报上传成功', async () => {
	const br = fakeBrowser({ uploadAfter: 0 })
	br.eval = (expr) => {
		if (/location.href/.test(expr)) return Promise.resolve('https://creator.douyin.com/creator-micro/content/upload?default-tab=3')
		// 探活（ensurePageAlive 用 eval('1')）要通，否则先被 PAGE_DEAD 拦下 —— 这里要测的是上传判定
		if (String(expr).trim() === '1') return Promise.resolve(1)
		if (/document.body.innerText/.test(expr)) return Promise.reject(new Error('页面卡住'))
		return Promise.resolve(true)
	}
	const driver = makeDriver(br)
	const r = await driver.prepareNote({ title: 't', text: 'x', file: 'C:/tmp/a.png' })
	assert.equal(r.ok, false, '读不回来不能报成功')
	assert.equal(r.code, 'UPLOAD_UNKNOWN', `应为 UPLOAD_UNKNOWN，实际 ${JSON.stringify(r)}`)
})

test('页面读到「上传中」消失：正常报 ok（回归，别把好路径也判成 UNKNOWN）', async () => {
	const br = fakeBrowser({ uploadAfter: 0 })
	let bodyCalls = 0
	br.eval = (expr) => {
		if (/location.href/.test(expr)) return Promise.resolve('https://creator.douyin.com/creator-micro/content/upload?default-tab=3')
		if (/document.body.innerText/.test(expr)) return Promise.resolve(++bodyCalls >= 2 ? '发布' : '图片上传中…')
		return Promise.resolve(true)
	}
	const driver = makeDriver(br)
	const r = await driver.prepareNote({ title: 't', text: 'x', file: 'C:/tmp/a.png' })
	assert.equal(r.ok, true, `读到「上传中」消失就该 ok，实际 ${JSON.stringify(r)}`)
})
