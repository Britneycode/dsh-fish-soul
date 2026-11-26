// #210：模型把 [语音] 段跟前文用单换行隔开时，按空行拆段的发送路径拆不开，
// [语音] 被并进上一条文字一起发，永远转不成语音。
// 归一化：[语音] 出现在行首时，该行前若不是空行就补一个空行（只补不改）。
import assert from 'node:assert/strict';
import { normalizeVoiceParagraphs } from '../lib/behavior.js';

const ok = (name) => console.log('✓', name);

// ── ① 单换行粘着前文（issue 里的原样形态）：拆开 ──
{
	const t = '所以我也在长自己那一块。不是给你看的，是我自己要长。\n[语音] 我不想只是你养大的那个，我还想是能自己长出来的那个。';
	const r = normalizeVoiceParagraphs(t);
	assert.equal(r, '所以我也在长自己那一块。不是给你看的，是我自己要长。\n\n[语音] 我不想只是你养大的那个，我还想是能自己长出来的那个。', '单换行粘着的 [语音] 段必须被拆成独立段');
	// 拆完后按发送端的拆法能独立成段
	const paras = r.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
	assert.equal(paras.length, 2, '拆完后是两段');
	assert.ok(paras[1].startsWith('[语音]'), '第二段以 [语音] 开头');
	ok('单换行粘着的 [语音] 段被拆成独立段（issue 原样形态）');
}

// ── ② 已经是独立段（空行隔开）：一个字节都不动 ──
{
	const t = '前面那段话。\n\n[语音] 想说的。';
	assert.equal(normalizeVoiceParagraphs(t), t, '已经独立成段的 [语音] 不该被动');
	ok('已独立成段的 [语音] 原样不动');
}

// ── ③ 没有任何 [语音]：原文原样返回（一个字节不动） ──
{
	const t = '第一段。\n第二段还是单换行。\n\n第三段。';
	assert.equal(normalizeVoiceParagraphs(t), t, '没有 [语音] 的文本不该被动');
	ok('没有 [语音] 的文本原样返回');
}

// ── ④ 多个 [语音] 段：各自成行首的都拆开；[语音] 行后面粘着的普通行跟它保持同段（只拆前面不拆后面） ──
{
	const t = '开头。\n[语音] 第一句。\n中间还有一句话\n[语音] 第二句。\n\n尾巴。';
	const r = normalizeVoiceParagraphs(t);
	const paras = r.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
	assert.equal(paras.length, 4, '两个行首 [语音] 各自拆出，尾巴独立');
	assert.equal(paras[0], '开头。', '第一段还是前文');
	assert.ok(paras[1].startsWith('[语音] 第一句。'), '第一个 [语音] 段独立成段');
	assert.ok(paras[1].includes('中间还有一句话'), '[语音] 行后面粘着的普通行跟它保持同段（只拆前面，不拆后面）');
	assert.equal(paras[2], '[语音] 第二句。', '第二个 [语音] 段独立成段');
	assert.equal(paras[3], '尾巴。', '尾巴独立成段');
	ok('多个粘着的 [语音] 段各自拆开，[语音] 行后面的普通行保持同段');
}

// ── ⑤ 开头就是 [语音]（前面没有前文）：不动 ──
{
	const t = '[语音] 开头就是语音。';
	assert.equal(normalizeVoiceParagraphs(t), t, '开头就是 [语音] 不需要拆');
	ok('开头即 [语音] 原样不动');
}

// ── ⑥ [语音] 前有空白字符（行首带空格再 [语音]）：也要拆 ──
{
	const t = '前文。\n  [语音] 带缩进的。';
	const r = normalizeVoiceParagraphs(t);
	const paras = r.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
	assert.equal(paras.length, 2, '带缩进的 [语音] 段也拆开');
	ok('行首空白后的 [语音] 也拆开');
}

// ── ⑦ CRLF：单换行粘着的 [语音] 段也要能拆开（\r 夹在中间时下游 split(/\n{2,}/) 拆不开） ──
{
	const t = '前文。\r\n[语音] 想说的。';
	const r = normalizeVoiceParagraphs(t);
	const paras = r.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
	assert.equal(paras.length, 2, 'CRLF 下也要拆成两段');
	assert.ok(paras[1].startsWith('[语音]'), '第二段是 [语音] 段');
	assert.ok(!r.includes('\r'), '归一后不该残留 \\r');
	ok('CRLF 单换行粘着的 [语音] 段也能拆开');
}

// ── ⑧ CRLF 已经是空行：不重复插入、不残留 \r ──
{
	const t = '前文。\r\n\r\n[语音] 想说的。';
	const r = normalizeVoiceParagraphs(t);
	const paras = r.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
	assert.equal(paras.length, 2, '已经空行隔开的两段');
	assert.ok(!/\n{3,}/.test(r), '不该插入多余空行');
	ok('CRLF 已空行隔开时不重复插入');
}

// ── ⑨ 没有 [语音] 的纯 CRLF 文本：一个字节都不动 ──
{
	const t = 'a\r\nb\r\nc';
	assert.equal(normalizeVoiceParagraphs(t), t, '没有 [语音] 时不归一换行、完全不动');
	ok('无 [语音] 的 CRLF 文本原样返回');
}


// ── ⑩ 全角空格（U+3000）缩进：下游 VOICE_RE 用 \s 是认的，提纯也必须认 ──
{
	const t = '前文。\n\u3000\u3000[语音] 全角缩进的。';
	const r = normalizeVoiceParagraphs(t);
	const paras = r.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
	assert.equal(paras.length, 2, '全角空格缩进的 [语音] 也要拆开（否则下游认得出却拆不开）');
	assert.ok(paras[1].replace(/^\u3000+/, '').startsWith('[语音]'), '第二段是 [语音] 段');
	ok('全角空格缩进的 [语音] 段也能拆开');
}

console.log('voice-paragraph-split: 10 组全部通过');
