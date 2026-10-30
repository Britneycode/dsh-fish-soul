/**
 * dsh-fish-soul — 桌面端设置面板（client.js）
 *
 * 真源：
 *  - 业务逻辑：《dsh-fish-soul 设计方案》v1.1（DESIGN-fish-soul.md）
 *  - 接口契约：《dsh-fish-soul 前端 UI 设计文档》§4（8 条 HTTP 路由）
 *  - DOM/交互：dsh_fish_soul_deepseek_harness.html 视觉原型（1:1）
 *
 * 宿主契约（参照 dsh-archive-vault-desktop/lib/client.js）：
 *  - window.__ModuleLoader__.load({ id, factory })，exports.apply/inject
 *  - inject: ["slots"]，ctx.slots.inject("settings.section", ...) 挂载
 *  - 通信 100% 走 /api/plugins/fish-soul/* 八条路由，前端不直连数据库
 *  - 样式只走 --dsw-* 语义令牌 + 本文件私有 fs-* 变量，跟随宿主亮/暗主题
 *
 * 设计信条：Avoid unnecessary secondary labels. Let the layout do the explaining.
 * 负面清单：无模型市场、无多角色切换、无人格卡编辑器、无演示面板、无模拟按钮。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		const inject = ["slots"];
		const PLUGIN_ID = "dsh-fish-soul";
		const API = "/api/plugins/fish-soul";
		const h = react.createElement;

		// -------------------------------------------------------------------
		// 面板样式：fs-* 私有变量映射宿主 --dsw-* 令牌，亮/暗主题跟随宿主
		// -------------------------------------------------------------------
		const css = `
.fs{display:flex;flex-direction:column;width:100%;max-width:680px;gap:18px;font-size:13px;line-height:1.5;
  color:var(--dsw-alias-label-primary,#eef0f4);
  --fs-text-2:var(--dsw-alias-label-secondary,#8b93a4);
  --fs-text-3:var(--dsw-alias-label-tertiary,#565e6d);
  --fs-surface:var(--dsw-alias-bg-layer-2,#14171f);
  --fs-control:var(--dsw-alias-bg-layer-1,#0b0d12);
  --fs-elevated:var(--dsw-alias-bg-layer-3,#1c202b);
  --fs-hover:var(--dsw-alias-bg-hover,rgba(255,255,255,.04));
  --fs-active:var(--dsw-alias-bg-active,rgba(255,255,255,.07));
  --fs-hairline:var(--dsw-alias-border-l1,rgba(255,255,255,.055));
  --fs-subtle:var(--dsw-alias-border-l2,rgba(255,255,255,.095));
  --fs-accent:var(--dsw-alias-border-focus,#4d6bfe);
  --fs-accent-hover:var(--dsw-alias-accent-hover,#607bff);
  --fs-accent-soft:color-mix(in srgb,var(--fs-accent) 13%,transparent);
  --fs-accent-border:color-mix(in srgb,var(--fs-accent) 32%,transparent);
  --fs-ok:var(--dsw-alias-label-success,#34d399);
  --fs-warn:var(--dsw-alias-label-warning,#fbbf24);
  --fs-info:var(--dsw-alias-label-info,#60a5fa);
  --fs-err:var(--dsw-alias-label-error,#f87171);
  --fs-mono:"JetBrains Mono","SFMono-Regular","Cascadia Code",Consolas,monospace;
  --fs-seg-shadow:0 1px 2px rgba(0,0,0,.4)}
.fs *{box-sizing:border-box;margin:0;padding:0}
.fs .mono{font-family:var(--fs-mono);font-variant-numeric:tabular-nums}
/* 顶栏 */
.fs-top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;
  padding-bottom:14px;border-bottom:1px solid var(--fs-hairline)}
.fs-brand{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600}
.fs-brand-icon{width:24px;height:24px;border-radius:6px;background:var(--fs-accent-soft);
  border:1px solid var(--fs-accent-border);color:var(--fs-accent);display:inline-flex;align-items:center;justify-content:center}
/* 胶囊分段器 */
.fs-seg{display:inline-flex;background:var(--fs-control);border:1px solid var(--fs-hairline);
  border-radius:7px;padding:2px;gap:2px}
.fs-seg-btn{background:transparent;border:none;cursor:pointer;padding:4px 11px;border-radius:5px;
  font-size:12px;font-weight:500;color:var(--fs-text-2);transition:all .14s ease;user-select:none;white-space:nowrap}
.fs-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.fs-seg-btn.active{background:var(--fs-elevated);color:var(--dsw-alias-label-primary);
  font-weight:600;box-shadow:var(--fs-seg-shadow)}
/* 表面卡片与对齐行 */
.fs-surface{background:var(--fs-surface);border:1px solid var(--fs-hairline);border-radius:9px;
  overflow:hidden;transition:opacity .18s ease}
.fs-surface.is-disabled{opacity:.38;pointer-events:none}
.fs-row{padding:10px 16px;display:grid;grid-template-columns:88px 1fr;align-items:center;gap:12px;
  border-bottom:1px solid var(--fs-hairline)}
.fs-row:last-child{border-bottom:none}
.fs-row-between{padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;
  border-bottom:1px solid var(--fs-hairline)}
