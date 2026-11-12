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
		const KIND = { fact: "事实", event: "事件", feeling: "感受", episode: "聊过", diary: "日记", weekly: "周记" };
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
		function MemoryItem({ m, ui, api, notify, refresh, curGen, selectable, selected, onSelect }) {
			const { h, Tag, Dot, IconButton, Area, Num, Select, Button } = ui;
			const [edit, setEdit] = react.useState(null);
			const [sources, setSources] = react.useState(null);
			const imp = m.importance ?? 1;
			const vec = m.vecGenerationId == null ? ["idle", "待向量化"] : m.vecGenerationId === curGen ? ["done", "已向量化"] : ["warning", "向量过期"];
			const origin = `出处：${m.source ?? ""}${m.evidence ? ` · ${m.evidence}` : ""}`;
			async function forget() {
				const r = await api("POST", "/inspector/forget", { targetType: "memory", id: m.id });
				if (r?.ok) { notify(`已删除 #${m.id}（能在下面"改掉 / 过时的"里恢复）`); refresh(); } else notify(r?.error ?? "删除失败");
			}
			async function toggleImportanceLock() {
				const r = await api("POST", "/inspector/importance-lock", { id: m.id, locked: !m.importanceLocked });
				if (r?.ok) { notify(m.importanceLocked ? "已允许自动提升" : "重要度已锁定"); refresh(); } else notify(r?.error ?? "设置失败");
			}
			async function save() {
				const importanceChanged = Number(edit.importance) !== (m.importance ?? 1);
			const r = await api("POST", "/inspector/memory-edit", { id: m.id, content: edit.content, kind: edit.kind, ...(importanceChanged ? { importance: Number(edit.importance) } : {}) });
				if (r?.ok) { setEdit(null); notify(r.replaced ? "已改（旧的留档了）" : "已保存"); refresh(); } else notify(r?.error ?? "保存失败");
			}
			if (edit !== null) {
				return h("div", { className: "fs-item edit" },
					Area({ value: edit.content, rows: 2, "aria-label": "记忆内容", onChange: (e) => setEdit({ ...edit, content: e.target.value }) }),
					h("div", { className: "fs-ctl" },
						Select({ value: edit.kind, "aria-label": "类型", onChange: (e) => setEdit({ ...edit, kind: e.target.value }) },
							...Object.entries(KIND).filter(([k]) => k !== "weekly" && k !== "diary").map(([k, v]) => h("option", { key: k, value: k }, v))),
						h("span", { className: "fs-unit" }, "重要度"),
						Num({ min: 1, max: 5, value: edit.importance, "aria-label": "重要度", onChange: (e) => setEdit({ ...edit, importance: e.target.value }) }),
						h("span", { className: "fs-fill-gap" }),
						Button({ variant: "ghost", onClick: () => setEdit(null) }, "取消"),
						Button({ variant: "primary", onClick: save, disabled: String(edit.content).trim() === "" }, "保存")),
					h("span", { className: "fs-item-sub" }, origin));
			}
			return h(react.Fragment, null, h("div", { className: "fs-item" },
				selectable ? h(ui.Check, { checked: selected === true, label: `选中 #${m.id}`, hideLabel: true, onChange: (v) => onSelect(m.id, v) }) : null,
				Tag(KIND[m.kind] ?? m.kind),
				h("span", { className: "fs-item-main", title: `${m.content}\n${origin}` }, m.content),
				h("span", { className: "fs-item-meta" },
					m.importanceAutoRecalled ? Tag("召回提升", "outline") : null,
					Button({ variant: "ghost", onClick: toggleImportanceLock, "aria-label": m.importanceLocked ? `解锁 #${m.id} 的重要度` : `锁定 #${m.id} 的重要度` }, m.importanceLocked ? "已锁定" : "锁定"),
					m.visibility === "private" ? Tag("私密", "warning", { title: "私聊里说的，群里不会提" }) : null,
					m.about ? Tag(`关于 ${m.aboutName ?? m.about.replace(/^user:/, "")}`, "outline") : null,
					imp >= 2 ? h("span", { title: imp >= 3 ? "不会淡忘" : undefined }, "★".repeat(imp)) : null,
					h("span", { title: origin }, m.source ?? ""),
					h("span", { title: vec[1], style: { display: "inline-flex" } }, Dot(vec[0])),
					m.kind === "weekly" ? Button({ variant: "ghost", onClick: async () => { if (sources) { setSources(null); return; } const r = await api("GET", `/memory/weekly/sources?summaryId=${m.id}`); if (r?.ok) setSources(r.sources); else notify(r?.error ?? "来源读取失败"); } }, sources ? "收起来源" : "查看来源") : IconButton("edit", "修改", () => setEdit({ content: m.content, importance: imp, kind: m.kind })),
					IconButton("close", "删除", forget))),
				sources ? h("div", { className: "fs-item-sub" }, ...sources.map((x) => h("div", { key: x.id }, `#${x.id} · ${x.content}`))) : null);
		}

		// ── 人物：关系 / 称呼 / 印象 ──
		function PersonCard({ ownerId, ui, api, notify, onChanged }) {
			const { h, Row, Group, Input, Select, Area, Button, Tag, Muted, Empty, Item, useConfirm } = ui;
			const [confirm, confirmNode] = useConfirm();
			const [data, load] = usePoll(api, `/inspector/person?ownerId=${encodeURIComponent(ownerId)}`, 0);
			const [form, setForm] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			react.useEffect(() => { setForm(null); }, [ownerId]);
			react.useEffect(() => {
				if (data?.ok && form === null) setForm({ displayName: data.person.displayName, profile: data.profile?.text ?? "", fields: { ...(data.profileFields ?? {}) } });
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
			async function forgetAll() {
				const dry = await api("POST", "/inspector/bulk", { filter: { ownerId }, action: "forget", dryRun: true });
				if (!dry?.ok) { notify(dry?.error ?? "操作失败"); return; }
				if (dry.matched === 0) { notify("没有要删的记忆"); return; }
				if (!(await confirm({ title: `清空 ${p.displayName} 的记忆`, description: `删掉这个人的全部 ${dry.matched} 条记忆？（能在下面「改掉 / 过时的」里恢复）`, danger: true }))) return;
				const r = await api("POST", "/inspector/bulk", { filter: { ownerId }, action: "forget" });
				if (r?.ok) { notify(`已删除 ${r.changed} 条记忆`); await load(); onChanged(); } else notify(r?.error ?? "删除失败");
			}
			const ids = [p.qqUin && `QQ ${p.qqUin}`, p.biliUid && `B站 ${p.biliUid}`, p.douyinName && `抖音 ${p.douyinName}`].filter(Boolean).join(" · ");
			const dirty = form !== null && form.profile !== (prof?.text ?? "");
			const fieldsSaved = data.profileFields ?? {};
			const lockedF = new Set(data.lockedFields ?? []);
			const legacy = prof && Object.keys(fieldsSaved).length === 0;
			const saveField = (id) => { const v = (form.fields[id] ?? "").trim(); if (v !== (fieldsSaved[id] ?? "")) save({ profileFields: { [id]: v } }, v ? "已保存（这栏 Dream 不再改）" : "已清空（交还给 Dream）"); };
			const mood = data.mood;
			return h(react.Fragment, null,
				Group({ title: p.displayName, aside: Muted(`${ids}${ids ? " · " : ""}互动 ${p.interactionCount} 次 · ${fmtDay(p.firstSeenAt)} 认识`) },
					form ? Row({ title: "名字", desc: "她心里怎么叫这个人（群里署名也用它）" }, Input({ value: form.displayName, "aria-label": "名字", onChange: (e) => setForm({ ...form, displayName: e.target.value }),
						onBlur: () => { if (form.displayName.trim() && form.displayName !== p.displayName) save({ displayName: form.displayName }, "已改名字"); } })) : null,
					Row({ title: "关系", desc: p.stageLocked ? "手动定的，不随好感自动升降" : "按好感自动升降" },
						p.stageLocked && p.canonicalId !== "master" ? Button({ variant: "ghost", disabled: busy, onClick: () => save({ stageLocked: false }, "关系交还给好感了") }, "改回自动") : null,
						Select({ value: p.relationStage, disabled: busy, "aria-label": "关系", onChange: (e) => save({ relationStage: e.target.value }, `关系改成「${stageLabel(e.target.value)}」`) },
						...STAGES.map(([k, v]) => h("option", { key: k, value: k }, v)))),
					Row({ title: "好感", meta: mood ? `她现在有点${mood.label}${mood.reason ? `（${mood.reason}）` : ""}` : undefined },
						h("div", { className: "fs-track", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": p.affinity ?? 0, "aria-label": "好感" },
							h("div", { className: "fs-fill", style: { width: `${Math.max(0, Math.min(100, p.affinity ?? 0))}%` } })),
						Muted(String(Math.round(p.affinity ?? 0)), { className: "fs-unit num" })),
					form ? (data.fieldDefs ?? []).map((f) => h(react.Fragment, { key: f.id }, Row({ title: f.label },
						lockedF.has(f.id) ? Tag("手写", "info", { title: "主人写的，Dream 不改；清空就交还" }) : null,
						Input({ value: form.fields[f.id] ?? "", placeholder: "还不知道", "aria-label": f.label, disabled: busy,
							onChange: (e) => setForm({ ...form, fields: { ...form.fields, [f.id]: e.target.value } }), onBlur: () => saveField(f.id) })))) : null,
					form && !legacy ? Row({ title: "印象", meta: prof ? `${prof.by === "user" ? "改过" : "Dream 整理"} · ${fmtDay(prof.updatedAt)}` : undefined },
						Button({ variant: "ghost", disabled: busy, onClick: dream }, "现在整理一次")) : null,
					form && legacy ? Row({ title: "印象", stack: true },
						Area({ value: form.profile, rows: 3, placeholder: "还没有印象：聊得多了 Dream 会写，也可以自己写", "aria-label": "印象", onChange: (e) => setForm({ ...form, profile: e.target.value }) }),
						prof ? Tag(prof.locked ? "手动写的（Dream 不改）" : "Dream 写的", prof.locked ? "info" : "outline") : null,
						h("span", { className: "fs-fill-gap" }),
						prof?.locked ? Button({ variant: "ghost", disabled: busy, onClick: () => save({ profileLocked: false }, "交还给 Dream 了") }, "交给 Dream") : null,
						Button({ variant: "ghost", disabled: busy, onClick: dream }, "现在整理一次"),
						Button({ variant: "primary", disabled: busy || !dirty, onClick: () => save({ profile: form.profile }, "印象已保存") }, "保存")) : null,
				p.canonicalId !== "master" && p.canonicalId !== "self" ? Row({ title: "清空记忆", desc: "删掉这个人的全部记忆（人还在，之后还能聊）" },
					Button({ variant: "ghost", disabled: busy, onClick: forgetAll }, "全部删掉")) : null,
				// #68：删除整个人物卡（不只是清空记忆——人本身从记忆区里消失）
				p.canonicalId !== "master" && p.canonicalId !== "self" ? Row({ title: "删除这个人", desc: "把这张人物卡整个删掉（记忆可在「改掉 / 过时的」里恢复，人物卡不可恢复）" },
					Button({ variant: "outline", disabled: busy, onClick: async () => {
						if (!(await confirm({ title: `删除「${p.displayName}」这张人物卡？`, description: `这个人在记忆区里的卡片会消失，\n所有记忆标为已删（可恢复）、待办丢弃、心情印象清空。\n人物卡本身不可恢复。`, danger: true }))) return;
						setBusy(true);
						const r = await api("POST", "/inspector/person/delete", { ownerId });
						setBusy(false);
						if (r?.ok) { notify("已删除这个人物卡"); onChanged(); } else notify(r?.error ?? "删除失败");
					} }, "删除这张卡")) : null),
				(data.episodes ?? []).length === 0 ? null : Group({ title: "最近聊过" },
					h("div", { className: "fs-list" }, data.episodes.map((x) => Item({ key: x.id, text: x.content, meta: [h("span", { key: "t" }, fmtDay(x.at))] })))),
			(data.outdated ?? []).length === 0 ? null : Group({ title: "改掉 / 过时的", aside: Tag(String(data.outdated.length), "outline") },
				h("div", { className: "fs-list" }, data.outdated.map((m) => Item({
					key: m.id, lead: Tag(m.status === "outdated" ? "过时" : m.status === "superseded" ? "改掉" : "删了", "outline"),
					text: m.content, title: `${m.content}\n${m.evidence || m.source}`,
					meta: [Button({ key: "r", variant: "ghost", onClick: () => restore(m.id) }, "恢复")]
				})))), confirmNode) // #82：confirm() 的对话框要挂进这棵树，否则点「删除这张卡」只是 pending 了、界面什么都不出;
	}

		// ── 导入聊天记录 / 备份 ──
		function ImportBackup({ ui, api, notify, relTime, onDone }) {
			const { h, Row, Group, Input, Num, Button, Switch, State, Muted, Tag, useConfirm } = ui;
			const [pv, setPv] = react.useState(null);
			const [opts, setOpts] = react.useState(null);
			const [dbPath, setDbPath] = react.useState("");
			const [showDb, setShowDb] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [confirm, confirmNode] = useConfirm();
			const [job, loadJob] = usePoll(api, "/import/history/state", 2000);
			const [bk, loadBk] = usePoll(api, "/backup/state", 0);
			const fileRef = react.useRef(null);
			const [mx, setMx] = react.useState(null);
			const [mxOpts, setMxOpts] = react.useState({ emojis: true, expressions: true, jargons: true, maxEmojis: 30 });
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
			async function previewExtras() {
				setBusy(true);
				const r = await api("POST", "/import/maibot-extras/preview", { dbPath });
				setBusy(false);
				if (r?.ok) setMx(r); else notify(r?.error ?? "读不了这个数据库");
			}
			async function applyExtras() {
				setBusy(true);
				const r = await api("POST", "/import/maibot-extras/apply", { dbPath, ...mxOpts, maxEmojis: Number(mxOpts.maxEmojis) });
				setBusy(false);
				if (!r?.ok) { notify(r?.error ?? "导入失败"); return; }
				setMx(null);
				notify(`导入了 ${r.emojis} 张表情、${r.expressions} 种说话方式、${r.terms} 个梗` + (r.emojiDup ? `（${r.emojiDup} 张已经有了）` : "") + ((r.warnings ?? []).length ? `；${r.warnings.join("；")}` : ""));
			}
			async function backupNow() {
				setBusy(true);
				const r = await api("POST", "/backup/now", {});
				setBusy(false);
				if (r?.ok) { notify(`已备份：${r.file}`); loadBk(); } else notify(r?.error ?? "备份失败");
			}
			async function restore(f) {
				if (!(await confirm({ title: "恢复备份", description: `恢复到 ${f.file}？\n重启 DSH 后生效：现在的库会先另存成 pre-restore-….db，恢复错了还能换回来。\n这份备份之后新记的东西会回到这份备份的样子。`, danger: true }))) return;
				const r = await api("POST", "/backup/restore", { file: f.file });
				if (r?.ok) { notify(`已选好（${r.pending.memories} 条记忆），重启 DSH 后换上`); loadBk(); } else notify(r?.error ?? "这份备份用不了");
			}
			async function cancelRestore() {
				const r = await api("POST", "/backup/restore-cancel", {});
				if (r?.ok) { notify("不恢复了"); loadBk(); } else notify(r?.error ?? "操作失败");
			}
			async function setAuto(v) {
				const r = await api("POST", "/backup/config", { auto: v });
				if (r?.ok) loadBk(); else notify(r?.error ?? "保存失败");
			}
			async function resume() {
				const r = await api("POST", "/import/history/resume", { id: j.id });
				if (r?.ok) { notify(`从第 ${r.job.done + 1} 段接着导`); loadJob(); } else notify(r?.error ?? "继续失败");
			}
			async function discard() {
				const r = await api("POST", "/import/history/discard", { id: j.id });
				if (r?.ok) { notify("不再提示继续（已经导进去的记忆还在）"); loadJob(); } else notify(r?.error ?? "操作失败");
			}
			const j = job?.job;
			const jobState = !j ? null : j.status === "running" ? State("ongoing", `导入中 ${j.done}/${j.total}${j.current ? ` · ${j.current}` : ""} · 新记忆 ${j.inserted}`)
				: j.resumable ? State("warning", `${j.status === "interrupted" ? "上次没导完（DSH 重启了）" : j.status === "cancelled" ? "停在一半" : "出错停了"}：${j.done}/${j.total} 段 · 新记忆 ${j.inserted}`, (j.errors ?? []).slice(-5).join("\n") || undefined)
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
						!running && j?.resumable ? Button({ variant: "primary", disabled: busy, onClick: resume, title: j.fileName }, "继续") : null,
						!running && j?.resumable ? Button({ variant: "ghost", disabled: busy, onClick: discard }, "放弃") : null,
						running ? null : Button({ variant: "ghost", disabled: busy, onClick: () => setShowDb(!showDb) }, "麦麦数据库")),
					showDb && !running ? Row({ title: "麦麦数据库路径" },
						Input({ value: dbPath, placeholder: "…/MaiBot/data/MaiBot.db", onChange: (e) => setDbPath(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && dbPath.trim()) preview({ dbPath }); } }),
						Button({ disabled: busy || dbPath.trim() === "", onClick: () => preview({ dbPath }) }, "读聊天记录"),
						Button({ variant: "ghost", disabled: busy || dbPath.trim() === "", onClick: previewExtras, title: "表情包 → _stickers；表达方式 / 黑话 → 学到的说法" }, "读表情和说法")) : null,
					mx && showDb && !running ? h(react.Fragment, null,
						Row({ title: `表情包 ${mx.emojis.count} 张`, meta: mx.emojis.sample.length ? `比如：${mx.emojis.sample.join("、")}。按麦麦里用得多的挑；她每轮只看得到 _stickers 里前 40 张` : "没找到能用的表情（被禁用 / 未注册 / 图片文件不在的跳过）" },
							Num({ min: 0, max: 100, value: mxOpts.maxEmojis, "aria-label": "最多导入几张", onChange: (e) => setMxOpts({ ...mxOpts, maxEmojis: e.target.value }) }), Muted("张"),
							h(Switch, { label: "导入表情包", checked: mxOpts.emojis && mx.emojis.count > 0, disabled: mx.emojis.count === 0, onChange: (v) => setMxOpts({ ...mxOpts, emojis: v }) })),
						Row({ title: `表达方式 ${mx.expressions.count} 条`, meta: mx.expressions.sample.join("；") || undefined },
							h(Switch, { label: "导入表达方式", checked: mxOpts.expressions && mx.expressions.count > 0, disabled: mx.expressions.count === 0, onChange: (v) => setMxOpts({ ...mxOpts, expressions: v }) })),
						Row({ title: `黑话 ${mx.jargons.count} 个`, meta: mx.jargons.sample.join("；") || undefined },
							h(Switch, { label: "导入黑话", checked: mxOpts.jargons && mx.jargons.count > 0, disabled: mx.jargons.count === 0, onChange: (v) => setMxOpts({ ...mxOpts, jargons: v }) })),
						Row({ title: "分到这些聊天", meta: mx.chats.map((c) => `${c.title}（${c.expressions} / ${c.jargons}）`).join("、") + "。每个聊天最多留 60 种说话方式、40 个梗，按次数留" },
							...(mx.warnings ?? []).map((w, i) => Tag(w, "warning", { key: i })),
							Button({ variant: "ghost", onClick: () => setMx(null) }, "取消"),
							Button({ variant: "primary", disabled: busy, onClick: applyExtras }, "导入"))) : null,
					pv && opts ? h(react.Fragment, null,
						Row({ title: `${FORMAT[pv.format] ?? pv.format} · ${pv.chatCount} 个聊天 · ${pv.messageCount} 条消息${pv.memoryCount ? ` · 现成记忆 ${pv.memoryCount} 条` : ""}` },
							...(pv.warnings ?? []).map((w, i) => Tag(w, "warning", { key: i }))),
						pv.speakers.length > 0 ? h("div", { className: "fs-list" }, pv.speakers.slice(0, 40).map((s) => h("div", { className: "fs-item", key: s.key },
							h(ui.Check, { checked: opts.self[s.key] === true, label: "是她", title: "勾上 = 这是她自己说的话", onChange: (v) => setOpts({ ...opts, self: { ...opts.self, [s.key]: v } }) }),
							h("span", { className: "fs-item-main", title: s.chats.join("、") }, s.name),
							h("span", { className: "fs-item-meta" },
								s.existing ? Tag(`已认识 · ${stageLabel(s.existing.relationStage)}`, "success") : null,
								h("span", null, `${s.count} 条`),
								opts.self[s.key] ? null : Input({ value: opts.qq[s.key] ?? "", placeholder: "QQ 号", inputMode: "numeric", "aria-label": `${s.name} 的 QQ 号`, style: { flex: "0 0 120px", width: "120px" },
									onChange: (e) => setOpts({ ...opts, qq: { ...opts.qq, [s.key]: e.target.value } }) }))))) : null,
						pv.coverage && pv.coverage.droppedChunks > 0 ? Row({
							title: `${pv.coverage.truncatedPersons} 个人的较早聊天按时间段总结`,
							meta: `每人最近 ${pv.coverage.chunksPerPerson} 段（每段约 ${pv.coverage.chunkChars} 字）逐段提炼；更早的 ${pv.coverage.droppedChunks} 段、约 ${Math.round(pv.coverage.droppedChars / 1000) / 10} 万字` +
								(pv.coverage.droppedFromMs ? `（最早到 ${new Date(pv.coverage.droppedFromMs).toLocaleDateString()}）` : "") +
								`压成 ${pv.coverage.eraChunks ?? 0} 个时间段总结（每人最多 ${pv.coverage.maxEras ?? 4} 段，聊天太多时只看抽样，细节会丢）。` +
								(pv.coverage.topTruncated ?? []).map((t) => `${t.name}：${t.droppedChunks} 段压成总结${t.keptFromMs ? `，${new Date(t.keptFromMs).toLocaleDateString()} 之后逐段` : ""}`).join("；")
						}, Tag("早期压缩", "warning")) : null,
						pv.coverage && Number(opts.maxCalls) < pv.coverage.keptChunks ? Row({
							title: `调用上限 ${opts.maxCalls} 次，还有 ${pv.coverage.keptChunks - Number(opts.maxCalls)} 段会跳过`,
							meta: `要全部导入需要 ${pv.coverage.keptChunks} 次（最多 500）；不够时每人从最近的往前轮流分，时间段总结最先砍`
						}, Tag("额度不够", "warning")) : null,
						Row({ title: "最多调用模型", meta: pv.memoryCount && !pv.messageCount ? undefined : `${mapped} 个人能导入；没填 QQ 号的人跳过` },
							Num({ min: 0, max: 500, value: opts.maxCalls, "aria-label": "最多调用模型", onChange: (e) => setOpts({ ...opts, maxCalls: e.target.value }) }), Muted("次"),
							Button({ variant: "ghost", onClick: () => { setPv(null); setOpts(null); } }, "取消"),
							Button({ variant: "primary", disabled: running || (mapped === 0 && !pv.memoryCount), onClick: start }, "开始导入"))) : null),
				Group({ title: "备份" },
					Row({ title: "每天自动备份" }, bk?.lastAt ? Muted(`上次 ${relTime(bk.lastAt, Date.now())}`) : null, h(Switch, { label: "每天自动备份", checked: bk?.auto !== false, onChange: setAuto })),
					Row({ title: "备份", meta: bk?.dir ? `${bk.dir}（每天一份，留最近 ${bk.keep ?? 7} 份）` : undefined },
						Button({ disabled: busy, onClick: backupNow }, "立刻备份"),
						h("a", { className: "fs-btn ghost", href: "/api/plugins/fish-soul/export/memories", download: "" }, "导出记忆")),
					bk?.pendingRestore ? Row({ title: `重启 DSH 后恢复到 ${bk.pendingRestore.file}`, meta: `这份有 ${bk.pendingRestore.memories} 条记忆、${bk.pendingRestore.persons} 个人；现在的库会先另存` },
						Tag("等重启", "warning"), Button({ variant: "ghost", onClick: cancelRestore }, "不恢复了")) : null,
					bk?.lastRestored ? Row({ title: `上次从 ${bk.lastRestored.file} 恢复`, meta: bk.lastRestored.safety ? `恢复前的库另存为 ${bk.lastRestored.safety}，恢复错了可以在下面换回去` : undefined }, Muted(relTime(bk.lastRestored.at, Date.now()))) : null,
					[...(bk?.list ?? []), ...(bk?.preRestore ?? [])].length > 0 ? h("div", { className: "fs-list" }, [...(bk?.list ?? []), ...(bk?.preRestore ?? [])].map((f) => h("div", { className: "fs-item", key: f.file },
						f.preRestore ? Tag("恢复前另存", "outline") : null,
						h("span", { className: "fs-item-main" }, f.file),
						h("span", { className: "fs-item-meta" },
							Muted(`${Math.max(1, Math.round(f.size / 1024))} KB · ${relTime(f.at, Date.now())}`),
							bk?.pendingRestore?.file === f.file ? Tag("等重启", "warning") : Button({ variant: "ghost", disabled: busy, onClick: () => restore(f) }, "恢复到这份"))))) : null),
				confirmNode);
		}

		// ── 记忆调试器：输一句话，看她会想起哪几条、为什么没想起别的 ──
		function MemoryDebug({ ownerId, ui, api, notify }) {
			const { h, Group, Input, Button, Switch, Tag, Empty, Muted } = ui;
			const [text, setText] = react.useState("");
			const [inGroup, setInGroup] = react.useState(false);
			const [res, setRes] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			async function run() {
				setBusy(true);
				const r = await api("POST", "/memory/debug", { ownerId, text, inGroup });
				setBusy(false);
				if (r?.ok) setRes(r); else notify(r?.error ?? "没试成");
			}
			const row = (m, lead, tone) => h("div", { className: "fs-item", key: `${lead}-${m.id}` },
				Tag(lead, tone),
				h("span", { className: "fs-item-main", title: m.content }, m.content),
				h("span", { className: "fs-item-meta" },
					m.score != null ? h("span", { className: "num", title: `原始 ${m.raw} × 新鲜度 ${m.decay} × ${({ recent: "近期", longTerm: "长期", weekly: "周记" })[m.tier] ?? "记忆"} ${m.tierWeight ?? 1}${m.bm25Rank ? ` · 关键词第 ${m.bm25Rank}` : ""}${m.vecRank ? ` · 意思第 ${m.vecRank}` : ""}` }, m.score.toFixed(3)) : null,
					m.when ? h("span", null, m.when) : null,
					Muted(m.why)));
			return Group({ title: "记忆调试", aside: res ? Tag(res.vector ? "关键词 + 意思" : "只有关键词", "outline", { title: res.vector ? "向量检索参与了" : "向量没开或还没算好，只按关键词" }) : null },
				h("div", { className: "fs-dock" },
					Input({ value: text, className: "wide", placeholder: "假如他说……", "aria-label": "记忆调试", onChange: (e) => setText(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && text.trim()) run(); } }),
					h("span", { className: "fs-unit", title: "群里不会想起私聊说的事" }, "群"),
					h(Switch, { label: "在群里", checked: inGroup, onChange: setInGroup }),
					Button({ disabled: busy || text.trim() === "", onClick: run }, busy ? "想…" : "试一下")),
				res === null ? null : h("div", { className: "fs-list" },
					res.recalled.length === 0 ? Empty("什么都想不起来") : res.recalled.map((m) => row(m, `#${m.rank}`, "success")),
					...(res.others ?? []).slice(0, 8).map((m) => row(m, "没想起", "outline")),
					...(res.excluded ?? []).slice(0, 6).map((m) => row(m, "不参与", "warning"))));
		}

		// ── 记忆检视 ──
		function WeeklyPanel({ ui, api, notify, onDone }) {
			const { h, Group, Row, Button, Switch, Muted, useConfirm } = ui;
			const [data, load] = usePoll(api, "/memory/weekly/state", 30000);
			const [busy, setBusy] = react.useState(false);
			const [confirm, confirmNode] = useConfirm();
			if (!data) return null;
			const consent = () => confirm({ title: "生成周记", description: "会把相关记忆（可能包含私密内容）发送给“写日记”使用的模型，模型可能由远程服务提供。原记忆不会删除。继续吗？" });
			async function setAuto(v) {
				if (v && !(await consent())) return;
				setBusy(true); const r = await api("POST", "/memory/weekly/config", { enabled: v }); setBusy(false);
				if (r?.ok) { await load(); notify(v ? "已开启自动周记" : "已关闭自动周记"); } else notify(r?.error ?? "设置失败");
			}
			async function run() {
				if (!(await consent())) return;
				setBusy(true); const r = await api("POST", "/memory/weekly/run", {}); setBusy(false);
				if (r?.ok) { notify(r.empty ? "暂无可整理的记忆" : `已生成周记（${r.count} 条来源）`); await load(); onDone(); } else notify(r?.error ?? "生成失败");
			}
			return h(react.Fragment, null,
				Group({ title: "周记" },
					Row({ title: "自动生成", meta: "按周整理，保留原记忆；使用写日记模型" }, h(Switch, { label: "自动生成周记", checked: data.enabled, disabled: busy, onChange: setAuto })),
					Row({ title: "待整理" }, Muted(`${data.pending} 条`), Button({ disabled: busy || data.running || !data.pending, onClick: run }, busy || data.running ? "生成中" : "生成一批"))),
				confirmNode);
		}

		function StoragePanel({ ui, api, notify }) {
			const { h, Group, Row, Input, Num, Button, Switch, Muted, useConfirm } = ui;
			const [storage, load] = usePoll(api, "/storage/state", 30000);
			const [chat, loadChat] = usePoll(api, "/chat-archive/state", 30000);
			const [form, setForm] = react.useState(null);
			const [threshold, setThreshold] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [items, setItems] = react.useState(null);
			const [history, setHistory] = react.useState(null);
			const [historyQuery, setHistoryQuery] = react.useState("");
			const [showAllFiles, setShowAllFiles] = react.useState(false);
			const [confirm, confirmNode] = useConfirm();
			react.useEffect(() => { if (chat && form === null) setForm({ enabled: chat.enabled, channels: chat.channels.join(", "), days: chat.days }); }, [chat, form]);
			react.useEffect(() => { if (storage && threshold === null) setThreshold({ warnMB: storage.warnMB, freeMB: storage.freeMB, keep: storage.keep ?? 0 }); }, [storage, threshold]);
			if (!storage || !chat || !form || !threshold) return null;
			const size = (x) => `${(Number(x || 0) / 1048576).toFixed(1)} MB`;
			async function storageConfig(patch) { const r=await api("POST", "/storage/config", patch); if(r?.ok){await load();notify("已保存");}else notify(r?.error??"保存失败"); }
			async function snapshot() { setBusy(true);const r=await api("POST", "/storage/snapshot", {});setBusy(false);if(r?.ok){notify("存档已校验");await load();}else notify(r?.error??"存档失败"); }
			async function fileAction(action, file) {
				const warning = action === "restore" ? "恢复将于重启后替换当前记忆库；当前库会先另存。确定？" : "永久删除这份存档？不会删除在线记忆。";
				if(!(await confirm({ title: action === "restore" ? "恢复存档" : "删除存档", description: warning, danger: action === "delete" })))return;setBusy(true);const r=await api("POST", `/storage/${action}`, {file});setBusy(false);
				if(r?.ok){notify(action === "restore" ? "已安排恢复，重启后生效" : "存档已删除");await load();}else notify(r?.error??"操作失败");
			}
			async function saveChat() {
				const channels=form.channels.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
				if(Number(form.days)<chat.days && !(await confirm({ title: "缩短保留期限", description: "会立即清理已过期的本地聊天文本，备份和复制件不会同步清理。继续？", danger: true })))return;
				if(form.enabled && !(await confirm({ title: "启用聊天文本存档", description: "仅保存所列会话中插件接收到的文本，可能包含私密内容；文件未加密。附件和未接入的消息不会保存，历史消息无法补录。继续？" })))return;
				const r=await api("POST", "/chat-archive/config", {enabled:form.enabled,channels,days:Number(form.days)});
				if(r?.ok){setForm({enabled:r.enabled,channels:r.channels.join(", "),days:r.days});setItems(null);await loadChat();notify("聊天存档设置已保存");}else notify(r?.error??"保存失败");
			}
			async function showChat(channel, before) {const r=await api("GET", `/chat-archive/list?channel=${encodeURIComponent(channel)}${before ? `&before=${before}` : ""}`);if(r?.ok)setItems(prev=>({channel, next:r.next, rows:before && prev?.channel === channel ? [...prev.rows,...r.items] : r.items}));else notify(r?.error??"读取失败");}
			async function dropChat(channel) {if(!(await confirm({ title: "删除聊天文本", description: `永久删除 ${channel} 的本地聊天文本？备份和复制件需另行清理。`, danger: true })))return;const r=await api("POST", "/chat-archive/delete", {channel});if(r?.ok){setItems(null);await loadChat();notify("聊天文本已删除");}else notify(r?.error??"删除失败");}
			async function searchHistory(before) {const r=await api("GET", `/storage/search?q=${encodeURIComponent(historyQuery)}${before ? `&before=${before}` : ""}`);if(r?.ok)setHistory(prev=>({next:r.next,rows:before&&prev?[...prev.rows,...r.items]:r.items}));else notify(r?.error??"搜索失败");}
			return h(react.Fragment,null,
				Group({title:"记忆存档",tip:"压缩快照保留全部记忆及来源，不删除在线数据；本地文件未加密"},
					Row({title:"容量",meta:`数据库 ${size(storage.databaseBytes)} · 存档 ${size(storage.archivesBytes)} · 备份 ${size(storage.backupsBytes)} · 聊天 ${size(storage.chatBytes)}`}, Muted(storage.warning ? "容量告警" : `可用 ${storage.freeBytes == null ? "未知" : size(storage.freeBytes)}`)),
					Row({title:"记忆分层"},Muted(`近期 ${storage.tiers.recent} · 长期 ${storage.tiers.longTerm} · 周记 ${storage.tiers.weekly}`)),
					Row({title:"上下文预算",meta:"按字符估算，仅监测记忆片段"},Muted(storage.budget.consecutive >= 3 ? `连续 ${storage.budget.consecutive} 次接近上限` : `最近 ${Math.round(storage.budget.lastRatio*100)}%`)),
					Row({title:"每周自动存档",meta:"压缩校验，不删除原文；存档未加密"},h(Switch,{label:"每周自动存档",checked:storage.auto,disabled:busy,onChange:v=>storageConfig({auto:v})})),
					Row({title:"存档预览",meta:`现有 ${storage.files.length} 份，当前库 ${size(storage.databaseBytes)}；每次大小取决于数据`},Button({disabled:busy||storage.running,onClick:snapshot},busy||storage.running?"处理中":"立即存档")),
					storage.error?Row({title:"存档异常"},Muted(storage.error)):null,
					Row({title:"占用告警 MB"},Num({min:50,max:1048576,value:threshold.warnMB,"aria-label":"占用告警 MB",onChange:e=>setThreshold({...threshold,warnMB:e.target.value})})),
					Row({title:"剩余空间告警 MB"},Num({min:50,max:1048576,value:threshold.freeMB,"aria-label":"剩余空间告警 MB",onChange:e=>setThreshold({...threshold,freeMB:e.target.value})})),
					Row({title:"存档最多保留",meta:"超过就自动删最旧的；0 = 不限。在线记忆永远不删"},Num({min:0,max:200,value:threshold.keep,"aria-label":"存档最多保留几份",onChange:e=>setThreshold({...threshold,keep:e.target.value})}),Button({onClick:()=>storageConfig({warnMB:Number(threshold.warnMB),freeMB:Number(threshold.freeMB),keep:Number(threshold.keep)})},"保存")),
					...storage.files.slice(0,showAllFiles ? undefined : 5).map(f=>Row({title:`${f.file.slice(7,22)} · ${f.file.slice(23,31)}`,meta:size(f.size)},Button({disabled:busy,onClick:()=>fileAction("restore",f.file)},"恢复"),Button({disabled:busy,onClick:()=>fileAction("delete",f.file)},"删除"))),
					storage.files.length>5 ? Button({variant:"ghost",onClick:()=>setShowAllFiles(!showAllFiles)},showAllFiles ? "收起存档" : `显示全部 ${storage.files.length} 份`) : null,
					Row({title:"全部记忆记录",meta:"包括已归档和失效记录",stack:true},Input({className:"wide",value:historyQuery,placeholder:"搜索记忆", "aria-label":"搜索全部记忆",onChange:e=>setHistoryQuery(e.target.value)}),Button({onClick:()=>searchHistory(null)},"搜索")),
					history?h("div",{className:"fs-list"},...history.rows.map(x=>h("div",{className:"fs-row",key:x.id},h("span",{style:{overflowWrap:"anywhere"}},`#${x.id} · ${{active:"当前",archived:"已归档",outdated:"过时",superseded:"已替换"}[x.status] ?? x.status} · ${x.visibility === "private" ? "私密 · " : ""}${x.content}`))),history.next?Button({onClick:()=>searchHistory(history.next)},"加载更早"):null):null),
				Group({title:"聊天文本存档",tip:"默认关闭；仅保存选定会话中插件接收到的文本，不包括附件或全部平台消息"},
					Row({title:"启用",meta:"存在本机（文件权限仅本人可读，内容未加密），只从开启后记录、历史不补录；不想要随时关掉或删掉"},h(Switch,{label:"聊天文本存档",checked:form.enabled,onChange:v=>setForm({...form,enabled:v})})),
					Row({title:"只记这些会话",meta:"留空 = 所有会话都记（推荐）；填了就只记这些，多个 ID 用逗号分隔，例如 private:123、group:456",stack:true},Input({className:"wide",value:form.channels,"aria-label":"聊天存档会话 ID",onChange:e=>setForm({...form,channels:e.target.value})})),
					Row({title:"保留天数",meta:"过期文本按天清理；备份和复制件需另行清理"},Num({min:1,max:3650,value:form.days,"aria-label":"聊天存档保留天数",onChange:e=>setForm({...form,days:e.target.value})}),Button({onClick:saveChat},"保存")),
					Row({title:"已保存文本"},Muted(`${chat.count} 条`)),
					...(chat.stored??[]).map(x=>Row({title:x.channel},Muted(`${x.count} 条`),Button({onClick:()=>showChat(x.channel,null)},"查看"),Button({onClick:()=>dropChat(x.channel)},"删除"))),
					chat.error?Row({title:"存档异常"},Muted(chat.error)):null,
					items?h("div",{className:"fs-list"},...items.rows.map(x=>h("div",{className:"fs-row",key:x.id},h("span",{style:{overflowWrap:"anywhere",whiteSpace:"pre-wrap"}},`${x.self?"我":x.who}：${x.content}`))),items.next?Button({onClick:()=>showChat(items.channel,items.next)},"加载更早"):null):null),
				confirmNode);
		}

		function InspectorPane({ section = "memories", ...props }) {
			const { api, notify, ui } = props;
			const { h, Tag, Empty, Item, Muted, Group, Row, Input, Button, useConfirm } = ui;
			const [owner, setOwner] = react.useState("all");
			const [q, setQ] = react.useState("");
			const [qApplied, setQApplied] = react.useState("");
			const [source, setSource] = react.useState("");
			const [bulk, setBulk] = react.useState(false);
			const [sel, setSel] = react.useState(() => new Set());
			const [confirm, confirmNode] = useConfirm();
			const qs = new URLSearchParams({ ...(owner !== "all" ? { ownerId: owner } : {}), ...(qApplied ? { q: qApplied } : {}), ...(source ? { source } : {}), ...(bulk ? { limit: "500" } : {}) }).toString();
			const [data, load] = usePoll(api, `/inspector/overview${qs ? `?${qs}` : ""}`, 0);
			async function dropPending(id) {
				const r = await api("POST", "/inspector/forget", { targetType: "pending", id });
				if (r?.ok) { notify("已删掉这条待办"); load(); } else notify(r?.error ?? "删除失败");
			}
			const [adding, setAdding] = react.useState("");
			react.useEffect(() => { setSel(new Set()); }, [owner, qApplied, source, bulk]);
			if (!data) return null;
			const persons = data.persons ?? [];
			const memories = data.memories ?? [];
			const pendings = data.pendings ?? [];
			const pill = (ownerId, label, title) => ui.Pill({ key: ownerId, active: owner === ownerId, className: "fs-pill", "aria-pressed": owner === ownerId, title, onClick: () => setOwner(ownerId), children: label });
			const onSelect = (id, on) => setSel((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
			const filter = { ownerId: owner, q: qApplied, source };
			const narrowed = owner !== "all" || qApplied !== "" || source !== "";
			async function runBulk(action, value, label, byFilter = false) {
				const target = byFilter ? { filter } : { ids: [...sel] };
				if (byFilter) {
					const dry = await api("POST", "/inspector/bulk", { ...target, action, value, dryRun: true });
					if (!dry?.ok) { notify(dry?.error ?? "操作失败"); return; }
					if (dry.matched === 0) { notify("没有符合条件的"); return; }
					if (!(await confirm({ title: label, description: `符合当前筛选的 ${dry.matched} 条，确定？`, danger: action === "forget" }))) return;
				} else if (action === "forget" && !(await confirm({ title: "删除记忆", description: `删掉选中的 ${sel.size} 条？（能在人物卡里恢复）`, danger: true }))) return;
				const r = await api("POST", "/inspector/bulk", { ...target, action, value });
				if (r?.ok) { notify(`${label}：${r.changed} 条`); setSel(new Set()); load(); } else notify(r?.error ?? "操作失败");
			}
			const SOURCES = [["", "所有来源"], ["chat", "聊天里记的"], ["history-import", "导入（聊天记录）"], ["import", "导入（记忆文件）"], ["manual", "主人手动加的"]];
			const n = sel.size;
			const bulkBar = !bulk ? null : h("div", { className: "fs-row" },
				h("div", { className: "fs-ctl", style: { flexWrap: "wrap", gap: "6px" } },
					Button({ variant: "ghost", onClick: () => setSel(n === memories.length ? new Set() : new Set(memories.map((m) => m.id))) }, n === memories.length && n > 0 ? "全不选" : `全选这 ${memories.length} 条`),
					Muted(`已选 ${n} 条`),
					Button({ disabled: n === 0, onClick: () => runBulk("forget", null, "删除") }, "删除"),
					Button({ variant: "ghost", disabled: n === 0, onClick: () => runBulk("visibility", "private", "标成私密") }, "标私密"),
					Button({ variant: "ghost", disabled: n === 0, onClick: () => runBulk("visibility", "normal", "取消私密") }, "取消私密"),
					...[1, 3, 5].map((v) => Button({ key: v, variant: "ghost", disabled: n === 0, onClick: () => runBulk("importance", v, `重要度改成 ${v}`) }, `重要度 ${v}`)),
					h("span", { className: "fs-fill-gap" }),
					Button({ variant: "ghost", disabled: !narrowed, title: narrowed ? "删掉符合当前筛选（人 / 来源 / 包含的字）的全部记忆，不只是这页显示的" : "先选一个人、来源或输入要包含的字", onClick: () => runBulk("forget", null, "按筛选删除", true) },
						`删掉符合筛选的全部${data.matchedTotal != null ? ` ${data.matchedTotal} 条` : ""}`)));
			async function add() {
				const r = await api("POST", "/inspector/memory-add", { ownerId: owner, content: adding, importance: 3 });
				if (r?.ok) { setAdding(""); notify("已记下"); load(); } else notify(r?.error ?? "添加失败");
			}
			return h(react.Fragment, null,
				section === "people" ? Group({ title: "人物与关系" },
					Row({ title: "选择人物" }, ui.Select({ value: owner, "aria-label": "选择人物", onChange: (e) => setOwner(e.target.value) },
						h("option", { value: "all" }, "请选择"),
						...persons.filter((p) => p.ownerId !== "self").map((p) => h("option", { key: p.ownerId, value: p.ownerId }, `${p.displayName} · ${p.memoryCount} 条`)))),
					owner !== "all" && owner !== "self" ? h(PersonCard, { key: owner, ownerId: owner, ui, api, notify, onChanged: load }) : Empty("选一个人，查看关系、称呼和印象")) : null,
				section === "recall-test" ? Group({ title: "检索测试" },
					Row({ title: "选择人物" }, ui.Select({ value: owner, "aria-label": "测试哪个人", onChange: (e) => setOwner(e.target.value) },
						h("option", { value: "all" }, "请选择"),
						...persons.filter((p) => p.ownerId !== "self").map((p) => h("option", { key: p.ownerId, value: p.ownerId }, p.displayName)))),
					owner !== "all" && owner !== "self" ? h(MemoryDebug, { key: `dbg-${owner}`, ownerId: owner, ui, api, notify }) : Empty("选一个人，输入一句话试试会想起什么")) : null,
				section === "memories" ? h(react.Fragment, null,
				Group({ title: "记忆内容", aside: h("span", { className: "fs-group-aside" },
					data.matchedTotal != null && data.matchedTotal > memories.length ? Muted(`显示 ${memories.length} / ${data.matchedTotal} 条`) : null,
					Button({ variant: bulk ? "primary" : "ghost", onClick: () => setBulk(!bulk) }, bulk ? "完成" : "批量")) },
					h("div", { className: "fs-pills", role: "group", "aria-label": "按人筛选" }, pill("all", "全部"),
						...persons.map((p) => pill(p.ownerId, p.ownerId === "self" ? "她自己" : p.displayName, p.ownerId === "self" ? undefined : `${stageLabel(p.relationStage)} · ${p.memoryCount} 条`))),
					h("div", { className: "fs-row" },
						Input({ value: q, className: "wide", placeholder: "搜记忆内容（回车）", "aria-label": "搜记忆内容", onChange: (e) => setQ(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") setQApplied(q.trim()); }, onBlur: () => setQApplied(q.trim()) }),
						ui.Select({ value: source, "aria-label": "来源", onChange: (e) => setSource(e.target.value) }, ...SOURCES.map(([v, l]) => h("option", { key: v, value: v }, l)))),
					bulkBar,
					owner !== "all" ? h("div", { className: "fs-row" },
						Input({ value: adding, className: "wide", placeholder: "手动记一条（比如：她不吃香菜）", onChange: (e) => setAdding(e.target.value), onKeyDown: (e) => { if (e.key === "Enter" && adding.trim()) add(); } }),
						Button({ disabled: adding.trim() === "", onClick: add }, "记下")) : null,
					h("div", { className: "fs-list" }, memories.length === 0 ? Empty("还没有记忆")
						: memories.map((m) => h(MemoryItem, { key: m.id, m, ui, api, notify, refresh: load, curGen: data.currentGenerationId ?? 1, selectable: bulk, selected: sel.has(m.id), onSelect })))),
				pendings.length === 0 ? null : Group({ title: "待办", aside: Tag(String(pendings.length), "outline") },
					h("div", { className: "fs-list" }, pendings.map((p) => Item({
						key: p.id, lead: Muted(props.fmtDueAt(p.dueAt), { className: "fs-unit num" }), text: p.reason,
						// 重试到放弃的也列出来：以前它悄悄消失，主人以为提醒还在（#80）
						meta: [p.status === "failed" ? Tag(`没发出去（试了 ${p.attempts ?? 0} 次）`, "danger", { key: "f" }) : null, p.channelId ?? ""].filter(Boolean),
						onRemove: () => dropPending(p.id)
					}))))) : null,
				section === "weekly" ? h(WeeklyPanel, { ui, api, notify, onDone: load }) : null,
				section === "archives" ? h(StoragePanel, { ui, api, notify }) : null,
				section === "backups" ? h(ImportBackup, { ui, api, notify, relTime: props.relTime, onDone: load }) : null,
				confirmNode);
		}

		// ── 动态：为什么回 / 为什么没回 / 想起了什么 ──
		const KINDS = {
			reply: ["要回", "info"], interject: ["插话", "info"], sent: ["已发", "success"], silent: ["没说", "outline"],
			memorize: ["只记", "outline"], paused: ["暂停", "warning"], resumed: ["恢复", "success"], failed: ["失败", "danger"],
			recalled: ["撤回", "outline"], command: ["命令", "info"], proactive: ["主动", "info"], digest: ["记下", "success"],
			filtered: ["改写", "outline"], diary: ["日记", "success"], browse: ["刷视频", "outline"], share: ["分享", "success"], post: ["发动态", "success"], comment: ["评论区", "info"], mood: ["心情", "info"], poke: ["戳回", "info"], react: ["回应", "info"],
			// 发出去了但回读没看到 —— 抖音风控会静默吞消息，这种要跟「失败」区分开
			unconfirmed: ["可能被吞", "warning"],
			relay: ["转达", "success"]
		};
		/** 单张图上限：跟后端 `IMPORT_BYTES_MAX` 对齐（原始二进制上传，不再有 base64 膨胀）。 */
		const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

		/** 一张表情：名字能直接改（失焦 / 回车保存，Esc 撤销），标签能补（老表情没标签就进不了「按感觉挑」），也能删 */
		function StickerCard({ x, api, apiBase, notify, refresh, relTime, ui, onRemove }) {
			const { h, Input, IconButton } = ui;
			const base = x.file.replace(/\.[a-z]+$/i, "");
			const [name, setName] = react.useState(base);
			// 标签草稿：null = 收着；开着时是输入框里的串（顿号 / 逗号分隔都认，后端会洗）
			const [tags, setTags] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const saving = react.useRef(false);
			const done = react.useRef(false);
			async function save() {
				if (saving.current || done.current) return;
				const next = name.trim();
				if (next === "" || next === base) { setName(base); return; }
				saving.current = true; setBusy(true);
				const r = await api("POST", "/stickers/rename", { file: x.file, workspacePath: x.workspacePath, name: next });
				saving.current = false; setBusy(false);
				if (r?.ok) { done.current = true; notify("改好了"); refresh(); }
				else { notify(r?.error ?? "改名失败"); setName(base); }
			}
			const current = (x.tags ?? []).join("、");
			// Esc 是「撤销」：要跳过紧接着那次 blur 的保存，否则撤销完还是把草稿存进去了
			const skipped = react.useRef(false);
			async function saveTags() {
				if (tags === null || busy) return;
				if (skipped.current) { skipped.current = false; return; }
				const next = tags.trim();
				if (next === current) { setTags(null); return; }
				setBusy(true);
				// 保存后向量由后端作废，下次「按感觉挑」自己懒补 —— 这里不用额外触发
				const r = await api("POST", "/stickers/tags", { file: x.file, workspacePath: x.workspacePath, tags: next });
				setBusy(false);
				if (r?.ok) { setTags(null); notify(r.tags?.length ? `标签：${r.tags.join("、")}` : "标签清空了"); refresh(); }
				else notify(r?.error ?? "保存标签失败");
			}
			const tip = [x.file, x.tracked ? (x.from === "主人" ? "主人导入的" : x.from ? `从 ${x.from} 那里` : "") : "主人自己放进目录的", x.summary, x.tags?.length ? x.tags.join("、") : "", relTime(x.at, Date.now())].filter(Boolean).join("\n");
			return h("figure", { className: "fs-sticker", title: tip },
				h("img", { alt: base, loading: "lazy", src: `${apiBase}/stickers/file?file=${encodeURIComponent(x.file)}&ws=${encodeURIComponent(x.workspacePath)}` }),
				h("figcaption", null,
					Input({ value: name, "aria-label": `给 ${x.file} 改名`, disabled: busy, onChange: (e) => setName(e.target.value), onBlur: save, onKeyDown: (e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") setName(base); } }),
					tags === null ? null : Input({ value: tags, "aria-label": `给 ${x.file} 改标签`, placeholder: "得意、猫", autoFocus: true, disabled: busy,
						onChange: (e) => setTags(e.target.value), onBlur: saveTags, onKeyDown: (e) => { if (e.key === "Enter") saveTags(); else if (e.key === "Escape") { skipped.current = true; setTags(null); } } })),
				IconButton("edit", x.tags?.length ? `编辑标签（现在：${current}）` : "编辑标签", () => setTags(tags === null ? current : null), { className: "fs-icon-btn fs-native-icon fs-sticker-tag-btn" }),
				IconButton("close", "删除", () => onRemove(x)));
		}

		/** 表情包：她收藏的 + 主人自己放进 _stickers 的（动态页底部） */
		function StickerShelf({ api, apiBase, notify, relTime, ui }) {
			const { h, Group, Tag, Empty, Row, Button, Muted, Switch, Num } = ui;
			const [data, load] = usePoll(api, "/stickers/state", 15000);
			const [busy, setBusy] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			// 数字框的草稿值：null = 还没动过（显示真值），改了才有值；失焦才提交
			const [listedDraft, setListedDraft] = react.useState(null);
			const picker = react.useRef(null);
			if (!data || data.ok === false) return null;
			const cfg = data.config ?? {};
			const panelOn = cfg.biliPanel === true;
			async function saveConfig(patch, doneText) {
				setSaving(true);
				const r = await api("POST", "/stickers/config", patch);
				setSaving(false);
				if (r?.ok) { notify(doneText); load(); } else notify(r?.error ?? "保存失败");
			}
			// 最近的排前面：主人刚放进目录的图不会被收藏记录挤出前 60 张
			const items = (data.items ?? []).filter((x) => x.exists).slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
			async function remove(x) {
				const r = await api("POST", "/stickers/delete", { file: x.file, workspacePath: x.workspacePath });
				if (r?.ok) { notify("删掉了"); load(); } else notify(r?.error ?? "删除失败");
			}
			async function importFiles(files) {
				const list = Array.from(files ?? []);
				if (list.length === 0) return;
				setBusy(true);
				let doneCount = 0; let skipped = 0; let failed = 0; let full = false;
				const errors = [];
				for (const f of list) {
					if (f.size > IMPORT_MAX_BYTES) { skipped++; continue; }
					// 🔴 直接发 File 本体（原始二进制），不再读成 base64。
					// base64 有 33% 膨胀，而且客户端要 4× 峰值内存（读→切片→stringify→编码），
					// 服务端还要再吃 2.4×；中文文件名更糟（V8 整串升 TwoByte，再翻倍）。
					// 改成流式写盘后，内存几乎不随文件大小增长。
					// 文件名走查询串（放 header 里中文会抛）。
					const r = await api("POST", `/stickers/import?name=${encodeURIComponent(f.name.replace(/\.[a-z]+$/i, ""))}`, f, { raw: true });
					if (r?.ok) doneCount++;
					else if (r?.full === true) { failed++; full = true; errors.push(`${f.name}：${r?.error ?? "_stickers 满了"}`); break; }
					else if (r?.dup === true) { errors.push(`${f.name}：${r?.error ?? "已经有了"}`); }
					else { failed++; errors.push(`${f.name}：${r?.error ?? "导入失败"}`); }
				}
				setBusy(false);
				const parts = [];
				if (doneCount > 0) parts.push(`导入了 ${doneCount} 张`);
				if (skipped > 0) parts.push(`${skipped} 张超过 ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)}MB 跳过`);
				if (failed > 0) parts.push(`${failed} 张没导进去`);
				if (full) parts.push("_stickers 满了");
				notify(parts.length > 0 ? parts.join("，") : "没有导入");
				if (errors.length > 0) notify(errors.join("；"));
				load();
			}
			return Group({ title: "表情包", aside: items.length ? Tag(String(items.length), "outline") : null },
				// B站 私信能用平台自带的表情：正文写 [doge] 这种码，服务端自己渲染成图。
				// 默认关——要打一次面板接口，且面板按账号不同，先确认拿得到再开。
				Row({ title: "B站私信用平台小表情",
					desc: panelOn ? "正文里写 [doge] 这类码就会变成表情" : "开了之后，她在 B站私信里可以用 B站自带的表情" },
					panelOn ? Tag("开着", "outline") : null,
					h(Switch, { label: "B站私信用平台小表情", disabled: saving,
						checked: panelOn,
						onChange: (v) => saveConfig({ biliPanel: v }, v ? "她可以在 B站私信里用平台表情了" : "不再用平台表情") })),
				panelOn ? Row({ title: "最多告诉她几个", desc: "面板有 400 多个，提示词放不下" },
					// 失焦才存：每敲一个字就发一次请求，既费接口又会把中间值（「3」）存进去
					// value 永远是「看得见的值」：没动过就显示配置里的真值，不会是空白
					Num({ min: 0, max: 60, value: listedDraft ?? (cfg.biliPanelListed ?? 30), "aria-label": "最多告诉她几个",
						onChange: (e) => setListedDraft(e.target.value),
						onBlur: () => {
							const raw = String(listedDraft ?? "").trim();
							setListedDraft(null);
							if (raw === "" || Number(raw) === (cfg.biliPanelListed ?? 30)) return; // 空 / 没变：还原成真值
							saveConfig({ biliPanelListed: Number(raw) }, "个数改了");
						} }), Muted("个")) : null,
				Row({ title: "导入本地图片" },
					h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true, ref: picker, style: { display: "none" }, "aria-label": "选要导入的表情图", onChange: (e) => {
						// 🔴 先 Array.from 做快照，再清空 input。
						// 以前先存 e.target.files（活的 FileList）再清空 value —— HTML 规范里
						// 设置 value="" 会清空 selected files 列表，FileList 跟着变空，
						// 于是 importFiles() 拿到 0 张，**连 /stickers/import 都不发**，表现为「选图后毫无反应」。
						const files = Array.from(e.target.files ?? []);
						e.target.value = "";
						importFiles(files);
					} }),
					Button({ variant: "ghost", disabled: busy, "aria-label": "导入本地图片", onClick: () => picker.current?.click() }, busy ? "导入中…" : "选图导入"),
					Muted("不占每天收藏的额度")),
				items.length === 0 ? Empty("还没有表情包。聊天里看到喜欢的，她会自己存下来；你也可以直接把图片放进工作区的 _stickers 目录") : h("div", { className: "fs-stickers" }, items.slice(0, 60).map((x) => h(StickerCard, { key: `${x.workspacePath}/${x.file}`, x, api, apiBase, notify, refresh: load, relTime, ui, onRemove: remove }))));
		}

		/** 一个群 / 私聊学到的说法 */
		function SlangGroupCard({ g, api, notify, relTime, ui, onChanged }) {
			const { h, Group, Row, Input, Button, IconButton, Tag, Muted, Empty } = ui;
			const [style, setStyle] = react.useState(g.style ?? "");
			const [term, setTerm] = react.useState("");
			const [meaning, setMeaning] = react.useState("");
			const [when, setWhen] = react.useState("");
			const [how, setHow] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const isGroup = g.kind !== "private";
			const isGlobal = g.kind === "global";
			async function edit(body, okText) {
				const r = await api("POST", "/slang/edit", { channelId: g.channelId, ...body });
				if (r?.ok) { if (okText) notify(okText); onChanged(); } else notify(r?.error ?? "保存失败");
			}
			async function learn() {
				setBusy(true);
				const r = await api("POST", "/slang/learn", { channelId: g.channelId });
				setBusy(false);
				const got = [r?.added ? `${r.added} 个新梗` : "", r?.expressionsAdded ? `${r.expressionsAdded} 种新的说话方式` : ""].filter(Boolean).join("、");
				if (r?.ok) { notify(got ? `学到 ${got}` : "没学到新的"); onChanged(); } else notify(r?.error ?? "没学成");
			}
			const add = () => { if (term.trim() && meaning.trim()) { edit({ add: { term, meaning } }, "加上了"); setTerm(""); setMeaning(""); } };
			const addWay = () => { if (when.trim() && how.trim()) { edit({ addExpression: { situation: when, style: how } }, "加上了"); setWhen(""); setHow(""); } };
			const ways = g.expressions ?? [];
			return Group({ title: isGlobal ? "所有聊天都能用的说法（导入的）" : `${isGroup ? "群里的说法" : "私聊学到的"} · ${g.title || g.channelId}`, tip: isGlobal ? "排在每个聊天自己学的后面" : undefined, aside: isGlobal ? null : h("span", { className: "fs-group-aside" },
				Muted(`${g.learnedAt ? `${relTime(g.learnedAt, Date.now())}学的` : "还没学过"} · 攒了 ${g.lines} 句`),
				Button({ variant: "ghost", disabled: busy, onClick: learn }, busy ? "学习中" : "现在学一次")) },
				isGlobal ? null : Row({ title: "说话风格", desc: g.styleByUser ? "你改过，不会被覆盖" : undefined },
					Input({ value: style, placeholder: "学到了会写在这里", onChange: (e) => setStyle(e.target.value), onBlur: () => { if (style !== (g.style ?? "")) edit({ style }, "改好了"); } })),
				(g.terms ?? []).length === 0 ? Empty("还没有学到梗") : h("div", { className: "fs-list" }, g.terms.map((t) => h("div", { className: "fs-item", key: t.term, title: t.example || undefined },
					h("span", { className: "fs-item-main" }, h("b", { className: "fs-strong" }, t.term), ` ${t.meaning}`),
					h("span", { className: "fs-item-meta" }, t.byUser ? Tag("手动", "outline") : t.from === "maibot" ? Tag("麦麦", "outline") : null, IconButton("close", "删除", () => edit({ remove: t.term })))))),
				Row({ title: "加一个梗" },
					Input({ value: term, placeholder: "说法", "aria-label": "说法", onChange: (e) => setTerm(e.target.value) }),
					Input({ value: meaning, placeholder: "什么意思", "aria-label": "什么意思", onChange: (e) => setMeaning(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") add(); } }),
					Button({ disabled: !term.trim() || !meaning.trim(), onClick: add }, "添加")),
				Row({ title: "说话方式", desc: `从${isGroup ? "群友" : "对方"}的话里学的，学到次数越多越常用；她自己说的不学` }, ways.length ? Tag(String(ways.length), "outline") : null),
				ways.length === 0 ? Empty("还没学到说话方式") : h("div", { className: "fs-list" }, ways.map((w) => h("div", { className: "fs-item", key: w.id, title: w.example ? `原话：${w.example}` : undefined },
					h("span", { className: "fs-item-main" }, Muted(`当${w.situation}时`), " ", h("b", { className: "fs-strong" }, w.style)),
					h("span", { className: "fs-item-meta" }, w.byUser ? Tag("手动", "outline") : w.from === "maibot" ? Tag(`麦麦 · ${w.count ?? 1} 次`, "outline") : Muted(`学到 ${w.count ?? 1} 次`), IconButton("close", "删除", () => edit({ removeExpression: w.id })))))),
				Row({ title: "加一种说法" },
					Input({ value: when, placeholder: "什么时候（比如：被夸了）", "aria-label": "什么时候", onChange: (e) => setWhen(e.target.value) }),
					Input({ value: how, placeholder: "怎么说（比如：先说「哪有」再偷偷高兴）", "aria-label": "怎么说", onChange: (e) => setHow(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") addWay(); } }),
					Button({ disabled: !when.trim() || !how.trim(), onClick: addWay }, "添加")));
		}

		function SlangShelf({ api, notify, relTime, ui }) {
			const { h, Group, Empty } = ui;
			const [data, load] = usePoll(api, "/slang/state", 0);
			if (!data || data.ok === false) return null;
			const groups = data.groups ?? [];
			if (groups.length === 0) return data.config?.enabled === false ? null : Group({ title: "学到的说法" }, Empty("群里、私聊里的话攒够了，她会自己学梗、说话风格和说话方式"));
			return h(react.Fragment, null, groups.map((g) => h(SlangGroupCard, { key: `${g.channelId}-${g.learnedAt ?? 0}-${(g.terms ?? []).length}-${(g.expressions ?? []).length}`, g, api, notify, relTime, ui, onChanged: load })));
		}

		function ActivityPane({ api, apiBase, notify, relTime, ui, section = "activity" }) {
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
				section === "activity" ? h(react.Fragment, null,
				(data.paused ?? []).length === 0 ? null : Group({ title: "暂停中" },
					h("div", { className: "fs-list" }, data.paused.map((p) => h("div", { className: "fs-item", key: p.channelId },
						h("span", { className: "fs-item-main" }, p.title),
						h("span", { className: "fs-item-meta" }, h("span", null, p.until ? `到 ${fmtClock(p.until)}` : "一直"),
							Button({ variant: "ghost", onClick: () => resume(p.channelId) }, "恢复")))))),
				Group({ title: "最近", aside: Tag(String(decisions.length), "outline") },
					h("div", { className: "fs-steps" }, decisions.length === 0 ? Empty("还没有动静") : decisions.map((d, i) => {
						const [label, tone] = KINDS[d.kind] ?? [d.kind, "outline"];
						const body = d.text ? [d.who && `${d.who}：`, d.text].filter(Boolean).join("") : d.who;
						// #78：这一轮记忆到底有没有参与。以前「没跑 / 认不出人 / 跑了没召回到」都是什么都不显示，
						// 于是「她怎么想不起来」在界面上查不出来
						// miss 由后端算好（notMounted / noSession），别在这里猜是哪一种
						const missWhy = d.recallMiss === "notMounted"
							? "瞬态块压根没挂上（这个会话的人格卡/上下文注册失败，插件启动时可能没挂成）"
							: d.recallMiss === "noSession"
								? "瞬态块跑了但找不到这个会话的登记（重启后 agent 复用了旧 id，或这一轮没走我们的 beginTurn）"
								: "这一轮没组装记忆（瞬态块没跑）";
						const recallBadge = !d.recallAt ? "记忆没进这轮" : d.speakerUnknown ? "认不出是谁" : d.memories?.length ? `想起 ${d.memories.length}` : "没召回到";
						const recallTone = !d.recallAt || d.speakerUnknown ? "warning" : null;
						const tip = [d.title, body, d.reason, d.memories?.length ? `想起了：\n${d.memories.join("\n")}` : "",
							!d.recallAt ? missWhy : ""].filter(Boolean).join("\n");
						const more = Boolean((body && body.length > 36) || d.reason || d.memories?.length);
						const head = [
							h("span", { className: "fs-step-dot", "data-tone": tone, key: "d", "aria-hidden": true }),
							h("span", { className: "fs-step-kind", key: "k" }, label),
							h("span", { className: "fs-item-main", key: "m", title: tip }, h("b", { className: "fs-strong" }, d.title), body ? ` ${body}` : ""),
							h("span", { className: "fs-item-meta", key: "t" },
								d.kind === "sent" || d.kind === "silent" || d.kind === "failed" || d.kind === "unconfirmed"
									? (recallTone ? Tag(recallBadge, recallTone) : Muted(recallBadge)) : null,
								h("span", { className: "num" }, relTime(d.at, now)))];
						if (!more) return h("div", { className: "fs-step", key: `${d.at}-${i}` }, h("div", { className: "fs-step-head" }, ...head));
						return h("details", { className: "fs-step", key: `${d.at}-${i}` },
							h("summary", { className: "fs-step-head" }, ...head, ui.Icon("chevron", 12)),
							h("div", { className: "fs-step-body" },
								body && body.length > 36 ? h("p", null, body) : null,
								d.reason ? h("p", { className: "fs-muted" }, d.reason) : null,
								d.memories?.length ? h("ul", null, d.memories.map((m, j) => h("li", { key: j }, m))) : null));
					}))),
				(data.dreamLog ?? []).length === 0 ? null : Group({ title: "整理记录" },
					h("div", { className: "fs-steps" }, data.dreamLog.map((x, i) => {
						const head = [
							h("span", { className: "fs-step-dot", "data-tone": "success", key: "d", "aria-hidden": true }),
							h("span", { className: "fs-item-main", key: "m" }, `${x.name}：${[x.profile ? "更新了印象" : "", x.outdated?.length ? `${x.outdated.length} 条记忆判为过时` : ""].filter(Boolean).join("，")}`),
							h("span", { className: "fs-item-meta", key: "t" }, h("span", { className: "num" }, relTime(x.at, now)))];
						if (!(x.outdated ?? []).length) return h("div", { className: "fs-step", key: i }, h("div", { className: "fs-step-head" }, ...head));
						return h("details", { className: "fs-step", key: i },
							h("summary", { className: "fs-step-head" }, ...head, ui.Icon("chevron", 12)),
							h("div", { className: "fs-step-body" }, h("ul", null, x.outdated.map((o) => h("li", { key: o.id }, `#${o.id}「${o.content}」→ #${o.by}：${o.reason}`)))));
					})))) : null,
				section === "stickers" ? h(StickerShelf, { api, apiBase, notify, relTime, ui }) : null,
				section === "slang" ? h(SlangShelf, { api, notify, relTime, ui }) : null);
		}

		return { InspectorPane, ActivityPane };
	}
});
