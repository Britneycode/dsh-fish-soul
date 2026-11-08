// 抖音「每次都要手机号验证」的反馈：碰到验证后固定停 6 小时 → 停完再试 → 又被验证 → 又停 6 小时，
// 一直循环。改成按连续次数指数退避（6 → 12 → 24 → 48 小时，封顶 72 小时），验证通过一次就清零。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-dyverify-');
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
const { openDatabase, getKv } = await import('../lib/db.js');
const db = openDatabase();
process.env.DSH_HOME = prevHome;

const { DouyinSocial } = await import('../lib/douyin-social.js');
const notes = [];
const social = new DouyinSocial({
	db,
	clock: { now: () => Date.now() },
	getConfig: () => ({}),
	callLlm: async () => '',
	worker: { enqueueRealtime: () => {} },
	host: { running: false, loggedIn: false, exclusive: async (_l, fn) => fn() },
	driver: {},
	notify: (kind, msg) => notes.push([kind, msg]),
});

// 连续 5 次被拦：停的时间要越来越久
const hours = [];
for (let i = 0; i < 5; i++) {
	social.blocked('发作品');
	hours.push(Math.round((social.blockedUntil - Date.now()) / 3600_000));
}
assert.deepEqual(hours, [6, 12, 24, 48, 72], '连续被验证要指数退避（72 小时封顶）');
assert.equal(getKv(db, 'douyin.verify.count', 0), 5, '连续次数要记下来');
assert.ok(notes.every(([k]) => k === 'douyin.verify'), '每次都要提醒主人');
assert.ok(notes[4][1].includes('第 5 次'), '通知里要说清是第几次');
assert.ok(notes[4][1].includes('72 小时'), '通知里要说清停了多久');

// 验证过一次 → 计数清零，下次回到 6 小时
social.verifyCleared();
assert.equal(getKv(db, 'douyin.verify.count', 0), 0, '验证过了计数清零');
social.blocked('发作品');
assert.equal(Math.round((social.blockedUntil - Date.now()) / 3600_000), 6, '清零后重新从 6 小时起算');

db.close();
console.log('✓ 抖音验证：连续触发指数退避（6→12→24→48→72 小时），验证过了清零');
