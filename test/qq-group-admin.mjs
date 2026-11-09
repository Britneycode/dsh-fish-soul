// 群管理：发版公告（基线 / 只发一次 / 更新说明）+ 入群申请（自动同意 / 主人拍板 / 兜底轮询）+ 接线。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
	GroupAdmin, normalizeConfig, cleanNotes, formatAnnouncement, describeRequest, changelogSection,
	KV_ANNOUNCED, KV_PENDING, KV_MEMBERS
} from '../lib/qq-group-admin.js';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

// ── 配置归一 ──
let cfg = normalizeConfig(undefined);
assert.equal(cfg.enabled, false);
assert.equal(cfg.groupId, '');
assert.equal(cfg.announce, true);
assert.equal(cfg.autoApprove, true);
assert.equal(cfg.releasePollMinutes, 5);
assert.equal(cfg.requestPollSeconds, 60);
cfg = normalizeConfig({ enabled: true, groupId: 'group:123456', releasePollMinutes: 9999, requestPollSeconds: 1 });
assert.equal(cfg.groupId, '123456');
assert.equal(cfg.releasePollMinutes, 1440);
assert.equal(cfg.requestPollSeconds, 15);
cfg = normalizeConfig({ enabled: true, groupId: '123456', announce: false, autoApprove: false });
assert.equal(cfg.announce, false);
assert.equal(cfg.autoApprove, false);

// ── 更新说明清洗 / 公告正文 ──
const lines = cleanNotes('- v0.15.9：修好了——\n  - **#68 删除人物卡**：person 行软删除\n  - 修抖音回评论\n');
assert.deepEqual(lines, ['v0.15.9：修好了——', '#68 删除人物卡：person 行软删除', '修抖音回评论']);
assert.equal(cleanNotes('').length, 0);
assert.equal(cleanNotes('   \n\n  ').length, 0);
const capped = cleanNotes(Array.from({ length: 50 }, (_, i) => `第${i}行`).join('\n'), 60);
assert.ok(capped.join('').length <= 80, '太长的说明要截断');
assert.match(capped[capped.length - 1], /Release 页面/);
// 一整行就超长（CHANGELOG 常常是几百字一个自然段）：必须截断后仍然有内容，
// 不能返回 0 行 —— 那会让公告写「这次没写更新说明」（v0.15.25/.27/.28 都踩过）
{
	const oneLine = '先说第一件事。然后说第二件事，这里啰嗦一点凑长度。最后是第三件事。';
	const got = cleanNotes(oneLine, 20);
	assert.ok(got.length > 0, '单行超长不能整行丢掉');
	assert.ok(got[0].length <= 20, '单行超长也要压在字数上限内');
	assert.ok(got.some((l) => /Release 页面/.test(l)), '截断了要指路到 Release');
	// 切点离句末够近就切在句末，不停在半句话上（20 字切不到，30 字能切到第一个句号后）
	assert.match(cleanNotes(oneLine, 30)[0], /。$/, '能在句末切就切在句末');
	// 没被截断时不该冒出「后面还有」
	assert.ok(!cleanNotes('短说明。', 100).some((l) => /Release 页面/.test(l)), '没截断就不用指路');
}
// CHANGELOG 里那一段（规则跟 release.yml 的 awk 一样）
const cl = [
	'（暂无）',
	'',
	'- v0.15.9：删除整个人物卡——',
	'  - **#68 删除人物卡**：person 行软删除',
	'    - 更细的一行',
	'',
	'- v0.15.8：设置页重排',
	''].join('\n');
