// #75：主动开口的时机 + 虚假日程。
//
// ① 「上一句还不到一分钟，她就主动开口了」
//    根因：空闲兜底只看 lastInteractionVirtualMs[主人 ownerId]，而桌面端（DSH 桌面）的消息
//    以前根本不登记互动（person=null 直接跳过），主人刚说完话，她的"多久没说话"还停在半天前。
//    修法：① 任何通道的入站互动都记一条全局时间，空闲判定取"主人这一路"与"全局"里较新的那个；
//          ② 再加一道真实时间护栏（默认 30 分钟），虚拟钟加速时也挡得住。
// ② 「虚假日程里的'我去煮面了'被记住了」
//    修法：日程写成"打算做什么"的大方向（不再写成已经发生过的事）；聊天整理里主动开口那轮标出来，
//          提示词明确"计划/想象不当既成事实"；再加一个自走日程开关，想彻底关掉可以关。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';
import { VirtualClock } from '../lib/clock.js';
import { LifeEngine, dayPlanPrompt } from '../lib/life.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── ① 刚说完话不主动开口 ─────────────────────────
{
	const home = tmpHome('dsh-75a-');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	process.env.DSH_HOME = prevHome;

	let t = Date.parse('2030-01-01T06:00:00Z'); // 14:00 UTC+8
	const clock = Object.assign(Object.create(VirtualClock.prototype), { scale: 1, now: () => t });
	const sent = [];
	const cfg = (over = {}) => ({
		proactive: {
			enabled: true, dailyMaxCount: 5, activeHours: [8, 24], idleTriggerHours: 1, idleRealGapMinutes: 30,
			targets: { masterCanonicalId: 'user:master', masterPrivateChannelId: 'private:123', selfGroupChannelIds: [] },
			...over
		}
	});
	const mk = (over) => new LifeEngine({
		db, clock, getConfig: () => cfg(over), callLlm: async () => null,
		deliver: async (ch, reason) => { sent.push([ch, reason]); return true; }
	});
	// 当天的日程：14:00 落在 idle 时段
	db.prepare(`INSERT INTO day (date, character_id, plan_json, proactive_count, last_proactive_at, generated_at)
		VALUES ('2030-01-01','feiyu',?,0,NULL,?)`).run(JSON.stringify({
		date: '2030-01-01', dailyMoodTone: '平静',
		schedule: [{ range: '13:00 - 18:00', activity: '有点闲', availability: 'idle' }]
	}), t);

	// 主人刚在"认不出 ownerId 的通道"（桌面端）说过话 —— 互动发生了，但主人那一路没有记录
	const life = mk();
	life.noteInteraction('user:p_desktop');
	await life.tick();
	assert.deepEqual(sent, [], '刚说完话（不到一分钟）不该主动开口（#75 ①）');

	// 虚拟钟往前推 2 小时（超过 idleTriggerHours=1），但真实时间只过了一点点 → 护栏仍然挡着
	t += 2 * 3600_000;
	await life.tick();
	assert.deepEqual(sent, [], '真实只过了一分钟（虚拟钟加速），也不该主动开口（#75 ①）');

	// 护栏关掉 + 真的闲够了 → 还是会主动开口（别把功能改没了）
	sent.length = 0;
	const life2 = mk({ idleRealGapMinutes: 0 });
	life2.noteInteraction('user:p_desktop');
	t += 2 * 3600_000;
	await life2.tick();
	assert.equal(sent.length, 1, '闲够了还是会主动开口');
	assert.equal(sent[0][0], 'private:123');
	assert.match(sent[0][1], /好久没说话/);

	// 从来没人跟她说过话 → 旧契约：照样能主动开口（smoke #20 守着这条，别改）
	sent.length = 0;
	const life3 = mk({ idleRealGapMinutes: 0 });
	t += 61 * 60_000; // 离上一条自发超过 60 虚拟分钟
	await life3.tick();
	assert.equal(sent.length, 1, '没人跟她说过话时，空闲兜底仍能开口（旧契约不变）');

	db.close();
}

