// 独立进程跑一轮完整 pollInner，验证熔断真的拦住
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dbg-poll-'));
const { openDatabase, getKv, setKv } = await import('../lib/db.js');
const { DouyinChannel } = await import('../lib/channels/douyin.js');
const db = openDatabase();
setKv(db, 'douyin.bootstrapped', true);
const key = `douyin.conv.${(await import('node:crypto')).createHash('sha1').update('未云').digest('hex').slice(0,16)}`;
setKv(db, key, { name: '未云', sig: '旧', window: [] });
setKv(db, `douyin.retry.${key}`, Date.now()); // 刚失败 → 窗口内
const d = new Date(); const hh = String(d.getHours()).padStart(2,'0'); const mm = String(d.getMinutes()).padStart(2,'0');
let reads = 0;
const ch = new DouyinChannel({
  db, host:{running:true,loggedIn:true,exclusive:async(_l,fn)=>await fn()},
  getConfig:()=>({enabled:true}), log:()=>{}, onMessage:async()=>({done:true}),
  driver:{
    checkLogin:async()=>true,
    list:async()=>({ok:true,conversations:[{name:'未云',unread:0,time:hh+':'+mm,preview:'新预览'}]}),
    read:async()=>{ reads++; return {ok:false,error:'x'}; },
  },
  pollRangeMs:[1000,2000],
});
ch.lastCanaryAt = Date.now();
await ch.pollInner().catch(e=>console.log('ERR', e.message));
console.log('READS:', reads);
process.exit(reads === 0 ? 0 : 1);
