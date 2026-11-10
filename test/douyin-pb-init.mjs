/**
 * 抖音私信新接口 `get_message_by_init` 的解析测试。
 *
 * fixture 是**真实抓包**（2026-11-10，27021 字节，base64 解出来的原始 protobuf），
 * 不是手写构造的：`test/fixtures/douyin-get_message_by_init.bin`。
 * 里面只摘了一个会话（20 条消息，其中 19 条有内容）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseMessages,
  pickMessages,
  conversationIdsInText,
  wsConversationId,
  MESSAGE_URL_RE,
} from '../lib/channels/vendor/douyin-bridge/douyin-api.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'douyin-get_message_by_init.bin'))

/** 主人的号（自己那一侧）的 sec_uid —— 真实抓包里的 localStorage.user_info.uid */
const SELF_SEC_UID = 'MS4wLjABAAAAP_RwsPwVksxwM5qFz2kt_IHcKPTbIyzagkq5AxCwDwY'
const CONV_ID = '0:1:146711185479164:2452390148054372'

// 旧结构用的 protobuf 编码器（和 test/douyin-exact-id.mjs 一致）
const v = (n) => {
  n = BigInt(n)
  const b = []
  while (n >= 128n) { b.push(Number(n & 127n) | 128); n >>= 7n }
  b.push(Number(n))
  return Buffer.from(b)
}
const field = (id, n) => Buffer.concat([v(id * 8), v(n)])
const bytes = (id, b) => Buffer.concat([v(id * 8 + 2), v(b.length), b])

test('真实 fixture：get_message_by_init 能解出消息 + 唯一会话 ID', () => {
  const r = parseMessages(FIXTURE, { selfSecUid: SELF_SEC_UID })

  assert.equal(r.ok, true, '应该解出消息')
  assert.equal(r.statusCode, 2043)
  assert.equal(r.statusMsg, 'OK')
  assert.ok(r.messages.length >= 2, `消息数应该 > 0，实际 ${r.messages.length}`)
  assert.equal(r.convId, CONV_ID, '唯一会话 ID 必须解出来')

  // 每条消息都带会话 ID（说明它是从 #1 字段读的，不是猜的）
  assert.ok(r.messages.every((m) => m.convId === CONV_ID))

  // 真实正文（不是空壳）
  const texts = r.messages.map((m) => m.text).filter((s) => s !== '')
  assert.ok(texts.some((s) => s.includes('抖音这边也能给你发消息')), '应解出真实文本')
  assert.ok(r.messages.filter((m) => m.text || m.tips || m.shareAweme).length > 0)
})

test('真实 fixture：发送者的 sec_uid / fromMe 能算对（新结构没有 #14）', () => {
  const r = parseMessages(FIXTURE, { selfSecUid: SELF_SEC_UID })

  // 新接口的消息里没有 #14 sec_uid，要从会话快照的参与者列表里补。
  const secUids = new Set(r.messages.map((m) => m.secUid).filter((s) => s !== ''))
  assert.deepEqual([...secUids].sort(), [
    'MS4wLjABAAAAP_RwsPwVksxwM5qFz2kt_IHcKPTbIyzagkq5AxCwDwY',
    'MS4wLjABAAAAbnfA5UIsToaG8UiFCDRK1UZYPNBQWw6O1-MgkWJoFGYOLS9kanmvV7haD2czCYGG',
  ].sort())

  // 6 条自己发的、14 条对方发的；一条都不该是 null（null = 不知道谁发的）
  assert.equal(r.messages.filter((m) => m.fromMe === true).length, 6)
  assert.equal(r.messages.filter((m) => m.fromMe === false).length, 14)
})

test('真实 fixture：分享视频卡（kind 77）的视频 id 要认出来', () => {
  const r = parseMessages(FIXTURE, { selfSecUid: SELF_SEC_UID })

  // 新接口的分享卡载荷用 itemId，不是旧接口的 aweme_id。
  // 认不出就 shareAweme 为空 → filterUseful 把它整条丢掉 → 对方分享的视频永远不入库。
  const shares = r.messages.filter((m) => m.kind === 77)
  assert.equal(shares.length, 1, 'fixture 里有一条分享卡')
  assert.equal(shares[0].shareAweme, String(shares[0].raw.itemId), '视频 id 必须从 itemId 读出来')
  assert.notEqual(shares[0].shareAweme, '', '空的话这条消息会被当成没内容丢掉')
})

