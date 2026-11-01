/**
 * dsh-fish-soul — 设置面板「习惯」页（client.behavior.js，按需加载的包内分块）
 *
 * 心情影响行为 / 每轮判断心情 / 去 AI 味、QQ 小习惯（合并转发、戳回去、表情回应、正在输入、群里冷热）、
 * 每个群的群设定、聊天用哪个模型（私聊 / 群聊默认 + 单个聊天）、每日日记。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	chunk: "client.behavior.js",
	factory: (require) => {
		const react = require("react");
		const SEP = "\u0001";
		const HEAT = { hot: ["热闹", "warning"], cooling: ["冷却中", "info"], diving: ["潜水", "outline"], off: ["没开", "outline"] };

		function useLoad(api, path) {
			const [data, setData] = react.useState(null);
			const load = react.useCallback(async () => { const r = await api("GET", path); if (r?.ok !== false) setData(r); else setData((d) => d ?? { error: r?.error }); }, [api, path]);
			react.useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
			return [data, load];
		}

		/** 失焦才保存的数字框 */
		function NumField({ value, min, max, step, label, onSave, ui }) {
			const [v, setV] = react.useState(String(value));
			react.useEffect(() => { setV(String(value)); }, [value]);
			return ui.Num({ value: v, min, max, step, "aria-label": label, onChange: (e) => setV(e.target.value), onBlur: () => { if (v !== String(value) && v !== "") onSave(Number(v)); } });
		}

		/** 心情和说话 + QQ 小习惯 */
		function Habits({ cfg, save, ui }) {
			const { h, Group, Row, Switch, Muted } = ui;
			const ia = cfg.interactions; const ht = cfg.heat;
			const pct = (x) => Math.round(x * 100);
			return h(react.Fragment, null,
				Group({ title: "心情和说话" },
					Row({ title: "心情影响行为", desc: "今天的基调和她对这个人的情绪，会让她回得快或慢、插话多或少、表情包和语音多或少" },
						h(Switch, { label: "心情影响行为", checked: cfg.moodAffects, onChange: (v) => save({ moodAffects: v }) })),
					Row({ title: "每轮判断心情", desc: cfg.turnMood.enabled ? "每条消息多调一次模型（「模型」页里「每轮判断心情」选的那个）" : "默认关：情绪只在聊完整理时更新" },
						h(Switch, { label: "每轮判断心情", checked: cfg.turnMood.enabled, onChange: (v) => save({ turnMood: { enabled: v } }) })),
					cfg.turnMood.enabled ? Row({ title: "把握够多少才改", desc: "模型给的把握低于这个就不改情绪" },
						h(NumField, { ui, value: pct(cfg.turnMood.minConfidence), min: 0, max: 100, step: 5, label: "把握门槛", onSave: (n) => save({ turnMood: { minConfidence: n / 100 } }) }), Muted("%")) : null,
					Row({ title: "去 AI 味", desc: "发出去之前去掉\"作为 AI / 综上所述 / 希望对你有帮助 / 首先其次\"和 markdown，太长的截到句末" },
						h(Switch, { label: "去 AI 味", checked: cfg.outFilter.enabled, onChange: (v) => save({ outFilter: { enabled: v } }) })),
					cfg.outFilter.enabled ? Row({ title: "一次最多说多少字" },
						h(NumField, { ui, value: cfg.outFilter.maxChars, min: 60, max: 2000, step: 10, label: "最多字数", onSave: (n) => save({ outFilter: { maxChars: n } }) }), Muted("字")) : null),
				Group({ title: "QQ 小习惯" },
					Row({ title: "看合并转发", desc: "展开一层，最多看前几条" },
						h(Switch, { label: "看合并转发", checked: cfg.forward.enabled, onChange: (v) => save({ forward: { enabled: v } }) })),
					Row({ title: "被戳了戳回去", desc: ia.pokeBack ? `有 ${pct(ia.pokeBackChance)}% 的时候戳回去（SnowLuma 不支持就算了）` : undefined },
						ia.pokeBack ? h(NumField, { ui, value: pct(ia.pokeBackChance), min: 0, max: 100, step: 10, label: "戳回去的概率", onSave: (n) => save({ interactions: { pokeBackChance: n / 100 } }) }) : null,
						ia.pokeBack ? Muted("%") : null,
						h(Switch, { label: "被戳了戳回去", checked: ia.pokeBack, onChange: (v) => save({ interactions: { pokeBack: v } }) })),
					Row({ title: "群里点表情回应", desc: ia.react ? `叫她的那条，有 ${pct(ia.reactChance)}% 的时候点个表情（生气时不点）` : "默认关" },
						ia.react ? h(NumField, { ui, value: pct(ia.reactChance), min: 0, max: 100, step: 10, label: "表情回应的概率", onSave: (n) => save({ interactions: { reactChance: n / 100 } }) }) : null,
						ia.react ? Muted("%") : null,
						h(Switch, { label: "群里点表情回应", checked: ia.react, onChange: (v) => save({ interactions: { react: v } }) })),
					Row({ title: "私聊显示正在输入" },
						h(Switch, { label: "私聊显示正在输入", checked: ia.typing, onChange: (v) => save({ interactions: { typing: v } }) })),
					Row({ title: "群里冷热", desc: ht.enabled ? `${Math.round(ht.windowSec / 60)} 分钟内有 ${ht.hotCount} 条、${ht.hotSpeakers} 个人在说就算热闹，插话概率 ×${ht.boost}；她说完话 ${ht.coolMinutes} 分钟内慢慢恢复` : "插话只看概率和冷却" },
						ht.enabled ? h(NumField, { ui, value: ht.hotCount, min: 3, max: 50, step: 1, label: "热闹的条数", onSave: (n) => save({ heat: { hotCount: n } }) }) : null,
						ht.enabled ? Muted("条") : null,
						h(Switch, { label: "群里冷热", checked: ht.enabled, onChange: (v) => save({ heat: { enabled: v } }) }))));
		}

		/** 每个群：群设定（失焦保存）+ 现在冷不冷 */
		function GroupNote({ g, api, notify, onSaved, ui }) {
			const { h, Area, Tag, Muted } = ui;
			const [text, setText] = react.useState(g.note);
			react.useEffect(() => { setText(g.note); }, [g.note]);
			async function save() {
				if (text.trim() === g.note) return;
				const r = await api("POST", "/groups/note", { groupId: g.groupId, note: text });
				if (r?.ok) { notify(r.note ? "群设定已保存" : "群设定已清空"); onSaved(); } else notify(r?.error ?? "保存失败");
			}
			const [label, tone] = HEAT[g.heat?.state] ?? HEAT.off;
			return h("div", { className: "fs-row stack", key: g.groupId },
				h("div", { className: "fs-row-title" }, h("span", null, g.title),
					h("span", { className: "fs-row-desc" }, Tag(label, tone), g.heat && g.heat.count > 0 ? Muted(` 最近 ${g.heat.count} 条 · ${g.heat.speakers} 人`) : null)),
				h("div", { className: "fs-ctl" }, Area({ value: text, rows: 2, maxLength: 500, "aria-label": `${g.title} 的群设定`,
					placeholder: "你在这个群是什么身份、气氛和忌讳（只在这个群里给她看），比如：考研群，你是过来人学姐，大家叫你鱼老师；别聊游戏",
					onChange: (e) => setText(e.target.value), onBlur: save })));
		}

		/** 聊天用哪个模型：私聊 / 群聊默认 + 单个聊天 */
		function ChatModels({ data, api, notify, load, ui }) {
			const { h, Group, Row, Select, Muted } = ui;
			const cm = data.chatModels ?? {};
			const providers = cm.providers ?? [];
			const host = cm.hostDefault;
			const val = (sel) => (sel ? `${sel.provider}${SEP}${sel.model}` : "");
			const parse = (v) => { if (v === "") return null; const [provider, model] = v.split(SEP); return { provider, model }; };
			async function post(body) {
				const r = await api("POST", "/chat-models/config", body);
				if (r?.ok) { notify("已保存，下一轮就用"); load(); } else notify(r?.error ?? "保存失败");
			}
			const options = (sel, empty) => {
				const opts = [h("option", { key: "", value: "" }, empty)];
				for (const p of providers) opts.push(h("optgroup", { key: p.id, label: p.name }, (p.models ?? []).map((m) => h("option", { key: m.id, value: `${p.id}${SEP}${m.id}` }, m.name || m.id))));
				if (sel && !providers.some((p) => p.id === sel.provider && (p.models ?? []).some((m) => m.id === sel.model))) opts.push(h("option", { key: "__x", value: val(sel) }, `${sel.model}（现在找不到）`));
				return opts;
			};
			const hostText = host ? `跟 DSH 默认（${host.model}）` : "跟 DSH 默认";
			const cfg = cm.config ?? {};
			const chats = cm.chats ?? [];
			return Group({ title: "聊天用哪个模型", aside: Muted("单个聊天 → 私聊 / 群聊默认 → DSH 默认") },
				Row({ title: "私聊默认", desc: "QQ / B站 / 抖音私信" }, Select({ value: val(cfg.private), "aria-label": "私聊默认", onChange: (e) => post({ private: parse(e.target.value) }) }, ...options(cfg.private, hostText))),
				Row({ title: "群聊默认" }, Select({ value: val(cfg.group), "aria-label": "群聊默认", onChange: (e) => post({ group: parse(e.target.value) }) }, ...options(cfg.group, hostText))),
				...chats.map((c) => Row({ title: c.title, key: c.channelId, desc: c.override ? undefined : c.resolved ? `现在用 ${c.resolved.model}` : undefined },
					Select({ value: val(c.override), "aria-label": `${c.title} 用的模型`, onChange: (e) => post({ channelId: c.channelId, selection: parse(e.target.value) }) },
						...options(c.override, c.channelId.startsWith("group:") ? "跟群聊默认" : "跟私聊默认")))));
		}

		/** 每日日记 */
		function Diary({ data, save, api, notify, load, relTime, ui }) {
			const { h, Group, Row, Switch, Muted, Button, Empty, Tag } = ui;
			const d = data.diary;
			const [busy, setBusy] = react.useState(false);
			if (!d) return null;
			const c = data.config.diary;
			async function writeNow() {
				setBusy(true);
				const r = await api("POST", "/diary/write-now", {});
				setBusy(false);
				if (r?.ok) { notify("写好了"); load(); } else notify(r?.error ?? "没写成");
			}
			const topics = d.topics?.items ?? [];
			const now = Date.now();
			return Group({ title: "日记", aside: Button({ variant: "ghost", disabled: busy, onClick: writeNow }, busy ? "在写…" : "现在写一篇") },
				Row({ title: "每晚写日记", desc: "记成她自己的私密记忆（群里不会想起），顺便想想明天想跟谁聊什么" },
					h(Switch, { label: "每晚写日记", checked: c.enabled, onChange: (v) => save({ diary: { enabled: v } }) })),
				c.enabled ? Row({ title: "几点写" }, h(NumField, { ui, value: c.hour, min: 18, max: 23, step: 1, label: "几点写", onSave: (n) => save({ diary: { hour: n } }) }), Muted("点以后（她的时间）")) : null,
				Row({ title: "发到 QQ 空间", desc: "默认关；SnowLuma 不支持的话会在动态里记一条失败" },
					h(Switch, { label: "发到 QQ 空间", checked: c.qzone, onChange: (v) => save({ diary: { qzone: v } }) })),
				topics.length === 0 ? null : h("div", { className: "fs-list" }, topics.map((x, i) => h("div", { className: "fs-item", key: `t${i}` },
					Tag("想聊", "info"), h("span", { className: "fs-item-main" }, `${x.who ? `${x.who}：` : ""}${x.topic}`)))),
				h("div", { className: "fs-list" }, (d.entries ?? []).length === 0 ? Empty("还没写过日记")
					: d.entries.map((e) => h("div", { className: "fs-item", key: e.id, title: e.content },
						h("span", { className: "fs-item-main" }, e.content.replace(/^\d{4}-\d{2}-\d{2} 的日记：/, "")),
						h("span", { className: "fs-item-meta" }, h("span", null, relTime(e.at, now)))))));
		}

		function BehaviorPane({ api, notify, relTime, ui }) {
			const { h, Empty, Dot, Group } = ui;
			const [data, load] = useLoad(api, "/behavior/state");
			if (data === null) return Empty(Dot("ongoing"));
			if (data.error) return h("div", { className: "fs-notice", role: "alert" }, h("b", null, "习惯设置读不到"), h("span", null, data.error));
			async function save(patch) {
				const r = await api("POST", "/behavior/config", patch);
				if (r?.ok) load(); else notify(r?.error ?? "保存失败");
			}
			const groups = data.groups ?? [];
			return h(react.Fragment, null,
				h(Habits, { cfg: data.config, save, ui }),
				Group({ title: "每个群" }, groups.length === 0 ? Empty("还没有群（在 QQ 页填群白名单，或者等群里有人叫她）")
					: groups.map((g) => h(GroupNote, { key: g.groupId, g, api, notify, onSaved: load, ui }))),
				h(ChatModels, { data, api, notify, load, ui }),
				h(Diary, { data, save, api, notify, load, relTime, ui }));
		}

		return { BehaviorPane };
	}
});
