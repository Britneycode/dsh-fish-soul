/**
 * #132：设置页「最近看过 / 动态和评论」分页接口。
 *
 * 为什么要有这个测试：
 *   面板以前只显示「最近 8 条刷视频 + 最近 10 条动态/评论」，更早的记录
 *   存在库里但面板拿不到。这两个接口（/bili/seen、/bili/social-log）
 *   就是给「加载更多」用的 —— 没有测试守着，谁顺手把 LIMIT 改回 8
 *   或者删掉 before 过滤，测试照样绿。
 */
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const ok = (msg) => console.log('✓', msg);
process.env.DSH_HOME = tmpHome('dsh-bili-pagination-');

const { openDatabase } = await import('../lib/db.js');
const { registerRoutes } = await import('../lib/routes.js');

const db = openDatabase();

// 造 25 条刷视频记录（seen_real_at 递减，最新的最大）
const insSeen = db.prepare(`INSERT INTO bili_seen (bvid, title, owner_name, source, impression, skipped, liked, favorited, seen_at, seen_real_at) VALUES (?, ?, '', 'recommend', '', 0, 0, 0, ?, ?)`);
for (let i = 0; i < 25; i++) insSeen.run(`BV${String(i).padStart(3, '0')}`, `视频${i}`, 1000 + i, 1000 + i);
// 造 12 条动态 + 12 条评论回复（created_real_at 交错）
const insPost = db.prepare(`INSERT INTO social_post (platform, post_id, content, created_at, created_real_at) VALUES ('bili', ?, ?, ?, ?)`);
for (let i = 0; i < 12; i++) insPost.run(`post${i}`, `动态内容${i}`, 2000 + i * 2, 2000 + i * 2);
const insReply = db.prepare(`INSERT INTO social_reply (platform, notify_id, from_name, subject, content, reply, status, created_real_at) VALUES ('bili', ?, '某人', '', ?, '', 'replied', ?)`);
for (let i = 0; i < 12; i++) insReply.run(`nid${i}`, `评论内容${i}`, 2001 + i * 2);

const deps = {
	db,
	clock: { getRoleDateParts: () => ({ dateStr: '2030-01-01' }) },
	embedder: {}, worker: {},
	life: { browseState: () => ({ count: 0 }), stateSnapshot: () => ({ today: {} }) },
	getConfig: () => ({ bili: { enabled: true }, qq: {}, douyin: {}, masterQqUin: '10001' }),
	saveConfig: () => {},
	log: () => {},
	gateway: { workspacePath: () => '/ws', listWorkspaces: () => [], isPaused: () => false },
	channel: { status: () => ({ connected: true }), restart() {} },
	bili: { status: () => ({ loggedIn: false }), restart() {} },
	biliClient: null, browser: null, biliSocial: null,
	douyin: { status: () => ({ running: false }) },
	douyinHost: { browsers: [], status: () => ({ state: 'stopped' }) },
	douyinBrowser: null, douyinSocial: null
};

function mount() {
	let handler = null;
	registerRoutes({ effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } }, deps);
	return handler;
}

async function call(path) {
	const handler = mount();
	let out = '';
	const req = new (await import('node:stream')).Readable({ read() { this.push(null); } });
	req.url = `/api/plugins/fish-soul${path}`;
	req.method = 'GET';
	req.headers = {};
	const res = { writeHead: () => {}, end: (t) => { out = t; } };
	await handler(req, res);
	return JSON.parse(out);
}

// ── /bili/seen：第一页 ──
let r = await call('/bili/seen?limit=10');
assert.equal(r.ok, true, 'seen 第一页要成功');
assert.equal(r.items.length, 10, `seen 第一页要 10 条，实际 ${r.items.length}`);
assert.equal(r.items[0].bvid, 'BV024', '最新的一条在最前');
assert.ok(r.next !== null, '还有更多时 next 不能是 null');

// ── /bili/seen：翻页到第三页（只剩 5 条）──
r = await call(`/bili/seen?before=${r.next}&limit=10`);
assert.equal(r.items.length, 10, '第二页 10 条');
r = await call(`/bili/seen?before=${r.next}&limit=10`);
assert.equal(r.items.length, 5, `第三页只剩 5 条，实际 ${r.items.length}`);
assert.equal(r.next, null, '翻完了 next 要是 null');
assert.equal(r.items[4].bvid, 'BV000', '最旧的一条在最后');

