/**
 * douyin-dm.mjs —— 私信：读（接口 + DOM 合并）/ 发文字 / 发图 / 发表情 / 登录态 / 会话列表
 * 拆自 dsh-douyin-bridge lib/douyin.mjs（MIT，commit 6e4bb7f），改动见同目录 README.md。
 */
import { existsSync } from 'node:fs'
import { SEL, pageFindHelper } from './selectors.mjs'
import {
  pageMediaHelper,
  describeMedia,
  mediaFingerprintPart,
  mergeMessages,
  dedupeNestedMessages,
  rememberEmojiNames,
  lookupEmojiName,
  MEDIA,
} from './media.mjs'
import {
  installHook as apiInstallHook,
  hookReady as apiHookReady,
  drain as apiDrain,
  pickMessages as apiPickMessages,
  selfInfo as apiSelfInfo,
  triggerFetch as apiTriggerFetch,
  cacheMessages as apiCacheMessages,
  cachedMessages as apiCachedMessages,
  clearCache as apiClearCache,
} from './douyin-api.mjs'
import { sleep } from './douyin-util.mjs'
import { ensurePanel, enterChat, hasInput } from './douyin-panel.mjs'

/**
 * 走接口读私信（**不依赖 DOM 结构**）。
 *
 * 原理：抖音自己请求 `imapi.douyin.com/v1/message/get_by_conversation` 拿消息，
 * 我们 hook 住 fetch/XHR 把响应截下来，再用 `lib/pb.mjs` 解 protobuf。
 *
 * 为什么比 DOM 稳：
 *   · 字段号是接口契约，抖音改版很少动；DOM 的 hash class 每次发版都可能变
 *   · 不受窗口尺寸影响（DOM 那套要求视口 ≥1800 宽，否则输入框跑出视口）
 *   · 消息顺序、发送者、时间戳都是结构化数据，不用从 innerText 里猜
 *
 * 代价：得先「触发」一次请求 —— 所以还是要调 `enterChat` 进会话。
 *       但那只用来**触发**，读数据完全不看 DOM。
 */
export async function readDMViaApi({ browser, uname = '', limit = 30, scrollBack = 0 }) {
  // ① hook 必须在位（首次或页面 reload 后会自动补上）
  if (!(await apiHookReady(browser))) {
    await apiInstallHook(browser)
    if (!(await apiHookReady(browser))) {
      return { ok: false, error: 'hook 装不上' }
    }
  }

  const hasPb = (list) => (list || []).some(
    (c) => c.kind === 'pb' && /get_by_conversation|get_user_message|message\/list/i.test(String(c.url)),
  )
  const cacheKey = uname || '*'

  // ② 先看 hook 里有没有**新抓到**的响应（轮询期间抖音会推新消息，偶尔会有）
  let captured = await apiDrain(browser)
  let parsed = null

  if (hasPb(captured)) {
    const me = await apiSelfInfo(browser).catch(() => ({ secUid: '' }))
    parsed = apiPickMessages(captured, { selfSecUid: me.secUid })
    const useful = filterUseful(parsed.messages)
    if (useful.length) apiCacheMessages(cacheKey, useful, { source: parsed.source })
  }

  // ③ 没抓到新的 → 用缓存。**这是常态**，因为抖音只在首次进会话时请求。
  if (!parsed?.messages?.length) {
    const cached = apiCachedMessages(cacheKey)
    if (cached?.messages?.length) {
      return shapeResult(cached.messages, limit, 'cache')
    }
  }

  // ④ 从没抓到过 → 进会话触发一次（会话没打开时抖音一定会请求）
  if (!parsed?.messages?.length) {
    // ⚡ 快路径：如果当前**已经在这个会话里**，就不用再 ensurePanel/enterChat ——
    //    那两步各要 2~3 秒的固定等待，轮询时白花。
    const already = await browser.eval(`(() => {
      const ta = document.querySelector('textarea')
      const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter((x) => x.getBoundingClientRect().width > 100)
      return Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
    })()`).catch(() => false)

    if (!already) {
      const st = await ensurePanel(browser)
      if (!st.panelOpen && !st.inChat) {
        return { ok: false, error: st.error || '打不开私信面板（无法触发接口）' }
      }
      if (!st.inChat || uname) {
        const entered = await enterChat(browser, uname)
        if (!entered) return { ok: false, error: '进不去会话（无法触发接口）' }
      }
    } else if (uname) {
      // 已经在某个会话里，但不是目标好友 —— 切过去。切会话会触发新请求。
      await enterChat(browser, uname).catch(() => {})
    }

    for (let i = 0; i < Math.min(scrollBack, 5); i++) {
      await browser.eval(`(() => {
        let best = null
        for (const el of document.querySelectorAll('div')) {
          const s = getComputedStyle(el)
          if (!/auto|scroll/.test(s.overflowY)) continue
          if (el.scrollHeight <= el.clientHeight + 20) continue
          if (!best || el.scrollHeight > best.scrollHeight) best = el
        }
        if (best) best.scrollTop = Math.max(0, best.scrollTop - best.clientHeight * 2)
        return Boolean(best)
      })()`).catch(() => {})
      await sleep(1000)
    }
    await sleep(2000)
    captured = await apiDrain(browser)

    if (hasPb(captured)) {
      const me = await apiSelfInfo(browser).catch(() => ({ secUid: '' }))
      parsed = apiPickMessages(captured, { selfSecUid: me.secUid })
      const useful = filterUseful(parsed.messages)
    if (useful.length) apiCacheMessages(cacheKey, useful, { source: parsed.source })
    }
  }

  // ⑤ 还是没有 → reload 清缓存（**只在从没成功过时**做，慢但确定有效）
  if (!parsed?.messages?.length) {
    apiClearCache()
    await apiTriggerFetch(browser).catch(() => {})
    const st2 = await ensurePanel(browser)
    if (st2.panelOpen || st2.inChat) {
      await enterChat(browser, uname)
      await sleep(3500)
    }
    captured = await apiDrain(browser)
    if (hasPb(captured)) {
      const me = await apiSelfInfo(browser).catch(() => ({ secUid: '' }))
      parsed = apiPickMessages(captured, { selfSecUid: me.secUid })
      const useful = filterUseful(parsed.messages)
    if (useful.length) apiCacheMessages(cacheKey, useful, { source: parsed.source })
    }
  }

  if (!parsed?.messages?.length) {
    return { ok: false, error: parsed?.error || '接口里没解出消息' }
  }

  return shapeResult(parsed.messages, limit, 'api')
}

