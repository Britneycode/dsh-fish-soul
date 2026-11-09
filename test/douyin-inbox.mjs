import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DouyinInbox } from '../lib/douyin-inbox.js';
import { DouyinChannel, messageFingerprint } from '../lib/channels/douyin.js';
import { ChatGateway, SOURCE_DOUYIN } from '../lib/gateway.js';
import { openDatabase, getKv } from '../lib/db.js';

const home=mkdtempSync(join(tmpdir(),'fish-inbox-')); process.env.DSH_HOME=home;
const db=openDatabase();
const msg=(seq,text='hello')=>({fromMe:false,seq,text,time:Date.now(),senderId:'123'});
const row=(id)=>db.prepare('SELECT * FROM douyin_inbox WHERE id=?').get(id);
const norm=(id)=>({channelId:'douyin:x',messageId:id,text:id,timeMs:Date.now()});

test('消息与游标原子落盘，写入中断时不前移游标', () => {
 const box=new DouyinInbox(db);
 db.exec("CREATE TRIGGER test_abort BEFORE INSERT ON douyin_inbox WHEN NEW.message_id='bad' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
 assert.throws(()=>box.record('cursor-test',{sig:'new'},[norm('good'),norm('bad')]));
 assert.equal(getKv(db,'cursor-test',null),null);assert.equal(db.prepare("SELECT count(*) n FROM douyin_inbox WHERE channel_id='douyin:x'").get().n,0);
 db.exec('DROP TRIGGER test_abort');box.record('cursor-test',{sig:'ok'},[norm('good'),norm('good')]);
 assert.equal(getKv(db,'cursor-test',null).sig,'ok');assert.equal(db.prepare("SELECT count(*) n FROM douyin_inbox WHERE channel_id='douyin:x'").get().n,1);
});

test('提交前中断自动恢复；处理中断标为未知，必须人工决定', () => {
 let box=new DouyinInbox(db);let item=box.next();assert.equal(JSON.parse(item.payload).messageId,'good');
 box=new DouyinInbox(db);assert.equal(box.next().id,item.id);assert.equal(box.start(item.id),true);
 box=new DouyinInbox(db);assert.equal(row(item.id).status,'unknown');assert.equal(box.next(),null);
 assert.equal(box.resolve(item.id,'retry'),true);assert.equal(box.resolve(item.id,'retry'),false);assert.equal(box.start(item.id),true);
 box.settle([item.id],true);assert.equal(row(item.id).status,'done');assert.equal(box.resolve(item.id,'retry'),false);
});

test('通道把新消息存盘后才交给网关，失败不自动重试', async () => {
 const a=msg('100','same'),b=msg('101','same');let calls=0;
 const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),driver:{read:async()=>({ok:true,messages:[a,b]})},onMessage:async()=>{calls++;if(calls===1)throw Error('failed');return {queued:true};}});
 await ch.readConversation({c:{time:''},name:'test',key:'conv-test',st:{window:['not-overlap']},sig:'new',unread:true});
 const rows=db.prepare("SELECT id,status,message_id FROM douyin_inbox WHERE channel_id='douyin:test' ORDER BY id").all();
 assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.status),['unknown','pending']);assert.deepEqual(rows.map(r=>r.message_id),['s100','s101']);assert.equal(getKv(db,'conv-test').sig,'new');assert.equal(ch.inbox.status().gaps.some(g=>g.channelId==='douyin:test'),true);
 await ch.drainInbox();assert.equal(calls,1);assert.equal(ch.inbox.resolve(rows[0].id,'dismiss'),true);assert.equal(row(rows[0].id).status,'dismissed');await ch.drainInbox();assert.equal(calls,2);assert.equal(row(rows[1].id).status,'processing');
});

test('同一会话的未知结果阻止后续待处理消息，其他会话不被卡住', () => {
 const box=new DouyinInbox(db);
 const x={...norm('order-x'),channelId:'douyin:order'},y={...norm('order-y'),channelId:'douyin:order'},z={...norm('order-z'),channelId:'douyin:other'};
 box.record('order-cursor',{},[x,y,z]); const first=box.next();box.start(first.id);box.settle([first.id],false);
 const next=box.next();assert.equal(JSON.parse(next.payload).messageId,'order-z');box.start(next.id);box.settle([next.id],true);
 assert.equal(box.next(),null);assert.equal(box.resolve(first.id,'dismiss'),true);assert.equal(JSON.parse(box.next().payload).messageId,'order-y');
 const last=box.next();box.start(last.id);box.settle([last.id],true);
});

test('重复消息相同指纹且无 seq 时仍分别入库', async () => {
 const a=msg('', 'same'),b={...a};const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),driver:{read:async()=>({ok:true,messages:[a,b]})},onMessage:async()=>({done:true})});
 await ch.readConversation({c:{time:''},name:'repeat',key:'conv-repeat',st:null,sig:'1',unread:true});
 const rows=db.prepare("SELECT message_id,status FROM douyin_inbox WHERE channel_id='douyin:repeat' ORDER BY id").all();assert.equal(rows.length,2);assert.notEqual(rows[0].message_id,rows[1].message_id);assert.ok(rows.every(x=>x.status==='done'));
});

test('首次读取过滤系统消息后，消息指纹仍对应原始索引', async () => {
 const a=msg('', 'first'), system={...msg('', 'notice'),system:true},b=msg('', 'second');
 const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),driver:{read:async()=>({ok:true,messages:[a,system,b]})},onMessage:async()=>({done:true})});
 await ch.readConversation({c:{time:'',unread:3},name:'filtered',key:'conv-filtered',st:null,sig:'1',unread:true});
 const rows=db.prepare("SELECT message_id FROM douyin_inbox WHERE channel_id='douyin:filtered' ORDER BY id").all();
 assert.equal(rows.length,2);assert.ok(rows[0].message_id.startsWith(messageFingerprint(a)));assert.ok(rows[1].message_id.startsWith(messageFingerprint(b)));
});

test('网关收到回合完成信号后才确认，失败/投递不确定需核实', async () => {
 const box=new DouyinInbox(db);box.record('event-cursor',{},[norm('event-a'),norm('event-b')]);const a=box.next();box.start(a.id);const b=box.next();box.start(b.id);
 const gw=Object.assign(Object.create(ChatGateway.prototype),{bound:new Map([['s',{}]]),turns:new Map(),waiters:new Map(),interjectTurns:new Set(),douyin:{inbox:box},note:()=>{},log:()=>{},sendReply:async()=>true});
 const emit=(id,reason)=>{gw.onSessionEvent({id:'s'},{type:'user/message',data:{message:{id:'msg',source:{kind:SOURCE_DOUYIN,channelId:'douyin:x',inboxIds:[id]}}}});gw.onSessionEvent({id:'s'},{type:'turn/end',data:{reason:{kind:reason}}});};
 emit(a.id,'completed');await new Promise(r=>setImmediate(r));assert.equal(row(a.id).status,'done');
 emit(b.id,'failed');assert.equal(row(b.id).status,'unknown');
});

test.after(()=>{db.close();rmSync(home,{recursive:true,force:true});});
