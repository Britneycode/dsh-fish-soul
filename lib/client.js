/**
 * dsh-fish-soul — 桌面端设置面板（client.js）
 *
 * 真源：业务逻辑见 DESIGN-fish-soul.md；接口契约见 lib/routes.js（100% 走 /api/plugins/fish-soul/*）。
 *
 * 宿主契约：
 *  - window.__ModuleLoader__.load({ id, factory })，exports.apply / inject；inject: ["slots"]
 *  - ctx.slots.inject("settings.section", ...) 挂载；样式随组件挂载 / 卸载（<style> 元素），不碰 document.head
 *  - 不 require 任何 Harness Client 包：下面的 Switch / Button / Input / Seg / Tabs / Dot / Tag 照抄
 *    @deepseek-ai/dsh-client-ui-primitives 的结构、无障碍语义与样式（lib/panel.css，fs- 前缀，只用 --dsw-alias-* 令牌）
 *
 * 设计信条：Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
 *  - 平铺行（标题左 / 控件右）+ 分组标题，沿用宿主「通用」设置页的节奏
 *  - 状态 = 一颗 StateDot + 一个短句；只在出问题时多说一句
 *  - 依赖总开关的设置，总开关关着就不显示
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const inject = ["slots"];
		const PLUGIN_ID = "dsh-fish-soul";
		const API = "/api/plugins/fish-soul";
		const h = react.createElement;
		const cx = (...names) => names.filter(Boolean).join(" ");

		// ── 通信层：fail-open（任何请求失败都不抛到宿主） ──
		async function api(method, path, body) {
			try {
				const response = await fetch(API + path, {
					method,
					headers: { "content-type": "application/json" },
					...(body !== undefined ? { body: JSON.stringify(body) } : {})
				});
				const data = await response.json().catch(() => null);
				if (response.status === 503 && data && (data.starting || data.failed)) {
					const at = data.step ? `第 ${data.stepIndex}/${data.stepTotal} 步「${data.step}」` : "";
					return { ok: false, error: data.failed ? `插件启动失败${at ? "，挂在" + at : ""}：${data.error ?? "未知原因"}（详见宿主日志）` : `插件还在启动${at ? "（" + at + "）" : ""}，稍等再刷新` };
				}
				if (data) return data;
				if (response.status === 404) return { ok: false, error: "HTTP 404：插件后台没加载，或宿主没把请求转给插件。请看宿主日志里有没有「[fish-soul] 启动闸门已挂」" };
				return { ok: false, error: `HTTP ${response.status}` };
			} catch (error) {
				return { ok: false, error: String(error instanceof Error ? error.message : error) };
			}
		}

		// 样式只拉一次；<style> 作为面板的子元素渲染，面板卸载即移除
		let cssPromise = null;
		function useCss() {
			const [css, setCss] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				cssPromise ??= fetch(`${API}/ui/panel.css`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
				cssPromise.then((text) => { if (alive) setCss(text); if (text === "") cssPromise = null; });
				return () => { alive = false; };
			}, []);
			return css;
		}

		const pad = (n) => String(n).padStart(2, "0");
		const fmtClock = (ms) => {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "--:--";
			const d = new Date(ms);
			return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		};
		const fmtDueAt = (ms) => {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "--";
			const d = new Date(ms);
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		};
		function relTime(ms, nowMs) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "--";
			const m = Math.floor(Math.max(0, nowMs - ms) / 60000);
			if (m < 1) return "刚刚";
			if (m < 60) return `${m} 分钟前`;
			const hr = Math.floor(m / 60);
			return hr < 24 ? `${hr} 小时前` : `${Math.floor(hr / 24)} 天前`;
		}

		// ── 控件：照抄 dsh-ui-primitives ──
		const ICONS = {
			eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
			close: "M7 7l10 10M17 7 7 17",
			refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
			chevron: "m7 10 5 5 5-5",
			edit: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4Z M13.5 6.5l4 4"
		};
		const Icon = (name, size = 16) => h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
			h("path", { d: ICONS[name] }));

		function Switch({ checked, onChange, label, disabled }) {
			return h("button", { type: "button", role: "switch", "aria-checked": checked === true, "aria-label": label, disabled, className: "fs-switch", onClick: () => onChange(!checked) },
				h("span", { className: "fs-switch-thumb" }));
		}
		const Button = ({ variant, ...props }, ...kids) => h("button", { type: "button", ...props, className: cx("fs-btn", variant) }, ...kids);
		const IconButton = (icon, label, onClick, extra) => h("button", { type: "button", className: "fs-icon-btn", "aria-label": label, title: label, onClick, ...extra }, Icon(icon, 14));

		function Seg({ options, value, onChange, label }) {
			const index = Math.max(0, options.findIndex((o) => o.value === value));
			return h("div", { className: "fs-seg", role: "radiogroup", "aria-label": label, style: { "--n": options.length, "--i": index } },
				h("span", { className: "fs-seg-ind", "aria-hidden": true }),
				options.map((o) => h("button", {
					type: "button", key: o.value, role: "radio", "aria-checked": o.value === value,
					className: "fs-seg-btn", onClick: () => { if (o.value !== value) onChange(o.value); }
				}, o.label)));
		}

		function Tabs({ items, value, onChange }) {
			const index = Math.max(0, items.findIndex(([v]) => v === value));
			const onKeyDown = (event, i) => {
				const n = items.length;
				const next = event.key === "ArrowLeft" ? (i + n - 1) % n : event.key === "ArrowRight" ? (i + 1) % n
					: event.key === "Home" ? 0 : event.key === "End" ? n - 1 : -1;
				if (next < 0) return;
				event.preventDefault();
				event.currentTarget.parentElement?.querySelectorAll('[role="tab"]').item(next)?.focus();
				onChange(items[next][0]);
			};
			return h("div", { className: "fs-tabs", role: "tablist", "aria-label": "鱼", style: { "--n": items.length, "--i": index } },
				h("span", { className: "fs-tabs-ind", "aria-hidden": true }),
				items.map(([v, label], i) => h("button", {
					type: "button", key: v, role: "tab", id: `fs-tab-${v}`, "aria-selected": v === value, "aria-controls": "fs-tabpanel",
					tabIndex: v === value ? 0 : -1, className: "fs-tab", title: label, onClick: () => onChange(v), onKeyDown: (e) => onKeyDown(e, i)
				}, label)));
		}

		/** StateDot：done / warning / error / idle 是圆点，ongoing 是转圈。 */
		const Dot = (state) => state === "ongoing"
			? h("svg", { className: "fs-spin", width: 14, height: 14, viewBox: "0 0 24 24", "aria-hidden": true },
				h("g", null, h("circle", { cx: 12, cy: 12, r: 9.5 }), h("circle", { cx: 12, cy: 12, r: 9.5 })))
			: h("span", { className: "fs-dot", "data-state": state, "aria-hidden": true });
		const State = (state, text, title) => h("span", { className: "fs-state", "data-state": state, title: title ?? text, role: "status" }, Dot(state), h("span", null, text));
		const Tag = (text, tone, extra, ...kids) => h("span", { className: "fs-tag", "data-tone": tone, ...extra }, text, ...kids);
		const Muted = (text, extra) => h("span", { className: "fs-unit", ...extra }, text);

		function Row({ title, desc, stack }, ...kids) {
			return h("div", { className: cx("fs-row", stack && "stack") },
				h("div", { className: "fs-row-title" }, h("span", null, title), desc ? h("span", { className: "fs-row-desc" }, desc) : null),
				h("div", { className: "fs-ctl" }, ...kids));
		}
		function Group({ title, aside }, ...kids) {
			return h("section", { className: "fs-group" },
				title ? h("h3", { className: "fs-group-head" }, h("span", null, title), aside ?? null) : null, ...kids);
		}
		const Input = (props) => h("input", { className: "fs-input", spellCheck: false, autoComplete: "off", ...props, className: cx("fs-input", props.className) });
		const Num = (props) => h("input", { type: "number", inputMode: "numeric", ...props, className: "fs-input num" });
		const Area = (props) => h("textarea", { rows: 2, spellCheck: false, ...props, className: "fs-input wide" });

		function Secret({ value, onChange, onBlur, placeholder, label }) {
			const [shown, setShown] = react.useState(false);
			return h("div", { className: "fs-affix" },
				h("input", { className: "fs-input", type: shown ? "text" : "password", value, placeholder, onChange, onBlur, autoComplete: "off", spellCheck: false, "aria-label": label }),
				IconButton("eye", shown ? "隐藏" : "显示", () => setShown(!shown)));
		}
		const Select = (props, ...options) => h("div", { className: "fs-affix select" },
			h("select", { ...props, className: "fs-input" }, ...options), Icon("chevron", 12));

		const Empty = (text) => h("div", { className: "fs-empty" }, text);
		const Item = ({ key, lead, text, title, meta }) => h("div", { className: "fs-item", key },
			lead ?? null, h("span", { className: "fs-item-main", title: title ?? text }, text), meta ? h("span", { className: "fs-item-meta" }, ...meta) : null);

		/** 表单：服务端数据到了才初始化一次，之后本地编辑、失焦保存。 */
		function useForm(data, init) {
			const [form, setForm] = react.useState(null);
			react.useEffect(() => { if (data && form === null) setForm(init()); }, [data, form]);
			return [form, setForm, (p) => setForm((f) => ({ ...f, ...p }))];
		}
		const split = (v, re = /[,，\s]+/) => String(v).split(re).map((x) => x.trim()).filter(Boolean);

		const ui = { h, cx, Icon, Switch, Button, IconButton, Seg, Dot, State, Tag, Muted, Row, Group, Input, Num, Area, Secret, Select, Empty, Item, useForm, split };

		// ── 记忆检索 ──
		function RetrievalPane({ data, refresh, notify }) {
			const cfg = data?.config ?? {};
			const vecMeta = data?.vecMeta ?? {};
			const cov = data?.coverage ?? {};
			const [probing, setProbing] = react.useState(false);
			const [form, setForm, patch] = useForm(data, () => ({
				enabled: cfg.enabled !== false, baseURL: cfg.baseURL ?? "", apiKey: "", model: cfg.model ?? "",
				fusionMethod: cfg.fusionMethod ?? "rrf", topK: cfg.topK ?? 5, tokenBudget: cfg.tokenBudget ?? 1200
			}));
			if (!data || !form) return null;

			const dirty = form.baseURL !== (cfg.baseURL ?? "") || form.model !== (vecMeta.modelId ?? cfg.model ?? "");
			const configured = Boolean((cfg.hasApiKey || form.apiKey !== "") && form.baseURL !== "" && form.model !== "");
			const building = cov.isWorkerRunning === true || vecMeta.status === "building";
			const status = !configured || vecMeta.status === "error" ? "error" : building ? "building" : dirty || vecMeta.status === "stale" ? "stale" : "ready";
			const total = cov.totalActiveCount ?? 0;
			const done = cov.vectorizedCount ?? 0;
			const partial = done > 0 && done < total;

			async function save(p = {}) {
				const next = { ...form, ...p };
				setForm(next);
				const res = await api("POST", "/retrieval/config", {
					enabled: next.enabled, baseURL: next.baseURL, ...(next.apiKey ? { apiKey: next.apiKey } : {}), model: next.model,
					fusionMethod: next.fusionMethod, topK: next.topK, tokenBudget: next.tokenBudget
				});
				if (res?.ok) refresh(); else notify(res?.error ?? "保存失败");
			}
			async function probe() {
				setProbing(true);
				const res = await api("POST", "/retrieval/probe", { baseURL: form.baseURL, ...(form.apiKey ? { apiKey: form.apiKey } : {}), model: form.model, timeoutMs: 800 });
				setProbing(false);
				notify(res?.ok ? `可用 · ${res.latencyMs}ms` : (res?.message ?? "连接失败"));
				refresh();
			}
			async function rebuild(action) {
				const res = await api("POST", "/retrieval/rebuild", { action });
				if (res?.ok) refresh(); else notify(res?.error ?? "重建失败");
			}

			const lat = vecMeta.lastProbeLatencyMs;
			const conn = status === "ready" ? State("done", lat ? `可用 · ${lat}ms` : "可用")
				: status === "stale" ? State("warning", "模型变了，需要重建索引")
				: status === "building" ? State("ongoing", "正在重建")
				: State(configured ? "error" : "idle", configured ? "连不上，先只用关键词" : "未配置");
			const rebuildBtn = building ? Button({ onClick: () => rebuild("pause") }, "暂停")
				: Button({ variant: status === "stale" ? "primary" : undefined, disabled: status !== "ready" && status !== "stale", onClick: () => rebuild(status !== "stale" && partial ? "resume" : "start") },
					status !== "stale" && partial ? "继续重建" : "重建");
			const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;

			return h(react.Fragment, null,
				Group({},
					Row({ title: "检索方式" }, h(Seg, { label: "检索方式", options: [{ value: "bm25", label: "关键词" }, { value: "hybrid", label: "混合" }], value: form.enabled ? "hybrid" : "bm25", onChange: (v) => save({ enabled: v === "hybrid" }) })),
					Row({ title: "召回条数" }, Num({ min: 1, max: 20, value: form.topK, onChange: (e) => patch({ topK: Number(e.target.value) || 5 }), onBlur: () => save() })),
					Row({ title: "Token 预算" }, Num({ min: 300, max: 4000, step: 100, value: form.tokenBudget, onChange: (e) => patch({ tokenBudget: Number(e.target.value) || 1200 }), onBlur: () => save() }))),
				form.enabled ? Group({ title: "向量", aside: conn },
					Row({ title: "接口地址" }, Input({ value: form.baseURL, placeholder: "https://…/v1", onChange: (e) => patch({ baseURL: e.target.value }), onBlur: () => save() })),
					Row({ title: "密钥" }, h(Secret, { label: "密钥", value: form.apiKey, placeholder: cfg.hasApiKey ? (cfg.apiKeyMasked ?? "已保存") : "sk-…", onChange: (e) => patch({ apiKey: e.target.value }), onBlur: () => { if (form.apiKey !== "") save(); } })),
					Row({ title: "模型" }, vecMeta.dim ? Tag(`${vecMeta.dim} 维`) : null,
						Input({ value: form.model, onChange: (e) => patch({ model: e.target.value }), onBlur: () => save() }),
						Button({ disabled: probing || form.baseURL === "" || form.model === "", onClick: probe }, probing ? "测试中…" : "测试")),
					Row({ title: "融合" }, h(Seg, { label: "融合", options: [{ value: "rrf", label: "RRF" }, { value: "weighted", label: "加权" }], value: form.fusionMethod, onChange: (v) => save({ fusionMethod: v }) })),
					Row({ title: "索引" },
						h("div", { className: "fs-track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": done },
							h("div", { className: "fs-fill", "data-state": building ? "ongoing" : status === "ready" ? undefined : "warning", style: { width: `${pct}%` } })),
						Muted(`${done.toLocaleString()} / ${total.toLocaleString()}`, { className: "fs-unit num", title: vecMeta.builtAt ? `上次重建 ${relTime(vecMeta.builtAt, Date.now())}` : undefined }),
						rebuildBtn)) : null,
				h(DigestGroup, { notify }));
		}

		// 聊完自动记：一段聊天空下来就整理（契约 34–35）
		function DigestGroup({ notify }) {
			const [d, setD] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [idle, setIdle] = react.useState("");
			const load = react.useCallback(async () => { const r = await api("GET", "/memory/state"); if (r?.ok) setD(r); }, []);
			react.useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
			react.useEffect(() => { if (d && idle === "") setIdle(String(d.idleMinutes)); }, [d]);
			if (!d) return null;
			async function save(p) {
				const r = await api("POST", "/memory/config", p);
				if (r?.ok) setD(r); else notify(r?.error ?? "保存失败");
			}
			async function now() {
				setBusy(true);
				const r = await api("POST", "/memory/digest-now", {});
				setBusy(false);
				if (r?.ok) { setD(r); notify(r.chats ? `整理了 ${r.chats} 段，记了 ${r.added} 条` : "没有要整理的"); } else notify(r?.error ?? "整理失败");
			}
			const last = d.last;
			const lastText = last ? `${relTime(last.at, Date.now())} · ${last.title || last.channelId} · 记了 ${(last.added ?? 0) + (last.self ?? 0)} 条${last.summary ? `：${last.summary}` : ""}` : "还没整理过";
			return Group({ title: "聊完自动记", aside: d.running ? State("ongoing", "整理中") : d.pending > 0 ? Muted(`攒了 ${d.pending} 句`) : null },
				Row({ title: "自动整理", desc: "聊天空下来就记下事实、她自己说过的话、一句小结，顺便更新好感和情绪" },
					h(Switch, { label: "自动整理", checked: d.autoExtract, onChange: (v) => save({ autoExtract: v }) })),
				d.autoExtract ? Row({ title: "空多久整理" },
					Num({ min: 1, max: 240, value: idle, onChange: (e) => setIdle(e.target.value), onBlur: () => { const n = Number(idle); if (n >= 1 && n !== d.idleMinutes) save({ idleMinutes: n }); } }), Muted("分钟")) : null,
				Row({ title: "上次", desc: lastText },
					Button({ disabled: busy || d.running || d.pending === 0, onClick: now }, busy ? "整理中…" : "现在整理")));
		}

		// ── 自走与主动 ──
		function LifePane({ data, refresh, notify }) {
			const clock = data?.clock ?? {};
			const today = data?.today ?? {};
			const pc = data?.proactiveConfig ?? {};
			const targets = pc.targets ?? {};
			const [newGroup, setNewGroup] = react.useState("");
			const [form, setForm, patch] = useForm(data, () => ({
				enabled: pc.enabled !== false, dailyMaxCount: pc.dailyMaxCount ?? 10,
				activeStart: pc.activeHours?.[0] ?? 8, activeEnd: pc.activeHours?.[1] ?? 24, idleTriggerHours: pc.idleTriggerHours ?? 6,
				masterPrivateChannelId: targets.masterPrivateChannelId ?? "", selfGroupChannelIds: [...(targets.selfGroupChannelIds ?? [])]
			}));
			if (!data || !form) return null;

			const scale = clock.timeScale ?? 1;
			const slot = today.currentSlot ?? {};
			const schedule = today.scheduleSummary ?? [];
			const sleeping = slot.availability === "sleeping" || slot.availability === "sleep";

			async function save(p = {}) {
				const next = { ...form, ...p };
				setForm(next);
				const res = await api("POST", "/life/proactive-config", {
					enabled: next.enabled,
					dailyMaxCount: Math.min(50, Math.max(0, Math.floor(Number(next.dailyMaxCount)))),
					activeHours: [next.activeStart, next.activeEnd],
					idleTriggerHours: next.idleTriggerHours,
					targets: { masterCanonicalId: targets.masterCanonicalId ?? "user:master", masterPrivateChannelId: next.masterPrivateChannelId, selfGroupChannelIds: next.selfGroupChannelIds }
				});
				if (res?.ok) refresh(); else notify(res?.error ?? "保存失败");
			}
			function addGroup() {
				let v = newGroup.trim();
				if (!v) return;
				if (!v.startsWith("group:")) v = `group:${v}`;
				if (!form.selfGroupChannelIds.includes(v)) save({ selfGroupChannelIds: [...form.selfGroupChannelIds, v] });
				setNewGroup("");
			}
			const num = (name, label, min, max, fallback) => Num({ min, max, value: form[name], "aria-label": label,
				onChange: (e) => patch({ [name]: e.target.value === "" ? "" : Number(e.target.value) }), onBlur: () => save({ [name]: form[name] === "" ? fallback : form[name] }) });

			return h(react.Fragment, null,
				h("section", { className: "fs-group" },
					h("div", { className: "fs-now" },
						Dot(sleeping ? "idle" : "done"),
						h("span", { className: "fs-now-title" }, slot.activity ?? "未排期"),
						today.dailyMoodTone ? Tag(today.dailyMoodTone) : null,
						h("span", { className: "fs-now-meta" },
							clock.isAccelerated || scale > 1 ? Tag(`${scale}×`, "warning") : null,
							h("span", null, fmtClock(clock.virtualNowMs)))),
					schedule.length > 0 ? h("div", { className: "fs-schedule" },
						schedule.map((s, i) => h("div", { className: "fs-slot", key: i, "aria-current": s.range === slot.range },
							h("span", null, s.range), h("span", { title: s.activity }, s.activity)))) : null),
				Group({},
					Row({ title: "主动开口" }, h(Switch, { label: "主动开口", checked: form.enabled, onChange: (v) => save({ enabled: v }) })),
					form.enabled ? Row({ title: "每天最多" }, Tag(`今天 ${today.proactiveCount ?? 0}`), num("dailyMaxCount", "每天最多", 0, 50, 10), Muted("次")) : null,
					form.enabled ? Row({ title: "时段" }, num("activeStart", "开始", 0, 23, 8), Muted("–"), num("activeEnd", "结束", 1, 24, 24), Muted("点")) : null,
					form.enabled ? Row({ title: "空闲多久后" }, num("idleTriggerHours", "空闲多久后", 1, 48, 6), Muted("小时")) : null,
					form.enabled ? Row({ title: "主人私聊" }, Input({ value: form.masterPrivateChannelId, placeholder: "private:主人 QQ", onChange: (e) => patch({ masterPrivateChannelId: e.target.value }), onBlur: () => save() })) : null,
					form.enabled ? Row({ title: "群聊", stack: true },
						...form.selfGroupChannelIds.map((cid) => Tag(cid, undefined, { key: cid },
							h("button", { type: "button", "aria-label": `移除 ${cid}`, onClick: () => save({ selfGroupChannelIds: form.selfGroupChannelIds.filter((x) => x !== cid) }) }, Icon("close", 12)))),
						Input({ value: newGroup, placeholder: "group:群号", style: { flex: "0 1 160px", width: "160px" }, onChange: (e) => setNewGroup(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") addGroup(); } }),
						Button({ variant: "ghost", disabled: newGroup.trim() === "", onClick: addGroup }, "添加")) : null));
		}

		// ── QQ 接入（SnowLuma 直连）与会话工作区 ──
		function ChannelPane({ data, refresh, notify }) {
			const qq = data?.qq ?? {};
			const ses = data?.sessions ?? {};
			const [busy, setBusy] = react.useState(false);
			const [form, setForm, patch] = useForm(data, () => ({
				enabled: qq.enabled === true, wsUrl: qq.wsUrl ?? "ws://127.0.0.1:3001", accessToken: "", masterQqUin: data.masterQqUin ?? "",
				groupAllowList: (qq.groupAllowList ?? []).join(", "), allGroups: qq.allGroups === true, followUpCount: qq.followUpCount ?? 3, followUpSeconds: qq.followUpSeconds ?? 120,
				callNames: (qq.callNames ?? []).join(", "), ij: { ...(qq.interject ?? {}), chance: Math.round((qq.interject?.chance ?? 0.05) * 100), keywords: (qq.interject?.keywords ?? []).join(", ") }
			}));
			if (!data || !form) return null;

			async function save(p = {}) {
				const next = { ...form, ...p };
				setForm(next);
				const res = await api("POST", "/channels/qq-config", {
					enabled: next.enabled, wsUrl: next.wsUrl, ...(next.accessToken !== "" ? { accessToken: next.accessToken } : {}),
					masterQqUin: next.masterQqUin, groupAllowList: split(next.groupAllowList), allGroups: next.allGroups === true,
					followUpCount: Number(next.followUpCount), followUpSeconds: Number(next.followUpSeconds), callNames: split(next.callNames),
					interject: { enabled: next.ij.enabled === true, chance: Number(next.ij.chance) / 100, cooldownMinutes: Number(next.ij.cooldownMinutes), maxPerHour: Number(next.ij.maxPerHour), keywords: split(next.ij.keywords) }
				});
				if (res?.ok) { if (next.accessToken !== "") setForm({ ...next, accessToken: "" }); refresh(); } else notify(res?.error ?? "保存失败");
			}
			async function run(path, body, okText, failText) {
				setBusy(true);
				const res = await api("POST", path, body);
				setBusy(false);
				if (res?.ok) notify(typeof okText === "function" ? okText(res) : okText); else notify(res?.error ?? failText);
				refresh();
			}

			const connected = qq.connected === true;
			const status = !form.enabled ? null : connected ? State("done", `${qq.nickname || qq.selfId || ""}${qq.friendCount != null ? ` · ${qq.friendCount} 位好友` : ""}`) : qq.lastError ? State("error", qq.lastError) : State("ongoing", "连接中");
			const field = (name, props) => Input({ value: form[name], onChange: (e) => patch({ [name]: e.target.value }), onBlur: () => save(), ...props });
			const chats = ses.chats ?? [];
			const ij = form.ij;
			const ijNum = (name, label, min, max) => Num({ min, max, value: ij[name] ?? "", "aria-label": label, onChange: (e) => patch({ ij: { ...ij, [name]: e.target.value } }), onBlur: () => save() });
			const pause = (c) => run("/sessions/pause", { channelId: c.channelId, minutes: c.paused ? 0 : -1 }, c.paused ? "已恢复" : "已暂停：只记不回", "操作失败");
			const elsewhere = chats.filter((c) => c.workspacePath !== ses.workspacePath).length;

			return h(react.Fragment, null,
				Group({},
					Row({ title: "QQ 接入" }, status, h(Switch, { label: "QQ 接入", checked: form.enabled, onChange: (v) => save({ enabled: v }) })),
					form.enabled ? Row({ title: "SnowLuma 地址" }, field("wsUrl", { placeholder: "ws://127.0.0.1:3001" })) : null,
					form.enabled ? Row({ title: "访问令牌" }, h(Secret, { label: "访问令牌", value: form.accessToken, placeholder: qq.hasToken ? qq.tokenMasked : "accessToken", onChange: (e) => patch({ accessToken: e.target.value }), onBlur: () => { if (form.accessToken !== "") save(); } })) : null,
					form.enabled ? Row({ title: "主人 QQ" }, field("masterQqUin", { inputMode: "numeric" })) : null,
					form.enabled ? Row({ title: "所有群" }, h(Switch, { label: "所有群", checked: form.allGroups, onChange: (v) => save({ allGroups: v }) }), Muted(form.allGroups ? "任何群里 @ 都回" : "只回下面列的群")) : null,
					form.enabled && !form.allGroups ? Row({ title: "只在这些群" }, field("groupAllowList", { placeholder: "群号，逗号分隔；空 = 谁都不回" })) : null,
					form.enabled ? Row({ title: "点名后接着听" },
						Num({ min: 0, max: 20, value: form.followUpCount, "aria-label": "条数", onChange: (e) => patch({ followUpCount: e.target.value }), onBlur: () => save() }), Muted("条"),
						Num({ min: 0, max: 1800, value: form.followUpSeconds, "aria-label": "秒数", onChange: (e) => patch({ followUpSeconds: e.target.value }), onBlur: () => save() }), Muted("秒")) : null,
					form.enabled ? Row({ title: "叫这些名字也算点名" }, field("callNames", { placeholder: "人格卡名字" })) : null,
					form.enabled ? Row({ title: "群里主动插话" }, h(Switch, { label: "群里主动插话", checked: ij.enabled === true, onChange: (v) => save({ ij: { ...ij, enabled: v } }) })) : null,
					form.enabled && ij.enabled ? Row({ title: "插话概率" }, ijNum("chance", "插话概率", 0, 100), Muted("%"), ijNum("maxPerHour", "每小时最多", 0, 30), Muted("次/小时")) : null,
					form.enabled && ij.enabled ? Row({ title: "说完话后冷却" }, ijNum("cooldownMinutes", "冷却", 0, 1440), Muted("分钟")) : null,
					form.enabled && ij.enabled ? Row({ title: "感兴趣的话题" }, Input({ value: ij.keywords ?? "", placeholder: "猫, 原神, 考研", onChange: (e) => patch({ ij: { ...ij, keywords: e.target.value } }), onBlur: () => save() })) : null,
					form.enabled ? Row({ title: "收藏表情包", desc: qq.stickers?.collect !== false ? undefined : "看到喜欢的表情会存下来，之后自己用" }, h(Switch, { label: "收藏表情包", checked: qq.stickers?.collect !== false, onChange: (v) => run("/stickers/config", { collect: v }, v ? "会收藏喜欢的表情了" : "不再收藏表情", "保存失败") })) : null,
					form.enabled ? Row({ title: "学群里的说法", desc: qq.slang?.enabled !== false ? undefined : "学每个群的梗和说话风格" }, h(Switch, { label: "学群里的说法", checked: qq.slang?.enabled !== false, onChange: (v) => run("/slang/config", { enabled: v }, v ? "会学群里的说法了" : "不再学群里的说法", "保存失败") })) : null,
					form.enabled && qq.slang?.enabled !== false ? Row({ title: "学说话方式", desc: "从别人的话里学「什么场合怎么说」，只学别人的、不带人名" }, h(Switch, { label: "学说话方式", checked: qq.slang?.expressions !== false, onChange: (v) => run("/slang/config", { expressions: v }, v ? "会学说话方式了" : "不再学说话方式", "保存失败") })) : null,
					form.enabled && qq.slang?.enabled !== false ? Row({ title: "私聊也学", desc: "好友私聊里学到的只在那个私聊里用" }, h(Switch, { label: "私聊也学", checked: qq.slang?.privateChats !== false, onChange: (v) => run("/slang/config", { privateChats: v }, v ? "私聊里也会学了" : "只学群里的", "保存失败") })) : null),
				Group({ title: "会话", aside: chats.length > 0 ? Tag(String(chats.length), "outline") : null },
					Row({ title: "工作区" }, Select({ disabled: busy, value: ses.isDedicated ? "__dedicated__" : ses.workspacePath, "aria-label": "工作区",
						onChange: (e) => run("/sessions/workspace", e.target.value === "__dedicated__" ? { dedicated: true } : { path: e.target.value }, "新会话会放在这里", "切换失败") },
						h("option", { key: "__dedicated__", value: "__dedicated__" }, "鱼的专用工作区"),
						...(ses.workspaces ?? []).filter((w) => w.path !== ses.dedicatedPath).map((w) => h("option", { key: w.path, value: w.path }, `${w.title || "未命名"} · ${w.path}`)))),
					elsewhere > 0 ? Row({ title: `${elsewhere} 个会话在别的工作区` }, Button({ disabled: busy, onClick: () => run("/sessions/migrate", {}, (r) => `已迁移 ${r.migrated} 个${r.failed?.length ? `，${r.failed.length} 个失败` : ""}`, "迁移失败") }, "迁过来")) : null,
					chats.length > 0 ? h("div", { className: "fs-list" }, chats.slice(0, 30).map((c) => Item({ key: c.sessionId, text: c.title || c.sessionId, meta: [
						c.paused ? Tag("暂停中", "warning", { key: "p" }) : null, h("span", { key: "c" }, c.channelId),
						Button({ key: "b", variant: "ghost", disabled: busy, onClick: () => pause(c) }, c.paused ? "恢复" : "暂停")] }))) : null));
		}

		// ── B站（登录 / 私信 / 自己刷视频） ──
		function BiliPane({ data, refresh, notify }) {
			const b = data?.bili ?? {};
			const br = b.browse ?? {};
			const [qr, setQr] = react.useState(null);
			const [cookie, setCookie] = react.useState("");
			const [acTime, setAcTime] = react.useState("");
			const [showCookie, setShowCookie] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [form, , patch] = useForm(data, () => ({
				masterUid: b.masterUid ?? "", allowList: (b.allowList ?? []).join(", "), links: (b.links ?? []).join("\n"),
				perDay: br.perDay ?? 3, videosPerSession: br.videosPerSession ?? 3,
				postPerDay: b.post?.perDay ?? 1, commentsPerHour: b.comments?.perHour ?? 6
			}));

			// 扫码状态 2s 轮询一次
			const qrLive = qr !== null && (qr.status === "waiting" || qr.status === "scanned");
			react.useEffect(() => {
				if (!qrLive) return undefined;
				const timer = setInterval(async () => {
					const r = await api("POST", "/bili/qr/poll", {});
					if (!r?.ok) { setQr((q) => (q ? { ...q, status: "error", error: r?.error ?? "出错了" } : q)); return; }
					if (r.status === "ok") { setQr(null); notify(`已登录 ${r.uname || ""}`); refresh(); return; }
					setQr((q) => (q ? { ...q, status: r.status } : q));
				}, 2000);
				return () => clearInterval(timer);
			}, [qrLive]);
			if (!data || !form) return null;

			const act = async (path, body, okMsg, failMsg) => {
				setBusy(true);
				const r = await api("POST", path, body);
				setBusy(false);
				if (!r?.ok) notify(r?.error ?? failMsg);
				else { if (okMsg) notify(typeof okMsg === "function" ? okMsg(r) : okMsg); refresh(); }
				return r;
			};
			const save = (p = {}) => act("/channels/bili-config", {
				masterUid: form.masterUid, allowList: split(form.allowList), links: split(form.links, /\n+/), ...(p.top ?? {}),
				browse: { perDay: Number(form.perDay), videosPerSession: Number(form.videosPerSession), ...(p.browse ?? {}) },
				post: { perDay: Number(form.postPerDay), ...(p.post ?? {}) },
				comments: { perHour: Number(form.commentsPerHour), ...(p.comments ?? {}) }
			}, null, "保存失败");
			const startQr = async () => {
				const r = await act("/bili/qr/start", {}, null, "拿不到二维码");
				if (r?.ok) { setShowCookie(false); setQr({ svg: r.svg, status: "waiting" }); }
			};
			const cookieLogin = async () => {
				const r = await act("/bili/cookie", { cookie, acTimeValue: acTime }, (x) => `已登录 ${x.uname || ""}`, "登录失败");
				if (r?.ok) { setCookie(""); setAcTime(""); setShowCookie(false); }
			};
			const sw = (label, checked, onChange) => h(Switch, { label, checked, onChange });
			const field = (name, props) => Input({ value: form[name], onChange: (e) => patch({ [name]: e.target.value }), onBlur: () => save(), ...props });

			const live = b.loggedIn && !b.authInvalid;
			const account = live ? State("done", b.uname || `UID ${b.uid}`, `UID ${b.uid || "?"}`) : b.authInvalid ? State("error", "登录失效") : State("idle", "未登录");
			const renewIssue = !live ? null : !b.canRenew ? "这种登录不能自动续期，扫码登录一次就好" : b.renewError ? `续期失败：${b.renewError}` : null;
			const poll = !b.enabled || !live ? null : b.lastError ? State("error", b.lastError) : b.lastPollAt ? State("done", relTime(b.lastPollAt, Date.now()), "上次收私信") : State("ongoing", "启动中");
			const qrText = qr === null ? null : qr.status === "scanned" ? "在手机上确认" : qr.status === "expired" ? "二维码过期了" : qr.status === "error" ? (qr.error || "出错了") : "用 B站 App 扫码";
			const recent = b.recent ?? [];
			const so = b.social ?? {};
			const post = b.post ?? {};
			const cm = b.comments ?? {};
			const socialLog = [
				...(so.post?.recent ?? []).map((x) => ({ key: `p${x.id}`, tag: Tag("动态", "outline"), text: x.content, at: x.at })),
				...(so.comments?.recent ?? []).map((x, i) => ({ key: `c${i}${x.at}`, tag: Tag(x.status === "replied" ? "回了" : x.status === "failed" ? "没发出" : "没回", x.status === "failed" ? "danger" : undefined),
					text: `${x.name}：${x.content}${x.reply ? ` → ${x.reply}` : ""}`, at: x.at }))
			].sort((x, y) => y.at - x.at).slice(0, 10);

			return h(react.Fragment, null,
				Group({ title: "账号" },
					Row({ title: "B站账号" }, account, renewIssue ? Tag("不能续期", "warning", { title: renewIssue }) : null,
						Button({ variant: live ? undefined : "primary", disabled: busy, onClick: startQr }, live ? "换号" : "扫码登录"),
						Button({ variant: "ghost", "aria-expanded": showCookie, onClick: () => { setQr(null); setShowCookie(!showCookie); } }, "Cookie"),
						b.loggedIn ? Button({ variant: "danger", disabled: busy, onClick: () => act("/bili/logout", {}, "已退出", "退出失败") }, "退出") : null),
					qr === null ? null : h("div", { className: "fs-qr" },
						qr.status === "expired" || qr.status === "error" ? null
							: h("img", { alt: "B站登录二维码", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}` }),
						State(qr.status === "scanned" ? "ongoing" : qr.status === "expired" || qr.status === "error" ? "error" : "idle", qrText),
						qr.status === "expired" || qr.status === "error" ? Button({ onClick: startQr }, "重新获取") : null),
					showCookie ? Row({ title: "Cookie" }, h(Secret, { label: "Cookie", value: cookie, placeholder: "SESSDATA=…; bili_jct=…", onChange: (e) => setCookie(e.target.value) })) : null,
					showCookie ? Row({ title: "ac_time_value" }, h(Secret, { label: "ac_time_value", value: acTime, placeholder: "可选，用于自动续期", onChange: (e) => setAcTime(e.target.value) }),
						Button({ variant: "primary", disabled: busy || cookie === "", onClick: cookieLogin }, "登录")) : null,
					Row({ title: "B站接入" }, poll, sw("B站接入", b.enabled === true, (v) => save({ top: { enabled: v } })))),
				Group({ title: "私信" },
					Row({ title: "自动回复" }, b.autoReply ? null : Muted("只记不回"), sw("自动回复", b.autoReply === true, (v) => save({ top: { autoReply: v } }))),
					Row({ title: "主人 UID" }, field("masterUid", { inputMode: "numeric" })),
					Row({ title: "白名单" }, field("allowList", { placeholder: "UID，逗号分隔" })),
					Row({ title: "互关的人也回" }, sw("互关的人也回", b.replyMutual !== false, (v) => save({ top: { replyMutual: v } }))),
					Row({ title: "主动私信主人" }, sw("主动私信主人", b.proactive === true, (v) => save({ top: { proactive: v } }))),
					Row({ title: "同一个人", stack: true }, Area({ value: form.links, placeholder: "B站 UID=QQ 号，每行一个", onChange: (e) => patch({ links: e.target.value }), onBlur: () => save() }))),
				Group({ title: "刷视频", aside: Tag(`今天 ${br.todayCount ?? 0} / ${br.perDay ?? 3}`, "outline") },
					Row({ title: "空闲时自己刷" },
						br.enabled !== false ? Button({ variant: "ghost", disabled: br.running === true || b.enabled !== true, onClick: () => act("/bili/browse-now", {}, "开始刷了", "没刷成") }, br.running ? "正在刷…" : "现在刷") : null,
						sw("空闲时自己刷", br.enabled !== false, (v) => save({ browse: { enabled: v } }))),
					br.enabled !== false ? Row({ title: "每天" },
						Num({ min: 0, max: 12, value: form.perDay, "aria-label": "轮数", onChange: (e) => patch({ perDay: e.target.value }), onBlur: () => save() }), Muted("轮 ×"),
						Num({ min: 1, max: 6, value: form.videosPerSession, "aria-label": "每轮条数", onChange: (e) => patch({ videosPerSession: e.target.value }), onBlur: () => save() }), Muted("条")) : null,
					br.enabled !== false ? Row({ title: "喜欢就点赞" }, sw("喜欢就点赞", br.like === true, (v) => save({ browse: { like: v } }))) : null,
					br.enabled !== false ? Row({ title: "刷到有意思的发给你", desc: "带链接和感受，发到你的 QQ 私聊；一天最多 2 条" }, sw("刷到有意思的发给你", br.share !== false, (v) => save({ browse: { share: v } }))) : null),
				Group({ title: "动态和评论", aside: post.enabled ? Tag(`今天发了 ${so.post?.todayCount ?? 0} / ${post.perDay ?? 1}`, "outline") : null },
					Row({ title: "自己发动态", desc: "醒着的时候按心情和最近刷到的随手发，纯文字；默认关" },
						post.enabled ? Button({ variant: "ghost", disabled: busy || so.post?.running === true || b.enabled !== true, onClick: () => act("/bili/post-now", {}, (r) => `发了：${r.text}`, "没发成") }, so.post?.running ? "正在写…" : "现在发一条") : null,
						sw("自己发动态", post.enabled === true, (v) => save({ post: { enabled: v } }))),
					post.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 5, value: form.postPerDay, "aria-label": "每天最多几条", onChange: (e) => patch({ postPerDay: e.target.value }), onBlur: () => save() }), Muted("条")) : null,
					Row({ title: "回评论", desc: "别人在她的动态 / 视频下评论或回复她时回一句；广告、引战不回" },
						cm.enabled ? Button({ variant: "ghost", disabled: busy || b.enabled !== true, onClick: () => act("/bili/comments-now", {}, (r) => (r.replied || r.skipped ? `回了 ${r.replied} 条，跳过 ${r.skipped} 条` : "没有新评论"), "没看成") }, "现在看一眼") : null,
						sw("回评论", cm.enabled === true, (v) => save({ comments: { enabled: v } }))),
					cm.enabled ? Row({ title: "每小时最多" }, Num({ min: 0, max: 30, value: form.commentsPerHour, "aria-label": "每小时最多回几条", onChange: (e) => patch({ commentsPerHour: e.target.value }), onBlur: () => save() }), Muted("条")) : null,
					so.lastError ? Row({ title: "上次出错" }, State("error", so.lastError)) : null,
					socialLog.length === 0 ? null : h("div", { className: "fs-list" }, socialLog.map((x) => Item({ key: x.key, lead: x.tag, text: x.text, title: x.text, meta: [h("span", { key: "t" }, relTime(x.at, Date.now()))] })))),
				recent.length === 0 ? null : Group({ title: "最近看过" },
					h("div", { className: "fs-list" }, recent.map((v) => Item({
						key: v.bvid, lead: Tag(v.liked ? "赞" : v.skipped ? "划走" : v.source === "following" ? "关注" : "推荐", v.liked ? "danger" : undefined),
						text: `${v.title}${v.impression ? ` — ${v.impression}` : ""}`, title: `${v.title}${v.owner ? ` · ${v.owner}` : ""}${v.impression ? `\n${v.impression}` : ""}`,
						meta: [h("a", { key: "a", href: `https://www.bilibili.com/video/${v.bvid}`, target: "_blank", rel: "noreferrer" }, v.owner || v.bvid), h("span", { key: "t" }, relTime(v.seenAt, Date.now()))]
					})))));
		}

		// ── 按需加载的分块：抖音页（client.douyin.js）、记忆检视 / 动态（client.soul.js）、模型（client.models.js）、人格（client.persona.js）；控件通过 props.ui 传过去 ──
		const chunks = {};
		function ChunkTab({ file, pick, failText, ...props }) {
			const [mod, setMod] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				if (typeof require.async !== "function") {
					setMod({ error: "这个版本的 DSH 不支持按需加载，升级后再试" });
					return undefined;
				}
				chunks[file] ??= require.async(`./${file}`);
				chunks[file].then((m) => { if (alive) setMod({ Pane: pick(m) ?? pick(m?.default ?? {}) }); },
					(error) => { delete chunks[file]; if (alive) setMod({ error: String(error instanceof Error ? error.message : error) }); });
				return () => { alive = false; };
			}, [file]);
			if (mod === null) return h("div", { className: "fs-empty" }, Dot("ongoing"));
			if (!mod.Pane) return h("div", { className: "fs-notice", role: "alert" }, h("b", null, failText), h("span", null, mod.error || ""));
			return h(mod.Pane, { ...props, api, apiBase: API, relTime, fmtDueAt, ui });
		}

		// ── 面板根组件：页签 + 数据装载 + 轮询 ──
		const TABS = [["retrieval", "记忆检索"], ["persona", "人格"], ["life", "自走"], ["inspector", "记忆检视"], ["activity", "动态"], ["behavior", "习惯"], ["models", "模型"], ["qq", "QQ"], ["bili", "B站"], ["douyin", "抖音"]];

		// ── 首次引导：没点「不再显示」就在页签上面列一张清单 ──
		function Onboarding({ onGo, notify }) {
			const [data, setData] = react.useState(null);
			const load = react.useCallback(async () => { const r = await api("GET", "/onboarding/state"); if (r?.ok) setData(r); }, []);
			react.useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
			if (!data || data.dismissed) return null;
			async function dismiss() {
				const r = await api("POST", "/onboarding/dismiss", { dismissed: true });
				if (r?.ok) setData({ ...data, dismissed: true }); else notify(r?.error ?? "操作失败");
			}
			const left = data.steps.filter((x) => !x.done && !x.optional).length;
			return Group({ title: left === 0 ? "都弄好了" : `开始之前 · 还差 ${left} 步`, aside: Button({ variant: "ghost", onClick: dismiss }, "不再显示") },
				h("div", { className: "fs-list" }, data.steps.map((x) => h("div", { className: "fs-item", key: x.id },
					h("span", { className: "fs-dot", "data-state": x.done ? "done" : x.optional ? "idle" : "warning", "aria-hidden": true }),
					h("span", { className: cx("fs-item-main", x.done && "fs-muted") }, x.title),
					h("span", { className: "fs-item-meta" },
						x.optional && !x.done ? Tag("可选", "outline") : null,
						x.done ? h("span", null, "已完成") : x.tab ? Button({ variant: "ghost", onClick: () => onGo(x.tab) }, "去设置") : null)))));
		}
		function FishSoulSection() {
			const css = useCss();
			const [tab, setTab] = react.useState("retrieval");
			const [retrieval, setRetrieval] = react.useState(null);
			const [life, setLife] = react.useState(null);
			const [channels, setChannels] = react.useState(null);
			const [toast, setToast] = react.useState(null);
			const notify = react.useCallback((text) => setToast({ key: Date.now(), text }), []);

			react.useEffect(() => {
				if (toast === null) return undefined;
				const timer = setTimeout(() => setToast(null), 2400);
				return () => clearTimeout(timer);
			}, [toast]);

			const load = (path, set) => async () => { const res = await api("GET", path); if (res?.ok !== false) set(res); };
			const loadRetrieval = react.useCallback(load("/retrieval/state", setRetrieval), []);
			const loadLife = react.useCallback(load("/life/state", setLife), []);
			const loadChannels = react.useCallback(load("/channels/state", setChannels), []);

			react.useEffect(() => { loadRetrieval(); loadLife(); loadChannels(); }, []);
			// 检索页 2s 刷新（重建进度）；QQ / B站 / 抖音 3s 刷新
			react.useEffect(() => {
				const fn = tab === "retrieval" ? loadRetrieval : tab === "qq" || tab === "bili" || tab === "douyin" ? loadChannels : null;
				if (fn === null) return undefined;
				const timer = setInterval(fn, tab === "retrieval" ? 2000 : 3000);
				return () => clearInterval(timer);
			}, [tab]);
			// 虚拟时钟走秒（纯展示）
			react.useEffect(() => {
				if (tab !== "life") return undefined;
				const timer = setInterval(() => setLife((prev) => prev?.clock?.virtualNowMs
					? { ...prev, clock: { ...prev.clock, virtualNowMs: prev.clock.virtualNowMs + 1000 * (prev.clock.timeScale ?? 1) } } : prev), 1000);
				return () => clearInterval(timer);
			}, [tab]);

			if (css === null) return null;
			const pane = tab === "retrieval" ? h(RetrievalPane, { data: retrieval, refresh: loadRetrieval, notify })
				: tab === "life" ? h(LifePane, { data: life, refresh: loadLife, notify })
				: tab === "inspector" ? h(ChunkTab, { file: "client.soul.js", pick: (m) => m.InspectorPane, failText: "记忆检视加载失败", notify })
				: tab === "activity" ? h(ChunkTab, { file: "client.soul.js", pick: (m) => m.ActivityPane, failText: "动态加载失败", notify })
				: tab === "behavior" ? h(ChunkTab, { file: "client.behavior.js", pick: (m) => m.BehaviorPane, failText: "习惯页加载失败", notify })
				: tab === "models" ? h(ChunkTab, { file: "client.models.js", pick: (m) => m.ModelsPane, failText: "模型页加载失败", notify })
				: tab === "persona" ? h(ChunkTab, { file: "client.persona.js", pick: (m) => m.PersonaPane, failText: "人格页加载失败", notify })
				: tab === "qq" ? h(ChannelPane, { data: channels, refresh: loadChannels, notify })
				: tab === "bili" ? h(BiliPane, { data: channels, refresh: loadChannels, notify })
				: h(ChunkTab, { file: "client.douyin.js", pick: (m) => m.DouyinPane, failText: "抖音页加载失败", data: channels, refresh: loadChannels, notify });

			return h("div", { className: "fs" },
				css === "" ? null : h("style", { "data-plugin-css": `${PLUGIN_ID}/panel.css` }, css),
				h(Onboarding, { onGo: setTab, notify }),
				h(Tabs, { items: TABS, value: tab, onChange: setTab }),
				h("div", { className: "fs-pane", role: "tabpanel", id: "fs-tabpanel", "aria-labelledby": `fs-tab-${tab}`, key: tab }, pane),
				toast === null ? null : h("div", { className: "fs-toast", role: "status", key: toast.key }, toast.text));
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "fish-soul",
				order: 60,
				label: () => "鱼 · 记忆与自走"
			}, FishSoulSection)), `${PLUGIN_ID}: panel`);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