/** 把接口解出来的消息整理成和 DOM 路径一致的形状 */
function shapeResult(rawMessages, limit, via) {
  const msgs = filterUseful(rawMessages).map((m) => ({
    fromMe: m.fromMe === true,
    system: m.isSystem && !m.text,
    unsupported: false,
    isShare: Boolean(m.shareAweme) || m.kind === 8,
    // fish-soul：带上分享视频的 id（聊天里分享的视频要先看再回）
    shareAweme: m.shareAweme ? String(m.shareAweme) : '',
    text: m.text || m.tips || '',
    seq: m.seq,
    time: m.time,
    kind: m.kind,
  }))
  return {
    ok: true,
    messages: msgs.slice(-limit),
    total: msgs.length,
    inChat: true,
    via,
  }
}

/**
 * 只留下「有内容」的消息。
 *
 * ⚠️ 缓存也要用这个过滤 —— 否则缓存里塞一堆 kind=8 的空壳，
 *    `shapeResult` 过滤完就空了，表现为「缓存命中了但 0 条」。
 */
function filterUseful(rawMessages) {
  return (rawMessages || []).filter((m) => m.text || m.tips || m.shareAweme)
}


/**
 * 读私信（进聊天界面，读 DOM）。
 * @param {object} p { browser, limit }
 */
/**
 * 读私信消息（带发送者标记）。
 *
 * ⭐ 判断"谁发的"用 class **`isFromMe`**（探针实测）：
 *    每条消息的外层容器是 `messageMessageBoxmessageBox`，
 *    内层 `messageMessageBoxcontentBox` 上如果是自己发的就带 `isFromMe`。
 *
 * ⚠️ **抖音是虚拟列表**：默认只渲染最近的一屏。想读更多历史必须往上滚。
 *    `scrollBack` 控制往上滚几次（每次约加载 20 条）。滚完再读。
 *
 * ⚠️ 分享卡片是 `MessageItemShareAwemecontainer`，文本只有作者名，没有正文。
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {number} p.limit       最多返回多少条（默认 30）
 * @param {string} p.uname       指定会话（按好友名），空=最新的
 * @param {number} p.scrollBack  往上滚几次来加载历史（默认 0，不滚）
 */
export async function readDM({ browser, limit = 30, uname = '', scrollBack = 0 }) {
  // ── ① 先走接口（稳）──────────────────────────────────────────────
  //
  // 🔴 这是首选路径：读抖音自己的 `imapi.douyin.com/v1/message/get_by_conversation`
  //    响应，解 protobuf。**完全不依赖 DOM** —— 页面改版、窗口变窄都不影响。
  //
  //    流程：确保 hook 在位 → 进会话（触发请求）→ 从 hook 里取响应 → 解码。
  //    触发还是要进会话（DOM 操作），但**只用来触发**，读数据不靠它。
  const viaApi = await readDMViaApi({ browser, uname, limit, scrollBack }).catch((e) => ({
    ok: false,
    error: `接口路径出错：${e?.message || e}`,
  }))

  // ── ② DOM 路（认媒体）───────────────────────────────────────────
  //
  // 🔴 **接口路只认文本消息**（kind=7）。图片 / 表情 / 语音这些，
  //    在 protobuf 里是别的 kind，接口路一个都不给。
  //    ⇒ DOM 路必须**每次都跑**，否则对方发张图，AI 永远收不到。
  //    两条路的结果最后合并（见 `mergeMessages`）。
  const viaDom = await readDMDom({ browser, limit, uname, scrollBack }).catch((e) => ({
    ok: false,
    error: `DOM 路径出错：${e?.message || e}`,
  }))

  // 两条路都失败
  if (!viaApi.ok && !viaDom.ok) {
    return {
      ok: false,
      error: `接口路：${viaApi.error || '未知'} ｜ DOM 路：${viaDom.error || '未知'}`,
      debug: viaDom.debug,
    }
  }

  // 只有一条路成功
  if (viaApi.ok && !viaDom.ok) return viaApi
  if (!viaApi.ok && viaDom.ok) return viaDom

  // 两条路都成功 → 合并
  //
  // 以接口路为底（有准确时间戳、有历史），把 DOM 里多出来的**媒体消息**插进去。
  const merged = mergeMessages(viaApi.messages, viaDom.messages)
  return {
    ok: true,
    messages: merged.slice(-limit),
    total: merged.length,
    inChat: true,
    via: `${viaApi.via}+dom`,
  }
}

/**
 * DOM 路：进聊天界面读消息（**认媒体**）。
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {number} p.limit       最多返回多少条（默认 30）
 * @param {string} p.uname       指定会话（按好友名），空=最新的
 * @param {number} p.scrollBack  往上滚几次来加载历史（默认 0，不滚）
 */
