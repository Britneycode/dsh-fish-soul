/**
 * douyin-panel.mjs —— 私信面板：撑窗口 / 打开面板（toggle）/ 进会话
 * 拆自 dsh-douyin-bridge lib/douyin.mjs（MIT，commit 6e4bb7f），改动见同目录 README.md。
 */
import { SEL, pageFindHelper } from './selectors.mjs'
import { sleep } from './douyin-util.mjs'

async function closePanel(b) {
  try {
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 400, button: 'left', clickCount: 1 }, b.sessionId)
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 400, button: 'left', clickCount: 1 }, b.sessionId)
  } catch { /* 忽略 */ }
}

// ── 私信 ────────────────────────────────────────────────────────

/**
 * 打开私信面板（toggle：开着就别再点）
 *
 * 🔴 踩过的坑：
 *   1. 「消息」按钮是 **toggle** —— 面板开着时再点会关掉
 *   2. 视频页**没有**「消息」按钮（在详情页跑 dm 会失败）
 *      ⇒ 先确认在首页，不在就导航过去
 */
/**
 * 把浏览器窗口撑大。
 *
 * 🔴 抖音私信面板对窗口尺寸极其挑剔，实测（2026-10，dpr 1.25 的 1920×1080 屏）：
 *   · 视口 1532 宽：会话列表能出来，但**聊天输入框落在 x=1707（视口外）** ——
 *     点不到、insertText 打不进去，焦点还留在 BODY 上。
 *     表现就是「发送返回 ok 但抖音里没这条」或「输入没生效」。
 *   · 视口 1532×791：面板可能干脆渲染不出来（DOM 里只有 0×0 的会话项）。
 *   ⇒ 私信面板要 **≥1800 宽**才完整落在视口里。
 *
 * ⚠️ 只能改**真实窗口尺寸**（`Browser.setWindowBounds`）。
 *    `Emulation.setDeviceMetricsOverride` 不管用 —— 抖音用自己算的宽度做布局。
 *
 * @returns {Promise<boolean>} 是否真的改了
 */
/**
 * 撑窗口。
 *
 * 🔴 两个必须知道的事（2026-10-26 实测）：
 *
 *  ① **改窗口大小会把私信面板关掉**。抖音的私信是浮层，窗口一 resize
 *     就重排、浮层消失。所以「每次读私信都先撑窗口」= 每次都把面板关掉，
 *     然后报「面板没打开」—— 看起来像面板打不开，其实是自己关的。
 *
 *  ② **屏幕不够宽时撑也白撑**。这台机器屏幕 CSS 尺寸只有 1536×816
 *     （1920 物理 + 125% 缩放），`setWindowBounds` 设 1920 会被系统夹回 1536。
 *     而 1532 宽下抖音的会话项渲染成 0×0 —— 面板等于没开。
 *     ⇒ 先看 `screen.availWidth`，到不了 1800 就直接放弃，别去动窗口。
 *
 * 结论：只在「屏幕够宽 且 当前窗口明显偏小」时才撑，而且撑完要重新判一次状态。
 */
/**
 * 🔴 确保浏览器窗口**不是最小化的**。
 *
 * 踩过的坑（比「屏幕太窄」隐蔽得多）：
 *   窗口最小化时，页面**不渲染** —— React 的 onClick 收不到事件，
 *   于是「真实鼠标点 im-entry」点了跟没点一样，面板永远打不开。
 *   而各种检测（`display:none` 的祖先、`getBoundingClientRect` 全 0）都会显示
 *   「面板关着」，看起来像点不到，实际是**窗口根本没在渲染**。
 *
 *   判据：`Browser.getWindowBounds` 返回 `windowState: 'minimized'`。
 *   修法：`Browser.setWindowBounds` 把 windowState 置成 'normal'。
 *
 *   （顺带发现：窗口最小化时 `setWindowBounds` 改尺寸会被系统忽略，
 *     只有 state 能改 —— 置 normal 之后尺寸才生效。）
 *
 * 🔴 还有一种更气人的情况：**窗口被挪到屏幕外面**（left 是很大的负数）。
 *   这时窗口状态是 'normal'、进程活得好好的、CDP 也能操作，
 *   但人**根本看不见这个窗口** —— 用户会说「你拉出的浏览器我打不开」。
 *   成因：早期为了绕过屏幕宽度限制，试过 `setWindowBounds({ left: -2000 })`
 *   把窗口挪到屏幕左边外面（见 PITFALLS 第 22 条）。
 *   那个方案早就废弃了，但窗口位置是**持久化**的 —— 一旦被挪出去，
 *   之后每次复用同一个 user-data-dir 启动，窗口都还在外面。
 *   ⇒ 所以每次 ensurePanel 都要检查「窗口是不是在可视区域内」，不是就拉回来。
 */
