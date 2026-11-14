/**
 * 导航超时清理 —— PR #112 的回归测试。
 *
 * Page.navigate 被原生确认框挡住时，send() 默认要等满 60 秒才超时。
 * 导航单独给 15 秒上限，且超时后必须把这次请求的 pending 和计时器清掉，
 * 否则对话框反复弹时 pending 会一条条积着空占到 60 秒。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Browser } from '../lib/channels/vendor/douyin-bridge/browser.mjs'

function fakeBrowser() {
  const b = new Browser({ log: () => {} })
  b.ready = true
  b.sessionId = 'sess'
  b.sent = []
  b.ws = { readyState: 1, send: (raw) => b.sent.push(JSON.parse(raw)) }
  return b
}

test('send 超时后 pending 和计时器被清掉，重试是新请求', async () => {
  const b = fakeBrowser()
  await assert.rejects(b.send('Page.navigate', { url: 'x' }, 'sess', 40), /超时/)
  assert.equal(b.pending.size, 0, '超时后 pending 必须为空')
  const p = b.send('Page.navigate', { url: 'x' }, 'sess', 1000)
  const req = b.sent.at(-1)
  assert.equal(req.id, 2, '重试用新的递增 id，不复用超时的请求')
  const slot = b.pending.get(req.id)
  b.pending.delete(req.id)
  slot.resolve({ frameId: 'ok' })
  assert.deepEqual(await p, { frameId: 'ok' })
  assert.equal(b.pending.size, 0)
})

test('默认超时仍是 60 秒（别的调用不受导航超时影响）', () => {
  const src = new Browser({ log: () => {} }).send.toString()
  assert.match(src, /timeoutMs = 60000/)
})
