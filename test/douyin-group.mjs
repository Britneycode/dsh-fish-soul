// 抖音群聊：认出群、按发言的人分开（不把整个群当一个人）
import assert from 'node:assert/strict';
import { isGroupConversation, groupSender, normalizeDouyinMessage } from '../lib/channels/douyin.js';
import { mergeMessages } from '../lib/channels/vendor/douyin-bridge/media.mjs';
import { platformOf, sessionChannelOf, splitChannelId, isGroupChannelId, groupOwnerOf } from '../lib/gateway-util.js';

const ok = (s) => console.log(`  ✓ ${s}`);

// 认群：会话类型 2 / 会话 ID 不是单聊形状 / 两个以上的人 / 手动填的
assert.equal(isGroupConversation([{ text: 'a', convId: '0:1:11:22', convType: 1, senderId: '11' }]), false);
assert.equal(isGroupConversation([{ text: 'a', convType: 2 }]), true);
assert.equal(isGroupConversation([{ text: 'a', convId: '0:2:7300' }]), true);
assert.equal(isGroupConversation([{ text: 'a', senderId: '1' }, { text: 'b', senderId: '2' }]), true);
assert.equal(isGroupConversation([{ text: 'a', senderId: '1' }, { text: 'b', senderId: '2', fromMe: true }]), false, '自己不算');
assert.equal(isGroupConversation([{ text: 'a' }], { name: '爬山群', groups: ['爬山群'] }), true);
assert.equal(isGroupConversation([{ text: 'a' }], { name: '阿二' }), false);
ok('认群：会话类型 / 会话 ID / 多人发言 / 手动填的');

// 谁说的：昵称 > 之前对上的昵称 > 群友+ID 后四位；都没有 = 认不出
assert.deepEqual(groupSender({ senderName: ' 阿三 ', senderId: '123456' }), { userId: '阿三', nickname: '阿三' });
assert.deepEqual(groupSender({ senderId: '123456' }, { 123456: '阿三' }), { userId: '阿三', nickname: '阿三' });
assert.deepEqual(groupSender({ senderId: '123456' }), { userId: 'uid:123456', nickname: '群友3456' });
assert.deepEqual(groupSender({}), { userId: '', nickname: '' });
const g = normalizeDouyinMessage({ text: '你好', senderName: '阿三' }, { name: '爬山群', timeMs: 1, messageId: 'm1', group: true });
assert.deepEqual([g.chatType, g.channelId, g.targetId, g.groupId, g.userId, g.nickname, g.mentioned], ['group', 'douyin-group:爬山群', '爬山群', '爬山群', '阿三', '阿三', false]);
assert.equal(normalizeDouyinMessage({ text: '你好' }, { name: '爬山群', timeMs: 1, messageId: 'm1', group: true }), null, '认不出是谁说的不当成群本身');
// 🔴 契约变更（2026-11-10）：私信的 userId 不再用昵称。
//
//    以前是 `userId: '阿二'`（会话名 = 昵称），于是「主人是谁」靠昵称比对 ——
//    主人改昵称就认不出，别人起同名就能冒充。现在私信认人只认会话 ID 推出来的
//    对方 uid（`douyin:<对方uid>`）；昵称只作展示（`nickname` / `peerName`）。
//    没有会话身份时返回 null（见下一条断言），不再退回昵称。
const pv = normalizeDouyinMessage({ text: '你好', senderName: '阿三' }, {
	name: '阿二', timeMs: 1, messageId: 'm1', identity: 'douyin:777', convId: '0:1:999:777'
});
assert.deepEqual([pv.chatType, pv.channelId, pv.userId, pv.nickname, pv.convId],
	['private', 'douyin:阿二', 'douyin:777', '阿二', '0:1:999:777'], '私信认人用会话身份，昵称只作展示');
assert.equal(normalizeDouyinMessage({ text: '你好' }, { name: '阿二', timeMs: 1, messageId: 'm1' }), null, '没有会话身份就不猜（不退回昵称）');
ok('群消息按发言的人归一化；认不出的丢掉；私信按会话身份认人');

// DOM 认出的昵称补到接口消息上
const merged = mergeMessages([{ fromMe: false, text: '今天去哪', senderId: '1', seq: 5 }], [{ fromMe: false, type: 'text', text: '今天去哪', senderName: '阿三' }]);
assert.deepEqual([merged.length, merged[0].seq, merged[0].senderId, merged[0].senderName], [1, 5, '1', '阿三']);
ok('接口 + DOM 合并时带上昵称');

// 频道名
assert.deepEqual([platformOf('douyin-group:a:b'), sessionChannelOf('douyin-group:a:b'), splitChannelId('douyin-group:a:b')], ['douyin', 'douyin-group', ['douyin-group', 'a:b']]);
assert.deepEqual([isGroupChannelId('douyin-group:x'), isGroupChannelId('group:1'), isGroupChannelId('douyin:x')], [true, true, false]);
assert.deepEqual([groupOwnerOf('group:1'), groupOwnerOf('douyin-group:x')], ['group:1', 'group:douyin-group:x']);
ok('频道名：douyin-group:<群名> 归抖音平台、按群处理');
console.log('douyin-group ok');
