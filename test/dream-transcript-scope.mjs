// #166：B站私信记忆串台 —— 给陌生用户整理印象时，喂进去的原文里混着主人和群里的话。
//
// 真根因（真机核实的，不是推断）：
//   `transcriptSample` 拼的通道名是 `qq:<qq_uin>` 和 canonical_id（`p_4eb7df52`），
//   而聊天存档里存的是 gateway 的 channelId（`private:<QQ>` / `douyin:<昵称>` / `bili:<uid>`）
//   ⇒ **永远对不上** ⇒ 每次都走到「无 channel 过滤的全库取样」。
//   真机数据：给抖音陌生人整理时，取样实际拿到的是主人 45 条私聊 + 群里 757 条 + 另一个抖音号 80 条
//   ⇒ 模型把「养的鱼叫肥鱼」「浙江大学生AI竞赛」写成了那个人的印象。
//
// 这里的断言打的是「取样范围」，不是「有没有调 sample」——
// 后者拆掉修复照样绿（本项目踩过很多次的坑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-dream-scope-');
const { openDatabase } = await import('../lib/db.js');
const { LifeEngine } = await import('../lib/life.js');

const db = openDatabase();
const H = 3600_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');

/** 假存档：记下每次 sample 的 channel 参数，并按 channel 返回预置行。 */
function fakeTranscripts(rowsByChannel) {
	const calls = [];
	return {
		calls,
		sample({ channel = '', since = 0, until = Date.now(), limit = 40 } = {}) {
			calls.push({ channel });
			const all = channel !== '' ? (rowsByChannel[channel] ?? []) : Object.values(rowsByChannel).flat();
			return all.filter((r) => r.at >= since && r.at <= until).slice(0, limit);
		}
	};
}

const engine = (transcripts, transcriptReview = true) => new LifeEngine({
	db,
	clock: { now: () => NOW, getRoleDateParts: () => ({ dateStr: '2026-11-20', hour: 20, minute: 0 }) },
	getConfig: () => ({ memory: { transcriptReview, transcriptMaxLines: 40 } }),
	callLlm: async () => null,
	deliver: async () => true,
	log: () => {},
	transcripts
});

const roomy = (text, at) => ({ who: '主人', self: false, content: text, at });

test('#166 给某个人整理时，只取他自己那条私聊的原文（不碰主人、不碰群）', () => {
	const t = fakeTranscripts({
		'private:1234567890': [roomy('我想养鱼，叫肥鱼', NOW - 2 * H)],
		'group:1125962189': [roomy('群里说了一堆插件的事', NOW - 3 * H)],
		'douyin:某人': [roomy('某人的私聊', NOW - 4 * H)]
	});
	const life = engine(t);
	// 这个人只有 B站 UID，没有 QQ 号 ⇒ 只能取 bili:<uid> 那条
	const person = { canonical_id: 'p_xxx', display_name: '陌生人', qq_uin: null, bili_uid: '98765432109876' };
	// 这个人的记忆行里没有可用的私聊通道（只有 B站 uid 可推）
	const out = life.transcriptSample('user:p_xxx', [{ created_at: NOW }], person);

	assert.deepEqual(t.calls.map((c) => c.channel), ['bili:98765432109876'], `只该查他自己那条，实际 ${JSON.stringify(t.calls)}`);
	assert.equal(out, '', '这条 B站 会话在存档里没有行 ⇒ 空串，不许退化成全库取样');
});

test('#166 取不到就返回空，绝不退化成「无 channel 过滤的全库取样」', () => {
	const t = fakeTranscripts({
		'private:1234567890': [roomy('主人的秘密', NOW - 1 * H)],
		'douyin:某某': [roomy('陌生人的招呼', NOW - 1 * H)]
	});
	const life = engine(t);
	// 这个人连 QQ 号都没有（只有抖音身份）⇒ 没有任何可用的通道
	const person = { canonical_id: 'p_4eb7df52', display_name: '某某', qq_uin: null, bili_uid: null, douyin_uid: 'douyin:1111222233334444' };
	const out = life.transcriptSample('user:p_4eb7df52', [{ created_at: NOW }], person);

	assert.deepEqual(t.calls, [], '没有可用通道时连 sample 都不该调（更别说无过滤取样）');
	assert.equal(out, '', '取不到就是空串 —— 少一段原文只是复核糙，多一段别人的原文是记错人');
});

