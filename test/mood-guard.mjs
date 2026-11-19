// 情绪状态机的一道闸 + 提示词护栏（PR3）。
//
// 为什么要有：mood 原来是「模型说变就变」，一天之内能在
// 开心→委屈→开心→委屈 之间反复横跳，她自己都说不清现在什么心情。
//
// 借鉴 anima-brain 的 emotion.py（常量在代码里，真读过的）：
//   每轴每日总位移上限、档位滞回 —— 挡的都是「同一话题反复刷」和「边界横跳」。
//
// 🔴 这里**没有**「按强度滞后」那道闸，是我砍掉的：
//    既有契约 smoke-v09 要求同一个 now 下 开心(满格) → 委屈 必须能翻，
//    翻完 markMoodSaid 要重新返回 true。那是「模型判断了就是判断了」，
//    是她的主体性。第一版按强度滞后写，直接打挂那条契约 —— 边界理解错了。
//    同样，也不能拿「每日位移上限」去压同标签叠加（smoke-persona 的 1→3→3）。
//
// 所以闸② 数的是「今天换了几次标签」，不是「涨了几格强度」。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-moodguard-');
const { openDatabase } = await import('../lib/db.js');
const db = openDatabase();
const { getMood, setMood, markMoodSaid } = await import('../lib/soul-memory.js');
const { canFlipToday, MOOD_FLIPS_PER_DAY, MOOD_STATE_GUARD, moodDayOf } = await import('../lib/mood-guard.js');
const { behaviorLines } = await import('../lib/behavior.js');

const HOUR = 3600_000;
const t0 = Date.parse('2026-11-19T02:00:00+08:00');

// ── ① 纯函数：每日翻转次数上限 ──
{
	const day = moodDayOf(t0);
	assert.equal(canFlipToday(null, t0).ok, true, '第一次翻随便');
	assert.equal(canFlipToday({ day, flips: 3 }, t0).ok, true, '没到上限还能翻');
	assert.equal(canFlipToday({ day, flips: 4 }, t0).ok, false, '到上限就不许翻了');
	// 跨天重置
	assert.equal(canFlipToday({ day: '2026-11-18', flips: 9 }, t0).ok, true, '换了一天重新算');
	assert.equal(MOOD_FLIPS_PER_DAY, 4);
}

// ── ② 接线：反复横跳真的被挡住（不是函数写好了没调）──
{
	const who = 'user:m1';
	const labels = ['开心', '委屈', '开心', '委屈', '开心', '委屈'];
	const got = [];
	for (let i = 0; i < labels.length; i++) {
		const r = setMood(db, who, { label: labels[i], intensity: 2 }, t0 + i * 60_000);
		if (r !== null) got.push(r.label);
	}
	// 首次设值不算翻转，所以成功次数 = 1（首次）+ MOOD_FLIPS_PER_DAY（翻转）
	assert.equal(got.length, MOOD_FLIPS_PER_DAY + 1, `首次 + ${MOOD_FLIPS_PER_DAY} 次翻转，实际成功 ${got.length} 次`);
	// 挡住之后状态停在最后一次成功的那个
	assert.equal(getMood(db, who, t0 + 10 * 60_000).label, got[got.length - 1]);
	// 第二天能继续翻
	assert.equal(setMood(db, who, { label: '生气', intensity: 2 }, t0 + 24 * HOUR)?.label, '生气', '跨天恢复');
}

// ── ③ 不误伤：同标签叠加（余温加深）不受闸② 影响 ──
// 既有契约 smoke-persona：1 → 3 → 3。
{
	const who = 'user:m2';
	assert.equal(setMood(db, who, { label: '开心' }, t0).intensity, 2, '首次按默认 2');
	assert.equal(setMood(db, who, { label: '开心' }, t0 + 1000).intensity, 3, '同标签叠加');
	assert.equal(setMood(db, who, { label: '开心' }, t0 + 2000).intensity, 3, '最多 3');
	// 连加十次也还是 3，且不消耗翻转额度
	for (let i = 0; i < 10; i++) setMood(db, who, { label: '开心' }, t0 + 3000 + i * 1000);
	assert.equal(setMood(db, who, { label: '开心' }, t0 + 20_000).intensity, 3, '一直加深也封顶 3');
}

// ── ④ 既有契约：同一个 now 下换情绪必须能翻 ──
// 这条是 smoke-v09 守着的，我不能打挂它 —— 也是我砍掉闸① 的原因。
{
	const who = 'user:m3';
	setMood(db, who, { label: '开心' }, t0);
	assert.equal(markMoodSaid(db, who, t0), true, '新情绪：流露一次');
	assert.equal(markMoodSaid(db, who, t0), false, '之后不再说');
	setMood(db, who, { label: '开心', reason: '又夸她了' }, t0);
	assert.equal(markMoodSaid(db, who, t0), false, '同一个情绪加深也不重复说');
	setMood(db, who, { label: '委屈' }, t0);
	assert.equal(markMoodSaid(db, who, t0), true, '换了情绪要重新算');
}

// ── ⑤ 护栏真的进了提示词（不是常量放着没用）──
{
	setMood(db, 'user:m4', { label: '开心', intensity: 2 }, t0);
	const lines = behaviorLines({
		db, getConfig: () => ({ behavior: { moodAffects: true, outFilter: { enabled: false } } }),
		session: { channel: 'qq-private', channelId: 'private:1' },
		known: [{ ownerId: 'user:m4', displayName: '小明' }],
		tone: '', now: t0 + 1000, diary: null, moods: null,
	});
	const joined = lines.join('\n');
	assert.match(joined, /只是你自己的状态，不是对方情绪的证据/, '护栏必须进提示词');
	assert.match(joined, /脆弱的话时，不许敷衍/, '要写明对方脆弱时不许敷衍');
	assert.ok(MOOD_STATE_GUARD.length > 20, '护栏不能是空串');
}

// ── ⑥ 安静时不误伤：没情绪 / 关掉 moodAffects 都不注入 ──
{
	const cfg = { behavior: { moodAffects: true, outFilter: { enabled: false } } };
	const none = behaviorLines({
		db, getConfig: () => cfg, session: { channel: 'qq-private', channelId: 'private:1' },
		known: [{ ownerId: 'user:never', displayName: '小明' }], tone: '', now: t0, diary: null, moods: null,
	});
	assert.equal(none.some((l) => l.includes('只是你自己的状态')), false, '没情绪时不该有这段');

	setMood(db, 'user:m5', { label: '开心', intensity: 2 }, t0);
	const off = behaviorLines({
		db, getConfig: () => ({ behavior: { moodAffects: false, outFilter: { enabled: false } } }),
		session: { channel: 'qq-private', channelId: 'private:1' },
		known: [{ ownerId: 'user:m5', displayName: '小明' }], tone: '', now: t0 + 1000, diary: null, moods: null,
	});
	assert.equal(off.some((l) => l.includes('只是你自己的状态')), false, 'moodAffects 关掉就不该注入');
}

console.log('✓ mood-guard：6 组断言全过');
