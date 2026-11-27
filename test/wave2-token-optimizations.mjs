// Wave 2 优化回归保护：allowedTools 过滤、水聊门控、knownText 上限、Dream 水位排除 episode、
// 入站图缩放、vision maxTokens 与跳过重复 hostDefault 回退、视频抽帧分辨率/needImages、补标签早退。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-wave2-');
process.env.DSH_HOME = home;

const { openDatabase, setKv } = await import('../lib/db.js');
const { ChatGateway, RELAY_TOOL, RELAY_FRIEND_TOOL, DOUYIN_VIDEO_TOOL, SCHEDULED_TASK_TOOLS, WEB_TOOLS, OWN_WEB_TOOL } = await import('../lib/gateway.js');
const { ChatJournal, ChatDigester, insertMemory, isTrivialChatBatch } = await import('../lib/soul-memory.js');
const { LifeEngine } = await import('../lib/life.js');
const { shrinkInboundImage } = await import('../lib/imageconv.js');
const { createStickerVision } = await import('../lib/sticker-vision.js');
const { LlmRouter } = await import('../lib/llm.js');
const { buildFfmpegArgs } = await import('../lib/video-frames.js');
const { BiliBrowser } = await import('../lib/browse.js');
const { DouyinBrowser } = await import('../lib/douyin-browse.js');
const { StickerBox } = await import('../lib/stickers.js');

const db = openDatabase();
const ok = (m) => console.log('✓', m);

