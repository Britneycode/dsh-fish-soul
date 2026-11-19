/**
 * 说法（学到的梗 / 说话方式）的「全局」语义。
 *
 * 用户的诉求：学到的按聊天分（群的梗不该串到别的群），但**自己手动加的要是全局**。
 *
 * 查下来三处缺口：
 *   ① 全局桶（`slang.global`）本来存在、也真的对所有 QQ 群 / 私聊生效，
 *      但 `state()` 只在它已有数据时才返回 ⇒ 从没导入过麦麦的人面板上根本没有这张卡，
 *      「手动加一条全局说法」没有入口。
 *   ② 全局词拼在这个聊天自己的梗**后面**，而上下文只取前 10 个 ⇒
 *      本群学满 10 个梗之后，全局词完全进不了上下文，「全局通用」名不副实。
 *   ③ 关掉「私聊也学」之后，私聊里连**手动加的全局说法**都不出现了 ——
 *      学习开关连坐了主人手动配的东西。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SlangLearner, GLOBAL_ID } from '../lib/slang.js';

function makeLearner(over = {}) {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
	const cfg = { enabled: true, expressions: true, privateChats: true, minLines: 10, intervalHours: 0, ...over };
	return new SlangLearner({ db, callLlm: async () => null, getConfig: () => cfg, personaName: () => '小鱼', titleOf: (c) => c, log: () => {} });
}

const hasTerm = (lines, term) => lines.some((l) => l.includes(term));

test('全新库：面板上就有全局卡（否则手动加不进全局）', () => {
	const L = makeLearner();
	const state = L.state();
	const global = state.find((g) => g.channelId === GLOBAL_ID);
	assert.ok(global, '没导入过麦麦也要有全局卡，否则没有手动添加的入口');
	assert.equal(global.kind, 'global');
	assert.deepEqual(global.terms, []);
});

test('手动往全局加一个梗：所有群和私聊都能用', () => {
	const L = makeLearner();
	L.edit(GLOBAL_ID, { add: { term: '绝绝子', meaning: '太绝了' } });
	assert.ok(hasTerm(L.contextLines('group:A', ''), '绝绝子'), '群要能用');
	assert.ok(hasTerm(L.contextLines('private:B', ''), '绝绝子'), '私聊也要能用');
});

test('学到的梗仍按聊天分（全局不等于把所有东西混在一起）', () => {
	const L = makeLearner();
	L.edit('group:A', { add: { term: '本群梗', meaning: '只有 A 懂' } });
	assert.ok(hasTerm(L.contextLines('group:A', ''), '本群梗'));
	assert.equal(hasTerm(L.contextLines('group:B', ''), '本群梗'), false, '别的群不该看到');
});

test('本群学满 10 个梗之后，全局词仍要占位（不能被 slice 挤掉）', () => {
	const L = makeLearner();
	L.edit(GLOBAL_ID, { add: { term: '全局词', meaning: '所有聊天都能用' } });
	for (let i = 1; i <= 12; i++) L.edit('group:A', { add: { term: `本群梗${i}`, meaning: `第${i}个` } });
	const lines = L.contextLines('group:A', '');
	assert.ok(hasTerm(lines, '全局词'), `本群学满之后全局词必须还在，实际：${lines.join(' | ')}`);
});

test('这轮提到的词优先（含全局词）', () => {
	const L = makeLearner();
	L.edit(GLOBAL_ID, { add: { term: '绝绝子', meaning: '太绝了' } });
	for (let i = 1; i <= 12; i++) L.edit('group:A', { add: { term: `本群梗${i}`, meaning: `第${i}个` } });
	assert.ok(hasTerm(L.contextLines('group:A', '今天真的绝绝子'), '绝绝子'), '这轮说了这个词就要先给她看');
});

test('关掉「私聊也学」：私聊里手动加的全局说法照样能用', () => {
	const L = makeLearner({ privateChats: false });
	L.edit(GLOBAL_ID, { add: { term: '全局词', meaning: '所有聊天都能用' } });
	assert.ok(hasTerm(L.contextLines('private:C', ''), '全局词'), '学习开关不该连坐手动配的全局说法');
});

test('关掉「私聊也学」：那个私聊自己学到的确实不给了（开关仍然生效）', () => {
	const L = makeLearner({ privateChats: false });
	L.edit('private:C', { add: { term: '只在私聊里', meaning: '私聊的梗' } });
	assert.equal(hasTerm(L.contextLines('private:C', ''), '只在私聊里'), false, '关了就不该再带私聊自己学的');
});

test('总开关关掉：连全局也不给（这是「学说法」整个功能的总闸）', () => {
	const L = makeLearner({ enabled: false });
	L.edit(GLOBAL_ID, { add: { term: '全局词', meaning: '所有聊天都能用' } });
	assert.deepEqual(L.contextLines('group:A', ''), []);
});

test('同名梗以这个聊天自己的为准（全局不覆盖本地）', () => {
	const L = makeLearner();
	L.edit(GLOBAL_ID, { add: { term: '开黑', meaning: '全局说的意思' } });
	L.edit('group:A', { add: { term: '开黑', meaning: '这个群说的意思' } });
	const line = L.contextLines('group:A', '').find((l) => l.includes('开黑'));
	assert.match(line, /这个群说的意思/);
	assert.doesNotMatch(line, /全局说的意思/);
});

console.log('slang-global: all assertions passed');

// ── 面板端到端：走真实 /slang/state + /slang/edit 路由 ──
// 只测纯函数证明不了「面板上真的有这个入口、加进去刷新还在」。
{
	const { tmpHome } = await import('./_tmp.mjs');
	process.env.DSH_HOME = tmpHome('dsh-slang-global-');
	const { openDatabase } = await import('../lib/db.js');
	const { handleV07Route } = await import('../lib/routes-v07.js');
	const { SlangLearner } = await import('../lib/slang.js');

	const db = openDatabase();
	const slang = new SlangLearner({ db, callLlm: async () => null, getConfig: () => ({ enabled: true, expressions: true, privateChats: true, minLines: 10, intervalHours: 6 }), personaName: () => '小鱼', titleOf: (c) => c, log: () => {} });
	const deps = { db, getConfig: () => ({}), saveConfig: () => {}, slang, gateway: { workspacePath: () => '', titleOf: (c) => c } };
	const call = async (method, path, body) => {
		let sent = null;
		const handled = await handleV07Route({
			method, path, url: new URL('http://localhost' + path), req: {}, res: {},
			send: (status, obj) => { sent = { status, ...obj }; },
			readBody: async () => JSON.stringify(body ?? {}),
			sameOrigin: () => true, deps
		});
		return handled ? sent : null;
	};

	const st = await call('GET', '/slang/state');
	assert.ok(st?.groups?.some((g) => g.channelId === GLOBAL_ID), '面板要能看到全局卡（否则没有手动添加的入口）');

	const add = await call('POST', '/slang/edit', { channelId: GLOBAL_ID, add: { term: '绝绝子', meaning: '太绝了' } });
	assert.equal(add?.ok, true);
	const again = await call('GET', '/slang/state');
	assert.ok(again?.groups?.find((g) => g.channelId === GLOBAL_ID)?.terms?.some((t) => t.term === '绝绝子'), '加进去的要能读回来');

	const way = await call('POST', '/slang/edit', { channelId: GLOBAL_ID, addExpression: { situation: '被夸了', style: '先说哪有再偷偷高兴' } });
	assert.equal(way?.ok, true);
	assert.equal(way.group?.expressions?.length, 1, '全局的说话方式也要能加');

	const rm = await call('POST', '/slang/edit', { channelId: GLOBAL_ID, remove: '绝绝子' });
	assert.equal(rm?.ok, true);
	assert.deepEqual(rm.group?.terms?.map((t) => t.term), [], '要能删');
	console.log('✓ 面板端到端：全局卡可见、能加能删、刷新读得回来');
}
