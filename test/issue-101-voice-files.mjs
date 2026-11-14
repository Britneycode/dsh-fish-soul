import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';
const home = tmpHome('fish-voice-101-');
process.env.DSH_HOME = home;
const { saveVoiceFile, voiceDir, voiceFileList, voiceIncomingCount, clearVoiceFiles, isAllowedVoiceInput, audioExt } = await import('../lib/voice-files.js');
const { ChatGateway } = await import('../lib/gateway.js');
const { voiceConfig, VoiceService, UNHEARD } = await import('../lib/voice.js');
const wav = Buffer.concat([Buffer.from('RIFF1234WAVE'), Buffer.alloc(16)]);
assert.equal(voiceConfig({}).saveIncoming, false); assert.equal(voiceConfig({}).desktopTts, false);
assert.equal(audioExt(wav), 'wav'); assert.equal(audioExt(Buffer.from('something')), 'bin');
let latest;
for (let i = 0; i < 35; i++) latest = saveVoiceFile('in', wav);
assert.equal(voiceFileList('in').length, 30); assert.deepEqual(readFileSync(latest), wav);
assert.equal(isAllowedVoiceInput({ input: latest }, [latest]), true);
assert.equal(isAllowedVoiceInput({ input: latest, srt: '/tmp/no' }, [latest]), false);
assert.equal(isAllowedVoiceInput({ input: latest, lyrics: '/etc/passwd' }, [latest]), false);
assert.equal(isAllowedVoiceInput({ input: '/etc/passwd' }, [latest]), false);
assert.equal(isAllowedVoiceInput({ input: latest }, []), false);
const other = join(voiceDir('in'), 'unmanaged.txt'); writeFileSync(other, 'untouched');
if (process.platform !== 'win32') { const link = join(voiceDir('in'), 'voice-1234567890123-00000000-0000-0000-0000-000000000000.wav'); symlinkSync('/etc/passwd', link); assert.equal(isAllowedVoiceInput({input: link}, [link]), false); }
assert.equal(clearVoiceFiles('in'), 30); assert.equal(readFileSync(other, 'utf8'), 'untouched');
assert.equal(isAllowedVoiceInput({input:latest}, [latest]), false);
const pair = saveVoiceFile('in', Buffer.from('\x02#!SILK_V3'), {analysisBytes:Buffer.from('ID3converted')});
assert.match(pair, /-analysis\.mp3$/); assert.equal(voiceIncomingCount(),1); assert.equal(voiceFileList('in').length,2);
assert.equal(isAllowedVoiceInput({input:pair},[pair]),true); assert.equal(clearVoiceFiles('in'),1); assert.equal(voiceFileList('in').length,0);
for(let i=0;i<31;i++) saveVoiceFile('in',Buffer.from('\x02#!SILK_V3'),{analysisBytes:Buffer.from('ID3converted')});
assert.equal(voiceIncomingCount(),30); assert.equal(voiceFileList('in').length,60); assert.equal(clearVoiceFiles('in'),30);


