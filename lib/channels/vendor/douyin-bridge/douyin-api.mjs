/**
 * lib/douyin-api.mjs —— 走抖音自己的接口读私信（**不碰 DOM**）
 * ============================================================================
 * 为什么要这层：
 *
 * 之前读私信靠解析 DOM（`ConversationItemwrapper` 这类 class）。抖音改版
 * 或者换个窗口尺寸就会崩 —— 实测已经踩过：面板 0×0、输入框跑到视口外、
 * 点错层级导致 toggle 把面板关掉。
 *
 * 这一层改成**读抖音自己的接口**。抓包确认的三层：
 *
 *   · `www.douyin.com/aweme/v1/web/im/*`  HTTP + JSON
 *   · `imapi.douyin.com/v1|v2|v3/*`       HTTP + **protobuf**（会话/消息/发送/已读）
 *   · `wss://frontier-im.douyin.com/ws/v2` WebSocket + protobuf（推送）
 *
 * 🔴 关键设计：**不自己拼请求**。
 *    imapi 的请求要带 `a_bogus` 签名，那是抖音自己的 JS 在页面里算的。
 *    所以我们用 `Page.addScriptToEvaluateOnNewDocument` 在页面里 hook 住
 *    `fetch` / `XMLHttpRequest`，让抖音**自己**去请求，我们把响应截下来解码。
 *
 *    好处：签名、cookie、风控参数全都由浏览器负责，我们只解 protobuf。
 *    代价：得先「触发」一次请求（打开面板 / 切会话），数据才会来。
 *
 * 字段映射（实测 2026-10，`v1/message/get_by_conversation`）：
 *
 *   顶层  #1 status_code  #4 status_msg  #6 数据体
 *   #6.#301.#1[] = 消息列表
 *     每条消息：
 *       #1  会话 id（`0:1:xxx:yyy`）
 *       #2  会话类型
 *       #6  消息类型（7 = 文本，15 = 其他，1 = 系统）
 *       #7  发送者 id
 *       #8  JSON 正文（`{"text":"..."}` 或 `{"tips":"..."}`）
 *       #10 服务端时间（毫秒）
 *       #14 发送者 sec_uid
 *       #17 序号
 *
 * 2026-11 实测：网页私信改成先请求 `v1/message/get_message_by_init`，外壳不一样，
 * 但**消息字段没变**：
 *
 *   顶层  #1 status_code  #4 status_msg  #6 数据体
 *   #6.#2043.#1.#1    = 会话快照（#1 会话 ID、#6 参与者 uid + sec_uid、#50/#51 详情）
 *   #6.#2043.#1.#2[]  = 消息列表（字段同上；新消息**没有** #14 sec_uid / #17 seq，
 *                       发送者的 sec_uid 要从会话快照的参与者里补）
 *
 *   `#2043` 这一层是套壳，字段号会变 —— 所以解析按「字段集像消息」递归找，
 *   不写死层级（见 `collectMessageFields`）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseTree, parseFields, getInt, getIntString, getString, all } from './pb.mjs'
import { soleConversationId } from '../../../douyin-conversation.js'

/** 消息类型 */
const KIND_TEXT = 7

/**
 * 消息接口的 URL 特征（hook 抓包过滤 + `pickMessages` 都认这几个）。
 *
 * `get_message_by_init` 是 2026-11 实测的新接口：网页私信现在先请求它，
 * 老的 `get_by_conversation` / `get_user_message` 还会顺带请求，但后者只回回执。
 */
export const MESSAGE_URL_RE = /get_by_conversation|get_message_by_init|get_user_message|message\/list/i

/**
 * 会话 ID 文本：单聊 `0:1:<uid>:<uid>`，群聊 `0:2:<uid>:<uid>`。
 *
 * ⚠️ 这里只负责「别把它当成 protobuf 子树」，单聊/群聊的判定交给
 *    `douyin-conversation.js`（`isSingleConversation` 只认 0:1）。
 */
const CONV_ID_TEXT_RE = /^0:[12]:\d+:\d+$/

/** sec_uid 的形状（`MS4wLjAB…`） */
const SEC_UID_TEXT_RE = /^MS4wLjAB[\w-]{8,}$/

/**
 * hook 脚本的源码。
 *
 * 🔴 必须**在页面加载前**注册（`Page.addScriptToEvaluateOnNewDocument`），
 *    否则只能截到「装上之后」的请求。抖音的私信接口只在首次进会话时请求一次，
 *    晚了就抓不到 —— 只能 reload 重来。
 *
 * 所以这段源码是**常量导出**的，给 `browser.addPreloadScript()` 用。
 */
