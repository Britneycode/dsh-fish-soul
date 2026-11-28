import assert from 'node:assert/strict';
import { test } from 'node:test';

// 昵称扫描器的切分/粘连回归测试。
//
// 背景：check-secrets 原来只拦数字 token（QQ 号 / 抖音 uid），中文昵称从第一天就绕过去了。
// ea75f7e 加了 scanNicknames，但切分用的是 `/[^\x00-\x7f]+/g` —— 它把中文标点也当成词的一部分：
//   「测试昵称：某人的名字」整段被当一个词，哈希对不上任何昵称 ⇒ **防线看起来在、实际漏检**。
// 而且中文没有分词，昵称天然会粘在上下文里：
//   「回复某某某：好的」→ 切出「回复某某某」⇒ 漏。
//
// 修法：① 切分显式排除中文标点；② 对每个候选再做滑窗子串比对（兜粘连那一类）。
//
// ⚠️ 这里按同样规则复刻「切分 + 滑窗」的纯逻辑来验证边界 ——
//    复刻有风险（改了一边另一边不知道），所以另有一组「接线」保证：
//    test/check-secrets.mjs 跑一次干净就说明真的接进去了（它在 test 链里）。

// 中文标点区间。用 fromCharCode 拼，避免源码里的 \\u 转义在写文件时被二次转义。
const PUNCT_CN = [
  [0x3000, 0x303f], // 中文标点（、。〈〉《》「」『』【】〜）
  [0xff00, 0xffef], // 全角 ASCII / 全角符号（：！？，．～）
  [0x2010, 0x2027], // 通用标点（—–‘’“”…）
  [0x2030, 0x205e], // 其他通用标点（‰†‡•）
].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('');
const NON_ASCII = new RegExp(`[^\\x00-\\x7f${PUNCT_CN}]+`, 'g');

/** 假昵称（测试用，不在黑名单里）。 */
const NICK = '阿猫';

/** 复刻 scanNicknames 的候选生成：整词 + 滑窗子串。 */
function candidates(text) {
  const out = new Set();
  for (const m of text.matchAll(NON_ASCII)) {
    const w = m[0];
    out.add(w);
    for (let i = 0; i < w.length; i++) {
      for (let n = 2; n <= Math.min(w.length - i, 16); n++) out.add(w.slice(i, i + n));
    }
  }
  return out;
}

test('切分：中文标点必须切开（原实现在这里漏检）', () => {
  // 「测试昵称：阿猫的名字」—— 冒号是全角，原实现把它整段当一个词
  const words = [...'测试昵称：阿猫的名字'.matchAll(NON_ASCII)].map((m) => m[0]);
  assert.ok(!words.includes('测试昵称：阿猫的名字'), '不该再整段成一个词');
  assert.ok(words.length >= 2, `冒号应把这段切成 ≥2 块，实际：${JSON.stringify(words)}`);
  assert.ok(candidates('测试昵称：阿猫的名字').has(NICK), '切完应能露出「阿猫」');
});

test('切分：书名号 / 引号 / 括号 / 全角感叹号也要切开', () => {
  const cases = [
    ['「阿猫」说了什么', '直角引号'],
    ['（阿猫）', '全角括号'],
    ['《阿猫》', '书名号'],
    ['【阿猫】', '方头括号'],
    ['阿猫！', '全角感叹号'],
    ['阿猫，', '全角逗号'],
  ];
  for (const [text, label] of cases) {
    const words = [...text.matchAll(NON_ASCII)].map((m) => m[0]);
    assert.ok(!words.includes(`「${NICK}」`) && !words.includes(`（${NICK}）`),
      `${label}「${text}」不该把符号连同昵称当一个词：${JSON.stringify(words)}`);
    assert.ok(candidates(text).has(NICK), `${label}「${text}」应能切出「${NICK}」`);
  }
});

test('粘连兜底：昵称粘在上下文里也要抓得到', () => {
  const cases = [
    '// 阿猫说的',          // 后粘
    '回复阿猫：好的',        // 前粘
    '阿猫的私聊',           // 后粘 + 助词
    '这是阿猫留下的',        // 两头都粘
  ];
  for (const text of cases) {
    assert.ok(candidates(text).has(NICK), `「${text}」应能切出「${NICK}」`);
  }
});

test('独立成词时仍然命中', () => {
  for (const text of [`const NAME = '${NICK}';`, `name: ${NICK},`, `{ nickname: ${NICK} }`]) {
    assert.ok(candidates(text).has(NICK), `「${text}」应命中`);
  }
});

test('单字不产生子串候选（否则满篇都是噪音）', () => {
  // 单字本身会作为「整词」进候选，但**不参与滑窗**（滑窗从 n=2 起）——
  // 而整词命中要求它恰好在黑名单里，所以单字不会带来噪音。
  const c = candidates('好');
  assert.ok(![...c].some((x) => x.length === 2), '单字不该切出双字子串');
  assert.ok(candidates('好的').has('好的'), '双字正常进候选（是否命中取决于黑名单）');
});

test('区间真的生效（不是字面量）：PUNCT_CN 必须匹配全角冒号', () => {
  // 这一条专门防「\\\\u3000 被写进文件变成字面反斜杠」那类事故
  const colon = String.fromCharCode(0xff1a); // ：
  assert.equal(new RegExp(`[${PUNCT_CN}]`).test(colon), true, '全角冒号应被标点区间吃掉');
  assert.equal(new RegExp(`[${PUNCT_CN}]`).test('阿'), false, '汉字不该被标点区间吃掉');
});