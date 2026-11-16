// #118：补标签的诊断必须对应这次调用，而不是共享 lastError 或另一个日志系统。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';
process.env.DSH_HOME = tmpHome('issue-118-');
const { openDatabase, setKv } = await import('../lib/db.js');
const { StickerBox } = await import('../lib/stickers.js');
const { LlmRouter } = await import('../lib/llm.js');
const { DiagLog } = await import('../lib/diag-log.js');
const { handleV07Route } = await import('../lib/routes-v07.js');
const db = openDatabase();
const ws = join(process.env.DSH_HOME, 'ws');
mkdirSync(join(ws, '_stickers'), { recursive: true });
const items = ['missing.png', 'large.png', 'bad-image.png', 'model-error.png', 'invalid.png', 'ok.png'];
for (const name of items.slice(2)) writeFileSync(join(ws, '_stickers', name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(ws, '_stickers', 'large.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
setKv(db, 'stickers.collected', items.map((file) => ({ file, workspacePath: ws, hash: file, tags: [], at: 1 })));
const box = new StickerBox({ db, getConfig: () => ({}), log: () => {} });
let calls = 0;
const router = new LlmRouter({ db, getConfig: () => ({}), log: () => {}, ctx: { get: (name) => {
 if (name === 'attachments') return { admitPromptContent: async (parts) => { if (parts[1].name === 'bad-image.png') throw new Error('secret-attach'); return parts; } };
 if (name === 'llm') return { listProviders: () => [], async *stream({ messages }) {
  calls++; const file = messages[0].content[1].name;
  if (file === 'model-error.png') throw new Error('secret-token');
  yield { type: 'text-delta', text: file === 'invalid.png' ? '看不清' : '可爱、开心' };
 } };
} } });
const diag = new DiagLog({ db, log: () => {} });
let sent;
await handleV07Route({ method:'POST', path:'/stickers/backfill', url:new URL('http://localhost/stickers/backfill'), req:{}, res:{}, send:(status,obj)=>{sent={status,...obj};}, readBody:async()=>JSON.stringify({workspacePath:ws}), sameOrigin:()=>true, deps:{ db, getConfig:()=>({}), saveConfig:()=>{}, stickers:box, llmRouter:router, gateway:{workspacePath:()=>ws}, diag } });
assert.equal(sent.total, 5, '文件已经没了的记录不算待办（#118）');
assert.equal(sent.tagged, 1); assert.equal(sent.skipped, 4); assert.equal(calls, 3, '缺文件、过大和附件失败不能送到模型');
assert.deepEqual(sent.failures, { file_too_large:1, image_not_admitted:1, model_error:1, invalid_tags:1 });
assert.match(sent.hint, /4 MB/); assert.match(sent.hint, /附件/); assert.match(sent.hint, /模型/);
assert.doesNotMatch(sent.hint, /读不到/, '文件已经没了的记录不再每次报「文件读不到」');
assert.doesNotMatch(JSON.stringify(sent), /secret-token|secret-attach|missing\.png|bad-image\.png/);
const entry = diag.list().find((x) => x.key === 'sticker-tag-failed');
assert.ok(entry, '失败原因应进入用户可见运行日志');
assert.doesNotMatch(JSON.stringify(entry), /secret-token|secret-attach|missing\.png|bad-image\.png/);
assert.deepEqual(box.collected().find((x)=>x.file==='ok.png').tags, ['可爱','开心']);
assert.deepEqual(box.collected().find((x)=>x.file==='model-error.png').tags, [], '失败时不编标签');

const { createStickerVision } = await import('../lib/sticker-vision.js');
let reason;
const slow = createStickerVision({ call: async () => new Promise(() => {}) }, { timeoutMs: 20 });
const keep = setTimeout(() => {}, 1000);
assert.equal(await slow('prompt', [], {onFailure:(r)=>{reason=r;}}), null);
clearTimeout(keep);
assert.equal(reason, 'timeout');
// 上一个别的调用的 lastError 不能污染这次结果。
const fake = createStickerVision({ lastError:'secret-old-error', call:async()=>null }, {timeoutMs:100});
reason=''; await fake('prompt', [], {onFailure:(r)=>{reason=r;}}); assert.equal(reason,'no_response');
// 两个并发请求的原因必须各自独立，不能混用全局 lastError。
const isolatedRouter = new LlmRouter({ db, getConfig:()=>({}), log:()=>{}, ctx:{ get:(name)=>{
 if (name === 'attachments') return { admitPromptContent:async(parts)=>{ if(parts[1].name==='attachment.png') throw new Error('private-attachment-error'); return parts; } };
 if (name === 'llm') return { listProviders:()=>[], async *stream(){ await new Promise((r)=>setTimeout(r,10)); throw new Error('private-model-error'); } };
} } });
const vision = createStickerVision(isolatedRouter, {timeoutMs:500});
const reasons = {};
await Promise.all(['attachment.png','model.png'].map(async (name)=>{
 await vision('prompt',[{data:'AA==',mediaType:'image/png',name}],{onFailure:(code)=>{reasons[name]=code;}});
}));
assert.deepEqual(reasons, {'attachment.png':'image_not_admitted','model.png':'model_error'});
const emptyRouter = new LlmRouter({ db, getConfig:()=>({}), log:()=>{}, ctx:{ get:(name)=>{
 if(name==='attachments')return {admitPromptContent:async(parts)=>parts};
 if(name==='llm')return {listProviders:()=>[],async *stream(){yield {type:'finish',reason:{kind:'stop'}};}};
} } });
reason=''; await createStickerVision(emptyRouter, {timeoutMs:500})('prompt',[{data:'AA==',mediaType:'image/png'}],{onFailure:(r)=>{reason=r;}});
assert.equal(reason,'empty_response');
const missingRouter = new LlmRouter({db,getConfig:()=>({}),log:()=>{},ctx:{}});
reason=''; await createStickerVision(missingRouter, {timeoutMs:500})('prompt',[],{onFailure:(r)=>{reason=r;}});
assert.equal(reason,'model_unavailable');

// 启动后自动补标签必须走同一套分类，不能再留一个只回 null 的旧回调。
{
 const src = (await import('node:fs')).readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
 assert.match(src, /createStickerVision\(llmRouter\)/, '启动补标签要复用 createStickerVision');
 assert.doesNotMatch(src, /AbortSignal\.timeout\(20_000\)/, '不能再留一套独立的 20 秒超时');
}
console.log('issue-118-sticker-diagnostics ok');
db.close();