export const HOOK_SOURCE = String.raw`
    (function () {
      // 🔴 版本号。改了 hook 就 +1。
      //
      //    为什么要这个：preload 脚本在 target 上是**累积注册**的，
      //    改完代码重新 attach 时旧版可能还挂着（CDP 没有「列已注册脚本」的接口，
      //    跨进程重启更清不掉）。旧版会先执行并把 window.__dyIM 占住，
      //    新版就变成空转 —— 表现就是「hook 在，但一条都抓不到」。
      //
      //    所以：版本不一致就**顶掉旧的**，重装一遍。
      const VERSION = 4;
      if (window.__dyIM && window.__dyIM.version === VERSION) return;

      const MAX = 40;
      // WebSocket 帧单独存：接口只回回执（如 get_user_message）时，会话 ID
      // 往往只出现在推送帧里，用来做兜底。
      const MAX_WS = 60;
      const log = [];
      const wsLog = [];
      const push = (o) => { log.push(o); if (log.length > MAX) log.shift(); };

      // 二进制响应转 base64（跨 CDP 传得动）
      const toB64 = (buf) => {
        // 注意 TypedArray 可能只是大 buffer 上的一个视图，要按 byteOffset/byteLength 取
        const bytes = ArrayBuffer.isView(buf)
          ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          : new Uint8Array(buf);
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(bin);
      };

      const isIM = (url) => /imapi\.douyin\.com|\/aweme\/v1\/web\/im\//i.test(String(url));

      // ── WebSocket ──────────────────────────────────────────
      //
      // 私信推送走 wss://frontier-im.douyin.com/ws/v2，帧里带明文会话 ID。
      // 这条路只做**兜底**：接口解不出 ID 时，从帧里捞唯一一个 0:1:uid:uid。
      //
      // ⚠️ 不能替换成别的类：页面里 instanceof WebSocket、静态常量都要照常。
      const OWS = window.WebSocket;
      if (typeof OWS === 'function') {
        const addFrame = (url, payload) => {
          wsLog.push({ url: String(url), kind: 'ws', b64: payload, at: Date.now() });
          if (wsLog.length > MAX_WS) wsLog.shift();
        };
        function DyWebSocket(url, protocols) {
          const ws = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
          try {
            ws.addEventListener('message', (ev) => {
              try {
                const d = ev.data;
                if (typeof d === 'string') addFrame(url, 'str:' + d);
                else if (d instanceof ArrayBuffer) addFrame(url, 'bin:' + toB64(d));
                // 二进制帧的 binaryType 默认是 blob，也可能被页面设成 arraybuffer
                else if (ArrayBuffer.isView(d)) addFrame(url, 'bin:' + toB64(d));
                else if (typeof Blob !== 'undefined' && d instanceof Blob) {
                  d.arrayBuffer().then((ab) => addFrame(url, 'bin:' + toB64(ab))).catch(() => {});
                }
              } catch (e) { /* 帧读失败不影响页面 */ }
            });
          } catch (e) { /* 挂不上监听就算了 */ }
          return ws;
        }
        DyWebSocket.prototype = OWS.prototype;
        try { Object.setPrototypeOf(DyWebSocket, OWS); } catch (e) {}
        window.WebSocket = DyWebSocket;
      }

      // ── fetch ──────────────────────────────────────────────
      const of = window.fetch;
      window.fetch = async function (...args) {
        const req = args[0];
        const url = typeof req === 'string' ? req : (req && req.url) || '';
        const res = await of.apply(this, args);
        if (!isIM(url)) return res;
        try {
          const clone = res.clone();
          const ct = clone.headers.get('content-type') || '';
          if (/protobuf|octet-stream/i.test(ct)) {
            const buf = await clone.arrayBuffer();
            push({ url: String(url), kind: 'pb', b64: toB64(buf), at: Date.now() });
          } else {
            const text = await clone.text();
            push({ url: String(url), kind: 'json', text: text.slice(0, 200000), at: Date.now() });
          }
        } catch (e) { /* 读失败就算了，别影响页面 */ }
        return res;
      };

      // ── XHR ────────────────────────────────────────────────
      //
      // 🔴 抖音的 IM 请求**走 XHR，不走 fetch**（实测：fetch 里只有扩展图标和埋点，
      //    imapi.douyin.com 的请求全在 XHR 里）。所以这段才是主力。
      //
      // ⚠️ 两个坑：
      //   ① this.responseType 可能不是 arraybuffer，this.response 就不是
      //      ArrayBuffer —— 原来的 instanceof ArrayBuffer 判断会永远 false，
      //      一条都抓不到。改成按 responseType 分支 + 兜底读 responseText。
      //   ② 不能替抖音改它的 responseType（会破坏它自己的解析），
      //      所以：能拿 ArrayBuffer 就拿，拿不到就按 latin1 把文本转回字节。
      const oOpen = XMLHttpRequest.prototype.open;
      const oSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (m, u, ...rest) {
        this.__dyUrl = String(u);
        this.__dyIsIM = isIM(u);
        return oOpen.call(this, m, u, ...rest);
      };

      XMLHttpRequest.prototype.send = function (body) {
        if (this.__dyIsIM) {
          this.addEventListener('load', () => {
            try {
              const url = this.__dyUrl;
              const ct = this.getResponseHeader('content-type') || '';
              const rt = this.responseType;

              // ① 二进制（protobuf）
              if (rt === 'arraybuffer' && this.response instanceof ArrayBuffer) {
                push({ url, kind: 'pb', b64: toB64(this.response), at: Date.now() });
                return;
              }
              // ② 二进制 blob
              if (rt === 'blob' && this.response instanceof Blob) {
                this.response.arrayBuffer().then((buf) => {
                  push({ url, kind: 'pb', b64: toB64(buf), at: Date.now() });
                }).catch(() => {});
                return;
              }
              // ③ 文本（JSON）
              if (rt === '' || rt === 'text') {
                const text = this.responseText;
                if (typeof text === 'string' && text.length) {
                  const isPb = /protobuf|octet-stream/i.test(ct) || /^[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 1));
                  if (isPb) {
                    // 文本模式下读到的二进制是 latin1 —— 转回字节
                    const bytes = new Uint8Array(text.length);
                    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
                    push({ url, kind: 'pb', b64: toB64(bytes.buffer), at: Date.now() });
                  } else {
                    push({ url, kind: 'json', text: text.slice(0, 200000), at: Date.now() });
                  }
                }
                return;
              }
              // ④ 其他 responseType：只记 URL，至少能看出它发过
              push({ url, kind: 'meta', rt, ct, at: Date.now() });
            } catch (e) {
              // ⚠️ 不能静默吞：读响应失败时留个记号，否则表现就是「hook 在但 0 条」
              push({ url: this.__dyUrl, kind: 'err', err: String(e && e.message || e), at: Date.now() });
            }
          });

          // 出错也要记一笔
          this.addEventListener('error', () => {
            push({ url: this.__dyUrl, kind: 'neterr', at: Date.now() });
          });
        }
        return oSend.call(this, body);
      };

      window.__dyIM = {
        version: VERSION,
        log,
        wsLog,
        drain() { const out = log.slice(); log.length = 0; return out; },
        peek() { return log.slice(); },
        wsPeek() { return wsLog.slice(); },
        wsDrain() { const out = wsLog.slice(); wsLog.length = 0; return out; },
      };
    })();
  `

