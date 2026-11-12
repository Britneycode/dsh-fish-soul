// 系统页「运行日志」。
//
// 为什么要有它：排查「她怎么突然不对劲」时，最常问的是「插件启动挂在第几步」、
// 「人格卡挂上没有」、「会话是新建还是恢复的」。这些以前只写在宿主终端日志里，
// 重启就没了。现在记在内存里（最近 200 条），系统页能看、能贴到 issue。
//
// 这个测试钉住四件事：
//   ① 同一个 key 短时间重复只累加 count，不刷屏（启动失败那种每秒一次的不会冲掉缓冲）
//   ② 超过上限只留最近 200 条
//   ③ 未知 key 也要能显示（宁可露出机器名，也别悄悄变空白）
//   ④ describeEntry 的中文说明要能覆盖常见 detail
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('diag-log-');
const { openDatabase } = await import('../lib/db.js');
const { DiagLog, describeEntry } = await import('../lib/diag-log.js');

const db = openDatabase();
const ok = (n) => console.log('✓', n);

{
	// ① 去重：同一 key 连发 5 次 → 1 条 + count 5
	let now = 1_000_000;
	const d = new DiagLog({ db, now: () => now });
	for (let i = 0; i < 5; i++) { d.add('mount-no-ctx', { sessionId: 's1' }); now += 100; }
	const list = d.list();
	assert.equal(list.length, 1, '同一 key 短时间重复要合并成一条');
	assert.equal(list[0].count, 5, '合并后 count 要累加');
	ok('同一 key 短时间重复：合并计数，不刷屏');
}

{
	// 去重窗口过了就另起一条
	let now = 2_000_000;
	const d = new DiagLog({ db, now: () => now });
	d.add('mount-no-ctx', { sessionId: 's1' });
	now += 61_000; // 超过 DEDUPE_MS（60s）
	d.add('mount-no-ctx', { sessionId: 's1' });
	assert.equal(d.list().length, 2, '过了去重窗口要另起一条');
	ok('过了去重窗口：另起一条（不会永远合并）');
}

{
	// ② 上限：塞 250 条，只留 200
	let now = 3_000_000;
	const d = new DiagLog({ db, now: () => now });
	for (let i = 0; i < 250; i++) { d.add('startup-step', { step: i }); now += 61_000; }
	const list = d.list(999);
	assert.equal(list.length, 200, '最多留 200 条');
	// 新的在前：最后一条的 step 是 249
	assert.equal(list[0].detail.step, 249, 'list() 新的在前');
	ok('超过上限只留最近 200 条');
}

{
	// ③ 未知 key：label 回落成 key 本身，不能变空白
	const d = new DiagLog({ db, now: () => 4_000_000 });
	d.add('some-new-event', { reason: 'x' });
	const list = d.list();
	assert.equal(list[0].label, 'some-new-event', '没登记的 key 要原样显示，别变空白');
	ok('没登记的 key 原样显示（宁可露机器名也不装没事）');
}

{
	// ④ describeEntry 中文说明
	const cases = [
		[{ key: 'startup-step', detail: { step: 3, name: '人格' }, count: 1 }, /第 3 步.*人格/],
		[{ key: 'context-size', detail: { chars: 1500, budget: 1200, over80: true }, count: 1 }, /1500 字.*预算 1200.*超 80%/],
		[{ key: 'resume-failed', detail: { sessionId: 'fish-soul-abc123', reason: 'not found' }, count: 1 }, /会话 fish-soul-ab.*not found/],
		[{ key: 'mount-failed', detail: {}, count: 2 }, /重复 2 次/],
		[{ key: 'x', detail: {}, count: 1 }, /没有细节/]
	];
	for (const [entry, re] of cases) {
		assert.match(describeEntry(entry), re, `describeEntry 要说人话：${JSON.stringify(entry)}`);
	}
	ok('describeEntry 把常见 detail 翻成人话');
}

{
	// 清空
	const d = new DiagLog({ db, now: () => 5_000_000 });
	d.add('startup-step', { step: 1 });
	d.clear();
	assert.equal(d.list().length, 0, 'clear() 要清空');
	ok('清空');
}

console.log('diag-log ok');
