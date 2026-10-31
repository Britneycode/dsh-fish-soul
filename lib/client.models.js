/**
 * dsh-fish-soul — 设置面板「模型」页（client.models.js，按需加载的包内分块）
 *
 * 按功能选模型（空 = 跟 DSH 默认模型）、用量与估算花费（单价主人自己填，元 / 百万 token）、上网查、语音。
 * 主面板 client.js 用 require.async("./client.models.js") 拿到 ModelsPane；api / 控件（props.ui）由主面板传进来。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	chunk: "client.models.js",
	factory: (require) => {
		const react = require("react");
		const SEP = "\u0001";
		const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));
		const fmtCost = (c) => (c === null || c === undefined ? "—" : c === 0 ? "¥0" : c < 0.01 ? "<¥0.01" : `¥${c.toFixed(c < 10 ? 2 : 1)}`);
		const SPEAK = [{ value: "never", label: "从不" }, { value: "mirror", label: "对方发语音时" }, { value: "sometimes", label: "偶尔自己发" }];

		function useLoad(api, path) {
			const [data, setData] = react.useState(null);
			const load = react.useCallback(async () => { const r = await api("GET", path); if (r?.ok !== false) setData(r); else setData((d) => d ?? { error: r?.error }); }, [api, path]);
			react.useEffect(() => { load(); }, [load]);
			return [data, load];
		}

		/** 按功能选模型 */
		function FeatureModels({ data, api, notify, load, ui }) {
			const { h, Group, Row, Select, Muted, State } = ui;
			const providers = data.providers ?? [];
			const host = data.hostDefault;
			async function pick(feature, value) {
				const [provider, model] = value === "" ? [] : value.split(SEP);
				const models = Object.fromEntries((data.features ?? []).map((f) => [f.id, f.selection]));
				models[feature] = value === "" ? null : { provider, model };
				const r = await api("POST", "/models/config", { models });
				if (r?.ok) load(); else notify(r?.error ?? "保存失败");
			}
			const providerName = (id) => providers.find((p) => p.id === id)?.name ?? id;
			const options = (sel) => {
				const opts = [h("option", { key: "", value: "" }, host ? `跟 DSH 默认（${host.model}）` : "跟 DSH 默认")];
				for (const p of providers) {
					opts.push(h("optgroup", { key: p.id, label: p.name }, (p.models ?? []).map((m) => h("option", { key: m.id, value: `${p.id}${SEP}${m.id}` }, m.name || m.id))));
				}
				if (sel && !providers.some((p) => p.id === sel.provider && (p.models ?? []).some((m) => m.id === sel.model))) {
					opts.push(h("option", { key: "__missing", value: `${sel.provider}${SEP}${sel.model}` }, `${sel.model}（现在找不到）`));
				}
				return opts;
			};
			return Group({ title: "按功能选模型", aside: host ? Muted(`DSH 默认：${providerName(host.provider)} · ${host.model}`) : null },
				providers.length === 0 && !host ? Row({ title: "可用模型" }, State("warning", "DSH 里还没配模型")) : null,
				data.lastError ? Row({ title: "上次调用" }, State("error", data.lastError)) : null,
				...(data.features ?? []).map((f) => Row({ title: f.label, key: f.id, desc: f.resolved ? (f.selection ? undefined : `现在用 ${f.resolved.model}`) : "没有可用的模型" },
					Select({ value: f.selection ? `${f.selection.provider}${SEP}${f.selection.model}` : "", "aria-label": f.label, onChange: (e) => pick(f.id, e.target.value) }, ...options(f.selection)))));
		}

		/** 用量 / 估算花费；按模型填单价 */
		function Usage({ data, api, notify, load, ui }) {
			const { h, Group, Row, Seg, Muted, Num, Empty, Tag } = ui;
			const [range, setRange] = react.useState("7");
			const [prices, setPrices] = react.useState(() => ({ ...(data.prices ?? {}) }));
			const u = range === "7" ? data.usage7 : data.usage30;
			if (!u) return null;
			const labels = Object.fromEntries((data.features ?? []).map((f) => [f.id, f.label]));
			const features = Object.entries(u.byFeature ?? {}).sort((a, b) => b[1].calls - a[1].calls);
			const models = Object.entries(u.byModel ?? {}).sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out));
			const estimated = features.some(([, f]) => (f.estimated ?? 0) > 0);
			const anyPrice = models.some(([m]) => prices[m]);
			async function savePrice(model) {
				const p = prices[model] ?? {};
				const r = await api("POST", "/models/config", { prices: { [model]: (Number(p.in) || 0) === 0 && (Number(p.out) || 0) === 0 ? null : { in: Number(p.in) || 0, out: Number(p.out) || 0 } } });
				if (r?.ok) load(); else notify(r?.error ?? "保存失败");
			}
			const priceInput = (model, k, label) => Num({ min: 0, step: 0.1, value: prices[model]?.[k] ?? "", placeholder: label, "aria-label": `${model} ${label}单价`,
				onChange: (e) => setPrices((all) => ({ ...all, [model]: { ...(all[model] ?? {}), [k]: e.target.value } })), onBlur: () => savePrice(model) });
			const t = u.total ?? { calls: 0, in: 0, out: 0, cost: 0 };
			return h(react.Fragment, null,
				Group({ title: "用量", aside: h(Seg, { label: "时间范围", value: range, onChange: setRange, options: [{ value: "7", label: "7 天" }, { value: "30", label: "30 天" }] }) },
					Row({ title: "合计", desc: estimated ? "有的模型没报用量，按字数估的" : undefined },
						Muted(`${t.calls} 次 · 输入 ${fmtTok(t.in)} · 输出 ${fmtTok(t.out)} token`), anyPrice ? Tag(`约 ${fmtCost(t.cost)}`, "info") : null),
					features.length === 0 ? Empty("这段时间还没调用过模型") : h("div", { className: "fs-list" }, features.map(([id, f]) => h("div", { className: "fs-item", key: id },
						h("span", { className: "fs-item-main" }, labels[id] ?? id),
						h("span", { className: "fs-item-meta" },
							h("span", null, `${f.calls} 次${f.failed ? `（失败 ${f.failed}）` : ""}`),
							h("span", null, `${fmtTok(f.in + f.out)} token`),
							anyPrice ? h("span", null, fmtCost(f.cost)) : null))))),
				models.length === 0 ? null : Group({ title: "单价", aside: Muted("元 / 百万 token，填了才算花费") },
					h("div", { className: "fs-list" }, models.map(([m, x]) => h("div", { className: "fs-item", key: m },
						h("span", { className: "fs-item-main", title: m }, m),
						h("span", { className: "fs-item-meta" },
							h("span", null, `${fmtTok(x.in + x.out)} token`),
							priceInput(m, "in", "输入"), priceInput(m, "out", "输出"),
							h("span", null, fmtCost(x.cost))))))));
		}

		/** 上网查（宿主的 web_search / web_fetch） */
		function Web({ data, api, notify, load, ui }) {
			const { h, Group, Row, Switch, Num, Muted, State } = ui;
			const w = data.web ?? {};
			const [perDay, setPerDay] = react.useState(w.perDay ?? 20);
			async function save(p) {
				const r = await api("POST", "/models/config", { web: { enabled: w.enabled, perDay: Number(perDay), ...p } });
				if (r?.ok) load(); else notify(r?.error ?? "保存失败");
			}
			return Group({ title: "上网查" },
				Row({ title: "聊天时可以上网查", desc: w.available ? undefined : "DSH 里没有联网搜索工具（web_search）" },
					w.enabled && w.available ? State(w.usedToday >= w.perDay ? "warning" : "done", `今天 ${w.usedToday}/${w.perDay}`) : null,
					h(Switch, { label: "聊天时可以上网查", checked: w.enabled === true, disabled: !w.available && !w.enabled, onChange: (v) => save({ enabled: v }) })),
				w.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 500, value: perDay, "aria-label": "每天最多", onChange: (e) => setPerDay(e.target.value), onBlur: () => save({}) }), Muted("次")) : null);
		}

		/** 语音：听 QQ 语音 + 发语音 */
		function Voice({ api, notify, ui }) {
			const { h, Group, Row, Switch, Input, Secret, Seg, Num, Muted, State, Button } = ui;
			const [v, load] = useLoad(api, "/voice/state");
			const [form, setForm] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [say, setSay] = react.useState("你好呀，我是鱼。");
			react.useEffect(() => {
				if (v && !v.error && form === null) setForm({ baseURL: v.baseURL, apiKey: "", sttModel: v.sttModel, ttsModel: v.ttsModel, ttsVoice: v.ttsVoice, ttsPerDay: v.ttsPerDay, sttPerDay: v.sttPerDay, maxChars: v.maxChars });
			}, [v, form]);
			if (!v || !form) return null;
			if (v.error) return null;
			const patch = (p) => setForm((f) => ({ ...f, ...p }));
			async function save(p = {}) {
				const next = { ...form, ...p };
				const r = await api("POST", "/voice/config", { ...next, ...(next.apiKey === "" ? { apiKey: undefined } : {}), ttsPerDay: Number(next.ttsPerDay), sttPerDay: Number(next.sttPerDay), maxChars: Number(next.maxChars), ...p });
				if (r?.ok) { if (next.apiKey !== "") patch({ apiKey: "" }); load(); } else notify(r?.error ?? "保存失败");
			}
			async function test() {
				setBusy(true);
				const r = await api("POST", "/voice/test", { text: say });
				setBusy(false);
				if (!r?.ok) { notify(r?.error ?? "试听失败"); return; }
				try { await new Audio(`data:${r.mediaType};base64,${r.base64}`).play(); } catch { notify("浏览器没能播放"); }
				load();
			}
			const field = (k, props) => Input({ value: form[k] ?? "", onChange: (e) => patch({ [k]: e.target.value }), onBlur: () => save(), ...props });
			const status = !v.enabled ? null : !v.hasApiKey ? State("warning", "还没有 key") : v.lastError ? State("error", v.lastError) : State("done", `今天还能听 ${v.sttLeft} 条 · 说 ${v.ttsLeft} 条`);
			return Group({ title: "语音" },
				Row({ title: "语音", desc: v.enabled ? undefined : "能听懂 QQ 语音，也会偶尔发语音" }, status, h(Switch, { label: "语音", checked: v.enabled === true, onChange: (x) => save({ enabled: x }) })),
				v.enabled ? Row({ title: "接口地址" }, field("baseURL", { placeholder: "https://api.siliconflow.cn/v1" })) : null,
				v.enabled ? Row({ title: "API Key" }, h(Secret, { label: "API Key", value: form.apiKey, placeholder: v.hasOwnKey ? v.apiKeyMasked : v.sharesEmbedding ? "沿用记忆检索的 key" : "sk-…", onChange: (e) => patch({ apiKey: e.target.value }), onBlur: () => { if (form.apiKey !== "") save(); } })) : null,
				v.enabled ? Row({ title: "听语音的模型" }, field("sttModel")) : null,
				v.enabled ? Row({ title: "说话的模型" }, field("ttsModel")) : null,
				v.enabled ? Row({ title: "音色" }, field("ttsVoice")) : null,
				v.enabled ? Row({ title: "什么时候发语音" }, h(Seg, { label: "什么时候发语音", value: v.speak, options: SPEAK, onChange: (x) => save({ speak: x }) })) : null,
				v.enabled && v.speak !== "never" ? Row({ title: "一条语音最多" }, Num({ min: 10, max: 200, value: form.maxChars, "aria-label": "字数", onChange: (e) => patch({ maxChars: e.target.value }), onBlur: () => save() }), Muted("字")) : null,
				v.enabled ? Row({ title: "每天最多" },
					Muted("听"), Num({ min: 0, max: 2000, value: form.sttPerDay, "aria-label": "每天最多听", onChange: (e) => patch({ sttPerDay: e.target.value }), onBlur: () => save() }),
					Muted("说"), Num({ min: 0, max: 500, value: form.ttsPerDay, "aria-label": "每天最多说", onChange: (e) => patch({ ttsPerDay: e.target.value }), onBlur: () => save() }), Muted("条")) : null,
				v.enabled && v.hasApiKey ? Row({ title: "试听" }, Input({ value: say, onChange: (e) => setSay(e.target.value), "aria-label": "试听的话" }), Button({ disabled: busy, onClick: test }, busy ? "合成中" : "播放")) : null);
		}

		function ModelsPane({ api, notify, ui }) {
			const { h, Empty, Dot } = ui;
			const [data, load] = useLoad(api, "/models/state");
			if (data === null) return Empty(Dot("ongoing"));
			if (data.error) return h("div", { className: "fs-notice", role: "alert" }, h("b", null, "模型状态读不到"), h("span", null, data.error));
			const p = { data, api, notify, load, ui };
			return h(react.Fragment, null, h(FeatureModels, p), h(Usage, p), h(Web, p), h(Voice, { api, notify, ui }));
		}

		return { ModelsPane };
	}
});