/**
 * 🟢 后台模式（dsh-fish-soul 加的）：窗口停在屏幕外面，不弹出来打扰人。
 *
 *   用户原话：「刷抖音的时候能不能不要让浏览器从最小化弹出来，影响我正常用电脑」。
 *   最小化 = 不渲染（见下面 ensureWindowVisible 的注释），所以不能让它最小化；
 *   但屏幕外 + 启动参数里的 --disable-backgrounding-occluded-windows 三件套 = 照常渲染
 *   （browser.mjs 坑 4）。于是：
 *     · b.windowMode 返回 'background' 时，不再把窗口拉回屏幕，而是停到 PARK_LEFT；
 *     · 已经停好的不动（每次 ensurePanel 只多两次 CDP 调用）；
 *     · 被最小化 / 最大化了：先置 normal 再停出去（这一下会闪一次，没办法）。
 *   挪窗口用 SetWindowPos(SWP_NOACTIVATE)，不抢焦点。
 *   想看窗口：插件设置页「显示一下」（b.windowMode 临时返回 'visible'）。
 */
export const PARK_LEFT = -20000

function windowModeOf(b) {
  try { return typeof b.windowMode === 'function' ? b.windowMode() : (b.windowMode || 'visible') } catch { return 'visible' }
}

async function parkWindow(b) {
  const { windowId } = (await b.send('Browser.getWindowForTarget', { targetId: b.targetId })) || {}
  if (typeof windowId !== 'number') return false
  const bd = (await b.send('Browser.getWindowBounds', { windowId }))?.bounds || {}
  const state = bd.windowState || 'normal'
  if (state === 'normal' && Number(bd.left) <= PARK_LEFT + 100) return false
  if (state !== 'normal') {
    await b.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await sleep(state === 'minimized' ? 800 : 400)
  }
  const cur = state === 'normal' ? bd : ((await b.send('Browser.getWindowBounds', { windowId }))?.bounds || bd)
  await b.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: PARK_LEFT, top: 0, width: Number(cur.width) || 1400, height: Number(cur.height) || 1000 },
  })
  await sleep(300)
  return true
}

/** 把窗口挪回屏幕里给人看（设置页「显示一下」/ 换回「正常显示」）。 */
async function showWindow(b) {
  const { windowId } = (await b.send('Browser.getWindowForTarget', { targetId: b.targetId })) || {}
  if (typeof windowId !== 'number') return false
  const bd = (await b.send('Browser.getWindowBounds', { windowId }))?.bounds || {}
  if ((bd.windowState || 'normal') !== 'normal') {
    await b.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await sleep(600)
  }
  const vp = await b.eval(`({ sw: screen.availWidth, sh: screen.availHeight })`).catch(() => null)
  const sw = Number(vp?.sw || 0) || 1400
  const sh = Number(vp?.sh || 0) || 1000
  await b.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: 40, top: 40, width: Math.min(Number(bd.width) || 1400, sw), height: Math.min(Number(bd.height) || 1000, sh) },
  })
  try { await b.send('Page.bringToFront', {}, b.sessionId) } catch { /* 不要紧 */ }
  return true
}

