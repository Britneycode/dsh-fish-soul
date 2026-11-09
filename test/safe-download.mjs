import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createSafeDownload, publicIPv4 } from '../lib/safe-download.js';
import { fetchImageBytes } from '../lib/gateway-util.js';
import { VoiceService } from '../lib/voice.js';

function fixture({ answers = [{address:'8.8.8.8',family:4}], responses = [{status:200, body:['abcd']}] } = {}) {
 const seen = [], lookups = [];
 const download = createSafeDownload({
  lookup: async (host) => { lookups.push(host); return typeof answers === 'function' ? answers(host) : answers; },
  request: (url, opts, cb) => {
   seen.push({url: url.href, opts}); const req = new EventEmitter();
   req.end = () => queueMicrotask(() => { const next=responses.shift(); if (!next) return req.emit('error', Error('unexpected request'));
    const res=Readable.from((next.body ?? []).map(x => Buffer.from(x))); res.statusCode=next.status; res.headers=next.headers ?? {}; cb(res); });
   return req;
  }
 });
 return {download,seen,lookups};
}
const get = (f,url='https://cdn.example/a',maxBytes=4) => f.download(url,{maxBytes});

test('公开 IPv4 才可连接：私网、环回、保留网段和 IPv6 全拒绝', async () => {
 for (const ip of ['0.1.2.3','10.1.2.3','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.1','192.168.1.1','100.64.1.1','192.0.0.1','192.0.2.1','198.18.0.1','198.51.100.2','203.0.113.1','224.0.0.1','255.255.255.255','::1','::ffff:8.8.8.8']) assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('8.8.8.8'),true);
 for (const url of ['http://127.1/','http://0x7f000001/','http://169.254.169.254/','http://[::1]/','file:///etc/passwd','https://u:p@example.com/','http://8.8.8.8:8080/']) { const f=fixture(); assert.equal(await get(f,url),null,url);assert.equal(f.seen.length,0); }
 const mixed=fixture({answers:[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]});assert.equal(await get(mixed),null);assert.equal(mixed.seen.length,0);
});

test('DNS 重绑定防护：固定已验证 IP，保留 TLS 服务器名与 Host', async () => {
 let n=0;const f=fixture({answers:()=>{n++;return [{address:n===1?'8.8.8.8':'127.0.0.1',family:4}]}});
 assert.equal((await get(f)).toString(),'abcd');assert.equal(n,1);assert.equal(f.seen[0].opts.hostname,'8.8.8.8');assert.equal(f.seen[0].opts.servername,'cdn.example');assert.equal(f.seen[0].opts.headers.host,'cdn.example');
 const dual=fixture({answers:[{address:'2606:4700:4700::1111',family:6},{address:'8.8.8.8',family:4}]});assert.equal((await get(dual)).toString(),'abcd');
 const only6=fixture({answers:[{address:'2606:4700:4700::1111',family:6}]});assert.equal(await get(only6),null);
});

test('每次重定向都重新验证；拒绝私网、非 HTTP 和超限跳转', async () => {
 for (const target of ['http://127.0.0.1/','file:///etc/passwd','http://internal.test/']) {
  const f=fixture({answers:h=>[{address:h==='internal.test'?'10.0.0.1':'8.8.8.8',family:4}],responses:[{status:302,headers:{location:target}}]});
  assert.equal(await get(f),null);assert.equal(f.seen.length,1);
 }
 const f=fixture({responses:[{status:302,headers:{location:'https://other.example/file'}},{status:200,body:['ab','cd']}]});assert.equal((await get(f)).toString(),'abcd');assert.deepEqual(f.lookups,['cdn.example','other.example']);
 const loop=fixture({responses:Array.from({length:4},()=>({status:302,headers:{location:'/loop'}}))});assert.equal(await get(loop),null);assert.equal(loop.seen.length,4);
});

