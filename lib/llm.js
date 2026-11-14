/**
 * llm.js —— 插件自己调模型（日程 / Dream / 刷视频感受 / 导入提炼 / 学群里的说法）。
 *
 * v0.7：
 * - 选模型：设置里按功能指定的 { provider, model } → DSH 的默认模型（agentDefaultModel）→ 第一个提供方的第一个模型。
 *   v0.6 之前只认 listProviders() 里带 models 的提供方，宿主的 listProviders() 只有 { id, name }，
 *   于是 provider / model 都没传、调用直接失败（fail-open 返回 null，日程 / Dream 一直在用兜底）。
 * - 用量：每次调用按「天 × 功能 × 模型」记次数和 token（宿主流里有 usage 块就用真的，没有就按字数估），
 *   存 kv `usage.YYYY-MM-DD`，留 35 天；设置页按主人填的单价（元 / 百万 token）估花费。
 */
import { getKv, setKv } from './db.js';

/** 设置页里能单独选模型的功能。 */
export const FEATURES = [
	['dream', '整理记忆 / 写印象'],
	['extract', '聊完记一下'],
	['schedule', '排日程'],
	['browse', '刷视频写感受'],
	['social', '发动态 / 回评论'],
	['import', '导入聊天记录'],
	['slang', '学群里的说法'],
	['diary', '写日记'],
	['mood', '每轮判断心情'],
	['other', '其他']
];
const FEATURE_IDS = new Set(FEATURES.map(([id]) => id));
const KEEP_DAYS = 35;

