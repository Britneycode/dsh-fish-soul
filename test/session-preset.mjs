// #73：宿主默认预设在 PTC 模式时，QQ 会话不能跟着用 PTC
// （PTC 里模型只能直接调 run_code，护栏不放行 → 记忆工具调不到、压缩也落地不了）。
// 所以 QQ 会话改用非 PTC 预设。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

process.env.DSH_HOME = tmpHome('dsh-preset-');
const { openDatabase } = await import('../lib/db.js');
const { ChatGateway } = await import('../lib/gateway.js');

const ok = (s) => console.log(`  ✓ ${s}`);
const db = openDatabase();

const PTC_DOC = `- id: tool-executor-ptc
  name: '@deepseek-ai/dsh-tool-executor-ptc'
`;
const NORMAL_DOC = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`;

/** 假宿主预设服务。 */
function fakePresets({ defaultId = 'standard', rows, docs, onMount } = {}) {
	const list = rows ?? [
		{ id: 'standard', name: 'Standard', order: 1 },
		{ id: 'ptc', name: 'PTC', order: 2 },
	];
	const documents = docs ?? { ptc: PTC_DOC, standard: NORMAL_DOC };
	return {
		async resolve(id) {
			const wanted = id ?? defaultId;
			if (!list.some((r) => r.id === wanted)) throw new Error(`Unknown agent preset: ${wanted}`);
			return { id: wanted };
		},
		async list() { return list; },
		async readDocument(id) {
			if (!(id in documents)) throw new Error(`Unknown agent preset: ${id}`);
			return documents[id];
		},
		async mount(_ctx, id) {
			onMount?.(id);
			return { id: id ?? defaultId };
		},
	};
}

const newGateway = (presets, cfg = {}) => {
	const mounted = [];
	const logs = [];
	const gw = new ChatGateway({
		ctx: { get: (n) => (n === 'agentPresets' ? presets : undefined) },
		db, clock: { now: () => Date.now() },
		getConfig: () => ({ masterQqUin: '10001', ...cfg }),
		log: (level, msg) => logs.push(`${level}:${msg}`),
		channel: { connected: true, selfId: '1000', send: async () => '1', groupName: async () => '群', getMessage: async () => null, isFriend: () => true },
		soul: { beginTurn: () => {}, nowLabel: () => '现在', resolvePerson: () => null, memorizeUnanswered: () => {}, availability: () => 'idle', personaName: () => '小鱼', recallInfo: () => [] },
	});
	gw.mounted = mounted;
	gw.logs = logs;
	return gw;
};

// ① 默认预设不是 PTC → 就用默认（跟以前一样）
{
	const gw = newGateway(fakePresets({ defaultId: 'standard' }));
	assert.equal(await gw.chatPresetId(), 'standard');
	assert.equal(await gw.isPtcPreset(gw.ctx.get('agentPresets'), 'standard'), false);
}
ok('默认不是 PTC：用默认预设');

// ② 默认预设是 PTC → 换成 standard（模型才能直接调记忆工具，压缩也不会带上 run_code）
{
	const mounted = [];
	const presets = fakePresets({ defaultId: 'ptc', onMount: (id) => mounted.push(id) });
	const gw = newGateway(presets);
	assert.equal(await gw.chatPresetId(), 'standard');
	await gw.setupAgent({ tools: { restrict: () => {} } }, 'private:10001');
	assert.deepEqual(mounted, ['standard'], 'PTC 默认 → 挂 standard');
	assert.equal(await gw.isPtcPreset(presets, 'ptc'), true, 'PTC 认得出来');
}
ok('默认是 PTC：QQ 会话改用 standard');

// ③ 自定义预设里带了 PTC 执行器（id 不叫 ptc）→ 一样认得出来
{
	const presets = fakePresets({
		defaultId: 'my-ptc',
		rows: [{ id: 'standard', order: 1 }, { id: 'my-ptc', order: 2 }],
		docs: { 'my-ptc': PTC_DOC, standard: NORMAL_DOC },
	});
	const gw = newGateway(presets);
	assert.equal(await gw.isPtcPreset(presets, 'my-ptc'), true, '看预设的插件清单，不只看 id');
	assert.equal(await gw.chatPresetId(), 'standard');
}
ok('自定义 PTC 预设：按插件清单认出来');

// ④ 宿主读不到预设清单 → 退回按 id 猜
{
	const presets = fakePresets({ defaultId: 'ptc' });
	delete presets.readDocument;
	const gw = newGateway(presets);
	assert.equal(await gw.isPtcPreset(presets, 'ptc'), true);
	assert.equal(await gw.isPtcPreset(presets, 'standard'), false);
	assert.equal(await gw.chatPresetId(), 'standard');
}
ok('读不到清单：按 id 兜底');

// ⑤ 只有 PTC 一个预设 → 没有替代，保持默认并喊一嗓子（别悄悄换成别的）
{
	const logs = [];
	const presets = fakePresets({ defaultId: 'ptc', rows: [{ id: 'ptc', order: 1 }], docs: { ptc: PTC_DOC } });
	const gw = newGateway(presets);
	assert.equal(await gw.chatPresetId(), 'ptc');
}
ok('只有 PTC：保持默认');

// ⑥ 挂预设失败 → 退回挂默认，别让会话建不起来
{
	const mounted = [];
	const presets = fakePresets({
		defaultId: 'ptc',
		onMount: (id) => {
			mounted.push(id);
			if (id === 'standard') throw new Error('挂不上');
		},
	});
	const gw = newGateway(presets);
	await gw.setupAgent({ tools: { restrict: () => {} } }, 'private:10001');
	assert.deepEqual(mounted, ['standard', undefined], 'standard 挂不上 → 退回挂默认');
}
ok('挂预设失败：退回默认预设');

// ⑦ 预设服务整个没有 → 照旧（宿主老版本没有 agentPresets）
{
	const gw = newGateway(undefined);
	assert.equal(await gw.chatPresetId(), undefined);
	await gw.setupAgent({ tools: { restrict: () => {} } }, 'private:10001');
}
ok('宿主没有预设服务：照旧');

console.log('session-preset ok');