try {
	// ── 1. allowedTools：按权限与开关过滤死工具 schema ──
	{
		let cfg = { masterQqUin: '10001', douyin: { enabled: false }, relay: { enabled: false }, tools: { web: { enabled: false, provider: 'host' } } };
		const gw = Object.assign(Object.create(ChatGateway.prototype), {
			ctx: { tools: {} },
			getConfig: () => cfg,
			voiceGuardReady: false
		});

		const guest = gw.allowedTools(null, 'private:99999');
		const group = gw.allowedTools(null, 'group:88888');
		for (const list of [guest, group]) {
			assert.equal(list.includes(RELAY_TOOL), false, '非主人/群聊不暴露 send_elsewhere');
			assert.equal(list.includes(DOUYIN_VIDEO_TOOL), false, '非主人/群聊不暴露 make_douyin_video');
			for (const t of SCHEDULED_TASK_TOOLS) assert.equal(list.includes(t), false, `非主人/群聊不暴露 ${t}`);
			assert.equal(list.includes(RELAY_FRIEND_TOOL), false, 'relay 关闭时不暴露 relay_to_friend');
			for (const t of WEB_TOOLS) assert.equal(list.includes(t), false, `web 关闭时不暴露 ${t}`);
			assert.equal(list.includes(OWN_WEB_TOOL), false, 'web 关闭时不暴露 fish_search');
		}

		const masterOff = gw.allowedTools(null, 'private:10001');
		assert.ok(masterOff.includes(RELAY_TOOL));
		for (const t of SCHEDULED_TASK_TOOLS) assert.ok(masterOff.includes(t));
		assert.equal(masterOff.includes(DOUYIN_VIDEO_TOOL), false, 'douyin 未开时不暴露 make_douyin_video');
		assert.equal(masterOff.includes(RELAY_FRIEND_TOOL), false, 'relay 未开时不暴露 relay_to_friend');
		for (const t of [...WEB_TOOLS, OWN_WEB_TOOL]) assert.equal(masterOff.includes(t), false);

		cfg = { masterQqUin: '10001', douyin: { enabled: true, video: { enabled: true } }, relay: { enabled: true }, tools: { web: { enabled: true, provider: 'host' } } };
		const masterHostWeb = gw.allowedTools(null, 'private:10001');
		assert.ok(masterHostWeb.includes(DOUYIN_VIDEO_TOOL));
		assert.ok(masterHostWeb.includes(RELAY_FRIEND_TOOL));
		for (const t of WEB_TOOLS) assert.ok(masterHostWeb.includes(t));
		assert.equal(masterHostWeb.includes(OWN_WEB_TOOL), false, 'provider=host 时不暴露 fish_search');

		cfg.tools.web.provider = 'tavily';
		const masterOwnWeb = gw.allowedTools(null, 'private:10001');
		assert.ok(masterOwnWeb.includes(OWN_WEB_TOOL), 'provider=tavily 时暴露 fish_search');
		for (const t of WEB_TOOLS) assert.equal(masterOwnWeb.includes(t), false, 'provider=tavily 时不暴露宿主 web 工具');
		ok('allowedTools：按主人身份与功能开关过滤不可用工具');
	}

	// ── 2. ChatDigester：水聊门控 + knownText 2500 字符上限 ──
	{
		for (const text of ['早', '哈哈哈', '【表情：大笑】', '【戳了戳你】', 'ok']) {
			assert.equal(isTrivialChatBatch([{ who: '阿一', self: false, text }]), true, `「${text}」应判为水聊`);
		}
		assert.equal(isTrivialChatBatch([{ who: '阿一', self: false, text: '早' }, { who: '鱼', self: true, text: '早安' }]), true, '双方简短寒暄仍判为水聊');
		assert.equal(isTrivialChatBatch([{ who: '鱼', self: true, text: '我去煮面了', proactive: true }, { who: '主人', self: false, text: '在干嘛' }]), false, '包含有实质内容的 self 轮次不能跳过');
		for (const text of ['下周要去体检', '我今天面试完了']) {
			assert.equal(isTrivialChatBatch([{ who: '阿一', self: false, text }]), false, `「${text}」有实质内容不能跳过`);
		}

		let llmCalls = 0;
		const prompts = [];
		const journal = new ChatJournal({ keepRecent: 50 });
		const longMemories = Array.from({ length: 30 }, (_, i) => ({
			id: i + 1, owner_id: 'user:p1', updated_at: Date.now(), created_at: Date.now(),
			content: `记忆条目${i}：` + '甲'.repeat(280)
		}));
		const digester = new ChatDigester({
			db, clock: { now: () => Date.now() }, journal, worker: null,
			getConfig: () => ({ enabled: true }),
			callLlm: async (p) => { llmCalls++; prompts.push(p); return '{"memories":[]}'; },
			related: () => longMemories,
			findOwnerByName: () => null,
			personaName: () => '鱼',
			titleOf: (c) => c,
			log: () => {},
			note: () => {}
		});

		for (const text of ['早', '哈哈哈', '【表情：大笑】', '【戳了戳你】']) {
			journal.add('private:t1', { who: '阿一', ownerId: 'user:p1', text });
			const res = await digester.digest('private:t1');
			assert.deepEqual(res, { added: 0, skippedTrivial: true }, `水聊「${text}」直接跳过`);
		}
		assert.equal(llmCalls, 0, '水聊批次零 LLM 调用');

		journal.add('private:t1', { who: '阿一', ownerId: 'user:p1', text: '下周要去体检' });
		await digester.digest('private:t1');
		assert.equal(llmCalls, 1, '实质消息正常调用 LLM');
		const knownSection = prompts[0].split('已有记忆：\n')[1].split('\n聊天：\n')[0];
		assert.ok(knownSection.length <= 2550, `knownText 必须受 2500 字上限约束（实际 ${knownSection.length}）`);
		ok('ChatDigester：跳过水聊寒暄且 knownText 控制在 2500 字内');
	}

	// ── 3. LifeEngine.maybeDream：纯 episode 不触发 Dream 水位，fact 触发 ──
	{
		const nowReal = 10_000_000;
		const nowVirtual = Date.parse('2026-11-20T12:00:00Z');
		let dreamCalls = 0;
		const engine = new LifeEngine({
			db, clock: { now: () => nowVirtual }, realNow: () => nowReal, getConfig: () => ({}),
			deliver: async () => true,
			callLlm: async () => { dreamCalls++; return '{"missedPending":[],"suggestedRelationStage":null,"outdated":[],"corrected":[]}'; }
		});
		const owner = 'user:ep_only';
		setKv(db, `dream.watermark.${owner}`, 0);
		engine.lastInteractionVirtualMs.set(owner, nowVirtual - 4 * 3600_000);
		insertMemory(db, null, { ownerId: owner, channel: 'qq-private', channelId: 'private:ep', kind: 'episode', content: '随便打了声招呼' }, nowVirtual - 4 * 3600_000);
		await engine.maybeDream();
		assert.equal(dreamCalls, 0, '仅有新 episode 时不应触发 Dream');

		insertMemory(db, null, { ownerId: owner, channel: 'qq-private', channelId: 'private:ep', kind: 'fact', content: '养了一只萨摩耶' }, nowVirtual - 4 * 3600_000);
		await engine.maybeDream();
		assert.equal(dreamCalls, 1, '新增 fact 记忆后应正常触发 Dream');
		ok('LifeEngine.maybeDream：水位忽略 episode 防止空转');
	}

	// ── 4. shrinkInboundImage + createStickerVision + LlmRouter vision 不回退 hostDefault ──
	{
		const smallPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
		const s1 = await shrinkInboundImage(smallPng, 'image/png');
		assert.equal(s1.bytes, smallPng);
		assert.equal(s1.mediaType, 'image/png');

		const bigGif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(600 * 1024)]);
		const s2 = await shrinkInboundImage(bigGif, 'image/gif');
		assert.equal(s2.bytes, bigGif);
		assert.equal(s2.mediaType, 'image/gif');

		const bigPng = Buffer.alloc(700 * 1024, 1);
		const ops = [];
		const fakeSharp = (buf) => ({
			rotate() { ops.push(['rotate', buf.length]); return this; },
			resize(o) { ops.push(['resize', o]); return this; },
			jpeg(o) { ops.push(['jpeg', o]); return this; },
			async toBuffer() { return Buffer.alloc(120 * 1024, 2); }
		});
		const s3 = await shrinkInboundImage(bigPng, 'image/png', { sharpOverride: fakeSharp });
		assert.equal(s3.mediaType, 'image/jpeg');
		assert.equal(s3.bytes.length, 120 * 1024);
		assert.deepEqual(ops[1], ['resize', { width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }]);
		assert.deepEqual(ops[2], ['jpeg', { quality: 80 }]);

		const routerCalls = [];
		const fakeRouter = {
			getConfig: () => ({ models: { vision: { provider: 'pv', model: 'vl' } } }),
			async call(prompt, opts) { routerCalls.push({ prompt, opts }); return '一只猫'; }
		};
		await createStickerVision(fakeRouter, { feature: 'vision', maxTokens: 400 })('desc', [{ data: 'AA==', mediaType: 'image/png' }]);
		await createStickerVision(fakeRouter)('tag', [{ data: 'AA==', mediaType: 'image/png' }]);
		await createStickerVision({ getConfig: () => ({}), async call(p, o) { routerCalls.push({ prompt: p, opts: o }); return 'tag'; } })('tag2', []);
		assert.equal(routerCalls[0].opts.feature, 'vision');
		assert.equal(routerCalls[0].opts.maxTokens, 400);
		assert.equal(routerCalls[1].opts.feature, 'vision', '配了 models.vision 时默认也优先走 vision');
		assert.equal(routerCalls[1].opts.maxTokens, 60);
		assert.equal(routerCalls[2].opts.feature, 'other', '未配 models.vision 时回落到 other');

		// LlmRouter：feature='vision' + needImages=true 遇到空回复时不回退 hostDefault（只调 1 次）
		const streamTargets = [];
		const router = new LlmRouter({
			db,
			getConfig: () => ({ models: { vision: { provider: 'pv', model: 'vl' } } }),
			log: () => {},
			ctx: {
				get: (name) => {
					if (name === 'attachments') return { admitPromptContent: async (parts) => parts };
					if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'ph', model: 'main' }) };
					if (name === 'llm') return {
						listProviders: () => [{ id: 'pv', models: [{ id: 'vl' }] }, { id: 'ph', models: [{ id: 'main' }] }],
						async *stream({ model }) {
							streamTargets.push(model);
							yield { type: 'finish', reason: { kind: 'stop' } };
						}
					};
					return undefined;
				}
			}
		});
		const vOut = await router.call('看图', { feature: 'vision', maxTokens: 400, images: [{ data: 'AA==', mediaType: 'image/png' }], needImages: true });
		assert.equal(vOut, null);
		assert.ok(streamTargets.length >= 1 && streamTargets.every((m) => m === 'vl'), `feature=vision 且 needImages=true 只能尝试 vl，实际：${JSON.stringify(streamTargets)}`);
		assert.equal(streamTargets.includes('main'), false, 'feature=vision 且 needImages=true 不得回退主模型再烧一遍图');
		ok('shrinkInboundImage / createStickerVision / LlmRouter vision 防重复计费');
	}

	// ── 5. 视频抽帧尺寸上限 + needImages:true + 补标签遇限额/连败早退 ──
	{
		const args = buildFfmpegArgs({ url: 'https://example.com/v.mp4', out: '/tmp/o.jpg' });
		assert.ok(args.includes('fps=1/6,scale=320:320:force_original_aspect_ratio=decrease,tile=3x3'));

		const biliCalls = [];
		const bili = new BiliBrowser({
			db, clock: { now: () => Date.now() }, client: {}, getConfig: () => ({}),
			callLlm: async (_p, o) => { biliCalls.push(o); return '蓝衣服'; },
			persona: () => ({ name: '鱼', brief: '' })
		});
		await bili.visualNote({ title: '测试' }, { data: 'AA==', mediaType: 'image/jpeg' });
		assert.equal(biliCalls[0].needImages, true, 'BiliBrowser.visualNote 必须传 needImages: true');

		const dyCalls = [];
		const dy = new DouyinBrowser({
			db, clock: { now: () => Date.now() }, host: { running: false, loggedIn: false },
			getConfig: () => ({ browse: { frames: true, framesPerDay: 5 } }),
			callLlm: async (_p, o) => { dyCalls.push(o); return '街景'; },
			persona: () => ({ name: '鱼', brief: '' }),
			frames: async () => ({ data: 'AA==', mediaType: 'image/jpeg' })
		});
		await dy.frameForWatch({ desc: '抖音测试', video: { duration: 10_000, play_addr: { url_list: ['https://cdn/1.mp4'] } } }, 'aweme1');
		assert.equal(dyCalls[0].needImages, true, 'DouyinBrowser.frameForWatch 必须传 needImages: true');

		const ws = join(home, 'ws-stickers');
		mkdirSync(join(ws, '_stickers'), { recursive: true });
		const items = Array.from({ length: 10 }, (_, i) => {
			const file = `s${i}.png`;
			writeFileSync(join(ws, '_stickers', file), Buffer.from([0x89, 0x50, 0x4e, 0x47, i + 1]));
			return { file, hash: `h${i}`, workspacePath: ws, tags: [], tagsBy: '', at: i + 1 };
		});
		setKv(db, 'stickers.collected', items);
		const box = new StickerBox({ db, getConfig: () => ({}), log: () => {} });

		for (const code of ['budget_exceeded', 'cooldown', 'model_unavailable']) {
			let count = 0;
			await box.backfillTags({
				workspacePath: ws,
				vision: async (_p, _imgs, { onFailure }) => { count++; onFailure?.(code); return null; }
			});
			assert.equal(count, 1, `遇到 ${code} 必须立刻停下（不应连发 10 次）`);
		}

		let streakCalls = 0;
		await box.backfillTags({
			workspacePath: ws,
			vision: async (_p, _imgs, { onFailure }) => { streakCalls++; onFailure?.('model_error'); return null; }
		});
		assert.equal(streakCalls, 3, '连续 3 次 model_error 必须早退');
		ok('视频抽帧参数/needImages 与 StickerBox 补标签早退验证通过');
	}
} finally {
	db.close();
}

console.log('✓ wave2-token-optimizations：5 组断言全过');
