/**
 * 抖音私信的「消息被整条丢掉」两处。
 *
 *   ① `filterUseful` 只认 text / tips / shareAweme。对方发图片 / 表情 / 语音 /
 *      视频卡片时这三个字段全空 ⇒ 整条消息被当成「没有内容」丢掉。
 *      而 kind / senderId / seq / convId 还在 —— 这些字段存在就说明它是一条
 *      真消息，只是没有文本。
 *   ② `resolveConvId` 靠消息里的 senderName 去匹配昵称。接口消息经常不带昵称
 *      （senderName 是空字符串），匹配永远失败 ⇒ 会话 ID 拿不到 ⇒ 发送前的
 *      身份校验永远「不敢发」。
 *
 * 两条合起来的后果：只发过媒体的会话，连「这批消息属于哪个会话」都定不下来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../lib/channels/vendor/douyin-bridge/douyin-dm.mjs'
import { parseMessages as apiParseMessages } from '../lib/channels/vendor/douyin-bridge/douyin-api.mjs'

const { filterUseful, resolveConvId } = __test

const CONV_ID = '0:1:100001:200002'
const OTHER_CONV_ID = '0:1:100001:300003'
const PEER = '200002'
const UNAME = '测试联系人'

// 旧结构 protobuf 编码器（与 test/douyin-read-cache.mjs 一致）
const v = (n) => {
  n = BigInt(n)
  const b = []
  while (n >= 128n) { b.push(Number(n & 127n) | 128); n >>= 7n }
  b.push(Number(n))
  return Buffer.from(b)
}
const field = (id, n) => Buffer.concat([v(id * 8), v(n)])
const bytes = (id, b) => Buffer.concat([v(id * 8 + 2), v(b.length), b])

/**
 * 一条消息节点：#1 会话 ID、#6 kind、#7 发送者 uid、#8 正文 JSON、#10 时间、
 * #17 序号；#9 里带 sender_nickname 时解出来才有昵称。
 */
function node({ convId = CONV_ID, senderId = PEER, kind = 7, seq = '1', time = 1700000000000, payload = { text: '在吗' }, senderName = '', convType = 1 }) {
  const parts = [
    bytes(1, Buffer.from(convId)),
    field(2, convType),
    field(6, kind),
    field(7, senderId),
    bytes(8, Buffer.from(JSON.stringify(payload))),
    field(10, time),
    field(17, seq),
  ]
  if (senderName !== '') {
    parts.push(bytes(9, Buffer.concat([bytes(1, Buffer.from('sender_nickname')), bytes(2, Buffer.from(senderName))])))
  }
  return Buffer.concat(parts)
}

/** 包装成一条 hook 抓到的响应 */
function capture(nodes) {
  const body = bytes(6, bytes(301, Buffer.concat(nodes.map((n) => bytes(1, n)))))
  return { kind: 'pb', url: 'https://imapi.douyin.com/v1/message/get_by_conversation', b64: body.toString('base64') }
}

/** 假浏览器：hook 缓存里放响应，页面里没有别的信息 */
function fakeBrowser(captures) {
  return {
    eval: async (script) => {
      if (script.includes('__dyIM.peek')) return captures
      if (script.includes('localStorage')) return { secUid: '', nickname: '' }
      return null
    },
  }
}

/** 解出响应里的消息（走真实解码，不手搓消息对象） */
function decode(captures) {
  return apiParseMessages(Buffer.from(captures.b64, 'base64'), {}).messages
}

test('图片这类媒体消息没有文本，但不能被当成空消息丢掉', () => {
  // 图片：正文 JSON 里只有图片信息，没有 text / tips / shareAweme
  const media = decode(capture([node({ kind: 11, payload: { uri: 'https://example.invalid/a.jpg', width: 100, height: 100 } })]))
  assert.equal(media.length, 1)
  assert.equal(media[0].text, '', '媒体消息本来就没有文本')
  assert.equal(media[0].tips, '')
  assert.equal(media[0].shareAweme, null)

  const kept = filterUseful(media)
  assert.equal(kept.length, 1, '媒体消息必须留下，不能因为没有文本就丢')
  assert.equal(kept[0].kind, 11)
  assert.equal(kept[0].senderId, PEER)
  assert.equal(kept[0].convId, CONV_ID)
})

