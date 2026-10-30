/**
 * 以下纯函数原样摘自 dsh-qq-bridge（https://github.com/Yuuyuko-uu/dsh-qq-bridge）lib/host.js，
 * 版本 1.4.2（commit 93aa874）。未做任何改动（这些函数不依赖 bridge 的其他代码）。
 * 原作者许可证全文如下。
 *
 * MIT License
 *
 * Copyright (c) 2026 Yuuyuko-uu
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * ⭐ 0.9.9：「这条是不是点了我的名」——@ 了我，或引用的是我发过的消息。纯函数，方便自测。
 */
export function 识别点名(段们, 自己QQ, 己方消息) {
  const 我 = String(自己QQ || '')
  let 点名 = false
  for (const 段 of Array.isArray(段们) ? 段们 : []) {
    if (!段 || !段.data) continue
    const 型 = String(段.type || '')
    if (型 === 'at' && 我 && String(段.data.qq || '') === 我) 点名 = true      // at 全体（qq='all'）不算
    if (型 === 'reply' && 段.data.id != null && 己方消息 && typeof 己方消息.has === 'function'
        && 己方消息.has(String(段.data.id))) 点名 = true
  }
  return 点名
}

/**
 * ⭐ 1.4.1：群里这一条要不要放进来 —— 纯函数，方便单独喂。
 *
 * 群里默认「只听点名」时，只认 @ 我 / 引用我的；但被点名之后**后面紧跟着那几句**才是
 * 真正在跟我说话的内容，全丢掉就会接不上前文。所以点名之后开一段「接听」：
 *   · 点名的那一条：收，并且把接听状态重置成「还剩 点名后接听条 条 / 到 现在 + 点名后接听秒 为止」；
 *   · 接听中进来的普通消息：收，**每收一条把剩余条数减一**（这条不算点名，不重置条数）；
 *   · 条数用光 / 过了时间：这个群自己退回「只听点名」。
 * 状态按聊天分开存（调用方按「类型:号码」存），这里只算「这一条怎么处理、下一个状态是什么」。
 *
 * @param {object} 选项
 * @param {boolean} 选项.全听 这个群是不是「谁都听」（是的话下面几个参数都不用看）
 * @param {boolean} 选项.点名 这一条是不是 @ 了我 / 引用了我
 * @param {{剩: number, 到: number}|null} 选项.接听 这个群现在的接听状态（null = 没在接听）
 * @param {number} 选项.条 配置：点名后接听条
 * @param {number} 选项.秒 配置：点名后接听秒
 * @param {number} 选项.现在 现在（毫秒时间戳）
 * @returns {{收: boolean, 接听: {剩: number, 到: number}|null, 用掉一条: boolean, 原因: string}}
 */
export function 该收这条(选项 = {}) {
  const 全听 = 选项.全听 === true
  const 点名 = 选项.点名 === true
  const 现在 = Number(选项.现在)
  const 时 = Number.isFinite(现在) ? 现在 : Date.now()
  const 条 = Math.max(0, Math.round(Number(选项.条) || 0))
  const 秒 = Math.max(0, Math.round(Number(选项.秒) || 0))
  const 旧 = 选项.接听 && typeof 选项.接听 === 'object' ? 选项.接听 : null
  if (全听) return { 收: true, 接听: null, 用掉一条: false, 原因: '这个群谁都听' }
  if (点名) {
    if (条 <= 0) return { 收: true, 接听: null, 用掉一条: false, 原因: '点了名（接听关着）' }
    return { 收: true, 接听: { 剩: 条, 到: 时 + 秒 * 1000 }, 用掉一条: false, 原因: '点了名，接着听 ' + 条 + ' 条' }
  }
  if (!旧) return { 收: false, 接听: null, 用掉一条: false, 原因: '没点名，也没在接听' }
  const 剩 = Math.round(Number(旧.剩) || 0)
  const 到 = Number(旧.到) || 0
  if (剩 <= 0) return { 收: false, 接听: null, 用掉一条: false, 原因: '接听的条数已经用光' }
  if (!(时 < 到)) return { 收: false, 接听: null, 用掉一条: false, 原因: '接听的时间过了' }
  const 下一份 = { 剩: 剩 - 1, 到 }
  return {
    收: true,
    接听: 下一份.剩 > 0 ? 下一份 : null,
    用掉一条: true,
    原因: '接听中，还剩 ' + 下一份.剩 + ' 条',
  }
}

