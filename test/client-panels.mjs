// 主面板 / 侧栏注册契约：旧宿主降级、声明顺序、卸载及重新声明。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let factory;
const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Component: class {} };
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f; } } }, console });
const plugin = factory((name) => { assert.equal(name, 'react'); return react; });
assert.deepEqual(Array.from(plugin.inject), ['slots']);

function runtime() {
 const available = new Set(); const entries = new Map(); const subscriptions = new Set(); const effects = [];
 const layout = { active: null, panelInfo: { getSnapshot: () => ({ activePanelId: layout.active }) }, selectPanel(id) { layout.active = id; } };
 function launch(fn) {
  const result = fn();
  if (result && typeof result.next === 'function') {
   const disposers = [];
   for (const item of result) if (typeof item === 'function') disposers.push(item);
   return () => { for (const d of disposers.reverse()) d(); };
  }
  return typeof result === 'function' ? result : () => {};
 }
 const slots = {
  inject(name, callback) {
   const sub = { name, callback, dispose: null }; subscriptions.add(sub);
   if (available.has(name)) sub.dispose = launch(callback);
   return () => { if (!subscriptions.delete(sub)) return; sub.dispose?.(); sub.dispose = null; };
  },
  register(options, component) {
   assert(available.has(options.name), `注册了不存在的插槽 ${options.name}`);
   const key = `${options.name}:${options.id ?? options.key}`;
   assert(!entries.has(key), `重复注册 ${key}`); entries.set(key, { options, component });
   return () => entries.delete(key);
  },
 };
 const ctx = { slots, effect(fn) { effects.push(launch(fn)); }, get(name) { return name === 'layout' ? layout : null; } };
 plugin.apply(ctx);
 return {
  entries, layout,
  declare(name) { available.add(name); for (const s of [...subscriptions]) if (s.name === name && !s.dispose) s.dispose = launch(s.callback); },
  undeclare(name) { available.delete(name); for (const s of [...subscriptions]) if (s.name === name && s.dispose) { const d = s.dispose; s.dispose = null; d(); } },
  dispose() { for (const d of effects.reverse()) d(); },
 };
}
{
 const r = runtime(); r.declare('settings.section'); r.declare('sidebar.panellist');
 assert(r.entries.has('settings.section:fish-soul')); assert(!r.entries.has('sidebar.panellist:dsh-fish-soul'), '无主面板时不能出现死链');
 r.declare('main');
 const page = r.entries.get('main:dsh-fish-soul'); const row = r.entries.get('sidebar.panellist:dsh-fish-soul');
 assert(page && row); assert.equal(row.options.label(), '鱼');
 const icon = row.component({ size: 18 }); assert.equal(icon.type, 'svg'); assert.equal(icon.props.width, 18); assert.equal(icon.props['aria-hidden'], true);
 const shell = page.component(); assert.equal(shell.props.className, 'fs-page-shell'); assert.equal(shell.children[0].props.className, 'fs-page-scroll');
 r.layout.active = 'dsh-fish-soul'; r.undeclare('main'); assert.equal(r.layout.active, null);
 assert(!r.entries.has('main:dsh-fish-soul')); assert(!r.entries.has('sidebar.panellist:dsh-fish-soul')); assert(r.entries.has('settings.section:fish-soul'));
 r.declare('main'); assert(r.entries.has('sidebar.panellist:dsh-fish-soul')); r.layout.active = 'other'; r.dispose();
 assert.equal(r.layout.active, 'other'); assert.equal(r.entries.size, 0);
}
{
 const r = runtime(); r.declare('main'); assert(r.entries.has('main:dsh-fish-soul')); assert(!r.entries.has('sidebar.panellist:dsh-fish-soul'));
 r.declare('sidebar.panellist'); assert(r.entries.has('sidebar.panellist:dsh-fish-soul')); r.undeclare('sidebar.panellist');
 assert(!r.entries.has('sidebar.panellist:dsh-fish-soul')); assert(r.entries.has('main:dsh-fish-soul')); r.dispose();
}
console.log('✓ 主面板与侧栏：声明顺序、旧宿主降级、卸载及重新注册');
