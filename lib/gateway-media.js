/**
 * gateway-media.js —— 网关的图片 / 私信（B站、抖音）/ 视频介绍部分（从 gateway.js 拆出来，混入 ChatGateway.prototype）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fishSoulDir } from './db.js';
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
	 * 抖音私信入口（DouyinChannel 轮询到的每条新消息）。
	 * 回：自动回复打开 + 页面自检正常 + 对方是主人 / 白名单（或打开了"回所有能私信她的人"）+ 不是 10 分钟前的旧消息。
	 */
	async onDouyinMessage(m) {
		if (this.stopped || this.douyin === null) return;
		const cfg = this.douyinConfig();
		if (!cfg.enabled || m.userId === '') return;
		if (m.messageId !== '' && !this.markSeen(`${m.channelId}#${m.messageId}`)) return;
		const person = this.soul.resolveDouyinPerson(m, { masterName: cfg.masterName, linkedQq: this.douyinLinks().get(m.userId) ?? '' });
		const stale = Date.now() - m.timeMs > cfg.replyWindowMinutes * 60_000;
		const paused = this.isPaused(m.channelId);
		const trusted = cfg.autoReply && !stale && !paused && !this.douyin.replyPaused &&
			(m.userId === cfg.masterName || cfg.allowList.includes(m.userId) || cfg.replyAll);
		if (!trusted) {
			this.soul.memorizeUnanswered(person, m);
			this.note(paused ? 'paused' : 'memorize', { channelId: m.channelId, who: m.userId, text: m.text, title: `抖音·${sanitizeName(m.userId, '抖音用户')}`,
				reason: paused ? '这个聊天暂停着' : !cfg.autoReply ? '自动回复关着' : stale ? '超过回复时限的旧消息' : this.douyin.replyPaused ? '页面自检没过，先不回' : '不是主人 / 白名单' });
			return;
		}
		this.note('reply', { channelId: m.channelId, who: m.userId, text: m.text });
		this.enqueue(m, person, cfg);
	},

	/** 消息里的 B站 / 抖音视频 → 简短介绍（没开或取不到就什么都不加）。 */
	async videoNotes(items) {
		const text = items.map(({ m }) => [m.text, ...(m.links ?? [])].join(' ')).join(' ');
		const jobs = [];
		if (this.browser !== null && this.biliConfig().enabled) {
			const refs = findVideoRefs(text);
			if (refs.bvids.length > 0 || refs.shorts.length > 0) jobs.push(this.withTimeout(this.browser.describe(refs), 8000));
		}
		if (this.douyinBrowser !== null && this.douyinConfig().enabled) {
			const refs = findDouyinRefs(text);
			// 抖音得真的打开视频页（十几秒），最多等 30 秒
			if (refs.ids.length > 0 || refs.shorts.length > 0) jobs.push(this.withTimeout(this.douyinBrowser.describe(refs), 30_000));
		}
		if (jobs.length === 0) return [];
		return (await Promise.all(jobs)).flat();
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
		let raw = String(p ?? '').trim();
		if (raw === '') return null;
		if (/^https?:\/\//i.test(raw)) return { type: 'image', data: { file: raw } };
		try { if (raw.startsWith('file://')) raw = fileURLToPath(raw); } catch { return null; }
		const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspacePath, raw);
		// 只允许工作区和 fish-soul 数据目录里的图：模型写个 ![](~/.ssh/id_rsa) 不能把文件发出去
		if (!isInside(workspacePath, abs) && !isInside(fishSoulDir(), abs)) {
			this.log('warn', `[fish-soul] 拒绝发送工作区外的图片：${raw}`);
			return null;
		}
		if (!IMAGE_EXT.has(extname(abs).toLowerCase())) return null;
		try {
			if (!existsSync(abs) || statSync(abs).size > MAX_IMAGE_BYTES) return null;
			return { type: 'image', data: { file: `base64://${readFileSync(abs).toString('base64')}` } };
		} catch {
			return null;
		}
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
		let raw = String(p ?? '').trim();
		if (raw === '' || /^https?:\/\//i.test(raw)) return null;
		try { if (raw.startsWith('file://')) raw = fileURLToPath(raw); } catch { return null; }
		const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspacePath, raw);
		if (!isInside(workspacePath, abs) && !isInside(fishSoulDir(), abs)) {
			this.log('warn', `[fish-soul] 拒绝发送工作区外的图片：${raw}`);
			return null;
		}
		if (!IMAGE_EXT.has(extname(abs).toLowerCase())) return null;
		return abs;
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
			const img = await prepareImage(f, { cacheDir, canvasConvert: this.canvasConvert, log: this.log });
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
		const isMaster = id !== '' && (kind === 'douyin' ? id === this.douyinConfig().masterName : kind === 'bili' ? id === this.biliConfig().masterUid : false);
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

	/** 抖音私信：文字按空行拆条；单独一段 [名字] 发成抖音自带表情；图片（≤2 张）跟在最后。 */
	async sendDouyin(row, text, images = []) {
		if (this.douyin === null) return false;
		const name = splitChannelId(row.channel_id)[1];
		const parts = this.dmParagraphs(text).map((p) => {
			const e = p.match(DOUYIN_EMOJI_RE);
			return e ? { type: 'emoji', name: e[1] } : { type: 'text', text: p };
		});
		for (const img of images) parts.push({ type: 'image', path: img.path });
		if (parts.length === 0) return true;
		try {
			return await this.douyin.send(name, parts);
		} catch (error) {
			this.log('error', `[fish-soul] 发到 ${row.title || row.channel_id} 失败：${String(error instanceof Error ? error.message : error)}`);
			return false;
		}
	}
};