const sec = changelogSection(cl, '0.15.9');
assert.match(sec, /^- v0\.15\.9：删除整个人物卡$/m);
assert.match(sec, /#68 删除人物卡/);
assert.match(sec, /更细的一行/);
assert.doesNotMatch(sec, /0\.15\.8/);
assert.equal(changelogSection(cl, '0.15.99'), '');
assert.equal(changelogSection('', '0.15.9'), '');

const text = formatAnnouncement({ version: '0.15.10', notes: '- 群管理上线' });
assert.match(text, /dsh-fish-soul v0\.15\.10/);
assert.match(text, /· 群管理上线/);
assert.match(text, /releases\/tag\/v0\.15\.10/);
assert.match(formatAnnouncement({ version: '0.1.0', notes: '' }), /没写更新说明/);
assert.equal(describeRequest({ userId: '123', nick: '小明', comment: '求进群' }), '小明（123）：求进群');
assert.equal(describeRequest({ userId: '123', nick: '', comment: '' }), '123');

// ── 发版公告 ──
const sent = [];
const logs = [];
let npmVersion = '0.15.9';
let releaseBody = '- v0.15.9：上一版';
let rawChangelog = '';
const fetchImpl = async (url) => {
	const u = String(url);
	if (u.includes('registry.npmjs.org')) return { ok: true, status: 200, json: async () => ({ version: npmVersion }) };
	if (u.includes('raw.githubusercontent.com')) return { ok: true, status: 200, text: async () => rawChangelog };
	if (u.includes('api.github.com')) return { ok: true, status: 200, json: async () => ({ body: releaseBody }) };
	throw new Error('unexpected ' + u);
};
const mk = (over = {}) => new GroupAdmin({
	db,
	getConfig: () => ({ enabled: true, groupId: '1125962189', ...over }),
	log: (l, m) => logs.push([l, m]),
	call: async () => null,
	sendGroup: async (gid, t) => { sent.push([gid, t]); },
	fetchImpl,
	now: () => 1000,
	current: '0.15.8'
});

let admin = mk();
// 第一次见到的版本就播一次（发版完立刻重启也不漏）
assert.equal(await admin.checkRelease(), '0.15.9');
assert.equal(sent.length, 1);
assert.equal(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_ANNOUNCED).value), '0.15.9');

// 没新版本 → 不重复发
assert.equal(await admin.checkRelease(), null);
assert.equal(sent.length, 1);

// 出了新版本 → 公告一次
npmVersion = '0.15.10';
releaseBody = '- v0.15.10：群管理上线\n  - **入群申请**：自动同意';
assert.equal(await admin.checkRelease(), '0.15.10');
assert.equal(sent.length, 2);
assert.equal(sent[1][0], '1125962189');
assert.match(sent[1][1], /v0\.15\.10/);
assert.match(sent[1][1], /群管理上线/);
assert.match(sent[1][1], /入群申请/);

// 同一版本不重复发
assert.equal(await admin.checkRelease(), null);
assert.equal(sent.length, 2);

// 更新说明优先取仓库里那个 tag 的 CHANGELOG（GitHub API 常年限流，raw 才稳）
npmVersion = '0.15.11';
rawChangelog = '- v0.15.11：从 CHANGELOG 来的说明——\n  - 群管理上线\n\n- v0.15.10：上一版\n';
assert.equal(await admin.checkRelease(), '0.15.11');
assert.equal(sent.length, 3);
assert.match(sent[2][1], /从 CHANGELOG 来的说明/);
assert.match(sent[2][1], /群管理上线/);
assert.doesNotMatch(sent[2][1], /上一版/);

// npm 上的版本比本地还老（本地是没发的开发版）→ 不是新闻
npmVersion = '0.15.10';
admin = mk();
admin.current = '0.15.20';
assert.equal(await admin.checkRelease(), null);
assert.equal(sent.length, 3);

// 公告关了 → 不发
npmVersion = '0.15.12';
admin = mk({ announce: false });
assert.equal(await admin.checkRelease(), null);
assert.equal(sent.length, 3);

// 没开群管理 → 不联网也不发
admin = mk({ enabled: false });
admin.fetchImpl = async () => { throw new Error('不该联网'); };
assert.equal(await admin.checkRelease(), null);
assert.equal(sent.length, 3);

// ── 入群申请 ──
const calls = [];
const notifies = [];
const reqAdmin = (over = {}) => new GroupAdmin({
	db,
	getConfig: () => ({ enabled: true, groupId: '1125962189', ...over }),
	log: () => {},
	call: async (action, params) => { calls.push([action, params]); return null; },
	sendGroup: async () => {},
	notifyMaster: (t) => notifies.push(t),
	now: () => 2000
});

const ev = { post_type: 'request', request_type: 'group', sub_type: 'add', group_id: 1125962189, user_id: '10001', comment: '求进群', flag: 'FLAG-A' };

