/**
 * dsh-fish-soul — 桌面端设置面板（client.js）
 *
 * 真源：
 *  - 业务逻辑：《dsh-fish-soul 设计方案》v1.1（DESIGN-fish-soul.md）
 *  - 接口契约：《dsh-fish-soul 前端 UI 设计文档》§4 + lib/routes.js
 *  - DOM/交互：dsh_fish_soul_deepseek_harness.html 视觉原型（1:1）
 *
 * 宿主契约（参照 dsh-archive-vault-desktop/lib/client.js）：
 *  - window.__ModuleLoader__.load({ id, factory })，exports.apply/inject
 *  - inject: ["slots"]，ctx.slots.inject("settings.section", ...) 挂载
 *  - 通信 100% 走 /api/plugins/fish-soul/*，前端不直连数据库
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


		// 样式放在 lib/panel.css（插件路由提供），client.js 只留逻辑，保持在宿主的大小限制以内
		let stylePending = null;
		function ensureStyle() {
			if (typeof document === "undefined") return;
			const tagId = `${PLUGIN_ID}/panel.css`;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null || stylePending !== null) return;
			stylePending = fetch(`${API}/ui/panel.css`).then((r) => (r.ok ? r.text() : "")).then((css) => {
				if (css === "" || document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
				const tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}).catch(() => {}).finally(() => { stylePending = null; });
		}

		// ── 通信层：fail-open（面板任何请求失败都不抛出到宿主） ──
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

		// ── Tab 1：记忆检索 ──
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

		// ── Tab 2：自走与主动 ──
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
						dailyMaxCount: pc.dailyMaxCount ?? 10,
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
			const dailyMax = today.dailyMaxCount ?? 10;
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
				const dailyMaxCount = Math.min(50, Math.max(0, Math.floor(Number(next.dailyMaxCount))));
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
							h("span", { className: "fs-pill", key: "q" }, `自发 ${proactiveCount} / ${dailyMax}`)
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
								h("span", { className: "sub", title: "只算她自发的；你交代的提醒不占这个数" }, "自发上限/天"),
								h("input", {
									className: "fs-input num mono", type: "number", min: 0, max: 50,
									value: form.dailyMaxCount,
									onChange: (e) => patch2({ dailyMaxCount: Number(e.target.value) }),
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
							placeholder: "留空 = private:<主人 QQ>",
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

		// ── Tab 4：QQ 接入（SnowLuma 直连）与会话工作区 ──
		function ChannelPane({ data, refresh, notify }) {
			const qq = data?.qq ?? {};
			const ses = data?.sessions ?? {};
			const [form, setForm] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			react.useEffect(() => {
				if (data && form === null) {
					setForm({
						enabled: qq.enabled === true,
						wsUrl: qq.wsUrl ?? "ws://127.0.0.1:3001",
						accessToken: "",
						masterQqUin: data.masterQqUin ?? "",
						groupAllowList: (qq.groupAllowList ?? []).join(", "),
						followUpCount: qq.followUpCount ?? 3,
						followUpSeconds: qq.followUpSeconds ?? 120
					});
				}
			}, [data, form]);

			if (!data || !form) return null;
			const patch = (p) => setForm({ ...form, ...p });

			async function save(p = {}) {
				const next = { ...form, ...p };
				setForm(next);
				const res = await api("POST", "/channels/qq-config", {
					enabled: next.enabled,
					wsUrl: next.wsUrl,
					...(next.accessToken !== "" ? { accessToken: next.accessToken } : {}),
					masterQqUin: next.masterQqUin,
					groupAllowList: next.groupAllowList.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
					followUpCount: Number(next.followUpCount),
					followUpSeconds: Number(next.followUpSeconds)
				});
				if (res?.ok) { if (next.accessToken !== "") setForm({ ...next, accessToken: "" }); refresh(); }
				else notify(res?.error ?? "保存失败");
			}

			async function pickWorkspace(value) {
				setBusy(true);
				const res = await api("POST", "/sessions/workspace", value === "__dedicated__" ? { dedicated: true } : { path: value });
				setBusy(false);
				if (res?.ok) { notify("之后新建的会话会放在这个工作区"); refresh(); }
				else notify(res?.error ?? "切换失败");
			}

			async function migrate() {
				setBusy(true);
				const res = await api("POST", "/sessions/migrate", {});
				setBusy(false);
				if (res?.ok) notify(`已迁移 ${res.migrated} 个聊天${res.failed?.length ? `，${res.failed.length} 个失败` : ""}`);
				else notify(res?.error ?? "迁移失败");
				refresh();
			}

			const connected = qq.connected === true;
			const statusClass = !form.enabled ? "fs-status-stale" : connected ? "fs-status-ready" : "fs-status-error";
			const statusText = !form.enabled ? "未启用" : connected ? `已连接 · ${qq.nickname || ""}（${qq.selfId || "?"}）· 好友 ${qq.friendCount ?? 0}` : (qq.lastError || "连接中…");
			const workspaces = ses.workspaces ?? [];
			const chats = ses.chats ?? [];
			const elsewhere = chats.filter((c) => c.workspacePath !== ses.workspacePath).length;
			const options = [
				h("option", { key: "__dedicated__", value: "__dedicated__" }, `鱼（专用工作区）· ${ses.dedicatedPath ?? ""}`),
				...workspaces.filter((w) => w.path !== ses.dedicatedPath).map((w) =>
					h("option", { key: w.path, value: w.path }, `${w.title || "未命名"} · ${w.path}`))
			];

			return [
				h("div", { className: "fs-surface", key: "conn" }, [
					h("div", { className: "fs-row", key: "sw" }, [
						h("span", { className: "fs-label" }, "QQ 接入"),
						h("div", { className: "fs-inline", style: { justifyContent: "space-between", width: "100%", flexWrap: "nowrap" } }, [
							h("label", { className: "fs-switch", key: "s" },
								h("input", { type: "checkbox", checked: form.enabled, onChange: (e) => save({ enabled: e.target.checked }) })),
							h("span", { className: `fs-status ${statusClass}`, key: "st" }, [h("span", { className: "fs-dot", key: "d" }), h("span", { key: "t" }, statusText)])
						])
					]),
					h("div", { className: "fs-row", key: "url" }, [
						h("label", { className: "fs-label" }, "SnowLuma WS"),
						h("input", { className: "fs-input mono", value: form.wsUrl, placeholder: "ws://127.0.0.1:3001",
							onChange: (e) => patch({ wsUrl: e.target.value }), onBlur: () => save() })
					]),
					h("div", { className: "fs-row", key: "tok" }, [
						h("label", { className: "fs-label" }, "访问令牌"),
						h("input", { className: "fs-input mono", type: "password", value: form.accessToken,
							placeholder: qq.hasToken ? `已保存 ${qq.tokenMasked}（留空不改）` : "SnowLuma 配置里的 accessToken",
							onChange: (e) => patch({ accessToken: e.target.value }), onBlur: () => { if (form.accessToken !== "") save(); } })
					]),
					h("div", { className: "fs-row", key: "master" }, [
						h("label", { className: "fs-label" }, "主人 QQ"),
						h("input", { className: "fs-input mono", value: form.masterQqUin, placeholder: "你的 QQ 号",
							onChange: (e) => patch({ masterQqUin: e.target.value }), onBlur: () => save() })
					]),
					h("div", { className: "fs-row", key: "groups" }, [
						h("label", { className: "fs-label" }, "只在这些群"),
						h("input", { className: "fs-input mono", value: form.groupAllowList, placeholder: "留空 = 所有群（都只听 @ 和引用）",
							onChange: (e) => patch({ groupAllowList: e.target.value }), onBlur: () => save() })
					]),
					h("div", { className: "fs-row", key: "follow" }, [
						h("span", { className: "fs-label" }, "点名后接着听"),
						h("div", { className: "fs-inline", style: { flexWrap: "nowrap" } }, [
							h("input", { key: "c", className: "fs-input num mono", type: "number", min: 0, max: 20, value: form.followUpCount,
								onChange: (e) => patch({ followUpCount: e.target.value }), onBlur: () => save() }),
							h("span", { key: "u", className: "sub" }, "条 / "),
							h("input", { key: "s", className: "fs-input num mono", type: "number", min: 0, max: 1800, value: form.followUpSeconds,
								onChange: (e) => patch({ followUpSeconds: e.target.value }), onBlur: () => save() }),
							h("span", { key: "su", className: "sub" }, "秒内")
						])
					])
				]),
				h("div", { className: "fs-surface", key: "ws" }, [
					h("div", { className: "fs-row", key: "pick" }, [
						h("label", { className: "fs-label" }, "会话工作区"),
						h("select", { className: "fs-input", disabled: busy,
							value: ses.isDedicated ? "__dedicated__" : ses.workspacePath,
							onChange: (e) => pickWorkspace(e.target.value) }, options)
					]),
					h("div", { className: "fs-row", key: "mig" }, [
						h("span", { className: "fs-label" }, "已有会话"),
						h("div", { className: "fs-inline", style: { justifyContent: "space-between", width: "100%" } }, [
							h("span", { className: "sub", key: "t" }, elsewhere > 0
								? `${chats.length} 个聊天，其中 ${elsewhere} 个还在别的工作区（切换只影响新会话）`
								: `${chats.length} 个聊天，都在当前工作区`),
							h("button", { className: "fs-btn", key: "b", disabled: busy || elsewhere === 0, onClick: migrate }, "全部迁到新工作区")
						])
					]),
					chats.length > 0
						? h("div", { className: "fs-schedule", key: "list" }, chats.slice(0, 30).map((c) =>
							h("div", { className: "fs-slot", key: c.sessionId }, [
								h("span", { className: "fs-slot-time mono", key: "id" }, c.channelId),
								h("span", { key: "t" }, c.title || c.sessionId)
							])))
						: null
				])
			];
		}

		// ── Tab 3：记忆检视 ──
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

		// ── Tab 5：B站（登录 / 私信 / 自己刷视频） ──
		function BiliPane({ data, refresh, notify }) {
			const b = data?.bili ?? {};
			const br = b.browse ?? {};
			const [form, setForm] = react.useState(null);
			const [qr, setQr] = react.useState(null);
			const [cookie, setCookie] = react.useState("");
			const [acTime, setAcTime] = react.useState("");
			const [showCookie, setShowCookie] = react.useState(false);
			const [busy, setBusy] = react.useState(false);

			react.useEffect(() => {
				if (data && form === null) setForm({
					masterUid: b.masterUid ?? "", allowList: (b.allowList ?? []).join(", "), links: (b.links ?? []).join("\n"),
					perDay: br.perDay ?? 3, videosPerSession: br.videosPerSession ?? 3
				});
			}, [data, form]);

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
			const patch = (p) => setForm({ ...form, ...p });
			const split = (v, re = /[,，\s]+/) => String(v).split(re).map((x) => x.trim()).filter(Boolean);

			// 发一个请求：成功就提示 + 刷新，失败报错
			const act = async (path, body, okMsg, failMsg) => {
				setBusy(true);
				const r = await api("POST", path, body);
				setBusy(false);
				if (!r?.ok) notify(r?.error ?? failMsg);
				else { if (okMsg) notify(typeof okMsg === "function" ? okMsg(r) : okMsg); refresh(); }
				return r;
			};
			const save = (p = {}) => act("/channels/bili-config", {
				masterUid: form.masterUid,
				allowList: split(form.allowList),
				links: split(form.links, /\n+/),
				...(p.top ?? {}),
				browse: { perDay: Number(form.perDay), videosPerSession: Number(form.videosPerSession), ...(p.browse ?? {}) }
			}, null, "保存失败");
			const startQr = async () => {
				const r = await act("/bili/qr/start", {}, null, "拿不到二维码");
				if (r?.ok) setQr({ svg: r.svg, status: "waiting" });
			};
			const cookieLogin = async () => {
				const r = await act("/bili/cookie", { cookie, acTimeValue: acTime }, (x) => `已登录 ${x.uname || ""}${x.canRenew ? "" : "（这种登录不能自动续期）"}`, "登录失败");
				if (r?.ok) { setCookie(""); setAcTime(""); setShowCookie(false); }
			};
			const logout = () => act("/bili/logout", {}, "已退出 B站登录", "退出失败");
			const browseNow = () => act("/bili/browse-now", {}, "开始刷了，一两分钟后看下面的列表", "没刷成");

			const live = b.loggedIn && !b.authInvalid;
			const loginClass = live ? "fs-status-ready" : b.authInvalid ? "fs-status-error" : "fs-status-stale";
			const loginText = live ? `已登录 · ${b.uname || ""}（UID ${b.uid || "?"}）`
				: b.authInvalid ? "登录失效了，重新扫码" : "未登录";
			const pollText = !b.enabled ? "未启用"
				: !b.loggedIn ? "登录后开始收私信"
				: b.lastError ? b.lastError
				: b.lastPollAt ? `收私信中 · ${relTime(b.lastPollAt, Date.now())}查过` : "启动中…";
			const renewText = !b.loggedIn ? null
				: !b.canRenew ? "这种登录不能自动续期，建议扫码登录一次（或粘 Cookie 时一起填 ac_time_value）"
				: b.renewError ? `自动续期没成功：${b.renewError}`
				: b.renewedAt ? `会自动续期 · 上次续期 ${relTime(b.renewedAt, Date.now())}` : "会自动续期（每天检查一次）";
			const qrHint = qr === null ? null
				: qr.status === "scanned" ? "已扫码，在手机上点确认"
				: qr.status === "expired" ? "二维码过期了，重新获取"
				: qr.status === "error" ? (qr.error || "出错了")
				: "用 B站 App 扫一扫（建议用给鱼准备的小号）";
			// 一行 = 标签 + 内容（变参子节点，免 key）
			const row = (label, ...kids) => h("div", { className: "fs-row" }, h("span", { className: "fs-label" }, label), ...kids);
			const inline = (style, ...kids) => h("div", { className: "fs-inline", style }, ...kids);
			const sub = (text) => h("span", { className: "sub" }, text);
			const sw = (checked, onChange) => h("label", { className: "fs-switch" },
				h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) }));
			const field = (name, props, tag = "input") => h(tag, {
				className: "fs-input mono", value: form[name], onChange: (e) => patch({ [name]: e.target.value }), onBlur: () => save(), ...props
			});
			const SPREAD = { justifyContent: "space-between", width: "100%", flexWrap: "nowrap" };
			const NOWRAP = { flexWrap: "nowrap" };
			const recent = b.recent ?? [];

			return h(react.Fragment, null,
				h("div", { className: "fs-surface" },
					row("B站账号", inline(SPREAD,
						h("span", { className: `fs-status ${loginClass}` }, h("span", { className: "fs-dot" }), h("span", null, loginText)),
						inline(null,
							h("button", { className: "fs-btn fs-btn-primary", disabled: busy, onClick: startQr }, b.loggedIn ? "换号扫码" : "扫码登录"),
							h("button", { className: "fs-btn", onClick: () => setShowCookie(!showCookie) }, "用 Cookie"),
							b.loggedIn ? h("button", { className: "fs-btn fs-btn-warn", onClick: logout }, "退出") : null))),
					qr === null ? null : row("", inline({ alignItems: "center", gap: "14px" },
						qr.status === "expired" || qr.status === "error"
							? h("button", { className: "fs-btn", onClick: startQr }, "重新获取")
							: h("img", { alt: "B站登录二维码", width: 180, height: 180, style: { borderRadius: "6px", background: "#fff" },
								src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}` }),
						sub(qrHint))),
					renewText === null ? null : row("", h("span", { className: "fs-hint", style: b.renewError || !b.canRenew ? { color: "#f87171" } : null }, renewText)),
					showCookie ? row("Cookie", inline({ width: "100%", flexWrap: "nowrap" },
						h("input", { className: "fs-input mono", type: "password", value: cookie,
							placeholder: "SESSDATA=…; bili_jct=…; DedeUserID=…", onChange: (e) => setCookie(e.target.value) }),
						h("button", { className: "fs-btn", disabled: busy || cookie === "", onClick: cookieLogin }, "登录"))) : null,
					showCookie ? row("ac_time_value", h("input", { className: "fs-input mono", type: "password", value: acTime,
						placeholder: "可选：网页 localStorage 里的 ac_time_value，填了才能自动续期", onChange: (e) => setAcTime(e.target.value) })) : null,
					row("B站接入", inline(SPREAD, sw(b.enabled === true, (v) => save({ top: { enabled: v } })), sub(pollText)))),
				h("div", { className: "fs-surface" },
					row("自动回私信", inline(NOWRAP, sw(b.autoReply === true, (v) => save({ top: { autoReply: v } })),
						sub(b.autoReply ? "回主人、白名单和互关的人" : "关着：只记不回（建议先这样跑一周）"))),
					row("主人 B站 UID", field("masterUid", { placeholder: "你自己的 B站 UID（和主人 QQ 算同一个人）" })),
					row("白名单 UID", field("allowList", { placeholder: "逗号分隔；陌生人只记不回" })),
					row("互关的人也回", sw(b.replyMutual !== false, (v) => save({ top: { replyMutual: v } }))),
					row("同一个人", field("links", { rows: 3, style: { height: "auto", resize: "vertical" }, placeholder: "每行一个：B站UID=QQ号（记忆合到一起）" }, "textarea")),
					row("主动发私信", inline(NOWRAP, sw(b.proactive === true, (v) => save({ top: { proactive: v } })),
						sub("只发给主人，和 QQ 共用每天的主动额度")))),
				h("div", { className: "fs-surface" },
					row("空闲时自己刷", inline(SPREAD, sw(br.enabled !== false, (v) => save({ browse: { enabled: v } })),
						inline(NOWRAP,
							h("span", { className: "fs-pill mono" }, `今天 ${br.todayCount ?? 0} / ${br.perDay ?? 3} 轮`),
							h("button", { className: "fs-btn", disabled: br.running === true || b.enabled !== true, onClick: browseNow },
								br.running ? "正在刷…" : "现在刷一下")))),
					row("每天", inline(NOWRAP,
						field("perDay", { className: "fs-input num mono", type: "number", min: 0, max: 12 }), sub("轮，每轮"),
						field("videosPerSession", { className: "fs-input num mono", type: "number", min: 1, max: 6 }), sub("条"))),
					row("喜欢就点赞", inline(NOWRAP, sw(br.like === true, (v) => save({ browse: { like: v } })), sub("不投币、不评论")))),
				h("div", { className: "fs-surface" },
					recent.length === 0
						? h("div", { className: "fs-mem-row" }, h("span", { style: { fontSize: "12px", color: "var(--fs-text-3)" } }, "还没刷过"))
						: recent.map((v) => h("div", { className: "fs-mem-row", key: v.bvid },
							h("div", { className: "fs-mem-left" },
								h("span", { className: "fs-kind" }, v.liked ? "♥" : v.skipped ? "划走" : v.source === "following" ? "关注" : "推荐"),
								h("span", { className: "fs-mem-text", title: `${v.title}${v.impression ? `\n${v.impression}` : ""}` },
									`《${v.title}》${v.owner ? ` · ${v.owner}` : ""}${v.impression ? ` —— ${v.impression}` : ""}`)),
							h("div", { className: "fs-mem-right mono" },
								h("a", { href: `https://www.bilibili.com/video/${v.bvid}`, target: "_blank", rel: "noreferrer", style: { color: "inherit" } }, v.bvid),
								h("span", null, relTime(v.seenAt, Date.now())))))));
		}

		// ── 抖音 Tab：界面在单独的 client.douyin.js（按需加载，主文件保持在宿主大小限制内）──
		let douyinChunk = null;
		function DouyinTab(props) {
			const [mod, setMod] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				if (typeof require.async !== "function") {
					setMod({ error: "这个版本的 DSH 不支持按需加载界面，抖音设置暂时打不开（升级 DSH 后再试）" });
					return undefined;
				}
				douyinChunk ??= require.async("./client.douyin.js");
				douyinChunk.then((m) => { if (alive) setMod({ Pane: m?.DouyinPane ?? m?.default?.DouyinPane }); },
					(error) => { douyinChunk = null; if (alive) setMod({ error: `抖音设置界面加载失败：${String(error instanceof Error ? error.message : error)}` }); });
				return () => { alive = false; };
			}, []);
			if (mod === null) return h("div", { className: "fs-surface" }, h("span", { className: "fs-hint" }, "加载中…"));
			if (!mod.Pane) return h("div", { className: "fs-notice" }, h("b", null, "抖音"), h("span", null, mod.error || "抖音设置界面加载失败"));
			return h(mod.Pane, { ...props, api, relTime });
		}

		// ── 面板根组件：顶栏 + Tab + 数据装载 + 轮询 ──
		function createSection() {
			return function FishSoulSection() {
				const [tab, setTab] = react.useState("retrieval");
				const [retrieval, setRetrieval] = react.useState(null);
				const [life, setLife] = react.useState(null);
				const [inspector, setInspector] = react.useState(null);
				const [channels, setChannels] = react.useState(null);
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

				const loadChannels = react.useCallback(async () => {
					const res = await api("GET", "/channels/state");
					if (res?.ok !== false) setChannels(res);
				}, []);

				react.useEffect(() => { loadRetrieval(); loadLife(); loadChannels(); }, [loadRetrieval, loadLife, loadChannels]);

				// QQ / B站 / 抖音 状态 3s 刷新一次（只在打开这几个 Tab 时）
				react.useEffect(() => {
					if (tab !== "qq" && tab !== "bili" && tab !== "douyin") return undefined;
					const timer = setInterval(loadChannels, 3000);
					return () => clearInterval(timer);
				}, [tab, loadChannels]);
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
					["inspector", "记忆检视"],
					["qq", "QQ 接入"],
					["bili", "B站"],
					["douyin", "抖音"]
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
							: tab === "qq"
								? h(ChannelPane, { key: "q", data: channels, refresh: loadChannels, notify })
								: tab === "bili"
									? h(BiliPane, { key: "b", data: channels, refresh: loadChannels, notify })
									: tab === "douyin"
										? h(DouyinTab, { key: "d", data: channels, refresh: loadChannels, notify })
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