const source = Buffer.from('ID3original'); const converted = Buffer.from('ID3converted');
const svc = new VoiceService({db: {}, getConfig: () => ({})});
assert.deepEqual(await svc.fetchQqRecord({call: async () => ({base64:converted.toString('base64')})}, {file:'x',base64:source.toString('base64')}, {preferOriginal:true,withSource:true}), {bytes:source,converted:false});
assert.deepEqual(await svc.fetchQqRecord({call: async () => ({base64:converted.toString('base64')})}, {file:'x'}, {preferOriginal:true,withSource:true}), {bytes:converted,converted:true});
assert.deepEqual(await svc.fetchQqRecord({call: async () => ({base64:converted.toString('base64')})}, {file:'x',base64:source.toString('base64')}), converted);
let savedCalls = 0; const cfg = { enabled:true, saveIncoming:true };
const gw = Object.assign(Object.create(ChatGateway.prototype), { getConfig:()=>({voice:cfg}), channel:{}, log(){}, voice:{ readyFor:()=>false, fetchQqRecord:async()=>{savedCalls++;return {bytes:wav,converted:false};} } });
const rec = {records:[{file:'x'}],text:UNHEARD};
await gw.hearVoice(rec); assert.equal(savedCalls,0, '没有明确授权不保存');
await gw.hearVoice(rec,{saveAllowed:true}); assert.equal(savedCalls,1); assert.equal(rec.voicePaths.length,1); assert.equal(rec.text,UNHEARD, 'STT 不可用也保存，原占位不变');
let finish; gw.voice.fetchQqRecord=()=>new Promise(resolve=>{finish=resolve});
const pending = gw.hearVoice({records:[{}],text:UNHEARD},{saveAllowed:true}); clearVoiceFiles('in'); finish({bytes:wav,converted:false}); await pending; assert.equal(voiceFileList('in').length,0,'清理后在途下载不能重新保存');
gw.voice.fetchQqRecord=async()=>{savedCalls++;return {bytes:wav,converted:false};};
cfg.saveIncoming=false; await gw.hearVoice({records:[{}], text:UNHEARD},{saveAllowed:true}); assert.equal(savedCalls,1);
// 实际保存路径：SILK 原件保留，同时把转码结果作为分析输入。
cfg.saveIncoming=true; let fetchCount=0;
gw.voice.fetchQqRecord=async(_ch,_rec,opts)=>{fetchCount++;return opts.preferOriginal ? {bytes:Buffer.from('\x02#!SILK_V3'),converted:false} : {bytes:Buffer.from('ID3converted'),converted:true}};
const silkMsg={records:[{file:'voice'}],text:UNHEARD}; await gw.hearVoice(silkMsg,{saveAllowed:true});
assert.equal(fetchCount,2); assert.match(silkMsg.voicePaths[0],/-analysis\.mp3$/); assert.equal(voiceIncomingCount(),1); assert.equal(voiceFileList('in').length,2); clearVoiceFiles('in');
// 保存授权仅在既有回复判定之后计算：好友私聊或显式白名单群，身份必须已知。
const results=[];
const fake = Object.assign(Object.create(ChatGateway.prototype), {
 masterQq:()=>'', isPaused:()=>false, channel:{isFriend:(id)=>id==='1'}, callNames:()=>[],
 recentSent:new Map(), follow:new Map(), interjects:new Map(),
 soul:{memorizeUnanswered(){}}, note(){}, reactTo:async()=>{}, enqueue(){},
 hearVoice:async(_m, opt)=>results.push(opt.saveAllowed),
});
const qcfg={replyWindowMinutes:10,followUpCount:0,followUpSeconds:0,mentionOnly:true,groupAllowList:['55'],allFriends:true};
const msg=(patch)=>({timeMs:Date.now(),channelId:'private:1',chatType:'private',userId:'1',subType:'friend',text:'hi',records:[{}],files:[],forwards:[],...patch});
await fake.decide(msg({}),{canonical_id:'person1'},qcfg);
await fake.decide(msg({}),null,qcfg);
await fake.decide(msg({chatType:'private',userId:'2',subType:'stranger'}),{canonical_id:'person2'},qcfg);
await fake.decide(msg({chatType:'group',groupId:'55',channelId:'group:55',mentioned:true}),{canonical_id:'person1'},qcfg);
await fake.decide(msg({chatType:'group',groupId:'66',channelId:'group:66',mentioned:true}),{canonical_id:'person1'},{...qcfg,allGroups:true});
assert.deepEqual(results,[true,false,true,false]);
// 从真实 dispatch 到事件登记：多人合批不带路径，单人只授权这条消息的文件。
{
 const paths=[saveVoiceFile('in',wav)]; const sid='test-session'; let sent;
 const dispatch=Object.assign(Object.create(ChatGateway.prototype),{
  applyChatModelFor(){},typing(){},judgeTurn:async()=>{},turnMood:new Map(),moodOf:()=>({}),
  interjectTurns:new Set(),soul:{beginTurn(){}},replyChannelFor:()=>'',bound:new Map([[sid,{workspace_path:home}]]),
  workspacePath:()=>home,turns:new Map(),pendingVoicePaths:new Map(),voiceGuardReady:true,
  getConfig:()=>({voice:{enabled:true,saveIncoming:true}}),db:{prepare:()=>({run(){}})},
  quoteLine:async()=>'',videoNotes:async()=>[],admitImages:async(text)=>[{type:'text',text}],takeBacklog:()=>[],
 });
 const person={canonical_id:'one'};const m={chatType:'group',targetId:'55',userId:'1',nickname:'one',text:'hi',messageId:'a',voicePaths:paths};
 const agent={id:sid,followup:async(msg)=>{sent=msg}};
 await dispatch.dispatchInner('group:55',[{m,person}],agent);
 assert.match(sent.content[0].text,/本轮语音文件/);assert.ok(dispatch.pendingVoicePaths.has(sent.id));
 dispatch.onSessionEvent({id:sid},{type:'user/message',data:sent});assert.deepEqual(dispatch.turns.get(sid).voicePaths,paths);
 dispatch.onSessionEvent({id:sid},{type:'user/message',data:{id:'new',source:{kind:'fish-soul/bili',channelId:'bili:2'}}});assert.deepEqual(dispatch.turns.get(sid).voicePaths,[]);
 dispatch.turns.clear();await dispatch.dispatchInner('group:55',[{m,person},{m:{...m,userId:'2',voicePaths:[],messageId:'b'},person:{canonical_id:'two'}}],agent);
 assert.doesNotMatch(sent.content[0].text,/本轮语音文件/);assert.ok(!dispatch.pendingVoicePaths.has(sent.id));
}
// DSH 本地语音不走 QQ 出站、失败不干扰文字。
let sends=0; cfg.enabled=true; cfg.desktopTts=true; gw.channel.send=()=>{sends++}; gw.voice={synthesize:async()=>wav,lastError:''};
await gw.saveDesktopVoice('你好'); assert.equal(voiceFileList('out').length,1); assert.equal(sends,0);
gw.voice.synthesize=async()=>null; await gw.saveDesktopVoice('你好'); assert.equal(voiceFileList('out').length,1);
// 正常完成的桌面轮次走真实 VoiceService（HTTP 替身）、受配额限制且不外发。
{
 const {openDatabase}=await import('../lib/db.js'); const db=openDatabase();
 const config={enabled:true,desktopTts:true,ttsApiKey:'test-key',ttsBaseURL:'https://tts.example/v1',ttsPerDay:1,maxChars:20};
 let requests=0,sends=0;
 const voice=new VoiceService({db,getConfig:()=>voiceConfig(config),fetchImpl:async(_url,opts)=>{requests++;assert.equal(JSON.parse(opts.body).input,'你好');return new Response(Buffer.from('ID3hello'));}});
 const g=Object.assign(Object.create(ChatGateway.prototype),{bound:new Map([['desktop-test',{channel_id:'private:1'}]]),turns:new Map(),pendingVoicePaths:new Map(),waiters:new Map(),interjectTurns:new Set(),soul:{recallInfo:()=>({memories:[]})},voice,getConfig:()=>({voice:config}),channel:{send:()=>sends++},note(){},log(){}});
 const run=(reason='completed')=>{g.onSessionEvent({id:'desktop-test'},{type:'user/message',data:{source:{kind:'user'}}});g.onSessionEvent({id:'desktop-test'},{type:'assistant/message',data:{message:{content:[{type:'text',text:'你好'}]}}});g.onSessionEvent({id:'desktop-test'},{type:'turn/end',data:{reason:{kind:reason}}});};
 const before=voiceFileList('out').length;run();await new Promise(r=>setTimeout(r,100));assert.equal(requests,1);assert.equal(voiceFileList('out').length,before+1);assert.equal(sends,0);
 run();await new Promise(r=>setTimeout(r,100));assert.equal(requests,1,'共用 TTS 配额');run('interrupted');await new Promise(r=>setTimeout(r,100));assert.equal(requests,1,'中断轮次不合成');db.close();
}
console.log('✓ #101 音频格式、30 条、清理、来源范围、守卫参数、STT 独立和 DSH 本地输出');
