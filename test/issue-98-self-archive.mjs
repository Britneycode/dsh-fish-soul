// #98: 鱼自己删除的记忆也能分页找到、恢复，不混进别人的记忆。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
process.env.DSH_HOME = tmpHome('fish-self-archive-');
const { openDatabase } = await import('../lib/db.js');
const { handleSoulRoute } = await import('../lib/routes-soul.js');
const db = openDatabase();
const clock = { now: () => 5000 };
const worker = { queued: [], enqueueRealtime(id) { this.queued.push(id); } };
const insert = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords, importance, emotion, source_session, created_at, updated_at, status) VALUES ('feiyu', ?, 'self', '', 'fact', ?, '', 2, 0, 'manual', 1, ?, ?)`);
for (let i = 0; i < 35; i++) insert.run('self', `鱼的记忆 ${i}`, i + 1, 'archived');
insert.run('user:other', '别人的记忆', 999, 'archived');
insert.run('self', '有效记忆', 999, 'active');
async function call(method, path, payload = {}) {
 let result;
 const url = new URL('http://localhost' + path);
 const handled = await handleSoulRoute({ method, path: url.pathname, url, req: {}, res: {}, send: (status, body) => { result = {status, ...body}; }, readBody: async () => JSON.stringify(payload), sameOrigin: () => true, deps: { db, clock, worker } });
 assert.equal(handled, true); return result;
}
const first = await call('GET','/inspector/self-outdated?offset=0');
assert.equal(first.total, 35); assert.equal(first.items.length, 30);
assert(first.items.every(m => m.ownerId === 'self' && m.status === 'archived'));
const second = await call('GET','/inspector/self-outdated?offset=30');
assert.equal(second.items.length, 5); assert.equal(second.total, 35);
assert(!second.items.some(m => first.items.some(n => n.id === m.id)));
const target = second.items[0];
assert.equal((await call('POST','/inspector/memory-restore',{id:target.id})).ok,true);
assert.equal(db.prepare('SELECT status FROM memory WHERE id = ?').get(target.id).status,'active');
assert.deepEqual(worker.queued,[target.id]);
const ui = readFileSync(new URL('../lib/client.soul.js', import.meta.url), 'utf8');
assert.match(ui, /\/inspector\/self-outdated/); assert.match(ui, /选择人物/);
// 执行实际面板组件，用假 React 检查恢复按钮确实连接到接口，周记不提供恢复按钮。
let factory; const instrumented = ui.replace('return { InspectorPane, ActivityPane };', 'return { InspectorPane, ActivityPane, SelfArchive };');
const states = [0, { ok: true, total: 2, items: [{ id: 4, status: 'archived', kind: 'fact', content: '旧事' }, { id: 5, status: 'outdated', kind: 'weekly', content: '失效周记' }] }];
const react = { Fragment: 'fragment', useState: () => [states.shift(), () => {}], useCallback: fn => fn, useEffect: () => {} };
vm.runInNewContext(instrumented, { window: { __ModuleLoader__: { load: ({factory:f}) => { factory=f; } } }, URLSearchParams, Date });
const {SelfArchive} = factory(() => react);
const element = (type, props, ...children) => ({type, props:props ?? {}, children});
const U = { h:element, Group:(p,...c)=>element('Group',p,...c), Item:p=>element('Item',p), Button:(p,...c)=>element('Button',p,...c), Empty:t=>element('Empty',{},t), Muted:t=>element('Muted',{},t), Tag:t=>element('Tag',{},t) };
const calls=[]; let changed=0;
const tree=SelfArchive({ui:U,api:async (...args)=>{calls.push(args);return {ok:true}},notify:()=>{},onChanged:()=>changed++});
const items=tree.children[0].children[0];
assert.equal(items.length,2); const restoreButton=items[0].props.meta[0];
assert.equal(restoreButton.children[0],'恢复'); await restoreButton.props.onClick();
assert.equal(calls[0][0],'POST'); assert.equal(calls[0][1],'/inspector/memory-restore'); assert.equal(calls[0][2].id,4); assert.equal(changed,1);
assert.equal(items[1].props.meta[0].type,'Muted','失效周记不显示恢复按钮');
db.close(); console.log('✓ #98 她自己的旧记忆可分页查找和恢复');