export function 提取正文(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * ⭐ 1.1.7：把要发出去的一段文字拆成 OneBot 消息段 —— 让「@」变成真的 @。
 *
 * 以前只能发纯文本（`{type:'text'}`），模型写「@123456」到 QQ 里就是几个字。
 * 现在（规矩跟别的 OneBot 插件一样，见 OneBot 11 的 `at` 段）：
 *   · `@123456789`（纯数字，5～12 位）→ `{type:'at', data:{qq:'123456789'}}`
 *   · `@全体成员` / `@所有人` → `{type:'at', data:{qq:'all'}}`（要「能@全体」打开才认）
 *   · `@昵称` → 到群成员表里找同名的（缓存十分钟）；找到且只有一个才真 @，找不到就当普通文字
 * 返回值里相邻的纯文本会自动拼回去，别一段一个字地发。
 */
export function 拆成消息段(text, 选项 = {}) {
  const 原 = String(text == null ? '' : text)
  if (!原) return [{ type: 'text', data: { text: '' } }]
  const 允许全体 = 选项.允许全体 === true
  const 认名字 = typeof 选项.按名字 === 'function' ? 选项.按名字 : null
  const 段们 = []
  const 加文本 = (t) => {
    if (!t) return
    const 最后 = 段们[段们.length - 1]
    if (最后 && 最后.type === 'text') 最后.data.text += t
    else 段们.push({ type: 'text', data: { text: t } })
  }
  // 逐个找 @：数字号 / 全体 / 昵称
  const 正则 = /@([0-9]{5,12}|全体成员|所有人|[^\s@，。！？、：;,.!?:]{1,24})/g
  let 上个位置 = 0
  let 匹配
  while ((匹配 = 正则.exec(原)) !== null) {
    const 起 = 匹配.index
    const 待 = 匹配[1]
    加文本(原.slice(上个位置, 起))
    if (/^[0-9]{5,12}$/.test(待)) {
      段们.push({ type: 'at', data: { qq: String(待) } })
      上个位置 = 起 + 匹配[0].length
      continue
    }
    if (待 === '全体成员' || 待 === '所有人') {
      if (允许全体) 段们.push({ type: 'at', data: { qq: 'all' } })
      else 加文本(匹配[0])
      上个位置 = 起 + 匹配[0].length
      continue
    }
    // 昵称：找得到就真 @，找不到就原样留着
    let 号 = ''
    if (认名字) {
      try {
        号 = String(认名字(待) || '')
      } catch (error) {
        号 = ''
      }
    }
    if (号 && /^[0-9]{5,12}$/.test(号)) {
      段们.push({ type: 'at', data: { qq: 号 } })
      上个位置 = 起 + 匹配[0].length
      continue
    }
    加文本(匹配[0])
    上个位置 = 起 + 匹配[0].length
  }
  加文本(原.slice(上个位置))
  if (!段们.length) return [{ type: 'text', data: { text: 原 } }]
  return 段们
}

export function 提取图块(message) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.filter((b) => b && b.type === 'image' && b.attachment).slice(0, 10)
}

/**
 * ⭐ 2026-10-22：正文里那种 markdown 图片 `![名字](路径)` 也当图片发。
 *    伙伴发贴纸就是这么发的（`![小肥鱼](_stickers/feiyu-test.webp)`）——
 *    以前只认附件块，这种一律被当成普通文字发过去，QQ 那边看到的是一串 markdown。
 * @returns {净文字, 图: [{kind:'url'|'path', value}]}
 */
export function 抠正文图(文字) {
  const 图 = []
  const 净文字 = String(文字 || '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (全, 路径) => {
      const p = String(路径 || '').trim()
      if (!p) return ''
      if (/^https?:\/\//i.test(p)) {
        if (!图.some((x) => x.value === p)) 图.push({ kind: 'url', value: p })
        return ''
      }
      if (!图.some((x) => x.value === p)) 图.push({ kind: 'path', value: p })
      return ''
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { 净文字, 图 }
}