/**
 * 在页面里装 hook（当前页面立即生效）。
 *
 * ⚠️ 这只是「补一次」—— 真正可靠的做法是
 *    `browser.addPreloadScript(HOOK_SOURCE)`，让每次导航都自动注入。
 *    两个都做：preload 管以后，这里管当前这一页。
 */
export async function installHook(browser) {
  try { browser.addPreloadScript(HOOK_SOURCE) } catch { /* 老版本 Browser 没有这方法 */ }
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SOURCE }, browser.sessionId)
  await browser.eval(HOOK_SOURCE).catch(() => {})
  return true
}

/** hook 是否在位 */
export async function hookReady(browser) {
  try {
    return await browser.eval(`Boolean(window.__dyIM && window.__dyIM.peek)`).catch(() => false)
  } catch { return false }
}

/** 取走已抓到的响应并清空 */
export async function drain(browser) {
  try {
    return await browser.eval(`(window.__dyIM && window.__dyIM.drain) ? window.__dyIM.drain() : []`)
  } catch { return [] }
}

/** 只看不清空 */
export async function peek(browser) {
  try {
    return await browser.eval(`(window.__dyIM && window.__dyIM.peek) ? window.__dyIM.peek() : []`)
  } catch { return [] }
}

/**
 * 从一段文本里捞出所有会话 ID（`0:1:uid:uid`），去重。
 *
 * 纯函数：单测直接用，不碰浏览器。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function conversationIdsInText(text) {
  const ids = new Set()
  for (const m of String(text ?? '').matchAll(/(?<![\d:])0:1:\d+:\d+(?![\d:])/g)) ids.add(m[0])
  return [...ids]
}

/**
 * 从 WebSocket 帧里捞会话 ID（接口只回回执时的兜底）。
 *
 * 🔴 **只接受唯一匹配**：0 个或多个都返回 '' —— 调用方必须走原来的失败路径，
 *    不许猜一个凑合（猜错就是串会话 / 发错人）。
 *
 * @returns {Promise<string>}
 */
export async function wsConversationId(browser) {
  let frames = []
  try {
    frames = await browser.eval(`(window.__dyIM && window.__dyIM.wsPeek) ? window.__dyIM.wsPeek() : []`)
  } catch { return '' }
  if (!Array.isArray(frames) || !frames.length) return ''
  const ids = new Set()
  for (const f of frames) {
    const raw = String(f?.b64 ?? '')
    let text = ''
    if (raw.startsWith('str:')) text = raw.slice(4)
    else if (raw.startsWith('bin:')) text = Buffer.from(raw.slice(4), 'base64').toString('latin1')
    else continue
    for (const id of conversationIdsInText(text)) ids.add(id)
  }
  return ids.size === 1 ? [...ids][0] : ''
}

/**
 * 拿到「我自己」的 sec_uid。
 *
 * 从 `localStorage.user_info` 读 —— 抖音登录后会把
 * `{uid:"MS4wLjABAAAA...", nickname:"...", avatarUrl:"..."}` 写在这里。
 * `uid` 字段其实是 **sec_uid**（MS4wLjABAAAA 开头），和消息里的 `#14` 同一种格式。
 *
 * ⚠️ 不要硬编码自己的 id：换号就废了。
 *
 * @returns {Promise<{secUid:string, nickname:string}>}
 */
