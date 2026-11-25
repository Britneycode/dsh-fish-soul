/**
 * dsh-fish-soul — 设置面板「运行日志」页（client.diag.js，按需加载的包内分块）
 *
 * 主面板 client.js 用 require.async("./client.diag.js") 拿到 DiagPane；
 * api / notify / 控件（props.ui）都由主面板传进来，分块自己不 require 主文件。
 *
 * 🔴 必须走 window.__ModuleLoader__.load 注册：裸 ES module 宿主能加载文件，
 *    但不会注册，设置页报 "loaded without registering"（2026-11-12 真机踩过）。
 *
 * 两个视图共用一份数据：
 *   - 默认中文时间线：给用户看，也方便原样贴到 issue；
 *   - 「看原始」切 JSON：给维护者 grep。
 *
 * 这里只放**装置层面**的事件（启动卡在哪、人格段挂不上、会话恢复失败、上下文长度）。
 * 对话层面的「谁说了什么、想起了几条」在「日常 → 最近动态」那边 —— 一事实一出处。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	chunk: "client.diag.js",
	factory: (require) => {
		const react = require("react");

		/** 跟 ActivityPane 一样的轮询小工具（各分块页各有一份，不跨块 import）。 */
		function usePoll(api, path, ms) {
			const [data, setData] = react.useState(null);
			const [err, setErr] = react.useState("");
			const load = react.useCallback(async (guard) => {
				const r = await api("GET", path);
				if (guard && !guard()) return;
				if (r?.ok) { setData(r); setErr(""); }
				else setErr(r?.error ?? "日志读取失败");
			}, [api, path]);
			react.useEffect(() => {
				let alive = true;
				const run = () => load(() => alive);
				run();
				const t = setInterval(run, ms);
				return () => { alive = false; clearInterval(t); };
			}, [load, ms]);
			return [data, () => load(), err];
		}

		function DiagPane({ api, notify, ui }) {
			const { h, Group, Tag, Button, useConfirm = () => [async () => true, null] } = ui;
			const [raw, setRaw] = react.useState(false);
			const [data, load, err] = usePoll(api, "/diag-log", 15000);
			const [confirm, confirmNode] = useConfirm();
			if (!data) {
				if (err) return h("div", { className: "fs-notice", role: "alert" }, h("b", null, "运行日志读取失败"), h("span", null, err), Button({ onClick: load }, "重试"));
				return h("div", { className: "fs-empty" }, "加载中…");
			}

			const entries = data.entries ?? [];
			const pad = (n) => String(n).padStart(2, "0");
			const fmtTime = (ms) => {
				const d = new Date(ms);
				return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
			};
			// 一行中文：时间 + 说人话的标题 + 细节
			const describe = (e) => {
				const d = e.detail ?? {};
				const bits = [];
				if (d.step !== undefined) bits.push(`第 ${d.step} 步${d.name ? `「${d.name}」` : ""}`);
				if (d.sessionId) bits.push(`会话 ${String(d.sessionId).slice(0, 12)}…`);
				if (d.channelId) bits.push(`聊天 ${d.channelId}`);
				if (d.count !== undefined) bits.push(`${d.count} 条`);
				if (d.chars !== undefined) bits.push(`${d.chars} 字${d.budget ? ` / 预算 ${d.budget}` : ""}${d.over80 ? " · 超 80%" : ""}`);
				if (d.code) bits.push(`错误码 ${String(d.code).slice(0, 48)}`);
				if (d.reason) bits.push(String(d.reason).slice(0, 120));
				if (d.error) bits.push(String(d.error).slice(0, 120));
				if (e.count > 1) bits.push(`重复 ${e.count} 次`);
				return bits.join("，") || "无细节";
			};
			const copy = async () => {
				try { await navigator.clipboard.writeText(JSON.stringify(entries, null, 2)); notify("已复制"); }
				catch { notify("复制失败，手动选中复制"); }
			};
			const clearLogs = async () => {
				if (!(await confirm({ title: "清空运行日志", description: "清空当前的运行记录？", danger: true }))) return;
				const r = await api("POST", "/diag-log/clear", {});
				if (r?.ok) { notify("已清空"); load(); } else notify(r?.error ?? "清空失败");
			};

			return Group({
				title: "最近 200 条",
				tip: "插件启动步骤、人格卡挂载与每轮上下文长度，仅留内存不落盘",
				aside: h("span", { className: "fs-group-aside" },
					Tag(String(entries.length), "outline"),
					Button({ onClick: () => load() }, "刷新"),
					Button({ disabled: entries.length === 0, onClick: copy }, "复制"),
					Button({ "aria-pressed": raw, onClick: () => setRaw((v) => !v) }, raw ? "看时间线" : "看原始"),
					Button({ variant: "danger", disabled: entries.length === 0, onClick: clearLogs }, "清空"))
			},
				entries.length === 0
					? h("div", { className: "fs-empty" }, "还没有记录。重启宿主后回来就能看到启动过程。")
					: raw
						? h("pre", { className: "fs-report fs-diag-raw" }, JSON.stringify(entries, null, 2))
						: h("div", { className: "fs-diag-list" },
							entries.map((e, i) => h("div", { key: `${e.at}-${e.key ?? i}`, className: "fs-diag-row" },
								h("span", { className: "fs-diag-time" }, fmtTime(e.at)),
								e.level === "error" ? Tag("错误", "danger") : e.level === "warn" ? Tag("警告", "warning") : null,
								h("span", { className: "fs-diag-label", "data-level": e.level }, e.label),
								h("span", { className: "fs-diag-detail" }, describe(e))))),
				confirmNode);
		}

		return { DiagPane };
	}
});