test('按实际流量限额：无长度、虚报、小于和等于边界', async () => {
 for(const [r,expected] of [[{status:200,body:['ab','cd']},'abcd'],[{status:200,body:['ab','cde']},null],[{status:200,headers:{'content-length':'1'},body:['abcde']},null],[{status:200,headers:{'content-length':'5'},body:['x']},null],[{status:404,body:['x']},null]]) {
  const f=fixture({responses:[r]});const got=await get(f);assert.equal(got?.toString() ?? null,expected);
 }
});

test('入站图片及语音不能直接读取本地文件，内联音频按大小限制', async () => {
 assert.equal(await fetchImageBytes({url:'file:///etc/passwd'}),null);
 const voice=new VoiceService({getConfig:()=>({})});
 assert.equal(await voice.fetchQqRecord(null,{path:'/etc/passwd'}),null);
 assert.equal((await voice.fetchQqRecord(null,{base64:Buffer.from('ok').toString('base64')})).toString(),'ok');
 assert.equal(await voice.fetchQqRecord(null,{base64:'A'.repeat(Math.ceil((8*1024*1024)/3)*4+4)}),null);
});

test('真实 HTTP 流：分块上限、超时和跳转到内网', async () => {
 const {createServer,request}=await import('node:http');
 const server=createServer((req,res)=>{
  if (req.url==='/chunks') { res.writeHead(200); res.write('ab'); setTimeout(()=>res.end('cde'),10); }
  else if(req.url==='/redirect') {res.writeHead(302,{location:'http://127.0.0.1/private'});res.end();}
  else if(req.url==='/hang') { /* 留给 AbortSignal 超时 */ }
  else {res.end('ok');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;
 const seen=[];
 const download=createSafeDownload({lookup:async()=>[{address:'8.8.8.8',family:4}],request:(url,opts,cb)=>{seen.push(opts);return request({...opts,hostname:'127.0.0.1',port},cb);}});
 try {
  assert.equal((await download('http://cdn.test/ok',{maxBytes:4})).toString(),'ok');
  assert.equal(seen[0].hostname,'8.8.8.8');
  assert.equal(await download('http://cdn.test/chunks',{maxBytes:4}),null);
  assert.equal(await download('http://cdn.test/redirect',{maxBytes:4}),null);
  assert.equal(await download('http://cdn.test/hang',{maxBytes:4,timeoutMs:50}),null);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('真实 TLS：验证原始域名和信任链，错误证书拒绝', async (t) => {
 const {mkdtempSync,readFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');const https=await import('node:https');
 const dir=mkdtempSync(join(tmpdir(),'fish-tls-'));const keyPath=join(dir,'key.pem'),certPath=join(dir,'cert.pem');
 const gen=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=cdn.test','-addext','subjectAltName=DNS:cdn.test'],{stdio:'ignore'});
 if(gen.status!==0){rmSync(dir,{recursive:true,force:true});t.skip('openssl 不可用');return;}
 const key=readFileSync(keyPath),cert=readFileSync(certPath);const seen=[];
 const server=https.createServer({key,cert},(req,res)=>{seen.push({sni:req.socket.servername,host:req.headers.host});res.end('ok');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const make=(trust)=>createSafeDownload({lookup:async()=>[{address:'8.8.8.8',family:4}],request:(_url,opts,cb)=>https.request({...opts,hostname:'127.0.0.1',port,...(trust?{ca:cert}:{})},cb)});
 try {
  assert.equal((await make(true)('https://cdn.test/file',{maxBytes:5})).toString(),'ok');
  assert.deepEqual(seen,[{sni:'cdn.test',host:'cdn.test'}]);
  assert.equal(await make(true)('https://wrong.test/file',{maxBytes:5}),null,'证书与目标域名不匹配');
  assert.equal(await make(false)('https://cdn.test/file',{maxBytes:5}),null,'不信任的证书必须拒绝');
  assert.equal(seen.length,1,'握手失败不能到达应用');
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
