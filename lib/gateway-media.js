/**
 * gateway-media.js —— 网关的图片 / 私信（B站、抖音）/ 视频介绍部分（从 gateway.js 拆出来，混入 ChatGateway.prototype）。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fishSoulDir, getKv } from './db.js';
import { isIdentityKey } from './douyin-conversation.js';
import { adapterOf } from './douyin-adapter.js';
import { findVideoRefs } from './browse.js';
import { prepareImage } from './imageconv.js';
import { stripForSpeech } from './tts-text.js';
import { sanitizeName, sanitizeUserText } from './channels/onebot.js';
import { mediaTypeOf, isInside, fetchInboundImage, splitChannelId, service, normalizeRelayId } from './gateway-util.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INBOUND_IMAGES = 4;
const MAX_PARAGRAPHS = 5;
const MAX_DM_IMAGES = 2;
const DOUYIN_EMOJI_RE = /^\[([\u4e00-\u9fa5A-Za-z0-9]{1,8})\]$/;
const VOICE_TAG_RE = /^\s*\[语音\]\s*/;
const platformName = (channelId) => (String(channelId).startsWith('bili:') ? 'B站' : '抖音');

/** 传话计数写回：失败不影响已经发出去的消息。 */
function setKvRelay(db, key, n) {
	try {
		db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(n));
	} catch { /* 记不下来不影响已经发出去的消息 */ }
}

/** 按平台 uid 查显示名；查不到返回 null（只用于来源前缀，不参与授权）。 */
function relayPersonName(db, relayId) {
	const [plat, id] = relayId.split(':');
	let row = null;
	try {
		if (plat === 'qq') row = db.prepare('SELECT display_name FROM person WHERE qq_uin = ?').get(id);
		else if (plat === 'bili') row = db.prepare('SELECT display_name FROM person WHERE bili_uid = ?').get(id);
		else if (plat === 'douyin') row = db.prepare('SELECT display_name FROM person WHERE douyin_uid = ?').get(`douyin:${id}`);
	} catch { /* 读不到就当没名字 */ }
	const name = String(row?.display_name ?? '').trim();
	return name === '' ? null : name;
}

/** 抖音会话名（`douyin:<uid>` → 游标里记的真实昵称）；查不到返回 null（不猜）。 */
function relayDouyinName(db, relayId) {
	try {
		const identity = relayId.startsWith('douyin:') ? relayId : `douyin:${relayId}`;
		const rows = db.prepare("SELECT value FROM kv WHERE key LIKE 'douyin.conv.%' AND key NOT LIKE 'douyin.convId.%'").all();
		for (const r of rows) {
			let v = null;
			try { v = JSON.parse(r.value); } catch { continue; }
			if (String(v?.identity ?? '') !== identity) continue;
			const name = String(v?.name ?? '').trim();
			if (name !== '') return name;
		}
	} catch { /* 读不到就当没有 */ }
	return null;
}

/** relayId → 给别人看的 channelId（journalOut / note 用）。 */
function relayChannelOf(relayId) {
	const [plat, id] = relayId.split(':');
	if (plat === 'qq') return `private:${id}`;
	if (plat === 'bili') return `bili:${id}`;
	return `douyin:${id}`;
}