test('#166 通道名按存档的真实形状拼：private:<QQ> / bili:<uid>（不是 qq:<uin>、不是 canonical_id）', () => {
	const t = fakeTranscripts({});
	const life = engine(t);
	assert.deepEqual(life.transcriptChannelsOf({ qq_uin: '1234567890', bili_uid: '' }, []), ['private:1234567890']);
	assert.deepEqual(life.transcriptChannelsOf({ qq_uin: null, bili_uid: '98765432109876' }, []), ['bili:98765432109876']);
	assert.deepEqual(life.transcriptChannelsOf({ qq_uin: '1234567890', bili_uid: '98765432109876' }, []), ['private:1234567890', 'bili:98765432109876']);
	assert.deepEqual(life.transcriptChannelsOf(null, []), []);
});

test('#166 候选通道名也能来自「这个人自己的记忆行」（抖音昵称那路靠它）', () => {
	const life = engine(fakeTranscripts({}));
	assert.deepEqual(
		life.transcriptChannelsOf({ qq_uin: null, bili_uid: null }, [{ channel: 'douyin-private', channel_id: 'douyin:某某' }]),
		['douyin:某某']
	);
});

test('#166 群不在取样范围里（他在群里说的话不是「他和我的对话」）', () => {
	const life = engine(fakeTranscripts({}));
	// 两种群形态都要排除 —— 判据是记忆行的 channel 字段（qq-group / douyin-group），
	// 不是 channel_id 的前缀。
	const chs = life.transcriptChannelsOf({ qq_uin: '1234567890' }, [
		{ channel: 'qq-group', channel_id: 'group:1125962189' },
		{ channel: 'douyin-group', channel_id: 'douyin-group:某群' }
	]);
	assert.deepEqual(chs, ['private:1234567890'], '只有他自己的私聊通道；群一条都不能进来');
	assert.ok(!chs.includes('group:1125962189'), 'QQ 群不能被当成这个人的私聊');
	assert.ok(!chs.includes('douyin-group:某群'), '抖音群不能被当成这个人的私聊');
});

test('#166 抖音通道不硬猜：存档里是昵称，person 里是 uid，猜一个昵称就是把别人的话记到他头上', () => {
	const life = engine(fakeTranscripts({}));
	const chs = life.transcriptChannelsOf({ douyin_uid: 'douyin:1111222233334444', qq_uin: null, bili_uid: null }, []);
	assert.deepEqual(chs, [], '只有抖音身份、又没有记忆行时宁可不给原文（不硬猜昵称）');
});

test('#166 开关关着就不取样（既有契约不变）', () => {
	const t = fakeTranscripts({ 'private:1234567890': [roomy('x', NOW - H)] });
	const life = engine(t, false);
	assert.equal(life.transcriptSample('user:master', [{ created_at: NOW }], { qq_uin: '1234567890' }), '');
	assert.deepEqual(t.calls, []);
});

test('#166 取到的原文按角色时区标时间（原来 toISOString 是 UTC，比角色时区早 8 小时）', () => {
	const at = Date.parse('2026-11-20T12:30:00Z'); // UTC 12:30 = 角色时区 20:30
	const t = fakeTranscripts({ 'private:1234567890': [{ who: '主人', self: false, content: '在吗', at }] });
	const life = engine(t);
	const out = life.transcriptSample('user:master', [{ created_at: NOW }], { display_name: '主人', qq_uin: '1234567890' });
	assert.match(out, /\[11-20 20:30\]/, `时间戳该是角色时区 20:30，实际：${out}`);
});
