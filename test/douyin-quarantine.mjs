import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
process.env.DSH_HOME = tmpHome('douyin-quarantine-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');
const db = openDatabase();
let sends = 0;
const config = { qq:{enabled:true}, masterQqUin:'123', tools:{sessionAllow:'all'}, douyin:{enabled:true,masterName:'主人',autoReply:true,links:['主人=123']} };
const gw = new ChatGateway({ctx:{get:()=>undefined},db,clock:{now:()=>Date.now()},getConfig:()=>config,log:()=>{},channel:{connected:true},douyin:{connected:true,send:async()=>{sends++;return {ok:true,delivered:true}}},
// soul 是替身：只提供网关会调到的两个方法（真实实现在 lib/index.js）
soul:{memorizeUnanswered:()=>{},recallInfo:()=>({memories:[],at:0,unknown:false})}});
test('昵称 / 裸 uid / 空身份都不算身份：隔离，不授予主人或共享会话',async()=>{
 // 三种「看起来像身份但证明不了会话」的写法：
 //   '主人'      —— 昵称（可被同名冒充、改名就对不上）
 //   'uid:...'   —— 群聊那条老格式，单条 senderId 证明不了属于当前会话
 //   ''          —— 什么都没有
 for(const userId of ['主人','uid:7702399256389125123','']) {
  const m={userId,peerName:'主人',channelId:'douyin:主人',chatType:'private',text:'秘密'};
  assert.match((await gw.onDouyinMessage(m)).review,/身份/);
  assert.equal(gw.personKeyOf(m),''); assert.equal(gw.isMasterChannel(m.channelId),false); assert.equal(gw.sessionOpenFor(m.channelId),false);
 }
 // 群聊同样按 uid 认：'主人' 是昵称，不是身份
 assert.match((await gw.onDouyinGroupMessage({channelId:'douyin-group:主人',userId:'主人'})).review,/身份/);
 assert.equal(gw.sessionOpenFor('douyin-group:主人'),false);
 // 会话身份（douyin:<uid>）才算数 —— 这条用来证明上面那些拒绝不是「一律拒绝」
 assert.equal((await gw.onDouyinMessage({userId:'douyin:7702399256389125123',peerName:'主人',channelId:'douyin:主人',chatType:'private',text:'秘密'})).review,'只记不回',
  '有会话身份但不在白名单 → 只记不回（不是身份问题）');
});
test('所有抖音发送路径拒绝，旧 QQ 共享会话不能泄露抖音回合',async()=>{
 assert.equal((await gw.sendDouyin({channel_id:'douyin:主人'},'秘密')).ok,false);
 assert.equal((await gw.relayTo('douyin','秘密')).ok,false);
 assert.equal(await gw.triggerProactive('douyin:主人','分享',{origin:'browsing'}),false);
 gw.bound.set('old',{channel_id:'private:123'});
 assert.equal(await gw.sendReply('old',{channelId:'douyin:主人',text:'秘密'}),false);
 assert.equal(sends,0);
});
// 🔴 契约变更（2026-11-10）：读不到会话 ID 时**不再入库**。
//
//    以前：消息先入库，再由网关按「昵称不可信」隔离（status 停在 unknown/pending）。
//    现在：通道在 readConversation 阶段就拒绝 —— 没有会话 ID 就没有身份，
//          连入库都不做，只留一条「读取意图 → 缺口提示」让人知道可能漏了消息。
//    两种做法都保证「不会回错人 / 不授予主人权限」，后者更早失败、也不会在库里
//    堆一堆永远处理不了的待核实消息。
test('读不到会话 ID 时整批拒绝：不入库、不发送，只留缺口提示',async()=>{
 const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),driver:{read:async()=>({ok:true,messages:[{fromMe:false,seq:'1001',text:'a',time:Date.now()},{fromMe:false,seq:'1002',text:'b',time:Date.now()}]})},onMessage:m=>gw.onDouyinMessage(m)});
 await ch.readConversation({c:{time:''},name:'主人',key:'quarantine-cursor',st:null,sig:'1',unread:true});
 assert.deepEqual(db.prepare("SELECT status FROM douyin_inbox WHERE channel_id='douyin:主人' ORDER BY id").all().map(x=>x.status),[],'没有会话 ID 就不入库');
 assert.equal(ch.inbox.status().gaps.some(g=>g.channelId==='douyin:主人'),true,'要留缺口提示，别让人以为没消息');
 assert.equal(ch.inbox.status().gaps.find(g=>g.channelId==='douyin:主人').reason.includes('读取'),true);
 await ch.drainInbox();assert.equal(ch.status().identityBlocked,true,'还不知道自己是谁 → 身份仍阻断');assert.equal(sends,0);
});

// 学到自己的 uid 之后，同一条会话就能正常处理（证明修复真的打通了链路）
test('拿到会话 ID 并能推出对端后，消息正常入库并按会话身份认人',async()=>{
 // 用独立的库：learnSelfUid 会把「自己的 uid」写进 kv，和前一条测试共用库会互相污染
 const { tmpHome } = await import('./_tmp.mjs');
 const prevHome = process.env.DSH_HOME;
 process.env.DSH_HOME = tmpHome('douyin-identity-ok-');
 const { openDatabase } = await import('../lib/db.js');
 const own = openDatabase();
 process.env.DSH_HOME = prevHome;
 try {
  const SELF='999',PEER='123',CONV=`0:1:${SELF}:${PEER}`;
  const seen=[];
  const ch=new DouyinChannel({db:own,host:{},getConfig:()=>({}),driver:{read:async()=>({ok:true,convId:CONV,messages:[
   {fromMe:false,seq:'2001',text:'在吗',time:Date.now(),senderId:PEER,convId:CONV},
   {fromMe:false,seq:'2002',text:'问你个事',time:Date.now(),senderId:PEER,convId:CONV}
  ]})},onMessage:async(m)=>{seen.push(m);return {done:true}}});
  await ch.readConversation({c:{time:''},name:'某个昵称',key:'identity-ok-cursor',st:null,sig:'1',unread:true});
  assert.equal(ch.status().identityBlocked,false,'学到自己的 uid 之后身份可用');
  assert.equal(ch.status().identityState.knowsSelfUid,true);
  assert.equal(seen.length,2,'消息交给网关了');
  assert.ok(seen.every(m=>m.userId===`douyin:${PEER}`),'认人用会话身份（对方 uid），不是昵称');
  assert.ok(seen.every(m=>m.convId===CONV),'带着会话 ID，发送前要靠它校验目标');
  assert.equal(seen[0].nickname,'某个昵称','昵称只作展示');
 } finally { own.close(); }
});
test.after(()=>db.close());
