// 时间观念：她得读得出「周几」和「上一条是多久之前」。
//
// 为什么要有这个测试：`[此刻状态]` 以前只有「虚拟时间 2026-11-19 18:11」——
// 能读几点，读不出周几、也读不出隔了多久。后者是「好久不见」永远不出现的原因。
//
// 两条硬约束（参考 SillyTavern / AstrBot 的做法 + DESIGN-fish-soul.md）：
//   1. 星期和 idle 只出现在瞬态块里，不进 system 段（秒级时间戳进稳定前缀会毁掉缓存）
//   2. idle 必须在本轮 journal.add **之前**取，否则永远是「刚刚」
import assert from 'node:assert/strict';

import { stateLineText, weekdayOf, idleLabel } from '../lib/time-awareness.js';
import { ChatJournal } from '../lib/soul-memory.js';

const ok = (m) => console.log('✓', m);

// ── 1. weekdayOf：角色时区（UTC+8）下的星期 ──
assert.equal(weekdayOf('2026-11-19'), '周四', '2026-11-19 是周四');
assert.equal(weekdayOf('2026-11-22'), '周日', '2026-11-22 是周日');
assert.equal(weekdayOf('2026-11-21'), '周六', '2026-11-21 是周六');
assert.equal(weekdayOf(''), '', '空串不猜');
assert.equal(weekdayOf(NaN), '', 'NaN 不猜');
assert.equal(weekdayOf('2026-13-01'), '', '月份越界不猜');
assert.equal(weekdayOf('2026-11-19 18:11:00'), '周四', '带时分秒也能认（取日期部分）');
assert.equal(weekdayOf(undefined), '', 'undefined 不猜');
ok('weekdayOf：日期串算星期，认不出返回空');

// ── 2. idleLabel：30 分钟以内不值得说（同一段对话，报「刚才」是噪音）──
assert.equal(idleLabel(null), null);
assert.equal(idleLabel(29 * 60_000), null, '29 分钟不报');
assert.equal(idleLabel(30 * 60_000), '30 分钟', '30 分钟起报');
assert.equal(idleLabel(90 * 60_000), '1 小时', '整点向下取整');
assert.equal(idleLabel(25 * 3600_000), '1 天', '跨天用天');
assert.equal(idleLabel(3 * 86400_000), '3 天');
ok('idleLabel：分 / 小时 / 天，30 分钟内静默');

// ── 3. stateLineText：整行拼装 ──
{
	const line = stateLineText({
		virtualIsoLocal: '2026-11-19 18:11:00',
		weekday: '周四',
		idleMs: 3 * 3600_000,
		tone: '平静',
		slot: { range: '18:00-22:00', availability: 'idle', activity: '在宿舍刷视频' }
	});
	assert.ok(line.startsWith('[此刻状态] '), '开头标记不变');
	assert.ok(line.includes('2026-11-19 18:11:00（周四）'), `时间后面要带星期，实际：${line}`);
	assert.ok(line.includes('距上次说话 3 小时'), `要带间隔，实际：${line}`);
	assert.ok(line.includes('基调 平静'));
	assert.ok(line.includes('在宿舍刷视频'), '日程照旧');
	ok('stateLineText：星期 + 间隔 + 基调 + 时段都在');
}

// 没有 idle（同一段对话）时不留空话
{
	const line = stateLineText({ virtualIsoLocal: '2026-11-19 18:11:00', weekday: '周四', idleMs: 60_000, tone: '平静', slot: null });
	assert.ok(!line.includes('距上次说话'), `短间隔不该出现，实际：${line}`);
	assert.ok(line.includes('今天没排日程'));
	ok('stateLineText：短间隔静默、没日程照旧说明');
}

// ── 4. 接线：idleMs 必须在 journal.add 之前取 ──
// 直接测 Journal 的语义：add 之后 lastAt 立刻变，所以「先取再 add」和「先 add 再取」结果不同。
{
	const j = new ChatJournal({});
	const t0 = Date.now() - 5 * 3600_000;
	j.add('qq-private:1', { who: '他', text: '在吗', at: t0 });
	const before = j.lastSpokeAt('qq-private:1');
	assert.equal(before, t0, 'lastSpokeAt 读的是最后一条的时刻');
	const idle = Date.now() - before;
	assert.ok(idle > 4.9 * 3600_000, `先取能算出真实间隔，实际 ${idle}`);

	j.add('qq-private:1', { who: '他', text: '又来了' });
	const after = j.lastSpokeAt('qq-private:1');
	assert.ok(after > before, 'add 之后 lastAt 被刷新');
	assert.ok(Date.now() - after < 1000, '刷新后算出来就是「刚刚」—— 这就是必须先取的原因');
	ok('Journal.lastSpokeAt：先取才有真实间隔，后取永远是刚刚');
}

// 没人说过话的通道返回 0，不编造
{
	const j = new ChatJournal({});
	assert.equal(j.lastSpokeAt('qq-private:nobody'), 0);
	ok('Journal.lastSpokeAt：没说过话返回 0');
}

// ── 5. #196：关掉日程后，基调和日程整段都不该再注入 ──
{
	const off = stateLineText({
		virtualIsoLocal: '2026-11-23 23:08:00', weekday: '周一', tone: '平静', slot: null, scheduleEnabled: false
	});
	assert.equal(off, '[此刻状态] 虚拟时间 2026-11-23 23:08:00（周一）', `关掉日程后只剩时间，实际：${off}`);
	assert.ok(!off.includes('基调'), '不该再有基调');
	assert.ok(!off.includes('今天没排日程'), '不该再有「今天没排日程」');

	// 关掉时即使 slot 还在（快照里有），也不能漏出来
	const offSlot = stateLineText({
		virtualIsoLocal: '2026-11-23 23:08:00', weekday: '周一', tone: '平静',
		slot: { range: '22:00-24:00', availability: 'idle', activity: '刷视频' }, scheduleEnabled: false
	});
	assert.ok(!offSlot.includes('时段'), '关掉日程后时段也不能出现');
	assert.ok(!offSlot.includes('刷视频'), '关掉日程后活动内容也不能出现');

	// 默认不传 = 开（旧调用方行为不变）
	const def = stateLineText({ virtualIsoLocal: '2026-11-23 23:08:00', weekday: '周一', tone: '平静', slot: null });
	assert.ok(def.includes('基调 平静') && def.includes('今天没排日程'), '不传 scheduleEnabled 保持旧行为');

	// 关掉时 idle 仍要保留（它跟日程无关，是「距上次说话」）
	const offIdle = stateLineText({
		virtualIsoLocal: '2026-11-23 23:08:00', weekday: '周一', idleMs: 3 * 3600_000, scheduleEnabled: false
	});
	assert.ok(offIdle.includes('距上次说话 3 小时'), '关掉日程不影响 idle 提示');
	ok('stateLineText：#196 关掉日程后基调/时段/没排日程整段不注入，idle 不受影响');
}

// ── 6. #196 接线：index.js 的 stateLine 必须把 life.scheduleEnabled() 传进去 ──
// 只测纯函数不够——函数写对了但没人传参，关掉日程照样注入。读源码断言参数确实接上。
{
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.ok(/scheduleEnabled:\s*life\.scheduleEnabled\(\)/.test(src),
		'index.js 的 stateLine 必须把 life.scheduleEnabled() 传给 stateLineText');
	ok('#196 接线：stateLine 把 life.scheduleEnabled() 传进 stateLineText');
}

console.log('时间观念：测试全部通过');