// ── /bili/social-log：第一页（合并动态 + 评论，按时间倒序）──
r = await call('/bili/social-log?limit=10');
assert.equal(r.ok, true, 'social-log 第一页要成功');
assert.equal(r.items.length, 10, `第一页 10 条，实际 ${r.items.length}`);
assert.ok(r.next !== null, '还有更多时 next 不能是 null');
// 最新的两条：评论 nid11（at=2023）和动态 post11（at=2022）
assert.equal(r.items[0].kind, 'reply', '最新的是评论');
assert.equal(r.items[0].at, 2023, '最新一条时间对');
assert.equal(r.items[1].kind, 'post', '次新的是动态');

// ── /bili/social-log：翻页到第三页（只剩 4 条）──
r = await call(`/bili/social-log?before=${r.next}&limit=10`);
assert.equal(r.items.length, 10, '第二页 10 条');
r = await call(`/bili/social-log?before=${r.next}&limit=10`);
assert.equal(r.items.length, 4, `第三页只剩 4 条，实际 ${r.items.length}`);
assert.equal(r.next, null, '翻完了 next 要是 null');

// ── backlog 状态的评论不进列表 ──
db.prepare(`INSERT INTO social_reply (platform, notify_id, from_name, subject, content, reply, status, created_real_at) VALUES ('bili', 'backlog1', '某人', '', '旧评论', '', 'backlog', 1999)`).run();
r = await call('/bili/social-log?limit=50');
assert.ok(!r.items.some((x) => x.text.includes('旧评论')), 'backlog 状态的不能出现在列表里');

// ── limit 上限 50，乱参数回退 20 ──
// 造到 60 条，真的穿过上限（只有 25 条时断言是虚的：数据不够本身就会回 25）
for (let i = 25; i < 60; i++) insSeen.run(`BV${String(i).padStart(3, '0')}`, `视频${i}`, 1000 + i, 1000 + i);
r = await call('/bili/seen?limit=999');
assert.equal(r.items.length, 50, `limit 超上限要收到 50，实际 ${r.items.length}`);
r = await call('/bili/seen?limit=abc');
assert.equal(r.items.length, 20, `limit 乱参数要回退 20，实际 ${r.items.length}`);

// ── 同毫秒游标边界：固化「整组跳过」的显性契约 ──
// 游标是「at < before」严格小于：同一毫秒的多条若跨页，下一页会跳过同毫秒剩余的。
// 这是时间戳游标的已知代价（串行写入基本撞不上），写在这里是让它变成显性契约而不是偷偷发生。
db.prepare("DELETE FROM bili_seen").run();
db.prepare(`INSERT INTO bili_seen (bvid, title, owner_name, source, impression, skipped, liked, favorited, seen_at, seen_real_at) VALUES ('BVt1', '同毫秒1', '', 'recommend', '', 0, 0, 0, 5000, 5000)`).run();
db.prepare(`INSERT INTO bili_seen (bvid, title, owner_name, source, impression, skipped, liked, favorited, seen_at, seen_real_at) VALUES ('BVt2', '同毫秒2', '', 'recommend', '', 0, 0, 0, 5000, 5000)`).run();
db.prepare(`INSERT INTO bili_seen (bvid, title, owner_name, source, impression, skipped, liked, favorited, seen_at, seen_real_at) VALUES ('BVt3', '同毫秒3', '', 'recommend', '', 0, 0, 0, 5000, 5000)`).run();
r = await call('/bili/seen?limit=1');
assert.equal(r.items.length, 1, '第一页只回 1 条');
assert.ok(r.next !== null, '还有更多时 next 不能是 null');
r = await call(`/bili/seen?before=${r.next}&limit=10`);
// 第一页的那条 at=5000，严格小于游标：同毫秒剩余的两条被整组跳过（已知代价）
assert.equal(r.items.length, 0, `同毫秒剩余的被跳过（契约），实际 ${r.items.length}`);
assert.equal(r.next, null, '跳过后没有更多了');

ok('分页接口：第一页 / 翻页 / 翻完 / backlog 排除 / limit 钳制，全对得上');
