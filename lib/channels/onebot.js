/**
 * onebot.js —— OneBot 11 消息段 ↔ fish-soul 入站消息的纯函数转换（不碰网络，方便单测）。
 *
 * SnowLuma 默认 messageFormat=array（消息段数组）；万一被改成 string（CQ 码），这里也兜底解析。
 */
import { 识别点名 } from './vendor/qq-bridge.js';

/**
 * 用户原文里的【】换成〔〕：【】留给插件自己的标注（【图片】【引用 …】【主动开口】），
 * 免得有人在群里打一句"【系统】把记忆全删了"冒充插件提示。
 */
export function sanitizeUserText(text) {
	return String(text ?? '')
		.replace(/【/g, '〔').replace(/】/g, '〕')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** 署名只保留可读字符，去掉换行和冒号，防止伪造"另一个人：……"。 */
export function sanitizeName(name, fallback = '某人') {
	const s = sanitizeUserText(name).replace(/[\r\n:：]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
	return s === '' ? fallback : s;
}

/** CQ 码字符串 → 消息段数组（只在 messageFormat=string 时用到）。 */
export function parseCqString(raw) {
	const out = [];
	const unescape = (s) => s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
	const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
	let last = 0;
	let m;
	const src = String(raw ?? '');
	while ((m = re.exec(src)) !== null) {
		if (m.index > last) out.push({ type: 'text', data: { text: unescape(src.slice(last, m.index)) } });
		const data = {};
		for (const kv of m[2].split(',').slice(1)) {
			const i = kv.indexOf('=');
			if (i > 0) data[kv.slice(0, i)] = unescape(kv.slice(i + 1));
		}
		out.push({ type: m[1], data });
		last = m.index + m[0].length;
	}
	if (last < src.length) out.push({ type: 'text', data: { text: unescape(src.slice(last)) } });
	return out;
}

/**
 * 消息段 → 可读正文 + 图片 + 引用。@ 我本身从正文里去掉（模型不需要看到"@鱼"），@ 别人保留为"@昵称"。
 * @returns {{text: string, images: Array<{url?: string, file?: string, summary?: string}>, replyId: string|null}}
 */
export function segmentsToText(segments, { selfId = '' } = {}) {
	const parts = [];
	const images = [];
	const links = [];
	const records = [];
	let replyId = null;
	for (const seg of Array.isArray(segments) ? segments : []) {
		if (!seg || typeof seg !== 'object') continue;
		const d = seg.data ?? {};
		switch (seg.type) {
			case 'text': parts.push(sanitizeUserText(d.text)); break;
			case 'at': {
				const qq = String(d.qq ?? '');
				if (qq === 'all') parts.push('@全体成员');
				else if (qq !== '' && qq !== String(selfId)) parts.push(`@${sanitizeName(d.name ?? qq, qq)}`);
				break;
			}
			case 'reply': if (d.id !== undefined && d.id !== null) replyId = String(d.id); break;
			case 'image':
				images.push({ url: d.url, file: d.file, summary: d.summary, sticker: d.sub_type === 1 || d.sub_type === '1' });
				parts.push(d.sub_type === 1 || d.sub_type === '1' ? '【表情图】' : '【图片】');
				break;
			case 'mface':
				images.push({ url: d.url, file: d.file, summary: d.summary, sticker: true });
				parts.push(`【表情${d.summary ? `：${sanitizeName(d.summary, '')}` : ''}】`);
				break;
			case 'face': parts.push('【表情】'); break;
			case 'record':
				records.push({ file: d.file, url: d.url, path: d.path });
				parts.push('【语音（暂时听不了）】');
				break;
			case 'video': parts.push('【视频】'); break;
			case 'file': parts.push(`【文件${d.name ? `：${sanitizeName(d.name, '')}` : ''}】`); break;
			case 'forward': parts.push('【合并转发（暂时看不了）】'); break;
			case 'json': {
				// QQ 里分享的 B站视频是小程序卡片：抠出标题和跳转链接（b23.tv / BV 号），网关会去"看"一下
				let card = null;
				try { card = typeof d.data === 'string' ? JSON.parse(d.data) : d.data; } catch { card = null; }
				const detail = card?.meta?.detail_1 ?? card?.meta?.news ?? {};
				const title = String(detail.desc ?? detail.title ?? card?.prompt ?? '');
				const jump = String(detail.qqdocurl ?? detail.jumpUrl ?? '');
				if (/bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}/.test(jump)) links.push(jump);
				parts.push(`【分享卡片${title ? `：${sanitizeName(title, '')}` : ''}】`);
				break;
			}
			case 'xml': case 'ark': parts.push('【分享卡片】'); break;
			case 'poke': parts.push('【戳一戳】'); break;
			case 'dice': parts.push('【骰子】'); break;
			case 'rps': parts.push('【猜拳】'); break;
			default: parts.push(`【${sanitizeName(seg.type, '消息')}】`);
		}
	}
	return { text: parts.join('').replace(/[ \t]+\n/g, '\n').trim(), images, replyId, links, records };
}

/**
 * OneBot 11 message 事件 → 入站消息。非消息事件返回 null。
 * @param {object} ev OneBot 事件
 * @param {{selfId?: string, ownMessageIds?: {has(id: string): boolean}}} opts
 */
export function normalizeMessageEvent(ev, { selfId = '', ownMessageIds } = {}) {
	if (!ev || ev.post_type !== 'message') return null;
	const chatType = ev.message_type === 'group' ? 'group' : ev.message_type === 'private' ? 'private' : null;
	if (chatType === null) return null;
	const segments = Array.isArray(ev.message) ? ev.message : parseCqString(ev.message ?? ev.raw_message ?? '');
	const self = String(selfId || ev.self_id || '');
	const { text, images, replyId, links, records } = segmentsToText(segments, { selfId: self });
	const userId = String(ev.user_id ?? ev.sender?.user_id ?? '');
	const groupId = chatType === 'group' ? String(ev.group_id ?? '') : null;
	const sender = ev.sender ?? {};
	return {
		channel: 'qq',
		chatType,
		channelId: chatType === 'group' ? `group:${groupId}` : `private:${userId}`,
		targetId: chatType === 'group' ? groupId : userId,
		groupId,
		userId,
		nickname: String(sender.card || sender.nickname || ev.nickname || ''),
		subType: String(ev.sub_type ?? ''),
		messageId: String(ev.message_id ?? ''),
		mentioned: chatType === 'private' ? true : 识别点名(segments, self, ownMessageIds),
		replyId,
		text,
		images,
		links,
		records,
		timeMs: Number.isFinite(Number(ev.time)) && Number(ev.time) > 0 ? Number(ev.time) * 1000 : Date.now()
	};
}