async function readDMDom({ browser, limit = 30, uname = '', scrollBack = 0 }) {
  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) {
    return {
      ok: false,
      error: st.error || '打不开私信面板',
      debug: { vw: st.vw, vh: st.vh, hasMsgBtn: st.hasMsgBtn, panelRect: st.panelRect },
    }
  }

  // 指定了好友，或者还没进聊天 → 进会话
  if (!st.inChat || uname) {
    let entered = false
    try {
      entered = await enterChat(browser, uname)
    } catch (e) {
      return { ok: false, error: e.message, debug: st }
    }
    if (!entered) {
      return { ok: false, error: '进不去具体会话（点了但没出现输入框）', debug: st }
    }
  }

  // 往上滚加载历史
  if (scrollBack > 0) {
    for (let i = 0; i < scrollBack; i++) {
      const before = await browser.eval(`(() => {
        const FIND = ${pageFindHelper()}
        return FIND.messageBox().length
      })()`)
      await browser.eval(`(() => {
        // 找最大的可滚动容器（消息列表）
        let best = null
        let bestArea = 0
        for (const el of document.querySelectorAll('div')) {
          if (el.scrollHeight <= el.clientHeight + 20) continue
          const r = el.getBoundingClientRect()
          if (r.width < 200 || r.height < 150) continue
          const area = r.width * r.height
          if (area > bestArea) { bestArea = area; best = el }
        }
        if (best) {
          best.scrollTop = 0
          return { ok: true, h: best.clientHeight, sh: best.scrollHeight }
        }
        return { ok: false }
      })()`)
      await sleep(1500)
      const after = await browser.eval(`(() => {
        const FIND = ${pageFindHelper()}
        return FIND.messageBox().length
      })()`)
      if (after <= before) break   // 没加载出新东西，停
    }
  }

  // ⚠️ 页面里跑的 JS，用 String.raw 写（\n / \d 要原样进浏览器）
  const MSGS_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()}
    ${pageMediaHelper()}

    // 找所有消息外层容器（走降级链）
    const all = FIND.messageBox()
    const sized = all.filter((el) => {
      const cls = (el.className || '').toString()
      // 过滤掉同一批匹配里的内层节点 —— 只要「外层容器」
      if (cls.includes('selectableRow')) return false
      if (cls.includes('contentBox')) return false
      const r = el.getBoundingClientRect()
      return r.width > 100 && r.height > 20
    })
    // 被另一个消息容器包住的是同一条消息的内层节点，丢掉（按 DOM 结构去重，不按正文）
    const boxes = sized.filter((el) => !sized.some((o) => o !== el && o.contains(el)))

    // 时间和已读状态不算正文
    const isMeta = (s) => /^(\d+秒前|\d+分钟前|\d+小时前|\d+天前|刚刚|昨天|前天|\d{1,2}月\d{1,2}日)$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || s === '已读' || s === '未读'

    const out = []
    for (const box of boxes) {
      const r = box.getBoundingClientRect()

      // ⭐ 先认类型（2026-10 修正）
      //
      // 🔴 以前这里是 "const t = (box.innerText||'').trim(); if (!t) continue" ——
      //    **图片 / 表情 / 语音气泡的 innerText 是空的**，
      //    于是它们全被这行丢掉 ⇒ 对方发张图，AI 永远收不到。
      //    现在改成先认类型、再按类型取信息。
      const type = typeOf(box)

      // ⭐ 判断发送者 / 分享卡片（都走降级链）
      const fromMe = Boolean(FIND.one(box, 'fromMe'))
      const isShare = Boolean(FIND.one(box, 'shareCard'))

      // 清理文本：去掉零宽字符、时间和已读标记
      const t = (box.innerText || '').trim()
      const lines = t.split(String.fromCharCode(10))
        .map((s) => s.replace(/\u200b/g, '').trim())
        .filter(Boolean)
        .filter((s) => !isMeta(s))

      const text = lines.join(' ').trim()

      // ── 媒体信息（图片 / 表情 / 语音 / 视频 / 位置）──────────────
      const media = {}
      if (type === 'image') {
        const src = imgOf(box, 'image')
        media.src = src
        const dim = sizeOf(box)
        media.width = dim.w
        media.height = dim.h
        // 抖音把私信图片转成 base64 内嵌（batch_build_image 干的），
        // 所以 DOM 里拿到的就是图片本体，不用再去 CDN 拉。
        // 太大就别往回传（几十万字符走 CDP 太慢），只留描述。
        if (src && src.indexOf('data:') === 0 && src.length < 1500000) media.data = src
      } else if (type === 'emoji') {
        const img = findByCls(box, 'MessageItemEmojiemojiBox')
          ? findByCls(box, 'MessageItemEmojiemojiBox').querySelector('img')
          : null
        media.src = img ? (img.getAttribute('src') || '') : ''
        media.name = textOf(box, 'MessageItemEmojiname')
          || (img ? (img.getAttribute('alt') || img.getAttribute('title') || '') : '')
      } else if (type === 'voice') {
        media.seconds = voiceSeconds(box)
      } else if (type === 'location') {
        media.name = textOf(box, 'MessageItemLocationtitle') || text
      } else if (type === 'video') {
        media.src = imgOf(box, 'video')
        const dim = sizeOf(box)
        media.width = dim.w
        media.height = dim.h
      } else if (type === 'share') {
        media.title = textOf(box, 'MessageItemShareAwemeauthorName') || text
      }

      // 文本类没正文 → 忽略；**媒体类照样要**
      if (type === 'text' && !text) continue
      if (type === 'share' && !text) continue

      out.push({
        fromMe,
        isShare,
        type,
        text: text.slice(0, 500),
        media,
        // ⭐ y 坐标用于排序（DOM 顺序不可靠）
        y: Math.round(r.top),
      })
    }
    return out
  })()`

  const msgs = await browser.eval(MSGS_JS)

  if (!Array.isArray(msgs)) return { ok: false, error: '读不到消息列表', debug: st }

  // ── 表情名：气泡里没有名字，得靠面板对照表 ──────────────────────
  //
  // 表情气泡的 innerText 是空的，图片也只有地址。
  // 但表情面板里每一格都带名字（续火花 / 比心 / 在干嘛…）⇒ 建一张对照表缓存起来。
  //
  // ⚠️ 不能只在「表是空的」时才建表：抖音会不断上新表情，
  //    表里没有的那一个就会永远显示成「[表情]」。
  //    所以先按现有表查一遍，**还有查不到的**就重建一次表再查。
  const resolveEmojiNames = () => {
    let miss = 0
    for (const m of msgs) {
      if (m.type !== 'emoji' || m.media?.name || !m.media?.src) continue
      const got = lookupEmojiName(m.media.src)
      if (got) m.media.name = got
      else miss++
    }
    return miss
  }
  if (msgs.some((m) => m.type === 'emoji' && !m.media?.name && m.media?.src)) {
    let miss = resolveEmojiNames()
    if (miss > 0) {
      await buildEmojiNameMap(browser).catch(() => {})
      miss = resolveEmojiNames()
    }
  }

  // 去重（嵌套容器会重复）+ 按 y 排序 = 视觉顺序（从上到下），最后一条就是最新的
  //
  // 🔴 以前按「谁发的 + 正文 + 媒体」全局去重 —— 对方连发两次「你好」，
  //    第二条在这里就被删了，后面的窗口对比永远看不到它。
  //    现在页面里先丢掉被别的消息容器包住的节点，这里再只合并 y 几乎重合的同内容节点。
  const uniq = dedupeNestedMessages(msgs)

  // 标记系统消息（不该触发回复）
  //
  // 🔴 除了「已互相关注」这类，还要拦两种：
  //    ① **「暂不支持该消息类型展示 请到抖音手机端查看」**
  //       —— 对方发的是网页端渲染不了的消息（语音、红包、某些卡片）。
  //       它不是对话内容，回它等于答非所问。
  //    ② **「[分享视频] xxx」** —— 分享卡片没有正文，也不该触发回复
  //       （分享由 digest 负责，聊天由 watch 负责，别串）。
  const SYS = new RegExp([
    '已互相关注',
    '可以开始聊天',
    '发布了新作品',
    '进入了直播间',
    '关注了你',
    '赞了你的',
    '系统消息',
    '撤回了一条消息',
    '暂不支持该消息类型展示',
    '请到抖音手机端查看',
    '消息已发出.*但被对方拒收',
    '对方开启了朋友验证',
  ].join('|'))

  for (const m of uniq) {
    m.system = !m.isShare && SYS.test(m.text)
    // 网页端读不到内容的卡片，单独标一下（给上层决定要不要提示用户）
    m.unsupported = /暂不支持该消息类型展示/.test(m.text) || m.type === MEDIA.UNSUPPORTED
    // 媒体消息也要有人能读的正文
    if (!m.text && m.type && m.type !== MEDIA.TEXT) m.text = describeMedia(m)
    delete m.y
  }

  return {
    ok: true,
    messages: uniq.slice(-limit),
    total: uniq.length,
    inChat: true,
    via: 'dom',
  }
}

/**
 * 发私信。
 * @param {object} p { browser, text, uname }
 */
export async function sendDM({ browser, text, uname = '' }) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '正文是空的' }

  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) return { ok: false, error: '打不开私信面板' }

  // 🔴 必须确认**进的是对的那个人**再打字。
  //    以前是 `if (!st.inChat) await enterChat(...)` —— 返回值直接丢掉了：
  //    enterChat 没进去 / 进错会话时照样往下走，消息就发给了上一个人。
  //    （表现：工具返回 ok:true，抖音里却查不到这条。）
  if (uname) {
    const ok = await enterChat(browser, uname)
    if (!ok) return { ok: false, error: `进不去「${uname}」的会话` }
    await sleep(600)
    // 再确认一次：现在打开的会话确实是这个人
    const cur = await currentPeer({ browser })
    if (cur.inChat && cur.name && !cur.name.includes(uname) && !uname.includes(cur.name)) {
      return { ok: false, error: `当前会话是「${cur.name}」，不是「${uname}」` }
    }
  } else if (!st.inChat) {
    const ok = await enterChat(browser, '')
    if (!ok) return { ok: false, error: '进不去会话' }
  }

  const focused = await browser.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().width > 100)
    const el = (ta && ta.getBoundingClientRect().width > 100) ? ta : ce
    if (!el) return null
    el.focus()
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
  })()`)
  if (!focused) return { ok: false, error: '找不到输入框' }

  // 点一下输入框，确保焦点
  //
  // 🔴 不能只靠 Input.dispatchMouseEvent —— 输入框可能**落在视口外**
  //    （实测：视口 1532 宽，聊天输入框在 x=1707，点不到，焦点留在 BODY 上）。
  //    `Input.insertText` 只往「当前焦点」打字，焦点在 BODY 上就等于什么都没打。
  //    ⇒ 先用 JS 直接 focus()，再用 CDP 打字的**双保险**。
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focused.x, y: focused.y, button: 'left', clickCount: 1 }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focused.x, y: focused.y, button: 'left', clickCount: 1 }, browser.sessionId)
  await sleep(300)

  // JS 兜底：直接聚焦那个 contenteditable（不依赖坐标）
  const focusedByJs = await browser.eval(`(() => {
    const ce = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 50 && r.height > 10 })
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
    if (!ce) return false
    ce.focus()
    // 有些编辑器要在内部的可编辑节点上聚焦
    const inner = ce.querySelector('[contenteditable="true"]')
    if (inner && inner !== ce) inner.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(inner || ce)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
    return document.activeElement === ce || document.activeElement === inner || ce.contains(document.activeElement)
  })()`)
  await sleep(250)

  const READ_INPUT = `(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find((x) => x.getBoundingClientRect().width > 100)
    const el = (ta && ta.getBoundingClientRect().width > 100) ? ta : ce
    return el ? String(el.value || el.innerText || '').replace(/\u200b/g, '').trim() : ''
  })()`

  await browser.send('Input.insertText', { text: body }, browser.sessionId)
  await sleep(900)

  let typed = await browser.eval(READ_INPUT)

  // 还是空的 ⇒ 用 JS 直接写进去（React 受控组件要走原生 setter + input 事件）
  if (!typed) {
    await browser.eval(`(() => {
      const ce = [...document.querySelectorAll('[contenteditable="true"]')]
        .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 50 && r.height > 10 })
        .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
      if (!ce) return false
      ce.focus()
      // execCommand 会触发正常的 input 事件，React 能收到
      document.execCommand('insertText', false, ${JSON.stringify(body)})
      return true
    })()`)
    await sleep(700)
    typed = await browser.eval(READ_INPUT)
  }

  // 🔴 必须确认**打的正是要发的内容**。
  //    只看「输入框非空」不够：焦点没在输入框时 insertText 会打进别处，
  //    或者输入框里残留着上一次的字 —— 都会让后面「输入框空了 = 发送成功」变成假阳性。
  if (!typed) {
    return { ok: false, error: `输入没生效（焦点=${focusedByJs ? '已聚焦' : '聚焦失败'}，输入框仍为空）` }
  }
  if (!typed.includes(body.slice(0, 12))) {
    return { ok: false, error: `输入框里的内容不对：${JSON.stringify(typed.slice(0, 40))}` }
  }

  // Enter 发送
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, browser.sessionId)
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, browser.sessionId)
  await sleep(2500)

  const after = await browser.eval(READ_INPUT)
  if (after) return { ok: false, error: '输入框还有内容，可能没发出去' }

  // 🔴 真·验证：消息列表里必须出现这条内容。
  //    以前只判断「输入框空了」就返回 ok —— 结果出现过「返回 ok:true、抖音里却查不到」
  //    （Enter 没触发发送，或者消息还在发送中就被读走了）。
  //    这里读一次聊天区，确认正文确实在。
  const probe = body.slice(0, 20)
  for (let i = 0; i < 4; i++) {
    const seen = await browser.eval(`(() => {
      const FINDV = ${pageFindHelper()}
      const boxes = FINDV.messageBox()
      for (const b of boxes) {
        if (!FINDV.one(b, 'fromMe')) continue
        if ((b.innerText || '').includes(${JSON.stringify(probe)})) return true
      }
      return false
    })()`)
    if (seen) return { ok: true, verified: true }
    await sleep(1200)
  }

  // 没在列表里看到 —— 不假装成功
  return {
    ok: false,
    error: '发送后没在消息列表里看到这条内容（Enter 可能没触发发送）',
    sent: body.slice(0, 40),
  }
}

