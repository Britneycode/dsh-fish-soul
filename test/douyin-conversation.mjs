// 抖音会话身份：把会话 ID 当成一等公民。纯函数，不碰浏览器 / 数据库。
import assert from 'node:assert/strict';
import {
	parseSingleConversation, isSingleConversation, peerUidFromConversation,
	soleConversationId, soleSingleConversationId, conversationIdentity, isPeerMessage, senderBelongsToConversation
} from '../lib/douyin-conversation.js';

const ME = '7000000000000000001';
const PEER = '1234567890123456789';

// ── 会话 ID 解析 ──
assert.deepEqual(parseSingleConversation(`0:1:${ME}:${PEER}`), { a: ME, b: PEER });
assert.deepEqual(parseSingleConversation(`0:1:${PEER}:${ME}`), { a: PEER, b: ME }, '两侧顺序不固定');
assert.equal(parseSingleConversation('0:2:7300'), null, '群聊不是单聊形状');
assert.equal(parseSingleConversation(''), null);
assert.equal(parseSingleConversation(null), null);
assert.equal(parseSingleConversation('0:1:abc:def'), null, 'uid 必须是数字');
assert.deepEqual(parseSingleConversation(` 0:1:${ME}:${PEER} `), parseSingleConversation(`0:1:${ME}:${PEER}`), '容忍首尾空格');
assert.equal(isSingleConversation(`0:1:${ME}:${PEER}`), true);
assert.equal(isSingleConversation('0:2:7300'), false);

// 超出 Number.MAX_SAFE_INTEGER 的 uid 不能掉精度
const BIG = '7702399256389125123';
assert.deepEqual(parseSingleConversation(`0:1:${BIG}:${PEER}`), { a: BIG, b: PEER });

// ── 推出对方 uid ──
assert.equal(peerUidFromConversation(`0:1:${ME}:${PEER}`, [ME]), PEER);
assert.equal(peerUidFromConversation(`0:1:${PEER}:${ME}`, [ME]), PEER, '反过来也对');
assert.equal(peerUidFromConversation(`0:1:${ME}:${PEER}`, ['MS4wLjABAAAAxxx', ME]), PEER, '多候选里命中一个就够');
assert.equal(peerUidFromConversation(`0:1:${ME}:${PEER}`, ['someone-else']), '', '都不命中就不猜');
assert.equal(peerUidFromConversation(`0:1:${ME}:${PEER}`, []), '', '没有自己的 id 就不猜');
assert.equal(peerUidFromConversation(`0:1:${ME}:${PEER}`, [ME, PEER]), '', '两侧都命中 = 有歧义，不猜');
assert.equal(peerUidFromConversation('0:2:7300', [ME]), '', '群聊推不出单聊对端');
assert.equal(peerUidFromConversation('', [ME]), '');

// ── 一个响应里只能有一个会话 ──
assert.equal(soleConversationId([{ convId: '0:1:1:2' }, { convId: '0:1:1:2' }]), '0:1:1:2');
assert.equal(soleConversationId([{ convId: '0:1:1:2' }, { convId: '0:1:1:3' }]), '', '混了两个会话 → 不能凑合');
assert.equal(soleConversationId([{ convId: '' }, { convId: '' }]), '', '一个都没有');
assert.equal(soleConversationId([]), '');
assert.equal(soleConversationId([{ convId: '0:1:1:2' }, { convId: '' }]), '0:1:1:2', '空的不算干扰');

// ── 稳定身份键 ──
assert.equal(conversationIdentity(`0:1:${ME}:${PEER}`, [ME]), `douyin:${PEER}`);
assert.equal(conversationIdentity(`0:1:${ME}:${PEER}`, []), '', '推不出对端就没有身份键');
// 昵称变了身份键不变（这条是整个修复的意义）
assert.equal(conversationIdentity(`0:1:${ME}:${PEER}`, [ME]), conversationIdentity(`0:1:${ME}:${PEER}`, [ME]));

// ── 是不是对方发的 ──
assert.equal(isPeerMessage({ convId: `0:1:${ME}:${PEER}`, senderId: PEER }, [ME]), true);
assert.equal(isPeerMessage({ convId: `0:1:${ME}:${PEER}`, senderId: ME }, [ME]), false, '自己发的');
assert.equal(isPeerMessage({ convId: `0:1:${ME}:${PEER}`, senderId: '999' }, [ME]), false, '第三方 uid');
// 没有 convId 才退回 fromMe；拿不到就是未知
assert.equal(isPeerMessage({ fromMe: false }, [ME]), true);
assert.equal(isPeerMessage({ fromMe: true }, [ME]), false);
assert.equal(isPeerMessage({ fromMe: null }, [ME]), null, '未知');
assert.equal(isPeerMessage({}, [ME]), null);

// ── 证据自洽：发送者必须是会话两侧之一 ──
assert.equal(senderBelongsToConversation({ convId: `0:1:${ME}:${PEER}`, senderId: PEER }, [ME]), true);
assert.equal(senderBelongsToConversation({ convId: `0:1:${ME}:${PEER}`, senderId: ME }, [ME]), true);
assert.equal(senderBelongsToConversation({ convId: `0:1:${ME}:${PEER}`, senderId: '999' }, [ME]), false, '第三方 = 串会话');
assert.equal(senderBelongsToConversation({ convId: '', senderId: PEER }, [ME]), false, '没有会话 ID 就不算自洽');
assert.equal(senderBelongsToConversation({ convId: `0:1:${ME}:${PEER}`, senderId: '' }, [ME]), false, '没有发送者');

console.log('✓ 抖音会话身份：会话 ID 解析 / 推对端 / 唯一性 / 稳定键 / 发送者自洽');


// #169：兜底「唯一单聊」必须把群挡在外面 —— 否则读群会话被误判成主人私聊
// （面板里只抓到主人的单聊时，读群/陌生人的会话会被 resolveConvId 兜底成主人那条 convId）
{
	const single = { convId: '0:1:111:222', convType: 1 };
	const group = { convId: '700:123:456', convType: 2 };
	assert.equal(soleSingleConversationId([single]).id, '0:1:111:222', '只有单聊：给唯一 id');
	assert.equal(soleSingleConversationId([single, group]).id, '', '群混入时不能给兜底 id');
	assert.equal(soleSingleConversationId([group]).id, '', '只有群时不能给兜底 id');
	assert.ok(soleSingleConversationId([group]).groupLike, '群要被标出来');
	assert.equal(soleSingleConversationId([{ convId: '0:1:111:222' }, { convId: '0:1:111:333' }]).id, '', '两个单聊不猜');
	assert.equal(soleSingleConversationId([{ convId: '0:2:999:888:777' }]).id, '', '0:2: 群形状不给兜底');
	// 🔴 真机形状：群消息的 convId 接口不一定回填（解出来是空），只有 convType=2。
	//    先判群再判空，否则这种群会被 `id==='' continue` 漏掉，groupLike 置不上，
	//    和单聊混在一起时兜底会错配到那个单聊（= 主人 convId）。
	const groupNoId = { convId: '', convType: 2 };
	assert.equal(soleSingleConversationId([groupNoId]).id, '', '只有「空 convId 的群」不给兜底');
	assert.ok(soleSingleConversationId([groupNoId]).groupLike, '空 convId 的群也要被标成群');
	assert.equal(soleSingleConversationId([single, groupNoId]).id, '', '单聊 + 空 convId 的群混在一起：不能把单聊当唯一证据');
	console.log('✓ #169 兜底「唯一单聊」把群挡在外面');
}