test('只有部分身份字段的消息也要留下', () => {
  // senderId / seq / convId 任意一个存在，都说明这是一条真消息
  for (const m of [{ senderId: PEER }, { seq: '3' }, { convId: CONV_ID }]) {
    assert.equal(filterUseful([m]).length, 1, `带 ${Object.keys(m)[0]} 的消息必须留下`)
  }
})

test('只有 kind 的空壳必须丢掉（空壳的 kind 也非 0，实测 58）', () => {
  // 这是上一版踩过的坑：把 kind 放进判据后，「解出一堆空壳」的结构会赢过
  // 「解出真消息」的结构（countUseful 挑结构、pickMessages 挑响应都会挑错）。
  assert.deepEqual(filterUseful([{ kind: 58 }, { kind: 7, text: '' }]), [])
})

test('什么都没有的空壳消息仍然丢掉', () => {
  assert.deepEqual(filterUseful([{}, { text: '', tips: '', shareAweme: null }]), [])
})

test('协议控制帧不算消息（#128 串会话根因）', () => {
  // kind=50001 且带 command_type 的控制帧（登录态同步、会话标记等）也有
  // convId / seq / senderId。放它们过判据，会被当成「这轮读到的会话」，它的
  // convId 写进游标 ⇒ 多轮轮询后所有会话被写成同一个人（记忆记错人、回复发错窗口）。
  const control = { kind: 50001, text: '', tips: '', shareAweme: null,
    convId: CONV_ID, seq: '99', senderId: PEER, raw: { command_type: 1 } }
  assert.deepEqual(filterUseful([control]), [], 'kind=50001 的控制帧必须丢掉')

  // raw.command_type 存在但 kind 不是 50001 —— 也是控制帧，同样丢。
  const ctOnly = { kind: 7, text: '', tips: '', shareAweme: null,
    convId: CONV_ID, seq: '98', senderId: PEER, raw: { command_type: 2 } }
  assert.deepEqual(filterUseful([ctOnly]), [], '带 command_type 的帧必须丢掉')

  // 真消息（文本 + command_type 不在 raw 里）不受影响。
  const real = { kind: 7, text: '在吗', tips: '', shareAweme: null,
    convId: CONV_ID, seq: '1', senderId: PEER, raw: { text: '在吗' } }
  assert.equal(filterUseful([real]).length, 1, '真文本消息必须留下')
})

test('接口消息不带昵称时，昵称匹配不上就拒绝（#169 删盲兜底）', async () => {
  const b = fakeBrowser([capture([node({ payload: { text: '在吗' } })])])
  assert.equal(await resolveConvId(b, UNAME), '', 'senderName 为空、昵称对不上时必须返回空——唯一会话 ID 兜底已被 #169 删除（不看昵称的兜底会串会话）')
})

test('只发过媒体的会话，昵称对不上同样拒绝（媒体消息的 senderName 也常为空）', async () => {
  const b = fakeBrowser([capture([node({ kind: 11, payload: { uri: 'https://example.invalid/a.jpg' } })])])
  assert.equal(await resolveConvId(b, UNAME), '', '媒体会话靠昵称定不出身份时返回空，走「拿不到身份」路径')
})

test('昵称对得上时，用昵称匹配到的那个会话', async () => {
  const b = fakeBrowser([
    capture([node({ convId: OTHER_CONV_ID, senderName: '别人' })]),
    capture([node({ convId: CONV_ID, senderName: UNAME })]),
  ])
  assert.equal(await resolveConvId(b, UNAME), CONV_ID)
})

test('多个会话混在一起时不能猜', async () => {
  const b = fakeBrowser([
    capture([node({ convId: CONV_ID })]),
    capture([node({ convId: OTHER_CONV_ID })]),
  ])
  assert.equal(await resolveConvId(b, UNAME), '', '会话 ID 不唯一时必须当作拿不到')
})

