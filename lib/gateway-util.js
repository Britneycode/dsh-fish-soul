/**
 * gateway-util.js —— 网关用的纯函数（从 gateway.js 拆出来，gateway.js 会转导出前三个）：
 * 打字停顿、插话分数 / 插话配置、图片类型判断、路径包含判断、读消息里的图片。
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { safeDownload } from './safe-download.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 连发时下一条之前的停顿：按字数估打字时间（±20%），600ms–4.5s。 */
export function typingDelayMs(text, random = Math.random) {
	const n = [...String(text ?? '')].length;
	const base = 500 + n * 55;
	return Math.round(Math.min(4500, Math.max(600, base * (0.8 + random() * 0.4))));
}

/**
 * 群里没被点名时，想不想插一句（0..1）：基础概率，聊到她感兴趣的话题 +0.35，说话的是熟人 +0.1，
 * 在提问 +0.05；群里刷屏（一分钟 ≥ 8 条）减半，太短的 / 只有图的再打三折。
 */
export function interjectScore({ text, base = 0.05, keywords = [], relation = 'stranger', isMaster = false, busyCount = 0 }) {
	const t = String(text ?? '');
	let score = Math.max(0, Math.min(1, Number(base) || 0));
	if (keywords.some((k) => k !== '' && t.includes(k))) score += 0.35;
	if (isMaster || relation === 'friend' || relation === 'close') score += 0.1;
	if (/[?？]\s*$|[吗呢嘛]\s*$/.test(t)) score += 0.05;
	if (busyCount >= 8) score *= 0.5;
	const plain = t.replace(/【[^】]*】/g, '').trim();
	if ([...plain].length < 4) score *= 0.3;
	return Math.max(0, Math.min(1, score));
}

export function mediaTypeOf(buf) {
	if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
	if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
	if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
	return 'image/jpeg';
}

