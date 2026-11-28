// #78 最后一条：她分得清消息是从 QQ / B站 / 抖音 / DSH 进来的。
//
// 用户原话（2026-11-20）：「希望AI能分清发给她的消息是从QQ、B站还是DSH来的。」
//
// 为什么不能靠「会话绑定的通道」推断：会话合并之后 B站/抖音私信都并进了 QQ 会话，
// `boundChannel` 永远是 QQ ⇒ DSH 里打的字会被说成 QQ。权威来源是 beginTurn 的 `desktop` 标志
// + 这一轮的 channelId。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { platformLabelOf, sourceLabelOf } from '../lib/gateway-util.js';

test('#78 平台名认得全：QQ 私聊 / QQ 群 / B站私信 / 抖音私信 / 抖音群 / DSH', () => {
	assert.equal(platformLabelOf('private:1234567890'), 'QQ 私聊');
	assert.equal(platformLabelOf('group:1125962189'), 'QQ 群');
	assert.equal(platformLabelOf('bili:98765432109876'), 'B站私信');
	assert.equal(platformLabelOf('douyin:某某'), '抖音私信');
	assert.equal(platformLabelOf('douyin-group:某某群'), '抖音群');
	assert.equal(platformLabelOf('dsh'), 'DSH 桌面端', 'DSH 桌面端要能和 QQ 分开（以前一律当 QQ 私聊）');
});

test('#78 sourceLabelOf：DSH 轮次优先按 desktop 判，不看通道', () => {
	// 关键场景：DSH 里打的字，会话绑定的是 QQ 私聊 —— 但它不是从 QQ 来的
	assert.equal(sourceLabelOf({ desktop: true, channelId: 'private:1234567890' }), 'DSH 桌面端',
		'会话共享时 boundChannel 是 QQ，靠它推断会把 DSH 说成 QQ');
	assert.equal(sourceLabelOf({ desktop: false, channelId: 'private:1234567890' }), 'QQ 私聊');
	assert.equal(sourceLabelOf({ desktop: false, channelId: 'bili:98765432109876' }), 'B站私信');
	assert.equal(sourceLabelOf({ desktop: false, channelId: 'douyin:某某' }), '抖音私信');
	assert.equal(sourceLabelOf({ desktop: false, channelId: 'group:1125962189' }), 'QQ 群');
	assert.equal(sourceLabelOf({}), 'QQ 私聊', '什么都不给时退回默认，不抛错');
});

test('#78 接线：瞬态块真的用了 sourceLabelOf（不是只写好了没接进去）', () => {
	// 本项目第五次「接线零覆盖」：只测新函数不够，要有一条「A 真的经过 B」的断言。
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(src, /const fromLabel = sourceLabelOf\(\{ desktop: session\.desktop === true, channelId: session\.channelId/,
		'瞬态块必须调 sourceLabelOf，而不是自己内联一份判断');
	assert.match(src, /这条消息是从\$\{fromLabel\}发来的/, '[当前说话人] 那行要把来源拼进去');

	// 反例守卫：不许拿 boundChannel 推断来源
	const line = src.match(/const fromLabel = [^\n]*/);
	assert.ok(line, '找不到 fromLabel');
	assert.doesNotMatch(line[0], /boundChannel/, 'boundChannel 在共享会话里永远是 QQ');
});
