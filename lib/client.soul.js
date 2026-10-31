/**
 * dsh-fish-soul — 设置面板「记忆检视」「动态」页（client.soul.js，按需加载的包内分块）
 *
 * 主面板 client.js 用 require.async("./client.soul.js") 拿到 InspectorPane / ActivityPane；
 * api / relTime / fmtDueAt / 控件（props.ui）都由主面板传进来，分块自己不 require 主文件。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	chunk: "client.soul.js",
	factory: (require) => {
		const react = require("react");
		const fmtClock = (ms) => {
			const d = new Date(ms);
			const p = (n) => String(n).padStart(2, "0");
			const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
			return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
		};
		const STAGES = [["stranger", "陌生人"], ["acquaintance", "认识"], ["friend", "朋友"], ["close", "很熟"]];
		const KIND = { fact: "事实", event: "事件", feeling: "感受" };
		const stageLabel = (v) => STAGES.find(([k]) => k === v)?.[1] ?? v ?? "";
		const fmtDay = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? `${new Date(ms).getFullYear()}-${String(new Date(ms).getMonth() + 1).padStart(2, "0")}-${String(new Date(ms).getDate()).padStart(2, "0")}` : "--");

		function usePoll(api, path, ms) {
			const [data, setData] = react.useState(null);
			const load = react.useCallback(async () => { const r = await api("GET", path); if (r?.ok !== false) setData(r); }, [api, path]);
			react.useEffect(() => {
				load();
				if (!ms) return undefined;
				const t = setInterval(load, ms);
				return () => clearInterval(t);
			}, [load, ms]);
			return [data, load];
		}

		// ── 一条记忆：点笔改，改内容 = 新写一条、旧的留档 ──
		function MemoryItem({ m, ui, api, notify, refresh, curGen }) {
			const { h, Tag, Dot, IconButton, Area, Num, Select, Button } = ui;
			const [edit, setEdit] = react.useState(null);
			const imp = m.importance ?? 1;
			const vec = m.vecGenerationId == null ? ["idle", "待向量化"] : m.vecGenerationId === curGen ? ["done", "已向量化"] : ["warning", "向量过期"];
			const origin = `出处：${m.source ?? ""}${m.evidence ? ` · ${m.evidence}` : ""}`;
			async function forget() {
				const r = await api("POST", "/inspector/forget", { targetType: "memory", id: m.id });
				if (r?.ok) { notify(`已删除 #${m.id}（能在下面"改掉 / 过时的"里恢复）`); refresh(); } else notify(r?.error ?? "删除失败");
			}
			async function save() {
				const r = await api("POST", "/inspector/memory-edit", { id: m.id, content: edit.content, importance: Number(edit.importance), kind: edit.kind });
				if (r?.ok) { setEdit(null); notify(r.replaced ? "已改（旧的留档了）" : "已保存"); refresh(); } else notify(r?.error ?? "保存失败");
			}
			if (edit !== null) {
				return h("div", { className: "fs-item edit" },
					Area({ value: edit.content, rows: 2, "aria-label": "记忆内容", onChange: (e) => setEdit({ ...edit, content: e.target.value }) }),
					h("div", { className: "fs-ctl" },
						Select({ value: edit.kind, "aria-label": "类型", onChange: (e) => setEdit({ ...edit, kind: e.target.value }) },
							...Object.entries(KIND).map(([k, v]) => h("option", { key: k, value: k }, v))),
						h("span", { className: "fs-unit" }, "重要度"),
						Num({ min: 1, max: 5, value: edit.importance, "aria-label": "重要度", onChange: (e) => setEdit({ ...edit, importance: e.target.value }) }),
						h("span", { className: "fs-fill-gap" }),
						Button({ variant: "ghost", onClick: () => setEdit(null) }, "取消"),
						Button({ variant: "primary", onClick: save, disabled: String(edit.content).trim() === "" }, "保存")),
					h("span", { className: "fs-item-sub" }, origin));
			}
			return h("div", { className: "fs-item" },
				Tag(KIND[m.kind] ?? m.kind),
				h("span", { className: "fs-item-main", title: `${m.content}\n${origin}` }, m.content),
				h("span", { className: "fs-item-meta" },
					imp >= 2 ? h("span", { title: imp >= 3 ? "不会淡忘" : undefined }, "★".repeat(imp)) : null,
					h("span", { title: origin }, m.source ?? ""),
					h("span", { title: vec[1], style: { display: "inline-flex" } }, Dot(vec[0])),
					IconButton("edit", "修改", () => setEdit({ content: m.content, importance: imp, kind: m.kind })),
					IconButton("close", "删除", forget)));
		}

		// ── 人物：关系 / 称呼 / 印象 ──
		function PersonCard({ ownerId, ui, api, notify, onChanged }) {
			const { h, Row, Group, Input, Select, Area, Button, Tag, Muted, Empty, Item } = ui;
			const [data, load] = usePoll(api, `/inspector/person?ownerId=${encodeURIComponent(ownerId)}`, 0);
			const [form, setForm] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			react.useEffect(() => { setForm(null); }, [ownerId]);
			react.useEffect(() => {
				if (data?.ok && form === null) setForm({ displayName: data.person.displayName, profile: data.profile?.text ?? "" });
			}, [data, form]);
			if (!data) return null;
			if (!data.ok) return Empty(data.error ?? "读不到这个人");
			const p = data.person;
			const prof = data.profile;
			async function save(patch, okText) {
				setBusy(true);
				const r = await api("POST", "/inspector/person", { ownerId, ...patch });
				setBusy(false);
				if (r?.ok) { notify(okText); await load(); onChanged(); } else notify(r?.error ?? "保存失败");
			}
			async function dream() {
				setBusy(true);
				const r = await api("POST", "/inspector/dream", { ownerId });
				setBusy(false);
				if (r?.ok) { notify(r.profile ? "整理完了" : "整理完了（模型没给印象）"); setForm(null); await load(); onChanged(); } else notify(r?.error ?? "整理失败");
			}
			async function restore(id) {
				const r = await api("POST", "/inspector/memory-restore", { id });
				if (r?.ok) { notify(`已恢复 #${id}`); await load(); onChanged(); } else notify(r?.error ?? "恢复失败");
			}
			const ids = [p.qqUin && `QQ ${p.qqUin}`, p.biliUid && `B站 ${p.biliUid}`, p.douyinName && `抖音 ${p.douyinName}`].filter(Boolean).join(" · ");
			const dirty = form !== null && form.profile !== (prof?.text ?? "");
			return h(react.Fragment, null,
				Group({ title: p.displayName, aside: Muted(`${ids}${ids ? " · " : ""}互动 ${p.interactionCount} 次 · ${fmtDay(p.firstSeenAt)} 认识`) },
					form ? Row({ title: "称呼" }, Input({ value: form.displayName, "aria-label": "称呼", onChange: (e) => setForm({ ...form, displayName: e.target.value }),
						onBlur: () => { if (form.displayName.trim() && form.displayName !== p.displayName) save({ displayName: form.displayName }, "已改称呼"); } })) : null,
					Row({ title: "关系" }, Select({ value: p.relationStage, disabled: busy, "aria-label": "关系", onChange: (e) => save({ relationStage: e.target.value }, `关系改成「${stageLabel(e.target.value)}」`) },
						...STAGES.map(([k, v]) => h("option", { key: k, value: k }, v)))),
					form ? Row({ title: "印象", stack: true },
						Area({ value: form.profile, rows: 3, placeholder: "还没有印象：聊得多了 Dream 会写，也可以自己写", "aria-label": "印象", onChange: (e) => setForm({ ...form, profile: e.target.value }) }),
						prof ? Tag(prof.locked ? "手动写的（Dream 不改）" : "Dream 写的", prof.locked ? "info" : "outline") : null,
						h("span", { className: "fs-fill-gap" }),
						prof?.locked ? Button({ variant: "ghost", disabled: busy, onClick: () => save({ profileLocked: false }, "交还给 Dream 了") }, "交给 Dream") : null,
						Button({ variant: "ghost", disabled: busy, onClick: dream }, "现在整理一次"),
						Button({ variant: "primary", disabled: busy || !dirty, onClick: () => save({ profile: form.profile }, "印象已保存") }, "保存")) : null),
				(data.outdated ?? []).length === 0 ? null : Group({ title: "改掉 / 过时的", aside: Tag(String(data.outdated.length), "outline") },
					h("div", { className: "fs-list" }, data.outdated.map((m) => Item({
						key: m.id, lead: Tag(m.status === "outdated" ? "过时" : m.status === "superseded" ? "改掉" : "删了", "outline"),
						text: m.content, title: `${m.content}\n${m.evidence || m.source}`,
						meta: [h("button", { key: "r", type: "button", className: "fs-btn ghost", onClick: () => restore(m.id) }, "恢复")]
					})))));
		}

		// ── 导入聊天记录 / 备份 ──
		function ImportBackup({ ui, api, notify, relTime, onDone }) {
			const { h, Row, Group, Input, Num, Button, Switch, State, Muted, Tag } = ui;
			const [pv, setPv] = react.useState(null);
			const [opts, setOpts] = react.useState(null);
			const [dbPath, setDbPath] = react.useState("");
			const [showDb, setShowDb] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [job, loadJob] = usePoll(api, "/import/history/state", 2000);
			const [bk, loadBk] = usePoll(api, "/backup/state", 0);
			const fileRef = react.useRef(null);
			const running = job?.job?.status === "running";
			const wasRunning = react.useRef(false);
			react.useEffect(() => { if (wasRunning.current && !running) onDone(); wasRunning.current = running; }, [running]);

			async function preview(body) {
				setBusy(true);
				const r = await api("POST", "/import/history/preview", body);
				setBusy(false);
				if (!r?.ok) { notify(r?.error ?? "读不了这个文件"); return; }
				setPv(r);
				setOpts({ self: Object.fromEntries(r.speakers.map((s) => [s.key, s.self])), qq: Object.fromEntries(r.speakers.map((s) => [s.key, s.suggestQq || ""])), maxCalls: r.estimate.calls });
			}
			function pick(e) {
				const f = e.target.files?.[0];
				e.target.value = "";
				if (!f) return;
				if (f.size > 40 * 1024 * 1024) { notify("文件太大（上限 40 MB）"); return; }
				const reader = new FileReader();
				reader.onload = () => preview({ text: String(reader.result ?? ""), fileName: f.name });
				reader.onerror = () => notify("读文件失败");
				reader.readAsText(f);
			}
			async function start() {
				const selfKeys = Object.entries(opts.self).filter(([, v]) => v).map(([k]) => k);
				const mapping = Object.fromEntries(Object.entries(opts.qq).filter(([, v]) => /^\d{5,12}$/.test(String(v).trim())).map(([k, v]) => [k, String(v).trim()]));
				const r = await api("POST", "/import/history/start", { previewId: pv.previewId, selfKeys, mapping, maxCalls: Number(opts.maxCalls) });
				if (r?.ok) { setPv(null); setOpts(null); notify("开始导入（后台慢慢提炼）"); loadJob(); } else notify(r?.error ?? "开始失败");
			}
			async function backupNow() {
				setBusy(true);
				const r = await api("POST", "/backup/now", {});
				setBusy(false);
				if (r?.ok) { notify(`已备份：${r.file}`); loadBk(); } else notify(r?.error ?? "备份失败");
			}
			async function setAuto(v) {
				const r = await api("POST", "/backup/config", { auto: v });
				if (r?.ok) loadBk(); else notify(r?.error ?? "保存失败");
			}
			const j = job?.job;
			const jobState = !j ? null : j.status === "running" ? State("ongoing", `导入中 ${j.done}/${j.total}${j.current ? ` · ${j.current}` : ""} · 新记忆 ${j.inserted}`)
				: j.status === "error" ? State("error", j.errors?.[j.errors.length - 1] ?? "导入失败")
				: State("done", `${j.status === "cancelled" ? "已停止" : "导入完成"}：新记忆 ${j.inserted + (j.direct ?? 0)} 条，重复跳过 ${j.duplicates} 条`, (j.errors ?? []).join("\n") || undefined);
			const FORMAT = { "qq-txt": "QQ 导出", sillytavern: "SillyTavern", "json-messages": "消息 JSON", memories: "记忆 JSON", maibot: "麦麦数据库" };
			const persons = pv ? pv.speakers.filter((s) => !opts.self[s.key]) : [];
			const mapped = persons.filter((s) => /^\d{5,12}$/.test(String(opts.qq[s.key] ?? "").trim())).length;

			return h(react.Fragment, null,
				Group({ title: "导入" },
					Row({ title: "聊天记录 / 记忆" },
						jobState,
						h("input", { ref: fileRef, type: "file", accept: ".txt,.json,.jsonl", style: { display: "none" }, onChange: pick }),
						running ? Button({ variant: "ghost", onClick: async () => { await api("POST", "/import/history/cancel", {}); loadJob(); } }, "停止")
							: Button({ disabled: busy, onClick: () => fileRef.current?.click() }, "选文件"),
						running ? null : Button({ variant: "ghost", disabled: busy, onClick: () => setShowDb(!showDb) }, "麦麦数据库")),
					showDb && !running ? Row({ title: "麦麦数据库路径" },
						Input({ value: dbPath, placeholder: "…/MaiBot/data/MaiBot.db", onChange: (e) => setDbPath(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && dbPath.trim()) preview({ dbPath }); } }),
						Button({ disabled: busy || dbPath.trim() === "", onClick: () => preview({ dbPath }) }, "读取")) : null,
					pv && opts ? h(react.Fragment, null,
						Row({ title: `${FORMAT[pv.format] ?? pv.format} · ${pv.chatCount} 个聊天 · ${pv.messageCount} 条消息${pv.memoryCount ? ` · 现成记忆 ${pv.memoryCount} 条` : ""}` },
							...(pv.warnings ?? []).map((w, i) => Tag(w, "warning", { key: i }))),
						pv.speakers.length > 0 ? h("div", { className: "fs-list" }, pv.speakers.slice(0, 40).map((s) => h("div", { className: "fs-item", key: s.key },
							h("label", { className: "fs-check", title: "勾上 = 这是她自己说的话" },
								h("input", { type: "checkbox", checked: opts.self[s.key] === true, onChange: (e) => setOpts({ ...opts, self: { ...opts.self, [s.key]: e.target.checked } }) }), "是她"),
							h("span", { className: "fs-item-main", title: s.chats.join("、") }, s.name),
							h("span", { className: "fs-item-meta" },
								s.existing ? Tag(`已认识 · ${stageLabel(s.existing.relationStage)}`, "success") : null,
								h("span", null, `${s.count} 条`),
								opts.self[s.key] ? null : Input({ value: opts.qq[s.key] ?? "", placeholder: "QQ 号", inputMode: "numeric", "aria-label": `${s.name} 的 QQ 号`, style: { flex: "0 0 120px", width: "120px" },
									onChange: (e) => setOpts({ ...opts, qq: { ...opts.qq, [s.key]: e.target.value } }) }))))) : null,
						Row({ title: "最多调用模型", desc: pv.memoryCount && !pv.messageCount ? undefined : `${mapped} 个人能导入；没填 QQ 号的人跳过` },
							Num({ min: 0, max: 500, value: opts.maxCalls, "aria-label": "最多调用模型", onChange: (e) => setOpts({ ...opts, maxCalls: e.target.value }) }), Muted("次"),
							Button({ variant: "ghost", onClick: () => { setPv(null); setOpts(null); } }, "取消"),
							Button({ variant: "primary", disabled: running || (mapped === 0 && !pv.memoryCount), onClick: start }, "开始导入"))) : null),
				Group({ title: "备份" },
					Row({ title: "每天自动备份" }, bk?.lastAt ? Muted(`上次 ${relTime(bk.lastAt, Date.now())}`) : null, h(Switch, { label: "每天自动备份", checked: bk?.auto !== false, onChange: setAuto })),
					Row({ title: "备份", desc: bk?.dir ? `${bk.dir}（恢复：关掉 DSH，把备份改名成 soul.db 放回上一级目录）` : undefined },
						Button({ disabled: busy, onClick: backupNow }, "立刻备份"),
						h("a", { className: "fs-btn ghost", href: "/api/plugins/fish-soul/export/memories", download: "" }, "导出记忆"))));
		}

		// ── 记忆检视 ──
		function InspectorPane(props) {
			const { api, notify, ui } = props;
			const { h, Tag, Empty, Item, Muted, Group, Input, Button } = ui;
			const [owner, setOwner] = react.useState("all");
			const [data, load] = usePoll(api, `/inspector/overview${owner !== "all" ? `?ownerId=${encodeURIComponent(owner)}` : ""}`, 0);
			const [adding, setAdding] = react.useState("");
			if (!data) return null;
			const persons = data.persons ?? [];
			const memories = data.memories ?? [];
			const pendings = data.pendings ?? [];
			const pill = (ownerId, label, title) => h("button", { type: "button", key: ownerId, className: "fs-pill", "aria-pressed": owner === ownerId, title, onClick: () => setOwner(ownerId) }, label);
			async function add() {
				const r = await api("POST", "/inspector/memory-add", { ownerId: owner, content: adding, importance: 3 });
				if (r?.ok) { setAdding(""); notify("已记下"); load(); } else notify(r?.error ?? "添加失败");
			}
			return h(react.Fragment, null,
				h("section", { className: "fs-group" },
					h("div", { className: "fs-group-head" },
						h("div", { className: "fs-pills", role: "group", "aria-label": "按人筛选" }, pill("all", "全部"),
							...persons.map((p) => pill(p.ownerId, p.ownerId === "self" ? "她自己" : p.displayName, p.ownerId === "self" ? undefined : `${stageLabel(p.relationStage)} · ${p.memoryCount} 条`))),
						Tag(String(memories.length), "outline"))),
				owner !== "all" && owner !== "self" ? h(PersonCard, { key: owner, ownerId: owner, ui, api, notify, onChanged: load }) : null,
				Group({ title: owner === "all" ? "最近的记忆" : "记忆" },
					owner !== "all" ? h("div", { className: "fs-row" },
						Input({ value: adding, className: "wide", placeholder: "手动记一条（比如：她不吃香菜）", onChange: (e) => setAdding(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && adding.trim()) add(); } }),
						Button({ disabled: adding.trim() === "", onClick: add }, "记下")) : null,
					h("div", { className: "fs-list" }, memories.length === 0 ? Empty("还没有记忆")
						: memories.map((m) => h(MemoryItem, { key: m.id, m, ui, api, notify, refresh: load, curGen: data.currentGenerationId ?? 1 })))),
				pendings.length === 0 ? null : Group({ title: "待办", aside: Tag(String(pendings.length), "outline") },
					h("div", { className: "fs-list" }, pendings.map((p) => Item({ key: p.id, lead: Muted(props.fmtDueAt(p.dueAt), { className: "fs-unit num" }), text: p.reason, meta: [p.channelId ?? ""] })))),
				h(ImportBackup, { ui, api, notify, relTime: props.relTime, onDone: load }));
		}

		// ── 动态：为什么回 / 为什么没回 / 想起了什么 ──
		const KINDS = {
			reply: ["要回", "info"], interject: ["插话", "info"], sent: ["已发", "success"], silent: ["没说", "outline"],
			memorize: ["只记", "outline"], paused: ["暂停", "warning"], resumed: ["恢复", "success"], failed: ["失败", "danger"],
			recalled: ["撤回", "outline"], command: ["命令", "info"], proactive: ["主动", "info"]
		};
		function ActivityPane({ api, notify, relTime, ui }) {
			const { h, Group, Tag, Empty, Button, Muted } = ui;
			const [data, load] = usePoll(api, "/activity", 3000);
			if (!data) return null;
			const now = Date.now();
			async function resume(channelId) {
				const r = await api("POST", "/sessions/pause", { channelId, minutes: 0 });
				if (r?.ok) { notify("已恢复"); load(); } else notify(r?.error ?? "恢复失败");
			}
			const decisions = data.decisions ?? [];
			return h(react.Fragment, null,
				(data.paused ?? []).length === 0 ? null : Group({ title: "暂停中" },
					h("div", { className: "fs-list" }, data.paused.map((p) => h("div", { className: "fs-item", key: p.channelId },
						h("span", { className: "fs-item-main" }, p.title),
						h("span", { className: "fs-item-meta" }, h("span", null, p.until ? `到 ${fmtClock(p.until)}` : "一直"),
							Button({ variant: "ghost", onClick: () => resume(p.channelId) }, "恢复")))))),
				Group({ title: "最近", aside: Tag(String(decisions.length), "outline") },
					h("div", { className: "fs-list" }, decisions.length === 0 ? Empty("还没有动静") : decisions.map((d, i) => {
						const [label, tone] = KINDS[d.kind] ?? [d.kind, "outline"];
						const body = d.text ? [d.who && `${d.who}：`, d.text].filter(Boolean).join("") : d.who;
						const tip = [d.title, body, d.reason, d.memories?.length ? `想起了：\n${d.memories.join("\n")}` : ""].filter(Boolean).join("\n");
						return h("div", { className: "fs-item", key: `${d.at}-${i}`, title: tip },
							Tag(label, tone),
							h("span", { className: "fs-item-main" }, h("b", { className: "fs-strong" }, d.title), body ? ` ${body}` : ""),
							h("span", { className: "fs-item-meta" },
								d.reason ? h("span", null, d.reason) : null,
								d.memories?.length ? h("span", null, `想起 ${d.memories.length} 条`) : null,
								h("span", null, relTime(d.at, now))));
					}))),
				(data.dreamLog ?? []).length === 0 ? null : Group({ title: "整理记录" },
					h("div", { className: "fs-list" }, data.dreamLog.map((x, i) => h("div", { className: "fs-item", key: i, title: (x.outdated ?? []).map((o) => `#${o.id}「${o.content}」→ 被 #${o.by} 推翻：${o.reason}`).join("\n") || undefined },
						h("span", { className: "fs-item-main" }, `${x.name}：${[x.profile ? "更新了印象" : "", x.outdated?.length ? `${x.outdated.length} 条记忆判为过时` : ""].filter(Boolean).join("，")}`),
						h("span", { className: "fs-item-meta" }, Muted(relTime(x.at, now))))))));
		}

		return { InspectorPane, ActivityPane };
	}
});
