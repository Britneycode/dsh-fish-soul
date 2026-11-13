import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DouyinInbox } from '../lib/douyin-inbox.js';
import { DouyinChannel, messageFingerprint } from '../lib/channels/douyin.js';
import { ChatGateway, SOURCE_DOUYIN } from '../lib/gateway.js';
import { openDatabase, getKv } from '../lib/db.js';

const home=mkdtempSync(join(tmpdir(),'fish-inbox-')); process.env.DSH_HOME=home;
const db=openDatabase();
// 会话身份：这些测试关心的是「入库与游标」，与身份无关，但 read() 现在必须给
// convId + 发送者属于该会话，否则通道会按「身份未确认」拒绝处理（见 douyin.js）。
const SELF='999', PEER='123', CONV=`0:1:${SELF}:${PEER}`;
const msg=(seq,text='hello')=>({fromMe:false,seq,text,time:Date.now(),senderId:PEER,convId:CONV});
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
 const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),selfSecUid:SELF,driver:{read:async()=>({ok:true,messages:[a,b],convId:CONV})},onMessage:async()=>{calls++;if(calls===1)throw Error('failed');return {queued:true};}});
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
 const a=msg('', 'same'),b={...a};const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),selfSecUid:SELF,driver:{read:async()=>({ok:true,messages:[a,b],convId:CONV})},onMessage:async()=>({done:true})});
 await ch.readConversation({c:{time:''},name:'repeat',key:'conv-repeat',st:null,sig:'1',unread:true});
 const rows=db.prepare("SELECT message_id,status FROM douyin_inbox WHERE channel_id='douyin:repeat' ORDER BY id").all();assert.equal(rows.length,2);assert.notEqual(rows[0].message_id,rows[1].message_id);assert.ok(rows.every(x=>x.status==='done'));
});

test('首次读取过滤系统消息后，消息指纹仍对应原始索引', async () => {
 const a=msg('', 'first'), system={...msg('', 'notice'),system:true},b=msg('', 'second');
 const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),selfSecUid:SELF,driver:{read:async()=>({ok:true,messages:[a,system,b],convId:CONV})},onMessage:async()=>({done:true})});
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

test('读取失败或入库事务失败时保留缺口或读取意图，不推进游标', async () => {
 const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),selfSecUid:SELF,driver:{read:async()=>({ok:false,error:'failed'})},onMessage:async()=>({done:true})});
 await ch.readConversation({c:{time:''},name:'failed-read',key:'failed-read-key',st:null,sig:'1',unread:true});
 assert.equal(getKv(db,'failed-read-key',null),null);
 assert.equal(db.prepare("SELECT count(*) n FROM douyin_inbox_read_intent WHERE cursor_key='failed-read-key'").get().n,0);
 assert.ok(ch.inbox.status().gaps.some(x=>x.channelId==='douyin:failed-read'));
 db.exec("CREATE TRIGGER abort_read_insert BEFORE INSERT ON douyin_inbox WHEN NEW.channel_id='douyin:db-failed' BEGIN SELECT RAISE(ABORT,'fail'); END;");
 ch.driver.read=async()=>({ok:true,messages:[msg('9001')],convId:CONV});
 await assert.rejects(ch.readConversation({c:{time:''},name:'db-failed',key:'db-failed-key',st:null,sig:'1',unread:true}));
 db.exec('DROP TRIGGER abort_read_insert');
 assert.equal(getKv(db,'db-failed-key',null),null);
 assert.equal(db.prepare("SELECT count(*) n FROM douyin_inbox_read_intent WHERE cursor_key='db-failed-key'").get().n,1);
 const recovered=new DouyinInbox(db);
 assert.ok(recovered.status().gaps.some(x=>x.channelId==='douyin:db-failed'));
 assert.equal(db.prepare("SELECT count(*) n FROM douyin_inbox_read_intent WHERE cursor_key='db-failed-key'").get().n,0);
});

