// @ 她时：如果是在"回复某条评论"，把她被回的那条原文也带上；顶层 @ 不多打接口。
import assert from 'node:assert/strict';

const { BiliClient } = await import('../lib/channels/bilibili.js');

const makeClient = (items, replies = {}) => {
	const client = Object.create(BiliClient.prototype);
	client.auth = { cookies: {} };
	client.calls = [];
	client.call = async (host, path, opts = {}) => {
		client.calls.push({ path, params: opts.params });
		if (path === '/x/msgfeed/at') return { data: { items } };
		if (path === '/x/v2/reply/reply') {
			const key = String(opts.params?.pn ?? 1);
			return replies[key] ?? replies.default ?? { data: { root: null, replies: [] } };
		}
		throw new Error('unexpected ' + path);
	};
	return client;
};

const atItem = ({ id, sourceId, rootId, targetId }) => ({
	id,
	item: {
		business_id: 1,
		subject_id: '777',
		source_id: sourceId,
		root_id: rootId,
		target_id: targetId,
		title: '某个视频',
		source_content: '@xml的贪吃鱼 你看这条',
		type: 'reply'
	},
	user: { mid: '5', nickname: '阿茶' },
	at_time: 1793800000
});

// 1. 顶层新评论 @ 她（target_id = 0）：只打一次 at 接口，target 空
{
	const client = makeClient([atItem({ id: '1', sourceId: '100', rootId: 0, targetId: 0 })]);
	const list = await client.atFeed();
	assert.equal(list.length, 1);
	assert.equal(list[0].target, '');
	assert.equal(client.calls.filter((c) => c.path === '/x/v2/reply/reply').length, 0, '顶层不该多打接口');
}

// 2. 回复别人的评论时 @ 她：把被回复的那条抓回来
{
	const client = makeClient([atItem({ id: '2', sourceId: '200', rootId: '100', targetId: '100' })], {
		1: { data: { root: { rpid: 100, member: { uname: '某人' }, content: { message: 'AI 迟早取代程序员' } }, replies: [] } }
	});
	const list = await client.atFeed();
	assert.equal(list[0].target, '某人：AI 迟早取代程序员');
}

// 3. 被回复的是子楼里某条：从 replies 里按 rpid 找
{
	const client = makeClient([atItem({ id: '3', sourceId: '300', rootId: '100', targetId: '150' })], {
		1: {
			data: {
				root: { rpid: 100, member: { uname: '楼主' }, content: { message: '楼主说' } },
				replies: [{ rpid: 150, member: { uname: '路人' }, content: { message: '这游戏我玩了三遍' } }]
			}
		}
	});
	const list = await client.atFeed();
	assert.equal(list[0].target, '路人：这游戏我玩了三遍');
}

// 4. 拉原文失败：不影响这条 @，target 保持空
{
	const client = makeClient([atItem({ id: '4', sourceId: '400', rootId: '100', targetId: '100' })]);
	client.call = async (host, path, opts = {}) => {
		if (path === '/x/msgfeed/at') return { data: { items: [atItem({ id: '4', sourceId: '400', rootId: '100', targetId: '100' })] } };
		throw new Error('boom');
	};
	const list = await client.atFeed();
	assert.equal(list.length, 1);
	assert.equal(list[0].target, '');
}

console.log('@ 时带上被回复的评论：测试全部通过');
