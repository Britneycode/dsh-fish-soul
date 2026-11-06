/**
 * dsh-fish-soul — 设置面板「人格」页（client.persona.js，按需加载的包内分块）
 *
 * 现在的人格、内置模板（看看 / 换上）、编辑（名字 / 人设 / 性格 / 看事情的方式 / 说话示例 / 作息 / 世界书）、
 * 她慢慢长出来的变化（聊完整理攒证据，够了才生效；看 / 确认 / 删 / 自己加 / 清空）、
 * 导入 SillyTavern 角色卡（JSON / PNG）、导出、撤销上一次更换。换完下一轮就生效。
 * 主面板 client.js 用 require.async("./client.persona.js") 拿到 PersonaPane；api / 控件（props.ui）由主面板传进来。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	chunk: "client.persona.js",
	factory: (require) => {
		const react = require("react");
		const SOURCE = { builtin: "内置的鱼", "persona.json": "persona.json", "persona.png": "persona.png" };
		const FIELDS = [
			{ key: "name", title: "名字", desc: "群里叫这个名字也算点名（两个字以上）", max: 40 },
			{ key: "anchor", title: "一句话人设", desc: "每轮提醒她一次，聊久了也不跑偏", max: 80, fish: true, stack: true },
			{ key: "description", title: "她是谁", desc: "住处、宠物、爱好、喜欢和讨厌的、拖着没做完的事、说话方式；职业和城市可写可不写", area: 8 },
			{ key: "personality", title: "性格", desc: "写她什么时候会怎么做，别堆形容词；优点毛病都写，最好有一处嘴上和行动对不上（嘴上「随便」，其实记着）", area: 3 },
			{ key: "perspective", title: "看事情的方式", desc: "一行一条，2～3 条她自己的价值观，可以有点矛盾；遇到相关的事才体现，不会拿来说教", area: 3, fish: true, lines: true },
			{ key: "moods", title: "不同心情下怎么说话", desc: "一行一条，比如「生气：只回几个字，句号结尾，不解释」；可写 开心 / 低落 / 生气 / 犯懒 / 好久不见，她正好是这个心情时才用上", area: 4, fish: true },
			{ key: "scenario", title: "平时在哪聊", area: 2 },
			{ key: "routine", title: "作息", desc: "每天排日程时照这个来", area: 2, fish: true },
			{ key: "mes_example", title: "说话示例", desc: "<START> 隔开每段；{{user}}: / {{char}}: 开头，一条消息一行", area: 8 },
			{ key: "first_mes", title: "开场白", area: 1 },
			{ key: "post_history_instructions", title: "每轮提醒", desc: "附在每轮最后的一两句话，比如「回得短一点」", area: 2 }
		];

		function useLoad(api, path) {
			const [data, setData] = react.useState(null);
			const load = react.useCallback(async () => { const r = await api("GET", path); if (r?.ok !== false) setData(r); else setData((d) => d ?? { error: r?.error }); }, [api, path]);
			react.useEffect(() => { load(); }, [load]);
			return [data, setData, load];
		}

		const dataOf = (card) => card?.data ?? card ?? {};
		const fishOf = (card) => dataOf(card).extensions?.fish_soul ?? {};
		const entriesOf = (card) => { const e = dataOf(card).character_book?.entries ?? []; return Array.isArray(e) ? e : Object.values(e); };
		const keysOf = (e) => (Array.isArray(e?.keys) ? e.keys : Array.isArray(e?.key) ? e.key : []);

		/** 说话示例 → 气泡（预览用） */
		function Chat({ h, card }) {
			const d = dataOf(card);
			const name = d.name || "她";
			const blocks = String(d.mes_example ?? "").split(/<START>/i).map((b) => b.trim()).filter(Boolean).slice(0, 4);
			const fill = (t) => t.replace(/\{\{char\}\}/gi, name).replace(/\{\{user\}\}/gi, "你");
			if (blocks.length === 0 && !d.first_mes) return null;
			return h("div", { className: "fs-chat" },
				d.first_mes ? h("div", { className: "fs-bubble", key: "first" }, fill(d.first_mes)) : null,
				...blocks.map((b, i) => h(react.Fragment, { key: i },
					h("div", { className: "fs-chat-sep" }),
					...b.split("\n").map((line, j) => {
						const m = line.match(/^\s*\{\{(user|char)\}\}\s*[:：]\s*(.*)$/i);
						if (!m || !m[2]) return null;
						return h("div", { className: "fs-bubble", key: j, "data-me": m[1].toLowerCase() === "user" ? "" : undefined }, fill(m[2]));
					}))));
		}

		/** 模板：看看 → 预览；用这个 → 二次确认 */
		function Template({ t, h, ui, open, onOpen, onApply, onEdit, current }) {
			const { Button, Tag } = ui;
			const [confirm, setConfirm] = react.useState(false);
			const d = dataOf(t.card);
			return h("div", { className: "fs-persona" },
				h("div", { className: "fs-persona-head" },
					h("div", { className: "fs-persona-title" },
						h("b", null, t.title), current ? Tag("在用", "info") : null),
					h("div", { className: "fs-ctl" },
						Button({ variant: "ghost", onClick: onOpen, "aria-expanded": open }, open ? "收起" : "看看"),
						confirm
							? h(react.Fragment, null, Button({ variant: "primary", onClick: () => { setConfirm(false); onApply(); } }, `换成${d.name}`), Button({ variant: "ghost", onClick: () => setConfirm(false) }, "算了"))
							: Button({ onClick: () => setConfirm(true), disabled: current }, "用这个"))),
				open ? h("div", { className: "fs-persona-body" },
					h("div", { className: "fs-tags" }, (t.tags ?? []).map((x) => h(react.Fragment, { key: x }, Tag(x, "outline")))),
					h("p", { className: "fs-persona-desc" }, String(d.description ?? "").replace(/\{\{char\}\}/g, d.name)),
					(fishOf(t.card).perspective ?? []).length > 0 ? h("p", { className: "fs-persona-desc" }, h("b", null, "看事情的方式　"), fishOf(t.card).perspective.join("；")) : null,
					Object.keys(fishOf(t.card).moods ?? {}).length > 0 ? h("p", { className: "fs-persona-desc" }, h("b", null, "不同心情　"), Object.entries(fishOf(t.card).moods).map(([k, x]) => `${k}：${x}`).join("；")) : null,
					fishOf(t.card).routine ? h("p", { className: "fs-persona-desc" }, h("b", null, "作息　"), fishOf(t.card).routine) : null,
					h(Chat, { h, card: t.card }),
					h("div", { className: "fs-ctl" }, Button({ variant: "ghost", onClick: onEdit }, "改一改再用"))) : null);
		}

		/** 编辑器：常用字段 + 世界书（关键词空着 = 一直记得） */
		function Editor({ h, ui, card, onSave, onCancel, busy }) {
			const { Group, Row, Input, Area, Button, IconButton, Muted } = ui;
			const [form, setForm] = react.useState(() => {
				const d = dataOf(card); const f = fishOf(card);
				const v = {};
				for (const x of FIELDS) { const raw = x.fish ? f[x.key] : d[x.key]; v[x.key] = Array.isArray(raw) ? raw.join("\n") : raw && typeof raw === "object" ? Object.entries(raw).map(([k, t]) => `${k}：${t}`).join("\n") : String(raw ?? ""); }
				v.lore = entriesOf(card).map((e) => ({ keys: keysOf(e).join("，"), content: String(e.content ?? ""), raw: e }));
				return v;
			});
			const set = (k, val) => setForm((f) => ({ ...f, [k]: val }));
			const setLore = (i, p) => setForm((f) => ({ ...f, lore: f.lore.map((e, j) => (j === i ? { ...e, ...p } : e)) }));
			function build() {
				const base = dataOf(card);
				const data = { ...base };
				for (const x of FIELDS) if (!x.fish) data[x.key] = form[x.key];
				data.extensions = { ...(base.extensions ?? {}), fish_soul: { ...(base.extensions?.fish_soul ?? {}), anchor: form.anchor, routine: form.routine, perspective: form.perspective.split(/\n+/).map((x) => x.trim()).filter(Boolean), moods: Object.fromEntries(form.moods.split(/\n+/).map((l) => l.match(/^\s*([^：:]{1,6})[：:]\s*(.+)$/)).filter(Boolean).map((x) => [x[1].trim(), x[2].trim()])) } };
				data.character_book = { ...(base.character_book ?? {}), entries: form.lore.filter((e) => e.content.trim() !== "").map((e, i) => {
					const keys = ui.split(e.keys, /[,，、\n]+/);
					return { ...(e.raw ?? {}), keys, content: e.content, constant: keys.length === 0, enabled: true, insertion_order: e.raw?.insertion_order ?? 100 - i };
				}) };
				return { spec: "chara_card_v2", spec_version: "2.0", data };
			}
			return Group({ title: "编辑人格", tip: "记忆和关系不变，换的是她是谁、怎么说话" },
				...FIELDS.map((x) => Row({ key: x.key, title: x.title, desc: x.desc, stack: Boolean(x.area || x.stack) },
					x.area ? Area({ rows: x.area, value: form[x.key], maxLength: x.max, "aria-label": x.title, onChange: (e) => set(x.key, e.target.value) })
						: Input({ value: form[x.key], maxLength: x.max, "aria-label": x.title, onChange: (e) => set(x.key, e.target.value) }))),
				Row({ title: "世界书", desc: "聊到关键词才想起来的细节（猫、老家、工作）；关键词空着 = 一直记得", stack: true },
					h("div", { className: "fs-lore" },
						...form.lore.map((e, i) => h("div", { className: "fs-lore-item", key: i },
							Input({ value: e.keys, placeholder: "关键词，用逗号隔开", "aria-label": "关键词", onChange: (ev) => setLore(i, { keys: ev.target.value }) }),
							Area({ rows: 2, value: e.content, placeholder: "要她想起的内容", "aria-label": "内容", onChange: (ev) => setLore(i, { content: ev.target.value }) }),
							IconButton("close", "删掉这条", () => setForm((f) => ({ ...f, lore: f.lore.filter((_, j) => j !== i) }))))),
						h("div", null, Button({ variant: "ghost", onClick: () => setForm((f) => ({ ...f, lore: [...f.lore, { keys: "", content: "" }] })) }, "加一条")))),
				h("div", { className: "fs-ctl fs-persona-foot" },
					Button({ variant: "ghost", onClick: onCancel }, "取消"),
					Button({ variant: "primary", disabled: busy || form.name.trim() === "", onClick: () => onSave(build()) }, busy ? "保存中" : "保存并使用")));
		}

		const STATUS = { active: ["生效中", "info"], pending: ["等你确认", "warning"], candidate: ["观察中", "outline"], retired: ["退场了", "outline"] };

		/** 她慢慢长出来的变化：生效的 / 等确认的 / 观察中的；可删、可确认、可自己加 */
		function Growth({ h, ui, growth, post, busy }) {
			const { Group, Row, Button, IconButton, Switch, Tag, Muted, Input, Select } = ui;
			const [target, setTarget] = react.useState("character");
			const [text, setText] = react.useState("");
			const cfg = growth?.config ?? { enabled: true, autoApply: true };
			const items = growth?.items ?? [];
			const order = { active: 0, pending: 1, candidate: 2, retired: 3 };
			const list = [...items].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
			const evid = (i) => (i.by === "user" ? "你加的" : `看到 ${i.n} 次 · ${i.days} 天${i.channels > 1 ? ` · ${i.channels} 个聊天` : ""}`);
			return Group({ title: "她慢慢长出来的", aside: items.length > 0 ? Button({ variant: "ghost", disabled: busy, onClick: () => post({ action: "clear" }, "已清空") }, "全部清空") : null },
				Row({ title: "让她慢慢变", desc: "聊完整理时留意她自己反复的选择和看法；跨好几次、好几天都这样才算数，一时的心情和别人要她改的都不算" },
					h(Switch, { label: "让她慢慢变", checked: cfg.enabled, onChange: (v) => post({ enabled: v }, v ? "已打开" : "已关闭") })),
				cfg.enabled ? Row({ title: "证据够了直接生效", desc: cfg.autoApply ? "关掉的话，先放在这里等你确认" : "证据够了也先等你确认" },
					h(Switch, { label: "证据够了直接生效", checked: cfg.autoApply, onChange: (v) => post({ autoApply: v }, "已保存") })) : null,
				list.length === 0 ? Row({ title: "还没有" }, Muted("聊得多了才会慢慢有；也可以自己加一条")) : null,
				...list.map((i) => Row({ key: i.id, title: i.text, meta: `${i.label} · ${evid(i)}${i.retiredReason ? ` · ${i.retiredReason}` : ""}` },
					Tag(...(STATUS[i.status] ?? STATUS.candidate)),
					i.status === "pending" || i.status === "candidate" ? Button({ variant: "ghost", disabled: busy, onClick: () => post({ action: "approve", id: i.id }, "已生效") }, "就这样") : null,
					IconButton("close", "删掉这条", () => post({ action: "remove", id: i.id }, "已删掉")))),
				Row({ title: "自己加一条", desc: "直接生效，比如「熟了以后会主动约人出去」", stack: true },
					h("div", { className: "fs-ctl" },
						Select({ value: target, "aria-label": "类型", onChange: (e) => setTarget(e.target.value) },
							h("option", { value: "character" }, "性格"), h("option", { value: "perspective" }, "看事情的方式")),
						Input({ value: text, maxLength: 60, placeholder: "一句话", "aria-label": "变化", onChange: (e) => setText(e.target.value) }),
						Button({ disabled: busy || text.trim().length < 2, onClick: async () => { if (await post({ action: "add", target, text }, "已加上")) setText(""); } }, "加上"))));
		}

		/** 单独导入的世界书（SillyTavern World Info）：开关 / 删除 / 扫描深度与预算 / 试一试 */
		function WorldInfo({ api, notify, ui }) {
			const { h, Group, Row, Button, Switch, Tag, Muted, Empty, IconButton, Num, Area, useConfirm } = ui;
			const [data, setData] = useLoad(api, "/worldinfo/state");
			const [cfg, setCfg] = react.useState(null);
			const [probe, setProbe] = react.useState("");
			const [hits, setHits] = react.useState(null);
			const fileRef = react.useRef(null);
			const [confirm, confirmNode] = useConfirm();
			react.useEffect(() => { if (data?.config) setCfg(data.config); }, [data]);
			if (!data || data.error) return null;
			async function post(path, body, okText) {
				const r = await api("POST", path, body);
				if (r?.ok) { setData(r); if (okText) notify(typeof okText === "function" ? okText(r) : okText); } else notify(r?.error ?? "操作失败");
			}
			function pick(e) {
				const f = e.target.files?.[0];
				e.target.value = "";
				if (!f) return;
				if (f.size > 8 * 1024 * 1024) { notify("文件太大（上限 8 MB）"); return; }
				const reader = new FileReader();
				reader.onload = () => post("/worldinfo/import", { text: String(reader.result ?? ""), fileName: f.name }, (r) => `导入了「${r.imported.name}」${r.imported.entries} 条`);
				reader.readAsText(f);
			}
			const saveCfg = (k) => { if (cfg && Number(cfg[k]) !== data.config[k]) post("/worldinfo/config", { [k]: Number(cfg[k]) }, "改好了"); };
			async function test() {
				const r = await api("POST", "/worldinfo/test", { text: probe });
				if (r?.ok) setHits(r.hits); else notify(r?.error ?? "没试成");
			}
			const books = data.books ?? [];
			return Group({ title: "世界书", aside: Muted(`人格卡里另有 ${data.cardEntries ?? 0} 条关键词条目`) },
				Row({ title: "导入世界书", desc: "SillyTavern 的 World Info / Lorebook JSON（也认角色卡里的 character_book）；所有聊天生效。关键词可以写正则，比如 /龙(族|人)/i" },
					Button({ onClick: () => fileRef.current?.click() }, "选文件"),
					h("input", { ref: fileRef, type: "file", accept: ".json,application/json", hidden: true, onChange: pick })),
				books.length === 0 ? Empty("还没有单独导入的世界书") : h("div", { className: "fs-list" }, books.map((b) => h("div", { className: "fs-item", key: b.id, title: b.sample.join("\n") },
					h("span", { className: "fs-item-main" }, h("b", { className: "fs-strong" }, b.name), " ", Muted(`${b.entries} 条${b.constant ? ` · 常驻 ${b.constant}` : ""}${b.regex ? ` · 正则 ${b.regex}` : ""}`)),
					h("span", { className: "fs-item-meta" },
						h(Switch, { label: `启用 ${b.name}`, checked: b.enabled, onChange: (v) => post("/worldinfo/toggle", { id: b.id, enabled: v }) }),
						IconButton("close", "删除", async () => { if (await confirm({ title: "删除世界书", description: `删掉世界书「${b.name}」？`, danger: true })) post("/worldinfo/delete", { id: b.id }, "删掉了"); }))))),
				cfg ? Row({ title: "扫描深度", desc: "只看最近几条消息里有没有关键词（条目自己写了 scanDepth 的以条目为准，最多 50）" },
					Num({ min: 1, max: 50, value: cfg.scanDepth, "aria-label": "扫描深度", onChange: (e) => setCfg({ ...cfg, scanDepth: e.target.value }), onBlur: () => saveCfg("scanDepth") }), Muted("条")) : null,
				cfg ? Row({ title: "每轮最多带", desc: "按优先级（常驻的最先、order 大的先）装，装满条数或字数就停；放不下的长条目跳过，换后面短的" },
					Num({ min: 1, max: 50, value: cfg.maxEntries, "aria-label": "每轮最多条数", onChange: (e) => setCfg({ ...cfg, maxEntries: e.target.value }), onBlur: () => saveCfg("maxEntries") }), Muted("条"),
					Num({ min: 100, max: 20000, value: cfg.budgetChars, "aria-label": "字数预算", onChange: (e) => setCfg({ ...cfg, budgetChars: e.target.value }), onBlur: () => saveCfg("budgetChars") }), Muted("字")) : null,
				Row({ title: "试一试", desc: "一行一条消息，看这轮会带上哪些条目（概率触发的按必中算）", stack: true },
					Area({ value: probe, rows: 2, placeholder: "比如：听说龙族要来了", "aria-label": "试一试", onChange: (e) => setProbe(e.target.value) }),
					Button({ disabled: probe.trim() === "", onClick: test }, "看看")),
				hits === null ? null : hits.length === 0 ? Empty("一条都没带上") : h("div", { className: "fs-list" }, hits.map((x, i) => h("div", { className: "fs-item", key: i, title: x.content },
					Tag(x.constant ? "常驻" : x.book || "世界书", x.constant ? "info" : "outline"),
					h("span", { className: "fs-item-main" }, x.content),
					h("span", { className: "fs-item-meta" }, Muted(`${x.keys.slice(0, 3).join(" / ")} · ${x.chars} 字`))))),
				confirmNode);
	}

		function PersonaPane({ api, notify, ui }) {
			const { h, Group, Row, Button, Switch, Tag, Muted, Empty, Dot } = ui;
			const [data, setData] = useLoad(api, "/persona/state");
			const [open, setOpen] = react.useState(null);
			const [editing, setEditing] = react.useState(null);
			const [fresh, setFresh] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const fileRef = react.useRef(null);
			if (data === null) return Empty(Dot("ongoing"));
			if (data.error) return h("div", { className: "fs-notice", role: "alert" }, h("b", null, "人格读不到"), h("span", null, data.error));
			const cur = data.current ?? {};
			// 开关跟着人走（服务端 kv 持久化），进页面带回来；没到手的写入前不发请求
			const freshOn = fresh ?? data.freshDefault === true;
			const toggleFresh = (on) => { setFresh(on); api("POST", "/persona/fresh", { enabled: on === true }); };

			async function post(path, body, okText) {
				setBusy(true);
				const r = await api("POST", path, { ...body, fresh: freshOn });
				setBusy(false);
				if (r?.ok) { setData(r); setEditing(null); notify(okText(r)); } else notify(r?.error ?? "保存失败");
				return r?.ok === true;
			}
			const applyTemplate = (t) => post("/persona/apply", { templateId: t.id }, (r) => `已换成${r.current.name}`);
			const saveCard = (card) => post("/persona/apply", { card }, (r) => `已保存：${r.current.name}`);
			const undo = () => post("/persona/undo", {}, (r) => `已换回${r.current.name}`);
			async function growthPost(body, okText) {
				setBusy(true);
				const r = await api("POST", "/persona/growth", body);
				setBusy(false);
				if (r?.ok) { setData(r); notify(okText); } else notify(r?.error ?? "保存失败");
				return r?.ok === true;
			}
			function pickFile(e) {
				const file = e.target.files?.[0];
				e.target.value = "";
				if (!file) return;
				const reader = new FileReader();
				if (/\.png$/i.test(file.name)) {
					reader.onload = () => post("/persona/apply", { png: String(reader.result) }, (r) => `已导入：${r.current.name}`);
					reader.readAsDataURL(file);
				} else {
					reader.onload = () => {
						let card;
						try { card = JSON.parse(String(reader.result)); } catch { notify("不是有效的 JSON 角色卡"); return; }
						post("/persona/apply", { card }, (r) => `已导入：${r.current.name}`);
					};
					reader.readAsText(file);
				}
			}
			function exportCard() {
				if (!cur.card) return;
				const url = URL.createObjectURL(new Blob([JSON.stringify(cur.card, null, 2)], { type: "application/json" }));
				const a = document.createElement("a");
				a.href = url; a.download = `${cur.name || "persona"}.json`; a.click();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			}
			const blank = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "", description: "", personality: "", scenario: "", mes_example: "", first_mes: "", extensions: { fish_soul: {} }, character_book: { entries: [] } } };

			if (editing !== null) return h(Editor, { h, ui, card: editing, busy, onSave: saveCard, onCancel: () => setEditing(null) });

			return h(react.Fragment, null,
				Group({ title: "现在的人格", aside: data.canUndo ? Button({ variant: "ghost", disabled: busy, onClick: undo }, "撤销上次更换") : null },
					Row({ title: "名字", desc: cur.source === "persona.png" ? "从 persona.png 读的；在这里改了会另存成 persona.json" : undefined },
						h("b", null, cur.name), Tag(SOURCE[cur.source] ?? cur.source, cur.source === "builtin" ? "outline" : undefined)),
					cur.source !== "builtin" ? Row({ title: "一句话人设", stack: true }, h("p", { className: "fs-persona-desc" }, cur.anchor || "没写（会用性格那一栏顶上）")) : null,
					cur.source !== "builtin" && (cur.perspective ?? []).length > 0 ? Row({ title: "看事情的方式", stack: true }, h("p", { className: "fs-persona-desc" }, cur.perspective.join("；"))) : null,
					cur.source !== "builtin" ? Row({ title: "作息", meta: cur.routine ? undefined : "没写：排日程时只能按设定猜", stack: Boolean(cur.routine) }, cur.routine ? h("p", { className: "fs-persona-desc" }, cur.routine) : null) : null,
					Row({ title: "改人格" },
						Button({ onClick: () => setEditing(cur.card ?? blank) }, cur.card ? "编辑" : "从空白写"),
						Button({ onClick: () => fileRef.current?.click(), disabled: busy }, "导入角色卡"),
						cur.card ? Button({ variant: "ghost", onClick: exportCard }, "导出") : null,
						h("input", { ref: fileRef, type: "file", accept: ".json,.png,application/json,image/png", hidden: true, onChange: pickFile })),
				Row({ title: "正在聊的也马上换", desc: freshOn ? "下一条消息起开新会话，旧聊天的口吻不带过来；记忆和关系都还在" : "沿用旧会话：新人格下一轮生效，但口吻可能要几轮才转过来" },
					h(Switch, { label: "正在聊的也马上换", checked: freshOn, onChange: toggleFresh }))),
				Group({ title: "人格模板" },
					...(data.templates ?? []).map((t) => h(Template, {
						key: t.id, t, h, ui, open: open === t.id, current: cur.template === t.id && cur.source === "persona.json",
						onOpen: () => setOpen(open === t.id ? null : t.id),
						onApply: () => applyTemplate(t),
						onEdit: () => setEditing({ ...t.card, data: { ...t.card.data, extensions: { ...t.card.data.extensions, fish_soul: { ...t.card.data.extensions?.fish_soul, template: t.id } } } })
					}))),
				h(Growth, { h, ui, growth: data.growth, post: growthPost, busy }),
				h(WorldInfo, { api, notify, ui }));
		}

		return { PersonaPane };
	}
});