/* ── 发图片 / 发表情 ──────────────────────────────────────────────── */

/**
 * 打开私信面板并确认「进的是对的那个人的会话」。
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
/**
 * 确保当前就在某个好友的会话里（发图/发表情前用）。
 *
 * 🔴 为什么要重试（2026-10-26 实测踩到）：
 *    `enterChat` 内部是「点会话项 → 等 3 秒 → 看有没有输入框」，
 *    抖音偶尔会吃掉第一次点击（虚拟列表重排、面板动画没结束），
 *    于是返回 false。之前一次失败就直接报「进不去会话」，
 *    用户看到的是「发图发不出去」，其实再点一次就好。
 *
 *    现在：① 先走快路径（本来就在这个会话里就直接过）
 *          ② 最多试 3 次，中间隔 1.2 秒
 */
async function ensureTargetChat({ browser, uname = '' }) {
  // ① 快路径：已经在目标会话里
  if (uname) {
    const now = await currentPeer({ browser }).catch(() => null)
    if (now?.inChat && now.name && (now.name.includes(uname) || uname.includes(now.name))) {
      return { ok: true, via: 'already-here' }
    }
  }

  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) return { ok: false, error: st.error || '打不开私信面板' }

  if (uname) {
    let lastErr = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      let ok = false
      try {
        ok = await enterChat(browser, uname)
      } catch (e) {
        lastErr = String(e?.message || e)
      }
      if (ok) {
        await sleep(600)
        const cur = await currentPeer({ browser })
        if (!cur.inChat || !cur.name || cur.name.includes(uname) || uname.includes(cur.name)) {
          return { ok: true, attempt }
        }
        lastErr = `当前会话是「${cur.name}」，不是「${uname}」`
      }
      if (attempt < 3) await sleep(1200)
    }
    return { ok: false, error: `进不去「${uname}」的会话${lastErr ? `（${lastErr}）` : ''}` }
  }

  if (!st.inChat) {
    const ok = await enterChat(browser, '')
    if (!ok) return { ok: false, error: '进不去会话' }
  }
  return { ok: true }
}