.fs-row-between:last-child{border-bottom:none}
.fs-label{font-size:12.5px;color:var(--fs-text-2);font-weight:500;user-select:none}
.fs-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fs-inline .sub{font-size:12px;color:var(--fs-text-2)}
/* 输入框 */
.fs-input{background:var(--fs-control);color:var(--dsw-alias-label-primary);border:1px solid var(--fs-subtle);
  border-radius:6px;padding:5px 10px;font-size:12.5px;outline:none;width:100%;flex:1;min-width:0;
  transition:border-color .14s ease}
.fs-input:focus{border-color:var(--fs-accent)}
.fs-input[readonly]{width:82px;flex:0 0 auto;text-align:center;color:var(--fs-text-2);
  border-color:var(--fs-hairline);cursor:default}
.fs-input.num{width:68px;flex:0 0 auto;text-align:right}
.fs-pwd{position:relative;display:flex;align-items:center;flex:1;min-width:0}
.fs-pwd .fs-input{padding-right:30px}
.fs-icon-btn{position:absolute;right:6px;background:transparent;border:none;color:var(--fs-text-3);
  cursor:pointer;padding:3px;display:inline-flex;align-items:center}
.fs-icon-btn:hover{color:var(--dsw-alias-label-primary)}
/* Switch */
.fs-switch{display:inline-flex;align-items:center;cursor:pointer}
.fs-switch input{appearance:none;-webkit-appearance:none;width:32px;height:18px;background:var(--fs-control);
  border:1px solid var(--fs-subtle);border-radius:99px;position:relative;cursor:pointer;transition:all .16s ease}
.fs-switch input::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;
  border-radius:50%;background:var(--fs-text-3);transition:transform .16s ease,background-color .16s ease}