export async function selfInfo(browser) {
  try {
    const r = await browser.eval(String.raw`(() => {
      try {
        const raw = localStorage.getItem('user_info')
        if (!raw) return null
        const o = JSON.parse(raw)
        return { secUid: String(o.uid || ''), nickname: String(o.nickname || '') }
      } catch (e) { return null }
    })()`)
    if (r && r.secUid) return r
  } catch { /* 落到下面 */ }

  // 兜底：从页面里的头像/昵称区域猜（一般不走到这）
  return { secUid: '', nickname: '' }
}

/** 这个 buffer 是不是一条明文会话 ID（`0:1:uid:uid`） */
function isConvIdBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 7 || buf.length > 80) return false
  if (buf[0] !== 0x30 /* '0' */) return false
  return CONV_ID_TEXT_RE.test(buf.toString('latin1'))
}

/**
 * `parseFields()` 解出的一层字段 → `parseTree()` 的节点形状。
 *
 * 🔴 为什么非要多这一步：会话 ID 字符串（`0:1:uid:uid`）的字节**碰巧也是合法的
 *    protobuf 字段序列** —— `'0'` = 0x30 = field 6 / wire 0、`':'` = 0x3a = 58……
 *    于是 `parseTree()` 会把消息的 `#1`（会话 ID）当成一棵嵌套消息树，
 *    `getString(c, 1)` 永远拿到 ''，会话 ID 就这么丢了（旧结构同样中招）。
 *
 *    这里对「看起来就是会话 ID」的字段直接按字符串处理；消息正文 JSON 同理
 *    （`{` = 0x7b 会被当成 group 解成残的）。
 */
function fieldsToNodes(fields) {
  const out = []
  for (const f of fields) {
    if (f.wire === 0) {
      out.push({ field: f.field, kind: 'varint', value: f.value, exact: f.exact })
      continue
    }
    if (f.wire === 1 || f.wire === 5) {
      out.push({ field: f.field, kind: 'bytes', value: f.value })
      continue
    }
    const sub = f.value
    if (!Buffer.isBuffer(sub) || sub.length === 0) {
      out.push({ field: f.field, kind: 'bytes', value: Buffer.alloc(0) })
      continue
    }
    if (isConvIdBuffer(sub)) {
      out.push({ field: f.field, kind: 'string', value: sub.toString('utf8') })
      continue
    }
    if (f.field === 8 && sub[0] === 0x7b /* '{' */) {
      out.push({ field: f.field, kind: 'string', value: sub.toString('utf8') })
      continue
    }
    const children = parseTree(sub)
    if (children.length) {
      out.push({ field: f.field, kind: 'message', value: sub, children })
    } else {
      const s = sub.toString('utf8')
      if (s.includes('\uFFFD')) out.push({ field: f.field, kind: 'bytes', value: sub })
      else out.push({ field: f.field, kind: 'string', value: s })
    }
  }
  return out
}

/**
 * 一条消息对象长什么样（不看层级，只看字段）：
 * `#1` = 会话 ID、`#6` = 消息类型、`#8` = JSON 正文。
 */
function looksLikeMessageFields(fields) {
  const conv = fields.find((f) => f.field === 1 && f.wire === 2)
  const kind = fields.find((f) => f.field === 6 && f.wire === 0)
  const body = fields.find((f) => f.field === 8 && f.wire === 2)
  return Boolean(conv && kind && body && isConvIdBuffer(conv.value)
    && Buffer.isBuffer(body.value) && body.value.length > 0 && body.value[0] === 0x7b)
}

/**
 * 递归找消息对象，**不假设消息列表在第几层**。
 *
 * 旧结构是 `#6.#301.#1[]`，2026-11 的新结构（`get_message_by_init`）是
 * `#6.#2043.#1.#2[]` —— 字段号还会变。所以判据换成「字段集像不像一条消息」，
 * 两种结构、以及以后换壳都能覆盖。
 *
 * @param {Buffer} buf
 * @param {number} depth 递归上限，防炸
 * @param {Array} out
 */
function collectMessageFields(buf, depth = 0, out = []) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || depth > 10 || out.length >= 500) return out
  let fields
  try { fields = parseFields(buf, { tolerant: true }) } catch { return out }
  if (fields.length === 0) return out
  if (looksLikeMessageFields(fields)) { out.push(fields); return out }
  for (const f of fields) {
    if (f.wire !== 2 || !Buffer.isBuffer(f.value) || f.value.length === 0) continue
    if (f.value[0] === 0x7b /* '{' */) continue   // JSON 正文不用往里钻
    collectMessageFields(f.value, depth + 1, out)
  }
  return out
}

/** 在一个子树里找 sec_uid（`MS4wLjAB…`），找不到返回 '' */
function findSecUid(buf, depth = 0) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || depth > 4) return ''
  let fields
  try { fields = parseFields(buf, { tolerant: true }) } catch { return '' }
  for (const f of fields) {
    if (f.wire !== 2 || !Buffer.isBuffer(f.value)) continue
    const s = f.value.toString('utf8')
    if (SEC_UID_TEXT_RE.test(s)) return s
  }
  for (const f of fields) {
    if (f.wire !== 2 || !Buffer.isBuffer(f.value) || f.value.length === 0) continue
    const s = findSecUid(f.value, depth + 1)
    if (s !== '') return s
  }
  return ''
}

