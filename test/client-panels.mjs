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

// 官方共享组件优先；模块缺失时退回原控件，不丢失事件和禁用状态。
{
 const instrumented = source.replace('exports.apply = apply;', 'exports.__controls = { Button, Switch, Dot, Icon, IconButton, Seg, Tag, Pill, Check, Input, Num }; exports.apply = apply;');
 let capture;
 vm.runInNewContext(instrumented, { window: { __ModuleLoader__: { load: ({ factory: f }) => { capture = f; } } }, console });
 const native = { Button: function NativeButton() {}, Switch: function NativeSwitch() {}, StateDot: function NativeStateDot() {}, Input: function NativeInput() {}, Pill: function NativePill() {}, Tag: function NativeTag() {}, Checkbox: function NativeCheckbox() {}, IconCloseOutlineRegular: function NativeClose() {}, IconChevronUpOutlineRegular: function NativeUp() {}, IconChevronDownOutlineRegular: function NativeDown() {} };
 const make = (provided) => capture((name) => name === 'react' ? react : provided ? native : (() => { throw Error('missing optional module'); })());
 let clicked = 0, switched = null;
 const buttonProps = { variant: 'primary', onClick: () => clicked++, disabled: true };
 const switchProps = { checked: false, label: '自动检查更新', onChange: (v) => { switched = v; } };
 const official = make(true).__controls;
 const b = official.Button(buttonProps, '保存');
 assert.equal(b.type, native.Button); assert.equal(b.props.variant, 'primary'); assert.equal(b.props.size, 'sm'); assert.equal(b.props.disabled, true); b.props.onClick(); assert.equal(clicked, 1);
 const s = official.Switch(switchProps); assert.equal(s.type, native.Switch); assert.equal(s.props.label, switchProps.label); s.props.onChange(true); assert.equal(switched, true);
 assert.equal(official.Dot('done').type, native.StateDot);
 const fallback = make(false).__controls;
 assert.equal(fallback.Dot('done').type, 'span');
 const fb = fallback.Button(buttonProps, '保存'); assert.equal(fb.type, 'button'); assert.equal(fb.props.disabled, true); fb.props.onClick(); assert.equal(clicked, 2);
 const fs = fallback.Switch(switchProps); assert.equal(fs.type, 'button'); assert.equal(fs.props.role, 'switch'); switched = null; fs.props.onClick(); assert.equal(switched, true);
 let inputValue = null, blurred = 0, checked = null, chosen = null;
 const inputProps = { value: 'abc', placeholder: '地址', style: { width: '160px' }, onChange: e => { inputValue = e.target.value; }, onBlur: () => blurred++ };
 const input = official.Input(inputProps); assert.equal(input.type, 'span'); assert.equal(input.props.style.width, '160px');
 const inner = input.children[0]; assert.equal(inner.type, native.Input); assert.equal(inner.props.value, 'abc'); inner.props.onChange({target:{value:'next'}}); inner.props.onBlur(); assert.equal(inputValue, 'next'); assert.equal(blurred, 1);
 const numberInput = { value: '5', focus() {}, stepUp() { this.value = String(+this.value + 1); }, stepDown() { this.value = String(+this.value - 1); } };
 react.useRef = () => ({ current: { querySelector: () => numberInput } });
 let stepped = null; const num = official.Num({value: 5, min: 0, max: 20, onChange:e => {stepped = e.target.value;}});
 const numView = num.type(num.props); const numeric = numView.children[0].children[0];
 assert.equal(numeric.props.type, 'number'); assert.equal(numeric.props.min, 0); assert.equal(numeric.props.max, 20);
 const up = numView.children[1].children[0], down = numView.children[1].children[1];
 assert.equal(up.children[0].type, native.IconChevronUpOutlineRegular); assert.equal(down.children[0].type, native.IconChevronDownOutlineRegular);
 assert.equal(up.children[0].props.size, 9); assert.equal(down.children[0].props.size, 9);
 up.props.onClick(); assert.equal(stepped, '6'); down.props.onClick(); assert.equal(stepped, '5');
 const atMax = official.Num({value:20,min:0,max:20}).type({value:20,min:0,max:20});
 assert.equal(atMax.children[1].children[0].props.disabled,true); assert.equal(atMax.children[1].children[1].props.disabled,false);
 const atMin = official.Num({value:0,min:0,max:20}).type({value:0,min:0,max:20});
 assert.equal(atMin.children[1].children[0].props.disabled,false); assert.equal(atMin.children[1].children[1].props.disabled,true);
 const fi = fallback.Input(inputProps); assert.equal(fi.type, 'input'); fi.props.onChange({target:{value:'fallback'}}); assert.equal(inputValue, 'fallback');
 const checkProps = {checked:false, label:'选中 #1', hideLabel:true, title:'选择', onChange:v => {checked = v;}};
 const check = official.Check(checkProps); assert.equal(check.type, native.Checkbox); assert.equal(check.props.label, checkProps.label); check.props.onChange(true); assert.equal(checked,true);
 const fc = fallback.Check(checkProps); assert.equal(fc.type,'label'); checked = null; fc.children[0].props.onChange({target:{checked:true}}); assert.equal(checked,true); assert.equal(fc.children[1].children[0],checkProps.label);
 const pill = official.Pill({active:true, 'aria-pressed':true, onClick:()=>chosen='pill', children:'朋友'}); assert.equal(pill.type,native.Pill); assert.equal(pill.props.active,true); pill.props.onClick(); assert.equal(chosen,'pill');
 assert.equal(fallback.Pill({children:'朋友'}).type,'button');
 const seg = official.Seg({options:[{value:'a',label:'甲'},{value:'b',label:'乙'}], value:'a', label:'模式', onChange:v=>chosen=v});
 assert.equal(seg.props.role,'radiogroup'); const choices = seg.children[1]; assert.equal(choices[0].type,native.Pill); assert.equal(choices[0].props['aria-checked'],true); choices[1].props.onClick(); assert.equal(chosen,'b');
 const fseg = fallback.Seg({options:[{value:'a',label:'甲'}],value:'a',onChange:()=>{},label:'模式'}); assert.equal(fseg.children[1][0].type,'button');
 const tag = official.Tag('警告','warning',{title:'详情'}); assert.equal(tag.props.title,'详情'); assert.equal(tag.children[0].type,native.Tag); assert.equal(tag.children[0].props.tone,'warning'); assert.equal(fallback.Tag('警告').type,'span');
 assert.equal(official.Icon('close').type,native.IconCloseOutlineRegular); assert.equal(official.Icon('eye').type,'svg'); assert.equal(fallback.Icon('close').type,'svg');
 assert.equal(official.IconButton('close','关闭',()=>{}).type,native.Button); assert.equal(fallback.IconButton('close','关闭',()=>{}).type,'button');
 const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
 assert(pkg.dsh.client.external.includes('@deepseek-ai/dsh-client-ui-primitives'));
 console.log('✓ 官方控件与缺失模块回退：状态、事件、语义及声明');
}
