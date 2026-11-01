// 启动闸门：初始化中 / 中途失败回 503 并带步骤；就绪后转给真正的处理器。
import assert from 'node:assert/strict';
import { mountApiGate } from '../lib/routes.js';

let route = null;
const logs = [];
const ctx = { effect: (fn) => fn(), webServer: { register: (r) => { route = r; return () => {}; } } };
const gate = mountApiGate(ctx, (level, msg) => logs.push([level, msg]));

async function call(path = '/retrieval/state') {
	let status = 0; let out = '';
	await route.handler({ method: 'GET', url: '/api/plugins/fish-soul' + path, headers: {} },
		{ writeHead: (c) => { status = c; }, end: (s) => { out += s ?? ''; } });
	return { status, json: JSON.parse(out) };
}

assert.equal(route.kind, 'prefix');
assert.equal(route.path, '/api/plugins/fish-soul');
assert.ok(logs.some(([, m]) => m.includes('启动闸门已挂')));

gate.setTotal(3);
gate.step('底座');
let r = await call();
assert.equal(r.status, 503);
assert.equal(r.json.starting, true);
assert.equal(r.json.step, '底座');
assert.equal(r.json.stepIndex, 1);

gate.step('B站');
gate.fail(new Error('boom'));
r = await call();
assert.equal(r.status, 503);
assert.equal(r.json.failed, true);
assert.equal(r.json.step, 'B站');
assert.equal(r.json.stepIndex, 2);
assert.equal(r.json.error, 'boom');

gate.ready(async (req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, url: req.url })); });
r = await call('/persona/state');
assert.equal(r.status, 200);
assert.equal(r.json.ok, true);

console.log('✓ 启动闸门：启动中 503 / 失败 503 带步骤和原因 / 就绪后转发');