/**
 * 会话参与者：`#1 { #1 = uid, #5 { #9 …, #13 = sec_uid } }` → `Map<uid, sec_uid>`。
 *
 * 🔴 新接口的消息里**没有** `#14 sec_uid`（旧结构有）。但同一份响应里的会话快照
 *    带参与者列表，自己那一侧也有 sec_uid —— 补上它，`fromMe` 才能按 sec_uid
 *    比对算出来。否则 `learnSelfUid()` 既学不到「我是谁」，也永远不知道哪条是
 *    自己发的（消息会被当成对方发的）。
 */
function collectParticipantSecUids(buf, depth = 0, map = new Map()) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || depth > 8) return map
  let fields
  try { fields = parseFields(buf, { tolerant: true }) } catch { return map }
  const uid = fields.find((f) => f.field === 1 && f.wire === 0)
  if (uid) {
    for (const f of fields) {
      if (f.wire !== 2 || !Buffer.isBuffer(f.value) || f.value.length === 0) continue
      // 实测结构：`#1.#6.#1 { #1 = uid, #5 = sec_uid 字符串 }`，`#5` 直接就是
      // sec_uid（55 字节）。`parseTree()` 会把这段文本误解析成 `#5{#9,#13}`，
      // 所以这里先按明文测一遍，测不到再退回递归找。
      const direct = f.value.toString('utf8')
      const sec = SEC_UID_TEXT_RE.test(direct) ? direct : findSecUid(f.value)
      if (sec !== '') { map.set(String(uid.exact), sec); break }
    }
  }
  for (const f of fields) {
    if (f.wire !== 2 || !Buffer.isBuffer(f.value) || f.value.length === 0) continue
    collectParticipantSecUids(f.value, depth + 1, map)
  }
  return map
}

/**
 * 把一个消息节点还原成字段树。
 *
 * 优先用 `parseFields(node.value)` 重新解一遍再走 `fieldsToNodes()`（能纠回被
 * `parseTree()` 误判成子树的会话 ID）；解不开时退回 `parseTree()` 的 children。
 */
function messageNodesOf(node) {
  const raw = node?.value
  if (Buffer.isBuffer(raw) && raw.length > 0) {
    try {
      const fields = parseFields(raw, { tolerant: true })
      if (fields.length > 0) return fieldsToNodes(fields)
    } catch { /* 退回 parseTree 的结果 */ }
  }
  return Array.isArray(node?.children) ? node.children : []
}

/**
 * 一条消息节点 → 统一的消息形状。新旧结构共用（字段号一致的部分就用它）。
 *
 * @param {Array} c 消息的字段节点
 * @param {string} selfSecUid 我自己的 sec_uid（用来算 `fromMe`）
 * @param {Map<string,string>|null} secByUid 会话参与者 uid → sec_uid（新结构补全用）
 */
function decodeMessageNode(c, selfSecUid = '', secByUid = null) {
  const kind = getInt(c, 6) ?? 0
  const senderId = (getIntString(c, 7) || '').replace(/^0$/, '')
  const timeMs = getInt(c, 10) ?? 0
  // 旧结构的消息自带 #14 sec_uid；新结构没有 —— 用会话参与者的 sec_uid 补。
  const secUid = getString(c, 14) || (secByUid && senderId ? String(secByUid.get(senderId) || '') : '')
  // fish-soul：#2 是会话类型（1 = 单聊，2 = 群聊）；#9 的扩展属性里有时带发送者昵称
  const convType = getInt(c, 2) ?? 0
  let senderName = ''
  for (const a of c.filter((x) => x.field === 9 && x.kind === 'message')) {
    const k = getString(a.children, 1)
    const v = getString(a.children, 2)
    if (v && /^(s:)?(sender_?nick_?name|nick_?name|sender_?name|user_?name)$/i.test(k)) { senderName = v.trim().slice(0, 40); break }
  }

  // 正文：优先 #8 的 JSON
  let text = ''
  let tips = ''
  let shareAweme = null
  let rawJson = null
  const j = getString(c, 8)
  if (j) {
    try {
      const o = JSON.parse(j)
      // 🔴 整个 JSON 要留着：不同消息类型的载荷字段完全不同 ——
      //    文本是 {text}，图片是 {uri,width,height,...}，
      //    语音是 {duration,voiceUri,...}。只留 text 等于把类型信息丢了。
      rawJson = o
      text = String(o.text ?? o.content ?? '')
      tips = String(o.tips ?? '')
      // 旧接口的分享卡用 aweme_id；2026-11 新接口（kind 77）改成 itemId。
      // 认不出就 shareAweme 为空，filterUseful 会把整条分享消息丢掉。
      const shareId = o.aweme_id ?? o.awemeId ?? o.itemId
      if (shareId) shareAweme = String(shareId)
    } catch {
      text = j   // 不是 JSON 就当纯文本
      rawJson = { __text: j }
    }
  }
  // 有些消息正文在 #9 的属性里（key 叫 content / text）
  if (!text) {
    for (const a of c.filter((x) => x.field === 9 && x.kind === 'message')) {
      const k = getString(a.children, 1)
      const v = getString(a.children, 2)
      if (v && /^(content|text|s:content|s:text)$/i.test(k)) { text = v; break }
    }
  }

  return {
    /** 抖音自己的消息序号（越大越新；新接口可能没有这个字段） */
    seq: (getIntString(c, 17) || '').replace(/^0$/, ''),
    kind,
    senderId,
    secUid,
    time: timeMs,
    text,
    tips,
    shareAweme,
    /** 消息载荷的完整 JSON（按类型不同字段不同：text / uri / duration…） */
    raw: rawJson,
    /** 是不是文本消息（能直接回） */
    isText: kind === KIND_TEXT,
    /** 系统提示（互相关注、可以开始聊天等） */
    isSystem: Boolean(tips) || kind === 1,
    /** 是不是我自己发的（靠 sec_uid 比对，拿不到就当未知） */
    fromMe: selfSecUid ? secUid === selfSecUid : null,
    convId: getString(c, 1),
    convType,
    senderName,
  }
}

