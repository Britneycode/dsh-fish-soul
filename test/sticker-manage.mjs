// 表情包面板的目录管理：主人直接放进 _stickers 的图、改名、删；导入不占每天收藏的额度。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';
import { getKv } from '../lib/db.js';
import { StickerBox, stickerConfig } from '../lib/stickers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
const PNG2 = Buffer.concat([PNG, Buffer.from([0])]);

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

const home = tmpHome('fs-sticker-');
const ws = join(home, 'ws');
mkdirSync(join(ws, '_stickers'), { recursive: true });
const box = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 10 }) });

// 假 embedder：按**字**计数（不是子串）。
// 用子串会踩坑：「想卖个萌」里「卖萌」不是连续子串（想-卖-个-萌），查询向量会退化成全 0，
// 所有表情同分，排序就成了池子顺序。按字计数才能让它们通过「卖」「萌」共享维度。
// 这测的是「挑对了哪张」；真模型的排序在本地单独验过（top1 5/6、top3 6/6）。
const CHARS = ['害', '羞', '卖', '萌', '得', '意', '同', '可', '以', '猫', '爱', '被', '捏', '脸', '个', '想'];
const fake = {
	embed: async (texts) => ({
		vectors: texts.map((t) => {
			const s = String(t);
			return CHARS.map((c) => (s.includes(c) ? 1 : 0));
		})
	})
};

// 1. 主人直接放进 _stickers 的图：面板里能看见，但不该写 kv
writeFileSync(join(ws, '_stickers', '主人放的.png'), PNG);
{
	const items = box.list(ws);
	const orphan = items.find((x) => x.file === '主人放的.png');
	assert.ok(orphan, '主人放进 _stickers 的图要出现在面板里');
	assert.equal(orphan.tracked, false, '它不是收藏记录');
	assert.equal(orphan.exists, true);
	assert.equal(orphan.from, '主人放的');
	assert.equal(orphan.workspacePath, ws);
	assert.ok(orphan.at > 0, '时间用文件的修改时间');
	assert.equal(getKv(db, 'stickers.collected', null), null, '看目录不写 kv');
}

// 2. 收藏记录也在清单里；文件没了标 exists=false
const imported = box.importImage({ bytes: PNG, mediaType: 'image/png', name: '狗头', workspacePath: ws, from: '主人' });
assert.equal(imported.ok, true, imported.reason);
{
	const hit = box.list(ws).find((x) => x.file === imported.file);
	assert.ok(hit, '收藏的也要在清单里');
	assert.equal(hit.tracked, true);
	assert.equal(hit.exists, true);
	assert.equal(box.list(ws).filter((x) => x.file === imported.file).length, 1, '同一个文件只出现一次');
}

// 3. 改名：收藏过的 → 文件改名，记录同步
{
	const r = box.rename(imported.file, '新名字', ws);
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.file, '新名字.png');
	assert.equal(existsSync(join(ws, '_stickers', '新名字.png')), true);
	assert.equal(existsSync(join(ws, '_stickers', imported.file)), false);
	assert.equal(box.collected()[0].file, '新名字.png', '收藏记录里的文件名要跟着改');
}

// 4. 改名：主人放的 → 只改文件，不写 kv
{
	const before = JSON.stringify(getKv(db, 'stickers.collected', []));
	const r = box.rename('主人放的.png', '换个名', ws);
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.file, '换个名.png');
	assert.equal(existsSync(join(ws, '_stickers', '换个名.png')), true);
	assert.equal(JSON.stringify(getKv(db, 'stickers.collected', [])), before, '主人放的改名不该动 kv');
}

// 5. 撞名：明确拒绝，不自动加序号
{
	const r = box.rename('换个名.png', '新名字', ws);
	assert.equal(r.ok, false);
	assert.match(r.reason, /同名/);
	assert.equal(existsSync(join(ws, '_stickers', '换个名.png')), true, '拒绝时原文件不动');
	assert.equal(existsSync(join(ws, '_stickers', '新名字2.png')), false, '不自动加序号');
}

// 6. 改成同一个名字：幂等
{
	const r = box.rename('换个名.png', '换个名', ws);
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.file, '换个名.png');
	assert.equal(existsSync(join(ws, '_stickers', '换个名.png')), true);
}

// 7. 文件不在 _stickers 里：拒绝
{
	assert.equal(box.rename('根本没有.png', 'x', ws).ok, false);
	assert.equal(box.rename('新名字.png', 'x', join(home, '别的工作区')).ok, false, '别的目录里的同名文件不算');
}

// 8. 删：主人放的也能删
{
	assert.equal(box.remove('换个名.png', ws), true);
	assert.equal(existsSync(join(ws, '_stickers', '换个名.png')), false);
	assert.equal(box.remove('换个名.png', ws), false, '删过就没了');
}