test('进程在读取中被强杀后，重启能看到可能遗漏警告', async () => {
 const dir=mkdtempSync(join(tmpdir(),'fish-crash-read-'));
 const script=`import {openDatabase} from './lib/db.js'; import {DouyinChannel} from './lib/channels/douyin.js';
 const db=openDatabase(); const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),selfSecUid:'${SELF}',driver:{read:async()=>{process.stdout.write('reading\\n');return new Promise(()=>{});}},onMessage:async()=>({done:true})});
 void ch.readConversation({c:{},name:'crashed',key:'crash-key',st:null,sig:'1',unread:true}); setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,DSH_HOME:dir},stdio:['ignore','pipe','pipe']});
 try {
  const [out]=await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>{ const timer=setTimeout(()=>reject(Error('child did not reach read')),5000); timer.unref(); })]);
  assert.match(String(out),/reading/); child.kill('SIGKILL'); await once(child,'exit');
  const prev=process.env.DSH_HOME;process.env.DSH_HOME=dir; const reopened=openDatabase();process.env.DSH_HOME=prev;
  const box=new DouyinInbox(reopened);const gaps=box.status().gaps;
  assert.ok(gaps.some(x=>x.channelId==='douyin:crashed' && /中断/.test(x.reason)));
  assert.equal(getKv(reopened,'crash-key',null),null);
  const gap=gaps.find(x=>x.channelId==='douyin:crashed');assert.equal(box.acknowledgeGap(gap.id),true);
  assert.equal(new DouyinInbox(reopened).status().gaps.some(x=>x.channelId==='douyin:crashed'),false);
  reopened.close();
 } finally { if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true}); }
});

test('首次未读超过补收上限时明确提示可能遗漏', async () => {
 const ch=new DouyinChannel({db,host:{},getConfig:()=>({}),selfSecUid:SELF,driver:{read:async()=>({ok:true,messages:[msg('991'),msg('992'),msg('993'),msg('994')]})},onMessage:async()=>({done:true})});
 await ch.readConversation({c:{time:'',unread:4},name:'truncated',key:'truncated-key',st:null,sig:'1',unread:true});
 assert.ok(ch.inbox.status().gaps.some(x=>x.channelId==='douyin:truncated'));
 const short=new DouyinChannel({db,host:{},getConfig:()=>({}),driver:{read:async()=>({ok:true,messages:[]})},onMessage:async()=>({done:true})});
 await short.readConversation({c:{time:'',unread:1},name:'unread-empty',key:'unread-empty-key',st:null,sig:'1',unread:true});
 assert.ok(short.inbox.status().gaps.some(x=>x.channelId==='douyin:unread-empty'));
});

test('一条待核实只挡住它之后 30 秒内的同会话消息；「全部忽略」这个出口还在', () => {
 const box = new DouyinInbox(db);
 const ch = 'douyin:blocked';
 box.record('blocked-cursor', {}, [
  { ...norm('b1'), channelId: ch }, { ...norm('b2'), channelId: ch }, { ...norm('b3'), channelId: ch }
 ]);
 const first = box.next(); box.start(first.id); box.settle([first.id], false);
 // 刚变待核实时，后面紧跟着的两条先按住（给核实留时间）
 assert.equal(box.next(), null, '刚变待核实时后面紧跟着的先按住');
 assert.equal(box.blockedBehind(first.id), 2, '要看得出后面还压着几条');
 // 面板已经不给核实入口了（v0.15.53 删了那块 UI），不能靠人点「全部忽略」才走得动：
 // 30 秒的窗口一过，队列自己就往前走。
 db.prepare('UPDATE douyin_inbox SET updated_at=? WHERE id=?').run(Date.now() - 60_000, first.id);
 const resumed = box.next();
 assert.ok(resumed, '超过 30 秒后同会话后面的消息要能继续走');
 assert.equal(JSON.parse(resumed.payload).messageId, 'b2', '放行的是同会话后面那条');
 // 「全部忽略」这个出口仍然在（一次清掉所有待核实）
 assert.ok(box.dismissAllUnknown() >= 1, '一次把所有 unknown 标成已忽略');
 assert.equal(box.status().unknownTotal, 0, '清完之后一条 unknown 都不剩');
});

test('收件表有保留期：只清已了结的，待处理和待核实的不能删', () => {
 const box = new DouyinInbox(db);
 const ch = 'douyin:prune';
 box.record('prune-cursor', {}, [
  { ...norm('p-done'), channelId: ch }, { ...norm('p-dismiss'), channelId: ch },
  { ...norm('p-unknown'), channelId: ch }, { ...norm('p-pending'), channelId: ch }
 ]);
 const ids = db.prepare("SELECT id, message_id FROM douyin_inbox WHERE channel_id=? ORDER BY id").all(ch);
 const byMsg = Object.fromEntries(ids.map((r) => [r.message_id, r.id]));
 box.start(byMsg['p-done']); box.settle([byMsg['p-done']], true);
 box.start(byMsg['p-dismiss']); box.settle([byMsg['p-dismiss']], false);
 box.resolve(byMsg['p-dismiss'], 'dismiss');
 box.start(byMsg['p-unknown']); box.settle([byMsg['p-unknown']], false);
 // 把已了结的两条改成很旧
 db.prepare("UPDATE douyin_inbox SET updated_at=1 WHERE id IN (?,?)").run(byMsg['p-done'], byMsg['p-dismiss']);
 box.prune();
 const left = db.prepare('SELECT message_id FROM douyin_inbox WHERE channel_id=? ORDER BY id').all(ch).map((r) => r.message_id);
 assert.deepEqual(left, ['p-unknown', 'p-pending'], '只清 done / dismissed');
});

test.after(()=>{db.close();rmSync(home,{recursive:true,force:true});});
