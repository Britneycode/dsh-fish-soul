/**
 * gateway-media.js —— 网关的图片 / 私信（B站、抖音）/ 视频介绍部分（从 gateway.js 拆出来，混入 ChatGateway.prototype）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fishSoulDir, resolveOrCreatePlatformPerson } from './db.js';
import { isIdentityKey } from './douyin-conversation.js';
import { findVideoRefs } from './browse.js';
import { findDouyinRefs } from './douyin-browse.js';
import { prepareImage } from './imageconv.js';
import { sanitizeName } from './channels/onebot.js';
import { mediaTypeOf, isInside, fetchImageBytes, splitChannelId, service } from './gateway-util.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INBOUND_IMAGES = 4;
const MAX_PARAGRAPHS = 5;
const MAX_DM_IMAGES = 2;
const DOUYIN_EMOJI_RE = /^\[([\u4e00-\u9fa5A-Za-z0-9]{1,8})\]$/;
const VOICE_TAG_RE = /^\s*\[语音\]\s*/;
const platformName = (channelId) => (String(channelId).startsWith('bili:') ? 'B站' : '抖音');

/** 共同校验 QQ 和私信出站图片；返回实际文件路径，失败关闭。 */
function safeLocalImagePath(p, workspacePath, log) {
	let raw = String(p ?? '').trim();
	if (raw === '' || /^https?:\/\//i.test(raw)) return null;
	try { if (raw.startsWith('file://')) raw = fileURLToPath(raw); } catch { return null; }
	const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspacePath, raw);
	const roots = [workspacePath, fishSoulDir()];
	if (!roots.some((root) => isInside(root, abs))) {
		log('warn', `[fish-soul] 拒绝发送工作区外的图片：${raw}`);
		return null;
	}
	if (!IMAGE_EXT.has(extname(abs).toLowerCase())) return null;
	try {
		const realRoots = roots.flatMap((root) => {
			try {
				const path = realpathSync.native(root);
				return statSync(path).isDirectory() ? [path] : [];
			} catch { return []; }
		});
		if (realRoots.length === 0) {
			log('warn', `[fish-soul] 图片允许目录不可用，拒绝发送：${raw}`);
			return null;
		}
		const real = realpathSync.native(abs);
		if (!realRoots.some((root) => isInside(root, real))) return null;
		const st = statSync(real);
		return st.isFile() && st.size <= MAX_IMAGE_BYTES ? real : null;
	} catch { return null; }
}