/**
 * 把 hook 抓到的一条 protobuf 响应解成消息数组。
 *
 * @param {Buffer} raw
 * @param {{ selfSecUid?: string }} opts 用来判断「谁发的」
 * @returns {{ ok:boolean, statusCode:number, statusMsg:string, messages:Array }}
 */
export function parseMessages(raw, opts = {}) {
  let tree
  try { tree = parseTree(raw) } catch (e) {
    return { ok: false, statusCode: -1, statusMsg: `解码失败：${e?.message || e}`, messages: [] }
  }

  // ⚠️ status_code 不能拿来判成败：`get_by_conversation` 成功时返回的是 **301**
  //    （protobuf 里 #1=301、#4="OK"）。真正判据是「有没有解出消息」。
  const statusCode = getInt(tree, 1) ?? -1
  const statusMsg = getString(tree, 4)

  // 数据体在 #6。
  //
  // ⚠️ 不能只信 parseTree 的结果：有的响应里 #6 会被当成普通字符串（递归解析
  //    失败），但原始字节还在。这里直接拿 `parseFields()` 里的 #6 value，
  //    后面的字段扫描本来就不依赖树结构。
  const body = tree.find((n) => n.field === 6 && n.kind === 'message')
  let data = Buffer.isBuffer(body?.value) ? body.value : null
  if (!data) {
    try {
      data = parseFields(raw, { tolerant: true }).find((f) => f.field === 6 && f.wire === 2)?.value ?? null
    } catch { data = null }
  }
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return { ok: false, statusCode, statusMsg, messages: [] }
  }

  // 找装消息列表的那一层：某个 message 字段下有 ≥1 个重复的 #1 message
  const children = body?.children ?? []
  const listHolder = children.find(
    (n) => n.kind === 'message' && n.children.some((c) => c.field === 1 && c.kind === 'message'),
  )
  const listNode = listHolder || body

  const items = listNode ? all(listNode.children, 1).filter((n) => n.kind === 'message') : []

  const selfSecUid = String(opts.selfSecUid || '')

  // 「有内容」的判据：文本 / 提示 / 分享卡（与 pickMessages 保持一致）
  const countUseful = (list) => list.filter((m) => m.text || m.tips || m.shareAweme).length

  // ① 旧结构：消息在 `#6.#301.#1[]`。解每个 item 时重新走一遍原始字段，
  //    否则 36 字节的会话 ID 会被 parseTree 误判成子树（见 fieldsToNodes 注释）。
  const fromTree = items.map((it) => decodeMessageNode(messageNodesOf(it), selfSecUid))

  // ② 新结构（2026-11 实测 `get_message_by_init`）：消息在 `#6.#2043.#1.#2[]`。
  //    字段号（`#2043`）会变，所以不赌层级，按「字段集像消息」递归扫。
  //    新结构的消息没有 #14 sec_uid，用同一份响应里的会话参与者补上。
  const secByUid = collectParticipantSecUids(data)
  const scanned = collectMessageFields(data).map(
    (f) => decodeMessageNode(fieldsToNodes(f), selfSecUid, secByUid),
  )

  // 哪份解出的「有内容消息」多就用哪份：旧接口还能解就保持旧行为，解不出来才落到新结构。
  const messages = countUseful(scanned) > countUseful(fromTree) ? scanned : fromTree

  // 按 seq 排序（接口返回的顺序不保证）
  messages.sort((a, b) => { const x=BigInt(a.seq || 0), y=BigInt(b.seq || 0); return x < y ? -1 : x > y ? 1 : 0 })

  // 这个响应里的会话 ID：全是一个会话才有值（混了多个就是污染，不能挑一个凑合）
  const convId = soleConversationId(messages)
  return { ok: messages.length > 0, statusCode, statusMsg, messages, convId }
}

/**
 * 缓存：按会话 id 存最近一次解出来的消息。
 *
 * 🔴 为什么必须有这层：
 *    抖音只在「第一次进某个会话」时请求 `get_by_conversation`，
 *    之后全走内存缓存。桥接每 20 秒轮询一次，如果每轮都指望抓到新响应，
 *    除了第一轮之外永远抓不到 —— 于是每轮都要 reload（40 秒），不可接受。
 *
 *    所以：抓到就存下来；抓不到就用上次的缓存。
 *
 * ⚠️ 缓存**要落盘**：插件热重载 / 进程重启后内存缓存就没了，
 *    而抖音那边也不会再发请求 —— 不落盘的话每次重启都要重新 reload 一次。
 *
 * key = 会话 id（`0:1:xxx:yyy`），拿不到就用好友名。
 */
