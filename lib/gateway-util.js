/**
 * gateway-util.js —— 网关用的纯函数（从 gateway.js 拆出来，gateway.js 会转导出前三个）：
 * 打字停顿、插话分数 / 插话配置、图片类型判断、路径包含判断、读消息里的图片。
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 读消息里的图片（url / file:// / base64:// / 本地路径），失败返回 null。 */
export async function fetchImageBytes(img) {
	const url = typeof img?.url === 'string' ? img.url.trim() : '';
	try {
		if (url.startsWith('data:')) {
			const m = /^data:[^;,]*;base64,/.exec(url);
			const buf = m ? Buffer.from(url.slice(m[0].length), 'base64') : null;
			return buf !== null && buf.length > 0 && buf.length <= MAX_IMAGE_BYTES ? buf : null;
		}
		if (/^https?:\/\//i.test(url)) {
			const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
			if (res.ok) {
				const buf = Buffer.from(await res.arrayBuffer());
				return buf.length <= MAX_IMAGE_BYTES ? buf : null;
			}
		} else if (url.startsWith('file://')) {
			return readFileSync(fileURLToPath(url));
		}
	} catch { /* 换 file 字段再试 */ }
	const file = typeof img?.file === 'string' ? img.file.trim() : '';
	try {
		if (file.startsWith('base64://')) return Buffer.from(file.slice(9), 'base64');
		if (/^https?:\/\//i.test(file)) {
			const res = await fetch(file, { signal: AbortSignal.timeout(8000) });
			if (res.ok) return Buffer.from(await res.arrayBuffer());
		}
	} catch { /* 放弃 */ }
	return null;
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
		keywords: Array.isArray(v.keywords) ? v.keywords.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : []
	};
}

/** channel_id → 平台：bili:<UID> 是 B站私信，douyin:<名字> 是抖音私信，其余（private:/group:）是 QQ。 */
export function platformOf(channelId) {
	const s = String(channelId ?? '');
	if (s.startsWith('bili:')) return 'bili';
	if (s.startsWith('douyin:')) return 'douyin';
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
	return kind === 'group' ? 'qq-group' : 'qq-private';
}

/** 可选宿主服务：先 ctx.get（不触发未声明 inject 的告警），再退回属性访问。 */
export function service(ctx, name) {
	try {
		const v = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
		if (v !== undefined && v !== null) return v;
	} catch { /* 往下 */ }
	try { return ctx[name] ?? null; } catch { return null; }
}
