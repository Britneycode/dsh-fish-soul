/**
 * douyin-detail.mjs —— 读视频详情：文案 + 话题 + 数据 + 评论
 * 拆自 dsh-douyin-bridge lib/douyin.mjs（MIT，commit 6e4bb7f），改动见同目录 README.md。
 */
import { sleep, parseCount } from './douyin-util.mjs'

// ── 详情 ────────────────────────────────────────────────────────

/**
 * 读视频详情：文案 + 话题 + 数据 + 评论。
 *
 * ⭐ 文案不是叶子元素 —— 正文和话题 `#xxx` 是分开的节点。
 *    做法：找左侧的话题 span，往上找父级直到长度合适。
 *
 * ⭐ 评论：`.Eh0a5CD4` 是单条容器，
 *    文本格式 `用户名 ▸ 内容 ▸ 时间·地区 ▸ 点赞 ▸ 分享 ▸ 回复`（换行分隔）
 */
export async function detail({ browser, id, commentLimit = 20 }) {
  const vid = String(id || '').trim()
  if (!vid) return { ok: false, error: '没有视频 id' }

  await browser.goto(`https://www.douyin.com/video/${vid}`, { settleMs: 11000 })
  try {
    await browser.eval('window.scrollBy(0, 500)')
    await sleep(2500)
  } catch { /* 滚不动算了 */ }

  const d = await browser.eval(`(() => {
    const out = { desc: '', tags: [], author: '', stats: {}, comments: [] }

    // ① 文案：从话题 span 往上找
    const hashSpans = []
    for (const el of document.querySelectorAll('span, a, div')) {
      if (el.children.length > 0) continue
      const t = (el.innerText || '').trim()
      if (!t.startsWith('#') || t.length < 3) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.left > 1100) continue
      hashSpans.push({ el, y: r.top })
    }
    if (hashSpans.length) {
      hashSpans.sort((a, b) => a.y - b.y)
      let node = hashSpans[0].el
      for (let i = 0; i < 6 && node.parentElement; i++) {
        const t = (node.innerText || '').trim()
        if (t.length >= 20 && t.length <= 700 && t.includes('#')) { out.desc = t; break }
        node = node.parentElement
      }
      if (!out.desc) {
        const t = (node.innerText || '').trim()
        if (t.length <= 1000) out.desc = t
      }
    }
    // 兜底
    if (!out.desc) {
      let best = ''
      for (const el of document.querySelectorAll('div')) {
        if (el.children.length > 3) continue
        const t = (el.innerText || '').trim()
        if (t.length < 20 || t.length > 700 || !/[#@]/.test(t)) continue
        const r = el.getBoundingClientRect()
        if (r.left > 1100 || r.top > 750) continue
        if (t.length > best.length) best = t
      }
      out.desc = best
    }

    out.tags = [...out.desc.matchAll(/#([^\\s#@]+)/g)].map(m => m[1]).slice(0, 12)
    const am = /@([^\\s#@]+)/.exec(out.desc)
    if (am) out.author = am[1]

    // ①-b 正文里没有 @ 时，从 DOM 里单独找作者名。
    //
    //     视频页右侧作者区一般有指向 /user/ 的链接，文字就是昵称。
    //     实测（2026-10）：不少视频的 desc 里**不带 @**，
    //     只靠正则抓 desc 会拿到空字符串。
    if (!out.author) {
      const cands = []
      for (const a of document.querySelectorAll('a[href*="/user/"]')) {
        const t = (a.innerText || '').trim()
        if (!t || t.length > 30) continue
        // 过滤掉「关注」「私信」这类按钮文字
        if (/^(关注|已关注|私信|分享|举报|更多)$/.test(t)) continue
        const r = a.getBoundingClientRect()
        if (r.width === 0) continue
        cands.push({ t, x: Math.round(r.left), y: Math.round(r.top), area: r.width * r.height })
      }
      // 作者名一般在整个页面最靠上、最靠左的那个用户链接
      cands.sort((p, q) => p.y - q.y || p.x - q.x)
      if (cands.length) out.author = cands[0].t
    }

    // ② 统计：底部那排数字，左到右 = 赞 评 藏 分
    const nums = []
    const vh = innerHeight
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      const t = (el.innerText || '').trim()
      if (!/^[\\d.]+[万亿]?$/.test(t)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.top < vh * 0.55 || r.left > 1100) continue
      nums.push({ text: t, x: Math.round(r.left) })
    }
    nums.sort((a, b) => a.x - b.x)
    const keys = ['digg', 'comment', 'collect', 'share']
    nums.slice(0, 4).forEach((n, i) => { out.stats[keys[i]] = n.text })

    // ③ 评论
    const seen = new Set()
    for (const el of document.querySelectorAll('.Eh0a5CD4, [class*="CommentItem"]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 300 || r.height < 50) continue
      const t = (el.innerText || '').trim()
      if (!t || t.length < 8) continue

      const lines = t.split('\\n').map(s => s.trim()).filter(Boolean)
      const user = lines[0] || ''
      const body = lines.slice(1).filter(l =>
        !/^(作者|置顶)$/.test(l)
        && !/^(\\d+\\s*(秒|分钟|小时|天)前|昨天|前天|\\d{1,2}月\\d{1,2}日)(\\s*·\\s*\\S+)?$/.test(l)
        && !/^\\d+$/.test(l)
        && !/^(分享|回复|展开\\d+条回复|收起)$/.test(l)
        && l !== '·' && l !== '...'
      )
      const text = body.join(' ').replace(/^[.．…]+\\s*/, '').trim()
      if (!text || text.length < 2) continue

      const key = (user + '|' + text).slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)

      const likeLine = lines.find(l => /^\\d+$/.test(l))
      out.comments.push({ user: user.slice(0, 30), text: text.slice(0, 200), like: likeLine ? Number(likeLine) : 0 })
      if (out.comments.length >= 30) break
    }

    return out
  })()`)

  return {
    ok: true,
    id: vid,
    url: `https://www.douyin.com/video/${vid}`,
    desc: String(d.desc || '').slice(0, 800),
    tags: d.tags || [],
    author: d.author || '',
    stats: Object.fromEntries(Object.entries(d.stats || {}).map(([k, v]) => [k, parseCount(v)])),
    comments: (d.comments || []).slice(0, commentLimit),
  }
}