// ── ④ #169 P0：兜底只认「唯一**单聊**」，群不许被当成会话身份的证据 ──
//
// 真机症状：`resolveConvId` 的 `sole.size === 1` 兜底把「面板里唯一抓到的会话」当成目标。
// 读群/陌生人会话时，面板里唯一抓到的往往是主人那条**单聊**（或那个群本身），
// 于是群消息被错配到主人的单聊 convId ⇒ 同一条消息按主人私聊入库（记忆记错人、回复发错窗口）。
const GROUP_CONV_ID = '0:2:7300'

test('#169 面板里只有一个群（convType=2）时不许兜底成会话 ID', async () => {
  const b = fakeBrowser([capture([node({ convId: GROUP_CONV_ID, convType: 2, payload: { text: '群里说话' } })])])
  assert.equal(await resolveConvId(b, UNAME), '', '群不是单聊形状，兜底必须空')
})

test('#169 群和单聊混在同一份响应里时不许兜底', async () => {
  // 单聊那条本来能兜底出 CONV_ID，但同批里有群 ⇒ 不唯一/不纯，必须空
  const b = fakeBrowser([capture([
    node({ convId: CONV_ID, payload: { text: '私聊' } }),
    node({ convId: GROUP_CONV_ID, convType: 2, payload: { text: '群里' } }),
  ])])
  assert.equal(await resolveConvId(b, UNAME), '', '有群混入时不能把单聊当成唯一证据')
})

test('#169 昵称对得上群里的发送者时，仍不许把群兜底成单聊 convId', async () => {
  // 即使 senderName 命中了 want，群会话也不是单聊 —— found 同样只收单聊，必须空
  const b = fakeBrowser([capture([node({ convId: GROUP_CONV_ID, convType: 2, senderName: UNAME, payload: { text: '是我' } })])])
  assert.equal(await resolveConvId(b, UNAME), '', '群里的同名发送者不能把群错配成单聊')
})

test('#169 纯单聊（无群）但昵称对不上：同样不许兜底', async () => {
  const b = fakeBrowser([capture([node({ convId: CONV_ID, payload: { text: '在吗' } })])])
  assert.equal(await resolveConvId(b, UNAME), '', '昵称对不上时单聊也不许兜底——「唯一单聊」不看昵称，正是串会话根源')
})

// ── ③ 推送路的帧过滤也必须用同一套判据 ──
//
// 上一轮只修了 `filterUseful` 函数本体，但 `drainPushFrames` 里还有一处**内联**的
// `filter((m) => m.text || m.tips || m.shareAweme)` —— 那是推送帧的入口。只发媒体的
// 帧会在那里被整帧丢掉，于是推送路既收不到媒体消息，也拿不到这帧的 convId
// （下面 `ids` 是从 useful 里取的）。症状是「陌生人只发图片/表情，永远收不到」。
test('推送路 drainPushFrames 的过滤走 filterUseful，不能自己内联一套旧判据', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(
    new URL('../lib/channels/vendor/douyin-bridge/douyin-dm.mjs', import.meta.url),
    'utf8',
  )
  const start = src.indexOf('export function drainPushFrames')
  assert.ok(start >= 0, 'drainPushFrames 要还在')
  const body = src.slice(start, src.indexOf('\nexport ', start + 10))
  assert.ok(
    /const useful = filterUseful\(parsed\.messages\)/.test(body),
    '推送帧的过滤要用 filterUseful，不能内联 m.text || m.tips || m.shareAweme',
  )
  assert.ok(
    !/\(m\) => m\.text \|\| m\.tips \|\| m\.shareAweme\)/.test(body),
    '推送路里不能再出现只认文本的内联过滤',
  )
})

