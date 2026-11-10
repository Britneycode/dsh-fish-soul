import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

// 抖音「主动私信 / 跨平台转达」找不到目标会话时，提示必须分得清原因。
//
// 真机踩到的坑：`masterUid` 空的时候，`masterDouyinConvId()` 在查 kv **之前**就
// return 空串 —— 于是「抖音里明明聊过、kv 里明明记着会话」的人永远卡在
// 「先在抖音里给我发一条消息」这句话上，他发一百条也没用。
// 真正该说的是「去设置页填主人身份」。
//
// 这里钉住三件事：
//   ① masterUid 空时退回 person.master 已经学到的 douyin_uid（平台数据比手填可信）
//   ② 两种失败原因给两句不同的话
//   ③ 都齐了才放行

process.env.DSH_HOME = tmpHome('douyin-master-uid-');
const { openDatabase } = await import('../lib/db.js');
const { getKv, setKv } = await import('../lib/db.js');
const { mediaMethods } = await import('../lib/gateway-media.js');

const db = openDatabase();
const MASTER_UID = 'douyin:7702399256389125000';
const CONV = '0:1:900001:7702399256389125000';

// 只测这几个方法，不启动整个网关：mediaMethods 是混进 ChatGateway.prototype 的对象
const proto = mediaMethods;
// 真实方法挂在 mediaMethods 上，用 Object.assign 造一个带这些方法的 this
const makeGw = (cfg) => Object.assign(Object.create(proto), {
  db,
  douyinConfig: () => ({ enabled: true, masterUid: cfg.masterUid ?? '', masterName: '未云' }),
});

/** 建一个 master 行，douyin_uid 记成给定值（空串 = 没有） */
function setMasterRow(douyinUid) {
  db.prepare("DELETE FROM person WHERE canonical_id = 'master'").run();
  db.prepare(
    "INSERT INTO person (canonical_id, qq_uin, douyin_uid, display_name, aliases, relation_stage, interaction_count, first_seen_at, last_seen_at) VALUES ('master', '3630958828', ?, '未云', '[]', 'close', 1, ?, ?)"
  ).run(douyinUid, Date.now(), Date.now());
}

// ── 1. masterUid 没填，但 person.master 学得到 → 要认出来 ──────────────────
setMasterRow(MASTER_UID);
setKv(db, `douyin.convId.${MASTER_UID}`, CONV);
{
  const gw = makeGw({ masterUid: '' });
  assert.equal(proto.masterDouyinIdentity.call(gw), MASTER_UID, 'masterUid 空时要退回 person.master 学到的身份');
  const conv = await proto.masterDouyinConvId.call(gw);
  assert.equal(conv, CONV, '认出身份后要能查到会话 ID');
  const why = await proto.masterDouyinSendBlocker.call(gw);
  assert.equal(why, '', '都齐了不该有阻塞原因');
}

// ── 2. 两处都没有 → 提示「去设置页填」，不能说「先去发消息」────────────────
setMasterRow('');
{
  const gw = makeGw({ masterUid: '' });
  assert.equal(proto.masterDouyinIdentity.call(gw), '', '都学不到就是空');
  const why = await proto.masterDouyinSendBlocker.call(gw);
  assert.match(why, /设置页/, '要指向设置页');
  assert.match(why, /douyin:</, '要给出该填的格式');
  // 🔴 关键：这句不能说「先去发消息」—— 他不知道自己是哪个号，发多少条都学不到
  assert.doesNotMatch(why, /发一条消息/, '不知道身份时让他发消息是错的提示');
}

// ── 3. 有身份但 kv 里没会话 → 这时才该说「先去发一条」──────────────────────
setMasterRow(MASTER_UID);
db.prepare('DELETE FROM kv WHERE key = ?').run(`douyin.convId.${MASTER_UID}`);
{
  const gw = makeGw({ masterUid: '' });
  assert.equal(proto.masterDouyinIdentity.call(gw), MASTER_UID);
  assert.equal(await proto.masterDouyinConvId.call(gw), '', '没聊过就没有会话 ID');
  const why = await proto.masterDouyinSendBlocker.call(gw);
  assert.match(why, /发一条消息/, '这时说「先去发一条」才是对的');
  assert.doesNotMatch(why, /设置页/, '不该再让他去设置页');
}

// ── 4. 设置页手填的优先（用户明确指定就该听他的）────────────────────────────
setMasterRow('douyin:111111111111111111');
{
  const gw = makeGw({ masterUid: MASTER_UID });
  assert.equal(proto.masterDouyinIdentity.call(gw), MASTER_UID, '手填的优先于学到的');
}

// ── 5. 脏值不能被当成身份（不能因为填了点什么就放行）──────────────────────
for (const bad of ['', '  ', '未云', '7702399256389125000', 'douyin:abc', 'uid:123']) {
  setMasterRow('');
  const gw = makeGw({ masterUid: bad });
  assert.equal(proto.masterDouyinIdentity.call(gw), '', `「${bad}」不是合法身份键`);
}

db.close();
console.log('douyin-master-uid ok');
