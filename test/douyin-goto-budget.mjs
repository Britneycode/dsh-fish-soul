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
import { douyinSocialDriver, PAGE_TIMING } from '../lib/douyin-social.js'

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

/**
 * 真的 Browser + **假时钟**：把「入睡时预算够、醒来时已过期」变成确定可复现的。
 *
 * 假时钟 tick(n) 会先把 Date.now() 推到 now+n，再按到期顺序跑定时器，
 * 回调里看到的是**推进后**的时间（不是它原本的到期时刻）⇒ 一次 tick 越过
 * deadline，就能精确造出「睡醒时已经过期」（真时钟下要靠事件循环被占住，
 * 复现全看机器负载，不算确定）。
 *
 * @param {object} o
 * @param {string} o.href location.href 回什么
 */
function clockBrowser({ href = 'https://www.douyin.com/video/7123' } = {}) {
  const br = new Browser({ exe: 'x', userDataDir: 'y', port: 1 })
  br.ready = true
  br.sessionId = 'S1'
  /** 发过的 CDP 命令：{ method, at }（at = 假时钟时刻） */
  br.calls = []
  br.ws = {
    readyState: 1,
    send(raw) {
      const msg = JSON.parse(raw)
      br.calls.push({ method: msg.method, at: Date.now() })
      const result = msg.method === 'Page.navigate'
        ? { frameId: 'F1' }
        : { result: { value: href } }
      setTimeout(() => br.handleMessage({ data: JSON.stringify({ id: msg.id, result }) }), 0)
    },
  }
  return br
}

/** 跑干净微任务队列（假时钟的定时器回调只负责 resolve，续跑要靠微任务） */
const flush = () => new Promise((r) => setImmediate(r))

test('入睡时预算够、醒来时已过期：settle 不能当作成功', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const br = clockBrowser()
    const budget = 2400
    // settleMs 3400 ⇒ 导航后等 1133ms + settle 睡 900ms；入睡时预算都够。
    // 立刻包一层 catch：假时钟下 promise 可能先落地，别留下未处理的 rejection。
    const p = br.goto('https://www.douyin.com/video/7123', { settleMs: 3400, timeoutMs: budget })
      .then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e }))
    const advance = async (ms) => { t.mock.timers.tick(ms); await flush() }
    /** 推进到 promise 落地（buggy 路径还要多走几步，不能让它挂住） */
    const drive = async (rounds = 20) => {
      let settled = false
      p.then(() => { settled = true })
      for (let i = 0; i < rounds && !settled; i++) await advance(50)
      return p
    }

    await advance(1)      // 导航回包 → 开始导航后等待
    await advance(1200)   // 导航后等待睡醒（还在预算内）
    await advance(1)      // location.href 回包 → 开始 settle
    await advance(1300)   // settle 睡醒时已经过了 deadline
    const res = await drive()

    // 修之前：入睡时预算够就返回 true ⇒ settle 判定通过 ⇒ 过了 deadline 还谎报成功。
    assert.equal(res.ok, false, '过了 deadline 不该返回成功')
    assert.match(String(res.error?.message ?? ''), /超时/)
  } finally {
    t.mock.timers.reset()
  }
})

test('入睡时预算够、醒来时已过期：导航后等待超预算就别再往下走', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const br = clockBrowser()
    const budget = 1000
    // settleMs 2400 ⇒ 导航后等 800ms；入睡时预算 999ms 够睡这 800ms。
    const p = br.goto('https://www.douyin.com/video/7123', { settleMs: 2400, timeoutMs: budget })
      .then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e }))
    const advance = async (ms) => { t.mock.timers.tick(ms); await flush() }
    const drive = async (rounds = 20) => {
      let settled = false
      p.then(() => { settled = true })
      for (let i = 0; i < rounds && !settled; i++) await advance(50)
      return p
    }

    await advance(1)      // 导航回包 → 开始导航后等待（预算够，睡 800ms）
    await advance(1200)   // 睡醒时已经过了 deadline
    const res = await drive()

    assert.equal(res.ok, false, '过了 deadline 不该返回成功')
    assert.match(String(res.error?.message ?? ''), /超时/)
    // 修之前：导航后等待的结果没人看 ⇒ 超预算后照样发 eval。
    const late = br.calls.filter((c) => c.method === 'Runtime.evaluate' && c.at > budget)
    assert.equal(late.length, 0, `超预算后不该再发 eval：${JSON.stringify(br.calls)}`)
  } finally {
    t.mock.timers.reset()
  }
})

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

test('真机事故回归：导航 >8s 但页面成功时，settle 不该被预算挤掉（2026-11-22 看评论报错）', async () => {
  // 🔴 这里必须传 PAGE_TIMING.gotoTimeoutMs 而不是写死的数 —— 测的就是这个常量
  //    够不够装下它自己结构的最小值（导航 15000 + 后等 2500 + settle 尾段 4500 = 23000）。
  //    给 15000 时，9 秒导航（慢网，但页面其实成功了）会在 settle 段被误判超时。
  const br = liveBrowser({ navDelayMs: 9000 })
  const t = Date.now()
  const r = await br.goto('https://www.douyin.com/user/self?showTab=post', {
    settleMs: 7000,
    timeoutMs: PAGE_TIMING.gotoTimeoutMs,
  })
  assert.equal(r.url, 'https://www.douyin.com/video/7123', '导航成功了就该认，settle 不该挤不进预算')
  assert.equal(r.attempt, 0)
  const spent = Date.now() - t
  // 9 秒导航 + 2500 后等 + 4500 settle = 16000，24 秒预算内必须返回成功。
  assert.ok(spent < PAGE_TIMING.gotoTimeoutMs, `实际 ${spent}ms，不该超过预算 ${PAGE_TIMING.gotoTimeoutMs}ms`)
})
