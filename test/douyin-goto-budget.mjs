/**
 * 导航的整段预算 —— 独立审查打回的阻断项（2026-11-15）。
 *
 * browser.mjs 的 goto() 给导航请求加了上限，**等待却是裸 sleep**：
 *   · 导航请求超时 → sleep(800) × 重试次数（不看剩余预算）
 *   · 导航成功后   → sleep(settle)（settleMs 7000 时是 4500ms）才返回
 * ⇒ 「整个导航的上限」名不副实；openWork 把它当整操作 deadline 的一部分，
 *   整操作照样能超过 30 秒。
 *
 * 这一组全部用**真的 Browser.goto**（不是立刻返回的 stub），
 * 断言整次导航有界返回、不超过给定的预算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs'
import { douyinSocialDriver } from '../lib/douyin-social.js'

// 挂一个非 unref 的定时器把事件循环钉住（2026-11-15 commit 897dd42 同款）：
// 没有永远 pending 的 promise 时不需要，但页面卡死的用例里有。
const keepAlive = setInterval(() => {}, 1000)
test.after(() => clearInterval(keepAlive))

/**
 * 真的 Browser，CDP 连着但**永远不回包** ——
 * 模拟原生确认框挡住 / renderer 卡死。
 */
function hungBrowser() {
  const br = new Browser({ exe: 'x', userDataDir: 'y', port: 1 })
  br.ready = true
  br.sessionId = 'S1'
  br.ws = { readyState: 1, send() {} }
  return br
}

/**
 * 真的 Browser，CDP 正常回包 —— 模拟页面加载成功（location.href 有值）。
 *
 * @param {object} o
 * @param {number} o.navDelayMs Page.navigate 多久才回包（0 = 立刻）
 * @param {number} o.evalDelayMs Runtime.evaluate 多久才回包（0 = 立刻）
 */
function liveBrowser({ href = 'https://www.douyin.com/video/7123', navDelayMs = 0, evalDelayMs = 0 } = {}) {
  const br = new Browser({ exe: 'x', userDataDir: 'y', port: 1 })
  br.ready = true
  br.sessionId = 'S1'
  br.ws = {
    readyState: 1,
    send(raw) {
      const msg = JSON.parse(raw)
      const result = msg.method === 'Page.navigate'
        ? { frameId: 'F1' }
        : { result: { value: href } }
      const delay = msg.method === 'Page.navigate' ? navDelayMs : evalDelayMs
      setTimeout(() => br.handleMessage({ data: JSON.stringify({ id: msg.id, result }) }), delay)
    },
  }
  return br
}

test('页面卡死时导航有界返回：重试间隔不许睡过预算', async () => {
  const br = hungBrowser()
  const budget = 1500
  const t = Date.now()
  await assert.rejects(
    () => br.goto('https://www.douyin.com/', { settleMs: 7000, timeoutMs: budget }),
    /超时/,
  )
  const spent = Date.now() - t
  // 修之前：导航请求挂满 1500ms 超时后，还要再睡 800ms 才轮到重试 ⇒ 2300ms。
  assert.ok(spent <= budget + 400, `实际 ${spent}ms，整导航不该超过 ${budget}ms 的上限`)
})

test('导航成功但 settle 睡不完时：有界返回，且不谎报成功', async () => {
  const br = liveBrowser()
  const budget = 3000
  const t = Date.now()
  // 修之前：导航成功后还要睡 4500ms 的 settle 才返回成功（6833ms），预算形同虚设。
  await assert.rejects(
    () => br.goto('https://www.douyin.com/video/7123', { settleMs: 7000, timeoutMs: budget }),
    /超时/,
  )
  const spent = Date.now() - t
  assert.ok(spent <= budget + 1000, `实际 ${spent}ms，整导航不该超过 ${budget}ms 的上限`)
})

test('不给预算 = 老行为不变：照睡整段 settle 并返回成功', async () => {
  const br = liveBrowser()
  const t = Date.now()
  const r = await br.goto('https://www.douyin.com/video/7123', { settleMs: 3000 })
  const spent = Date.now() - t
  assert.equal(r.url, 'https://www.douyin.com/video/7123')
  assert.equal(r.attempt, 0)
  // 导航后等待 1000ms + settle 500ms —— 没预算时这两段都得照睡。
  assert.ok(spent >= 1400, `实际 ${spent}ms，不该跳过等待`)
})

test('openWork 整操作不超过总预算（页面卡死，真的 Browser.goto）', async () => {
  const br = hungBrowser()
  const driver = douyinSocialDriver(
    { running: true, browser: br },
    { evalTimeoutMs: 200, gotoTimeoutMs: 1000, openWorkBudgetMs: 3000 },
  )
  const t = Date.now()
  const r = await driver.openWork({ id: '7123', kind: 'video' })
  const spent = Date.now() - t
  assert.equal(r.ok, false)
  assert.ok(String(r.error ?? '').length > 0, '失败要说清原因')
  // 修之前：两次导航各多睡 800ms 的重试间隔 ⇒ 3600ms，超出 3000ms 的总预算。
  assert.ok(spent <= 3000, `实际 ${spent}ms，openWork 不该超过 3000ms 的总预算`)
})

test('openWork 整操作不超过总预算（慢导航：成功但慢，sleep 睡过预算）', async () => {
  const br = liveBrowser({ navDelayMs: 400 })
  const driver = douyinSocialDriver(
    { running: true, browser: br },
    { evalTimeoutMs: 200, gotoTimeoutMs: 3000, openWorkBudgetMs: 3000 },
  )
  const t = Date.now()
  const r = await driver.openWork({ id: '7123', kind: 'video' })
  const spent = Date.now() - t
  assert.equal(r.ok, false)
  // 修之前：导航成功后照睡 4500ms 的 settle ⇒ 7233ms。
  assert.ok(spent <= 3000 + 1000, `实际 ${spent}ms，openWork 不该超过 3000ms 的总预算`)
})
