import { Browser } from './lib/channels/vendor/douyin-bridge/browser.mjs'
import { dmList, readDM } from './lib/channels/vendor/douyin-bridge/douyin-dm.mjs'
const b = new Browser({ port: 47890 })
await b.connect?.() ?? await b.attach?.()
console.log('浏览器 ready:', b.ready)
const list = await dmList({ browser: b, limit: 10 }).catch(e => ({ ok: false, error: String(e.message) }))
console.log('会话列表:', JSON.stringify(list, null, 1).slice(0, 800))