admin = reqAdmin();
// 不是 request 事件 → 不管
assert.equal(await admin.handleRequestEvent({ post_type: 'message' }), null);
// 别的群 → 不管
assert.equal(await admin.handleRequestEvent({ ...ev, group_id: 999 }), null);
// 自动同意
const r = await admin.handleRequestEvent(ev);
assert.equal(r.approved, true);
assert.equal(calls.length, 1);
assert.equal(calls[0][0], 'set_group_add_request');
assert.equal(calls[0][1].flag, 'FLAG-A');
assert.equal(calls[0][1].sub_type, 'add');
assert.equal(calls[0][1].approve, true);
assert.equal(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_MEMBERS).value).length, 1);
assert.match(notifies.at(-1), /已同意入群/);

// 自动同意关掉 → 记下来等主人拍板
calls.length = 0; notifies.length = 0;
admin = reqAdmin({ autoApprove: false });
const r2 = await admin.handleRequestEvent(ev);
assert.equal(r2.approved, false);
assert.equal(calls.length, 0);
assert.equal(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_PENDING).value).length, 1);
assert.match(notifies.at(-1), /\/鱼 同意/);
// 主人说同意 → 处理掉
const reply = await admin.decide(true);
assert.match(reply, /已同意/);
assert.equal(calls.length, 1);
assert.equal(calls[0][1].approve, true);
assert.equal(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_PENDING).value).length, 0);
// 没有待处理的 → 说清楚
assert.match(await admin.decide(true), /没有待处理/);

// 拒绝
calls.length = 0;
admin = reqAdmin({ autoApprove: false });
await admin.handleRequestEvent(ev);
assert.match(await admin.decide(false), /已拒绝/);
assert.equal(calls[0][1].approve, false);

// ── 兜底轮询（有些实现不推 request 事件）──
calls.length = 0;
admin = reqAdmin();
admin.call = async (action, params) => {
	calls.push([action, params]);
	if (action === 'get_group_system_msg') {
		return [{ group_id: 1125962189, request_id: 7, requester_uin: 20002, requester_nick: '路人', message: '带我走', checked: false, flag: 'FLAG-B', inviter_uin: 0 }];
	}
	return null;
};
const handled = await admin.pollRequests();
assert.equal(handled.length, 1);
assert.equal(calls[0][0], 'get_group_system_msg');
assert.equal(calls[0][1].only_pending, true);
assert.equal(calls[1][0], 'set_group_add_request');
assert.equal(calls[1][1].flag, 'FLAG-B');
assert.equal(calls[1][1].approve, true);
// 同一个 flag 不重复处理
await admin.pollRequests();
assert.equal(calls.filter((c) => c[0] === 'set_group_add_request').length, 1);

// ── 接线断言（改代码忘了接上，测试要红）──
const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
assert.match(indexSrc, /import \{ GroupAdmin \} from '\.\/qq-group-admin\.js'/, 'index.js 要引入 GroupAdmin');
assert.match(indexSrc, /new GroupAdmin\(\{/, 'index.js 要建 GroupAdmin');
assert.match(indexSrc, /post_type === 'request'/, 'request 事件要交给群管理');
assert.match(indexSrc, /groupAdmin\s*=\s*new GroupAdmin/, '群管理实例要接上');
const gatewaySrc = readFileSync(new URL('../lib/gateway.js', import.meta.url), 'utf8');
assert.match(gatewaySrc, /groupAdmin = null/, '网关要接 groupAdmin');
assert.match(gatewaySrc, /同意\|通过\|允许\|拒绝/, '主人指令要能同意 / 拒绝入群');
const routesSrc = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8');
assert.match(routesSrc, /groupAdmin: normalizeConfig\(q\.groupAdmin\)/, '状态路由要带 groupAdmin');
assert.match(routesSrc, /groupAdmin\s*\n\s*\};/, '保存 QQ 配置时不能把 groupAdmin 冲掉');
const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(clientSrc, /groupAdmin: \{ enabled:/, '设置页保存时要带上 groupAdmin');
assert.match(clientSrc, /群管理/, '设置页要有群管理开关');

console.log('qq-group-admin: 全部断言通过');