// ───────────────────────── ② 自走日程开关 ─────────────────────────
{
	const home = tmpHome('dsh-75b-');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	process.env.DSH_HOME = prevHome;

	let t = Date.parse('2030-01-01T06:00:00Z');
	const clock = Object.assign(Object.create(VirtualClock.prototype), { scale: 1, now: () => t });
	let llmCalls = 0;
	const sent = [];
	const life = new LifeEngine({
		db, clock,
		getConfig: () => ({
			proactive: {
				enabled: true, dailyMaxCount: 5, activeHours: [8, 24], idleTriggerHours: 0, idleRealGapMinutes: 0,
				scheduleEnabled: false,
				targets: { masterCanonicalId: 'user:master', masterPrivateChannelId: 'private:123', selfGroupChannelIds: [] }
			}
		}),
		callLlm: async () => { llmCalls += 1; return null; },
		deliver: async (ch, reason) => { sent.push([ch, reason]); return true; }
	});
	await life.tick();
	assert.equal(llmCalls, 0, '日程关掉就不该调 LLM 生成日程（#75 ②）');
	const day = db.prepare("SELECT * FROM day WHERE character_id='feiyu' AND date='2030-01-01'").get();
	assert.ok(day !== undefined, '当天的行还是要建（配额/计数用）');
	assert.deepEqual(JSON.parse(day.plan_json).schedule, [], '关掉日程 = 没有时段');
	const parts = clock.getRoleDateParts();
	assert.equal(life.currentSlot(day, parts), null, '关掉日程 = 没有当前时段');
	// 没有日程就没有"忙"的时段卡着：闲够了照样能主动开口
	life.noteInteraction('user:master');
	t += 2 * 3600_000;
	await life.tick();
	assert.equal(sent.length, 1, '关掉日程后主动开口不受"忙/闲"影响');

	db.close();
}

// ───────────────────────── ③ 日程与记忆的措辞 ─────────────────────────
{
	const p = dayPlanPrompt('2030-01-01', { name: '鱼', brief: '普通人' });
	assert.ok(p.includes('打算'), '日程提示词要写成"打算做什么"（#75 ②）');
	assert.ok(!p.includes('活动写具体'), '不能再要求写"具体发生过的事"');
	assert.ok(!p.includes('在做什么、在哪'), '不能再让日程写成已经发生过的具体事件');
}

// ───────────────────────── ④ 桌面端要登记互动 / 主动开口那轮要标出来 ─────────────────────────
{
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.ok(/else life\.noteInteraction\('user:master'\)/.test(src), '桌面端消息也要登记主人互动（#75 ①）');

	const { ChatJournal } = await import('../lib/soul-memory.js');
	const journal = new ChatJournal();
	journal.add('private:123', { who: '鱼', self: true, text: '我去煮面了', proactive: true });
	journal.add('private:123', { who: 'later', ownerId: 'user:master', text: '在干嘛' });
	const lines = journal.take('private:123');
	assert.equal(lines[0].proactive, true, '主动开口那轮要在聊天日志里标出来（#75 ②）');
	assert.equal(lines[1].proactive, false, '真人说话的不标');

	// 整理用的提示词：主动开口那轮标出来 + 明确"计划不当既成事实"
	const home = tmpHome('dsh-75c-');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	process.env.DSH_HOME = prevHome;
	let prompt = '';
	const { ChatDigester } = await import('../lib/soul-memory.js');
	const journal2 = new ChatJournal();
	journal2.add('private:123', { who: '鱼', self: true, text: '我去煮面了', proactive: true });
	journal2.add('private:123', { who: 'later', ownerId: 'user:master', text: '在干嘛' });
	const dig = new ChatDigester({
		db, clock: { now: () => Date.now() }, journal: journal2, worker: { enqueueRealtime: () => {} },
		callLlm: async (p) => { prompt = String(p); return '{"memories":[],"self":[],"summary":"","people":[]}'; },
		getConfig: () => ({ enabled: true, autoExtract: true, idleMinutes: 1, maxLines: 20 }),
		related: () => [], findOwnerByName: () => null, personaName: () => '鱼', titleOf: () => 'x', note: () => {}
	});
	await dig.digest('private:123');
	assert.ok(prompt.includes('我（主动开口时说的）'), '整理时要把主动开口那轮标出来（#75 ②）');
	assert.ok(prompt.includes('别写进 self'), '整理时明确：计划/想象不当既成事实（#75 ②）');
	db.close();
}

console.log('✓ #75：刚说完话不主动开口（桌面端互动 + 真实时间护栏）；日程开关 + 日程/记忆措辞');