const messageCache = new Map()
let cacheFile = ''
let cacheLoaded = false

/** 设置缓存文件路径（bridge 启动时调一次） */
export function setCacheFile(file) {
  cacheFile = String(file || '')
  if (cacheFile && !cacheLoaded) loadCacheFromDisk()
}

function loadCacheFromDisk() {
  cacheLoaded = true
  if (!cacheFile) return
  try {
    const raw = readFileSync(cacheFile, 'utf8')
    const obj = JSON.parse(raw)
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && v.identityVersion === 1 && Array.isArray(v.messages) && v.messages.length) messageCache.set(k, v)
    }
  } catch { /* 没有或坏了都当空缓存 */ }
}

function saveCacheToDisk() {
  if (!cacheFile) return
  try {
    const obj = {}
    for (const [k, v] of messageCache) obj[k] = v
    writeFileSync(cacheFile, JSON.stringify(obj), 'utf8')
  } catch { /* 写不进去不影响主流程 */ }
}

/** 存一份缓存 */
export function cacheMessages(key, messages, meta = {}) {
  // ⚠️ 空数组不写缓存 —— 否则「这一轮没抓到」会被当成「这个会话没消息」，
  //    后面每次都直接返回空，永远不再尝试。
  if (!key || !Array.isArray(messages) || messages.length === 0) return
  messageCache.set(key, { messages, at: Date.now(), ...meta, identityVersion: 1 })
  saveCacheToDisk()
}

/** 取缓存（没有就 null） */
export function cachedMessages(key) {
  return messageCache.get(key) || null
}

/** 清缓存（reload 后调用，因为 seq 可能整体变） */
export function clearCache() {
  messageCache.clear()
  saveCacheToDisk()
}

/** 缓存统计（排障用） */
export function cacheStats() {
  return [...messageCache].map(([k, v]) => ({ key: k, n: v.messages.length, at: v.at }))
}

/**
 * 后台累积器：定期把 hook 里的新响应解出来存进缓存。
 *
 * 🔴 这是让「接口路径」真正可用的关键。
 *
 *    抖音只在**首次进某个会话**时请求 `get_by_conversation`，之后走内存缓存。
 *    所以「按需读」一定会卡在「这一轮没数据」上，然后被迫 reload（30~40 秒）。
 *
 *    但如果**一直挂着 hook**，抖音自己刷新（轮询推送、切会话、刷新页面）
 *    产生的响应都会被截下来。累积器每 2 秒扫一次 hook，解出消息就进缓存。
 *    之后 `readDM` 直接命中缓存 —— 3ms。
 *
 * @returns {() => void} 停止函数
 */
