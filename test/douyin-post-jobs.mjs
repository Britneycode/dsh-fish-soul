import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const home=mkdtempSync(join(tmpdir(),'fish-post-jobs-'));process.env.DSH_HOME=home;
const { openDatabase }=await import('../lib/db.js');
const { DouyinSocial }=await import('../lib/douyin-social.js');
const db=openDatabase();
let mode='ambiguous', clicks=0, seen=[];
const driver={
 renderCard:async()=>Buffer.from('card'), prepareNote:async()=>({ok:true}),
 listRecommendedMusic:async()=>({ok:true,songs:['歌']}),closeMusicPanel:async()=>{},
 publishNote:async({beforeSubmit,allowDuplicate})=>{seen.push(allowDuplicate);if(mode==='music-failed')return {ok:false,error:'配乐失败'};await beforeSubmit();clicks++;if(mode==='ambiguous')return {ok:false,error:'timeout'};return {ok:true,musicPicked:true};}
};
const host={running:true,loggedIn:true,exclusive:async(_label,fn)=>await fn()};
const clock={now:()=>100,getRoleDateParts:()=>({dateStr:'2026-11-09',hour:12,minute:0})};
const make=()=>new DouyinSocial({db,clock,host,driver,getConfig:()=>({enabled:true,post:{enabled:true,perDay:1}}),callLlm:async(p)=>p.includes('背景音乐')?'歌':p.includes('「心情」')?'{}':'测试发布内容',persona:()=>({name:'鱼'}),cardDir:join(home,'cards')});
try {
 let s=make();
 mode='music-failed'; let r=await s.post({force:true});assert.equal(r.ok,false);assert.equal(clicks,0);assert.equal(s.postJobs.pending(),null);
 mode='ambiguous'; r=await s.post({force:true});assert.equal(r.ok,false);assert.match(r.error,/结果未知/);assert.equal(clicks,1);let pending=s.postJobs.pending();assert.equal(pending.status,'unknown');
 r=await s.post({force:true});assert.equal(r.ok,false);assert.equal(clicks,1,'手动强制也不能重发');
 s=make(); pending=s.postJobs.pending();assert.equal(pending.status,'unknown');
 assert.equal(s.resolvePost(pending.id,'published').ok,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM social_post WHERE platform='douyin'").get().n,1);assert.equal(s.postState('2026-11-09').count,1);
 assert.equal(s.resolvePost(pending.id,'published').ok,false,'不能重复记账');
 mode='ok';r=await s.post({force:true});assert.equal(r.ok,true);assert.equal(clicks,2);assert.equal(db.prepare("SELECT COUNT(*) n FROM social_post WHERE platform='douyin'").get().n,2);
 driver.listRecommendedMusic=async()=>({ok:true,songs:['歌'],counts:{'歌':2}});
 seen=[];r=await s.post({force:true});assert.equal(r.ok,true,r.error);assert.equal(seen.at(-1),true,'同名歌要告诉发布去点第一张');assert.equal(clicks,3);
 // 确保上次发送时直接退出也会在重启时变为 unknown。
 const id=s.postJobs.begin('中断','2026-11-09');s.postJobs.submitting(id);s=make();assert.equal(s.postJobs.pending().status,'unknown');assert.equal(s.resolvePost(id,'not_published').ok,true);assert.equal(s.postJobs.pending(),null);
 console.log('✓ 抖音发布任务：配乐失败不发布、提交未知不重发、重启恢复、人工核实与记账');
} finally {db.close();rmSync(home,{recursive:true,force:true});}
