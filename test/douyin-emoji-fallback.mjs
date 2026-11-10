/**
 * 抖音表情兜底名：提示词里给的名字**必须是面板里真有的**。
 *
 * 为什么要有这个：
 *   以前提示词的兜底写的是 `[比心] [捂脸]`，而 `[捂脸]` **不在抖音表情面板里**（2026-11-09 实测）。
 *   后果不是报错 —— `sendEmoji` 找不到就退回 `sendText`，把 `[捂脸]` 当**纯文字**发出去，
 *   对方看到一串方括号。模型被提示词引到一个不存在的名字上，锅在提示词这边。
 *
 * 契约：
 *   ① 兜底清单非空，且都是短的、像表情名（不是句子）
 *   ② 提示词真的用了这份清单（不是只定义了常量没人用）
 *   ③ 提示词里**不能再出现** `[捂脸]` 这种没核对过的名字
 *   ④ 兜底名**必须**出现在真机抓到的面板清单里（这里是写死的那次实测结果）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ok = (msg) => console.log(`✓ ${msg}`);

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

/**
 * 2026-11-09 真机抓的抖音私信表情面板（21 个，全部带名字、可点）。
 * 来源：`scripts/probe-douyin-emoji-names.mjs`（只读探针，按红线不进仓库）。
 */
const PANEL = [
  '续火花', '比心', '在干嘛', '笑死', '麻了', '躺平', '摇骰子', '猜拳', '开心', '嗨', '吹泡泡',
  '黑人问号', '早上好', '晚上好', '早点睡', '爱心', '便便', '戳一戳', '绝了', '已阅', '生日祝福'
];

// ── ① 常量本身 ──
const m = src.match(/const DOUYIN_EMOJI_FALLBACK = \[([^\]]+)\]/);
assert.ok(m !== null, '要有 DOUYIN_EMOJI_FALLBACK 常量');
const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
assert.ok(names.length > 0, '兜底清单不能是空的');
for (const n of names) {
  assert.ok(n.length >= 2 && n.length <= 6, `「${n}」要像表情名（2~6 字）`);
  assert.ok(!/[，。！？\s]/.test(n), `「${n}」不该含标点或空格`);
}
ok(`兜底清单 ${names.length} 个：${names.join(' ')}`);

// ── ② 提示词真的用了它 ──
assert.match(src, /DOUYIN_EMOJI_FALLBACK\.map/, '提示词要用这份清单，不能只定义常量');
ok('提示词真的引用了这份清单');

// ── ③ 提示词里不能再出现没核对过的名字 ──
//    ⚠️ 只查**代码行**，注释里可以提（我在常量上方写了为什么换掉 `[捂脸]`，
//       那段历史值得留，不该被测试逼着删掉）。
const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
const codeOnly = codeLines.join('\n');
assert.ok(!codeOnly.includes('[捂脸]'), '代码里不能再出现 [捂脸]（面板里没有这个名字）');
ok('代码里不再有 [捂脸]（注释里的历史说明保留）');

//    兜底分支里不该再有硬编码的表情名（应该只走常量）
const fallbackBranch = codeOnly.match(/douyinNames\.length > 0[\s\S]{0,400}?；`\)/) ?? [''];
assert.ok(!/\[[\u4e00-\u9fa5]{2,6}\]/.test(fallbackBranch[0].replace(/\$\{[^}]*\}/g, '')),
  '兜底分支里不该硬编码表情名（用常量）');
ok('兜底分支只走常量，没有硬编码名字');

// ── ④ 兜底名必须真在面板里 ──
for (const n of names) {
  assert.ok(PANEL.includes(n), `「${n}」不在 2026-11-09 真机抓的面板清单里 —— 会被当纯文字发出去`);
}
ok(`兜底名都在真机面板清单里（面板共 ${PANEL.length} 个）`);

// ── ⑤ 跟「面板里没有就退回文字」的降级逻辑对得上 ──
//    sendEmoji 找不到名字 → sendText(`[名字]`)。所以名字错了不会报错只会发成文字，
//    这正是「必须核对」的原因。守住这个降级还在（以免有人以为「发不出去会报错」）。
const dm = readFileSync(new URL('../lib/channels/douyin.js', import.meta.url), 'utf8');
// 兜底那条现在要带上目标会话 ID（convId）—— 降级不能顺手丢掉身份校验。
assert.match(dm, /sendText\(name, `\[\$\{part\.name\}\]`, convId\)/,
  '表情找不到名字时要退回文字发，并且带上会话 ID（降级还在，所以名字必须核对）');
ok('降级行为没变：名字不对 = 静默发成纯文字（这就是必须核对的原因）');

console.log('\ndouyin-emoji-fallback ok');