/** 列出当前会话里的图片气泡（发图前后对比用） */
const COUNT_IMAGES = `(() => {
  const out = []
  for (const el of document.querySelectorAll('[class*="MessageItemImageImageBox"]')) {
    const img = el.querySelector('img')
    out.push(img ? (img.getAttribute('src') || '') : '')
  }
  return out
})()`

/** 列出当前会话里的表情气泡 */
const COUNT_EMOJI = `(() => {
  const out = []
  for (const el of document.querySelectorAll('[class*="MessageItemEmojiemojiBox"]')) {
    const img = el.querySelector('img')
    out.push(img ? (img.getAttribute('src') || '') : '')
  }
  return out
})()`

/**
 * 判断「有没有多出新的气泡」。
 *
 * 🔴 **不能用数量对比**（实测踩过）：
 *    抖音的消息列表是**虚拟列表** —— 只渲染最近一屏。
 *    新消息进来时，**旧消息会被卸载**，于是「数量」可能一直不变
 *    （1 → 1），看起来像没发出去，其实发出去了。
 *    ⇒ 只能比「集合里有没有新东西」。
 *
 * @param {Array<string>} before 之前的气泡标识（图片/表情地址）
 * @param {Array<string>} after  之后的
 * @returns {boolean}
 */
function hasNewBubble(before, after) {
  const seen = new Set((before || []).filter(Boolean))
  return (after || []).some((x) => x && !seen.has(x))
}

