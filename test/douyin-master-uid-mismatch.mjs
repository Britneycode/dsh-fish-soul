/**
 * 「主人身份」填了跟真实 uid 对不上的值（账号短号）时，必须在状态里报出来。
 *
 * 真机踩过（2026-11-14）：设置页 `masterUid` 填了账号短号（`37638767132`），
 * 而真实 uid 是 `2874562949425280`（19 位，从会话 ID 推出来）。
 * 两者都是纯数字，用户分不出来，界面又写「填数字就行」——
 * 之后认领分支比对不上、静默什么都不发生：昵称候选永远不弹，用户看到「她不理我」。
 *
 * 静默失效是最坏的失败，所以状态里要给出 `masterUidMismatch`。
 */
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('douyin-master-uid-mismatch-');
const { openDatabase, setKv } = await import('../lib/db.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');

const db = openDatabase();
const ok = (m) => console.log('✓', m);

/** 造一个最小通道（不启动轮询、不连浏览器）。 */
function channel(masterUid) {
	return new DouyinChannel({
		db, host: {}, driver: {}, onMessage: async () => ({ done: true }),
		getConfig: () => ({ enabled: false, masterUid }),
	});
}

/** 往游标里塞一个已学到的会话身份（真实 uid）。 */
function seedConversation(identity) {
	setKv(db, `douyin.conv.${identity.slice('douyin:'.length).padStart(16, '0')}`, {
		name: '某人', convId: `0:1:${identity.slice('douyin:'.length)}:900001`, identity, readAt: Date.now(),
	});
}

// ① 填短号 + 已学到真实 uid ⇒ 报出来
{
	// ⚠️ 每节独立：这个文件的 db 共用，不清会串（前一节塞的游标会让后一节读到）。
	db.exec("DELETE FROM kv WHERE key LIKE 'douyin.conv.%'");
	const ch = channel('douyin:37638767132');
	seedConversation('douyin:2874562949425280');
	const m = ch.masterUidMismatch();
	assert.ok(m !== null, '短号跟真实 uid 对不上 ⇒ 必须报出来（不然就是静默失效）');
	assert.equal(m.filled, 'douyin:37638767132');
	assert.deepEqual(m.learned, ['2874562949425280']);
	ok('短号对不上真实 uid → 报出 filled / learned');
}

// ② 填对了 ⇒ 不警告
{
	// ⚠️ 每节独立：这个文件的 db 共用，不清会串（前一节塞的游标会让后一节读到）。
	db.exec("DELETE FROM kv WHERE key LIKE 'douyin.conv.%'");
	const ch = channel('douyin:2874562949425280');
	seedConversation('douyin:2874562949425280');
	assert.equal(ch.masterUidMismatch(), null, '填对了不该警告');
	ok('填对真实 uid → 不警告');
}

// ③ 留空 ⇒ 不警告（留空是推荐的）
{
	// ⚠️ 每节独立：这个文件的 db 共用，不清会串（前一节塞的游标会让后一节读到）。
	db.exec("DELETE FROM kv WHERE key LIKE 'douyin.conv.%'");
	const ch = channel('');
	seedConversation('douyin:2874562949425280');
	assert.equal(ch.masterUidMismatch(), null, '留空 = 不认主人，不该算错');
	ok('留空 → 不警告');
}

// ④ 一条都没学到 ⇒ 不警告（那时不能证明填错了）
{
	// ⚠️ 每节独立：这个文件的 db 共用，不清会串（前一节塞的游标会让后一节读到）。
	db.exec("DELETE FROM kv WHERE key LIKE 'douyin.conv.%'");
	const ch = channel('douyin:37638767132');
	assert.equal(ch.masterUidMismatch(), null, '没学到任何会话身份时不能判它错');
	ok('还没学到身份 → 不警告');
}

// ⑤ 填的不是纯数字 ⇒ 不警告（交给其他校验管）
{
	// ⚠️ 每节独立：这个文件的 db 共用，不清会串（前一节塞的游标会让后一节读到）。
	db.exec("DELETE FROM kv WHERE key LIKE 'douyin.conv.%'");
	const ch = channel('douyin:abc');
	seedConversation('douyin:2874562949425280');
	assert.equal(ch.masterUidMismatch(), null);
	ok('非数字 → 不在这里警告');
}

// ⑥ 学到的 identity 是脏的（昵称 / 老格式）⇒ 不当真实 uid 用
//    ⚠️ 必须清掉前面几节塞的游标 —— 这个文件的 db 是共用的，
//       残留的真 uid 会让「脏 identity 不算数」这条测不出来。
{
	db.exec("DELETE FROM kv WHERE key LIKE 'douyin.conv.%'");
	const ch = channel('douyin:37638767132');
	setKv(db, 'douyin.conv.dirty0000000000', { name: '脏的', identity: 'Re.', readAt: Date.now() });
	assert.equal(ch.masterUidMismatch(), null, 'identity 不是 douyin:<数字uid> 的行不能拿来当证据');
	ok('脏 identity → 不算已学到的身份');
}

console.log('douyin-master-uid-mismatch ok');
