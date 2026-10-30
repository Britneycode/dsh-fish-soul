/**
 * douyin-util.mjs —— 解析工具（数量 / 时长 / 相对时间）
 * 拆自 dsh-douyin-bridge lib/douyin.mjs（MIT，commit 6e4bb7f），改动见同目录 README.md。
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 解析工具 ────────────────────────────────────────────────────

/** "11.7万" → 117000 */
export function parseCount(s) {
  const t = String(s || '').trim()
  const m = /^([\d.]+)\s*([万亿wkm]?)$/i.exec(t)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return 0
  const u = (m[2] || '').toLowerCase()
  const mul = u === '万' || u === 'w' ? 1e4
    : u === '亿' ? 1e8
      : u === 'k' ? 1e3
        : u === 'm' ? 1e6 : 1
  return Math.round(n * mul)
}

/** "08:28" → 508 */
export function parseDuration(s) {
  const parts = String(s || '').trim().split(':').map(Number)
  if (parts.some((x) => !Number.isFinite(x))) return 0
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

/** "5小时前" / "10月16日" → ISO */
export function parseTime(s, now = new Date()) {
  const t = String(s || '').trim()
  if (!t) return ''
  let d = null
  let m = /^(\d+)\s*(秒|分钟|小时|天)前$/.exec(t)
  if (m) {
    const n = Number(m[1])
    const u = m[2]
    const ms = u === '秒' ? n * 1000
      : u === '分钟' ? n * 60000
        : u === '小时' ? n * 3600000
          : n * 86400000
    d = new Date(now.getTime() - ms)
  } else if (t === '刚刚') d = now
  else if (t === '昨天') d = new Date(now.getTime() - 86400000)
  else if (t === '前天') d = new Date(now.getTime() - 2 * 86400000)
  else {
    m = /^(\d{1,2})月(\d{1,2})日$/.exec(t)
    if (m) {
      d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
      if (d > now) d.setFullYear(d.getFullYear() - 1)
    }
  }
  return d ? d.toISOString() : ''
}