function dayKey(ms) {
	return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 粗估 token：中文约 1 字 1 token，其余约 4 字符 1 token。 */
export function estimateTokens(text) {
	const s = String(text ?? '');
	let cjk = 0;
	for (const ch of s) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
	return Math.ceil(cjk + (s.length - cjk) / 4);
}

/** 推理模型的输出额度（思考 + 正文） */
const ROOMY_TOKENS = 8000;

/**
 * 把提示词和图片拼成 DSH 的 ContentBlock[]。
 * 图片块形状沿用插件收图时的写法：{ type: 'image', data(base64), mediaType, name }。
 */
export function buildContent(prompt, images = []) {
	const content = [{ type: 'text', text: prompt }];
	for (const img of images) {
		if (!img?.data) continue;
		content.push({ type: 'image', data: img.data, mediaType: img.mediaType ?? 'image/jpeg', ...(img.name ? { name: img.name } : {}) });
	}
	return content;
}

export class LlmRouter {
	/**
	 * @param {object} deps
	 * @param {object} deps.ctx 插件上下文（取 llm / agentDefaultModel 服务）
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => object} deps.getConfig
	 * @param {(level: string, msg: string) => void} [deps.log]
	 */
	constructor({ ctx, db, getConfig, log }) {
		Object.assign(this, { ctx, db, getConfig });
		this.log = log ?? (() => {});
		this.modelCache = new Map(); // provider → { at, models }
		this.lastError = '';
	}

	llm() {
		const l = this.ctx.get?.('llm') ?? this.ctx.llm;
		return l && typeof l.stream === 'function' ? l : null;
	}

	providers() {
		try { return (this.llm()?.listProviders?.() ?? []).map((p) => ({ id: String(p.id ?? p.name), name: String(p.name ?? p.id) })); } catch { return []; }
	}

	async models(provider) {
		const hit = this.modelCache.get(provider);
		if (hit && Date.now() - hit.at < 10 * 60_000) return hit.models;
		let models = [];
		try {
			const list = await this.llm()?.listModels?.(provider);
			models = (Array.isArray(list) ? list : []).map((m) => ({ id: String(m.id), name: String(m.name ?? m.id) }));
		} catch { models = []; }
		this.modelCache.set(provider, { at: Date.now(), models });
		return models;
	}

	/** DSH 设置里的默认模型（没有这个服务就 null）。 */
	hostDefault() {
		try {
			const s = this.ctx.get?.('agentDefaultModel')?.currentSelection?.();
			if (s && typeof s.provider === 'string' && s.provider !== '' && typeof s.model === 'string' && s.model !== '') {
				return { provider: s.provider, model: s.model };
			}
		} catch { /* 没配 */ }
		return null;
	}

	/** 这个功能用哪个模型：{ provider, model, from: 'feature' | 'host' | 'first' } 或 null。 */
	async resolve(feature) {
		const providers = this.providers();
		const known = (p) => providers.some((x) => x.id === p);
		const pick = this.getConfig().models?.[feature];
		if (pick && typeof pick.provider === 'string' && typeof pick.model === 'string' && pick.model !== '' && known(pick.provider)) {
			return { provider: pick.provider, model: pick.model, from: 'feature' };
		}
		const host = this.hostDefault();
		if (host !== null && (providers.length === 0 || known(host.provider))) return { ...host, from: 'host' };
		for (const p of providers) {
			const first = (await this.models(p.id))[0];
			if (first) return { provider: p.id, model: first.id, from: 'first' };
		}
		return null;
	}

	/**
	 * 调一次模型；失败 / 没有模型返回 null（调用方都有兜底）。
	 * @param {string} prompt
	 * @param {{signal?: AbortSignal, maxTokens?: number, feature?: string}} [opts]
	 */
	/**
	 * 把图片先交给宿主的附件库（admitPromptContent），拿到 { type:'image', attachment } 这种
	 * 真正能进模型的块。裸 base64 直接塞 messages 有的通道会静默丢掉——图就白抽了。
	 * 附件库不可用或拒收：退回纯文字，不让整次调用失败。
	 *
	 * `dropped` 标出「图没送进去、只发了文字」：调用方要的是图本身（看图打标）时不能拿这次结果当答案。
	 * @returns {Promise<{parts: object[], dropped: boolean}>}
	 */
	async promptPartsDetailed(prompt, images = [], feature = 'other') {
		const content = buildContent(prompt, images);
		if (images.length === 0) return { parts: content, dropped: false };
		try {
			const att = this.ctx.get?.('attachments') ?? this.ctx.attachments;
			if (att && typeof att.admitPromptContent === 'function') return { parts: await att.admitPromptContent(content), dropped: false };
			this.log('warn', `[fish-soul] ${feature}：宿主没有附件库，图片只能丢掉`);
		} catch (error) {
			const msg = String(error instanceof Error ? error.message : error).slice(0, 160);
			this.log('warn', `[fish-soul] ${feature}：图片没过附件库（${msg}），这次只看文字`);
		}
		return { parts: [{ type: 'text', text: prompt }], dropped: true };
	}

	/** 兼容老接口：只要内容块。 */
	async promptParts(prompt, images = [], feature = 'other') {
		return (await this.promptPartsDetailed(prompt, images, feature)).parts;
	}

	// #58：默认 600 对推理模型太小——光思考就 1000+ token，第一次必然白卷还白烧思考费。
	// 提到 1500 让大多数推理模型的第一轮能容下思考；maxTokens 是上限不是必花，普通模型不受影响。
	async call(prompt, { signal, maxTokens = 1500, feature = 'other', thinkFallback = false, images = [], needImages = false, _target, _tried } = {}) {
		const llm = this.llm();
		if (llm === null) return null;
		const f = FEATURE_IDS.has(feature) ? feature : 'other';
		let target = _target ?? null;
		if (target === null) { try { target = await this.resolve(f); } catch { target = null; } }
		// 一个都选不出来（宿主没报提供方 / 默认模型）：不指定，交给宿主自己决定（老版本的行为）
		if (target === null) target = { provider: undefined, model: '(宿主默认)', from: 'none' };
		// 推理模型会先把额度花在思考上：这个模型返回过空的，以后直接给大额度（只是上限，不用就不花）
		const roomy = this.roomy ?? (this.roomy = new Set());
		const key = `${target.provider ?? ''}/${target.model}`;
		const tried = _tried ?? new Set();
		const budget = roomy.has(key) ? Math.max(maxTokens, ROOMY_TOKENS) : maxTokens;
		let out = '';
		let think = '';
		let usage = null;
		let finish = '';
		let blockText = '';
		let emptyCode = false;
		const seen = new Set();
		try {
			const { parts, dropped } = await this.promptPartsDetailed(prompt, images, f);
			// needImages：图是这个调用的全部意义（看图打标）。图没送进去就别问了 ——
			// 模型看不见图却会照着提示词编一段像模像样的答案，那比没有答案更糟。
			// 🔴 这里以前是静默 return：调用方只看到 null，日志一片空白，
			//    表现是「模型说看不清」而查不出到底是图没送进去还是模型不认图。
			//    看图打标 / 导入表情全靠这条路，所以必须留一行，带上具体原因。
			if (dropped && needImages) {
				this.lastError = 'IMAGE_NOT_ADMITTED';
				this.log('warn', `[fish-soul] ${f}：图没送进模型（${target.model || '(宿主默认)'}），这次要的就是图，放弃`);
				return null;
			}
			for await (const chunk of llm.stream({
				...(target.provider !== undefined ? { provider: target.provider, model: target.model } : {}),
				// DSH 的 RequestMessage.content 是内容块数组（ContentBlock[]），不是字符串
				messages: [{ role: 'user', content: parts }],
				maxTokens: budget,
				temperature: 0.7,
				...(signal ? { signal } : {})
			})) {
				if (signal?.aborted) return null;
				const type = String(chunk?.type ?? typeof chunk);
				seen.add(type);
				if (type === 'text-delta') out += chunk.text ?? chunk.delta ?? '';
				else if (/reason|think/i.test(type)) think += String(chunk.text ?? chunk.delta ?? '');
				else if (type === 'block-end') {
					// block-end 带着拼好的整块：没收到 delta 的适配器靠它
					const b = chunk.block ?? {};
					if (b.type === 'text') blockText += String(b.text ?? '');
					else if (b.type === 'reasoning' && think === '') think = String(b.text ?? b.reasoning ?? '');
				} else if (type === 'usage' && chunk.usage) usage = chunk.usage;
				else if (type === 'finish' || type === 'done') {
					// DSH：finish { reason: { kind: 'stop' | 'max-tokens' | 'error' | 'aborted', failure? } }
					const r = chunk.reason ?? chunk.finishReason;
					const kind = typeof r === 'string' ? r : String(r?.kind ?? r?.unified ?? r?.type ?? '');
					finish = kind;
					if (kind === 'error' || kind === 'aborted') {
						const fl = r?.failure ?? {};
						// 空回复（EMPTY_RESPONSE）当空处理，走下面的放大额度 / 换模型
						if (fl.code === 'EMPTY_RESPONSE') { emptyCode = true; continue; }
						throw new Error(`${String(fl.message ?? kind).slice(0, 160)}${fl.code ? ` [${fl.code}]` : ''}${fl.status ? `（HTTP ${fl.status}）` : ''}`);
					}
				} else if (type === 'error' || type === 'failure') throw new Error(String(chunk.error?.message ?? chunk.message ?? 'stream error'));
			}
		} catch (error) {
			this.lastError = String(error instanceof Error ? error.message : error).slice(0, 200);
			this.record(f, target.model, { failed: true, inputTokens: estimateTokens(prompt), outputTokens: 0, estimated: true });
			// 带图调用失败（有的通道/模型不吃 image 块）：先退回纯文字重试一次。
			// 但调用方要的就是图（needImages）时不能这么退 —— 退成纯文字，模型看不见图还会
			// 照着提示词编一段，看图打标就会把编出来的标签落进库（比没标签更糟）。
			if (images.length > 0 && !needImages) {
				this.log('warn', `[fish-soul] ${f}：带图调用失败（${this.lastError}），退回纯文字重试`);
				return this.call(prompt, { signal, maxTokens, feature, thinkFallback, _target: target, _tried: tried });
			}
			if (images.length > 0) {
				this.log('warn', `[fish-soul] ${f}：带图调用失败（${this.lastError}），这次要的就是图，不再纯文字重试`);
				return null;
			}
			// 按功能选的模型报错（比如模型下线了）：换 DSH 默认模型试一次
			return this.fallback(prompt, { signal, maxTokens, feature, thinkFallback, images, needImages, tried: tried.add(key) });
		}
		const text = (out.trim() || blockText.trim());
		if (text === '' && budget < ROOMY_TOKENS && !signal?.aborted) {
			// 空回复多半是额度全花在思考上了：记住这个模型，放大额度再试一次
			roomy.add(key);
			this.record(f, target.model, { inputTokens: usage ? Number(usage.inputTokens) || 0 : estimateTokens(prompt), outputTokens: usage ? Number(usage.outputTokens) || 0 : 0, estimated: !usage, failed: true });
			return this.call(prompt, { signal, maxTokens, feature, thinkFallback, images, needImages, _target: target, _tried: tried });
		}
		this.record(f, target.model, usage
			? { inputTokens: Number(usage.inputTokens) || 0, outputTokens: Number(usage.outputTokens) || 0, estimated: false, failed: text === '' }
			: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(out), estimated: true, failed: text === '' });
		if (text !== '') { this.lastError = ''; return text; }
		// 正文是空的但思考里写出了要的 JSON（有的推理模型把答案留在思考里）：调用方允许就拿来用
		if (thinkFallback && /\{[\s\S]*\}/.test(think)) { this.lastError = ''; return think.trim(); }
		// 讲清楚空在哪：一个块都没收到 / 全是思考 / 被额度截断
		const bits = [];
		if (seen.size === 0) bits.push('一个数据块都没收到');
		else {
			if (emptyCode) bits.push('宿主判定为空回复');
			if (think) bits.push(`只有思考（${[...think].length} 字）`);
			if (usage) bits.push(`输出 ${Number(usage.outputTokens) || 0} token`);
			if (finish) bits.push(`结束原因 ${finish}`);
			bits.push(`收到 ${[...seen].join('/')}`);
		}
		this.lastError = `${target.model} 回了空内容（${bits.join('，')}）`;
		this.log('warn', `[fish-soul] ${f}：${this.lastError}`);
		return this.fallback(prompt, { signal, maxTokens, feature, thinkFallback, images, needImages, tried: tried.add(key) });
	}

	/** 这个模型不行（报错 / 空）：换 DSH 默认模型再试一次；默认模型也试过了就算了。 */
	async fallback(prompt, { signal, maxTokens, feature, thinkFallback, images = [], needImages = false, tried }) {
		if (signal?.aborted) return null;
		const host = this.hostDefault();
		if (host === null || tried.has(`${host.provider}/${host.model}`)) return null;
		const first = this.lastError;
		const r = await this.call(prompt, { signal, maxTokens, feature, thinkFallback, images, needImages, _target: { ...host, from: 'host' }, _tried: tried });
		if (r === null && first && !this.lastError.includes(first)) this.lastError = `${first}；换 ${host.model} 也没成：${this.lastError}`;
		return r;
	}

	/** 绑定功能名的调用函数（交给日程 / 刷视频 / 导入等模块）。 */
	bound(feature) {
		return (prompt, opts = {}) => this.call(prompt, { ...opts, feature: opts.feature ?? feature });
	}

	record(feature, model, { inputTokens, outputTokens, estimated, failed }) {
		try {
			const key = `usage.${dayKey(Date.now())}`;
			const day = getKv(this.db, key, {}) ?? {};
			const f = day[feature] ?? { calls: 0, failed: 0, in: 0, out: 0, estimated: 0, models: {} };
			f.calls++;
			if (failed) f.failed++;
			if (estimated) f.estimated++;
			f.in += inputTokens; f.out += outputTokens;
			const m = f.models[model] ?? { calls: 0, in: 0, out: 0 };
			m.calls++; m.in += inputTokens; m.out += outputTokens;
			f.models[model] = m;
			day[feature] = f;
			setKv(this.db, key, day);
			const days = getKv(this.db, 'usage.days', []) ?? [];
			const today = key.slice(6);
			if (!days.includes(today)) {
				days.push(today);
				days.sort();
				for (const old of days.splice(0, Math.max(0, days.length - KEEP_DAYS))) this.db.prepare('DELETE FROM kv WHERE key = ?').run(`usage.${old}`);
				setKv(this.db, 'usage.days', days);
			}
		} catch (error) {
			this.log('warn', `[fish-soul] 记用量失败：${String(error instanceof Error ? error.message : error)}`);
		}
	}

	/**
	 * 最近 n 天的用量：按功能、按模型汇总，按单价估花费（元）。
	 * @param {number} days
	 */
	usage(days = 7) {
		const prices = this.getConfig().modelPrices ?? {};
		const cost = (model, inTok, outTok) => {
			const p = prices[model];
			if (!p) return null;
			return (inTok * (Number(p.in) || 0) + outTok * (Number(p.out) || 0)) / 1e6;
		};
		const byFeature = {};
		const byModel = {};
		const daily = [];
		for (let i = days - 1; i >= 0; i--) {
			const d = dayKey(Date.now() - i * 86400_000);
			const day = getKv(this.db, `usage.${d}`, {}) ?? {};
			let calls = 0; let tokens = 0; let dayCost = 0;
			for (const [feature, f] of Object.entries(day)) {
				const bf = byFeature[feature] ?? { calls: 0, failed: 0, in: 0, out: 0, estimated: 0, cost: 0 };
				bf.calls += f.calls; bf.failed += f.failed; bf.in += f.in; bf.out += f.out; bf.estimated += f.estimated ?? 0;
				for (const [model, m] of Object.entries(f.models ?? {})) {
					const bm = byModel[model] ?? { calls: 0, in: 0, out: 0, cost: null };
					bm.calls += m.calls; bm.in += m.in; bm.out += m.out;
					const c = cost(model, m.in, m.out);
					if (c !== null) { bm.cost = (bm.cost ?? 0) + c; bf.cost += c; dayCost += c; }
					byModel[model] = bm;
				}
				byFeature[feature] = bf;
				calls += f.calls; tokens += f.in + f.out;
			}
			daily.push({ day: d, calls, tokens, cost: dayCost });
		}
		const total = Object.values(byFeature).reduce((s, f) => ({ calls: s.calls + f.calls, in: s.in + f.in, out: s.out + f.out, cost: s.cost + f.cost }), { calls: 0, in: 0, out: 0, cost: 0 });
		return { days, byFeature, byModel, daily, total, prices };
	}
}