async function ensureWindowVisible(b) {
  if (windowModeOf(b) === 'background') {
    try { return await parkWindow(b) } catch { return false }
  }
  let windowId = null
  try {
    ({ windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId }))
    const r = await b.send('Browser.getWindowBounds', { windowId })
    const bd = r?.bounds || {}

    // ① 最小化 ⇒ 恢复
    if (bd.windowState === 'minimized') {
      await b.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await sleep(1200)
      return true
    }

    // ② 窗口跑到屏幕外 ⇒ 拉回左上角
    //    判据：left/top 是负数，或者 left 超过了屏幕宽度（整块都在右边外面）。
    //    注意不能用「右下角越界」判 —— 窗口比屏幕大一点点是正常的。
    const vp = await b.eval(`({ sw: screen.availWidth, sh: screen.availHeight })`).catch(() => null)
    const sw = Number(vp?.sw || 0)
    const sh = Number(vp?.sh || 0)
    if (sw > 0) {
      const left = Number(bd.left ?? 0)
      const top = Number(bd.top ?? 0)
      const offscreen = left < -50 || top < -50 || left > sw - 200
      if (offscreen) {
        await b.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
        await sleep(600)
        await b.send('Browser.setWindowBounds', {
          windowId,
          bounds: {
            left: 0,
            top: 0,
            width: Math.min(Number(bd.width) || 1400, sw),
            height: Math.min(Number(bd.height) || 900, sh),
          },
        })
        await sleep(1000)
        return true
      }
    }
  } catch {
    /* 取不到就算了，不是致命问题 */
  }
  return false
}

async function growWindow(b, vp = null) {
  const cur = vp || await b.eval(`({ w: innerWidth, h: innerHeight, sw: screen.availWidth, sh: screen.availHeight })`).catch(() => null)
  if (!cur) return false
  // 1800 是私信面板（列表 324 + 聊天区 ~500 + 边距）能完整显示的临界宽度
  if (cur.w >= 1800 && cur.h >= 900) return false
  // 屏幕本身不够宽 —— 撑不上去，别动窗口（动了反而把面板关掉）
  if (Number(cur.sw || 0) < 1800) return false

  try {
    const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId })
    await b.send('Browser.setWindowBounds', {
      windowId,
      // 留 40px 给任务栏/标题栏，避免被系统夹回去
      bounds: { width: Math.min(1920, cur.sw), height: Math.min(1040, cur.sh), windowState: 'normal' },
    })
    await sleep(2500)
    const after = await b.eval(`({ w: innerWidth, h: innerHeight })`).catch(() => null)
    // 有些屏 / 缩放比例下系统会夹回去，把实际值记下来方便排障
    if (after) b._lastViewport = after
    return true
  } catch {
    return false
  }
}