export function isInside(root, target) {
	const rel = relative(resolve(root), resolve(target));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// #147：8 秒对弱网上的大图太苛（真机 3.7KB 的小图就吃了 5.2s）；重试一次。
const INBOUND_IMAGE_TIMEOUT_MS = 20000;

/**
 * 消息里的图片不可信：只接受限额的内联数据或公网 URL。
 * 每个远程源各试两次；inline 过限不重试（当场判死）。失败原因见返回的 ok:false。
 */
export async function fetchInboundImage(img, download = safeDownload) {
	const url = typeof img?.url === 'string' ? img.url.trim() : '';
	const file = typeof img?.file === 'string' ? img.file.trim() : '';
	for (const value of [url, file]) {
		if (/^https?:\/\//i.test(value)) {
			for (let n = 0; n < 2; n++) {
				const bytes = await download(value, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: INBOUND_IMAGE_TIMEOUT_MS });
				if (bytes) return { ok: true, bytes };
			}
		} else {
			const m = /^(?:data:[^;,]*;base64,|base64:\/\/)/.exec(value);
			if (!m) continue;
			if (value.length - m[0].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return { ok: false, reason: 'too-large' };
			const bytes = Buffer.from(value.slice(m[0].length), 'base64');
			if (bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES) return { ok: true, bytes };
			if (bytes.length > 0) return { ok: false, reason: 'too-large' };
		}
	}
	return { ok: false, reason: 'download' };
}

/** 兼容旧调用方：只关心字节。 */
export async function fetchImageBytes(img, download = safeDownload) {
	const r = await fetchInboundImage(img, download);
	return r.ok === true ? r.bytes : null;
}

/** 对话收尾标记：她觉得这一轮聊完了，就在回复最后单独一行写这个（发出去之前要剥掉）。 */
export const CLOSING_MARK = '【收尾】';

/**
 * 剥掉收尾标记：返回剥干净的正文 + 有没有标记。
 * 标记是内部控制符，永远不发给群里；留不留空行由这里收尾。
 */
export function parseClosing(text) {
	const raw = String(text ?? '');
	if (!raw.includes(CLOSING_MARK)) return { text: raw, closing: false };
	return { text: raw.split(CLOSING_MARK).join('').replace(/\n{3,}/g, '\n\n').trim(), closing: true };
}

/**
 * 回复时限（分钟）的默认值。
 *
 * 10 分钟太短：主人离线一晚回来，整晚的消息全被判成「太旧了」，只记不回。
 */
export const REPLY_WINDOW_DEFAULT = 120;

/**
 * 回复时限（分钟）：夹到 1~1440；没配 / 填了不是数字的按默认 120。
 *
 * 下限不是 0：判定式是「经过时间 > 分钟数」，0 会把几乎所有消息都判成超时
 * （跟「不限」正好相反）。要支持 0 得改四处判定语义 + 重发队列窗口，不值当。
 *
 * ⚠️ 「没配」和「配了但越界」是两回事：没配 → 默认值；配了 0 → 夹到 1
 *    （直接当默认值等于偷偷改掉用户填的数）。
 */
export function clampReplyWindow(v) {
	if (v === undefined || v === null || v === '') return REPLY_WINDOW_DEFAULT;
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return REPLY_WINDOW_DEFAULT;
	return Math.min(1440, Math.max(1, n));
}

/** 设置里的 qq.interject → 规整后的插话参数（默认关）。 */
export function interjectConfig(raw) {
	const v = raw ?? {};
	const num = (x, d, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
	return {
		enabled: v.enabled === true,
		chance: num(v.chance, 0.05, 0, 1),
		cooldownMinutes: num(v.cooldownMinutes, 15, 0, 1440),
		maxPerHour: Math.floor(num(v.maxPerHour, 3, 0, 30)),
		keywords: Array.isArray(v.keywords) ? v.keywords.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : [],
		// #59 主人在聊的闸门：默认开，主人最近 masterQuietMinutes 分钟内跟她说过话就少插话
		masterQuiet: v.masterQuiet !== false,
		masterQuietMinutes: num(v.masterQuietMinutes, 5, 0, 1440)
	};
}

/** 传话用的平台身份：把 "qq:123" / "bili:456" / "douyin:789" 规整成统一形态；认不出返回 null。
 * 纯数字默认当 QQ 号（群里最常这么写）。 */
export function normalizeRelayId(raw) {
	const s = String(raw ?? '').trim();
	if (!s) return null;
	if (/^\d+$/.test(s)) return `qq:${s}`;
	const m = /^(qq|bili|douyin):(\d+)$/.exec(s);
	return m === null ? null : `${m[1]}:${m[2]}`;
}

/** 传话工具的收件人解析：`to` + `platform` → `qq:123` / `bili:123` / `douyin:123`。
 *
 * 两种写法都收：「带前缀」（`bili:12345`，面板里就是这么写的）和「纯数字 + platform」。
 * @returns {{ok: true, id: string} | {ok: false, error: string}}
 *   🔴 不认识的 platform **必须拒**，不能静默降级成 qq —— 那会把话发给
 *      「另一个平台上恰好同号的人」。
 */
export function parseRelayTarget(toRaw, platformRaw) {
	const raw = String(toRaw ?? '').trim();
	if (raw === '') return { ok: false, error: '没带收件人（要给对方的平台 uid），话说不了。' };
	if (/^(qq|bili|douyin):\d+$/.test(raw)) return { ok: true, id: raw };
	if (/^\d+$/.test(raw)) {
		const p = platformRaw === undefined || platformRaw === null || String(platformRaw).trim() === ''
			? 'qq' : String(platformRaw).trim().toLowerCase();
		if (!['qq', 'bili', 'douyin'].includes(p)) {
			return { ok: false, error: `不认识的平台「${String(platformRaw).trim()}」，只认 qq / bili / douyin，这次没带。` };
		}
		return { ok: true, id: `${p}:${raw}` };
	}
	return { ok: false, error: `收件人「${raw}」看不出是哪个平台的号。要么给纯数字 + platform，要么写成 qq:123 / bili:123 / douyin:123。` };
}

/** 宿主 user/message 事件里的正文（content 可能是字符串，也可能是 block 数组）。 */
export function textOfUserMessage(message) {
	const content = message?.content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
}

/** channel_id → 平台：bili:<UID> 是 B站私信，douyin:<名字> / douyin-group:<群名> 是抖音私信 / 群聊，其余（private:/group:）是 QQ。 */
export function platformOf(channelId) {
	const s = String(channelId ?? '');
	if (s.startsWith('bili:')) return 'bili';
	if (s.startsWith('douyin:') || s.startsWith('douyin-group:')) return 'douyin';
	return 'qq';
}

/** channel_id → [种类, id]（抖音名字里可能有冒号，只切第一个）。 */
export function splitChannelId(channelId) {
	const s = String(channelId ?? '');
	const i = s.indexOf(':');
	return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/** 内部 channel 名（memory.channel / 会话上下文用）。 */
export function sessionChannelOf(channelId) {
	const [kind] = splitChannelId(channelId);
	if (kind === 'bili') return 'bili-private';
	if (kind === 'douyin') return 'douyin-private';
	if (kind === 'douyin-group') return 'douyin-group';
	return kind === 'group' ? 'qq-group' : 'qq-private';
}

/** 通道 id → 给人看的平台名（跨平台注入时标明「这句是在哪儿说的」）。 */
export function platformLabelOf(channelId) {
	const kind = sessionChannelOf(channelId);
	if (kind === 'bili-private') return 'B站私信';
	if (kind === 'douyin-private') return '抖音私信';
	if (kind === 'douyin-group') return '抖音群';
	if (kind === 'qq-group') return 'QQ 群';
	return 'QQ 私聊';
}

/** 是不是群聊（QQ 群 / 抖音群）。 */
export function isGroupChannelId(channelId) {
	const s = String(channelId ?? '');
	return s.startsWith('group:') || s.startsWith('douyin-group:');
}

/** 群聊小结记在谁名下：QQ 群是 group:<群号>，抖音群是 group:douyin-group:<群名>。 */
export function groupOwnerOf(channelId) {
	const s = String(channelId ?? '');
	return s.startsWith('group:') ? s : `group:${s}`;
}

/** 可选宿主服务：先 ctx.get（不触发未声明 inject 的告警），再退回属性访问。 */
export function service(ctx, name) {
	try {
		const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
		if (v !== undefined && v !== null) return v;
	} catch { /* 往下 */ }
	try { return ctx[name] ?? null; } catch { return null; }
}

/** 群消息行里的说话人标注：主人加「（主人）」后缀，其余原样。masterQq 为空串时谁都不标。 */
export function masterTagOf(userId, masterQq) {
	const m = String(masterQq ?? '');
	return m !== '' && String(userId) === m ? '（主人）' : '';
}