export const mediaMethods = {
	/**
	 * B站私信入口（BiliChannel 轮询到的每条新消息）。
	 * 回：自动回复打开 + 对方是主人 / 白名单 / 互关 + 不是 10 分钟前的旧消息；其余只记不回。
	 */
	async onBiliMessage(m) {
		if (this.stopped || this.bili === null) return;
		const cfg = this.biliConfig();
		if (!cfg.enabled || m.userId === '' || m.userId === this.bili.client.uid) return;
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return;
		const person = this.soul.resolveBiliPerson(m, { masterUid: cfg.masterUid, linkedQq: this.biliLinks().get(m.userId) ?? '' });
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;
		const paused = this.isPaused(m.channelId);
		// 只读阶段 / 旧消息不查关注关系（省一次接口调用）
		const trusted = cfg.autoReply && !stale && !paused && (m.userId === cfg.masterUid || cfg.allowList.includes(m.userId) ||
			(cfg.replyMutual && await this.bili.isMutual(m.userId)));
		const who = m.nickname || person?.display_name || m.userId;
		if (!trusted) {
			this.soul.memorizeUnanswered(person, m);
			this.note(paused ? 'paused' : 'memorize', { channelId: m.channelId, who, text: m.text, title: `B站·${sanitizeName(who, m.userId)}`,
				reason: paused ? '这个聊天暂停着' : !cfg.autoReply ? '自动回复关着' : stale ? '超过回复时限的旧消息' : '不是主人 / 白名单 / 互关' });
			return;
		}
		this.note('reply', { channelId: m.channelId, who, text: m.text });
		this.enqueue(m, person, cfg);
	},

	/**
	 * 抖音私信：按**会话身份**认人（`douyin:<对方uid>`），不按昵称。
	 *
	 * 身份来自会话 ID（`0:1:我方:对方`），由通道在 `readConversation` 里确认过 ——
	 * 到这里还没确认的（`userId` 不是 `douyin:<uid>` 形状）一律隔离：
	 * 昵称、单条 senderId 都证明不了「这是谁的会话」。
	 *
	 * 授权仍然保守：
	 *   · 主人 = 会话身份等于配置里那个抖音身份（`douyin.masterUid`）；
	 *   · 白名单也是按身份，不再按昵称；
	 *   · 旧的「昵称 → QQ 号」对应表（`douyin.links`）**不再生效**，只原样保留。
	 */
	async onDouyinMessage(m) {
		if (this.stopped || this.douyin === null) return { review: '抖音通道没开' };
		const cfg = this.douyinConfig();
		if (!cfg.enabled) return { review: '抖音接入关着' };
		// 身份没确认：通道那边已经按「不入库」拦了，这里是第二道（重放 / 老数据）。
		if (!isIdentityKey(m?.userId)) {
			return { review: '抖音会话身份未确认（缺会话 ID），消息已保留，暂不处理' };
		}
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return { done: true, review: '重复消息' };

		const person = this.resolveDouyinPerson(m, cfg);
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;
		const paused = this.isPaused(m.channelId);
		const who = m.nickname || person?.display_name || m.userId;
		// 授权只看身份：主人身份 / 身份白名单 / 「回所有能私信她的人」
		const trusted = cfg.autoReply && !stale && !paused && (
			m.userId === cfg.masterUid || cfg.allowList.includes(m.userId) || cfg.replyAll
		);
		if (!trusted) {
			this.soul.memorizeUnanswered(person, m);
			this.note(paused ? 'paused' : 'memorize', {
				channelId: m.channelId, who, text: m.text, title: `抖音·${sanitizeName(who, m.userId)}`,
				reason: paused ? '这个聊天暂停着' : !cfg.autoReply ? '自动回复关着'
					: stale ? '超过回复时限的旧消息' : '不在白名单（身份未授权）'
			});
			// 🔴 结果明确的不记不回：返回 {review} 会被 drainInbox 标 unknown，
			//    一条 unknown 挡住同会话后面所有消息——重启后积压的旧消息条条超时限，
			//    条条变 unknown，新消息永远轮不到（2026-11-11 真机连 dismiss 六条才放行）。
			//    超时限 / 暂停 / 未授权 / 开关关着都是「确定不处理」，与「结果不确定需核实」分开。
			return { done: true, review: '只记不回' };
		}
		this.note('reply', { channelId: m.channelId, who, text: m.text });
		this.enqueue(m, person, cfg);
		// 🔴 必须返回 `queued`：结算由 `turn/end` 回写（网关那边 settle）。
		//    返回 `{review}` 会被 drainInbox 当成「未取得处理确认」→ 标 unknown，
		//    而 next() 里一条 unknown 会挡住同会话后面**所有**消息 —— 一条之后整个会话就哑了。
		return { queued: true, review: '已交给模型' };
	},

	/** 抖音群：身份同样按 uid 认，群本身按 `douyin-group:<群名>` 分开。 */
	async onDouyinGroupMessage(m) {
		if (this.stopped || this.douyin === null) return { review: '抖音通道没开' };
		// 身份检查放在开关之前：身份不明的消息，不管群回复开没开都不该被处理，
		// 也不该因为「开关状态」给出不同的结论（否则排查时会误以为是配置问题）。
		if (!isIdentityKey(m?.userId)) {
			return { review: '抖音群成员身份未确认，消息已保留，暂不处理' };
		}
		const cfg = this.douyinConfig();
		if (!cfg.enabled || !cfg.groupReply) return { review: '抖音群回复关着' };
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return { done: true, review: '重复消息' };
		const person = this.resolveDouyinPerson(m, cfg);
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;
		const paused = this.isPaused(m.channelId);
		const who = m.nickname || person?.display_name || m.userId;
		const trusted = cfg.autoReply && !stale && !paused && (
			m.userId === cfg.masterUid || cfg.allowList.includes(m.userId) || cfg.replyAll
		);
		if (!trusted) {
			this.soul.memorizeUnanswered(person, m);
			this.note(paused ? 'paused' : 'memorize', {
				channelId: m.channelId, who, text: m.text, title: `抖音群·${sanitizeName(who, m.userId)}`,
				reason: paused ? '这个群暂停着' : !cfg.autoReply ? '自动回复关着'
					: stale ? '超过回复时限的旧消息' : '不在白名单（身份未授权）'
			});
			// 同私信：结果明确的不记不回返回 done，别被 drainInbox 标 unknown 挡住整个群
			return { done: true, review: '只记不回' };
		}
		this.note('reply', { channelId: m.channelId, who, text: m.text });
		this.enqueue(m, person, cfg);
		// 同私信：结算交给 turn/end，别在 drainInbox 里提前标 unknown
		return { queued: true, review: '已交给模型' };
	},

	/**
	 * 主人的抖音身份键（`douyin:<uid>`）。
	 *
	 * 优先设置页填的 `masterUid`；没填就退回 `person.master` 那一行已经记下的
	 * `douyin_uid` —— 那是从平台数据（会话 ID + senderId）学来的，比手填更可信。
	 *
	 * 🔴 以前只看 `masterUid`：没填就返回空，于是一个「抖音里明明聊过、kv 里明明
	 *    记着会话」的人，永远卡在「先在抖音里给我发一条消息」这句话上 —— 他发了也没用。
	 *
	 * @returns {string} 形如 `douyin:7702399256389125000`；认不出来是空串
	 */
	masterDouyinIdentity() {
		const cfg = this.douyinConfig();
		const configured = String(cfg.masterUid ?? '').trim();
		if (/^douyin:\d+$/.test(configured)) return configured;
		try {
			const row = this.db.prepare("SELECT douyin_uid FROM person WHERE canonical_id = 'master'").get();
			const learned = String(row?.douyin_uid ?? '').trim();
			if (/^douyin:\d+$/.test(learned)) return learned;
		} catch { /* 读不到就当没填，走下面那句提示 */ }
		return '';
	},

	/**
	 * 主人那个抖音会话的 ID（转达 / 主动私信要用）。
	 *
	 * 来源：通道在读过主人会话之后会把 `convId` 记在 kv（`douyin.convId.<身份>`）。
	 * 没读过就是空 —— 那时宁可发不出去，也不能按昵称猜一个会话发。
	 *
	 * @returns {Promise<string>}
	 */
	async masterDouyinConvId() {
		const id = this.masterDouyinIdentity();
		if (id === '') return '';
		try {
			const { getKv } = await import('./db.js');
			return String(getKv(this.db, `douyin.convId.${id}`, '') ?? '').trim();
		} catch { return ''; }
	},

	/**
	 * 发不出去时给一句「照着做就能修好」的话。
	 *
	 * 三种原因必须分开说，否则用户会照着错的提示白折腾：
	 *   ① 根本不知道主人是哪个抖音号 → 去设置页填身份（发消息没用）
	 *   ② 知道身份但没聊过 → 让他先在抖音发一条（这时那句提示才是对的）
	 * @returns {Promise<string>} 空串 = 能发
	 */
	async masterDouyinSendBlocker() {
		const id = this.masterDouyinIdentity();
		if (id === '') {
			return '还没认出你的抖音身份：去设置页「平台 → 抖音」把「主人身份」填成 douyin:<你的抖音数字uid>（只发消息不会自动认出来）';
		}
		const convId = String(await this.masterDouyinConvId() ?? '').trim();
		if (convId === '') {
			return '还认不出你抖音那个会话：先在抖音里给我发一条消息，我就能把会话身份记下来';
		}
		return '';
	},

	/** 按会话身份建/找人。`masterUid` 对上就是主人，否则是陌生人（不按昵称合并）。 */
	resolveDouyinPerson(m, cfg) {
		try {
			return resolveOrCreatePlatformPerson(this.db, {
				platform: 'douyin',
				platformId: String(m.userId),
				nickname: String(m.nickname ?? ''),
				nowMs: Date.now(),
				masterId: cfg.masterUid || ''
			});
		} catch (error) {
			this.log('warn', `[fish-soul] 抖音认人失败（按陌生人处理）：${String(error instanceof Error ? error.message : error)}`);
			return null;
		}
	},

	/**
	 * 主人私聊发链接、并且明确让她去评论区说一句 → 真的发一条。
	 * 只有主人能触发；不受「刷视频时自己留一句」开关限制，但共用每天的留评额度。
	 */
	async commentOnRequest(bvid) {
		if (this.browser === null || typeof this.browser.gather !== 'function') return [];
		try {
			const cfg = this.browser.cfg?.() ?? {};
			const used = Number(this.browser.commentedToday?.() ?? 0);
			const cap = Number(cfg.commentPerDay ?? 1);
			if (used >= cap) return ['【你让她去评论区说一句，但今天留评的额度已经用完了】'];
			const v = await this.browser.gather(bvid);
			if (!v?.aid) return ['【你让她去评论区说一句，但没拿到这条视频的评论入口】'];
			const said = await this.browser.commentOn(v, '主人让我看完之后，在这条视频下面说一句。');
			if (!said) return ['【你让她去评论区说一句，她没发成】'];
			const title = String(v.title ?? '').slice(0, 30);
			return ['【你让她去评论区说一句，她已经在《' + title + '》下面发了：' + said + '】'];
		} catch (error) {
			this.log('warn', '[fish-soul] 按主人要求发评论失败：' + String(error instanceof Error ? error.message : error));
			return ['【想去评论区说一句，但没成功】'];
		}
	},

	/** 消息里的 B站 / 抖音视频 → 简短介绍（没开或取不到就什么都不加）。 */
	async videoNotes(items) {
		const text = items.map(({ m }) => [m.text, ...(m.links ?? [])].join(' ')).join(' ');
		const jobs = [];
		const askFromMaster = /(评论|留言|冒个泡|说一句|留一句|回一句)/.test(String(text)) && items.every(({ m }) => m.chatType === 'private') && String(this.masterQq?.() ?? '') !== '' && items.some(({ m }) => String(m.userId) === String(this.masterQq?.() ?? ''));
		let askBvid = '';
		if (this.browser !== null && this.biliConfig().enabled) {
			const refs = findVideoRefs(text);
			if (refs.bvids.length > 0 || refs.shorts.length > 0) {
				if (askFromMaster) {
					if (refs.bvids.length > 0) askBvid = refs.bvids[0];
					else if (refs.shorts.length > 0) {
						// b23.tv 短链：得先换成 BV 号才能发评论
						try { askBvid = String(await this.browser?.client?.resolveShort?.(refs.shorts[0]) ?? ''); } catch { askBvid = ''; }
					}
				}
				jobs.push(this.withTimeout(this.browser.describe(refs), 8000));
			}
		}
		if (this.douyinBrowser !== null && this.douyinConfig().enabled) {
			const refs = findDouyinRefs(text);
			// 抖音得真的打开视频页（十几秒），最多等 30 秒
			if (refs.ids.length > 0 || refs.shorts.length > 0) jobs.push(this.withTimeout(this.douyinBrowser.describe(refs), 30_000));
		}
		if (jobs.length === 0) return [];
		const notes = (await Promise.all(jobs)).flat();
		if (askBvid !== '') notes.push(...await this.withTimeout(this.commentOnRequest(askBvid), 20_000));
		return notes;
	},

	async withTimeout(p, ms) {
		try {
			return await Promise.race([p, new Promise((r) => { const t = setTimeout(() => r([]), ms); t.unref?.(); })]);
		} catch {
			return [];
		}
	},

	async admitImages(text, items, sessionId = '') {
		const imgs = [];
		for (const { m } of items) for (const img of m.images) if (imgs.length < MAX_INBOUND_IMAGES) imgs.push({ img, m });
		const base = [{ type: 'text', text }];
		if (imgs.length === 0) return base;
		const attachments = service(this.ctx, 'attachments');
		if (!attachments || typeof attachments.admitPromptContent !== 'function') return base;
		const parts = [...base];
		for (const [i, { img, m }] of imgs.entries()) {
			const bytes = await fetchImageBytes(img);
			if (bytes === null) continue;
			const mediaType = mediaTypeOf(bytes);
			this.stickers?.remember(sessionId, { bytes, mediaType, sticker: img.sticker === true, summary: img.summary, from: m.nickname || m.userId });
			parts.push({ type: 'image', data: bytes.toString('base64'), mediaType, name: `qq-${m.messageId || 'x'}-${i + 1}.${mediaType.split('/')[1]}` });
		}
		if (parts.length === 1) return base;
		try {
			return await attachments.admitPromptContent(parts);
		} catch (error) {
			this.log('warn', `[fish-soul] 图片交给 DSH 失败（这轮只转文字）：${String(error instanceof Error ? error.message : error)}`);
			return base;
		}
	},

	resolveImageFile(p, workspacePath) {
		const raw = String(p ?? '').trim();
		if (/^https?:\/\//i.test(raw)) return { type: 'image', data: { file: raw } };
		const real = safeLocalImagePath(raw, workspacePath, (...args) => this.log(...args));
		if (real === null) return null;
		try { return { type: 'image', data: { file: `base64://${readFileSync(real).toString('base64')}` } }; }
		catch { return null; }
	},

	async attachmentSegment(block) {
		const attachments = service(this.ctx, 'attachments');
		try {
			if (typeof attachments?.readImage === 'function') {
				const stored = await attachments.readImage(block.attachment);
				const bytes = stored?.bytes ?? stored?.data;
				if (bytes) return { type: 'image', data: { file: `base64://${Buffer.from(bytes).toString('base64')}` } };
			}
			const p = attachments?.imageHostPath?.(block.attachment);
			if (p) return { type: 'image', data: { file: `base64://${readFileSync(p).toString('base64')}` } };
		} catch { /* 这张发不出去 */ }
		return null;
	},

	/** 私信（B站 / 抖音）的文字：按空行拆条（每条 ≤ 500 字），最多 5 条。 */
	dmParagraphs(text) {
		let paragraphs = String(text ?? '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 500));
		if (paragraphs.length > MAX_PARAGRAPHS) {
			paragraphs = [...paragraphs.slice(0, MAX_PARAGRAPHS - 1), paragraphs.slice(MAX_PARAGRAPHS - 1).join('\n').slice(0, 500)];
		}
		return paragraphs;
	},

	/** 本地图片路径（工作区 / 插件数据目录里的）；网址、越界的、不是图的返回 null。 */
	localImagePath(p, workspacePath) {
		return safeLocalImagePath(p, workspacePath, (...args) => this.log(...args));
	},

	/** 私信要发的图（表情包 / 模型生成的图）→ 能直接发的 {path, bytes, type, width, height}（webp 先转），最多 2 张。 */
	async dmImages(row, 图, st) {
		const files = [];
		for (const g of 图) {
			const p = this.localImagePath(g.value, row.workspace_path);
			if (p !== null) files.push(p);
		}
		const cacheDir = join(fishSoulDir(), 'img-cache');
		for (const block of st.images ?? []) {
			if (files.length >= MAX_DM_IMAGES) break;
			const bytes = await this.attachmentBytes(block);
			if (bytes === null) continue;
			try {
				mkdirSync(cacheDir, { recursive: true });
				const ext = mediaTypeOf(bytes).split('/')[1];
				const f = join(cacheDir, `att-${createHash('sha1').update(bytes).digest('hex').slice(0, 20)}.${ext}`);
				if (!existsSync(f)) writeFileSync(f, bytes);
				files.push(f);
			} catch { /* 这张发不出去 */ }
		}
		const out = [];
		for (const f of files.slice(0, MAX_DM_IMAGES)) {
			// keepWebpIfNoConverter：这台机器没有 sharp（loadSharp 返回 null），
			// webp 只能靠浏览器 canvas 兜底；兜不住时以前是**静默丢掉**，
			// 表现就是「表情包明明在库里，发出去什么都没有」。
			// 现在原样交给 sendImage —— 私信走 DOM.setFileInputFiles，它绕过文件框的
			// accept 过滤，webp 是能发的（抖音官方实现里 webp 走普通图片分支）。
			const img = await prepareImage(f, {
				cacheDir, canvasConvert: this.canvasConvert, log: this.log, keepWebpIfNoConverter: true
			});
			if (img !== null) out.push(img);
			else this.log('warn', `[fish-soul] 这张图发不了（格式不支持或者太大）：${f}`);
		}
		return out;
	},

	async attachmentBytes(block) {
		const attachments = service(this.ctx, 'attachments');
		try {
			if (typeof attachments?.readImage === 'function') {
				const stored = await attachments.readImage(block.attachment);
				const bytes = stored?.bytes ?? stored?.data;
				if (bytes) return Buffer.from(bytes);
			}
			const p = attachments?.imageHostPath?.(block.attachment);
			if (p) return readFileSync(p);
		} catch { /* 这张发不出去 */ }
		return null;
	},

	/** B站私信：文字按空行拆条，图片（≤2 张）跟在最后。 */
	/**
	 * 抖音 / B站私信发不了语音：主人在那边要的语音发到主人的 QQ 私聊。
	 * 条件：是主人、填了主人 QQ、QQ 连着、「说」那组配好了、没设成从不发语音、QQ 私聊没暂停；不行返回 ''。
	 */
	voiceRelayTarget(channelId) {
		const [kind, id] = splitChannelId(channelId);
		const isMaster = id !== '' && kind === 'bili' && id === this.biliConfig().masterUid;
		const qq = this.masterQq();
		if (!isMaster || qq === '' || this.voice === null || this.voice === undefined || !this.voice.readyFor('tts')) return '';
		if (this.voice.getConfig().speak === 'never' || !this.qqConfig().enabled || !this.channel?.connected) return '';
		const target = `private:${qq}`;
		return this.isPaused(target) ? '' : target;
	},

	/** 写了 [语音] 却发成了文字：为什么（记进「动态」）。 */
	voiceFailReason(text) {
		const v = this.voice;
		if (!v) return '没开语音';
		if (!v.readyFor('tts')) return '「说」那组没配好';
		const c = v.getConfig();
		if ([...String(text ?? '')].length > c.maxChars) return `超过 ${c.maxChars} 字`;
		return v.lastError || '合成失败';
	},

	/**
	 * 私信回复里 [语音] 开头的段：能转到主人 QQ 的就合成语音发过去（这段不在私信里发），
	 * 不能的去掉标记当文字发。返回私信里要发的文字。
	 */
	async relayDmVoice(row, text) {
		const paras = String(text ?? '').split(/\n{2,}/);
		if (!paras.some((p) => VOICE_TAG_RE.test(p))) return text;
		const target = this.voiceRelayTarget(row.channel_id);
		const where = platformName(row.channel_id);
		const keep = [];
		for (const p of paras) {
			if (!VOICE_TAG_RE.test(p)) { keep.push(p); continue; }
			const said = p.replace(VOICE_TAG_RE, '').trim();
			if (said === '') continue;
			if (target === '') {
				this.note('filtered', { channelId: row.channel_id, title: row.title, text: said, reason: `${where}私信发不了语音，改成打字` });
				keep.push(said);
				continue;
			}
			const bytes = await this.voice.synthesize(said);
			if (!bytes) {
				this.note('filtered', { channelId: row.channel_id, title: row.title, text: said, reason: `语音没发成（${this.voiceFailReason(said)}），改成打字` });
				keep.push(said);
				continue;
			}
			try {
				const id = await this.channel.send(target, [{ type: 'record', data: { file: `base64://${bytes.toString('base64')}` } }]);
				this.rememberOwn?.(id, `[语音] ${said}`);
				this.note('sent', { channelId: target, title: 'QQ·主人', text: `🔊${said}`, reason: `${where}里要的语音，发到 QQ 私聊` });
				this.soul.journalOut?.(target, `[语音] ${said}`);
			} catch (error) {
				this.log('error', `[fish-soul] 语音发到 QQ 失败：${String(error instanceof Error ? error.message : error)}`);
				this.note('filtered', { channelId: row.channel_id, title: row.title, text: said, reason: '语音发到 QQ 失败，改成打字' });
				keep.push(said);
			}
		}
		return keep.join('\n\n');
	},

	async sendBili(row, text, images = []) {
		if (this.bili === null) return false;
		const mid = row.channel_id.slice('bili:'.length);
		let allOk = true;
		const fail = (error) => {
			allOk = false;
			this.log('error', `[fish-soul] 发到 ${row.title || row.channel_id} 失败：${String(error instanceof Error ? error.message : error)}`);
		};
		for (const p of this.dmParagraphs(text)) {
			try { await this.bili.send(mid, p); } catch (error) { fail(error); }
		}
		for (const img of images) {
			try { await this.bili.sendImage(mid, img); } catch (error) { fail(error); }
		}
		return allOk;
	},

	/**
	 * 抖音私信：文字按空行拆条；单独一段 [名字] 发成抖音自带表情；图片（≤2 张）跟在最后。
	 *
	 * @returns {Promise<{ok: boolean, delivered: boolean, parts: Array<object>}>}
	 *   `ok` = 动作都做了；`delivered` = 至少一条回读到证据。
	 *   🔴 两者要分开报：抖音风控静默吞消息时 `ok` 仍然是 true，
	 *      但对方根本收不到 —— 只报 ok 等于撒谎。
	 */
	async sendDouyin(row, text, images = [], convId = '') {
		if (this.douyin === null || typeof this.douyin.send !== 'function') {
			return { ok: false, delivered: false, parts: [], error: '抖音通道没接上' };
		}
		// 🔴 没有目标会话 ID 就不发：昵称只能用来「找到会话」，证明不了「打开的就是这个人」。
		//    通道层还会再挡一道（DouyinChannel.send），这里是给上层一个明确原因。
		const target = String(convId ?? '').trim();
		if (!/^0:1:\d+:\d+$/.test(target)) {
			return { ok: false, delivered: false, parts: [], error: '没有确认过这个抖音会话的身份（缺会话 ID），不发，以免发错人' };
		}
		// 会话名只用来找会话：channel_id 是 `douyin:<名字>`，名字从 row 上取。
		const name = String(row?.channel_id ?? '').replace(/^douyin:/, '');
		if (name === '') return { ok: false, delivered: false, parts: [], error: '不知道要发给哪个会话' };

		const parts = [];
		for (const para of String(text ?? '').split(/\n{2,}/).map((x) => x.trim()).filter((x) => x !== '')) {
			// 单独一段 [名字] → 抖音自带表情
			const m = /^\[([^\]\n]{1,12})\]$/.exec(para);
			if (m !== null) { parts.push({ type: 'emoji', name: m[1] }); continue; }
			parts.push({ type: 'text', text: para });
		}
		for (const img of images.slice(0, 2)) {
			const file = String(img?.data?.file ?? img?.path ?? '');
			if (file !== '') parts.push({ type: 'image', path: file });
		}
		if (parts.length === 0) return { ok: false, delivered: false, parts: [], error: '没有可发的内容' };
		const r = await this.douyin.send(name, parts, target);
		return { ok: r?.ok === true, delivered: r?.delivered === true, parts: r?.parts ?? [], error: r?.ok === true ? '' : (r?.error ?? '发送失败') };
	},

	/**
	 * 跨平台转达：主人在 QQ 私聊里让她去抖音 / B站 私信自己一条。
	 * 只发主人自己的账号 —— 小号主动私信真人 = 封号 + 社交双重风险（见 DECISIONS D11）。
	 *
	 * @returns {Promise<{ok: boolean, delivered: boolean, platform: string, reason: string}>}
	 *   `ok` = 动作做了；`delivered` = 至少有一条回读到证据（抖音风控吞消息时 ok 仍是 true）。
	 */
	async relayTo(platform, text) {
		const said = String(text ?? '').trim();
		if (said === '') return { ok: false, delivered: false, platform, reason: '内容是空的' };
		try {
			if (platform === 'bili') {
				const cfg = this.biliConfig();
				if (!cfg.enabled) return { ok: false, delivered: false, platform, reason: 'B站那边没开' };
				if (this.bili === null || !this.bili.connected) return { ok: false, delivered: false, platform, reason: 'B站没连上' };
				if (cfg.masterUid === '') return { ok: false, delivered: false, platform, reason: '没填主人的 B站 UID（设置页「平台」→ B站）' };
				const channelId = 'bili:' + cfg.masterUid;
				const ok = await this.sendBili({ channel_id: channelId, title: 'B站·' + cfg.masterUid }, said, []);
				if (ok) this.afterRelay(channelId, said, 'bili');
				return { ok, delivered: ok, platform, reason: ok ? '' : '发送时报错了，看日志' };
			}
			if (platform === 'douyin') {
				const cfg = this.douyinConfig();
				if (!cfg.enabled) return { ok: false, delivered: false, platform, reason: '抖音那边没开' };
				if (this.douyin === null || !this.douyin.connected) return { ok: false, delivered: false, platform, reason: '抖音没连上' };
				// 转达是「主动私信」，没有入站消息可依据，只能靠主人身份反查会话 ID。
				// 拿不到就明确说清楚 —— 不退回昵称（那正是会把消息发给错的人的做法）。
				// 提示要分得清「没填身份」和「没聊过」：说错了用户会白折腾一轮。
				const blocker = await this.masterDouyinSendBlocker();
				if (blocker !== '') return { ok: false, delivered: false, platform, reason: blocker };
				const convId = String(await this.masterDouyinConvId() ?? '').trim();
				const name = cfg.masterName;
				if (name === '') return { ok: false, delivered: false, platform, reason: '没填主人抖音的会话名（设置页「平台」→ 抖音）' };
				const channelId = 'douyin:' + name;
				const r = await this.sendDouyin({ channel_id: channelId, title: '抖音·' + name }, said, [], convId);
				if (r.ok === true) this.afterRelay(channelId, said, 'douyin');
				return { ok: r.ok === true, delivered: r.delivered === true, platform, reason: r.ok === true ? '' : (r.error || '发送时报错了，看日志') };
			}
			return { ok: false, delivered: false, platform, reason: '只支持 douyin / bili' };
		} catch (error) {
			// 绝不往上抛：工具层会把异常当成"这次没发成"，这里自己收住并把原因带给主人
			const msg = String(error instanceof Error ? error.message : error);
			this.log('error', `[fish-soul] 转达消息失败：${msg}`);
			return { ok: false, delivered: false, platform, reason: msg.slice(0, 80) };
		}
	},

	/** 转达发出去了：记进聊天日志 + 记一条「动态」。 */
	afterRelay(channelId, text, platform) {
		try { this.soul.journalOut?.(channelId, text); } catch { /* 记日志失败不影响已经发出去的消息 */ }
		this.note('relay', { channelId, text, reason: `主人让去${platform === 'bili' ? 'B站' : '抖音'}发的` });
	}
};