.fs-switch input:checked{background:var(--fs-accent);border-color:var(--fs-accent)}
.fs-switch input:checked::after{transform:translateX(14px);background:#fff}
/* 按钮 */
.fs-btn{background:var(--fs-elevated);color:var(--dsw-alias-label-primary);border:1px solid var(--fs-subtle);
  border-radius:6px;padding:5px 11px;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;
  align-items:center;justify-content:center;gap:5px;white-space:nowrap;transition:all .12s ease}
.fs-btn:hover:not(:disabled){background:var(--fs-active)}
.fs-btn:disabled{opacity:.45;cursor:not-allowed}
.fs-btn-primary{background:var(--fs-accent);color:#fff;border-color:var(--fs-accent)}
.fs-btn-primary:hover:not(:disabled){background:var(--fs-accent-hover);border-color:var(--fs-accent-hover)}
.fs-btn-warn{color:var(--fs-warn);border-color:color-mix(in srgb,var(--fs-warn) 35%,transparent);
  background:color-mix(in srgb,var(--fs-warn) 8%,transparent)}
.fs-btn-del{background:transparent;color:var(--fs-text-3);border:none;padding:2px 6px;font-size:11.5px;
  border-radius:4px;cursor:pointer}
.fs-btn-del:hover{color:var(--fs-err);background:color-mix(in srgb,var(--fs-err) 10%,transparent)}
/* 状态行：单颗圆点 + 极简短句 */
.fs-status{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:500}
.fs-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.fs-status-ready{color:var(--fs-ok)}.fs-status-ready .fs-dot{background:var(--fs-ok);box-shadow:0 0 8px var(--fs-ok)}
.fs-status-stale{color:var(--fs-warn)}.fs-status-stale .fs-dot{background:var(--fs-warn)}
.fs-status-building{color:var(--fs-info)}.fs-status-building .fs-dot{background:var(--fs-info)}
.fs-status-error{color:var(--fs-err)}.fs-status-error .fs-dot{background:var(--fs-err)}
/* 进度条 */
.fs-progress{display:flex;align-items:center;gap:12px;width:100%}
.fs-track{flex:1;height:5px;background:var(--fs-control);border-radius:99px;overflow:hidden}
.fs-fill{height:100%;background:var(--fs-accent);border-radius:99px;transition:width .25s ease,background-color .2s ease}
.fs-fill.stale{background:var(--fs-warn)}
.fs-fill.building{background:linear-gradient(90deg,var(--fs-accent) 0%,#60a5fa 50%,var(--fs-accent) 100%);
  background-size:200% 100%;animation:fs-shimmer 1.4s infinite linear}
@keyframes fs-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* 她此刻状态 */
.fs-persona{padding:14px 16px;display:flex;align-items:center;justify-content:space-between;
  flex-wrap:wrap;gap:12px;border-bottom:1px solid var(--fs-hairline)}
.fs-persona-left{display:flex;align-items:center;gap:10px}
.fs-activity{font-size:14px;font-weight:600}
.fs-pill{font-size:11px;padding:1.5px 7px;border-radius:99px;background:var(--fs-control);
  border:1px solid var(--fs-hairline);color:var(--fs-text-2)}
.fs-pill.accel{color:var(--fs-warn);border-color:color-mix(in srgb,var(--fs-warn) 30%,transparent);
  background:color-mix(in srgb,var(--fs-warn) 8%,transparent)}
.fs-schedule{display:grid;grid-template-columns:repeat(4,1fr)}
.fs-slot{padding:10px 14px;border-right:1px solid var(--fs-hairline);font-size:11.5px;
  color:var(--fs-text-3);display:flex;flex-direction:column;gap:2px;transition:background-color .15s ease}
.fs-slot:last-child{border-right:none}
.fs-slot.current{background:var(--fs-accent-soft);color:var(--dsw-alias-label-primary)}
.fs-slot.current .fs-slot-time{color:var(--fs-accent);font-weight:600}
/* 群标签 */
.fs-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.fs-chip{display:inline-flex;align-items:center;gap:5px;background:var(--fs-control);
  border:1px solid var(--fs-subtle);border-radius:5px;padding:2px 8px;font-size:11.5px;color:var(--fs-text-2)}
.fs-chip-x{background:transparent;border:none;color:var(--fs-text-3);cursor:pointer;font-size:12px}
.fs-chip-x:hover{color:var(--fs-err)}
/* 记忆检视 */
.fs-owner-bar{display:flex;align-items:center;flex-wrap:wrap;gap:5px}
.fs-owner{background:transparent;border:1px solid var(--fs-hairline);border-radius:99px;padding:3.5px 10px;
  font-size:11.5px;color:var(--fs-text-2);cursor:pointer;display:inline-flex;align-items:center;gap:5px;
  transition:all .12s ease}
.fs-owner:hover{color:var(--dsw-alias-label-primary);border-color:var(--fs-subtle)}
.fs-owner.active{background:var(--fs-accent-soft);border-color:var(--fs-accent-border);
  color:var(--dsw-alias-label-primary);font-weight:500}
.fs-mem-row{padding:10px 14px;border-bottom:1px solid var(--fs-hairline);display:flex;
  align-items:center;justify-content:space-between;gap:12px}
.fs-mem-row:last-child{border-bottom:none}
.fs-mem-left{display:flex;align-items:baseline;gap:9px;min-width:0;flex:1}
.fs-kind{font-size:10.5px;font-family:var(--fs-mono);font-weight:600;color:var(--fs-accent);flex-shrink:0;width:42px}
.fs-mem-text{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-mem-right{display:flex;align-items:center;gap:10px;flex-shrink:0;font-size:11px;color:var(--fs-text-3)}
/* Toast */
.fs-toast{position:fixed;top:18px;right:18px;background:var(--fs-elevated);color:var(--dsw-alias-label-primary);
  border:1px solid var(--fs-subtle);border-radius:8px;padding:6px 12px;font-size:12px;z-index:100;
  box-shadow:0 28px 70px rgba(0,0,0,.65);animation:fs-toast-in .15s ease}
@keyframes fs-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
@media (max-width:560px){.fs-schedule{grid-template-columns:repeat(2,1fr)}.fs-row{grid-template-columns:1fr;gap:6px}}
`;

		function ensureStyle() {
			if (typeof document === "undefined") return;
			const tagId = `${PLUGIN_ID}/panel.css`;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// -------------------------------------------------------------------
		// 通信层：八条契约路由，fail-open（面板任何请求失败都不抛出到宿主）
		// -------------------------------------------------------------------
		async function api(method, path, body) {
			try {
				const response = await fetch(API + path, {
					method,
					headers: { "content-type": "application/json" },
					...(body !== undefined ? { body: JSON.stringify(body) } : {})
				});
				return await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
			} catch (error) {
				return { ok: false, error: String(error instanceof Error ? error.message : error) };
			}
		}

		function fmtClock(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "--:--:--";
			const d = new Date(ms);
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		}

		function fmtDueAt(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "--";
			const d = new Date(ms);
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}

		function relTime(ms, nowMs) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "--";
			const diff = Math.max(0, nowMs - ms);
			const m = Math.floor(diff / 60000);
			if (m < 1) return "刚刚";
			if (m < 60) return `${m} 分钟前`;
			const hr = Math.floor(m / 60);
			if (hr < 24) return `${hr} 小时前`;
			return `${Math.floor(hr / 24)} 天前`;
		}

		function Segmented({ options, value, onChange, name }) {
			return h("div", { className: "fs-seg", role: "radiogroup" },
				options.map((opt) =>
					h("button", {
						type: "button", key: opt.value, role: "radio",
						"aria-checked": value === opt.value,
						className: `fs-seg-btn${value === opt.value ? " active" : ""}`,
						onClick: () => onChange(opt.value)
					}, opt.label)
				)
			);
		}

		// -------------------------------------------------------------------
		// Tab 1：记忆检索
		// -------------------------------------------------------------------
		function RetrievalPane({ data, refresh, notify }) {
			const cfg = data?.config ?? {};
			const vecMeta = data?.vecMeta ?? {};
			const cov = data?.coverage ?? {};

			const [form, setForm] = react.useState(null);
			const [showKey, setShowKey] = react.useState(false);
			const [probing, setProbing] = react.useState(false);

			react.useEffect(() => {
				if (data && form === null) {
					setForm({
						enabled: cfg.enabled !== false,
						baseURL: cfg.baseURL ?? "",
						apiKey: "",
						model: cfg.model ?? "",
						fusionMethod: cfg.fusionMethod ?? "rrf",
						topK: cfg.topK ?? 5,
						tokenBudget: cfg.tokenBudget ?? 1200
					});
				}
			}, [data, form]);

			if (!data || !form) return null;

			// 脏检查：表单值与已建索引快照（vecMeta.modelId / 配置 baseURL）不一致 → stale
			const snapModel = vecMeta.modelId ?? cfg.model ?? "";
			const snapURL = cfg.baseURL ?? "";
			const dirty = form.baseURL !== snapURL || form.model !== snapModel;
			const configured = Boolean((cfg.hasApiKey || form.apiKey !== "") && form.baseURL !== "" && form.model !== "");

			const vecDisabled = !form.enabled;
			const building = cov.isWorkerRunning === true || vecMeta.status === "building";
			let status; // disabled | error | stale | building | ready
			if (vecDisabled) status = "disabled";
			else if (!configured || vecMeta.status === "error") status = "error";
			else if (building) status = "building";
			else if (dirty || vecMeta.status === "stale") status = "stale";
			else status = "ready";

			const gen = vecMeta.generationId ?? 1;
			const dim = vecMeta.dim ?? null;
			const total = cov.totalActiveCount ?? 0;
			const done = cov.vectorizedCount ?? 0;
			const pct = total > 0 ? Math.min(100, (done / total) * 100).toFixed(1) : "0.0";

			const patch = (p) => setForm({ ...form, ...p });

			async function save(p = {}) {
				const next = { ...form, ...p };
				setForm(next);
				const res = await api("POST", "/retrieval/config", {
					enabled: next.enabled,
					baseURL: next.baseURL,
					...(next.apiKey ? { apiKey: next.apiKey } : {}),
					model: next.model,
					fusionMethod: next.fusionMethod,
					topK: next.topK,
					tokenBudget: next.tokenBudget
				});
				if (res?.ok) refresh();
				else notify(res?.error ?? "保存失败");
			}

			async function probe() {
				setProbing(true);
				const res = await api("POST", "/retrieval/probe", {
					baseURL: form.baseURL,
					...(form.apiKey ? { apiKey: form.apiKey } : {}),
					model: form.model,
					timeoutMs: 800
				});
				setProbing(false);
				notify(res?.ok ? `可用 · 延迟 ${res.latencyMs}ms` : (res?.message ?? "连接失败"));
				refresh();
			}

			async function rebuild(action) {
				const res = await api("POST", "/retrieval/rebuild", { action });
				if (res?.ok) refresh();
				else notify(res?.error ?? "重建控制失败");
			}

			// 状态行：单颗圆点 + 极简短句
			let statusCls = "fs-status fs-status-ready";
			let statusText = "未探测";
			if (status === "ready") {
				const lat = vecMeta.lastProbeLatencyMs;
				statusText = lat ? `可用 · 延迟 ${lat}ms` : "可用";
			} else if (status === "stale") {
				statusCls = "fs-status fs-status-stale";
				statusText = "模型已变更，需重建索引";
			} else if (status === "building") {
				statusCls = "fs-status fs-status-building";
				statusText = `重建中 (gen #${gen})`;
			} else if (status === "error") {
				statusCls = "fs-status fs-status-error";
				statusText = configured
					? "连接失败/超时 · 已自动降级为纯 BM25（对话不受影响）"
					: "未配置向量接口 · 纯 BM25";
			}

			const rebuildBtn = building
				? h("button", { className: "fs-btn fs-btn-primary", onClick: () => rebuild("pause") }, "暂停重建")
				: status === "stale"
					? h("button", { className: "fs-btn fs-btn-warn", onClick: () => rebuild("start") }, "重建索引")
					: h("button", {
						className: "fs-btn", disabled: status !== "ready",
						onClick: () => rebuild(done > 0 && done < total ? "resume" : "start")
					}, done > 0 && done < total ? "继续重建" : "重建索引");

			return [
				// 检索方式
				h("div", { className: "fs-surface", key: "mode" },
					h("div", { className: "fs-row" }, [
						h("span", { className: "fs-label", key: "l" }, "检索方式"),
						h(Segmented, {
							key: "s", name: "fs-mode",
							options: [
								{ value: "bm25", label: "仅关键词 BM25" },
								{ value: "hybrid", label: "混合（关键词 + 语义向量）" }
							],
							value: form.enabled ? "hybrid" : "bm25",
							onChange: (v) => save({ enabled: v === "hybrid" })
						})
					])
				),
				// 向量接口
				h("div", { className: `fs-surface${vecDisabled ? " is-disabled" : ""}`, key: "vec" }, [
					h("div", { className: "fs-row", key: "url" }, [
						h("label", { className: "fs-label" }, "BaseURL"),
						h("input", {
							className: "fs-input mono", value: form.baseURL,
							onChange: (e) => patch({ baseURL: e.target.value }),
							onBlur: () => save()
						})
					]),
					h("div", { className: "fs-row", key: "key" }, [
						h("label", { className: "fs-label" }, "Key"),
						h("div", { className: "fs-inline", style: { flexWrap: "nowrap" } }, [
							h("div", { className: "fs-pwd", key: "pwd" }, [
								h("input", {
									className: "fs-input mono",
									type: showKey ? "text" : "password",
									value: form.apiKey,
									placeholder: cfg.hasApiKey ? (cfg.apiKeyMasked ?? "已配置") : "sk-...",
									onChange: (e) => patch({ apiKey: e.target.value })
								}),
								h("button", {
									type: "button", className: "fs-icon-btn", title: "显隐密钥",
									onClick: () => setShowKey(!showKey)
								}, h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 }, [
									h("path", { key: "p", d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }),
									h("circle", { key: "c", cx: 12, cy: 12, r: 3 })
								]))
							]),
							h("button", {
								key: "probe", className: "fs-btn fs-btn-primary",
								disabled: probing, onClick: probe
							}, probing ? "测试中..." : "测试连接")
						])
					]),
					h("div", { className: "fs-row", key: "model" }, [
						h("label", { className: "fs-label" }, "模型"),
						h("div", { className: "fs-inline", style: { flexWrap: "nowrap" } }, [
							h("input", {
								key: "m", className: "fs-input mono", value: form.model,
								onChange: (e) => patch({ model: e.target.value }),
								onBlur: () => save()
							}),
							h("input", {
								key: "d", className: "fs-input mono", readOnly: true,
								value: dim ? `${dim} dim` : "-- dim", title: "向量维度（测试连接后自动填入）"
							})
						])
					]),
					h("div", { className: "fs-row", key: "status" }, [
						h("span", { className: "fs-label" }, "状态"),
						h("span", { className: statusCls }, [
							h("span", { className: "fs-dot", key: "d" }),
							h("span", { className: "mono", key: "t" }, statusText)
						])
					])
				]),
				// 融合与召回
				h("div", { className: "fs-surface", key: "fusion" }, [
					h("div", { className: "fs-row", key: "f" }, [
						h("span", { className: "fs-label" }, "融合"),
						h(Segmented, {
							name: "fs-fusion",
							options: [
								{ value: "rrf", label: "RRF（推荐）" },
								{ value: "weighted", label: "加权平均" }
							],
							value: form.fusionMethod,
							onChange: (v) => save({ fusionMethod: v })
						})
					]),
					h("div", { className: "fs-row", key: "r" }, [
						h("span", { className: "fs-label" }, "召回"),
						h("div", { className: "fs-inline" }, [
							h("span", { className: "sub", key: "l1" }, "条数"),
							h("input", {
								key: "k", className: "fs-input num mono", type: "number",
								min: 1, max: 20, value: form.topK,
								onChange: (e) => patch({ topK: Number(e.target.value) || 5 }),
								onBlur: () => save()
							}),
							h("span", { className: "sub", key: "l2", style: { marginLeft: "8px" } }, "token 预算"),
							h("input", {
								key: "t", className: "fs-input num mono", type: "number",
								step: 100, min: 300, max: 4000, value: form.tokenBudget,
								onChange: (e) => patch({ tokenBudget: Number(e.target.value) || 1200 }),
								onBlur: () => save()
							})
						])
					])
				]),
				// 索引覆盖
				h("div", { className: "fs-surface", key: "cov" }, [
					h("div", { className: "fs-row", key: "bar" }, [
						h("span", { className: "fs-label" }, "索引覆盖"),
						h("div", { className: "fs-progress" }, [
							h("div", { className: "fs-track", key: "t" },
								h("div", {
									className: `fs-fill${building ? " building" : status === "stale" || status === "error" ? " stale" : ""}`,
									style: { width: `${pct}%` }
								})
							),
							h("span", { className: "mono", key: "c", style: { fontSize: "12px", color: "var(--fs-text-2)" } },
								`${done.toLocaleString()} / ${total.toLocaleString()} 条`)
						])
					]),
					h("div", { className: "fs-row", key: "act" }, [
						h("span", { className: "fs-label" }),
						h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: "10px" } }, [
							h("div", { className: "fs-inline", key: "l" }, [
								rebuildBtn,
								h("span", { className: "mono", style: { fontSize: "11.5px", color: "var(--fs-text-3)" } },
									`上次重建：${relTime(vecMeta.builtAt, Date.now())}`)
							]),
							status === "stale"
								? h("span", {
									key: "w", className: "mono",
									style: { fontSize: "11.5px", color: "var(--fs-warn)" }
								}, `● 模型已变更，需重建 (#${gen} → #${gen + 1})`)
								: null
						])
					])
				])
			];
		}

		// -------------------------------------------------------------------
		// Tab 2：自走与主动
		// -------------------------------------------------------------------
		function LifePane({ data, refresh, notify }) {
			const clock = data?.clock ?? {};
			const today = data?.today ?? {};
			const pc = data?.proactiveConfig ?? {};
			const targets = pc.targets ?? {};

			const [form, setForm] = react.useState(null);
			const [newGroup, setNewGroup] = react.useState("");

			react.useEffect(() => {
				if (data && form === null) {
					setForm({
						enabled: pc.enabled !== false,
						dailyMaxCount: pc.dailyMaxCount ?? 2,
						activeStart: pc.activeHours?.[0] ?? 8,
						activeEnd: pc.activeHours?.[1] ?? 24,
						idleTriggerHours: pc.idleTriggerHours ?? 6,
						masterPrivateChannelId: targets.masterPrivateChannelId ?? "",
						selfGroupChannelIds: [...(targets.selfGroupChannelIds ?? [])]
					});
				}
			}, [data, form]);

			if (!data || !form) return null;

			const scale = clock.timeScale ?? 1;
			const accel = clock.isAccelerated || scale > 1;
			const slot = today.currentSlot ?? {};
			const schedule = today.scheduleSummary ?? [];
			const proactiveCount = today.proactiveCount ?? 0;
			const dailyMax = today.dailyMaxCount ?? 2;
			const sleeping = slot.availability === "sleeping" || slot.availability === "sleep";

			function addGroup() {
				let v = newGroup.trim();
				if (!v) return;
				if (!v.startsWith("group:")) v = "group:" + v;
				if (!form.selfGroupChannelIds.includes(v)) {
					const next = { ...form, selfGroupChannelIds: [...form.selfGroupChannelIds, v] };
					setForm(next);
					save(next);
				}
				setNewGroup("");
			}

			function removeGroup(cid) {
				const next = { ...form, selfGroupChannelIds: form.selfGroupChannelIds.filter((x) => x !== cid) };
				setForm(next);
				save(next);
			}

			async function save(next = form) {
				const dailyMaxCount = Math.min(2, Math.max(1, Number(next.dailyMaxCount) || 2));
				const res = await api("POST", "/life/proactive-config", {
					enabled: next.enabled,
					dailyMaxCount,
					activeHours: [next.activeStart, next.activeEnd],
					idleTriggerHours: next.idleTriggerHours,
					targets: {
						masterCanonicalId: targets.masterCanonicalId ?? "user:master",
						masterPrivateChannelId: next.masterPrivateChannelId,
						selfGroupChannelIds: next.selfGroupChannelIds
					}
				});
				if (res?.ok) refresh();
				else notify(res?.error ?? "保存失败");
			}

			return [
				// 她此刻状态
				h("div", { className: "fs-surface", key: "state" }, [
					h("div", { className: "fs-persona", key: "bar" }, [
						h("div", { className: "fs-persona-left", key: "l" }, [
							h("span", { className: `fs-status ${sleeping ? "fs-status-stale" : "fs-status-ready"}` },
								h("span", { className: "fs-dot" })),
							h("span", { className: "fs-activity" }, slot.activity ?? "未排期"),
							today.dailyMoodTone ? h("span", { className: "fs-pill" }, today.dailyMoodTone) : null
						]),
						h("div", { className: "fs-inline mono", key: "r", style: { flexWrap: "nowrap" } }, [
							h("span", { className: `fs-pill${accel ? " accel" : ""}`, key: "s" },
								accel ? `⚡ ${scale}×` : "1×"),
							h("span", { style: { fontSize: "12.5px", color: "var(--fs-text-2)" }, key: "c" },
								fmtClock(clock.virtualNowMs)),
							h("span", { className: "fs-pill", key: "q" }, `主动 ${proactiveCount} / ${dailyMax}`)
						])
					]),
					schedule.length > 0
						? h("div", { className: "fs-schedule", key: "sched" },
							schedule.map((s, i) =>
								h("div", { className: `fs-slot${s.range === slot.range ? " current" : ""}`, key: i }, [
									h("span", { className: "fs-slot-time mono", key: "t" }, s.range),
									h("span", { key: "a" }, s.activity)
								])
							)
						)
						: null
				]),
				// 主动投递白名单
				h("div", { className: "fs-surface", key: "wl" }, [
					h("div", { className: "fs-row", key: "sw" }, [
						h("span", { className: "fs-label" }, "主动开口"),
						h("div", { className: "fs-inline", style: { justifyContent: "space-between", width: "100%", flexWrap: "nowrap" } }, [
							h("label", { className: "fs-switch", key: "s" },
								h("input", {
									type: "checkbox", checked: form.enabled,
									onChange: (e) => { const n = { ...form, enabled: e.target.checked }; setForm(n); save(n); }
								})
							),
							h("div", { className: "fs-inline", key: "m", style: { flexWrap: "nowrap" } }, [
								h("span", { className: "sub" }, "每日上限"),
								h("input", {
									className: "fs-input num mono", type: "number", min: 1, max: 2,
									value: form.dailyMaxCount,
									onChange: (e) => patch2({ dailyMaxCount: Number(e.target.value) || 2 }),
									onBlur: () => save()
								})
							])
						])
					]),
					h("div", { className: "fs-row", key: "hrs" }, [
						h("span", { className: "fs-label" }, "触发时段"),
						h("div", { className: "fs-inline", style: { flexWrap: "nowrap" } }, [
							h("input", {
								key: "a", className: "fs-input num mono", type: "number", min: 0, max: 23,
								value: form.activeStart,
								onChange: (e) => patch2({ activeStart: Number(e.target.value) }),
								onBlur: () => save()
							}),
							h("span", { key: "d", style: { color: "var(--fs-text-3)" } }, "-"),
							h("input", {
								key: "b", className: "fs-input num mono", type: "number", min: 1, max: 24,
								value: form.activeEnd,
								onChange: (e) => patch2({ activeEnd: Number(e.target.value) }),
								onBlur: () => save()
							}),
							h("span", { key: "h", className: "sub" }, "时"),
							h("span", { key: "il", className: "sub", style: { marginLeft: "10px" } }, "空闲阈值"),
							h("input", {
								key: "i", className: "fs-input num mono", type: "number", min: 1, max: 48,
								value: form.idleTriggerHours,
								onChange: (e) => patch2({ idleTriggerHours: Number(e.target.value) || 6 }),
								onBlur: () => save()
							}),
							h("span", { key: "ih", className: "sub" }, "h")
						])
					]),
					h("div", { className: "fs-row", key: "master" }, [
						h("label", { className: "fs-label" }, "主人私聊"),
						h("input", {
							className: "fs-input mono", value: form.masterPrivateChannelId,
							placeholder: "private:<QQ号>",
							onChange: (e) => patch2({ masterPrivateChannelId: e.target.value }),
							onBlur: () => save()
						})
					]),
					h("div", { className: "fs-row", key: "groups" }, [
						h("span", { className: "fs-label" }, "自建群聊"),
						h("div", { className: "fs-inline", style: { width: "100%", justifyContent: "space-between" } }, [
							h("div", { className: "fs-chips", key: "chips" },
								form.selfGroupChannelIds.map((cid) =>
									h("span", { className: "fs-chip mono", key: cid }, [
										h("span", { key: "t" }, cid),
										h("button", {
											type: "button", key: "x", className: "fs-chip-x",
											onClick: () => removeGroup(cid)
										}, "×")
									])
								)
							),
							h("div", { className: "fs-inline", key: "add", style: { flexWrap: "nowrap" } }, [
								h("input", {
									className: "fs-input mono",
									style: { width: "128px", flex: "0 0 auto" },
									value: newGroup, placeholder: "group:20099",
									onChange: (e) => setNewGroup(e.target.value),
									onKeyDown: (e) => { if (e.key === "Enter") addGroup(); }
								}),
								h("button", { className: "fs-btn", onClick: addGroup }, "+ 添加")
							])
						])
					])
				])
			];

			function patch2(p) { setForm({ ...form, ...p }); }
		}

		// -------------------------------------------------------------------
		// Tab 3：记忆检视
		// -------------------------------------------------------------------
		function InspectorPane({ data, refresh, notify, onSelectOwner }) {
			if (!data) return null;

			const persons = data.persons ?? [];
			const memories = data.memories ?? [];
			const pendings = data.pendings ?? [];
			const curGen = data.currentGenerationId ?? 1;
			const selected = data.selectedOwnerId ?? "all";

			async function forget(id) {
				const res = await api("POST", "/inspector/forget", { targetType: "memory", id });
				if (res?.ok) {
					notify(`已删除 #${id}`);
					refresh();
				} else {
					notify(res?.error ?? "删除失败");
				}
			}

			const ownerPill = (ownerId, label, count) =>
				h("button", {
					type: "button", key: ownerId,
					className: `fs-owner${selected === ownerId ? " active" : ""}`,
					onClick: () => onSelectOwner(ownerId)
				}, label);

			return [
				h("div", {
					key: "bar",
					style: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }
				}, [
					h("div", { className: "fs-owner-bar", key: "pills" }, [
						ownerPill("all", "全部"),
						...persons.map((p) =>
							ownerPill(
								p.ownerId,
								`${p.ownerId === "self" ? "self" : p.displayName}${p.relationStage && p.ownerId !== "self" ? ` · ${p.relationStage}` : ""}`
							)
						)
					]),
					h("span", { key: "n", className: "mono", style: { fontSize: "11.5px", color: "var(--fs-text-3)" } },
						`${memories.length} 条`)
				]),
				h("div", { className: "fs-surface", key: "mems" },
					memories.length === 0
						? h("div", { className: "fs-mem-row" },
							h("span", { style: { fontSize: "12px", color: "var(--fs-text-3)" } }, "暂无记忆"))
						: memories.map((m) => {
							const imp = m.importance ?? 1;
							const stars = "★".repeat(imp);
							const starColor = imp >= 3 ? "var(--fs-ok)" : "var(--fs-text-3)";
							const vecDot = m.vecGenerationId == null
								? h("span", { style: { color: "var(--fs-info)" }, title: "待向量化 · 0.85×RRF 补偿" }, "◐")
								: m.vecGenerationId === curGen
									? h("span", { style: { color: "var(--fs-ok)" }, title: "已向量化" }, "●")
									: h("span", { style: { color: "var(--fs-warn)" }, title: "世代过期" }, "▲");
							return h("div", { className: "fs-mem-row", key: m.id }, [
								h("div", { className: "fs-mem-left", key: "l" }, [
									h("span", { className: "fs-kind", key: "k" }, m.kind),
									h("span", { className: "fs-mem-text", key: "t", title: m.content }, m.content)
								]),
								h("div", { className: "fs-mem-right mono", key: "r" }, [
									h("span", { style: { color: starColor }, title: imp >= 3 ? "豁免衰减" : "正常衰减", key: "s" }, stars),
									h("span", { key: "c" }, m.channelId ?? ""),
									vecDot,
									h("button", {
										type: "button", key: "x", className: "fs-btn-del",
										title: "删除 (forget)", onClick: () => forget(m.id)
									}, "×")
								])
							]);
						})
				),
				h("div", { className: "fs-surface", key: "pending" }, [
					h("div", { className: "fs-row-between", key: "head", style: { background: "var(--fs-control)" } }, [
						h("span", { style: { fontSize: "11.5px", fontWeight: 600, color: "var(--fs-text-2)" } }, "待办到期"),
						h("span", { className: "mono", style: { fontSize: "11px", color: "var(--fs-text-3)" } }, String(pendings.length))
					]),
					h("div", { key: "list" },
						pendings.map((p) =>
							h("div", { className: "fs-mem-row", key: p.id }, [
								h("div", { className: "fs-mem-left", key: "l" }, [
									h("span", { className: "fs-kind mono", style: { width: "72px" } }, fmtDueAt(p.dueAt)),
									h("span", { className: "fs-mem-text", title: p.reason }, p.reason)
								]),
								h("div", { className: "fs-mem-right mono", key: "r" },
									h("span", null, p.channelId ?? ""))
							])
						)
					)
				])
			];
		}

		// -------------------------------------------------------------------
		// 面板根组件：顶栏 + 三 Tab + 数据装载 + 2s 轮询
		// -------------------------------------------------------------------
		function createSection() {
			return function FishSoulSection() {
				const [tab, setTab] = react.useState("retrieval");
				const [retrieval, setRetrieval] = react.useState(null);
				const [life, setLife] = react.useState(null);
				const [inspector, setInspector] = react.useState(null);
				const [ownerId, setOwnerId] = react.useState("all");
				const [toast, setToast] = react.useState(null);

				react.useEffect(() => { ensureStyle(); }, []);

				const notify = react.useCallback((text) => setToast({ key: Date.now(), text }), []);

				react.useEffect(() => {
					if (toast === null) return;
					const timer = setTimeout(() => setToast(null), 2000);
					return () => clearTimeout(timer);
				}, [toast]);

				const loadRetrieval = react.useCallback(async () => {
					const res = await api("GET", "/retrieval/state");
					if (res?.ok !== false) setRetrieval(res);
				}, []);

				const loadLife = react.useCallback(async () => {
					const res = await api("GET", "/life/state");
					if (res?.ok !== false) setLife(res);
				}, []);

				const loadInspector = react.useCallback(async (owner) => {
					const query = owner && owner !== "all" ? `?ownerId=${encodeURIComponent(owner)}` : "";
					const res = await api("GET", `/inspector/overview${query}`);
					if (res?.ok !== false) setInspector({ ...res, selectedOwnerId: owner });
				}, []);

				react.useEffect(() => { loadRetrieval(); loadLife(); }, [loadRetrieval, loadLife]);
				react.useEffect(() => { loadInspector(ownerId); }, [ownerId, loadInspector]);

				// 2s 轮询检索状态（重建进度/覆盖数实时刷新）
				react.useEffect(() => {
					const timer = setInterval(loadRetrieval, 2000);
					return () => clearInterval(timer);
				}, [loadRetrieval]);

				// 虚拟时钟走秒（纯展示，不驱动业务）
				react.useEffect(() => {
					const timer = setInterval(() => {
						setLife((prev) => {
							if (!prev?.clock?.virtualNowMs) return prev;
							const scale = prev.clock.timeScale ?? 1;
							return {
								...prev,
								clock: { ...prev.clock, virtualNowMs: prev.clock.virtualNowMs + 1000 * scale }
							};
						});
					}, 1000);
					return () => clearInterval(timer);
				}, []);

				const TABS = [
					["retrieval", "记忆检索"],
					["life", "自走与主动"],
					["inspector", "记忆检视"]
				];

				return h("div", { className: "fs" }, [
					h("header", { className: "fs-top", key: "top" }, [
						h("div", { className: "fs-brand", key: "b" }, [
							h("span", { className: "fs-brand-icon", key: "i" },
								h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 }, [
									h("path", { key: "p", d: "M2 16s3-6 10-6 10 6 10 6-3 6-10 6-10-6-10-6Z" }),
									h("circle", { key: "c", cx: 12, cy: 16, r: 2.5 })
								])
							),
							h("span", { key: "t" }, "鱼 · dsh-fish-soul")
						]),
						h(Segmented, {
							key: "tabs",
							options: TABS.map(([v, label]) => ({ value: v, label })),
							value: tab,
							onChange: setTab
						})
					]),
					tab === "retrieval"
						? h(RetrievalPane, { key: "r", data: retrieval, refresh: loadRetrieval, notify })
						: tab === "life"
							? h(LifePane, { key: "l", data: life, refresh: loadLife, notify })
							: h(InspectorPane, {
								key: "i", data: inspector, notify,
								refresh: () => loadInspector(ownerId),
								onSelectOwner: setOwnerId
							}),
					toast === null ? null : h("div", { className: "fs-toast", role: "status", key: "toast" }, toast.text)
				]);
			};
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "fish-soul",
				order: 60,
				label: () => "鱼 · 记忆与自走"
			}, createSection())), `${PLUGIN_ID}: panel`);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
