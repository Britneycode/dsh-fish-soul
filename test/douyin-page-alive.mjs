/**
 * 页面活性检测 —— 2026-11-15 真机回归。
 *
 * 创作者中心页面挂着验证码 iframe 后整页 hung 死，Runtime.evaluate / Page.navigate
 * 全部无响应，配乐报「没找到或打开音乐面板」「已点击使用，但编辑页未确认显示歌名」。
 * 根因是在死页面上盲点：eval 永远 pending，waitFor 空等十几秒后报错。
 * 修法：操作前探活，死了就 reload 一次，还死就直接报原因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ensurePageAlive, VERIFY_JS } from '../lib/douyin-social.js'

// lib/time-util.js 的 sleep 是 unref 的。CI 上 4 vCPU 被真启 Chromium 的套件抢满时，
// 事件循环认为没事可做直接结束，await 永不 resolve，0.1 秒就挂
// （'Promise resolution is still pending but the event loop has already resolved'）。
// 挂一个非 unref 的定时器把事件循环钉住（2026-11-10 commit 53af484 同款修法）。
const keepAlive = setInterval(() => {}, 1000)
test.after(() => clearInterval(keepAlive))

/** eval 永远 pending 的假浏览器。reload 后按 aliveAfterReload 决定是否恢复。 */
function deadBrowser({ aliveAfterReload = false } = {}) {
	const br = { reloaded: false, evals: 0 }
	br.eval = (expr) => {
		br.evals++
		if (br.reloaded && aliveAfterReload) return Promise.resolve(1)
		return new Promise(() => {}) // 永不 resolve，模拟 renderer 卡死
	}
	br.send = (method) => {
		if (method === 'Page.reload') br.reloaded = true
		return Promise.resolve({})
	}
	return br
}

test('活页面直接通过，不 reload', async () => {
	const br = { reloaded: false, eval: () => Promise.resolve(1), send: () => { br.reloaded = true; return Promise.resolve({}) } }
	assert.equal(await ensurePageAlive(br, { timeoutMs: 200 }), true)
	assert.equal(br.reloaded, false, '活着就别刷新，刷新会把编辑页的草稿冲掉')
})

test('卡死的页面 reload 一次后恢复', async () => {
	const br = deadBrowser({ aliveAfterReload: true })
	assert.equal(await ensurePageAlive(br, { timeoutMs: 150 }), true)
	assert.equal(br.reloaded, true, '必须真的发了 Page.reload')
})

test('reload 也救不回就返回 false，且只 reload 一次', async () => {
	const br = deadBrowser({ aliveAfterReload: false })
	let reloads = 0
	br.send = (method) => { if (method === 'Page.reload') { reloads++; br.reloaded = true } return Promise.resolve({}) }
	const t = Date.now()
	assert.equal(await ensurePageAlive(br, { timeoutMs: 150 }), false)
	assert.equal(reloads, 1, '只试一次，别循环刷新把页面越刷越死')
	assert.ok(Date.now() - t < 5000, '两次探活各 150ms，不能空等 send 的 60 秒默认超时')
})

test('reload 命令本身也不回（死页面连 CDP 都不响应）时仍能返回', async () => {
	const br = deadBrowser()
	br.send = () => new Promise(() => {}) // reload 命令也永不回
	const t = Date.now()
	assert.equal(await ensurePageAlive(br, { timeoutMs: 150 }), false)
	// 5 秒竞速 + 3 秒等待 + 两次探活，约 8 秒；关键是远小于 send 默认的 60 秒
	assert.ok(Date.now() - t < 12000, 'reload 命令有 5 秒短超时，不能卡死 60 秒')
})

test('验证码检测认 iframe（rc-verifycenter），不靠 body 文本', () => {
	// 真机那次滑块挂在独立 iframe 里，body 一个字都没有
	const js = VERIFY_JS
	assert.match(js, /rc-verifycenter/, '必须扫 iframe src')
	assert.match(js, /querySelectorAll\('iframe'\)/, '必须遍历 iframe')
	// 纯函数级验证：把脚本里的 document 换成假的跑一遍
	const fakeDoc = (src) => ({
		body: { innerText: '' },
		querySelectorAll: (sel) => sel === 'iframe' ? [{ src }] : [],
	})
	const run = (doc) => new Function('document', `return ${js}`)(doc)
	assert.equal(run(fakeDoc('https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/rmc-nocaptcha/1.0.0.54/index.html')), 'captcha')
	assert.equal(run(fakeDoc('https://www.douyin.com/sw.js')), '', '无关 iframe 不误报')
	assert.equal(run(fakeDoc('')), '', '没有 iframe 不误报')
})