// ── ④ 挑响应（pickMessages）与挑结构（countUseful）同样不能只认文本 ──
test('douyin-api 里挑响应/挑结构都不再把媒体消息当空', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(
    new URL('../lib/channels/vendor/douyin-bridge/douyin-api.mjs', import.meta.url),
    'utf8',
  )
  // 判据本体已收口到 `isUsefulMessage`（全仓唯一一份，三个调用点都走它）。
  // 断言对象跟着契约变：不再查某个局部变量长什么样，而是查
  // ① 判据本体认 convId/seq/senderId；② 两处调用点真的走了它，没有内联副本。
  const predLine = src.slice(src.indexOf('export function isUsefulMessage'), src.indexOf('export function isUsefulMessage') + 400)
  assert.ok(
    /m\.convId \|\| m\.seq \|\| m\.senderId/.test(predLine),
    'isUsefulMessage 要认 convId/seq/senderId，否则只发媒体的新结构会被判成「解不出」',
  )
  assert.ok(
    !/[^a-zA-Z]m\.text \|\| m\.tips \|\| m\.shareAweme \|\| m\.convId/.test(src.replace(predLine, '')),
    '除了 isUsefulMessage 本体，别处不能再出现内联的同一套判据（#128 就是内联副本漏修）',
  )
})

// ── ⑤ fromMe 必须是三态，不能压成布尔 ──
//
// `decodeMessageNode` 在拿不到 selfSecUid 时给 `fromMe: null`（算不出谁发的）。
// `shapeResult` 以前写的是 `fromMe: m.fromMe === true` —— 把 null 和 false
// **压成同一个值**。于是「算不出谁发的」被当成「对方发的」，她自己刚回出去的话
// 下一轮又被当成对方的新消息注入回去（真机症状：她把刚发的表情包当成对方发的，
// 还回一句「这不是你发的表情包吗」）。
test('shapeResult 的 fromMe 保留三态（null 不能压成 false）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(
    new URL('../lib/channels/vendor/douyin-bridge/douyin-dm.mjs', import.meta.url),
    'utf8',
  )
  assert.ok(
    /fromMe: m\.fromMe === true \? true : m\.fromMe === false \? false : null/.test(src),
    'shapeResult 的 fromMe 要保留三态（true / false / null），不能写成 === true',
  )
  assert.ok(
    !/fromMe: m\.fromMe === true,\n\s+system:/.test(src),
    '不能再退回把 null 压成 false 的旧写法',
  )
})

// ── ⑥ #169 P0：跨会话错配的完整根因链 ──
//
// 真机症状：主人、叔叔、群三个会话共用同一个主人 convId。两条路径各中一招：
//
//   ① 首读毒化：首次接触（无 expectConvId）时，hook 缓冲里躺着**上一轮读别的会话**
//      （比如主人）留下的响应。readDMViaApi 第①步 apiDrain 把它倒出来，
//      pickMessages(convId='') 只要求「响应内部唯一会话」——主人那条完全合格
//      ⇒ 直接当成本轮结果返回 ⇒ 叔叔的收件箱从第一条起就被灌进主人的消息，
//      游标还被钉死到主人 convId。
//   ② 盲兜底错配：resolveConvId 的 sole.size===1 兜底不看 uname、不限时间窗，
//      缓冲里只有主人单聊时，读「叔叔」也返回主人 convId。
//
// 修法：首次接触只信「本次读取动作之后」触发的响应；盲兜底整个删掉，
// 昵称匹配不上就返回 ''（宁可拒绝，不猜）。
const MASTER_CONV_ID = '0:1:100001:999999'

/** 首读场景的假浏览器：hook 缓冲里躺着主人那条遗留响应，CDP 侧没有新响应 */
function leftoverBrowser(captures) {
  return {
    // 面板/导航：模拟「已在抖音页面、面板开着、会话列表里没有目标」——
    // step④ 走完 enterChat 拿不到新证据，本轮必须以失败收场（而不是拿遗留顶包）
    goto: async () => {},
    eval: async (script) => {
      if (script.includes('__dyIM.drain()')) return captures
      if (script.includes('__dyIM')) return true
      if (script.includes('localStorage')) return { secUid: '', nickname: '' }
      if (script.includes('location.href')) return 'https://www.douyin.com/jingxuan'
      if (script.includes('conversation-item')) return []
      return null
    },
    imResponses: () => [],
    responseBody: async () => { throw new Error('none') },
  }
}

