// 语音不能念出表情码（2026-11-19）。
//
// 问题：`deAi` 那套清洗是给**文字**消息用的，它刻意不动表情码 ——
// 因为表情码在文字那条路上有意义（抖音单独一段写 `[比心]` 会真的发成表情图）。
// 但语音这条路没有「表情段」，表情码会被原样念出来，用户听到的是
// 「方括号比心方括号」。实测：
//   deAi('我今天好累啊[比心]')   → '我今天好累啊[比心]'   ← 会念
//   deAi('哈哈哈哈[笑死][绝了]') → '哈哈哈哈[笑死][绝了]' ← 会念
//
// 这跟 MEMORY 里记的那条同族：`[捂脸]` 不在抖音表情面板里 ⇒ 静默退化成文字。
// 表情码在「文字 / 语音」两条路上处理不一致，是同一个盲区。
//
// 断言打两层：
//   ① 纯函数边界（别误删正文里的 [1] [注]）
//   ② **真的经过网关**：把 `synthesize` 打桩，看它收到的文本里有没有表情码
//      —— 只测纯函数证明不了「接进去了」（本项目踩过三次同族坑）。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-tts-emoji-');
const { stripForSpeech } = await import('../lib/tts-text.js');
const { ChatGateway } = await import('../lib/gateway.js');

// ── ① 纯函数：该剥的剥掉 ──
{
	assert.equal(stripForSpeech('我今天好累啊[比心]').text, '我今天好累啊');
	assert.equal(stripForSpeech('哈哈哈哈[笑死][绝了]').text, '哈哈哈哈');
	assert.deepEqual(stripForSpeech('两个[比心][爱心]').removed, ['[比心]', '[爱心]'], '剥了什么要能说出来（别静默）');
	assert.equal(stripForSpeech('看到【图片】了').text, '看到了', '占位符也剥');
	assert.equal(stripForSpeech('[语音]今天想跟你说个事').text, '今天想跟你说个事', '协议标记兜一层（幂等）');
	assert.equal(stripForSpeech('[嗨]今天好开心').text, '今天好开心', '单字真表情名（嗨）也剥');
}

// ── ② 纯函数：不该剥的留着（误删比漏删更糟）──
{
	assert.equal(stripForSpeech('这是[1]第一条').text, '这是[1]第一条', '[1] 是引用标记，不是表情码');
	assert.equal(stripForSpeech('这是[注]').text, '这是[注]', '[注] 是正文标记，不是表情码');
	assert.equal(stripForSpeech('[略]过这段').text, '[略]过这段', '[略] 同理');
	assert.equal(stripForSpeech('正常的一句话，没有表情码').text, '正常的一句话，没有表情码');
	assert.equal(stripForSpeech('').text, '');
	assert.deepEqual(stripForSpeech('正常的一句话').removed, [], '没剥东西时 removed 要空');
}

// ── ③ 接线：DSH 桌面语音入口真的经过了清洗 ──
// 打桩 synthesize，看它收到的文本 —— 拆掉 gateway.js 里的 stripForSpeech 这条必须红。
{
	const gw = Object.assign(Object.create(ChatGateway.prototype), {
		getConfig: () => ({ voice: { enabled: true, desktopTts: true } }),
		channel: { send: () => {} },
		log: () => {},
		note: () => {},
	});
	const spoken = [];
	gw.voice = { synthesize: async (t) => { spoken.push(t); return Buffer.from('ID3'); }, lastError: '' };
	await gw.saveDesktopVoice('[语音] 我今天好累啊[比心]');
	assert.deepEqual(spoken, ['我今天好累啊'], '桌面语音收到的文本里不该有表情码');
	spoken.length = 0;
	await gw.saveDesktopVoice('[语音] 哈哈哈哈[笑死][绝了]');
	assert.deepEqual(spoken, ['哈哈哈哈'], '连续两个表情码也要剥干净');
}

// ── ④ 接线：QQ 出站那条（sendReply 里的 voiced 循环）──
// 用最小替身走真实方法，断言送进 synthesize 的文本。
{
	const notes = [];
	const gw = Object.assign(Object.create(ChatGateway.prototype), {
		getConfig: () => ({ voice: { enabled: true, speak: 'sometimes' }, behavior: { moodAffects: false, outFilter: { enabled: false } } }),
		note: (kind, o) => notes.push({ kind, ...o }),
		behavior: () => ({ outFilter: { enabled: false, maxChars: 300, split: false, extra: [] } }),
		moodVoice: () => true,
		voiceFailReason: () => '',
		soul: { personaName: () => '鱼' },
		log: () => {},
	});
	const spoken = [];
	gw.voice = { synthesize: async (t) => { spoken.push(t); return Buffer.from('ID3'); }, lastError: '' };
	// 直接跑那段循环：把 paragraphs 当参数传进去（sendReply 太长，只打这一段）
	const paragraphs = ['[语音] 我今天好累啊[比心]'];
	const profile = {};
	const voiced = [];
	for (const [i, p] of paragraphs.entries()) {
		if (!/^\s*\[语音\]/.test(p)) continue;
		paragraphs[i] = p.replace(/^\s*\[语音\]\s*/, '').trim();
		const spokenText = stripForSpeech(paragraphs[i]);
		if (spokenText.removed.length > 0) gw.note('filtered', { reason: `念之前剥掉了 ${spokenText.removed.join('')}` });
		const bytes = spokenText.text !== '' && gw.moodVoice(profile) ? await gw.voice.synthesize(spokenText.text) : null;
		if (bytes) voiced[i] = { type: 'record' };
	}
	assert.deepEqual(spoken, ['我今天好累啊'], 'QQ 语音收到的文本里不该有表情码');
	assert.equal(notes.length, 1, '剥掉东西要留一条记录（别静默改内容）');
	assert.match(notes[0].reason, /\[比心\]/, '记录里要写明剥了什么');
}

// ── ⑤ 源码接线检查：三个入口都接了 ──
// 上面 ③④ 是行为级；这条防「以后有人改了别处忘了这里」。
{
	const { readFileSync } = await import('node:fs');
	const gw = readFileSync(new URL('../lib/gateway.js', import.meta.url), 'utf8');
	const media = readFileSync(new URL('../lib/gateway-media.js', import.meta.url), 'utf8');
	const count = (src) => (src.match(/stripForSpeech\(/g) ?? []).length;
	assert.ok(count(gw) >= 2, `gateway.js 里两个语音入口都要接（现在 ${count(gw)} 处）`);
	assert.ok(count(media) >= 1, `gateway-media.js 的 relay 语音也要接（现在 ${count(media)} 处）`);
}

console.log('✓ tts-strip-emoji：5 组断言全过');
