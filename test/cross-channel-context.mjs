// #78：把「他在别的平台刚说过什么」搬几句到当前会话的瞬态块里。
//
// 为什么不是「共用同一个会话」：会话 ↔ 聊天是一对一（chat_session 一行一个 channel_id），
// 回复发到哪由 sendReply 读 row.channel_id 决定；合并要把回复目标降成轮次级，动的是核心链路。
// 这里只搬原文几句，标明平台，收益差不多、风险小得多。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { ChatJournal } = await import('../lib/soul-memory.js');
const { platformLabelOf } = await import('../lib/gateway-util.js');
const ok = (n) => console.log('✓', n);

const H = 3600_000;
const now = 100 * H;

function journal() {
	const j = new ChatJournal({ keepRecent: 50 });
	const put = (channelId, items) => {
		for (const [at, who, ownerId, text, self] of items) j.add(channelId, { who, ownerId, text, self, at });
	};
	return { j, put };
}

{
	const { j, put } = journal();
	put('qq:private:10001', [[now - 1 * H, '主人', 'user:master', '在吗']]);
	put('bili:12345', [
		[now - 30 * 60_000, '主人', 'user:master', '你看看这个视频'],
		[now - 29 * 60_000, '鱼', 'user:master', '看了，橘猫弹钢琴那个吧', true],
	]);
	const got = j.recentAcrossChannels('user:master', { except: 'qq:private:10001', now });
	assert.equal(got.length, 1, '只搬另一个通道');
	assert.equal(got[0].channelId, 'bili:12345');
	assert.deepEqual(got[0].lines, ['主人：你看看这个视频', '我：看了，橘猫弹钢琴那个吧']);
	ok('QQ 私聊里能看到 B站私信刚说过的话（带署名，她自己的话是「我」）');
}

{
	// 当前通道不重复搬
	const { j, put } = journal();
	put('qq:private:10001', [[now - 60_000, '主人', 'user:master', '在吗']]);
	assert.equal(j.recentAcrossChannels('user:master', { except: 'qq:private:10001', now }).length, 0);
	ok('当前通道自己那几句不重复注入');
}

{
	// 别人的话不能跟着搬过来
	const { j, put } = journal();
	put('qq:private:20002', [[now - 60_000, '路人', 'user:someone', '你好']]);
	assert.equal(j.recentAcrossChannels('user:master', { except: 'qq:private:10001', now }).length, 0);
	ok('别人跟她的私聊不会被搬给主人');
}

{
	// 同一日志里主人曾通过 DSH 发言，之后 B 在自己的私聊里对话：B 的回复不能跟着搬给主人。
	const { j, put } = journal();
	put('private:20002', [
		[now - 4000, '主人', 'user:master', '桌面端说话'],
		[now - 3000, 'B', 'user:b', '秘密'],
		[now - 2000, '鱼', 'user:b', '这是给 B 的私密回复', true],
		[now - 1000, '鱼', null, '无法确定归属的回复', true],
	]);
	const got = j.recentAcrossChannels('user:master', { except: 'private:10001', now });
	assert.equal(got.length, 1);
	assert.deepEqual(got[0].lines, ['主人：桌面端说话'], '只搬有明确归属的内容，不能带 B 的回复或未知归属回复');
	ok('#105：混合日志不会把其他人的回复带给主人');
}

{
	// 群聊不搬（调用方用 allow 挡，这里直接验 allow）
	const { j, put } = journal();
	put('group:88888', [[now - 60_000, '群友', 'user:master', '群里说一句']]);
	const all = j.recentAcrossChannels('user:master', { except: '', now });
	assert.equal(all.length, 1, '不设 allow 时群也能取到（说明过滤在调用方）');
	const priv = j.recentAcrossChannels('user:master', { except: '', now, allow: (id) => !String(id).startsWith('group:') });
	assert.equal(priv.length, 0, '群里的话不能搬进私聊');
	ok('群聊内容不会被搬进私聊（只搬私聊通道）');
}

{
	// 太久没说话的不搬：只有「刚说的」才有意义
	const { j, put } = journal();
	put('bili:12345', [[now - 30 * H, '主人', 'user:master', '昨天看的']]);
	assert.equal(j.recentAcrossChannels('user:master', { except: '', now }).length, 0);
	assert.equal(j.recentAcrossChannels('user:master', { except: '', now, withinMs: 48 * H }).length, 1);
	ok('太久以前的对话不搬（默认 6 小时内）');
}

{
	// 多个平台都说过话：最近说话的排前面，调用方只取前两个
	const { j, put } = journal();
	put('bili:12345', [[now - 3 * H, '主人', 'user:master', 'B站那句']]);
	put('douyin:主人', [[now - 10 * 60_000, '主人', 'user:master', '抖音那句']]);
	const got = j.recentAcrossChannels('user:master', { except: 'qq:private:10001', now });
	assert.deepEqual(got.map((x) => x.channelId), ['douyin:主人', 'bili:12345']);
	ok('多个平台按「最近说话」排序，调用方只取前两个');
}

{
	// 接线：注入点必须在私聊分支、必须排除当前通道、必须只用真实钟比时间
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(src, /if \(!sharedSession && !inGroup && known\.length === 1 && session\.channelId !== ''\) \{[\s\S]{0,400}recentAcrossChannels\(/, '只在私聊、只对认出来的那一个人注入');
	assert.match(src, /const sharedSession = boundChannel !== '' && boundChannel !== session\.channelId/, '会话已经共享了就别再搬（那些话本来就在同一个会话里）');
	assert.match(src, /except: session\.channelId/, '当前通道要排除');
	assert.match(src, /now: Date\.now\(\)/, '通道活跃时间是真实钟，不能用虚拟钟');
	assert.match(src, /endsWith\('group'\)/, '群通道不能搬');
	ok('接线：私聊才注入、排除当前通道、群不搬、用真实钟');
}

{
	// 标明「这句是在哪儿说的」：不同平台的通道 id 要能翻成人话
	assert.equal(platformLabelOf('bili:12345'), 'B站私信');
	assert.equal(platformLabelOf('douyin:主人'), '抖音私信');
	assert.equal(platformLabelOf('qq:private:10001'), 'QQ 私聊');
	assert.equal(platformLabelOf('group:88888'), 'QQ 群');
	assert.equal(platformLabelOf('douyin-group:某某群'), '抖音群');
	ok('平台名：B站私信 / 抖音私信 / QQ 私聊 / QQ 群 / 抖音群 都能翻');
}

console.log('cross-channel-context ok');
