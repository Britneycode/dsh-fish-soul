import assert from 'node:assert/strict';
import { BiliBrowser } from '../lib/browse.js';

// 只测 cfg() 的夹取（不跑浏览流程）
const make = (browse) => new BiliBrowser({
	db: { exec() {}, prepare() { return { run() {}, get() { return null; }, all() { return []; } }; } },
	clock: { now: () => 0 },
	client: {},
	getConfig: () => ({ enabled: true, browse }),
	callLlm: async () => '',
	persona: {},
	log: () => {},
	watchDelayMs: [0, 0],
	note: () => {}
});

// 默认值不变
const d = make({}).cfg();
assert.equal(d.commentPerDay, 1, '留评默认 1');
assert.equal(d.commentReplyPerDay, 1, '楼中楼默认 1');
assert.equal(d.favoritePerDay, 2, '收藏默认 2');
assert.equal(d.hotComments, 6, '热评默认 6');
assert.equal(d.framesPerDay, 1, '抽帧默认 1');

// 能调到新上限
const up = make({ commentPerDay: 20, commentReplyPerDay: 20, favoritePerDay: 30, hotComments: 30, framesPerDay: 15 }).cfg();
assert.equal(up.commentPerDay, 20, '留评上限 20');
assert.equal(up.commentReplyPerDay, 20, '楼中楼上限 20');
assert.equal(up.favoritePerDay, 30, '收藏上限 30');
assert.equal(up.hotComments, 30, '热评上限 30');
assert.equal(up.framesPerDay, 15, '抽帧上限 15');

// 超过上限仍被夹住，不会无限大
const over = make({ commentPerDay: 999, commentReplyPerDay: 999, favoritePerDay: 999, hotComments: 999, framesPerDay: 999 }).cfg();
assert.equal(over.commentPerDay, 20);
assert.equal(over.commentReplyPerDay, 20);
assert.equal(over.favoritePerDay, 30);
assert.equal(over.hotComments, 30);
assert.equal(over.framesPerDay, 15);

// 负数归 0
const neg = make({ commentPerDay: -5, favoritePerDay: -1 }).cfg();
assert.equal(neg.commentPerDay, 0);
assert.equal(neg.favoritePerDay, 0);

console.log('额度上限测试全部通过');
