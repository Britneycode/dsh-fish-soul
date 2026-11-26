// #210 接线：确认 cleanOut 真的调了 normalizeVoiceParagraphs（只测纯函数不知道有没有接进去）。
import assert from 'node:assert/strict';
import { behaviorMethods } from '../lib/gateway-behavior.js';

const ok = (name) => console.log('✓', name);

// cleanOut 只依赖这几样：soul.personaName / behavior() / note() / random
const gw = {
	soul: { personaName: () => '鱼' },
	behavior: () => ({ outFilter: { enabled: false } }),
	note: () => {},
	random: () => 0.5,
	cleanOut: behaviorMethods.cleanOut
};
const row = { channel_id: 'private:10001', title: '私聊' };

const glued = '所以我也在长自己那一块。\n[语音] 我不想只是你养大的那个。';
const out = gw.cleanOut(glued, row);
const paras = out.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
assert.equal(paras.length, 2, 'cleanOut 出口处 [语音] 段必须已经独立（下游才拆得开）');
assert.ok(paras[1].startsWith('[语音]'), '第二段是 [语音] 段');
ok('cleanOut 内部完成了 [语音] 段提纯（接线生效）');

// 没有 [语音] 的文本仍原样返回（接线不改变其它行为）
const plain = '第一段。\n第二段。';
assert.equal(gw.cleanOut(plain, row), plain, '没有 [语音] 的文本原样返回');
ok('无 [语音] 文本不受影响');


// DSH 桌面端本地语音（saveDesktopVoice）吃的是 st.text 原文，不经过 cleanOut。
// 它内部自己按空行拆段找 [语音]，所以也必须在入口提纯，否则桌面端同样发不出语音。
const { ChatGateway } = await import('../lib/gateway.js');
{
	const gw2 = Object.create(ChatGateway.prototype);
	gw2.getConfig = () => ({ voice: { desktopTts: true, enabled: true } });
	gw2.log = () => {};
	let synthesized = 0;
	gw2.voice = { synthesize: async () => { synthesized++; return Buffer.from('x'); } };
	await gw2.saveDesktopVoice('前文一段。\n[语音] 桌面端想说的。');
	assert.equal(synthesized, 1, 'saveDesktopVoice 也必须能认出单换行粘着的 [语音] 段');
	ok('DSH 桌面端 saveDesktopVoice 也提纯了 [语音] 段');
}

console.log('voice-paragraph-split-wire: 3 组通过');