test('#169 首次接触时，hook 缓冲里别的会话的遗留响应不能当成本轮结果', async () => {
  const { readDMViaApi } = await import('../lib/channels/vendor/douyin-bridge/douyin-dm.mjs')
  const { clearCache } = await import('../lib/channels/vendor/douyin-bridge/douyin-api.mjs')
  clearCache()
  // 上一轮读主人留下的响应还在 hook 缓冲里；现在首次读「叔叔」（无 expectConvId）
  const b = leftoverBrowser([capture([node({ convId: MASTER_CONV_ID, payload: { text: '主人的话' } })])])
  const r = await readDMViaApi({ browser: b, uname: '叔叔', limit: 30 })
  assert.equal(r.ok, false, '首读叔叔绝不能把主人那条遗留响应当成本轮结果（串会话）')
  assert.notEqual(r.convId, MASTER_CONV_ID, 'convId 绝不能是主人的会话')
  clearCache()
})

test('#169 缓冲里只有别的单聊时，盲兜底不许把它的 convId 错配给目标昵称', async () => {
  // 接口消息不带 senderName（常态），昵称匹配不上；缓冲里唯一单聊是主人那条。
  // 旧实现的 sole.size===1 兜底会把主人 convId 返回给「叔叔」⇒ 串会话。
  const b = fakeBrowser([capture([node({ convId: MASTER_CONV_ID, payload: { text: '在吗' } })])])
  assert.equal(await resolveConvId(b, '叔叔'), '', '昵称对不上时必须返回空，不许拿别的单聊顶包')
})

test('#169 发送快路径：给了 since 就只能认这个时间点之后的响应', async () => {
  // 发送路径 enterChat 之后调 resolveConvId(name, since)。缓冲里躺着主人那条
  // 遗留响应（since 之前），带 since 时必须完全看不到它 —— 否则会把主人 convId
  // 报成「当前打开的会话」，发错窗口。
  const stale = capture([node({ convId: MASTER_CONV_ID, senderName: '叔叔', payload: { text: '旧' } })])
  let captured = 0
  const b = {
    imResponses: () => [],
    responseBody: async () => { throw new Error('none') },
    eval: async (script) => {
      if (script.includes('__dyIM.drain()')) return stale
      if (script.includes('__dyIM')) return true
      if (script.includes('localStorage')) return { secUid: '', nickname: '' }
      return null
    },
    // CDP 侧：since > 0 时返回空（本次进会话没触发新响应）
    imResponsesWithSince: (since) => { captured = since; return [] },
  }
  // captureImBodies 走的是 browser.imResponses(pattern, since)
  b.imResponses = (pattern, since) => { captured = since ?? 0; return [] }
  assert.equal(await resolveConvId(b, '叔叔', 42), '', '带 since 时不许采信缓冲里的遗留响应')
  assert.equal(captured, 42, 'since 要原样传给 CDP 查询（不能悄悄退回 0）')
})

test('注入筛选只认明确的 fromMe === false（未知不注入）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/channels/douyin.js', import.meta.url), 'utf8')
  // normalizeDouyinMessage：只有明确 fromMe === true 才拒（纯函数，输入可能没有 fromMe）
  assert.ok(
    /if \(!m \|\| m\.fromMe === true \|\| m\.system \|\| m\.unsupported\) return null;/.test(src),
    'normalizeDouyinMessage 要按 fromMe === true 拒绝（保持纯函数契约）',
  )
  // 注入筛选
  assert.ok(
    /filter\(i => msgs\[i\]\.fromMe === false && !msgs\[i\]\.system/.test(src),
    '注入筛选要只认 fromMe === false',
  )
  // 不能再出现 !msgs[i].fromMe 这种对 null 判真的写法
  assert.ok(
    !/!msgs\[i\]\.fromMe/.test(src),
    '不能再用 !msgs[i].fromMe（对 null 是 true，会把自己的话当对方的）',
  )
})
