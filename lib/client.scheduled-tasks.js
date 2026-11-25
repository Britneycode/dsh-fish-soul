/**
 * dsh-fish-soul — 设置面板「日常 → 定时任务」页（client.scheduled-tasks.js，按需加载的包内分块）
 *
 * 主面板 client.js 用 require.async("./client.scheduled-tasks.js") 拿到 ScheduledTasksPane；
 * api / notify / 控件（props.ui）都由主面板传进来，分块自己不 require 主文件。
 *
 * 🔴 必须走 window.__ModuleLoader__.load 注册：裸 ES module 宿主能加载文件，但不会注册，
 *    设置页会报 "loaded without registering"（2026-11-12 真机踩过）。
 *
 * 这一页是「用户自己排的自动化任务」（#190）：
 *   - 增删改查全在这里（AI 那边只能看和改，不能建也不能删）；
 *   - 「回复发到哪儿」只给真实的可选目标（主人私聊 / 主动开口白名单里的自建群），不让手填 id；
 *   - 时间按角色时区（UTC+8）显示与填写 —— 面板里的 datetime-local 值就是角色时区的字面量，
 *     浏览器本地时区不参与，免得同一个时间在面板和服务端对不上。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	chunk: "client.scheduled-tasks.js",
	factory: (require) => {
		const react = require("react");

		const RECURRENCES = [
			{ value: "once", label: "仅一次" },
			{ value: "interval", label: "每隔 N 分钟" },
			{ value: "daily", label: "每天" }
		];

		function ScheduledTasksPane({ api, notify, ui }) {
			const { h, Group, Row, Input, Num, Area, Select, Seg, Switch, Button, Tag, Muted, useConfirm } = ui;
			const [data, setData] = react.useState(null);
			const [form, setForm] = react.useState(null);
			const [confirm, confirmNode] = useConfirm();

			const load = react.useCallback(async () => {
				const r = await api("GET", "/scheduled-tasks/state");
				if (r?.ok) setData(r);
				else notify(r?.error ?? "读不到定时任务");
			}, [api, notify]);

			react.useEffect(() => { void load(); }, [load]);

			const tasks = data?.tasks ?? [];
			const destinations = data?.destinations ?? [];
			const patch = (p) => setForm((f) => ({ ...f, ...p }));

			const openNew = () => setForm({
				id: null, name: "", prompt: "", recurrence: "interval",
				at: "", intervalMinutes: 20, dailyHhmm: "08:00", target: destinations[0]?.id ?? ""
			});
			const openEdit = (t) => setForm({
				id: t.id, name: t.name, prompt: t.prompt, recurrence: t.recurrence,
				at: t.nextRunAtInput, intervalMinutes: t.intervalMinutes ?? 20,
				dailyHhmm: t.dailyHhmm ?? "08:00", target: t.target
			});

			async function save() {
				const v = form;
				if (v.name.trim() === "") { notify("任务名称不能为空"); return; }
				if (v.prompt.trim() === "") { notify("唤醒提示词不能为空"); return; }
				if (v.target === "") { notify("要选一个回复发到的地方"); return; }
				if (v.recurrence !== "daily" && v.at === "") { notify("要选一个时间"); return; }
				if (v.recurrence === "interval" && Number(v.intervalMinutes) < 1) { notify("间隔最少 1 分钟"); return; }
				const body = { name: v.name.trim(), prompt: v.prompt.trim(), recurrence: v.recurrence, target: v.target };
				if (v.recurrence === "daily") body.dailyHhmm = v.dailyHhmm;
				else {
					body.at = v.at;
					if (v.recurrence === "interval") body.intervalMinutes = Number(v.intervalMinutes);
				}
				const creating = v.id === null;
				if (!creating) body.id = v.id;
				const r = await api("POST", creating ? "/scheduled-tasks/create" : "/scheduled-tasks/update", body);
				if (r?.ok) { notify(creating ? "任务已加上" : "任务已改好"); setForm(null); await load(); }
				else notify(r?.error ?? "保存失败");
			}

			async function toggle(t, enabled) {
				const r = await api("POST", "/scheduled-tasks/toggle", { id: t.id, enabled });
				if (r?.ok) { notify(enabled ? "已开启" : "已关闭"); await load(); }
				else notify(r?.error ?? "改不动");
			}

			async function remove(t) {
				const ok = await confirm({
					title: `删掉「${t.name}」？`,
					description: "删了就再也不会按这个安排唤醒了。",
					confirmLabel: "删掉",
					danger: true
				});
				if (!ok) return;
				const r = await api("POST", "/scheduled-tasks/delete", { id: t.id });
				if (r?.ok) { notify("已删除"); await load(); }
				else notify(r?.error ?? "删除失败");
			}

			if (data === null) return null;

			const formView = form === null ? null : Group({
				title: form.id === null ? "新建定时任务" : `改任务：${form.name || form.id}`,
				aside: Button({ variant: "ghost", onClick: () => setForm(null) }, "取消")
			},
				Row({ title: "任务名称", desc: "用来分辨是哪件事" },
					Input({ value: form.name, placeholder: "比如：盯着服务器", onChange: (e) => patch({ name: e.target.value }) })),
				Row({ title: "唤醒提示词", desc: "到点时她要做什么 —— 写成一句交代给她的话" },
					Area({ value: form.prompt, rows: 3, placeholder: "比如：看看我的服务器有没有挂，挂了跟我说一声", onChange: (e) => patch({ prompt: e.target.value }) })),
				Row({ title: "重复方式" },
					Seg({ options: RECURRENCES, value: form.recurrence, onChange: (v) => patch({ recurrence: v }) })),
				form.recurrence === "daily"
					? Row({ title: "每天几点" }, Input({ type: "time", value: form.dailyHhmm, onChange: (e) => patch({ dailyHhmm: e.target.value }) }))
					: Row({ title: "首次时间", desc: "按角色时区（东八区）" }, Input({ type: "datetime-local", value: form.at, onChange: (e) => patch({ at: e.target.value }) })),
				form.recurrence === "interval"
					? Row({ title: "每隔多少分钟", desc: "最少 1 分钟" }, Num({ value: form.intervalMinutes, min: 1, max: 43200, onChange: (e) => patch({ intervalMinutes: e.target.value }) }))
					: null,
				Row({ title: "回复发到哪儿" },
					destinations.length === 0
						? Muted("还没有可选的位置 —— 去「日常 → 主动开口」配一下主人私聊或自建群")
						: Select({ value: form.target, onChange: (e) => patch({ target: e.target.value }) },
							...destinations.map((d) => h("option", { value: d.id, key: d.id }, d.label)))),
				Row({ title: "定时", desc: "到点她按提示词做事，回复发到上面选的地方" },
					Button({ variant: "primary", onClick: () => { void save(); } }, form.id === null ? "加上任务" : "保存修改"))
			);

			return h("div", null,
				Group({
					title: "定时任务",
					aside: h("span", { style: { display: "flex", gap: 8, alignItems: "center" } },
						Tag(String(tasks.length), "outline"),
						Button({ variant: "ghost", onClick: () => { void load(); } }, "刷新"),
						Button({ variant: "primary", onClick: openNew }, "新建任务"))
				},
					Muted("到点她会照你写的提示词做一件事，回复发到你选的地方。定时任务不占「主动开口」的每日配额，也不受活跃时段限制。"),
					tasks.length === 0
						? h("div", { className: "fs-empty" }, "还没有定时任务。点右上角「新建任务」加一个。")
						: h("div", { className: "fs-list" }, tasks.map((t) => h("div", { key: t.id },
							Row({
								title: t.name,
								desc: t.lastError === '' ? t.prompt : `${t.prompt}（上次没发出去：${t.lastError}）`,
								meta: `${t.scheduleLabel}｜${t.stateLabel}｜发到 ${t.targetLabel}`
							},
								Tag(t.enabled ? "开着" : "关着", t.enabled ? "success" : "outline"),
								Switch({ checked: t.enabled, label: `${t.name} 是否开启`, onChange: (v) => { void toggle(t, v); } }),
								Button({ variant: "ghost", onClick: () => openEdit(t) }, "改"),
								Button({ variant: "danger", onClick: () => { void remove(t); } }, "删")))))),
				formView,
				confirmNode
			);
		}

		return { ScheduledTasksPane };
	}
});
