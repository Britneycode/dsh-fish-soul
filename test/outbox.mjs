// QQ 重发队列：没连上排队、连上补发、顺序不乱、超时放弃、可能已发出的不重发。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Outbox, classifySendError } from '../lib/outbox.js';

assert.equal(classifySendError(new Error('QQ 未连接')), 'retry');
assert.equal(classifySendError(new Error('发送失败（retcode 1200）')), 'retry');
assert.equal(classifySendError(new Error('连接已断开')), 'unknown');
assert.equal(classifySendError(new Error('send_group_msg 超时')), 'unknown');

let now = 1_000_000;
const sent = []; const gaveUp = []; const ok = [];
let mode = 'down';
const channel = {
	connected: false,
	async send(cid, segs) {
		if (mode === 'down') throw new Error('QQ 未连接');
		if (mode === 'ambiguous') throw new Error('连接已断开');
		sent.push([cid, segs[0].data.text]);
		return String(sent.length);
	}
};
const db = new DatabaseSync(':memory:');
const box = new Outbox({
	db, channel, windowMs: () => 10 * 60_000, now: () => now,
	onSent: (id, item) => ok.push([id, item.text]),
	onGiveUp: (item, reason) => gaveUp.push([item.text, reason])
});
const seg = (t) => [{ type: 'text', data: { text: t } }];

box.enqueue({ channelId: 'private:1', segs: seg('a'), text: 'a' });
box.enqueue({ channelId: 'private:1', segs: seg('b'), text: 'b' });
box.enqueue({ channelId: 'group:2', segs: seg('c'), text: 'c' });
assert.equal(box.hasQueued('private:1'), true);
assert.equal(box.size(), 3);

// 没连上：不发、不算次数
await box.flush({ force: true });
assert.equal(sent.length, 0);
assert.equal(box.size(), 3);

// 连上了：按顺序补发
channel.connected = true; mode = 'up';
await box.flush({ force: true });
assert.deepEqual(sent, [['private:1', 'a'], ['private:1', 'b'], ['group:2', 'c']]);
assert.equal(box.size(), 0);
assert.equal(ok.length, 3);

// 超过回复时限：放弃
box.enqueue({ channelId: 'private:1', segs: seg('old'), text: 'old' });
now += 11 * 60_000;
await box.flush({ force: true });
assert.equal(box.size(), 0);
assert.match(gaveUp.at(-1)[1], /超过回复时限/);

// 重发时变成"可能已发出"：不再重发，后面的照常
box.enqueue({ channelId: 'private:9', segs: seg('x'), text: 'x' });
mode = 'ambiguous';
await box.flush({ force: true });
assert.equal(box.size(), 0);
assert.match(gaveUp.at(-1)[1], /可能已经发出去了/);

// 一直被拒：退避，重试用完放弃
mode = 'down';
box.enqueue({ channelId: 'private:5', segs: seg('y'), text: 'y' });
for (let i = 0; i < 5; i++) await box.flush({ force: true });
assert.equal(box.size(), 0);
assert.match(gaveUp.at(-1)[1], /重发 5 次都没成功/);

box.stop();
console.log('✓ QQ 重发队列：没连上排队 / 连上按顺序补发 / 超时放弃 / 可能已发出不重发 / 重试用完放弃');
