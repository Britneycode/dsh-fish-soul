/**
 * slang.js —— 学群里的说法：每个群自己的梗 / 黑话 / 说话风格。
 *
 * 网关把群里的每句话（不管点没点名）交给 observe()；攒够 minLines 条新话、且离上次学 ≥ intervalHours，
 * 就交给模型（功能 slang）提炼：这个群特有的词和意思、说话风格。结果存 kv `slang.<channelId>`，
 * 在这个群聊天时作为 [这个群的说话习惯] / [群里的梗] 进瞬态块（先放这轮提到的）。
 */
import { getKv, setKv } from './db.js';

const LINES_KEEP = 300;
const MAX_TERMS = 40;
const LEARNS_PER_DAY = 4;
const PLACEHOLDER_ONLY = /^(【[^】]*】\s*)+$/;

export function slangConfig(raw) {
	const v = raw ?? {};
	const num = (x, d, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
	return { enabled: v.enabled !== false, minLines: Math.floor(num(v.minLines, 60, 10, 1000)), intervalHours: num(v.intervalHours, 6, 0, 168) };
}

export function slangPrompt({ personaName, title, existing, style, lines }) {
	return `你是「${personaName}」，在 QQ 群「${title}」里。下面是群里最近的聊天。找出这个群**特有**的说法：梗、黑话、外号、缩写、` +
		'反复出现的口头禅（大家都懂的普通词不要），每个写清楚意思和一句原话例子；再用一句话（≤60 字）总结这个群说话的风格（语气、长短、爱用什么表情 / 符号）。' +
		(existing.length > 0 ? `\n已经知道的（意思变了就更新，不再用的放进 drop）：${existing.map((t) => `${t.term}=${t.meaning}`).join('；')}` : '') +
		(style ? `\n之前总结的风格：${style}` : '') +
		'\n只输出 JSON：{"terms":[{"term":"…","meaning":"…","example":"…"}],"style":"…","drop":["…"]}，terms 最多 10 个，拿不准的别写。\n聊天：\n' +
		lines.map((l) => `${l.name}：${l.text}`).join('\n');
}

export class SlangLearner {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {(prompt: string, opts?: object) => Promise<string|null>} deps.callLlm
	 * @param {() => ReturnType<typeof slangConfig>} deps.getConfig
	 * @param {() => string} deps.personaName
	 * @param {(channelId: string) => string} [deps.titleOf]
	 */
	constructor({ db, callLlm, getConfig, personaName, titleOf, log }) {
		Object.assign(this, { db, callLlm, getConfig, personaName });
		this.titleOf = titleOf ?? ((c) => c);
		this.log = log ?? (() => {});
		this.buffers = new Map(); // channelId → { lines, newCount, dirty }
		this.timer = null;
		this.running = null;
	}

	start(intervalMs = 10 * 60_000) {
		this.stop();
		this.timer = setInterval(() => { void this.tick(); }, intervalMs);
		this.timer.unref?.();
	}

	stop() {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		this.flush();
	}

	buffer(channelId) {
		let b = this.buffers.get(channelId);
		if (!b) {
			const saved = getKv(this.db, `slang.lines.${channelId}`, null);
			b = { lines: Array.isArray(saved?.lines) ? saved.lines : [], newCount: Number(saved?.newCount) || 0, dirty: 0 };
			this.buffers.set(channelId, b);
		}
		return b;
	}

	/** 网关：群里的一句话。 */
	observe(channelId, name, text) {
		if (!this.getConfig().enabled || !String(channelId).startsWith('group:')) return;
		const t = String(text ?? '').replace(/\s+/g, ' ').trim();
		if (t === '' || PLACEHOLDER_ONLY.test(t)) return;
		const b = this.buffer(channelId);
		b.lines.push({ name: String(name ?? '').slice(0, 20), text: t.slice(0, 200), t: Date.now() });
		if (b.lines.length > LINES_KEEP) b.lines.splice(0, b.lines.length - LINES_KEEP);
		b.newCount++;
		if (++b.dirty >= 20) this.flushOne(channelId, b);
	}

	flushOne(channelId, b) {
		setKv(this.db, `slang.lines.${channelId}`, { lines: b.lines, newCount: b.newCount });
		b.dirty = 0;
	}

	flush() {
		for (const [c, b] of this.buffers) if (b.dirty > 0) this.flushOne(c, b);
	}

	data(channelId) {
		return getKv(this.db, `slang.${channelId}`, null) ?? { terms: [], style: '', learnedAt: 0, learns: {} };
	}

	/** 定时：攒够了、隔够了、今天没学满就学一次（一次只学一个群）。 */
	async tick() {
		const cfg = this.getConfig();
		if (!cfg.enabled || this.running) return;
		const keys = new Set([...this.buffers.keys(), ...this.db.prepare("SELECT key FROM kv WHERE key LIKE 'slang.lines.%'").all().map((r) => r.key.slice('slang.lines.'.length))]);
		for (const channelId of keys) {
			const b = this.buffer(channelId);
			const d = this.data(channelId);
			const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
			if (b.newCount < cfg.minLines || Date.now() - (d.learnedAt || 0) < cfg.intervalHours * 3600_000 || (d.learns?.[day] ?? 0) >= LEARNS_PER_DAY) continue;
			await this.learn(channelId);
			return;
		}
	}

	/** 立刻学一次（设置页按钮 / 定时）。 */
	async learn(channelId) {
		if (this.running) return { ok: false, error: '正在学别的群，稍等' };
		const b = this.buffer(channelId);
		if (b.lines.length < 5) return { ok: false, error: '这个群的话还太少' };
		this.running = channelId;
		try {
			const d = this.data(channelId);
			let lines = b.lines.slice(-200);
			while (lines.length > 20 && lines.reduce((s, l) => s + l.text.length + l.name.length + 2, 0) > 6000) lines = lines.slice(Math.ceil(lines.length / 5));
			const text = await this.callLlm(slangPrompt({ personaName: this.personaName(), title: this.titleOf(channelId), existing: d.terms, style: d.style, lines }), { maxTokens: 900 });
			if (text === null) return { ok: false, error: '模型没回（看看「模型」页有没有可用的模型）' };
			let parsed;
			try { parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch { parsed = null; }
			if (!parsed || typeof parsed !== 'object') return { ok: false, error: '模型回的不是 JSON' };
			const drop = new Set((Array.isArray(parsed.drop) ? parsed.drop : []).map((x) => String(x).trim()));
			const terms = d.terms.filter((t) => t.byUser === true || !drop.has(t.term)); // 主人加的不被模型删
			let added = 0;
			for (const raw of (Array.isArray(parsed.terms) ? parsed.terms : []).slice(0, 10)) {
				const term = String(raw?.term ?? '').trim().slice(0, 20);
				const meaning = String(raw?.meaning ?? '').trim().slice(0, 80);
				if (term === '' || meaning === '') continue;
				const example = String(raw?.example ?? '').trim().slice(0, 80);
				const hit = terms.find((t) => t.term === term);
				if (hit) { if (!hit.byUser) Object.assign(hit, { meaning, example: example || hit.example, updatedAt: Date.now() }); }
				else { terms.unshift({ term, meaning, example, updatedAt: Date.now() }); added++; }
			}
			const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
			const style = typeof parsed.style === 'string' && parsed.style.trim() !== '' && !d.styleByUser ? parsed.style.trim().slice(0, 100) : d.style;
			setKv(this.db, `slang.${channelId}`, { ...d, terms: terms.slice(0, MAX_TERMS), style, learnedAt: Date.now(), learns: { [day]: (d.learns?.[day] ?? 0) + 1 } });
			b.newCount = 0;
			this.flushOne(channelId, b);
			return { ok: true, added, total: Math.min(MAX_TERMS, terms.length) };
		} finally {
			this.running = null;
		}
	}

	/** 聊天时给她看的几行（先放这轮提到的词）。 */
	contextLines(channelId, recentText = '') {
		if (!this.getConfig().enabled) return [];
		const d = this.data(channelId);
		const out = [];
		if (d.style) out.push(`[这个群的说话习惯] ${d.style}`);
		if (d.terms.length > 0) {
			const t = String(recentText);
			const mentioned = d.terms.filter((x) => t.includes(x.term));
			const rest = d.terms.filter((x) => !t.includes(x.term));
			const pick = [...mentioned, ...rest].slice(0, 10);
			out.push(`[群里的梗（自然用，别硬套）] ${pick.map((x) => `${x.term}：${x.meaning}`).join('；')}`);
		}
		return out;
	}

	/** 设置页：改风格 / 加词 / 删词。 */
	edit(channelId, { style, add, remove }) {
		const d = this.data(channelId);
		if (typeof style === 'string') { d.style = style.trim().slice(0, 100); d.styleByUser = d.style !== ''; }
		if (typeof remove === 'string') d.terms = d.terms.filter((t) => t.term !== remove);
		if (add && typeof add.term === 'string' && add.term.trim() !== '' && typeof add.meaning === 'string' && add.meaning.trim() !== '') {
			d.terms = d.terms.filter((t) => t.term !== add.term.trim());
			d.terms.unshift({ term: add.term.trim().slice(0, 20), meaning: add.meaning.trim().slice(0, 80), example: '', byUser: true, updatedAt: Date.now() });
			d.terms = d.terms.slice(0, MAX_TERMS);
		}
		setKv(this.db, `slang.${channelId}`, d);
		return d;
	}

	state() {
		const keys = new Set([...this.buffers.keys(),
			...this.db.prepare("SELECT key FROM kv WHERE key LIKE 'slang.%'").all().map((r) => r.key.replace(/^slang\.(lines\.)?/, ''))]);
		return [...keys].filter((c) => c.startsWith('group:')).map((channelId) => {
			const d = this.data(channelId);
			const b = this.buffer(channelId);
			return { channelId, title: this.titleOf(channelId), style: d.style, styleByUser: d.styleByUser === true, terms: d.terms, learnedAt: d.learnedAt || null, lines: b.lines.length, newLines: b.newCount };
		}).sort((a, b) => (b.learnedAt ?? 0) - (a.learnedAt ?? 0) || b.lines - a.lines);
	}
}