export function startCollector(browser, opts = {}) {
  const every = Math.max(1000, Number(opts.intervalMs) || 2000)
  let stopped = false
  let timer = null

  const tick = async () => {
    if (stopped) return
    try {
      const captured = await drain(browser)
      const pb = (captured || []).filter((c) => c.kind === 'pb' && MESSAGE_URL_RE.test(String(c.url)))
      if (pb.length) {
        const me = await selfInfo(browser).catch(() => ({ secUid: '' }))
        const parsed = pickMessages(captured, { selfSecUid: me.secUid })
        if (parsed.messages?.length) {
          // 按会话 id 分组缓存
          const byConv = new Map()
          for (const m of parsed.messages) {
            const k = m.convId || '*'
            if (!byConv.has(k)) byConv.set(k, [])
            byConv.get(k).push(m)
          }
          for (const [k, list] of byConv) cacheMessages(k, list, { source: parsed.source })
          // 也存一份到 '*'（不分会话的兜底）
          cacheMessages('*', parsed.messages, { source: parsed.source })
          if (typeof opts.onMessages === 'function') {
            try { opts.onMessages(parsed.messages) } catch { /* 上层出错不影响收集 */ }
          }
        }
      }
    } catch { /* 这一轮失败无所谓，下一轮再来 */ }

    if (!stopped) timer = setTimeout(tick, every)
  }

  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

/**
 * 强制触发一次「拉消息」请求。
 *
 * 🔴 问题：会话已经打开过时，抖音**不会重新请求** —— 数据在内存缓存里。
 *    表现：hook 装好了、会话也进了，`drain()` 却是空的。
 *
 * 试过但**不通**的路（记下来，免得再走一遍）：
 *
 *   · 在页面里直接 `fetch('imapi.douyin.com/v1/message/get_by_conversation')`
 *     → 请求体不是纯 protobuf，而是「base64 外壳 + 内层 protobuf」的自定义帧
 *       （hex 开头 `434b3043` 就是 ASCII `CK0CEJZO` 的 base64）。
 *       空 body 或乱拼 body 都换不回数据。
 *
 *   · 只靠 UI 切换会话
 *     → 切回来时抖音仍走内存缓存，不发请求。
 *
 * 现在用的：**reload 一次**（清内存缓存），再重新开面板进会话。
 * 慢（约 10 秒），但确定有效，而且只在「hook 里没数据」时才走。
 *
 * @returns {Promise<{ok:boolean, via:string}>}
 */
export async function triggerFetch(browser) {
  // reload 到首页 —— 这一步会清掉抖音的 IM 内存缓存
  await browser.goto('https://www.douyin.com/jingxuan', { settleMs: 8000 })
  return { ok: true, via: 'reload' }
}

/**
 * 从 hook 抓到的响应里，挑出「消息历史」那条并解析。
 *
 * 🔴 **必须按会话挑，不能只看条数。**
 *    以前是「解出来的消息最多就算赢」，完全不看这些消息属于哪个会话 ——
 *    轮询期间抖音会推好几个会话的响应，于是可能把 A 会话的消息当成 B 会话的，
 *    这就是「串会话」的根源（见 docs/douyin-identity-validation.md）。
 *
 *    现在：
 *      · 传了 `convId` → 只要那个会话的响应，别的会话一律不要；
 *      · 没传 → 要求响应内部**只有一个**会话（多会话混在一起时无法判断，宁可不要）。
 *    两种情况都拿不到时返回 `ok:false` 并说明原因，调用方不能退回昵称信任。
 *
 * @param {Array} captured drain() 的结果
 * @param {{ selfSecUid?: string, convId?: string }} opts convId = 只认这个会话
 * @returns {{ ok:boolean, messages:Array, source?:string, convId?:string, error?:string }}
 */
export function pickMessages(captured, opts = {}) {
  const hits = (captured || []).filter(
    (x) => x.kind === 'pb' && MESSAGE_URL_RE.test(String(x.url)),
  )
  if (!hits.length) return { ok: false, messages: [], error: '没抓到消息接口的响应' }

  const want = String(opts.convId ?? '').trim()
  // 历史分页经常比初始化响应条数更多，先比消息时间，再以条数打破平局。
  // 否则新消息所在的较短响应会被旧历史覆盖。
  let best = null
  const candidates = []
  const latest = (messages) => Math.max(0, ...messages.map((m) => Number(m.time) || 0))
  const newer = (messages) => !best || latest(messages) > best.latest
    || (latest(messages) === best.latest && messages.length > best.useful)
  let mixed = 0
  for (const h of hits) {
    try {
      const raw = Buffer.from(h.b64, 'base64')
      const parsed = parseMessages(raw, opts)
      const useful = parsed.messages.filter((m) => m.text || m.tips || m.shareAweme)
      if (!useful.length) continue
      const ids = new Set(useful.map((m) => String(m.convId ?? '').trim()).filter((x) => x !== ''))
      // 指定了会话：只要它，别的会话直接跳过
      if (want !== '') {
        if (!ids.has(want)) continue
        const mine = useful.filter((m) => String(m.convId ?? '').trim() === want)
        const candidate = { parsed, useful: mine.length, latest: latest(mine), msgs: mine, url: h.url, bytes: raw.length, convId: want }
        candidates.push(candidate)
        if (newer(mine)) best = candidate
        continue
      }
      // 没指定：要求响应内部只有一个会话
      if (ids.size !== 1) { if (ids.size > 1) mixed++; continue }
      const only = [...ids][0]
      const candidate = { parsed, useful: useful.length, latest: latest(useful), msgs: useful, url: h.url, bytes: raw.length, convId: only }
      candidates.push(candidate)
      if (newer(useful)) best = candidate
    } catch { /* 这条解不开就跳过 */ }
  }

  if (!best) {
    return {
      ok: false,
      messages: [],
      error: want !== ''
        ? `没抓到会话 ${want} 的消息响应`
        : (mixed > 0 ? '抓到的响应里混了多个会话，无法确定归属' : '抓到的响应都解不开'),
    }
  }
  // 一轮里可能同时收到两种响应：一份较大的历史快照，以及若干份只含一条
  // 新消息的增量响应。历史快照不能覆盖增量，但增量之间必须合并，否则同一轮
  // 多人连续发消息时只会留下最后一条。大于一条且明显更旧的响应视为历史快照；
  // 单条响应保留并按稳定指纹去重。
  const merged = []
  const seen = new Set()
  const add = (m) => {
    const key = [m.convId, m.senderId, m.seq, m.time, m.text, m.tips, m.shareAweme].map((x) => String(x ?? '')).join('|')
    if (seen.has(key)) return
    seen.add(key)
    merged.push(m)
  }
  for (const candidate of candidates) {
    if (candidate.convId !== best.convId) continue
    const isPrimary = candidate === best
    const isSingleton = candidate.msgs.length <= 1
    if (isPrimary || isSingleton) for (const m of candidate.msgs) add(m)
  }
  merged.sort((a, b) => {
    const x = BigInt(a.seq || 0), y = BigInt(b.seq || 0)
    if (x !== 0n || y !== 0n) return x < y ? -1 : x > y ? 1 : 0
    return (Number(a.time) || 0) - (Number(b.time) || 0)
  })
  return { ...best.parsed, messages: merged, convId: best.convId, source: best.url, bytes: best.bytes }
}
