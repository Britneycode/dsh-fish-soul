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
  // kind / senderId / seq / convId 任意一个存在，都说明这是一条真消息
  for (const m of [{ kind: 7 }, { senderId: PEER }, { seq: '3' }, { convId: CONV_ID }]) {
    assert.equal(filterUseful([m]).length, 1, `带 ${Object.keys(m)[0]} 的消息必须留下`)
  }
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
