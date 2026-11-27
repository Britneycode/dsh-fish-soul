/**
 * #224：发完表情要把面板关掉。
 *
 * 用户反馈（2026-11-24 22:20）：鱼网页里常常开着私聊窗口、表情面板长久停留。
 * 面板是发送流程必须打开的（点表情格子），但发完不收尾就会一直挂在那儿，
 * 主人下次进会话看到一个开着的面板，还挡着输入区。
 *
 * 这里给一个够用的假 browser：ensureTargetChat 走 alreadyVerified 快路径，
 * 其余 eval 按表达式内容分派，并记录面板的开关状态。
 */
import assert from 'node:assert/strict';
import { sendEmoji } from '../lib/channels/vendor/douyin-bridge/douyin-dm.mjs';

/** panelOpen：面板状态由假页面维护；clickedOutside 记录收尾点击。 */
let panelOpen = false;
let closedByOutsideClick = 0;
// 点之前是空的，点完才出现这条（hasNewBubble 比的是集合里有没有新东西）
let bubbles = [];
const newBubbleAfter = ['https://img/1'];

const browser = {
  sessionId: 'S',
  targetId: 'T',
  async send() { return {}; },
  async eval(expr) {
    const e = String(expr);
    // 输入框在不在（ensureTargetChat 的 alreadyVerified 快路径）
    if (/hasInput|contenteditable|textarea/i.test(e) && e.length < 400) return true;
    // 数表情气泡
    if (e.includes('MessageItemEmojiemojiBox') && e.includes('out.push')) return bubbles;
    // 表情名对照表
    if (e.includes('emojiEmojiItememojiItem')) {
      bubbles = newBubbleAfter;
      if (e.includes('return items.map') || e.includes('const all')) {
        return { ok: true, name: '比心', src: 'https://img/1', all: [{ src: 'https://img/1', name: '比心' }] };
      }
      bubbles = newBubbleAfter;
      return { ok: true, name: '比心', src: 'https://img/1', all: [{ src: 'https://img/1', name: '比心' }] };
    }
    // 关面板：找面板位置然后点外面
    if (e.includes('emojiPanel') && e.includes('elementFromPoint')) {
      if (!panelOpen) return 'gone';
      panelOpen = false;
      closedByOutsideClick++;
      return 'clicked';
    }
    // 面板是否弹出
    if (e.includes('emojiPanel')) { panelOpen = true; return true; }
    // 点表情按钮
    if (e.includes('messageMsgInputiconAction')) { panelOpen = true; return true; }
    return null;
  },
  async cookies() { return []; }
};

const r = await sendEmoji({ browser, name: '比心', uname: '', expectConvId: '', alreadyVerified: true });
assert.equal(r.ok, true, `表情应发成功：${r.error}`);
assert.equal(closedByOutsideClick, 1, '发完表情必须把面板关掉（用户反馈面板长久停留）');
assert.equal(panelOpen, false, '发完之后面板不该还开着');
console.log('✓ #224 表情发完自动关面板');