// 9. 删：文件已经没了，收藏记录也要删掉
{
	unlinkSync(join(ws, '_stickers', '新名字.png'));
	assert.equal(box.remove('新名字.png', ws), true);
	assert.equal(box.collected().length, 0);
	assert.equal(box.remove('新名字.png', ws), false);
}

// 10. 导入不占每天收藏的额度：perDay=0 也照样能导
{
	const box0 = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 0 }) });
	const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
	const before = getKv(db, `stickers.day.${day}`, 0);
	const r = box0.importImage({ bytes: PNG2, mediaType: 'image/png', name: '导入的', workspacePath: ws, from: '主人' });
	assert.equal(r.ok, true, r.reason);
	assert.equal(getKv(db, `stickers.day.${day}`, 0), before, '导入不占每天收藏的额度');
	// 但她自己收藏（聊天里存）是要占额度的：perDay=0 存不进来
	box0.remember('s1', { bytes: PNG2, mediaType: 'image/png', sticker: true });
	const blocked = box0.collect('s1', '要存的', ws, { from: '某人' });
	assert.equal(blocked.ok, false);
	assert.match(blocked.reason, /存够了/);
}

// 11. 按感觉挑：打向量 → 按标签相似度选 → 换成真文件名
//     用假 embedder（词表哈希），CI 不依赖外网；真模型的排序在本地验过（top3 6/6）
{
	const feelWs = join(tmpHome('fs-feel-'), 'ws');
	mkdirSync(join(feelWs, '_stickers'), { recursive: true });
	const boxF = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 10 }) });
	const lib = {
		'害羞.png': ['害羞', '被捏脸'],
		'卖萌.png': ['卖萌', '可爱'],
		'得意猫.png': ['得意', '猫'],
		'同意.png': ['同意', '可以可以']
	};
	const all = boxF.collected();
	for (const [file, tags] of Object.entries(lib)) {
		writeFileSync(join(feelWs, '_stickers', file), PNG);
		all.unshift({ file, hash: `h-${file}`, workspacePath: feelWs, from: '她', summary: '', tags, tagsBy: 'self', at: Date.now() });
	}
	db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('stickers.collected', JSON.stringify(all));

	// 假 embedder 见文件上方（按字计数）

	const n = await boxF.embedStickers(feelWs, fake, { model: 'fake-1' });
	assert.equal(n, 4, '四张都打上向量');
	assert.ok(boxF.collected().every((x) => x.workspacePath !== feelWs || x.vec), '向量真存进 kv');

	// 换模型后要重打（vecModel 对不上）
	assert.equal(await boxF.embedStickers(feelWs, fake, { model: 'fake-2' }), 4, '换模型重打');

	for (const [feel, want] of [['害羞', '害羞.png'], ['想卖个萌', '卖萌.png'], ['得意', '得意猫.png']]) {
		const r = await boxF.pickByFeel(feelWs, feel, fake, { model: 'fake-2' });
		assert.equal(r.ok, true, r.reason);
		assert.equal(r.file, want, `「${feel}」应挑到 ${want}，实际 ${r.file}`);
	}

	// 整段替换：`@感觉` 换成真文件名，不留 @
	const rr = await boxF.resolveFeelRefs('好呀 ![得意](_stickers/@得意)', feelWs, fake, { model: 'fake-2' });
	assert.match(rr.text, /!\[得意\]\(_stickers\/得意猫\.png\)/);
	assert.ok(!rr.text.includes('@'), '不漏 @ 进正文');

	// 降级：没 embedder / 空库 / 没标签，都明确失败不抛错
	assert.equal((await boxF.pickByFeel(feelWs, '得意', null)).ok, false, '没 embedder');
	assert.equal((await boxF.pickByFeel(feelWs, '', fake)).ok, false, '没说感觉');
	const emptyWs = join(tmpHome('fs-feel-empty-'), 'ws');
	assert.equal((await boxF.pickByFeel(emptyWs, '得意', fake)).ok, false, '库里没向量');
	// 没 embedder 时 `@感觉` 那段要被丢掉，不能原样漏进她的话
	const lost = await boxF.resolveFeelRefs('好 ![得意](_stickers/@得意)', feelWs, null);
	assert.ok(!lost.text.includes('@'), '没 embedder 时 @ 段丢掉');
	assert.equal(lost.resolved.length, 1);
	assert.equal(lost.resolved[0].file, null);
}

