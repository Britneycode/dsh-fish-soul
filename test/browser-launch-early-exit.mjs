/**
 * 启动进程早退 ≠ 浏览器没起来（Edge 158 的启动竞争，2026-11-22）。
 *
 * 症状：`Browser.launch()` 在 Edge 上稳定抛
 *   「浏览器进程启动后立刻退出。多半是同一个 profile 已经被另一个浏览器占着。」
 * 而那个提示是**错的** —— profile 没被占，机器上也没有别人在用那个目录。
 *
 * 真根因（本机实测，同参数 / 同 FLAGS / 同 tmpHome 结构）：
 *   · Edge 158 把「拉起真正的浏览器」交给常驻的 watchdog 进程，
 *     我们 spawn 出去的那个启动进程 **110ms 就以 code=0 退出**；
 *   · 真正的 CDP 端口要 **~800ms** 才开始应答；
 *   · 而 `launch()` 的等待循环里 **`if (exited)` 分支排在探端口之前**：
 *     一看到 `exited=true`、端口还没起来就 throw，
 *     于是永远等不到端口就绪那一刻。
 *
 * Chrome 不受影响（它 spawn 的进程自己就是浏览器，不早退），
 * 所以这条竞争只在本机 Edge 上现形。
 *
 * 时序不靠真实毫秒（机器快慢会漂），靠 **probePort 的调用次数**门控：
 *   前 5 次调用一律「端口没起来」，第 6 次起才「就绪」。
 * 这样旧代码（第一次 exited 检查就放弃）与新代码（继续等到就绪）的结果
 * **只差在行为上**，与时序漂移无关。
 *
 * 启动进程用真的 spawn：exe 指向 node 自己、喂给它浏览器参数 ——
 * node 不认识这些参数会立刻报错退出（实测 ~85ms，code=9），
 * 和 Edge 启动进程「秒退」的节奏一致，且不依赖任何浏览器安装。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs'
import { tmpHome } from './_tmp.mjs'

// 「端口永远不就绪」的用例全程在 sleep 里，挂个非 unref 定时器钉住事件循环（仓库约定）。
const keepAlive = setInterval(() => {}, 1000)
test.after(() => clearInterval(keepAlive))

/** 借一个空闲端口号（借完就还，只拿号码不占线）。 */
async function freePort() {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))
  return port
}

/**
 * 造一个「启动进程秒退、CDP 端口晚就绪」的 Browser。
 *
 * @param {object} o
 * @param {number|false} o.readyAtCall 第几次 probePort 调用起端口算就绪；
 *        `false` = 永远不就绪。计数包含 launch() 入口那次「端口上是否已有浏览器」检查。
 */
function earlyExitBrowser({ readyAtCall } = {}) {
  const home = tmpHome('dsh-earlyexit-')
  const userDataDir = join(home, 'profile')
  mkdirSync(userDataDir, { recursive: true })

  const port = 1 // 端口本身没人听：循环里非 exited 分支的 fetch 永远拿不到应答
  const br = new Browser({ exe: process.execPath, userDataDir, port, log: () => {} })

  let calls = 0
  br.probePort = async () => {
    calls += 1
    if (readyAtCall === false || calls < readyAtCall) return null
    return { Browser: 'Fake/158', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x' }
  }
  return { br, getCalls: () => calls }
}

test('启动进程早退时，继续等端口到就绪，而不是当场放弃', async () => {
  process.env.FISH_SOUL_CDP_WAIT_MS = '8000'
  try {
    // 就绪时刻设在第 6 次调用：
    //   #1 = launch 入口的「已有浏览器」检查；#2 = 退出处理器的存活检查；
    //   #3 起才是等待循环每轮一次的探测。旧代码在 #3 拿到 null 就 throw，
    //   新代码要等到 #6 ——「等够了才认输/接管」正是要钉住的行为。
    const { br, getCalls } = earlyExitBrowser({ readyAtCall: 6 })
    let err = null
    try { await br.launch() } catch (e) { err = e }
    const msg = String(err?.message ?? '')

    // 早退不能被当成「profile 被占」的致命错误
    assert.ok(!/profile 已经被另一个浏览器占着/.test(msg), `不该甩锅 profile，实际：${msg}`)
    // 也不能没等到就绪就放弃（端口没响应 = 等待上限处才该说的话）
    assert.ok(!/端口 .*没响应/.test(msg), `没等到端口就绪就放弃了（只探到第 ${getCalls()} 次），实际：${msg}`)
    // 真等到第 6 次才走到接管 / 连接那一步（后面的失败只可能来自假 ws，与本竞争无关）
    assert.ok(getCalls() >= 6, `等待循环应该在就绪前持续探测，实际只探了 ${getCalls()} 次`)
    // 🔴 关键：**真的走到了 attach 那一步**（假端口的 ws 连不上 ⇒ 报错必须是 WebSocket 错误）。
    //    只断言「没报错」是不够的 —— 万一某版实现压根没去 attach，光靠计数也分不出来。
    assert.match(msg, /WebSocket|连 CDP/, `应该已经过了端口等待、进入连接阶段，实际：${msg}`)
    // 而且要按「接管已有实例」处理：attached=true ⇒ close() 不会去 kill 别人的进程
    assert.equal(br.attached, true, '早退后接管 watchdog 拉起的实例，应当标记 attached')
  } finally {
    delete process.env.FISH_SOUL_CDP_WAIT_MS
  }
})

test('启动进程早退且端口永远不就绪 → 在等待上限处报「端口没响应」，不甩锅 profile', async () => {
  process.env.FISH_SOUL_CDP_WAIT_MS = '1200'
  try {
    const { br } = earlyExitBrowser({ readyAtCall: false })
    await assert.rejects(
      br.launch(),
      (err) => {
        const msg = String(err.message)
        assert.match(msg, /端口.*没响应/, `错误文案不对：${msg}`)
        assert.doesNotMatch(msg, /profile 已经被另一个浏览器占着/, `不该甩锅 profile：${msg}`)
        return true
      },
      '端口迟迟不应答时，应该报真实的「端口没响应」，而不是甩锅给 profile',
    )
  } finally {
    delete process.env.FISH_SOUL_CDP_WAIT_MS
  }
})
