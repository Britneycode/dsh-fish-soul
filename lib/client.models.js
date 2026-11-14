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
		const TTS_PROVIDERS = [{ value: "", label: "自动" }, { value: "openai", label: "OpenAI 兼容" }, { value: "mimo", label: "小米 MiMo" }, { value: "volcengine", label: "火山引擎" }, { value: "minimax", label: "MiniMax" }];
		// 听的服务商：百炼和 MiniMax 的端点跟 OpenAI 不一样，选错了会一直「听不到」
		const STT_PROVIDERS = [{ value: "", label: "自动" }, { value: "openai", label: "OpenAI 兼容" }, { value: "dashscope", label: "阿里百炼" }, { value: "minimax", label: "MiniMax" }];

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
			return Group({ title: "按功能选模型", className: "fs-model-routes", aside: host ? Muted(`DSH 默认：${providerName(host.provider)} · ${host.model}`) : null },
				providers.length === 0 && !host ? Row({ title: "可用模型" }, State("warning", "DSH 里还没配模型")) : null,
				data.lastError ? Row({ title: "上次调用" }, State("error", data.lastError)) : null,
				...(data.features ?? []).map((f) => Row({ title: f.label, key: f.id, meta: f.resolved ? (f.selection ? undefined : `现在用 ${f.resolved.model}`) : "没有可用的模型" },
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
					Row({ title: "合计", meta: estimated ? "有的模型没报用量，按字数估的" : undefined },
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

		/** 上网查：DSH 自带的 web_search，或自己填 key 的搜索服务（博查 / Tavily / Brave / SearXNG） */
		function Web({ data, api, notify, load, ui }) {
			const { h, Group, Row, Switch, Num, Muted, State, Select, Secret, Input, Button, Seg } = ui;
			const w = data.web ?? {};
			const providers = w.providers ?? [{ id: "host", label: "DSH 自带" }];
			const cur = providers.find((p) => p.id === (w.provider ?? "host")) ?? providers[0];
			const [perDay, setPerDay] = react.useState(w.perDay ?? 20);
			const [key, setKey] = react.useState("");
			const [baseURL, setBaseURL] = react.useState(w.baseURL ?? "");
			const [busy, setBusy] = react.useState(false);
			const [result, setResult] = react.useState(null);
			async function save(p) {
				const r = await api("POST", "/models/config", { web: { enabled: w.enabled, perDay: Number(perDay), ...p } });
				if (r?.ok) { if (p.apiKey !== undefined) setKey(""); load(); } else notify(r?.error ?? "保存失败");
			}
			async function saveSessionAllow(v) { // #37 会话工具放行档位
				const r = await api("POST", "/models/config", { sessionAllow: v });
				if (!r?.ok) notify(r?.error ?? "保存失败");
				else load();
			}
			async function test() {
				setBusy(true); setResult(null);
				const r = await api("POST", "/web/test", { query: "今天有什么新闻" });
				setBusy(false);
				if (!r?.ok) { notify(r?.error ?? "没搜成"); return; }
				setResult(r);
			}
			const own = cur.id !== "host";
			const why = cur.id === "host" ? "DSH 里没有联网搜索工具（web_search），可以换成自己的搜索服务" : cur.needsBaseURL ? "先填 SearXNG 地址" : "先填 API Key";
			return Group({ title: "上网查" },
				Row({ title: "聊天时可以上网查", meta: w.available ? undefined : why },
					w.enabled && w.available ? State(w.usedToday >= w.perDay ? "warning" : "done", `今天 ${w.usedToday}/${w.perDay}`) : null,
					h(Switch, { label: "聊天时可以上网查", checked: w.enabled === true, disabled: !w.available && !w.enabled, onChange: (v) => save({ enabled: v }) })),
				Row({ title: "聊天会话能用哪些工具", desc: "只放记忆和上网最安全；「只对主人放开」是主人的私聊会话放开宿主全部工具（其他人不变），「全放开」是所有聊天会话都放。放开后已开着的会话要在 DSH 里重开一次才生效。run_code 始终不放行" },
					Seg({ label: "聊天会话能用哪些工具", value: w.sessionAllow ?? "memory", onChange: (v) => saveSessionAllow(v), options: [
						{ value: "memory", label: "只记忆+上网" }, { value: "master", label: "只对主人放开" }, { value: "all", label: "全放开" }
					] })),
				Row({ title: "搜索服务", desc: cur.id === "host" && w.hostState === "unknown" ? `${cur.hint}。插件这边检测不到不代表没有（DSH 的联网工具常按会话挂载），打开后问她一件最近的事试试；查成过一次这里会显示「用过」` : cur.hint },
					Select({ value: cur.id, "aria-label": "搜索服务", onChange: (e) => { setResult(null); save({ provider: e.target.value }); } },
						...providers.map((p) => h("option", { key: p.id, value: p.id }, p.id === "host" && w.hostState === "unknown" ? `${p.label}（没检测到）` : p.id === "host" && w.hostState === "seen" ? `${p.label}（用过）` : p.label)))),
				own && cur.needsKey ? Row({ title: "API Key" },
					w.hasApiKey && !key ? State("done", "已填") : null,
					h(Secret, { label: "API Key", value: key, placeholder: w.hasApiKey ? w.apiKeyMasked : "粘贴 key", onChange: (e) => setKey(e.target.value), onBlur: () => { if (key.trim() !== "") save({ apiKey: key.trim() }); } })) : null,
				own && cur.needsBaseURL ? Row({ title: "SearXNG 地址" },
					Input({ value: baseURL, placeholder: "http://127.0.0.1:8080", "aria-label": "SearXNG 地址", onChange: (e) => setBaseURL(e.target.value), onBlur: () => { if (baseURL !== (w.baseURL ?? "")) save({ baseURL }); } })) : null,
				own && w.available ? Row({ title: "测一下", meta: result ? `搜到 ${result.count} 条 · ${(result.latencyMs / 1000).toFixed(1)} 秒${result.results?.[0] ? ` · 第一条：${result.results[0].title}` : ""}` : undefined, desc: "搜一次「今天有什么新闻」，不算今天的次数" },
					Button({ disabled: busy, onClick: test }, busy ? "搜索中" : "测一下")) : null,
				w.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 500, value: perDay, "aria-label": "每天最多", onChange: (e) => setPerDay(e.target.value), onBlur: () => save({}) }), Muted("次")) : null);
		}

		/** 语音：听 QQ 语音 + 发语音 */
		function Voice({ api, notify, ui }) {
			const { h, Group, Row, Switch, Input, Secret, Seg, Num, Muted, State, Button, useConfirm } = ui;
			const [confirm, confirmNode] = useConfirm();
			const [v, load] = useLoad(api, "/voice/state");
			const [form, setForm] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [say, setSay] = react.useState("你好呀，我是鱼。");
			react.useEffect(() => {
				if (v && !v.error && form === null) setForm({
					sttBaseURL: v.stt?.baseURL ?? "", sttApiKey: "", ttsBaseURL: v.tts?.baseURL ?? "", ttsApiKey: "",
					sttModel: v.sttModel, ttsModel: v.ttsModel, ttsVoice: v.ttsVoice, ttsPerDay: v.ttsPerDay, sttPerDay: v.sttPerDay, maxChars: v.maxChars, timeoutSec: v.timeoutSec,
					sttProvider: v.sttProvider ?? "",
					ttsProvider: v.ttsProvider ?? "", volcAppId: v.volcAppId ?? "", volcCluster: v.volcCluster ?? "", volcResourceId: v.volcResourceId ?? ""
				});
			}, [v, form]);
			if (!v || !form) return null;
			if (v.error) return null;
			const stt = v.stt ?? {};
			const tts = v.tts ?? {};
			// 选了火山，或者没选但地址 / 模型看着像火山，就把火山的几行露出来
			const ttsVolc = form.ttsProvider === "volcengine" || (form.ttsProvider === "" && (/openspeech|bytedance/i.test(form.ttsBaseURL || tts.effectiveBaseURL || "") || /^(volc|doubao)/i.test(form.ttsModel || v.ttsModel || "")));
			// 火山新版控制台只给 API Key（没有 AppID）→ V3；填了 AppID 才是老版 AppID + Token
			const volcV3 = String(form.volcAppId ?? "").trim() === "";
			// 听那边同理：选了就看选的，没选就按地址 / 模型猜（跟服务端 voice.js 的判定保持一致）
			const sttSrc = (form.sttBaseURL || stt.effectiveBaseURL || "") + " " + (form.sttModel || v.sttModel || "");
			const sttDash = form.sttProvider === "dashscope" || (form.sttProvider === "" && /dashscope|maas\.aliyuncs/i.test(sttSrc) || (form.sttProvider === "" && /qwen[\d.]*-asr|paraformer/i.test(form.sttModel || v.sttModel || "")));
			const sttMini = form.sttProvider === "minimax" || (form.sttProvider === "" && /minimax/i.test(form.sttBaseURL || stt.effectiveBaseURL || ""));
			const ttsMini = form.ttsProvider === "minimax" || (form.ttsProvider === "" && /minimax/i.test(form.ttsBaseURL || tts.effectiveBaseURL || ""));
			const patch = (p) => setForm((f) => ({ ...f, ...p }));
			async function save(p = {}) {
				const next = { ...form, ...p };
				const keys = {};
				for (const k of ["sttApiKey", "ttsApiKey"]) if (next[k] !== "") keys[k] = next[k];
				const { sttApiKey: _a, ttsApiKey: _b, ...rest } = next;
				const r = await api("POST", "/voice/config", { ...rest, ...keys, ttsPerDay: Number(next.ttsPerDay), sttPerDay: Number(next.sttPerDay), maxChars: Number(next.maxChars), timeoutSec: Number(next.timeoutSec), ...p });
				if (r?.ok) { if (Object.keys(keys).length > 0) patch({ sttApiKey: "", ttsApiKey: "" }); load(); } else notify(r?.error ?? "保存失败");
			}
			async function setIncoming(x) {
				if (x && !(await confirm({ title: "保存 QQ 语音", description: "会把需要回复的好友私聊或白名单群语音以未加密文件保存到本机，最多 30 条；备份和复制件需另行清理。继续吗？" }))) return;
				await save({ saveIncoming: x });
			}
			async function clearIncoming() {
				if (!(await confirm({ title: "清空 QQ 语音", description: "永久删除插件保存的入站语音；备份和复制件需另行清理。继续吗？", danger: true }))) return;
				const r = await api("POST", "/voice/clear-incoming", {});
				if (r?.ok) { notify(`已清理 ${r.removed} 条`); load(); } else notify(r?.error ?? "清理失败");
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
			const keyHint = (x) => (x.hasOwnKey ? x.keyMasked : x.keyFrom === "shared" ? `沿用公用的 key（${v.apiKeyMasked}）` : x.keyFrom === "embedding" ? "沿用记忆检索的 key" : "sk-…");
			const keyField = (k, x, label) => h(Secret, { label, value: form[k], placeholder: keyHint(x), onChange: (e) => patch({ [k]: e.target.value }), onBlur: () => { if (form[k] !== "") save(); } });
			const sideState = (x, left) => (!v.enabled ? null : !x.ready ? State("warning", x.hasKey ? "还差点配置" : "还没有 key") : State("done", `今天还能 ${left} 条`));
			const status = !v.enabled ? null : !stt.hasKey && !tts.hasKey ? State("warning", "还没有 key") : v.lastError ? State("error", v.lastError) : null;
			const on = v.enabled === true;
			return h(react.Fragment, null,
				Group({ title: "语音" },
					Row({ title: "语音", desc: on ? "听和说可以用不同的服务，各填各的；地址或 key 留空就沿用另一组 / 记忆检索的" : "能听懂 QQ 语音，也会偶尔发语音" }, status, h(Switch, { label: "语音", checked: on, onChange: (x) => save({ enabled: x }) })),
					on ? Row({ title: "什么时候发语音" }, h(Seg, { label: "什么时候发语音", value: v.speak, options: SPEAK, onChange: (x) => save({ speak: x }) })) : null),
				on ? Group({ title: "语音文件" },
					Row({ title: "保存收到的 QQ 语音", desc: `仅保存需回复的好友私聊和明确白名单群语音，最多 30 条；未加密。目录：${v.incomingDir}。受限会话的 sound_read 仅能分析本轮单一说话人文件；已放开工具的会话保留原有权限。安装插件后可能需要重开会话。` }, h(Switch, { label: "保存收到的 QQ 语音", checked: v.saveIncoming === true, onChange: setIncoming })),
					Row({ title: "清理 QQ 语音", desc: v.filesError || `当前 ${v.incomingCount ?? 0} 条；不删除备份或复制件` }, Button({ onClick: clearIncoming }, "清空")),
					Row({ title: "DSH 里鱼的会话生成本地语音", desc: `使用「说」的服务与配额；不会发送 QQ。超字数或失败保留文字。最多保留 30 条，目录：${v.desktopDir}${v.desktopLatest ? `；最近：${v.desktopLatest}` : ""}` }, h(Switch, { label: "DSH 里鱼的会话生成本地语音", checked: v.desktopTts === true, onChange: (x) => save({ desktopTts: x }) }))) : null,
				on ? Group({ title: "听（语音转文字）", aside: sideState(stt, v.sttLeft) },
					Row({ title: "服务商", desc: "百炼和 MiniMax 的端点跟 OpenAI 不一样，选错了会一直「听不到」" }, h(Seg, { label: "听的服务商", value: form.sttProvider, options: STT_PROVIDERS, onChange: (x) => { patch({ sttProvider: x }); save({ sttProvider: x }); } })),
					Row({ title: "接口地址", desc: sttDash ? "阿里百炼填 https://dashscope.aliyuncs.com/compatible-mode/v1" : sttMini ? "MiniMax 填 https://api.minimax.cn/v1" : "" }, field("sttBaseURL", { placeholder: stt.effectiveBaseURL || "https://api.siliconflow.cn/v1", "aria-label": "听的接口地址" })),
					Row({ title: "API Key" }, keyField("sttApiKey", stt, "听的 API Key")),
					Row({ title: "模型", desc: sttDash ? "百炼用 qwen3-asr-flash" : sttMini ? "MiniMax 用 asr-1.0" : "" }, field("sttModel", { "aria-label": "听的模型" })),
					Row({ title: "每天最多" }, Num({ min: 0, max: 2000, value: form.sttPerDay, "aria-label": "每天最多听", onChange: (e) => patch({ sttPerDay: e.target.value }), onBlur: () => save() }), Muted("条"))) : null,
				on ? Group({ title: "说（文字转语音）", aside: sideState(tts, v.ttsLeft) },
					Row({ title: "服务商", desc: "自动也认；火山引擎新版控制台填 API Key 就行，老版还要 AppID" }, h(Seg, { label: "说的服务商", value: form.ttsProvider, options: TTS_PROVIDERS, onChange: (x) => { patch({ ttsProvider: x }); save({ ttsProvider: x }); } })),
					Row({ title: "接口地址", desc: ttsMini ? "MiniMax 填 https://api.minimax.cn/v1" : "小米 MiMo 填它的地址就行，会自动换成 MiMo 的调用方式；火山填 https://openspeech.bytedance.com" }, field("ttsBaseURL", { placeholder: tts.effectiveBaseURL || "https://api.siliconflow.cn/v1", "aria-label": "说的接口地址" })),
					Row({ title: "API Key", desc: ttsVolc ? (volcV3 ? "新版控制台给的 API Key" : "老版控制台的 Access Token") : "" }, keyField("ttsApiKey", tts, "说的 API Key")),
					Row({ title: "模型" }, field("ttsModel", { "aria-label": "说的模型" })),
					Row({ title: "音色", desc: ttsVolc && volcV3 ? "V3 只认 2.0 音色（*_uranus_bigtts）；声音复刻要先在火山开通" : "" }, field("ttsVoice", { "aria-label": "音色", placeholder: ttsVolc ? (volcV3 ? "zh_female_shuangkuaisisi_uranus_bigtts" : "zh_female_qingxin") : "" })),
					ttsVolc ? Row({ title: "AppID", desc: "老版控制台（V1）才填；新版留空，走 API Key + V3" }, field("volcAppId", { placeholder: "留空 = 新版 API Key 模式", "aria-label": "火山的 AppID" })) : null,
					ttsVolc && !volcV3 ? Row({ title: "集群", desc: "普通合成填 volcano_tts；声音复刻填 volcano_icl" }, field("volcCluster", { placeholder: "volcano_tts", "aria-label": "火山的集群" })) : null,
					ttsVolc && volcV3 ? Row({ title: "Resource ID", desc: "V3 的模型版本，一般不用改" }, field("volcResourceId", { placeholder: "seed-tts-2.0", "aria-label": "火山的 Resource ID" })) : null,
					v.speak !== "never" ? Row({ title: "一条语音最多" }, Num({ min: 10, max: 200, value: form.maxChars, "aria-label": "字数", onChange: (e) => patch({ maxChars: e.target.value }), onBlur: () => save() }), Muted("字")) : null,
					Row({ title: "每天最多" }, Num({ min: 0, max: 500, value: form.ttsPerDay, "aria-label": "每天最多说", onChange: (e) => patch({ ttsPerDay: e.target.value }), onBlur: () => save() }), Muted("条")),
					Row({ title: "最多等", desc: "长一点的语音合成会超过 20 秒，等不到就白合成一次。听也共用这个上限" }, Num({ min: 5, max: 300, value: form.timeoutSec, "aria-label": "最多等几秒", onChange: (e) => patch({ timeoutSec: e.target.value }), onBlur: () => save() }), Muted("秒")),
					tts.hasKey ? Row({ title: "试听" }, Input({ value: say, onChange: (e) => setSay(e.target.value), "aria-label": "试听的话" }), Button({ disabled: busy, onClick: test }, busy ? "合成中" : "播放")) : null) : null, confirmNode);
		}

		function ModelsPane({ api, notify, ui, section = "models" }) {
			const { h, Empty, Dot } = ui;
			const [data, load] = useLoad(api, "/models/state");
			if (data === null) return Empty(Dot("ongoing"));
			if (data.error) return h("div", { className: "fs-notice", role: "alert" }, h("b", null, "模型状态读不到"), h("span", null, data.error));
			const p = { data, api, notify, load, ui };
			return h(react.Fragment, null,
				section === "models" ? h(FeatureModels, p) : null,
				section === "usage" ? h(Usage, p) : null,
				section === "web" ? h(Web, p) : null,
				section === "voice" ? h(Voice, { api, notify, ui }) : null);
		}

		return { ModelsPane };
	}
});
