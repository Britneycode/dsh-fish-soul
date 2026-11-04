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
		.replace(/\[/g, '［').replace(/\]/g, '］') // 上下文里 [这样] 的段落只能是插件写的，对方打不出来
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** 署名只保留可读字符，去掉换行和冒号，防止伪造"另一个人：……"。 */
export function sanitizeName(name, fallback = '某人') {
	const s = sanitizeUserText(name).replace(/[\r\n:：]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
	return s === '' ? fallback : s;
}

/** CQ 码字符串 → 消息段数组（只在 messageFormat=string 时用到）。 */
function parseCqString(raw) {
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
 * QQ 经典小黄脸（face 段只有 id，没有名字）→ 中文名。
 * 只收常用的 0–60；不认识的 id 直接显示「表情(数字)」，不让它变成一句空话。
 */
export const FACE_NAMES = {
	0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴',
	8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过',
	16: '酷', 17: '抓狂', 18: '吐', 19: '偷笑', 20: '可爱', 21: '白眼', 22: '傲慢', 23: '饥饿',
	24: '困', 25: '惊恐', 26: '流汗', 27: '憨笑', 28: '大兵', 29: '奋斗', 30: '咒骂', 31: '疑问',
	32: '嘘', 33: '晕', 34: '折磨', 35: '衰', 36: '骷髅', 37: '敲打', 38: '再见', 39: '发抖',
	40: '爱情', 41: '跳跳', 42: '拥抱', 43: '蛋糕', 44: '闪电', 45: '炸弹', 46: '刀', 47: '足球',
	48: '瓢虫', 49: '便便', 50: '咖啡', 51: '饭', 52: '药', 53: '玫瑰', 54: '凋谢', 55: '示爱',
	56: '爱心', 57: '心碎', 58: '会议', 59: '包', 60: '礼物'
};

/** face 段 → 【表情：呲牙】；认不出的 id 显示成「表情(128)」而不是空话。 */
export function faceLabel(id) {
	const raw = String(id ?? '').trim();
	if (raw === '') return '表情';
	const key = Number(raw);
	if (Number.isInteger(key) && FACE_NAMES[key]) return FACE_NAMES[key];
	return `表情(${raw})`;
}

/**
 * 消息段 → 可读正文 + 图片 + 引用。@ 我本身从正文里去掉（模型不需要看到"@鱼"），@ 别人保留为"@昵称"。
 * @returns {{text: string, images: Array<{url?: string, file?: string, summary?: string}>, files: Array<{name: string, path: string, url: string, size: number}>, replyId: string|null}}
 */
export function segmentsToText(segments, { selfId = '' } = {}) {
	const parts = [];
	const images = [];
	const links = [];
	const records = [];
	const forwards = [];
	const files = [];
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
			case 'face': parts.push(`【表情：${faceLabel(d.id)}】`); break;
			case 'record':
				records.push({ file: d.file, url: d.url, path: d.path });
				parts.push('【语音（暂时听不了）】');
				break;
			case 'video': parts.push('【视频】'); break;
			case 'file':
				// 附件：正文里留占位，能不能读由网关那边看路径和开关决定
				// SnowLuma 不给 path，给的是 file_id（d.id / d.file_id）+ file_hash，要用 get_private_file_url 换链接
				files.push({
					name: sanitizeName(d.name, ''),
					path: d.path ?? '',
					url: d.url ?? '',
					size: Number(d.size) || 0,
					fileId: String(d.id ?? d.file_id ?? '').trim(),
					fileHash: String(d.file_hash ?? '').trim()
				});
				parts.push(`【文件${d.name ? `：${sanitizeName(d.name, '')}` : ''}】`);
				break;
			case 'forward':
				// 网关回复前会用 get_forward_msg 展开（一层，限条数）；展开不了就保持这个占位
				forwards.push({ id: String(d.id ?? ''), content: Array.isArray(d.content) ? d.content : null });
				parts.push('【合并转发（暂时看不了）】');
				break;
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
	return { text: parts.join('').replace(/[ \t]+\n/g, '\n').trim(), images, replyId, links, records, forwards, files };
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
	const { text, images, replyId, links, records, forwards, files } = segmentsToText(segments, { selfId: self });
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
		forwards,
		files,
		timeMs: Number.isFinite(Number(ev.time)) && Number(ev.time) > 0 ? Number(ev.time) * 1000 : Date.now()
	};
}