async function ensurePanel(b) {
  // ⓪ 🔴 窗口不能是最小化的 —— 最小化时页面不渲染，事件不生效，
  //    面板怎么点都开不了（详见 ensureWindowVisible 的注释）。
  await ensureWindowVisible(b)

  // ⓪.5 🔴 **面板已经开着就直接返回**。
  //    「消息」是 toggle：开着的状态下再点一次会**关掉**。
  //    实测踩过：ensurePanel 自己刚把面板点开，上层（ensureTargetChat）
  //    又调了一次 ensurePanel，第二次点击把它关掉，于是 sendImage 报
  //    「面板没打开」—— 明明两秒前面板还是开的。
  const preOpen = await b.eval(`(() => {
    const dlg = document.querySelector('[data-e2e="im-dialog"]')
    if (dlg) {
      let n = dlg
      for (let i = 0; i < 8 && n; i++) {
        if (getComputedStyle(n).display === 'none') break
        n = n.parentElement
        if (!n) return { open: true }
      }
    }
    const convs = [...document.querySelectorAll('[data-e2e="conversation-item"], [class*="conversationItem"]')]
      .filter((el) => el.getBoundingClientRect().width > 100)
    return { open: convs.length > 0, convs: convs.length }
  })()`).catch(() => ({ open: false }))
  if (preOpen?.open) {
    return {
      inChat: false,
      panelOpen: true,
      convCount: Number(preOpen.convs || 0),
      hasMsgBtn: true,
      msgAt: null,
      vw: 0, vh: 0,
      panelRect: null,
      via: 'already-open',
    }
  }

  // ① 先确保在能私信的页面（首页 / 搜索页 / 个人页都能，视频页不行）
  //
  // 🔴 一定要拦住 `about:blank` / `chrome://newtab` 这类**根本不是抖音**的页面。
  //    实测踩过：某次 goto 失败把标签页留在 about:blank，
  //    之后所有选择器都探测不到，表现成「面板打不开 / 找不到会话」，
  //    但报错信息完全不提页面是空的 —— 极难查。
  const where = await b.eval(`location.href`).catch(() => '')
  const onDouyin = /^https?:\/\/[^/]*douyin\.com(\/|$)/.test(String(where))
  if (!onDouyin) {
    await b.goto('https://www.douyin.com/jingxuan', { settleMs: 9000 })
    // 导航完再确认一次，还是不对就明确报错，别让上层瞎猜
    const after = await b.eval(`location.href`).catch(() => '')
    if (!/^https?:\/\/[^/]*douyin\.com(\/|$)/.test(String(after))) {
      return {
        inChat: false,
        panelOpen: false,
        convCount: 0,
        hasMsgBtn: false,
        vw: 0,
        vh: 0,
        error: `导航到抖音失败，当前页面是 ${after || '(读不到)'}`,
      }
    }
  }

  // 视频页不能私信，要回首页
  const canDM = /douyin\.com\/(jingxuan|$|\?|search|user)/.test(where) || where.endsWith('douyin.com/')
  if (onDouyin && !canDM) {
    await b.goto('https://www.douyin.com/', { settleMs: 8000 })
  }

  // ② 🔴 关键：窗口够大
  //    实测：宽 1378 时私信面板落在 x=1378（**完全在视口外**），点不到。
  //    ⚠️ 但**改窗口大小会把已经打开的面板关掉**，屏幕不够宽时也撑不上去 ——
  //       所以这里只在「屏幕够宽 + 还没进会话」时才撑，别每次读都动它。
  //       细节见 growWindow 的注释。
  const vp = await b.eval(`({ w: innerWidth, h: innerHeight, sw: screen.availWidth, sh: screen.availHeight })`).catch(() => null)
  if (vp && (vp.w < 1800 || vp.h < 900) && Number(vp.sw || 0) >= 1800) {
    await growWindow(b, vp).catch(() => {})
  }

  // ③ 检查当前状态
  //
  // 🔴 判定面板开没开，**只看会话项有没有尺寸**（`ConversationItemwrapper` 的 rect）。
  //    以前用的是「宽度 250~600 且 innerText 含『消息』的 div」——那个条件经常假阴性：
  //    面板明明开着，会话项已经 324×67 了，但它匹配不上，于是代码以为没开，
  //    又去点一次「消息」⇒ toggle 把它关掉，永远打不开。
  const st = await b.eval(`(() => {
    const FIND = ${pageFindHelper()}
    const ta = document.querySelector('textarea')
    const ce = FIND.chatInput().filter((x) => x.getBoundingClientRect().width > 100)
    const inChat = Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)

    // 会话项 = 面板是否真的渲染出来了（有尺寸才算）
    const convs = FIND.conversationItem()
    const shown = convs.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 100 && r.height > 20
    })
    const pr = shown.length ? shown[0].getBoundingClientRect() : null

    // 「消息」入口：优先用 data-e2e="im-entry"（抖音自己的测试锚点，最稳），
    // 拿不到再退回「innerText 恰好是『消息』的叶子元素」
    let entry = null
    for (const sel of ['[data-e2e="im-entry"]', '[data-e2e="msg-entry"]']) {
      const el = document.querySelector(sel)
      if (el && el.getBoundingClientRect().width > 0) { entry = el; break }
    }
    if (!entry) {
      entry = [...document.querySelectorAll('*')].find(
        (el) => (el.innerText || '').trim() === '消息'
          && el.children.length === 0
          && el.getBoundingClientRect().width > 0,
      )
    }
    const mr = entry ? entry.getBoundingClientRect() : null

    return {
      inChat,
      panelOpen: shown.length > 0,
      convCount: shown.length,
      hasMsgBtn: Boolean(entry),
      msgVia: entry ? (entry.getAttribute('data-e2e') ? 'data-e2e' : 'text') : '',
      msgAt: mr ? { x: Math.round(mr.left + mr.width / 2), y: Math.round(mr.top + mr.height / 2) } : null,
      vw: innerWidth,
      vh: innerHeight,
      panelRect: pr ? { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height), right: Math.round(pr.right) } : null,
    }
  })()`)

  if (st.inChat) return st

  // 🔴 只要面板开着就认 —— **不管在不在视口内**。
  //    因为 dispatchEvent 不需要坐标在视口内。
  //    ⚠️ 而且「消息」是 toggle：面板开着时再点会**关掉**。
  if (st.panelOpen) return st

  // ⑤ 面板没开：点「消息」的**叶子**元素（P / DIV 都行，只要能匹配到）
  if (!st.hasMsgBtn) {
    return { ...st, error: '当前页面没有「消息」按钮' }
  }

  // 轻量版状态读取：只判断「面板开没开 / 在不在聊天里」。
  // 和下面完整的 READ_JS 分开，是因为这里要**快速**判断 JS click 有没有生效，
  // 不想每次都跑一遍 pageFindHelper()（那个开销不小）。
  const READ_JS_LITE = `(() => {
    const dlg = document.querySelector('[data-e2e="im-dialog"]')
    let dlgOpen = false
    if (dlg) {
      dlgOpen = true
      let n = dlg
      for (let i = 0; i < 8 && n; i++) {
        if (getComputedStyle(n).display === 'none') { dlgOpen = false; break }
        n = n.parentElement
      }
    }
    const convs = [...document.querySelectorAll('[data-e2e="conversation-item"], [class*="conversationItem"]')]
      .filter((el) => el.getBoundingClientRect().width > 100)
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter((x) => x.getBoundingClientRect().width > 100)
    const inChat = Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
    return {
      inChat,
      panelOpen: dlgOpen || convs.length > 0,
      convCount: convs.length,
      hasMsgBtn: Boolean(document.querySelector('[data-e2e="im-entry"]')),
      msgAt: null,
      vw: innerWidth, vh: innerHeight,
      panelRect: null,
      ...(dlgOpen || convs.length ? {} : { error: '面板没打开' }),
    }
  })()`

  // 🔴 先试 **JS click**，再退回真实鼠标 —— 顺序很反直觉，但这是实测结果：
  //    在精选页（/jingxuan）上，`[data-e2e="im-entry"]` 的真实鼠标点击
  //    **点了没反应**（`elementFromPoint` 确认命中、坐标也对、窗口 normal），
  //    而 JS 的 `el.click()` 一次就开。
  //
  //    这和视频页/私信页的经验相反（那边真实鼠标更稳），所以两边都留着，
  //    只是把 JS 提到前面：它快（不用等 3 秒），失败也就失败一次。
  //
  //    ⚠️ 只点 `im-entry` 本身不够 —— 事件绑在里面的 `<i>` 上，
  //       所以要同时点内层叶子和外层容器。
  // ⚠️ 先等 `im-entry` 出现 —— 页面刚 goto 完时 DOM 还没渲染出这个入口，
  //    直接查会拿到 null，看起来像「没有消息按钮」。
  for (let i = 0; i < 12; i++) {
    const ready = await b.eval(`Boolean(document.querySelector('[data-e2e="im-entry"]'))`).catch(() => false)
    if (ready) break
    await sleep(600)
  }

  const jsOpened = await b.eval(`(() => {
    const el = document.querySelector('[data-e2e="im-entry"]') || document.querySelector('[data-e2e="msg-entry"]')
    if (!el) return false
    const leaf = el.querySelector('i') || el.querySelector('svg') || el
    try { leaf.click() } catch (e) { /* 继续 */ }
    try { el.click() } catch (e) { /* 继续 */ }
    return true
  })()`).catch(() => false)

  if (jsOpened) {
    // 面板动画 + 会话列表加载要时间，2.5s 常常不够
    for (let i = 0; i < 8; i++) {
      await sleep(700)
      const quick = await b.eval(READ_JS_LITE)
      if (quick.inChat || quick.panelOpen) return quick
    }
  }

  // 真实鼠标（JS click 没开时再试）
  let clicked = false
  if (st.msgAt) {
    try {
      await b.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: st.msgAt.x, y: st.msgAt.y, button: 'left', clickCount: 1,
      }, b.sessionId)
      await b.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: st.msgAt.x, y: st.msgAt.y, button: 'left', clickCount: 1,
      }, b.sessionId)
      clicked = true
    } catch { /* 退回 dispatchEvent */ }
  }
  if (!clicked) {
    await b.eval(`(() => {
      const el = [...document.querySelectorAll('*')].find(
        (x) => (x.innerText || '').trim() === '消息'
          && x.children.length === 0
          && x.getBoundingClientRect().width > 0,
      )
      if (!el) return false
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return true
    })()`)
  }
  await sleep(3000)

  // ⑥ 用同一套判定再读一次
  const READ_JS = `(() => {
    const FIND = ${pageFindHelper()}
    const convs = FIND.conversationItem()
    const shown = convs.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 100 && r.height > 20
    })
    const ta = document.querySelector('textarea')
    const ce = FIND.chatInput().filter((x) => x.getBoundingClientRect().width > 100)
    const pr = shown.length ? shown[0].getBoundingClientRect() : null
    // 「消息」入口：优先 data-e2e，再退回文字
    let entry = document.querySelector('[data-e2e="im-entry"]') || document.querySelector('[data-e2e="msg-entry"]')
    if (!entry) {
      entry = [...document.querySelectorAll('*')].find(
        (el) => (el.innerText || '').trim() === '消息'
          && el.children.length === 0
          && el.getBoundingClientRect().width > 0,
      )
    }
    const mr = entry ? entry.getBoundingClientRect() : null
    return {
      inChat: Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length),
      panelOpen: shown.length > 0,
      convCount: shown.length,
      hasMsgBtn: Boolean(entry),
      msgAt: mr ? { x: Math.round(mr.left + mr.width / 2), y: Math.round(mr.top + mr.height / 2) } : null,
      vw: innerWidth, vh: innerHeight,
      panelRect: pr ? { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height), right: Math.round(pr.right) } : null,
      ...(shown.length ? {} : { error: '面板没打开' }),
    }
  })()`

  let after = await b.eval(READ_JS)
  if (after.inChat || after.panelOpen) return after

  // ⑦ 🔴 兜底：真实鼠标点过还是没开 —— 说明点击落在了**没绑事件的容器**上。
  //    优先用 data-e2e="im-entry"（抖音自己的测试锚点），
  //    拿不到再退回「innerText 恰好是『消息』的叶子」逐层往上 dispatchEvent。
  const OPEN_JS = `(() => {
    // ① data-e2e 锚点：直接点它 + 往上两层（事件可能绑在父级）
    const entry = document.querySelector('[data-e2e="im-entry"]') || document.querySelector('[data-e2e="msg-entry"]')
    if (entry) {
      const o = { bubbles: true, cancelable: true, view: window }
      const chain = [entry, entry.parentElement, entry.parentElement?.parentElement].filter(Boolean)
      for (const el of chain) {
        try { el.dispatchEvent(new PointerEvent('pointerdown', o)) } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', o)) } catch (e) {}
        try { el.dispatchEvent(new PointerEvent('pointerup', o)) } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', o)) } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('click', o)) } catch (e) {}
        try { el.click() } catch (e) {}
      }
      return 'e2e'
    }

    // ② 退回文字匹配 + 逐层点
    let leaf = null
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() !== '消息') continue
      if (el.children.length !== 0) continue
      if (el.getBoundingClientRect().width === 0) continue
      leaf = el; break
    }
    if (!leaf) return ''
    const chain = []
    let node = leaf
    for (let i = 0; i < 6 && node && node !== document.body; i++) { chain.push(node); node = node.parentElement }
    const o = { bubbles: true, cancelable: true, view: window }
    for (const el of chain) {
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', o)) } catch (e) {}
      try { el.dispatchEvent(new PointerEvent('pointerup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click', o)) } catch (e) {}
    }
    return 'text'
  })()`

  const OPENED_JS = `(() => {
    const FIND = ${pageFindHelper()}
    return FIND.conversationItem()
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 20 }).length
  })()`

  for (let attempt = 0; attempt < 3; attempt++) {
    await b.eval(OPEN_JS)
    await sleep(2200)
    if (await b.eval(OPENED_JS) > 0) {
      after = await b.eval(READ_JS)
      return after
    }
    // 可能点开了又被点关（toggle）—— 再读一次状态再决定
    await sleep(800)
  }

  // ⑧ 最后再兜一次：窗口不够高时面板渲染不出来
  const grew = await growWindow(b, { w: after.vw, h: after.vh }).catch(() => false)
  if (grew) {
    await sleep(1500)
    await b.eval(OPEN_JS)
    await sleep(3000)
    after = await b.eval(READ_JS)
  }

  return after
}