/**
 * 发一张图片到私信。
 *
 * 🔴 **整条流程是实测出来的，别乱改**（2026-10）：
 *
 *   1. `.semi-upload-add`（32×32 的 `div[role=button]`）点了会弹**系统文件选择框**。
 *      必须先 `Page.setInterceptFileChooserDialog {enabled:true}` 把这个框截下来，
 *      否则浏览器会弹一个真窗口，自动化就卡死了。
 *   2. 用 JS `click()` 触发，**不能用 `Input.dispatchMouseEvent`** ——
 *      坐标会随布局漂移（实测点下去没反应）。
 *   3. 截到 `Page.fileChooserOpened` 后，用 `DOM.setFileInputFiles {backendNodeId}` 塞文件。
 *      ⚠️ 只对隐藏的 `input[type=file]` 调 `setFileInputFiles` 是**没用**的 ——
 *         抖音的隐藏 input 不是真正上传的那个。
 *   4. 选完文件会弹「发送给 XXX」确认框（`MsgInputSendFileModalbox`），
 *      **真正开始上传是点里面的「发送」按钮**（`MsgInputSendFileModalbtnSure`）。
 *      点文字叶子节点不生效，必须点带 `btnSure` class 的那个。
 *   5. 上传链路（实测）：
 *        GET  /aweme/v1/web/im/upload/config/v2
 *        GET  vod.bytedanceapi.com?Action=ApplyUploadInner&FileType=image
 *        POST https://tos-d-x-hl.douyin.com/upload/v1/tos-cn-o-00061/...
 *        POST vod.bytedanceapi.com?Action=CommitUploadInner
 *        POST https://imapi.douyin.com/v1/message/send
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {string} p.file  本地图片路径
 * @param {string} p.uname 好友名
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function sendImage({ browser, file, uname = '' }) {
  const path = String(file || '').trim()
  if (!path) return { ok: false, error: '没给图片路径' }
  if (!existsSync(path)) return { ok: false, error: `图片不存在：${path}` }

  const chat = await ensureTargetChat({ browser, uname })
  if (!chat.ok) return chat

  const before = await browser.eval(COUNT_IMAGES).catch(() => 0)

  // ① 截住系统文件选择框
  let intercepting = false
  try {
    await browser.send('Page.setInterceptFileChooserDialog', { enabled: true }, browser.sessionId)
    intercepting = true
  } catch (e) {
    return { ok: false, error: `开不了文件选择框拦截：${e.message}` }
  }

  try {
    // ② 等文件选择框事件 + 点上传按钮（**并行**等，别等完再点）
    const chooserPromise = browser.waitForEvent('Page.fileChooserOpened', { timeoutMs: 15000 })
    const clicked = await browser.eval(`(() => {
      const btn = document.querySelector('.semi-upload-add')
      if (!btn) return false
      const o = { bubbles: true, cancelable: true, view: window }
      btn.dispatchEvent(new MouseEvent('click', o))
      btn.click && btn.click()
      return true
    })()`)
    if (!clicked) return { ok: false, error: '找不到上传图片的按钮（.semi-upload-add）' }

    const chooser = await chooserPromise

    // ③ 把文件塞进去
    await browser.send('DOM.setFileInputFiles', {
      files: [path],
      backendNodeId: chooser.params?.backendNodeId,
    }, browser.sessionId)

    // ④ 等「发送给 XXX」确认框
    let modal = false
    for (let i = 0; i < 15; i++) {
      await sleep(600)
      modal = await browser.eval(`Boolean(document.querySelector('[class*="MsgInputSendFileModalbox"]'))`).catch(() => false)
      if (modal) break
    }
    if (!modal) return { ok: false, error: '选完文件后没弹出「发送」确认框' }

    // ⑤ 点「发送」——**要点带 btnSure 的那个元素**
    const sent = await browser.eval(`(() => {
      const btn = document.querySelector('[class*="MsgInputSendFileModalbtnSure"]')
      if (!btn) return false
      const o = { bubbles: true, cancelable: true, view: window }
      btn.dispatchEvent(new MouseEvent('click', o))
      btn.click && btn.click()
      return true
    })()`)
    if (!sent) return { ok: false, error: '确认框里找不到「发送」按钮' }

    // ⑥ 验证：气泡集合里要多出新的东西
    for (let i = 0; i < 12; i++) {
      await sleep(1000)
      const after = await browser.eval(COUNT_IMAGES).catch(() => [])
      if (hasNewBubble(before, after)) return { ok: true, verified: true, images: after.length }
    }
    return { ok: false, error: '点了发送，但消息列表里没出现新的图片气泡' }
  } finally {
    if (intercepting) {
      await browser.send('Page.setInterceptFileChooserDialog', { enabled: false }, browser.sessionId).catch(() => {})
    }
  }
}

/**
 * 抓一次表情面板，建「图片地址 → 表情名」对照表。
 *
 * 🔴 面板的 class 是 `componentsemojiemojiPanel` ——
 *    注意是**全小写的 emoji** + 驼峰的 Panel。
 *    写成 `emojiEmojiPanel` 匹配不到（大小写对不上），实测踩过：
 *    「表情面板没弹出来」—— 其实弹出来了，只是没认出来。
 *
 * @param {object} browser
 * @returns {Promise<Array<{src:string, name:string}>>}
 */
async function buildEmojiNameMap(browser) {
  const opened = await browser.eval(`(() => {
    const svgs = [...document.querySelectorAll('svg')].filter((s) => {
      const c = String((s.className && s.className.baseVal) || '')
      return c.indexOf('messageMsgInputiconAction') >= 0
    })
    if (!svgs.length) return false
    const o = { bubbles: true, cancelable: true, view: window }
    svgs[0].dispatchEvent(new MouseEvent('click', o))
    svgs[0].click && svgs[0].click()
    return true
  })()`).catch(() => false)
  if (!opened) return []

  let panel = false
  for (let i = 0; i < 10; i++) {
    await sleep(400)
    panel = await browser.eval(`Boolean(document.querySelector('[class*="emojiPanel"]'))`).catch(() => false)
    if (panel) break
  }
  if (!panel) return []

  const items = await browser.eval(`(() => {
    const out = []
    for (const el of document.querySelectorAll('[class*="emojiEmojiItememojiItem"]')) {
      const img = el.querySelector('img')
      out.push({
        src: img ? (img.getAttribute('src') || '') : '',
        name: (el.innerText || '').trim(),
      })
    }
    return out
  })()`).catch(() => [])

  // 关掉面板（Esc）
  try {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, browser.sessionId)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, browser.sessionId)
  } catch { /* 关不掉也无所谓 */ }
  await sleep(300)

  rememberEmojiNames(items)
  return items
}

/**
 * 发一个表情（贴纸）。
 *
 * 🔴 实测（2026-10）：
 *   · 表情按钮是输入框工具栏中间那个 `svg.messageMsgInputiconAction`
 *     （左边是上传 `MsgInputFileUploadinputActionIcon`，右边是发送 `e2e-send-msg-btn`）
 *   · 点了之后弹出 `componentsemojiemojiPanel`（304×245），里面一格一个表情：
 *     `emojiEmojiItememojiItem`，每格 55×79，**文字就是表情名**（续火花 / 比心 / 在干嘛…）
 *   · 点一格**直接就发出去了**（面板会关掉），不用再点发送
 *   · 表情图片是 https CDN 地址（`p3-sign.douyinpic.com/obj/im-resource/...`）
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {string} p.name  表情名（支持部分匹配）
 * @param {string} p.uname 好友名
 */
