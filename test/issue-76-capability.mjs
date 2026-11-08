// #76：她把旧的「我做不到」记忆当永久事实。
//
// 根因（三条都在代码里核实过）：
//  ① 自己说的装置能力陈述（"我没有识图能力"）会写成 kind=fact / owner=self 的长期记忆；
//  ② 被反复想起 3 次就自动升到 importance=3（soul-memory.js 的 reinforce）；
//  ③ importance>=3 的 decayFactor 直接返回 1 → 永不衰减 → 每轮都注入 → 现实变了记忆比现实更坚定。
//
// 修法三道：写入时就不记 + 不自动升星 + 注入时标「可能已过时」。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { isCapabilityClaim, isSelfCapabilityClaim, capabilityStaleTag } from '../lib/capability.js';
import { reinforce, insertMemory } from '../lib/soul-memory.js';

const home = tmpHome('dsh-76-');
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const db = openDatabase();
process.env.DSH_HOME = prevHome;

// ── 1. 判定：只认"关于自己能不能做某事"的话，宁可漏判不误伤 ──
{
	assert.equal(isCapabilityClaim('我没有识图能力'), true);
	assert.equal(isCapabilityClaim('我只能读字'), true);
	assert.equal(isCapabilityClaim('我不会发语音'), true);
	assert.equal(isCapabilityClaim('我没法看视频'), true);
	assert.equal(isCapabilityClaim('我不喜欢吃辣'), false, '不是能力就别误伤');
	assert.equal(isCapabilityClaim('我不会忘记她'), false, '不是装置能力就别误伤');
	assert.equal(isCapabilityClaim('我现在能看图片了'), false, '更正的话要能记下来');
	// 说的是别人 = 稳定事实，不是"她自己不能做"
	assert.equal(isSelfCapabilityClaim('他不能看图'), false, '说别人是稳定事实，不管');
	assert.equal(isSelfCapabilityClaim('我同事不能看图'), false);
	assert.equal(isSelfCapabilityClaim('我没有识图能力'), true);
	assert.equal(capabilityStaleTag('我没有识图能力'), '可能已过时');
	assert.equal(capabilityStaleTag('我喜欢猫'), '');
}

// ── 2. 写侧：能力类自我陈述不进长期记忆 ──
{
	const { ChatDigester, ChatJournal } = await import('../lib/soul-memory.js');
	const journal = new ChatJournal();
	journal.add('private:1', { who: 'later', ownerId: 'user:master', text: '你不是能看图了吗' });
	journal.add('private:1', { who: '鱼', self: true, text: '我以前不能看图' });
	let prompt = '';
	const dig = new ChatDigester({
		db, clock: { now: () => Date.now() }, journal, worker: { enqueueRealtime: () => {} },
		callLlm: async (p) => {
			prompt = String(p);
			return JSON.stringify({
				memories: [],
				self: [
					{ content: '我没有识图能力，只能读字', importance: 3 },
					{ content: '我喜欢在晚上写东西', importance: 2 }
				],
				summary: '', people: []
			});
		},
		getConfig: () => ({ enabled: true, autoExtract: true, idleMinutes: 1, maxLines: 20 }),
		related: () => [], findOwnerByName: () => null, personaName: () => '鱼', titleOf: () => 'x', note: () => {}
	});
	const r = await dig.digest('private:1');
	assert.equal(r.capabilitySkipped, 1, '能力类自我陈述要被跳过（#76）');
	const selfRows = db.prepare("SELECT content FROM memory WHERE owner_id = 'self' AND status = 'active'").all().map((x) => x.content);
	assert.ok(!selfRows.some((c) => c.includes('识图')), '不能把"我没有识图能力"写进长期记忆');
	assert.ok(selfRows.some((c) => c.includes('喜欢在晚上写东西')), '别的 self 记忆照常写');
	assert.ok(prompt.includes('装置能力'), '整理提示词里要写明这条规则');
}

// ── 3. 升星侧：老的能力类陈述不因为"被反复想起"升到 3 星（3 星 = 永不衰减）──
{
	const now = Date.now();
	const claimId = insertMemory(db, { enqueueRealtime: () => {} }, {
		ownerId: 'self', channel: 'qq-private', channelId: 'private:1', kind: 'fact',
		content: '我没有识图能力，只能读字', importance: 1, evidence: '测试'
	}, now);
	const otherId = insertMemory(db, { enqueueRealtime: () => {} }, {
		ownerId: 'self', channel: 'qq-private', channelId: 'private:1', kind: 'fact',
		content: '我喜欢猫', importance: 1, evidence: '测试'
	}, now);
	for (let i = 0; i < 4; i++) {
		reinforce(db, [claimId, otherId], now + i * 24 * 3600_000);
	}
	const claim = db.prepare('SELECT importance, importance_auto_recalled, recall_count FROM memory WHERE id = ?').get(claimId);
	const other = db.prepare('SELECT importance, importance_auto_recalled, recall_count FROM memory WHERE id = ?').get(otherId);
	assert.equal(claim.importance, 1, '能力类陈述不被自动升星（否则永不衰减）');
	assert.equal(claim.importance_auto_recalled, 0, '也不该标成自动升星');
	assert.ok(claim.recall_count >= 1, '但"被想起"这件事还是要记');
	assert.equal(other.importance, 3, '别的记忆照常自动升星（老行为不变）');
	assert.equal(other.importance_auto_recalled, 1);
}

// ── 4. 注入侧：老的能力类陈述标「可能已过时」──
{
	const fs = await import('node:fs');
	const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.ok(src.includes('capabilityStaleTag(m.content)'), '注入时给能力类记忆加时效标注（#76）');
	const capSrc = fs.readFileSync(new URL('../lib/capability.js', import.meta.url), 'utf8');
	assert.ok(capSrc.includes('可能已过时'), '标注文案要在');
}

db.close();
console.log('✓ #76：能力类自我陈述不进记忆、不自动升星、注入时标可能已过时');