/**
 * 进聊天界面。
 *
 * ⭐ 用语义化 class 定位（比坐标可靠）：
 *    `conversationConversationItemwrapper`  = 一个会话项（324×67）
 *       ├ `conversationConversationItemrowArea1`  头像区
 *       ├ `conversationConversationItemtitle`     好友名
 *       ├ `ConversationItemTagNextToTitlewrapper` 时间
 *       └ `ConversationItemDescwrapper`           消息预览
 *
 * 🔴 踩过的坑：
 *   1. 点外层容器 / 叶子都可能没反应 ⇒ **要试多层**
 *   2. 面板在窄窗口下会 `translateX(100%)` 滑出视口
 *      ⇒ dispatchEvent 可以，Input 不行
 *   3. 之前"找第一个含时间的元素"会命中嵌套内层，导致进错会话
 */
async function enterChat(b, uname = '') {
  // 🔴 先把面板打开 —— 下面的兜底逻辑要 `[data-e2e="im-dialog"]` 作为 scope，
  //    面板关着的时候 scope 是 null，会一路走到 'no conversation items'。
  //    （ensurePanel 内部已经处理「已经开着就直接返回」，重复调是安全的）
  await ensurePanel(b).catch(() => {})

  const result = await b.eval(`(() => {
    const FIND = ${pageFindHelper()}
    // ⭐ 会话项（走降级链）
    let items = FIND.conversationItem()
    if (!items.length) {
      // 🔴 兜底：限定在**私信面板内部**，并且排除视频卡片。
      //
      //    这里和 dmList 里那份兜底是同一个坑（我踩了两次）：
      //    在整页按「尺寸 250~450 × 50~120 + 含『分钟前/小时前』」找，
      //    会把**信息流里的视频卡片**当成会话项 —— 视频卡片也是这个尺寸，
      //    也带「· 21小时前」。于是报错信息里「现有：」列出一堆视频标题，
      //    看起来像「找不到好友」，实际是根本没读到会话列表。
      const scope = document.querySelector('[data-e2e="im-dialog"]')
        || document.querySelector('[class*="conversationConversationList"]')
        || document.querySelector('[class*="conversationList"]')
      if (scope) {
        const KW = ['分钟前', '小时前', '昨天', '刚刚']
        const looksLikeVideoCard = (el) => {
          const t = (el.innerText || '')
          if (/@[^\s·]{1,20}\s*·/.test(t)) return true
          if (/#[^\s#]{1,20}/.test(t)) return true
          return false
        }
        items = [...scope.querySelectorAll('div')].filter((el) => {
          const r = el.getBoundingClientRect()
          if (r.width < 250 || r.width > 450) return false
          if (r.height < 50 || r.height > 120) return false
          const t = el.innerText || ''
          if (!KW.some(k => t.indexOf(k) >= 0)) return false
          if (looksLikeVideoCard(el)) return false
          return true
        })
      }
    }
    if (!items.length) return { err: 'no conversation items' }

    // 解析每个会话项
    //
    // 🔴 必须过滤掉 0×0 的**隐藏副本**：抖音的 DOM 里同时存在
    //    已经渲染的会话项和一个尺寸为 0 的旧副本。不过滤的话，
    //    排序后第一个可能是隐藏的那个 —— 点它什么都不会发生，
    //    而且它读出来的名字/时间也可能是过期的。
    const rows = items.map((el) => {
      const r = el.getBoundingClientRect()
      const t = (el.innerText || '').trim()
      const nameEl = FIND.one(el, 'conversationTitle')
      const timeEl = FIND.one(el, 'conversationTime')
      const descEl = FIND.one(el, 'conversationDesc')
      // 🔴 名字兜底要**筛**：取 innerText 第一行可能在拿 ID / 时间 / 未读数。
      //    实测踩过：报错里「现有：103489541842」—— 那是某个元素的
      //    innerText，被当成好友名了，于是按名字找人永远失配。
      const firstLine = (t.split(String.fromCharCode(10)) || [])
        .map((s) => s.trim())
        .find((s) => {
          if (!s) return false
          if (/^\d+$/.test(s)) return false                        // 纯数字（ID / 未读数）
          if (/^\d{1,2}:\d{2}$/.test(s)) return false              // 时间
          if (/^(昨天|刚刚|\d+分钟前|\d+小时前|\d+月\d+日)$/.test(s)) return false
          return true
        }) || ''
      return {
        el,
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        name: (nameEl?.innerText || '').trim() || firstLine,
        time: (timeEl?.innerText || '').trim(),
        preview: (descEl?.innerText || '').trim().split(String.fromCharCode(10)).join(' '),
      }
    }).filter((x) => x.name && x.w > 100 && x.h > 20)

    if (!rows.length) return { err: 'no named rows' }
    rows.sort((a, b) => a.y - b.y)

    const want = ${JSON.stringify(String(uname || ''))}
    let target = rows[0]
    if (want) {
      const hit = rows.find(r => r.name.includes(want))
      if (!hit) return { err: 'not found', available: rows.map(r => r.name) }
      target = hit
    }

    // 🔴 多层点击（某些层级的事件是分开绑的）
    const fire = (el) => {
      if (!el) return
      const o = { bubbles: true, cancelable: true, view: window }
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', o)) } catch (e) {}
      try { el.dispatchEvent(new PointerEvent('pointerup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click', o)) } catch (e) {}
      try { el.click() } catch (e) {}
    }

    // 点 wrapper、它的父级、它的内容区
    fire(target.el)
    fire(target.el.parentElement)
    fire(target.el.querySelector('[class*="rowArea2"]'))
    fire(FIND.one(target.el, 'conversationDesc'))

    return { ok: true, name: target.name, total: rows.length, all: rows.map(r => r.name) }
  })()`)

  if (result.err) {
    if (result.err === 'not found') {
      throw new Error(`找不到会话「${uname}」，现有：${(result.available || []).join(', ')}`)
    }
    return false
  }

  await sleep(3000)
  if (await hasInput(b)) return true

  // 再点一次（第二下常有效）
  await b.eval(`(() => {
    const WANT = ${JSON.stringify(String(uname || ''))}
    let items = [...document.querySelectorAll('[class*="ConversationItemwrapper"]')]
    if (!items.length) return false
    const rows = items.map((el) => {
      const r = el.getBoundingClientRect()
      const nameEl = el.querySelector('[class*="ConversationItemtitle"]')
      return { el, y: Math.round(r.top), name: (nameEl?.innerText || '').trim() }
    }).filter(x => x.name).sort((a, b) => a.y - b.y)
    if (!rows.length) return false
    let t = rows[0]
    if (WANT) t = rows.find(r => r.name.includes(WANT)) || rows[0]
    t.el.click()
    return true
  })()`)
  await sleep(3000)

  return hasInput(b)
}


/** 聊天输入框出现了吗 */
async function hasInput(b) {
  return b.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter(x => x.getBoundingClientRect().width > 100)
    return Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
  })()`)
}

export { closePanel, ensureWindowVisible, parkWindow, showWindow, growWindow, ensurePanel, enterChat, hasInput }