test('pickMessages 认 get_message_by_init（旧正则漏了这个接口）', () => {
  assert.equal(MESSAGE_URL_RE.test('https://imapi.douyin.com/v1/message/get_message_by_init?x=1'), true)
  assert.equal(MESSAGE_URL_RE.test('https://imapi.douyin.com/v1/message/get_by_conversation?x=1'), true)
  assert.equal(MESSAGE_URL_RE.test('https://imapi.douyin.com/aweme/v1/web/im/message/list/'), true)
  assert.equal(MESSAGE_URL_RE.test('https://imapi.douyin.com/v1/stranger/get_conversation_list'), false)

  const r = pickMessages([{
    kind: 'pb',
    url: 'https://imapi.douyin.com/v1/message/get_message_by_init?x=1',
    b64: FIXTURE.toString('base64'),
  }], { selfSecUid: SELF_SEC_UID })

  assert.ok(r, '应该选中这份响应')
  assert.ok(r.messages.length > 0)
  assert.equal(r.convId, CONV_ID)
  assert.equal(r.bytes, FIXTURE.length)
})

test('旧结构 (#6.#301.#1[]) 仍能解，36 字节会话 ID 不被当成子树', () => {
  // 36 字节的 `0:1:uid:uid` 的字节碰巧是合法 protobuf —— 老代码会把它解成
  // 嵌套 message，于是 convId 变 ''。这条用例锁住旧接口的兼容性。
  const text = JSON.stringify({ text: '旧结构 hello' })
  const mk = (uid, seq, text, time) => Buffer.concat([
    bytes(1, Buffer.from(CONV_ID)),
    field(2, 1),
    field(6, 7),
    field(7, uid),
    bytes(8, Buffer.from(text)),
    field(10, time),
    field(17, seq),
  ])
  const m1 = mk('2452390148054372', '9007199254740993', JSON.stringify({ text: '第一条' }), 1700000000000)
  const m2 = mk('146711185479164', '9007199254740992', JSON.stringify({ text: '第二条' }), 1700000001000)

  const raw = bytes(6, bytes(301, Buffer.concat([bytes(1, m1), bytes(1, m2)])))
  const r = parseMessages(raw)

  assert.equal(r.ok, true)
  assert.equal(r.messages.length, 2)
  assert.equal(r.convId, CONV_ID, '旧结构的会话 ID 也必须解出来')
  assert.deepEqual(r.messages.map((m) => m.seq), ['9007199254740992', '9007199254740993'])
  assert.deepEqual(r.messages.map((m) => m.senderId), ['146711185479164', '2452390148054372'])
  assert.deepEqual(r.messages.map((m) => m.text), ['第二条', '第一条'])
})

test('WebSocket 帧兜底：只接受唯一的会话 ID，不猜', () => {
  // 纯函数：从帧文本里捞 `0:1:uid:uid`
  assert.deepEqual(conversationIdsInText(`聊天 ${CONV_ID} 结束`), [CONV_ID])
  // 重复只算一个
  assert.deepEqual(conversationIdsInText(`${CONV_ID} ${CONV_ID}`), [CONV_ID])
  // 两个不同会话 = 没法确定是哪个，调用方必须当作没捞到
  assert.deepEqual(conversationIdsInText(`${CONV_ID} 0:1:1:2`), [CONV_ID, '0:1:1:2'])
  // 嵌在更长的数字串里不算（避免把别的 id 截一段当成会话 ID）
  assert.deepEqual(conversationIdsInText(`9${CONV_ID}`), [])
  // 群聊 ID 不认
  assert.deepEqual(conversationIdsInText('0:2:146711185479164:2452390148054372'), [])
})

test('wsConversationId：唯一才返回，多会话/没帧都返回空（不猜）', async () => {
  // 用假 browser 模拟 hook 拿到的帧（text 帧 + 二进制帧两条路径）
  const fake = (frames) => ({ eval: async () => frames })

  assert.equal(await wsConversationId(fake([{ b64: `str:{"conv_id":"${CONV_ID}"}` }])), CONV_ID)
  // 二进制帧（protobuf 里字符串字段的字节也是明文 ASCII）
  const bin = Buffer.from(`x${CONV_ID}y`).toString('base64')
  assert.equal(await wsConversationId(fake([{ b64: `bin:${bin}` }])), CONV_ID)
  // 两个不同会话 → 不猜
  assert.equal(await wsConversationId(fake([{ b64: `str:${CONV_ID} 0:1:1:2` }])), '')
  // 没有帧 / eval 报错 → 空
  assert.equal(await wsConversationId(fake([])), '')
  assert.equal(await wsConversationId({ eval: async () => { throw new Error('cdp 断了') } }), '')
})