export async function sendEmoji({ browser, name = '', uname = '' }) {
  const want = String(name || '').trim()
  if (!want) return { ok: false, error: '没给表情名' }

  const chat = await ensureTargetChat({ browser, uname })
  if (!chat.ok) return chat

  const before = await browser.eval(COUNT_EMOJI).catch(() => 0)

  // ① 开表情面板
  const opened = await browser.eval(`(() => {
    const svgs = [...document.querySelectorAll('svg')].filter((s) => {
      const c = String((s.className && s.className.baseVal) || '')
      return c.indexOf('messageMsgInputiconAction') >= 0
    })
    if (!svgs.length) return false
    const b = svgs[0]
    const o = { bubbles: true, cancelable: true, view: window }
    b.dispatchEvent(new MouseEvent('click', o))
    b.click && b.click()
    return true
  })()`)
  if (!opened) return { ok: false, error: '找不到表情按钮（svg.messageMsgInputiconAction）' }

  // ② 等面板出来
  //
  // ⚠️ 面板 class 是 `componentsemojiemojiPanel`（全小写 emoji）。
  //    匹配 `emojiEmojiPanel` 会找不到 —— 实测踩过。
  let panel = false
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    panel = await browser.eval(`Boolean(document.querySelector('[class*="emojiPanel"]'))`).catch(() => false)
    if (panel) break
  }
  if (!panel) return { ok: false, error: '表情面板没弹出来' }

  // ③ 找表情（顺便把整张对照表记下来）
  const picked = await browser.eval(`(() => {
    const want = ${JSON.stringify(want)}
    const items = [...document.querySelectorAll('[class*="emojiEmojiItememojiItem"]')]
    if (!items.length) return { err: '面板里没有表情' }
    const label = (el) => (el.innerText || '').trim()
    const all = items.map((el) => {
      const img = el.querySelector('img')
      return { src: img ? (img.getAttribute('src') || '') : '', name: label(el) }
    })
    let target = items.find((el) => label(el) === want)
    if (!target) target = items.find((el) => label(el).indexOf(want) >= 0)
    if (!target) {
      return { err: '没有叫「' + want + '」的表情', available: all.map((x) => x.name).filter(Boolean).slice(0, 20) }
    }
    const name = label(target)
    const img = target.querySelector('img')
    const src = img ? (img.getAttribute('src') || '') : ''
    const o = { bubbles: true, cancelable: true, view: window }
    target.dispatchEvent(new MouseEvent('click', o))
    target.click && target.click()
    if (img) {
      img.dispatchEvent(new MouseEvent('click', o))
      img.click && img.click()
    }
    return { ok: true, name, src, all }
  })()`)
  if (!picked?.ok) return { ok: false, error: picked?.err || '没找到表情', available: picked?.available }

  // 记住整张对照表（读消息时靠它把表情地址翻译成名字）
  rememberEmojiNames(picked.all || [])

  // ④ 验证：表情气泡集合里要多出新的东西
  //
  // ⚠️ 抖音发消息**不是立刻上屏**的 —— 实测点完表情 6 秒多才渲染出来。
  //    窗口太短会误报「没发出去」（其实发出去了）。
  for (let i = 0; i < 16; i++) {
    await sleep(1000)
    const after = await browser.eval(COUNT_EMOJI).catch(() => [])
    if (hasNewBubble(before, after)) return { ok: true, verified: true, name: picked.name, url: picked.src }
  }
  return { ok: false, error: '点了表情，但消息列表里没出现新的表情气泡', name: picked.name }
}

/** 登录态检查 */
export async function checkLogin(browser) {
  const ck = await browser.cookies(['https://www.douyin.com/', 'https://www.douyin.com/user/self'])
  const names = ck.map((c) => c.name)
  // ⚠️ 只认 sessionid / sessionid_ss —— passport_csrf_token 是访客 cookie
  const logged = names.includes('sessionid') || names.includes('sessionid_ss')
  return {
    loggedIn: logged,
    cookies: names.length,
    detail: logged ? '已登录' : '未登录（passport_csrf_token 是访客 cookie，不算登录）',
  }
}

/* ── 会话列表 ──────────────────────────────────────────────────────── */

/**
 * 列出私信会话（会话名 / 时间 / 预览 / 未读标记）。
 *
 * ⭐ 会话项 class：`conversationConversationItemwrapper`
 *    ├ `conversationConversationItemtitle`    好友名
 *    ├ `ConversationItemTagNextToTitlewrapper` 时间
 *    └ `ConversationItemDescwrapper`          消息预览
 *
 * ⚠️ 这一步**只读不点**：不进入任何会话，所以不会打扰对方的在线状态，
 *    也不会把自己这边的"正在输入"暴露出去。
 *
 * @param {object} p { browser, limit }
 */