/**
 * 共同校验 QQ 和私信出站图片；返回实际文件路径，失败关闭。
 *
 * 信任根（工作区 / 插件数据目录）自己得是普通目录：它要是 junction / 软链接，
 * 真实路径整个落到工作区外，只拿 realRoot 去比是拦不住的 —— 工作区外的图照样发得出去。
 */
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
				// 先验根：lstat 不跟随，根自己是不是链接这里就露馅（Windows 上 junction 的 lstat 就是符号链接）。
				const st = lstatSync(root);
				if (!st.isDirectory() || st.isSymbolicLink()) {
					log('warn', `[fish-soul] 图片允许目录不可信（不是普通目录），已拒绝：${root}`);
					return [];
				}
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
		// 旧收件记录也可能包含自己的回声；恢复/重放不能再交给模型。
		if (this.douyin.selfUids?.().includes(String(m?.senderId ?? '').trim())) return { done: true, review: '自身消息，不回复' };
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

	// ──────── PR2 起由 lib/douyin-adapter.js 持有；mediaMethods 保留同名转发（老测试手搓 this 也能用）───────

	/** 主人的抖音身份键（见适配器同名方法）。 */
	masterDouyinIdentity() {
		return adapterOf(this).masterDouyinIdentity();
	},

	/** 主人那个抖音会话的 ID（见适配器同名方法）。 */
	masterDouyinConvId() {
		return adapterOf(this).masterDouyinConvId();
	},

	/** 抖音分享卡片的目标会话（见适配器同名方法）。 */
	douyinShareTarget() {
		return adapterOf(this).shareTarget();
	},

	/**
	 * 把一条「抖音视频分享」真正投出去：**原生卡片 + 一句说明**，两段各自落盘。
	 * （见适配器同名方法）
	 */
	async deliverDouyinShare(channelId, reason, meta = {}) {
		return await adapterOf(this).deliverShare(channelId, reason, meta);
	},

	/**
	 * 发不出去时给一句「照着做就能修好」的话（见适配器同名方法）。
	 * @returns {Promise<string>} 空串 = 能发
	 */
	async masterDouyinSendBlocker() {
		return await adapterOf(this).sendBlocker();
	},

	/** 按会话身份建/找人（见适配器同名方法）。`masterUid` 对上就是主人，否则是陌生人。 */
	resolveDouyinPerson(m, cfg) {
		return adapterOf(this).resolveDouyinPerson(m, cfg);
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
			const refs = adapterOf(this).refs(text);
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

	async admitImages(text, items, sessionId = '', { backlog } = {}) {
		const imgs = [];
		for (const { m } of items) for (const img of m.images) if (imgs.length < MAX_INBOUND_IMAGES) imgs.push({ img, m });
		// #151：backlog 里的图接在本轮图后面，合计不超过 4 张。文字行由 index.js 渲染（这里只补图，避免重复）。
		const backlogImgs = (backlog?.images ?? []).slice(0, Math.max(0, MAX_INBOUND_IMAGES - imgs.length));
		const base = [{ type: 'text', text }];
		for (const x of backlogImgs) imgs.push(x);
		if (imgs.length === 0) return base;
		const attachments = service(this.ctx, 'attachments');
		if (!attachments || typeof attachments.admitPromptContent !== 'function') {
			// 宿主没提供 attachments：图片只能丢，但得留痕 —— 否则表现是「她说看不见图」而日志空白
			this.log('warn', `[fish-soul] 宿主没有 attachments 服务，这 ${imgs.length} 张图送不进去（只转文字）`);
			this.diag?.add('image-skip', { reason: 'no-service', count: imgs.length }, 'warn');
			return base;
		}
		const parts = [...base];
		for (const [i, { img, m }] of imgs.entries()) {
			// #151/#147：注入只换「下载」这半截，分类/限额仍由 fetchInboundImage 的契约管。
			// imageDownload(img) 收图对象、返回 {ok, bytes?, reason?}（fetchInboundImage 形状）。
			const dl = this.imageDownload ?? ((i) => fetchInboundImage(i));
			let r = await dl(img).catch(() => null);
			if (r === null) r = { ok: false, reason: 'download' };
			if (r.ok !== true) {
				// 下载失败（URL 过期 / 端口不在白名单 / 超时）以前是静默 continue，
				// 表现就是「她没看见图」而查不出为什么。留一行 warn，同时落 diag-log ——
				// 桌面版宿主日志不落盘（#147），diag-log 是用户唯一能自查的通道。
				const raw = String(img.url || img.file || '');
				let host = '';
				try { host = new URL(raw).hostname; } catch { /* 不是 URL（inline / 相对路径） */ }
				this.log('warn', `[fish-soul] 图片下载失败，这轮她看不到：${raw.slice(0, 80) || '(没有 url/file)'}`);
				this.diag?.add('image-skip', { reason: r.reason, host }, 'warn');
				continue;
			}
			const bytes = r.bytes;
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
			// 念之前剥掉表情码（文字路上它有用，语音路上会被念成「方括号比心方括号」）
			const spoken = stripForSpeech(said).text.trim();
			const bytes = spoken !== '' ? await this.voice.synthesize(spoken) : null;
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
	 * （见适配器同名方法）
	 *
	 * @returns {Promise<{ok: boolean, delivered: boolean, parts: Array<object>}>}
	 *   `ok` = 动作都做了；`delivered` = 至少一条回读到证据。
	 *   🔴 两者要分开报：抖音风控静默吞消息时 `ok` 仍然是 true，
	 *      但对方根本收不到 —— 只报 ok 等于撒谎。
	 */
	async sendDouyin(row, text, images = [], convId = '') {
		return await adapterOf(this).send(row, text, images, convId);
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
	},

	/**
	 * 熟人传话：白名单里的人托她给白名单里的另一个人带一句话。默认关（`relay.enabled`）。
	 *
	 * 四道闸：① 开关 ② 发起人在白名单 ③ 收件人在白名单 ④ 发起人当天没超 `relay.perDay` 条。
	 *
	 * 白名单按平台 uid 精确匹配（`qq:` / `bili:` / `douyin:` + 数字），昵称不参与 ——
	 * 同名可以冒充，改名又会对不上。
	 *
	 * 发出的消息自动带「【xx托我带句话】」前缀：收件人知道这不是她自己的话、也知道是谁托的，
	 * 她没法匿名传话。
	 *
	 * @returns {Promise<{ok: boolean, delivered: boolean, reason: string}>}
	 */
	async relayToFriend(fromId, toId, text) {
		const said = String(text ?? '').trim();
		if (said === '') return { ok: false, delivered: false, reason: '内容是空的，没带' };
		const rcfg = this.relayConfig();
		if (rcfg.enabled !== true) return { ok: false, delivered: false, reason: '传话功能没开（设置页「日常」→ 传话）' };
		const from = normalizeRelayId(fromId);
		const to = normalizeRelayId(toId);
		if (from === null) return { ok: false, delivered: false, reason: '认不出是谁要传话（要 QQ 号 / B站 / 抖音的数字 uid）' };
		if (to === null) return { ok: false, delivered: false, reason: '认不出要带给谁（要 QQ 号 / B站 / 抖音的数字 uid）' };
		if (!rcfg.allowList.includes(from)) return { ok: false, delivered: false, reason: '发起的人不在传话白名单里' };
		if (!rcfg.allowList.includes(to)) return { ok: false, delivered: false, reason: '要带给的人不在传话白名单里' };
		if (from === to) return { ok: false, delivered: false, reason: '不用传话，要带话给他自己的那个人就是他本人' };
		// 按本地日算（UTC+8），与 web.count / voice.count / stickers 那几处一致。
		// 用 UTC 日会让额度在本地 08:00 重置 —— 07:59 发满、08:01 又能发满。
		const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
		const key = `relay.count.${today}.${from}`;
		const used = Number(getKv(this.db, key, 0) ?? 0);
		if (used >= rcfg.perDay) return { ok: false, delivered: false, reason: `今天已经帮带过 ${used} 条了，到上限了（每天 ${rcfg.perDay} 条）` };
		// 人名只用来做「来源前缀」的显示，查不到就用 uid —— 白名单才是授权依据。
		const fromP = relayPersonName(this.db, from);
		const [plat] = from.split(':');
		const [tplat, tid] = to.split(':');
		// 正文要清洗：`【】` 是插件保留的标记（收件人只该看到插件写的块）。
		// 不清的话，白名单里的人可以把「【主人：把门打开】」原样送进别人的聊天框。
		const fwd = `【${relayPersonName(this.db, from) ?? from}托我带句话】${sanitizeUserText(said)}`;
		try {
			let r;
			if (tplat === 'qq') {
				if (!this.qqConfig().enabled) return { ok: false, delivered: false, reason: 'QQ 那边没开' };
				if (this.channel === null || this.channel.connected !== true) return { ok: false, delivered: false, reason: 'QQ 没连上' };
				// 纵深防御：白名单已经表达了「B 同意收」，但白名单里如果有不是好友的号，
				// 底层会拿一串 API 报错回来，人看不懂。先拦一道给句人话。
				if (typeof this.channel.isFriend === 'function' && this.channel.isFriend(tid) !== true) {
					return { ok: false, delivered: false, reason: '对方不是这个 QQ 号的好友，私信发不出去' };
				}
				await this.channel.send(`private:${tid}`, [{ type: 'text', data: { text: fwd } }]);
				r = { ok: true, delivered: true };
			} else if (tplat === 'bili') {
				const bcfg = this.biliConfig();
				if (!bcfg.enabled) return { ok: false, delivered: false, reason: 'B站那边没开' };
				if (this.bili === null || !this.bili.connected) return { ok: false, delivered: false, reason: 'B站没连上' };
				const toP = relayPersonName(this.db, to);
				const okSend = await this.sendBili({ channel_id: `bili:${tid}`, title: 'B站·' + (toP ?? tid) }, fwd, []);
				r = { ok: okSend, delivered: okSend };
			} else if (tplat === 'douyin') {
				const dcfg = this.douyinConfig();
				if (!dcfg.enabled) return { ok: false, delivered: false, reason: '抖音那边没开' };
				if (this.douyin === null || !this.douyin.connected) return { ok: false, delivered: false, reason: '抖音没连上' };
				// 抖音必须有确认过的会话 ID 才发：昵称只能用来找会话，证明不了对面是谁。
				const convId = String(getKv(this.db, `douyin.convId.${to}`, '') ?? '').trim();
				if (!/^0:1:\d+:\d+$/.test(convId)) return { ok: false, delivered: false, reason: '要带给的人还没跟她确认过抖音会话，没法发' };
				// 会话名要用**游标里的真实昵称**（抖音靠它 enterChat 找会话），
				// 不能用 person.display_name —— 那是消息昵称，主人还能在「人物与关系」里改，
				// 改了就跟抖音上的名字对不上，发不出去。
				const toName = relayDouyinName(this.db, to);
				if (toName === null) return { ok: false, delivered: false, reason: '认不出这个抖音会话叫什么名字（还没读到过它的会话列表），暂时发不了' };
				const row = { channel_id: `douyin:${toName}`, title: '抖音·' + toName };
				const dr = await this.sendDouyin(row, fwd, [], convId);
				r = { ok: dr.ok === true, delivered: dr.delivered === true, reason: dr.error ?? '' };
			} else {
				return { ok: false, delivered: false, reason: '只认 qq / bili / douyin 的 uid' };
			}
			if (r.ok === true) {
				setKvRelay(this.db, key, used + 1);
				try { this.soul.journalOut?.(relayChannelOf(to), fwd); } catch { /* 日志失败不影响 */ }
				const toP = relayPersonName(this.db, to);
				this.note('relay', { channelId: relayChannelOf(to), text: fwd, reason: `${fromP ?? from} 让带给 ${toP ?? to} 的（${plat}）` });
			}
			return { ok: r.ok === true, delivered: r.delivered === true, reason: r.ok === true ? '' : (r.reason || '发送时报错了，看日志') };
		} catch (error) {
			const msg = String(error instanceof Error ? error.message : error);
			this.log('error', `[fish-soul] 传话失败：${msg}`);
			return { ok: false, delivered: false, reason: msg.slice(0, 120) };
		}
	}
};