// 12. 接线：sendReply 里 `_stickers/@感觉` 那段真的被走到（不是死代码）
//     用 spy 替掉 resolveFeelRefs —— 单测解析容易，难的是「接线断了测试还全绿」
{
	const { ChatGateway } = await import('../lib/gateway.js');
	// ChatGateway 构造时要摸 outbox / chat_session 这些表，用 openDatabase 一次建全（别手抄 DDL）。
	// openDatabase 每次读 DSH_HOME，先指到临时目录，别写到真实数据目录去。
	const { openDatabase } = await import('../lib/db.js');
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = tmpHome('fs-feel-gatedb-');
	const gateDb = openDatabase();
	if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
	const gwWs = join(tmpHome('fs-feel-gw-'), 'ws');
	mkdirSync(join(gwWs, '_stickers'), { recursive: true });
	writeFileSync(join(gwWs, '_stickers', '得意猫.png'), PNG);
	const feelCalls = []; const imgSent = []; const textSent = [];
	const spyStickers = {
		list: () => [],
		collect: () => ({ ok: false }),
		resolveFeelRefs: async (text, ws, emb, opts) => {
			feelCalls.push({ text, ws, hasEmb: emb !== null, model: opts?.model });
			return { text: text.replace('_stickers/@得意', '_stickers/得意猫.png'), resolved: [{ feel: '得意', file: '得意猫.png' }] };
		}
	};
	const gw = new ChatGateway({
		ctx: { get: () => undefined, logger: { info() {}, warn() {}, error() {} }, effect: (f) => f(), tools: { get: () => ({}) } },
		db: gateDb, clock: { now: () => Date.now() },
		getConfig: () => ({ sessions: { workspacePath: gwWs }, bili: { enabled: true, masterUid: '555' }, stickers: {}, qq: {} }),
		log: () => {},
		channel: { connected: true, send: async () => '1' },
		bili: { send: async (_m, t) => { textSent.push(t); return '1'; }, sendImage: async (_m, img) => { imgSent.push(img.path); return '1'; } },
		soul: { personaName: () => '鱼', journalOut: () => {}, recallInfo: () => [] },
		stickers: spyStickers, voice: null,
		embedder: { embed: async () => null }, embeddingCfg: () => ({ model: 'fake-model' })
	});
	gw.random = () => 0.5;
	gw.bound.set('s-feel', { channel_id: 'bili:555', title: 'B站·某人', workspace_path: gwWs });
	gw.onSessionEvent({ id: 's-feel' }, { type: 'user/message', data: { source: { kind: 'fish-soul/bili', replyTo: null } } });
	gw.onSessionEvent({ id: 's-feel' }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好呀\n\n![得意](_stickers/@得意)' }] } } });
	gw.onSessionEvent({ id: 's-feel' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(feelCalls.length, 1, 'sendReply 里 resolveFeelRefs 要被调用（接线断了会变 0）');
	assert.equal(feelCalls[0].hasEmb, true, '要把 embedder 传进去');
	assert.equal(feelCalls[0].model, 'fake-model', '要用当前嵌入模型 id');
	assert.equal(imgSent.length, 1, '换出来的图要真的进发送队列');
	assert.match(imgSent[0], /得意猫\.png$/);
	assert.ok(!textSent.join('').includes('@'), '@ 不能漏进正文');
}

// 13. 生产路径要自己补向量：库里贴着标签但没打过向量的表情，出站挑之前要被打上。
//     （以前 embedStickers 只有测试调，生产没人调 → 「按感觉挑」的池子恒为空，整条路是死的）
{
	const autoWs = join(tmpHome('fs-feel-auto-'), 'ws');
	mkdirSync(join(autoWs, '_stickers'), { recursive: true });
	const boxA = new StickerBox({ db, getConfig: () => stickerConfig({ perDay: 10 }) });
	const all = boxA.collected();
	all.unshift({ file: '得意猫.png', hash: 'h-auto', workspacePath: autoWs, from: '她', summary: '', tags: ['得意', '猫'], tagsBy: 'self', at: Date.now() });
	db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('stickers.collected', JSON.stringify(all));
	assert.equal(boxA.collected().find((x) => x.file === '得意猫.png')?.vec, undefined, '前置：这条还没打过向量');

	// 出站那一步（resolveFeelRefs → pickByFeel）要顺带把向量补上
	const rr = await boxA.resolveFeelRefs('好呀 ![得意](_stickers/@得意)', autoWs, fake, { model: 'fake-1' });
	assert.match(rr.text, /!\[得意\]\(_stickers\/得意猫\.png\)/, `库里没向量就挑不出来，实际正文：${rr.text}`);
	const row = boxA.collected().find((x) => x.file === '得意猫.png');
	assert.ok(row?.vec, '向量要落进 kv（不能只在内存里挑完就算）');
	assert.equal(row.vecModel, 'fake-1', '要记下是哪个模型打的');
}

console.log('✓ 表情包面板：目录里的图看得见、改名、删；导入不占每天收藏的额度；按感觉挑表情（含 sendReply 接线）');
