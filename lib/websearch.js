// 上网查：除了 DSH 自带的 web_search，也可以填自己的搜索 API key（博查 / Tavily / Brave / SearXNG）
// 只做"搜一下 → 给模型看标题+摘要"，不抓网页全文。

export const WEB_PROVIDERS = [
	{ id: 'host', label: 'DSH 自带', needsKey: false, needsBaseURL: false, hint: '用 DSH 自己的 web_search / web_fetch（宿主得有这两个工具）' },
	{ id: 'bocha', label: '博查（国内直连）', needsKey: true, needsBaseURL: false, hint: '在 open.bochaai.com 注册，「API KEY 管理」里新建一个 key' },
	{ id: 'tavily', label: 'Tavily', needsKey: true, needsBaseURL: false, hint: 'app.tavily.com 注册就有免费额度（国内可能要代理）' },
	{ id: 'brave', label: 'Brave Search', needsKey: true, needsBaseURL: false, hint: 'api-dashboard.search.brave.com 申请（国内可能要代理）' },
	{ id: 'searxng', label: 'SearXNG（自己搭）', needsKey: false, needsBaseURL: true, hint: '填你的 SearXNG 地址，要在 settings.yml 里打开 json 格式' }
];
const IDS = new Set(WEB_PROVIDERS.map((p) => p.id));

/** 把原始 tools.web 配置收拾成稳定的形状。 */
export function webSearchConfig(raw = {}) {
	const n = Number(raw.perDay);
	const provider = IDS.has(raw.provider) ? raw.provider : 'host';
	return {
		enabled: raw.enabled === true,
		perDay: Number.isFinite(n) ? Math.min(500, Math.max(0, Math.floor(n))) : 20,
		provider,
		apiKey: typeof raw.apiKeys?.[provider] === 'string' ? raw.apiKeys[provider].trim() : '',
		baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : ''
	};
}

/** 自己的搜索服务配齐了没（host 不算"自己的"）。 */
export function ownSearchReady(cfg) {
	const p = WEB_PROVIDERS.find((x) => x.id === cfg.provider);
	if (!p || p.id === 'host') return false;
	if (p.needsKey && cfg.apiKey === '') return false;
	if (p.needsBaseURL && !/^https?:\/\//i.test(cfg.baseURL)) return false;
	return true;
}

const clip = (s, n) => {
	const t = String(s ?? '').replace(/\s+/g, ' ').trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};
const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function readJson(res, label) {
	const text = await res.text();
	if (!res.ok) {
		let msg = text.slice(0, 200);
		try { const j = JSON.parse(text); msg = j.message ?? j.msg ?? j.error?.message ?? j.error ?? j.detail ?? msg; } catch { /* 原样 */ }
		throw new Error(`${label} 返回 ${res.status}：${typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200)}`);
	}
	try { return JSON.parse(text); } catch { throw new Error(`${label} 返回的不是 JSON`); }
}

/**
 * 搜一下。
 * @returns {Promise<{answer:string, results:Array<{title:string,url:string,site:string,date:string,snippet:string}>}>}
 */
export async function webSearch(cfg, query, { fetchImpl = globalThis.fetch, signal, count = 6 } = {}) {
	const q = String(query ?? '').trim().slice(0, 200);
	if (q === '') throw new Error('搜什么？query 是空的');
	const timeout = AbortSignal.timeout(15_000);
	const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const n = Math.min(10, Math.max(1, count));
	const norm = (arr) => arr.filter((r) => r && (r.title || r.snippet)).slice(0, n)
		.map((r) => ({ title: clip(r.title, 80), url: String(r.url ?? ''), site: clip(r.site || siteOf(r.url), 40), date: String(r.date ?? '').slice(0, 10), snippet: clip(r.snippet, 300) }));

	if (cfg.provider === 'bocha') {
		const res = await fetchImpl('https://api.bochaai.com/v1/web-search', {
			method: 'POST', signal: sig,
			headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: q, summary: true, count: n, freshness: 'noLimit' })
		});
		const j = await readJson(res, '博查');
		if (typeof j.code === 'number' && j.code !== 200) throw new Error(`博查：${j.msg ?? j.message ?? j.code}`);
		const items = j.data?.webPages?.value ?? j.webPages?.value ?? [];
		return { answer: '', results: norm(items.map((x) => ({ title: x.name, url: x.url, site: x.siteName, date: x.datePublished ?? x.dateLastCrawled, snippet: x.summary || x.snippet }))) };
	}
	if (cfg.provider === 'tavily') {
		const res = await fetchImpl('https://api.tavily.com/search', {
			method: 'POST', signal: sig,
			headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: q, max_results: n, include_answer: true })
		});
		const j = await readJson(res, 'Tavily');
		return { answer: clip(j.answer, 400), results: norm((j.results ?? []).map((x) => ({ title: x.title, url: x.url, date: x.published_date, snippet: x.content }))) };
	}
	if (cfg.provider === 'brave') {
		const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`;
		const res = await fetchImpl(u, { signal: sig, headers: { Accept: 'application/json', 'X-Subscription-Token': cfg.apiKey } });
		const j = await readJson(res, 'Brave');
		return { answer: '', results: norm((j.web?.results ?? []).map((x) => ({ title: x.title, url: x.url, date: x.page_age ?? x.age, snippet: String(x.description ?? '').replace(/<[^>]+>/g, '') }))) };
	}
	if (cfg.provider === 'searxng') {
		const u = `${cfg.baseURL}/search?q=${encodeURIComponent(q)}&format=json`;
		const res = await fetchImpl(u, { signal: sig, headers: { Accept: 'application/json' } });
		if (res.status === 403) throw new Error('SearXNG 返回 403：settings.yml 的 search.formats 里要加上 json');
		const j = await readJson(res, 'SearXNG');
		return { answer: (j.answers ?? [])[0] ? clip(j.answers[0], 400) : '', results: norm((j.results ?? []).map((x) => ({ title: x.title, url: x.url, date: x.publishedDate, snippet: x.content }))) };
	}
	throw new Error('没选自己的搜索服务');
}

/** 给模型看的文本。 */
export function formatSearch(query, { answer, results }) {
	if (results.length === 0 && !answer) return `搜「${query}」没搜到东西。`;
	const lines = [`搜「${query}」的结果（用自己的话说给对方听，别贴链接）：`];
	if (answer) lines.push(`概要：${answer}`);
	results.forEach((r, i) => {
		lines.push(`${i + 1}. ${r.title}${r.site ? `（${r.site}${r.date ? ` ${r.date}` : ''}）` : r.date ? `（${r.date}）` : ''}\n   ${r.snippet}${r.url ? `\n   ${r.url}` : ''}`);
	});
	return lines.join('\n');
}
