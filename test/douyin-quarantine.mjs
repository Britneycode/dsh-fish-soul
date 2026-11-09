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
const gw = new ChatGateway({ctx:{get:()=>undefined},db,clock:{now:()=>Date.now()},getConfig:()=>config,log:()=>{},channel:{connected:true},douyin:{connected:true,send:async()=>{sends++;return {ok:true,delivered:true}}},soul:{}});
test('同名、无 ID 和声称相同 ID 的消息均隔离，不授予主人或共享会话',async()=>{
 for(const userId of ['主人','uid:7702399256389125123','']) {
  const m={userId,peerName:'主人',channelId:'douyin:主人',chatType:'private',text:'秘密'};
  assert.match((await gw.onDouyinMessage(m)).review,/身份/);
  assert.equal(gw.personKeyOf(m),''); assert.equal(gw.isMasterChannel(m.channelId),false); assert.equal(gw.sessionOpenFor(m.channelId),false);
 }
 assert.match((await gw.onDouyinGroupMessage({channelId:'douyin-group:主人',userId:'主人'})).review,/身份/);
 assert.equal(gw.sessionOpenFor('douyin-group:主人'),false);
});
test('所有抖音发送路径拒绝，旧 QQ 共享会话不能泄露抖音回合',async()=>{
 assert.equal((await gw.sendDouyin({channel_id:'douyin:主人'},'秘密')).ok,false);
 assert.equal((await gw.relayTo('douyin','秘密')).ok,false);
 assert.equal(await gw.triggerProactive('douyin:主人','分享',{origin:'browsing'}),false);
 gw.bound.set('old',{channel_id:'private:123'});
 assert.equal(await gw.sendReply('old',{channelId:'douyin:主人',text:'秘密'}),false);
 assert.equal(sends,0);
});
test('真实收件组件接到隔离反馈后，消息可恢复并停止同会话后续处理',async()=>{
 const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),driver:{read:async()=>({ok:true,messages:[{fromMe:false,seq:'1001',text:'a',time:Date.now()},{fromMe:false,seq:'1002',text:'b',time:Date.now()}]})},onMessage:m=>gw.onDouyinMessage(m)});
 await ch.readConversation({c:{time:''},name:'主人',key:'quarantine-cursor',st:null,sig:'1',unread:true});
 assert.deepEqual(db.prepare("SELECT status FROM douyin_inbox WHERE channel_id='douyin:主人' ORDER BY id").all().map(x=>x.status),['unknown','pending']);
 await ch.drainInbox();assert.equal(ch.status().identityBlocked,true);assert.equal(sends,0);
});
test.after(()=>db.close());