export async function dmList({ browser, limit = 40 }) {
  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) {
    return {
      ok: false,
      error: st.error || '打不开私信面板',
      debug: { vw: st.vw, vh: st.vh, hasMsgBtn: st.hasMsgBtn },
    }
  }

  // ⚠️ 这段是**页面里跑的 JS**，用 String.raw 写：里面的 \n / \d / \s 要原样进浏览器，
  //    不能用普通模板字符串（那会把 \n 变成真换行，把整个表达式弄坏）。
  //
  // ⭐ 选择器全部走 selectors.mjs 的降级链（data-e2e → 语义 class → 结构兜底），
  //    抖音改版把某条路径打挂时，后面的还能顶。
  const ROWS_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()}
    let items = FIND.conversationItem()

    if (!items.length) {
      // 🔴 兜底：按尺寸 + 时间关键词找。
      //
      //    但这里有个**极其坑**的陷阱，实测踩到过：
      //    如果直接在整页里按「尺寸 250~450 × 50~120 + 含『分钟前/小时前』」找，
      //    会把**信息流里的视频卡片**全部当成会话项 ——
      //    视频卡片也是这个尺寸，也带「· 21小时前」。
      //
      //    后果不是「找不到会话」，而是「找到一堆假会话」：
      //    桥接拿视频标题当好友名去读私信，每轮刷一堆
      //    「找不到会话《一碗羊汤引发的惨案》…」，injected 永远是 0。
      //
      //    所以兜底必须**双重限制**：
      //      ① 只在私信面板内部找（[data-e2e="im-dialog"] 或会话列表容器）
      //      ② 排除「@作者 · 时间」这种视频卡片特征
      const dialog = document.querySelector('[data-e2e="im-dialog"]')
        || document.querySelector('[class*="conversationList"]')
        || document.querySelector('[class*="conversation-list"]')
      const scope = dialog || null
      if (scope) {
        const KW = ['分钟前', '小时前', '昨天', '刚刚']
        // 视频卡片特征：形如「@作者 · 21小时前」，或带 #话题
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
          if (!KW.some((k) => t.indexOf(k) >= 0)) return false
          if (looksLikeVideoCard(el)) return false
          return true
        })
      }
      // scope 找不到就**宁可返回空**，也不要拿整页去猜 ——
      // 空列表上层会明确报「没有会话」，比返回一堆假会话好查得多。
    }
    const isNoise = (s) => /^\d{1,3}$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^(昨天|刚刚|\d+分钟前|\d+小时前|\d+月\d+日)$/.test(s)

    const out = []
    for (const el of items) {
      const r = el.getBoundingClientRect()
      // 只认真的渲染出来的会话项（DOM 里常有 0×0 的隐藏副本）
      if (r.width < 100 || r.height < 20) continue
      const nameEl = FIND.one(el, 'conversationTitle')
      const timeEl = FIND.one(el, 'conversationTime')
      const descEl = FIND.one(el, 'conversationDesc')
      const raw = (el.innerText || '').trim()

      // 🔴 名字要剥掉未读数和时间：
      //    innerText 长这样 —— 「好友名 / 3 / 03:27」，
      //    直接把整串当名字，后面按名字找人就会失配。
      const title = (nameEl?.innerText || '').trim()
      const parts = (title || raw).split('\n').map((s) => s.trim()).filter((s) => s && !isNoise(s))
      const name = (parts[0] || '').replace(/\s*\d{1,3}\s*$/, '').trim()
      if (!name) continue

      const badge = FIND.one(el, 'unreadBadge')
      out.push({
        name,
        time: (timeEl?.innerText || '').trim(),
        preview: (descEl?.innerText || '').trim().split('\n').join(' ').slice(0, 200),
        unread: Boolean(badge),
        y: Math.round(r.top),
      })
    }
    return out
  })()`

  // 🔴 抖音会**周期性地把 IM 组件整个卸载再挂回来**（实测 45 秒内掉了 2 次，
  //    URL 不变、没有导航、没有路由变化，就是 DOM 突然没了又回来）。
  //    读一次很容易正好撞上空窗期，于是拿到空列表 —— 看起来像「没有会话」。
  //    ⇒ 重试几次，别一次读空就下结论。
  //
  // ⚠️ 但重试**不能盲目**：面板要是压根没打开，重试只会白等，
  //    还会把整轮轮询拖过 bridge 的 80 秒上限（实测踩过）。
  //    所以重试前先确认面板还在，不在就立刻退出 —— 上层会重新 ensurePanel。
  let rows = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    rows = await browser.eval(ROWS_JS).catch(() => null)
    if (Array.isArray(rows) && rows.length) break
    if (attempt >= 5) break
    const alive = await browser.eval(
      `Boolean(document.querySelector('[data-e2e="im-dialog"]'))`,
    ).catch(() => false)
    if (!alive) break
    await sleep(700)
  }

  if (!Array.isArray(rows)) return { ok: false, error: '读不到会话列表' }

  const seen = new Set()
  const uniq = rows
    .filter((x) => (seen.has(x.name) ? false : (seen.add(x.name), true)))
    .sort((a, b) => a.y - b.y)

  return { ok: true, conversations: uniq.slice(0, limit), total: uniq.length }
}

/**
 * 当前打开的会话是哪个好友（进聊天时才知道）。
 *
 * 🔴 抖音的聊天面板**没有独立的会话头元素**（实测：右侧只有「消息」标题栏，
 *    好友名不在里面）。真正的信号是**左侧会话列表里被选中的那一项** ——
 *    选中项带 `active` / `selected` 之类的 class。
 *
 * ⚠️ 千万别用「尺寸 + 文字长度」去猜：那样会抓到左侧导航的「精选」，
 *    或者聊天区里的消息正文（实测抓到过「刚才那个视频讲了啥」）。
 *
 * @param {object} p { browser }
 */
export async function currentPeer({ browser }) {
  const CUR_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()}
    const ta = document.querySelector('textarea')
    const ce = FIND.chatInput().filter((x) => x.getBoundingClientRect().width > 100)
    const inChat = Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
    if (!inChat) return { inChat: false, name: '' }

    const isNoise = (s) => /^\d{1,3}$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^(昨天|刚刚|\d+分钟前|\d+小时前|\d+月\d+日)$/.test(s)

    const nameOf = (item) => {
      const title = FIND.one(item, 'conversationTitle')
      const parts = ((title?.innerText || '').trim() || (item.innerText || '').trim())
        .split('\n').map((s) => s.trim()).filter((s) => s && !isNoise(s))
      return (parts[0] || '').replace(/\s*\d{1,3}\s*$/, '').trim()
    }

    // ① 选中项：class 里带 active / selected / current 的会话项
    const items = FIND.conversationItem()
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 20 })
    for (const el of items) {
      const cls = String(el.className || '')
      // 选中态可能挂在会话项自己身上，也可能挂在它的子/父节点上
      const marks = [el, el.parentElement, el.firstElementChild].filter(Boolean)
      for (const m of marks) {
        const c = String(m.className || '')
        if (/\b(active|selected|current|checked|isActive)\b/i.test(c) || /active|selected/i.test(c)) {
          const name = nameOf(el)
          if (name) return { inChat: true, name, via: 'active-item' }
        }
      }
    }

    // ② 兜底：聊天面板正上方那个会话项（视觉上最靠上、且在列表里）
    if (items.length) {
      items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const name = nameOf(items[0])
      if (name) return { inChat: true, name, via: 'first-item' }
    }

    return { inChat: true, name: '', via: 'none' }
  })()`
  const r = await browser.eval(CUR_JS)
  return r || { inChat: false, name: '' }
}
