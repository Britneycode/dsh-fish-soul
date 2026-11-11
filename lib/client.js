/**
 * dsh-fish-soul — 桌面端设置面板（client.js）
 *
 * 真源：业务逻辑见 DESIGN-fish-soul.md；接口契约见 lib/routes.js（100% 走 /api/plugins/fish-soul/*）。
 *
 * 宿主契约：
 *  - window.__ModuleLoader__.load({ id, factory })，exports.apply / inject；inject: ["slots"]
 *  - 通过 settings.section 保留设置入口；在宿主支持时通过 main + sidebar.panellist 注册独立页；样式随组件挂载 / 卸载
 *  - 优先使用宿主提供的 @deepseek-ai/dsh-client-ui-primitives；旧宿主缺失时基础控件降级，
 *    个别需要专用语义与布局的控件使用插件局部实现（lib/panel.css，fs- 前缀）
 *
 * 设计信条：Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
 *  - DeepSeek Harness 工作台骨架：主页与设置页共用两级顶部导航 | 居中主任务流 | 按需展开的详情面板
 *  - 动态 / 整理记录渲染成单行步骤胶囊（<details>），默认收起，点开看原因与想起的记忆
 *  - 平铺紧凑行（标题左 / 控件右），1px 低对比分隔；Row 的 desc 只作悬停提示，meta（实时状态）用等宽小字
 *  - 状态 = 一颗 StateDot + 一个短句；只在出问题时多说一句
 *  - 依赖总开关的设置，总开关关着就不显示
 *  - 只改视图层：状态、事件、接口调用保持原样
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		// 新版宿主把官方组件作为共享模块提供；旧宿主无此模块时保留原控件。
		/** @type {any} */
		let primitives = null;
		try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch { /* 旧宿主 */ }

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

		// ── 控件：参考 dsh-ui-primitives，自包含以兼容插件加载器 ──
		const ICONS = {
			eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
			close: "M7 7l10 10M17 7 7 17",
			refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
			chevron: "m7 10 5 5 5-5", chevronUp: "m7 14 5-5 5 5",
			edit: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4Z M13.5 6.5l4 4",
			sidebar: "M4 5h16v14H4Z M9 5v14",
			info: "M12 8h.01 M11 12h1v5h1 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"
		};
		const ICON_COMPONENTS = { close: "IconCloseOutlineRegular", refresh: "IconRefreshOutlineRegular", chevron: "IconChevronDownOutlineRegular", chevronUp: "IconChevronUpOutlineRegular", edit: "IconEditOutlineRegular", sidebar: "IconPanelLeftOutlineRegular", info: "IconInfoOutlineRegular" };
		const Icon = (name, size = 16) => primitives?.[ICON_COMPONENTS[name]] ? h(primitives[ICON_COMPONENTS[name]], { size, "aria-hidden": true })
			: h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: ICONS[name] }));

		function Switch({ checked, onChange, label, disabled }) {
			if (primitives?.Switch) return h(primitives.Switch, { checked: checked === true, onChange, label, disabled, className: "fs-native-switch" });
			return h("button", { type: "button", role: "switch", "aria-checked": checked === true, "aria-label": label, disabled, className: "fs-switch", onClick: () => onChange(!checked) },
				h("span", { className: "fs-switch-thumb" }));
		}
		const Button = ({ variant, ...props }, ...kids) => primitives?.Button
			? h(primitives.Button, { ...props, variant: variant === "danger" ? "outline" : variant ?? "outline", size: "sm", className: cx("fs-native-btn", variant === "danger" && "fs-native-danger", variant === "primary" && "fs-native-primary", props.className) }, ...kids)
			: h("button", { type: "button", ...props, className: cx("fs-btn", variant) }, ...kids);
		const IconButton = (icon, label, onClick, extra) => primitives?.Button
			? h(primitives.Button, { variant: "ghost", size: "sm", className: "fs-icon-btn fs-native-icon", "aria-label": label, title: label, onClick, ...extra }, Icon(icon, 14))
			: h("button", { type: "button", className: "fs-icon-btn", "aria-label": label, title: label, onClick, ...extra }, Icon(icon, 14));

		function Seg({ options, value, onChange, label }) {
			const index = Math.max(0, options.findIndex((o) => o.value === value));
			return h("div", { className: "fs-seg", role: "radiogroup", "aria-label": label, style: { "--n": options.length, "--i": index } },
				h("span", { className: "fs-seg-ind", "aria-hidden": true }),
				options.map((o) => h(primitives?.Pill ?? "button", {
					type: "button", key: o.value, role: "radio", "aria-checked": o.value === value,
					className: "fs-seg-btn", onClick: () => { if (o.value !== value) onChange(o.value); }
				}, o.label)));
		}

		function Tabs({ items, value, onChange, horizontal = false, hasUpdate = false }) {
			const navRef = react.useRef(null);
			react.useEffect(() => {
				const nav = navRef.current;
				const selected = nav?.querySelector('[role="tab"][aria-selected="true"]');
				if (!nav || !selected) return;
				const outer = nav.getBoundingClientRect(), inner = selected.getBoundingClientRect();
				if (inner.left < outer.left) nav.scrollLeft -= outer.left - inner.left;
				else if (inner.right > outer.right) nav.scrollLeft += inner.right - outer.right;
			}, [value]);
			const index = Math.max(0, items.findIndex(([v]) => v === value));
			const onKeyDown = (event, i) => {
				const n = items.length;
				const next = event.key === "ArrowLeft" || event.key === "ArrowUp" ? (i + n - 1) % n : event.key === "ArrowRight" || event.key === "ArrowDown" ? (i + 1) % n
					: event.key === "Home" ? 0 : event.key === "End" ? n - 1 : -1;
				if (next < 0) return;
				event.preventDefault();
				event.currentTarget.parentElement?.querySelectorAll('[role="tab"]').item(next)?.focus();
				onChange(items[next][0]);
			};
			return h("nav", { className: "fs-nav", ref: navRef, role: "tablist", "aria-label": "鱼", "aria-orientation": horizontal ? "horizontal" : "vertical", style: { "--n": items.length, "--i": index } },
				items.map(([v, label], i) => h("button", {
					type: "button", key: v, role: "tab", id: `fs-tab-${v}`, "aria-selected": v === value, "aria-controls": "fs-tabpanel",
					tabIndex: v === value ? 0 : -1, className: "fs-tab", title: v === "version" && hasUpdate ? "版本更新（有新版本）" : label, "aria-label": v === "version" && hasUpdate ? "版本更新（有新版本）" : label, onClick: () => onChange(v), onKeyDown: (e) => onKeyDown(e, i)
				}, h("span", { className: "fs-tab-key", "aria-hidden": true }, TAB_KEYS[v] ?? label.slice(0, 1)), h("span", { className: "fs-tab-label" }, label), v === "version" && hasUpdate ? h("span", { className: "fs-update-dot", "aria-hidden": true }) : null)));
		}

		// 大项是页面，不再让每个大项重复一个同名子页签。
		function GroupedTabs({ value, onChange, hasUpdate }) {
			const active = NAV_GROUPS.find((group) => group.id === value) ?? NAV_GROUPS[0];
			return h("div", { className: "fs-group-row" },
				h("span", { className: "fs-brand" }, "鱼"),
				h("nav", { className: "fs-group-nav", "aria-label": "设置分类" }, NAV_GROUPS.map((group) => {
					const selected = group.id === active.id;
					const showUpdate = hasUpdate && group.id === "system";
					return h("button", { type: "button", key: group.id, className: "fs-group-tab", "aria-pressed": selected,
						"aria-label": showUpdate ? `${group.label}（有新版本）` : group.label, onClick: () => onChange(group.id) },
						group.label, showUpdate ? h("span", { className: "fs-update-dot", "aria-hidden": true }) : null);
				})));
		}

		/** StateDot：done / warning / error / idle 是圆点，ongoing 是转圈。 */
		const Dot = (state) => primitives?.StateDot ? h(primitives.StateDot, { state }) : state === "ongoing"
			? h("svg", { className: "fs-spin", width: 14, height: 14, viewBox: "0 0 24 24", "aria-hidden": true },
				h("g", null, h("circle", { cx: 12, cy: 12, r: 9.5 }), h("circle", { cx: 12, cy: 12, r: 9.5 })))
			: h("span", { className: "fs-dot", "data-state": state, "aria-hidden": true });
		const State = (state, text, title) => h("span", { className: "fs-state", "data-state": state, title: title ?? text, role: "status" }, Dot(state), h("span", null, text));
		const Tag = (text, tone, extra, ...kids) => {
			if (!primitives?.Tag) return h("span", { className: "fs-tag", "data-tone": tone, ...extra }, text, ...kids);
			const tag = h(primitives.Tag, { tone: tone ?? "neutral", className: "fs-native-tag" }, text, ...kids);
			return extra ? h("span", { className: "fs-native-tag-wrap", ...extra }, tag) : tag;
		};
		const Pill = ({ active, children, ...props }) => primitives?.Pill
			? h(primitives.Pill, { ...props, active }, children)
			: h("button", { type: "button", ...props }, children);
		function Check({ checked, onChange, label, hideLabel, title }) {
			return primitives?.Checkbox ? h(primitives.Checkbox, { checked, onChange, label, title, className: cx("fs-native-check", hideLabel && "label-hidden") })
				: h("label", { className: cx("fs-native-check", hideLabel && "label-hidden"), title }, h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) }), h("span", null, label));
		}
		const Muted = (text, extra) => h("span", { className: "fs-unit", ...extra }, text);

		// 行：标题左 / 控件右。desc（解释性文字）不占版面，只作悬停提示；meta（实时状态）以等宽小字跟在标题下
		/** @param {{ title: any, desc?: any, meta?: any, stack?: boolean }} props @param {...any} kids */
		function Row({ title, desc, meta, stack }, ...kids) {
			const tip = typeof desc === "string" ? desc : undefined;
			return h("div", { className: cx("fs-row", stack && "stack") },
				h("div", { className: "fs-row-title" },
					h("span", { className: cx("fs-row-label", tip && "has-tip"), title: tip }, title),
					meta ? h("span", { className: "fs-row-meta" }, meta) : null),
				h("div", { className: "fs-ctl" }, ...kids));
		}
		/** @param {{ title?: any, aside?: any, tip?: string, className?: string }} props @param {...any} kids */
		function Group({ title, aside, tip, className }, ...kids) {
			return h("section", { className: cx("fs-group", className) },
				title ? h("h3", { className: "fs-group-head", title: tip }, h("span", null, title), aside ?? null) : null, ...kids);
		}
		const Input = (props) => {
			if (!primitives?.Input) return h("input", { spellCheck: false, autoComplete: "off", ...props, className: cx("fs-input", props.className) });
			const { className, style, ...input } = props;
			return h("span", { className: cx("fs-native-input-wrap", className), style }, h(primitives.Input, { spellCheck: false, autoComplete: "off", ...input, className: "fs-native-input" }));
		};
		function NumberControl(props) {
			const wrap = react.useRef(null);
			const step = (direction) => {
				const input = wrap.current?.querySelector('input');
				if (!input || input.disabled || input.readOnly) return;
				input.focus();
				const before = input.value;
				try { direction > 0 ? input.stepUp() : input.stepDown(); } catch { return; }
				if (before !== input.value) props.onChange?.({ target: input, currentTarget: input });
			};
			const chars = String(props.value ?? "").length;
			const numeric = props.value === "" || props.value == null ? NaN : Number(props.value);
			return h("span", { className: cx("fs-number", chars >= 4 && "long-value"), ref: wrap,
				style: chars >= 4 ? { width: `${Math.max(72, 40 + chars * 8)}px` } : undefined },
				Input({ type: "number", inputMode: "numeric", ...props, className: cx("num", props.className) }),
				h("span", { className: "fs-number-steps" }, ...[1, -1].map((direction) => h("button", {
					type: "button", key: direction, disabled: props.disabled || props.readOnly || (Number.isFinite(numeric) &&
						(direction > 0 ? props.max != null && numeric >= Number(props.max) : props.min != null && numeric <= Number(props.min))),
					"aria-label": `${direction > 0 ? "增加" : "减少"}${props["aria-label"] ?? "数值"}`,
					onMouseDown: (event) => event.preventDefault(), onClick: () => step(direction)
				}, Icon(direction > 0 ? "chevronUp" : "chevron", 9)))));
		}
		const Num = (props) => h(NumberControl, props);
		const Area = (props) => h("textarea", { rows: 2, spellCheck: false, ...props, className: "fs-input wide" });

		function Secret({ value, onChange, onBlur, placeholder, label }) {
			const [shown, setShown] = react.useState(false);
			return h("div", { className: "fs-affix" },
				Input({ type: shown ? "text" : "password", value, placeholder, onChange, onBlur, autoComplete: "off", spellCheck: false, "aria-label": label }),
				IconButton("eye", shown ? "隐藏" : "显示", () => setShown(!shown)));
		}
		function SelectControl({ selectProps, options }) {
			const [open, setOpen] = react.useState(false);
			const anchorRef = react.useRef(null);
			const entries = [];
			const add = (children, disabled = false) => react.Children.forEach(children, (option) => {
				if (!react.isValidElement(option)) return;
				if (option.type === "optgroup") {
					entries.push({ type: "label", id: `group-${entries.length}`, text: option.props.label });
					add(option.props.children, disabled || option.props.disabled);
				} else if (option.type === "option") {
					const value = String(option.props.value ?? option.props.children ?? "");
					entries.push({ id: `option-${entries.length}`, value, label: option.props.children, disabled: disabled || option.props.disabled });
				}
			});
			add(options);
			const selected = entries.find((entry) => entry.value === String(selectProps.value ?? ""));
			if (!primitives?.Menu) return h("div", { className: "fs-affix select" },
				h("select", { ...selectProps, className: "fs-input" }, ...options), Icon("chevron", 12));
			return h(primitives.Menu, {
				open: open && !selectProps.disabled, onClose: () => setOpen(false), items: entries,
				selectedId: selected?.id, portal: true, align: "end", minWidthFromAnchor: true, anchorRef,
				className: "fs-select-anchor",
				onSelect: (id) => {
					const choice = entries.find((entry) => entry.id === id && entry.type !== "label" && !entry.disabled);
					setOpen(false);
					if (choice && choice.value !== String(selectProps.value ?? "")) selectProps.onChange?.({ target: { value: choice.value }, currentTarget: { value: choice.value } });
				},
				anchor: h("button", { ref: anchorRef, type: "button", className: "fs-select-trigger", disabled: selectProps.disabled,
					"aria-label": selectProps["aria-label"], "aria-haspopup": "menu", "aria-expanded": open,
					onClick: () => setOpen((v) => !v) }, h("span", null, selected?.label ?? ""), Icon("chevron", 16))
			});
		}
		const Select = (props, ...options) => h(SelectControl, { selectProps: props, options });

		const Empty = (text) => h("div", { className: "fs-empty" }, text);
		const Item = ({ key, lead, text, title, meta, onRemove }) => h("div", { className: "fs-item", key },
			lead ?? null, h("span", { className: "fs-item-main", title: title ?? text }, text), meta ? h("span", { className: "fs-item-meta" }, ...meta) : null,
			onRemove ? IconButton("close", "删除", onRemove) : null);

		/** 表单：服务端数据到了才初始化一次，之后本地编辑、失焦保存。 */
		function useForm(data, init) {
			const [form, setForm] = react.useState(null);
			react.useEffect(() => { if (data && form === null) setForm(init()); }, [data, form]);
			return [form, setForm, (p) => setForm((f) => ({ ...f, ...p }))];
		}
		const split = (v, re = /[,，\s]+/) => String(v).split(re).map((x) => x.trim()).filter(Boolean);

		// 宿主原生确认对话框：优先用 dsh-client-ui-primitives 的 Modal（portal + mask + Esc + 原生样式）。
		// 用法：const confirm = useConfirm(); confirm({ title, description, confirmLabel? }) → Promise<boolean>
		// 旧宿主无 Modal 时退回 window.confirm，保证功能可用。
		function useConfirm() {
			const [pending, setPending] = react.useState(null);
			const confirm = react.useCallback((opts) => {
				if (!primitives?.Modal) return Promise.resolve(window.confirm(opts.description ? `${opts.title}\n\n${opts.description}` : opts.title));
				return new Promise((resolve) => { setPending({ ...opts, resolve }); });
			}, []);
			const settle = (ok) => () => { pending.resolve(ok); setPending(null); };
			const node = pending && primitives?.Modal
				? h(primitives.Modal, {
					open: true,
					title: pending.title,
					description: pending.description,
					closeLabel: "取消",
					onClose: settle(false),
					footer: h(react.Fragment, null,
						h(primitives.Button, { variant: "outline", size: "sm", onClick: settle(false) }, "取消"),
						h(primitives.Button, { variant: pending.danger ? "outline" : "primary", size: "sm", onClick: settle(true) }, pending.confirmLabel ?? "确定"))
				})
				: null;
			return [confirm, node];
		}

		const ui = { h, cx, Icon, Switch, Button, IconButton, Seg, Dot, State, Tag, Pill, Check, Muted, Row, Group, Input, Num, Area, Secret, Select, Empty, Item, useForm, split, useConfirm };

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
			const [tMax, setTMax] = react.useState(""); // 「整理时对照聊天原文」最多看几句
			const load = react.useCallback(async () => { const r = await api("GET", "/memory/state"); if (r?.ok) setD(r); }, []);
			react.useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
			react.useEffect(() => { if (d && idle === "") setIdle(String(d.idleMinutes)); }, [d]);
			react.useEffect(() => { if (d && tMax === "") setTMax(String(d.transcriptMaxLines ?? 40)); }, [d]);
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
				// 睡前整理（Dream）复核记忆时，要不要拿聊天原文对照
				Row({ title: "整理时对照聊天原文", desc: "睡前整理记忆时，把这段时间的真实对话一起给她看，好发现「记错了」的地方并改掉。要配合上面「聊天存档」开着才有原文；拿不到就自动只看记忆" },
					h(Switch, { label: "整理时对照聊天原文", checked: d.transcriptReview === true, onChange: (v) => save({ transcriptReview: v }) })),
				d.transcriptReview === true ? Row({ title: "最多看几句", desc: "一次给多少条原文，太多会占掉整理用的上下文" },
					Num({ min: 1, max: 200, value: tMax, onChange: (e) => setTMax(e.target.value), onBlur: () => { const n = Number(tMax); if (n >= 1 && n !== d.transcriptMaxLines) save({ transcriptMaxLines: n }); } }), Muted("句")) : null,
				Row({ title: "上次", meta: lastText },
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
				idleRealGapMinutes: pc.idleRealGapMinutes ?? 30, scheduleEnabled: pc.scheduleEnabled !== false,
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
					idleRealGapMinutes: next.idleRealGapMinutes,
					scheduleEnabled: next.scheduleEnabled,
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
				h("section", { className: "fs-life-overview" },
					h("div", { className: "fs-now" },
						h("div", { className: "fs-now-activity" }, Dot(sleeping ? "idle" : "done"),
							h("span", { className: "fs-now-title" }, slot.activity ?? "未排期")),
						h("span", { className: "fs-now-meta" },
							today.dailyMoodTone ? Tag(today.dailyMoodTone) : null,
							clock.isAccelerated || scale > 1 ? Tag(`${scale}×`, "warning") : null,
							h("span", null, fmtClock(clock.virtualNowMs)))),
					schedule.length > 0 ? h("div", { className: "fs-schedule" },
						schedule.map((s, i) => h("div", { className: "fs-slot", key: i, "aria-current": s.range === slot.range },
							h("span", null, s.range), h("span", { title: s.activity }, s.activity)))) : null),
				Group({ className: "fs-life-settings" },
					Row({ title: "主动开口" }, h(Switch, { label: "主动开口", checked: form.enabled, onChange: (v) => save({ enabled: v }) })),
					form.enabled ? Row({ title: "每天最多" }, Tag(`今天 ${today.proactiveCount ?? 0}`), num("dailyMaxCount", "每天最多", 0, 50, 10), Muted("次")) : null,
					form.enabled ? Row({ title: "时段" }, num("activeStart", "开始", 0, 23, 8), Muted("–"), num("activeEnd", "结束", 1, 24, 24), Muted("点")) : null,
					form.enabled ? Row({ title: "空闲多久后" }, num("idleTriggerHours", "空闲多久后", 1, 48, 6), Muted("小时")) : null,
					form.enabled ? Row({ title: "刚聊完先等等" }, num("idleRealGapMinutes", "刚聊完先等等", 0, 1440, 30), Muted("分钟"), Muted("0 = 不等")) : null,
					form.enabled ? Row({ title: "自走日程" }, h(Switch, { label: "自走日程", checked: form.scheduleEnabled, onChange: (v) => save({ scheduleEnabled: v }) }), Muted("关掉就不排今天干什么")) : null,
					form.enabled ? Row({ title: "主人私聊" }, Input({ value: form.masterPrivateChannelId, placeholder: "private:主人 QQ", onChange: (e) => patch({ masterPrivateChannelId: e.target.value }), onBlur: () => save() })) : null,
					form.enabled ? Row({ title: "群聊", stack: true },
						...form.selfGroupChannelIds.map((cid) => Tag(cid, undefined, { key: cid },
							IconButton("close", `移除 ${cid}`, () => save({ selfGroupChannelIds: form.selfGroupChannelIds.filter((x) => x !== cid) })))),
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
				groupAllowList: (qq.groupAllowList ?? []).join(", "), allGroups: qq.allGroups === true, followUpCount: qq.followUpCount ?? 3, followUpSeconds: qq.followUpSeconds ?? 120, batchMs: qq.batchMs ?? 3000,
				callNames: (qq.callNames ?? []).join(", "), ij: { ...(qq.interject ?? {}), chance: Math.round((qq.interject?.chance ?? 0.05) * 100), keywords: (qq.interject?.keywords ?? []).join(", ") },
				stickersPerDay: qq.stickers?.perDay ?? 10,
				ga: { enabled: qq.groupAdmin?.enabled === true, groupId: qq.groupAdmin?.groupId ?? "", announce: qq.groupAdmin?.announce !== false, autoApprove: qq.groupAdmin?.autoApprove !== false }
			}));
			if (!data || !form) return null;

			async function save(p = {}) {
				const next = { ...form, ...p };
				setForm(next);
				const res = await api("POST", "/channels/qq-config", {
					enabled: next.enabled, wsUrl: next.wsUrl, ...(next.accessToken !== "" ? { accessToken: next.accessToken } : {}),
					masterQqUin: next.masterQqUin, groupAllowList: split(next.groupAllowList), allGroups: next.allGroups === true,
					followUpCount: Number(next.followUpCount), followUpSeconds: Number(next.followUpSeconds), batchMs: Number(next.batchMs), callNames: split(next.callNames),
					interject: { enabled: next.ij.enabled === true, chance: Number(next.ij.chance) / 100, cooldownMinutes: Number(next.ij.cooldownMinutes), maxPerHour: Number(next.ij.maxPerHour), keywords: split(next.ij.keywords) },
					groupAdmin: { enabled: next.ga.enabled === true, groupId: next.ga.groupId, announce: next.ga.announce === true, autoApprove: next.ga.autoApprove === true }
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
			// 连上过又掉了和压根没连上要分得开：「连接中」只留给真的还在握手的第一次
			const status = !form.enabled ? null : connected ? State("done", `${qq.nickname || qq.selfId || ""}${qq.friendCount != null ? ` · ${qq.friendCount} 位好友` : ""}${qq.autoToken ? "（令牌自动同步）" : ""}`) : qq.lastError ? State(qq.connectedAt ? "error" : "ongoing", qq.lastError) : State("ongoing", "连接中");
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
					form.enabled ? Row({ title: "连着发几条时", desc: "你连着发消息，她等你停手再一起回；0 = 每条都回" },
						Num({ min: 0, max: 15000, step: 500, value: form.batchMs, "aria-label": "等待毫秒", onChange: (e) => patch({ batchMs: e.target.value }), onBlur: () => save({ batchMs: form.batchMs === "" ? 3000 : Number(form.batchMs) }) }), Muted("毫秒")) : null,
					form.enabled ? Row({ title: "叫这些名字也算点名" }, field("callNames", { placeholder: "人格卡名字" })) : null,
					form.enabled ? Row({ title: "群管理", desc: "发版时在群里公告更新说明 + 处理入群申请" },
						h(Switch, { label: "群管理", checked: form.ga.enabled === true, onChange: (v) => save({ ga: { ...form.ga, enabled: v } }) })) : null,
					form.enabled && form.ga.enabled ? Row({ title: "要管的群" },
						Input({ value: form.ga.groupId, placeholder: "群号", inputMode: "numeric", onChange: (e) => patch({ ga: { ...form.ga, groupId: e.target.value } }), onBlur: () => save() })) : null,
					form.enabled && form.ga.enabled ? Row({ title: "发版公告" },
						h(Switch, { label: "发版公告", checked: form.ga.announce === true, onChange: (v) => save({ ga: { ...form.ga, announce: v } }) }),
						Muted("有新版本就在这个群里发更新说明")) : null,
					form.enabled && form.ga.enabled ? Row({ title: "入群申请" },
						h(Switch, { label: "自动同意", checked: form.ga.autoApprove === true, onChange: (v) => save({ ga: { ...form.ga, autoApprove: v } }) }),
						Muted(form.ga.autoApprove === true ? "有人申请就同意" : "私聊通知你，回「/鱼 同意」或「/鱼 拒绝」")) : null,
					form.enabled ? Row({ title: "群里主动插话" }, h(Switch, { label: "群里主动插话", checked: ij.enabled === true, onChange: (v) => save({ ij: { ...ij, enabled: v } }) })) : null,
					form.enabled && ij.enabled ? Row({ title: "插话概率" }, ijNum("chance", "插话概率", 0, 100), Muted("%"), ijNum("maxPerHour", "每小时最多", 0, 30), Muted("次/小时")) : null,
					form.enabled && ij.enabled ? Row({ title: "说完话后冷却" }, ijNum("cooldownMinutes", "冷却", 0, 1440), Muted("分钟")) : null,
					form.enabled && ij.enabled ? Row({ title: "感兴趣的话题" }, Input({ value: ij.keywords ?? "", placeholder: "猫, 原神, 考研", onChange: (e) => patch({ ij: { ...ij, keywords: e.target.value } }), onBlur: () => save() })) : null,
					form.enabled ? Row({ title: "收藏表情包", desc: qq.stickers?.collect !== false ? undefined : "看到喜欢的表情会存下来，之后自己用" },
						h(Switch, { label: "收藏表情包", checked: qq.stickers?.collect !== false, onChange: (v) => run("/stickers/config", { collect: v }, v ? "会收藏喜欢的表情了" : "不再收藏表情", "保存失败") }),
						Num({ min: 0, max: 100, value: form.stickersPerDay, "aria-label": "每天收藏几张", onChange: (e) => patch({ stickersPerDay: e.target.value }), onBlur: () => { if (form.stickersPerDay !== "") run("/stickers/config", { perDay: form.stickersPerDay }, "每天的上限改了", "保存失败"); } }),
						Muted("张/天")) : null,
					form.enabled ? Row({ title: "学群里的说法", desc: qq.slang?.enabled !== false ? undefined : "学每个群的梗和说话风格" }, h(Switch, { label: "学群里的说法", checked: qq.slang?.enabled !== false, onChange: (v) => run("/slang/config", { enabled: v }, v ? "会学群里的说法了" : "不再学群里的说法", "保存失败") })) : null,
					form.enabled && qq.slang?.enabled !== false ? Row({ title: "学说话方式", desc: "从别人的话里学「什么场合怎么说」，只学别人的、不带人名" }, h(Switch, { label: "学说话方式", checked: qq.slang?.expressions !== false, onChange: (v) => run("/slang/config", { expressions: v }, v ? "会学说话方式了" : "不再学说话方式", "保存失败") })) : null,
					form.enabled && qq.slang?.enabled !== false ? Row({ title: "私聊也学", desc: "好友私聊里学到的只在那个私聊里用" }, h(Switch, { label: "私聊也学", checked: qq.slang?.privateChats !== false, onChange: (v) => run("/slang/config", { privateChats: v }, v ? "私聊里也会学了" : "只学群里的", "保存失败") })) : null),
				Group({ title: "会话", aside: chats.length > 0 ? Tag(String(chats.length), "outline") : null },
					Row({ title: "工作区" }, Select({ disabled: busy, value: ses.isDedicated ? "__dedicated__" : ses.workspacePath, "aria-label": "工作区",
						onChange: (e) => run("/sessions/workspace", e.target.value === "__dedicated__" ? { dedicated: true } : { path: e.target.value }, "新会话会放在这里", "切换失败") },
						h("option", { key: "__dedicated__", value: "__dedicated__" }, "鱼的专用工作区"),
						...(ses.workspaces ?? []).filter((w) => w.path !== ses.dedicatedPath).map((w) => h("option", { key: w.path, value: w.path }, `${w.title || "未命名"} · ${w.path}`)))),
					Row({ title: "回复发到哪", desc: "B站 / 抖音 私信跟 QQ 共用会话时，回在哪一边" },
						Select({ "aria-label": "回复发到哪", value: ses.replyTarget ?? "source",
							onChange: (e) => run("/sessions/reply-target", { replyTarget: e.target.value }, "回复发到这里", "保存失败") },
						h("option", { key: "source", value: "source" }, "哪边问的就回哪边"),
						h("option", { key: "qq", value: "qq" }, "一律回 QQ"))),
					elsewhere > 0 ? Row({ title: `${elsewhere} 个会话在别的工作区` }, Button({ disabled: busy, onClick: () => run("/sessions/migrate", {}, (r) => `已迁移 ${r.migrated} 个${r.failed?.length ? `，${r.failed.length} 个失败` : ""}`, "迁移失败") }, "迁过来")) : null,
					chats.length > 0 ? h("div", { className: "fs-list" }, chats.slice(0, 30).map((c) => Item({ key: c.sessionId, text: c.title || c.sessionId, meta: [
						c.paused ? Tag("暂停中", "warning", { key: "p" }) : null, h("span", { key: "c" }, c.channelId),
						Button({ key: "b", variant: "ghost", disabled: busy, onClick: () => pause(c) }, c.paused ? "恢复" : "暂停")] }))) : null));
		}

		/**
		 * B站设置页「整份保存」的请求体（#77）。
		 *
		 * 这一页有两种保存：开关只把新值发给服务端（`save({ browse: { frames: v } })`），
		 * 输入框失焦走整份保存（把 form 里的字段全发一遍）。开关不回写 form 的话，
		 * 之后任何一次失焦都会带着 form 里的旧值把它盖回去 ——
		 * 表现就是「开关打开以后点别处，自己又关掉了」。所以先把这次的覆盖值并进 form，
		 * 再按并进去的结果拼请求体，调用方拿 `next` 写回表单。
		 * @param {object} form 表单当前值
		 * @param {{top?: object, browse?: object, post?: object, comments?: object}} [p] 这一次的覆盖值
		 */
		function biliSaveBody(form, p = {}) {
			const next = p.browse ? { ...form, ...p.browse } : form;
			return {
				next,
				body: {
					masterUid: form.masterUid, allowList: split(form.allowList), links: split(form.links, /\n+/), ...(p.top ?? {}),
					browse: { perDay: Number(next.perDay), videosPerSession: Number(next.videosPerSession), favoritePerDay: Number(next.favoritePerDay), searchKeywords: split(next.searchKeywords), searchPerDay: Number(next.searchPerDay), frames: next.frames === true, framesPerDay: Number(next.framesPerDay), framesPerDayChat: Number(next.framesPerDayChat),
						maxLinks: Number(next.maxLinks), subtitleChars: Number(next.subtitleChars), comment: next.comment === true, commentPerDay: Number(next.commentPerDay),
						// 回评论的每日上限：界面读得到、保存时却没带上，改了永远不生效
						commentReplyPerDay: Number(next.commentReplyPerDay),
						descChars: Number(next.descChars), hotCommentChars: Number(next.hotCommentChars), ...(p.browse ?? {}) },
					post: { perDay: Number(form.postPerDay), ...(p.post ?? {}) },
					comments: { perHour: Number(form.commentsPerHour), replyChars: Number(form.commentsReplyChars), ...(p.comments ?? {}) }
				}
			};
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
			const [form, setForm, patch] = useForm(data, () => ({
				masterUid: b.masterUid ?? "", allowList: (b.allowList ?? []).join(", "), links: (b.links ?? []).join("\n"),
				perDay: br.perDay ?? 3, videosPerSession: br.videosPerSession ?? 3, favoritePerDay: br.favoritePerDay ?? 2, searchKeywords: (br.searchKeywords ?? []).join("，"), searchPerDay: br.searchPerDay ?? 2, frames: br.frames === true, framesPerDay: br.framesPerDay ?? 1, framesPerDayChat: br.framesPerDayChat ?? 10,
				maxLinks: br.maxLinks ?? 3, subtitleChars: br.subtitleChars ?? 1200, comment: br.comment === true, commentPerDay: br.commentPerDay ?? 1, descChars: br.descChars ?? 300, hotCommentChars: br.hotCommentChars ?? 80,
				postPerDay: b.post?.perDay ?? 1, commentsPerHour: b.comments?.perHour ?? 6, commentsReplyChars: b.comments?.replyChars ?? 40,
				// 回评论的每日上限：以前只读了 form.commentReplyPerDay 却没初始化，那个数字框一直空白
				commentReplyPerDay: b.commentReplyPerDay ?? 1
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
			const save = (p = {}) => {
				const { next, body } = biliSaveBody(form, p);
				if (next !== form) setForm(next);
				return act("/channels/bili-config", body, null, "保存失败");
			};
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
					Row({ title: "主人 UID", desc: "填了之后，可以在 QQ 私聊里让她去 B站 给你发一条私信" }, field("masterUid", { inputMode: "numeric" })),
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
					br.enabled !== false ? Row({ title: "刷到就分享", desc: "带链接和感受，发到你的 QQ 私聊；多少条受「主动开口」那边的额度管" }, sw("刷到就分享", br.share !== false, (v) => save({ browse: { share: v } }))) : null,
					br.enabled !== false ? Row({ title: "看完就收藏", desc: `收进默认收藏夹，建议 1–3 个/天；要能看图的模型（flash 可以、pro 不行）` },
						br.favorite ? Muted(`今天收藏了 ${br.favoritedToday ?? 0}`) : null,
						sw("想再看的就收藏", br.favorite === true, (v) => save({ browse: { favorite: v } })),
						br.favorite ? Num({ min: 0, max: 30, value: form.favoritePerDay, "aria-label": "一天最多收藏几个", onChange: (e) => patch({ favoritePerDay: e.target.value }), onBlur: () => save() }) : null,
						br.favorite ? Muted("个/天") : null) : null,
					br.enabled !== false ? Row({ title: "看一眼画面", desc: `抽开头 1 分钟拼 9 格一起看，一条十几秒；要用能看图的模型（flash 可以、pro 不行）` },
						br.frames ? Muted(`今天看了 ${br.framedToday ?? 0}`) : null,
						sw("看一眼画面", br.frames === true, (v) => save({ browse: { frames: v } })),
						br.frames ? Muted("自己刷的") : null,
						br.frames ? Num({ min: 0, max: 15, value: form.framesPerDay, "aria-label": "自己刷每天最多几条", onChange: (e) => patch({ framesPerDay: e.target.value }), onBlur: () => save() }) : null,
						br.frames ? Muted("条/天；") : null,
						br.frames ? Muted("你发链接的") : null,
						br.frames ? Num({ min: 0, max: 30, value: form.framesPerDayChat, "aria-label": "你发链接时每天最多几条", onChange: (e) => patch({ framesPerDayChat: e.target.value }), onBlur: () => save() }) : null,
						br.frames ? Muted(`条/天（今天 ${br.framedTodayChat ?? 0}）`) : null) : null,
					br.enabled !== false ? Row({ title: "回一条评论", desc: "在她看的视频评论区挑一条值得搭话的回一句（楼中楼）；不追着聊、不抬杠" },
						sw("回一条评论", br.commentReply === true, (v) => save({ browse: { commentReply: v } })),
						br.commentReply ? Num({ min: 0, max: 20, value: form.commentReplyPerDay, "aria-label": "一天最多回几条", onChange: (e) => patch({ commentReplyPerDay: e.target.value }), onBlur: () => save() }) : null,
						br.commentReply ? Muted("条/天") : null,
						br.commentReply ? Muted(`（今天回了 ${br.repliedToday ?? 0}）`) : null,
						br.commentReply && br.replyLast
							? h("a", {
									className: "fs-unit",
									style: { flexBasis: "100%", marginTop: "2px" },
									href: `https://www.bilibili.com/video/${br.replyLast.bvid}?comment_on=1`,
									target: "_blank",
									rel: "noreferrer",
									title: br.replyLast.title ?? ""
								}, `最近一次：回 @${br.replyLast.name || "某人"}「${String(br.replyLast.text ?? "").slice(0, 20)}」`)
							: null) : null,
					br.enabled !== false ? Row({ title: "也看弹幕", desc: "看视频时顺便看几条弹幕（只看不发）" }, sw("也看弹幕", br.danmaku !== false, (v) => save({ browse: { danmaku: v } }))) : null,
					br.enabled !== false ? Row({ title: "留一句", desc: `真看完、有感觉的视频，在评论区留一句（不超过 25 字，只写不追回复），一天最多 ${br.commentPerDay ?? 1} 条` },
						br.comment ? Muted(`今天留了 ${br.commentedToday ?? 0}`) : null,
						sw("留一句", br.comment === true, (v) => save({ browse: { comment: v } })),
						br.comment ? Num({ min: 0, max: 20, value: form.commentPerDay, "aria-label": "一天最多几条", onChange: (e) => patch({ commentPerDay: e.target.value }), onBlur: () => save() }) : null,
						br.comment ? Muted("条/天") : null) : null,
					br.enabled !== false ? Row({ title: "你发视频给她时读多细", stack: true, desc: "你在聊天里发 B站 链接，她先看一遍再回；四个数字都可以改，字数是节选上限，不写 0 就行" },
						Num({ min: 1, max: 5, value: form.maxLinks, "aria-label": "最多读几条", onChange: (e) => patch({ maxLinks: e.target.value }), onBlur: () => save() }), Muted("条"),
						Num({ min: 0, max: 3000, step: 100, value: form.subtitleChars, "aria-label": "字幕字数", onChange: (e) => patch({ subtitleChars: e.target.value }), onBlur: () => save() }), Muted("字字幕，"),
						Num({ min: 0, max: 1000, step: 50, value: form.descChars, "aria-label": "简介字数", onChange: (e) => patch({ descChars: e.target.value }), onBlur: () => save() }), Muted("字简介，"),
						Num({ min: 0, max: 500, step: 20, value: form.hotCommentChars, "aria-label": "热评字数", onChange: (e) => patch({ hotCommentChars: e.target.value }), onBlur: () => save() }), Muted("字热评")) : null,
					br.enabled !== false ? Row({ title: "按关键词搜一下", desc: "让她偶尔按自己最近感兴趣的东西搜一下，当作刷视频的又一个来源；只读" },
						br.search ? Muted(`今天搜了 ${br.searchedToday ?? 0} / ${br.searchPerDay ?? 2} 次`) : null,
						sw("按关键词搜一下", br.search === true, (v) => save({ browse: { search: v } }))) : null,
					br.enabled !== false && br.search ? Row({ title: "搜什么词", desc: "留空 = 她自己按最近看过的提一个；填了就按你的搜（逗号分隔，比如：插件，大肥鱼）" },
						Input({ value: form.searchKeywords, className: "wide", placeholder: "插件，大肥鱼", "aria-label": "搜索关键词", onChange: (e) => patch({ searchKeywords: e.target.value }), onBlur: () => save() })) : null,
					br.enabled !== false && br.search ? Row({ title: "一天最多搜" },
						Num({ min: 0, max: 12, value: form.searchPerDay, "aria-label": "一天最多搜几次", onChange: (e) => patch({ searchPerDay: e.target.value }), onBlur: () => save() }), Muted("次")) : null),
				Group({ title: "动态和评论", aside: post.enabled ? Tag(`今天发了 ${so.post?.todayCount ?? 0} / ${post.perDay ?? 1}`, "outline") : null },
					Row({ title: "自己发动态", desc: "醒着的时候按心情和最近刷到的随手发，纯文字" },
						post.enabled ? Button({ variant: "ghost", disabled: busy || so.post?.running === true || b.enabled !== true, onClick: () => act("/bili/post-now", {}, (r) => `发了：${r.text}`, "没发成") }, so.post?.running ? "正在写…" : "现在发一条") : null,
						sw("自己发动态", post.enabled === true, (v) => save({ post: { enabled: v } }))),
					post.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 5, value: form.postPerDay, "aria-label": "每天最多几条", onChange: (e) => patch({ postPerDay: e.target.value }), onBlur: () => save() }), Muted("条")) : null,
					Row({ title: "回评论", desc: "别人在她的动态 / 视频下评论或回复她时回一句；广告、引战不回" },
						cm.enabled ? Button({ variant: "ghost", disabled: busy || b.enabled !== true, onClick: () => act("/bili/comments-now", {}, (r) => (r.replied || r.skipped ? `回了 ${r.replied} 条，跳过 ${r.skipped} 条` : "没有新评论"), "没看成") }, "现在看一眼") : null,
						sw("回评论", cm.enabled === true, (v) => save({ comments: { enabled: v } }))),
				cm.enabled ? Row({ title: "别人评论区 @ 她也回", desc: "在别人的视频 / 动态评论区 @ 她时回一句；回复大家都看得到" }, sw("别人评论区 @ 她也回", cm.atMe === true, (v) => save({ comments: { atMe: v } }))) : null,
				cm.enabled && cm.atMe ? Row({ title: "@ 她时先读一下视频", desc: "把简介和字幕节选塞进提示词再回；多两次 B站 接口调用" }, sw("@ 她时先读一下视频", cm.atReadVideo === true, (v) => save({ comments: { atReadVideo: v } }))) : null,
					cm.enabled ? Row({ title: "每小时最多" }, Num({ min: 0, max: 30, value: form.commentsPerHour, "aria-label": "每小时最多回几条", onChange: (e) => patch({ commentsPerHour: e.target.value }), onBlur: () => save() }), Muted("条")) : null,
					cm.enabled ? Row({ title: "回一句大概多长", desc: "给模型的上限提示，不是硬截断；评论区默认 40 字比较像真人" },
						Num({ min: 10, max: 300, step: 10, value: form.commentsReplyChars, "aria-label": "回评论字数", onChange: (e) => patch({ commentsReplyChars: e.target.value }), onBlur: () => save() }), Muted("字")) : null,
					so.lastError ? Row({ title: "上次出错" }, State("error", so.lastError)) : null,
					socialLog.length === 0 ? null : h("div", { className: "fs-list" }, socialLog.map((x) => Item({ key: x.key, lead: x.tag, text: x.text, title: x.text, meta: [h("span", { key: "t" }, relTime(x.at, Date.now()))] })))),
				recent.length === 0 ? null : Group({ title: "最近看过" },
					h("div", { className: "fs-list" }, recent.map((v) => Item({
						key: v.bvid, lead: Tag(v.favorited ? "藏" : v.liked ? "赞" : v.skipped ? "划走" : v.source === "following" ? "关注" : v.source === "search" ? "搜索" : "推荐", v.liked ? "danger" : undefined),
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
		const TAB_KEYS = { memory: "忆", character: "角", daily: "常", channels: "台", models: "模", system: "统", guide: "引", retrieval: "索", persona: "人", life: "自", inspector: "忆", activity: "动", behavior: "习", qq: "Q", bili: "B", douyin: "抖", version: "版" };
		const TABS = [
			["memory", "记忆", [["retrieval", "检索设置"], ["people", "人物与关系"], ["memories", "记忆内容"], ["recall-test", "检索测试"], ["weekly", "周记"], ["archives", "记忆存档"], ["backups", "导入与备份"]]],
			["character", "角色", [["persona", "人格卡"], ["templates", "人格模板"], ["growth", "成长"], ["worldinfo", "世界书"], ["habits", "说话习惯"], ["groups", "群设定"], ["chat-models", "聊天模型"]]],
			["daily", "日常", [["life", "主动开口"], ["activity", "最近动态"], ["diary", "日记"], ["stickers", "表情包"], ["slang", "学到的说法"]]],
			["channels", "平台", [["qq", "QQ"], ["bili", "B站"], ["douyin", "抖音"]]],
			["models", "模型", [["models", "功能模型"], ["usage", "用量与价格"], ["web", "联网搜索"], ["voice", "语音"]]],
			["system", "系统", [["interface", "界面"], ["version", "版本更新"]]]
		];
		const NAV_GROUPS = TABS.map(([id, label]) => ({ id, label }));
		const SUBTABS = Object.fromEntries(TABS.map(([id, , subs]) => [id, subs]));
		const DEFAULT_TABS = Object.fromEntries(TABS.map(([id, , subs]) => [id, subs[0][0]]));

		// 服务端仍提供原始步骤与状态；短标题只调整展示，未知步骤保留服务端原文。
		const ONBOARDING_LABELS = { persona: "选择人格", model: "配置模型", qq: "连接 QQ", master: "设置主人 QQ", retrieval: "配置向量检索", import: "导入聊天记录", voice: "配置语音" };
		// 独立引导页：关闭自动显示后仍可从「开始」重新打开。
		function Onboarding({ onGo, onDismiss, onHide, notify }) {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const load = react.useCallback(async () => { const r = await api("GET", "/onboarding/state"); if (r?.ok) { setData(r); setError(null); } else setError(r?.error ?? "引导状态暂不可用"); }, []);
			react.useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
			if (!data) return error ? h("div", { className: "fs-notice", role: "alert" }, h("b", null, "引导加载失败"), h("span", null, error), Button({ variant: "secondary", onClick: load }, "重试")) : h("div", { className: "fs-empty" }, Dot("ongoing"));
			async function dismiss() {
				const r = await api("POST", "/onboarding/dismiss", { dismissed: true });
				if (r?.ok) { setData({ ...data, dismissed: true }); onDismiss(); } else notify(r?.error ?? "操作失败");
			}
			const steps = data.steps ?? [];
			const completed = steps.filter((x) => x.done).length;
			const left = steps.filter((x) => !x.done && !x.optional).length;
			return Group({ className: "fs-onboarding", title: `${left === 0 ? "基础就绪" : "开始"} · ${completed}/${steps.length}`, aside: h("span", { className: "fs-group-aside" }, Button({ variant: "ghost", onClick: onHide }, "隐藏开始"), data.dismissed ? null : IconButton("close", "以后不再自动显示", dismiss)) },
				h("div", { className: "fs-list" }, steps.map((x) => {
					const label = ONBOARDING_LABELS[x.id] ?? x.title;
					return h("div", { className: "fs-item", key: x.id },
						h("span", { className: "fs-onboarding-dot", role: "img", "aria-label": x.done ? "已完成" : x.optional ? "可选，未完成" : "未完成" }, Dot(x.done ? "done" : x.optional ? "idle" : "warning")),
						h("span", { className: cx("fs-item-main", x.done && "fs-muted") }, label),
						h("span", { className: "fs-item-meta" },
							x.optional && !x.done ? Tag("可选", "outline") : null,
							x.done ? null : x.tab ? Button({ variant: "ghost", "aria-label": `设置${label}`, onClick: () => onGo(x.tab) }, "去设置") : null));
				})));
		}
		// 版本与更新：显示当前版本，自动 / 手动去 npm（不通再 GitHub）看有没有新版；只提示，不替你装
		function UpdateBar({ notify, onUpdateState }) {
			const [data, setData] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const load = react.useCallback(async () => { const r = await api("GET", "/update/state"); if (r?.ok) setData(r); }, []);
			react.useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
			react.useEffect(() => { if (data && onUpdateState) onUpdateState(data.hasUpdate === true); }, [data, onUpdateState]);
			if (!data) return null;
			async function check() {
				setBusy(true);
				const r = await api("POST", "/update/check");
				setBusy(false);
				if (r?.ok) { setData(r); notify(r.hasUpdate ? `有新版本 v${r.latest}` : r.latest ? "已是最新" : `没查成：${r.error || "网络不通"}`); }
				else notify(r?.error ?? "没查成");
			}
			async function toggle(v) {
				const r = await api("POST", "/update/config", { autoCheck: v });
				if (r?.ok) { setData(r); notify(v ? "已开自动检查" : "已关自动检查"); } else notify(r?.error ?? "没存上");
			}
			async function copy() {
				try { await navigator.clipboard.writeText(data.command); notify("已复制更新命令"); } catch { notify("复制失败，手动选中复制"); }
			}
			async function apply() {
				setBusy(true);
				const r = await api("POST", "/update/apply");
				setBusy(false);
				if (r?.ok) { setData(r); notify(`已更新到 v${r.to}，重启 DSH 生效`); }
				else notify(r?.error ?? "没更新成");
			}
			const when = data.checkedAt ? new Date(data.checkedAt).toLocaleString("zh-CN", { hour12: false }) : "";
			const status = data.hasUpdate ? Tag(`有新版本 v${data.latest}`, "warning")
				: data.latest ? Tag("已是最新", "success")
				: data.error ? Tag("没查成", "outline", { title: data.error }) : Tag("还没检查", "outline");
			// Group / Row 是普通函数（第二个参数起是子元素），不能当组件（createElement）用：
			// 宿主的 React 会把 legacy context（{}）当第二个参数传进来，变成一个对象子元素，整个面板崩成空白
			return Group({ title: "版本", aside: h("span", { className: "fs-unit num" }, `v${data.current}`) },
				Row({ title: status, meta: when ? `${when}${data.source ? ` · ${data.source}` : ""}` : undefined, desc: "每 12 小时自动看一次 npm / GitHub" },
					Button({ onClick: check, disabled: busy || data.checking }, busy || data.checking ? "检查中…" : "检查更新"),
					data.hasUpdate ? Button({ onClick: () => window.open(data.notesUrl, "_blank", "noopener") }, "更新说明") : null,
					data.hasUpdate && data.canApply ? Button({ variant: "primary", onClick: apply, disabled: busy }, busy ? "更新中…" : `更新到 v${data.latest}`) : null,
					data.hasUpdate && data.command ? Button({ variant: data.canApply ? "ghost" : "primary", onClick: copy, title: data.command }, "复制更新命令") : null),
				data.hasUpdate ? (data.notes ? h("pre", { className: "fs-report" }, data.notes)
					: h("p", { className: "fs-row-meta" },
						h("a", { href: data.notesUrl, target: "_blank", rel: "noopener noreferrer" }, "GitHub Releases"))) : null,
				Row({ title: "自动检查更新", desc: "只提示，不会自动安装；点「更新到」才装，装完重启 DSH 生效" },
					h(Switch, { checked: data.autoCheck !== false, onChange: toggle, label: "自动检查更新" })));
		}

		// 某一块渲染出错只换成一行提示，别让整个设置页变空白
		class Boundary extends react.Component {
			constructor(props) { super(props); this.state = { error: null }; }
			static getDerivedStateFromError(error) { return { error }; }
			componentDidCatch(error) { try { console.error(`[fish-soul] ${this.props.name}渲染出错`, error); } catch { /* 无 */ } }
			render() {
				if (this.state.error === null) return this.props.children ?? null;
				const msg = String(this.state.error?.message ?? this.state.error).slice(0, 200);
				return h("p", { className: "fs-row-desc", role: "alert", style: { margin: "8px 0" } }, `${this.props.name}显示出错了（${msg}），其它部分不受影响；可以把这句话发给开发者`);
			}
		}

		function FishSoulSection({ standalone = false } = {}) {
			const css = useCss();
			// 界面偏好只保存在当前宿主浏览器，不修改服务端引导进度。
			const guideVisibilityKey = "fish-soul:guide-visible";
			const readGuideVisible = () => { try { return window.localStorage.getItem(guideVisibilityKey) !== "false"; } catch { return true; } };
			const [guideVisible, setGuideVisible] = react.useState(readGuideVisible);
			const [tab, setTab] = react.useState("memory");
			const [subtab, setSubtab] = react.useState("retrieval");
			const hasInteracted = react.useRef(false);
			const remembered = react.useRef({});
			const goTab = (next, child) => {
				hasInteracted.current = true;
				if (next === "guide") { setTab(next); return; }
				if (SUBTABS[next]) setSubtab(child ?? remembered.current[next] ?? DEFAULT_TABS[next]);
				setTab(next);
			};
			const goSubtab = (next) => { hasInteracted.current = true; remembered.current[tab] = next; setSubtab(next); };
			const goSetting = (next) => {
				const group = TABS.find(([, , subs]) => subs.some(([id]) => id === next));
				if (group) goTab(group[0], next);
			};
			const [retrieval, setRetrieval] = react.useState(null);
			const [life, setLife] = react.useState(null);
			const [channels, setChannels] = react.useState(null);
			const [toast, setToast] = react.useState(null);
			const [updateAvailable, setUpdateAvailable] = react.useState(false);
			const [storageWarning, setStorageWarning] = react.useState(null);
			const notify = react.useCallback((text) => setToast({ key: Date.now(), text }), []);
			const setGuideVisibility = (visible) => {
				try { window.localStorage.setItem(guideVisibilityKey, String(visible)); }
				catch { notify("无法保存界面设置"); return; }
				setGuideVisible(visible);
				if (!visible) setTab((current) => current === "guide" ? "memory" : current);
				window.dispatchEvent(new Event("fish-soul:guide-visibility"));
			};
			react.useEffect(() => {
				const sync = () => { const visible = readGuideVisible(); setGuideVisible(visible); if (!visible) setTab((current) => current === "guide" ? "retrieval" : current); };
				window.addEventListener("fish-soul:guide-visibility", sync); window.addEventListener("storage", sync);
				return () => { window.removeEventListener("fish-soul:guide-visibility", sync); window.removeEventListener("storage", sync); };
			}, []);

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
			// 仅在初次加载且用户尚未操作时自动进入引导，慢请求不能打断用户。
			react.useEffect(() => {
				let active = true;
				api("GET", "/onboarding/state").then((r) => {
					if (active && !hasInteracted.current && readGuideVisible() && r?.ok && r.dismissed === false && Array.isArray(r.steps) && r.steps.some((step) => !step.done)) setTab("guide");
				});
				return () => { active = false; };
			}, []);
			// 检索页 2s 刷新（重建进度）；QQ / B站 / 抖音 3s 刷新
			react.useEffect(() => {
				const fn = subtab === "retrieval" ? loadRetrieval : subtab === "qq" || subtab === "bili" || subtab === "douyin" ? loadChannels : null;
				if (fn === null) return undefined;
				const timer = setInterval(fn, subtab === "retrieval" ? 2000 : 3000);
				return () => clearInterval(timer);
			}, [subtab]);
			// 虚拟时钟走秒（纯展示）
			react.useEffect(() => {
				if (subtab !== "life") return undefined;
				const timer = setInterval(() => setLife((prev) => prev?.clock?.virtualNowMs
					? { ...prev, clock: { ...prev.clock, virtualNowMs: prev.clock.virtualNowMs + 1000 * (prev.clock.timeScale ?? 1) } } : prev), 1000);
				return () => clearInterval(timer);
			}, [tab]);

			react.useEffect(() => {
				let active = true;
				const loadStorage = async () => { const r = await api("GET", "/storage/state"); if (active && r?.ok) setStorageWarning(r.warning ? "容量告警" : r.budget?.consecutive >= 3 ? "记忆预算接近上限" : null); };
				loadStorage(); const timer = setInterval(loadStorage, 60000);
				return () => { active = false; clearInterval(timer); };
			}, []);

			// 导航红点使用同一只读状态接口；版本页自身检查后的结果即时同步。
			react.useEffect(() => {
				if (subtab === "version") return undefined;
				let active = true;
				const loadUpdate = async () => { const r = await api("GET", "/update/state"); if (active && r?.ok) setUpdateAvailable(r.hasUpdate === true); };
				loadUpdate();
				const timer = setInterval(loadUpdate, 60000);
				return () => { active = false; clearInterval(timer); };
			}, [tab]);

			if (css === null) return null;
			const pane = tab === "guide" ? h(Onboarding, { onGo: goSetting, onDismiss: () => goTab("memory"), onHide: () => setGuideVisibility(false), notify })
				: subtab === "interface" ? Row({ title: "显示开始" }, h(Switch, { label: "显示开始", checked: guideVisible, onChange: setGuideVisibility }))
				: subtab === "version" ? h(Boundary, { name: "版本" }, h(UpdateBar, { notify, onUpdateState: setUpdateAvailable }))
				: subtab === "retrieval" ? h(RetrievalPane, { data: retrieval, refresh: loadRetrieval, notify })
				: subtab === "life" ? h(LifePane, { data: life, refresh: loadLife, notify })
				: ["people", "memories", "recall-test", "weekly", "archives", "backups"].includes(subtab) ? h(ChunkTab, { file: "client.soul.js", pick: (m) => m.InspectorPane, failText: "记忆管理加载失败", section: subtab, notify })
				: ["activity", "stickers", "slang"].includes(subtab) ? h(ChunkTab, { file: "client.soul.js", pick: (m) => m.ActivityPane, failText: "动态加载失败", section: subtab, notify })
				: ["habits", "groups", "chat-models", "diary"].includes(subtab) ? h(ChunkTab, { file: "client.behavior.js", pick: (m) => m.BehaviorPane, failText: "习惯页加载失败", section: subtab === "chat-models" ? "models" : subtab, notify })
				: ["models", "usage", "web", "voice"].includes(subtab) ? h(ChunkTab, { file: "client.models.js", pick: (m) => m.ModelsPane, failText: "模型页加载失败", section: subtab, notify })
				: ["persona", "templates", "growth", "worldinfo"].includes(subtab) ? h(ChunkTab, { file: "client.persona.js", pick: (m) => m.PersonaPane, failText: "人格页加载失败", section: subtab === "persona" ? "current" : subtab, notify })
				: subtab === "qq" ? h(ChannelPane, { data: channels, refresh: loadChannels, notify })
				: subtab === "bili" ? h(BiliPane, { data: channels, refresh: loadChannels, notify })
				: h(ChunkTab, { file: "client.douyin.js", pick: (m) => m.DouyinPane, failText: "抖音页加载失败", data: channels, refresh: loadChannels, notify });

			const tabs = tab === "guide" ? [] : SUBTABS[tab] ?? [];
			const label = tab === "guide" ? "使用引导" : tabs.find(([v]) => v === subtab)?.[1] ?? "";
			return h("div", { className: "fs-host" }, h("div", { className: cx("fs", standalone ? "fs-standalone" : "fs-settings"), onPointerDown: () => { hasInteracted.current = true; }, onKeyDown: () => { hasInteracted.current = true; } },
				css === "" ? null : h("style", { "data-plugin-css": `${PLUGIN_ID}/panel.css` }, css),
				h("div", { className: "fs-side" }, h("div", { className: "fs-side-inner" },
					h(GroupedTabs, { value: tab, onChange: goTab, hasUpdate: updateAvailable }),
					guideVisible && tab !== "guide" ? h("div", { className: "fs-subnav-row" }, Button({ variant: "ghost", onClick: () => goTab("guide") }, "使用引导")) : null,
					tabs.length > 0 ? h("div", { className: "fs-subnav-row" }, h(Tabs, { items: tabs, value: subtab, onChange: goSubtab, horizontal: true })) : null)),
				h("main", { className: "fs-main" },
					h("header", { className: "fs-main-head" }, h("h2", { className: "fs-main-title" }, label), storageWarning ? h("span", { role: "status", style: { marginLeft: "auto" } }, Button({ variant: "ghost", onClick: () => goSetting("archives") }, storageWarning)) : null),
					h("div", { className: "fs-pane", role: "tabpanel", id: "fs-tabpanel", "aria-labelledby": `fs-tab-${subtab}`, key: `${tab}:${subtab}` }, h(Boundary, { name: "这一页" }, pane))),
				toast === null ? null : h("div", { className: "fs-toast", role: "status", key: toast.key }, toast.text)));
		}

		// 同一组件可在设置弹窗或宿主主面板内渲染；只改变承载容器。
		function FishSoulPage() {
			return h("div", { className: "fs-page-shell" },
				h("div", { className: "fs-page-scroll" }, h(FishSoulSection, { standalone: true })));
		}

		function FishSoulPanelIcon({ size = 16 } = {}) {
			return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
				h("path", { d: "M3 12c3-5 9-7 14-3l4-3v12l-4-3c-5 4-11 2-14-3Z M14 11h.01 M7 12h.01" }));
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "fish-soul",
				order: 60,
				label: () => "鱼 · 记忆与自走"
			}, FishSoulSection)), `${PLUGIN_ID}: panel`);
			// main 先于入口注册；主面板不存在的旧宿主只保留设置页。
			ctx.effect(() => ctx.slots.inject("main", function* () {
				yield ctx.slots.register({ name: "main", key: PLUGIN_ID }, FishSoulPage);
				yield ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist", id: PLUGIN_ID, order: 2, label: () => "鱼"
				}, FishSoulPanelIcon));
				// 卸载当前页前回到会话；layout 为可选服务，不阻塞旧宿主。
				yield () => {
					const layout = typeof ctx.get === "function" ? ctx.get("layout") : null;
					if (layout?.panelInfo?.getSnapshot()?.activePanelId === PLUGIN_ID) layout.selectPanel(null);
				};
			}), `${PLUGIN_ID}: main panel`);
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数抽出来才测得动（test/bili-switch-persist.mjs）：不碰 DOM，只拼请求体。
		exports.__test = { biliSaveBody };
		return module.exports;
	}
});
