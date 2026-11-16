// #125：记忆列表能按类型、按日期筛（query 参数真的进 WHERE，前端也有这两个控件）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';
process.env.DSH_HOME = tmpHome('issue-125-');
const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');
const db = openDatabase();
const clock = { now: () => Date.parse('2026-11-16T12:00:00Z') };
const worker = { enqueueRealtime() {} };
const ins = db.prepare(`INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, created_at, updated_at, status, sort_date)
	VALUES ('feiyu', 'self', 'manual', '', ?, ?, ?, ?, 'active', ?)`);
ins.run('fact', '事实一条', 1, 1, '2026-01-05');
ins.run('event', '事件一条', 1, 1, '2026-03-10');
ins.run('feeling', '感受一条', 1, 1, '2026-05-20');
const createdAt = Date.parse('2026-02-14T10:00:00Z');
ins.run('episode', '聊过一条', createdAt, createdAt, null);
let handler;
registerRoutes({ effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } }, { db, clock, worker, getConfig: () => ({}), saveConfig() {} });
async function get(path) {
	let obj;
	await handler({ method: 'GET', url: `/api/plugins/fish-soul${path}`, headers: {}, on() {} }, { writeHead() {}, end(s) { obj = JSON.parse(s); } });
	return obj;
}
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const all = await get('/inspector/overview');
assert.equal(all.matchedTotal, 4);
const byKind = await get('/inspector/overview?kind=event');
assert.equal(byKind.matchedTotal, 1, '按类型筛');
assert.deepEqual(byKind.memories.map((m) => m.content), ['事件一条']);
const byDate = await get('/inspector/overview?from=2026-03-01&to=2026-03-31');
assert.equal(byDate.matchedTotal, 1, '按日期范围筛');
assert.deepEqual(byDate.memories.map((m) => m.content), ['事件一条']);
const byCreated = await get(`/inspector/overview?from=${localDay(createdAt)}&to=${localDay(createdAt)}`);
assert.deepEqual(byCreated.memories.map((m) => m.content), ['聊过一条'], '没有事件日期的按创建日期算');
const junk = await get('/inspector/overview?kind=%E4%B9%B1%E5%86%99&from=2026-13-45');
assert.equal(junk.matchedTotal, 4, '非法类型 / 日期不筛');

// 前端控件在（设置页「记忆内容」那一行）
const client = readFileSync(new URL('../lib/client.soul.js', import.meta.url), 'utf8');
assert.match(client, /ui\.Select\(\{ value: kind, "aria-label": "类型", onChange: \(e\) => setKind\(e\.target\.value\) \}, \.\.\.KIND_OPTIONS\.map/, '记忆列表能按类型筛选');
assert.match(client, /KIND_OPTIONS = \[\["", "所有类型"\], \.\.\.Object\.entries\(KIND\)\.filter\(\(\[k\]\) => k !== "weekly" && k !== "diary"\)\]/, '类型选项 = 事实 / 事件 / 感受 / 聊过');
assert.match(client, /"aria-label": "日期从"/, '记忆列表有日期筛选');
assert.match(client, /\.\.\.\(kind \? \{ kind \} : \{\}\)/, '类型筛选进了列表请求');
assert.match(client, /\.\.\.\(from \? \{ from \} : \{\}\)/, '日期筛选进了列表请求');

db.close();
console.log('issue-125-memory-filter ok');
