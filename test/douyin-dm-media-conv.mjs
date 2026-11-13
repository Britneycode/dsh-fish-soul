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
function node({ convId = CONV_ID, senderId = PEER, kind = 7, seq = '1', time = 1700000000000, payload = { text: '在吗' }, senderName = '' }) {
  const parts = [
    bytes(1, Buffer.from(convId)),
    field(2, 1),
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

test('接口消息不带昵称时，用唯一会话 ID 兜底', async () => {
  const b = fakeBrowser([capture([node({ payload: { text: '在吗' } })])])
  assert.equal(await resolveConvId(b, UNAME), CONV_ID, 'senderName 为空也要能定出会话')
})

test('只发过媒体的会话，也能定出会话 ID', async () => {
  const b = fakeBrowser([capture([node({ kind: 11, payload: { uri: 'https://example.invalid/a.jpg' } })])])
  assert.equal(await resolveConvId(b, UNAME), CONV_ID)
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
  const countLine = src.slice(src.indexOf('const countUseful'), src.indexOf('const countUseful') + 300)
  assert.ok(
    /m\.convId \|\| m\.seq \|\| m\.senderId/.test(countLine),
    'countUseful 要认 convId/seq/senderId，否则只发媒体的新结构会被判成「解不出」',
  )
  assert.ok(
    !/const countUseful = \(list\) => list\.filter\(\(m\) => m\.text \|\| m\.tips \|\| m\.shareAweme\)\.length/.test(src),
    'countUseful 不能退回只认文本的旧判据',
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
