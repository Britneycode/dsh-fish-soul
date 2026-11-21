// #167：自动整理的记忆会把日期记错一天（今天 20 号，记忆里写 19 号）。
//
// 真根因：两处「整理记忆」的提示词**都没有告诉模型今天是几号** ——
//   ① ChatDigester.run（聊完自动记，soul-memory.js）
//   ② LifeEngine.runDream（3h 空闲整理，life.js）
// 已有的记忆里只有相对时间（relTime 给的「刚才 / 昨天 / 3 天前」），模型要写绝对日期只能自己猜。
//
// 断言打的是「实际送给模型的提示词里有没有今天」，不是「有没有调 roleDayLabel」——
// 后者只要函数被调用就绿，接错参数（传成 UTC、少星期）也发现不了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-mem-date-');
const { openDatabase } = await import('../lib/db.js');
const { ChatJournal, ChatDigester, roleDayLabel, insertMemory } = await import('../lib/soul-memory.js');
const { LifeEngine } = await import('../lib/life.js');

const db = openDatabase();

test('#167 roleDayLabel：角色时区（UTC+8）的年月日星期', () => {
	// 2026-11-20 12:00 UTC = 角色时区 2026-11-20 20:00（周五）
	assert.equal(roleDayLabel(Date.parse('2026-11-20T12:00:00Z')), '2026年11月20日 星期五');
	// 跨日边界：UTC 还是 19 号、角色时区已经是 20 号 —— 这里最容易差一天
	assert.equal(roleDayLabel(Date.parse('2026-11-19T17:00:00Z')), '2026年11月20日 星期五', 'UTC 19 号 17 点 = 角色时区 20 号 1 点');
	assert.equal(roleDayLabel(Date.parse('2026-11-19T15:00:00Z')), '2026年11月19日 星期四', 'UTC 19 号 15 点 = 角色时区 19 号 23 点');
	// 月末 / 年初也要对
	assert.equal(roleDayLabel(Date.parse('2026-12-31T16:00:00Z')), '2027年1月1日 星期五', '跨年');
});

test('#167 聊完自动记：提示词里带「今天是 X」，并要求绝对日期以它为准', async () => {
	let seen = '';
	const now = Date.parse('2026-11-20T12:00:00Z');
	const journal = new ChatJournal({ keepRecent: 50 });
	journal.add('private:20002', { who: '阿二', ownerId: 'user:p2', text: '我今天面试完了' });
	const digester = new ChatDigester({
		db,
		clock: { now: () => now },
		journal,
		worker: null,
		callLlm: async (prompt) => { seen = prompt; return '{"memories":[]}'; },
		getConfig: () => ({ enabled: true, idleMinutes: 1, maxLines: 40 }),
		related: () => [],
		findOwnerByName: () => null,
		personaName: () => '鱼',
		titleOf: (c) => c,
		log: () => {},
		note: () => {}
	});
	await digester.digest('private:20002');

	assert.match(seen, /今天是 2026年11月20日 星期五/, '提示词里必须给出角色时区的今天');
	assert.match(seen, /以开头给的「今天」为准/, '要明确要求绝对日期按它算，不然模型还是会自己估');
});

test('#167 3h Dream 整理：提示词里同样带「今天是 X」', async () => {
	let seen = '';
	const now = Date.parse('2026-11-20T12:00:00Z');
	const owner = 'user:p_date_test';
	insertMemory(db, null, { ownerId: owner, channel: 'qq-private', channelId: 'private:30003', kind: 'fact', content: '阿三说他在准备考试', importance: 2 }, now - 2 * 3600_000);

	const life = new LifeEngine({
		db,
		clock: { now: () => now, getRoleDateParts: () => ({ dateStr: '2026-11-20', hour: 20, minute: 0 }) },
		getConfig: () => ({ memory: {}, proactive: {} }),
		callLlm: async (prompt) => { seen = prompt; return null; },
		deliver: async () => true,
		log: () => {},
		transcripts: null
	});
	await life.runDream(owner);

	assert.match(seen, /今天是 2026年11月20日 星期五/, 'Dream 提示词里必须给出角色时区的今天');
	assert.match(seen, /以开头给的「今天」为准/, 'Dream 也要明确要求绝对日期按它算');
});

test('#167 提示词带上日期后，已有时刻不再被误标成 UTC（角色时区差 8 小时）', () => {
	// 这条守的是「同一族 bug 不要再从别的地方长回来」：给模型看的时刻一律角色时区。
	const at = Date.parse('2026-11-20T12:30:00Z');
	assert.match(roleDayLabel(at), /11月20日/, 'UTC 12:30 在角色时区仍是 20 号');
	assert.match(roleDayLabel(Date.parse('2026-11-20T16:30:00Z')), /11月21日/, 'UTC 16:30 = 角色时区 21 号 0:30');
});
