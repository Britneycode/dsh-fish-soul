// relaySenderIdOf：会话 → 发起人平台 uid。
//
// 2026-11-19 的真实事故：这个函数曾是 `relaySenderId(db, session)`，但调用点只传一个参数
// ⇒ db 顶掉 session 位 ⇒ 恒返回空串 ⇒ 白名单里任何人传话都回「认不出你是谁」。
// 一行修，但**没有测试守着**，谁改回去都不会红。
//
// 抽成纯函数 + 依赖注入后，「参数错位」在调用形式层面就写不出来（只有一个参数，且必须传 session）。
// 这个套件守三件事：
//   ① 三个平台分支都能正确反查（用真库结构，不写真数据）
//   ② 认不出时返回空串（不是抛错、不是返回垃圾）
//   ③ **参数错位形态必须返回空串** —— 这条是事故的回归锁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relaySenderIdOf } from '../lib/gateway-util.js';

// 假库：形状照抄真机的 person 表（qq_uin / bili_uid 是 TEXT 列）
const fakeDb = { kind: 'db-handle' };
const people = [
	{ qq_uin: '10001', bili_uid: '', display_name: '甲' },
	{ qq_uin: '', bili_uid: '50001', display_name: '乙' }
];
const deps = {
	db: fakeDb,
	findPersonByQq: (db, qq) => {
		assert.equal(db, fakeDb, '必须把 db 原样传给查询函数');
		return people.find((p) => p.qq_uin === String(qq));
	},
	findPersonByBili: (db, uid) => {
		assert.equal(db, fakeDb, '必须把 db 原样传给查询函数');
		return people.find((p) => p.bili_uid === String(uid));
	}
};

test('private 通道 → qq:<uid>', () => {
	assert.equal(relaySenderIdOf({ channelId: 'private:10001' }, deps), 'qq:10001');
});

test('bili 通道 → bili:<uid>', () => {
	assert.equal(relaySenderIdOf({ channelId: 'bili:50001' }, deps), 'bili:50001');
});

test('库里没有这个人 → 空串（不是抛错、不是返回裸 uid）', () => {
	assert.equal(relaySenderIdOf({ channelId: 'private:99999' }, deps), '');
	assert.equal(relaySenderIdOf({ channelId: 'bili:99999' }, deps), '');
});

test('空会话 / 空 channelId / 群通道 → 空串', () => {
	assert.equal(relaySenderIdOf(undefined, deps), '');
	assert.equal(relaySenderIdOf({}, deps), '');
	assert.equal(relaySenderIdOf({ channelId: '' }, deps), '');
	assert.equal(relaySenderIdOf({ channelId: 'group:1125962189' }, deps), '');
});

// ── 事故回归锁：参数错位形态 ──
// 旧签名是 relaySenderId(db, session)，调用点传一个参数时 db 占了 session 位。
// 新签名只有一个参数；如果谁「按旧习惯」把 db 当 session 传，必须得到空串而不是别的。
test('参数错位（把 db 当 session 传）→ 空串', () => {
	const out = relaySenderIdOf(fakeDb, deps);
	assert.equal(out, '', 'db 句柄没有 channelId ⇒ 必须返回空串');
});

test('抖音分支：昵称不是身份，只认游标反查出来的 douyin:<数字>', () => {
	// 昵称能改能撞名 ⇒ 不认
	const noIdentity = relaySenderIdOf({ channelId: 'douyin:某人' }, { ...deps, douyinIdentityOfChannel: () => '' });
	assert.equal(noIdentity, '');

	// 游标给出真 uid ⇒ 认
	const withIdentity = relaySenderIdOf(
		{ channelId: 'douyin:某人' },
		{ ...deps, douyinIdentityOfChannel: () => 'douyin:1234567890123456789' }
	);
	assert.equal(withIdentity, 'douyin:1234567890123456789');

	// 游标给的东西形状不对（不是 douyin:<数字>）⇒ 不认
	const badShape = relaySenderIdOf(
		{ channelId: 'douyin:某人' },
		{ ...deps, douyinIdentityOfChannel: () => '某人' }
	);
	assert.equal(badShape, '', '形状不对的 identity 不能当身份用');
});

test('依赖没注入 → 不崩，返回空串', () => {
	// 防御性：少了 findPersonByQq 也不能抛（工具入口那条路可能是半初始化的）
	assert.equal(relaySenderIdOf({ channelId: 'private:10001' }, {}), '');
});
