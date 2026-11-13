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
			const load = react.useCallback(async () => {
				const r = await api("GET", path);
				if (r?.ok) setData(r);
			}, [api, path]);
			react.useEffect(() => {
				let alive = true;
				const run = async () => { if (alive) await load(); };
				run();
				const t = setInterval(run, ms);
				return () => { alive = false; clearInterval(t); };
			}, [load, ms]);
			return [data, load];
		}

		function DiagPane({ api, notify, ui }) {
			const { h, Group, Tag, Button, Muted } = ui;
			const [raw, setRaw] = react.useState(false);
			const [data, load] = usePoll(api, "/diag-log", 15000);
			if (!data) return null;

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
				if (d.chars !== undefined) bits.push(`${d.chars} 字${d.budget ? ` / 预算 ${d.budget}` : ""}${d.over80 ? "（超 80%）" : ""}`);
				if (d.reason) bits.push(String(d.reason).slice(0, 120));
				if (d.error) bits.push(String(d.error).slice(0, 120));
				if (e.count > 1) bits.push(`重复 ${e.count} 次`);
				return bits.join("，") || "（没有细节）";
			};
			const levelStyle = (lv) => (lv === "error"
				? { color: "var(--dsw-alias-state-error-primary, #d93025)" }
				: lv === "warn" ? { color: "var(--dsw-alias-state-warning-primary, #b26a00)" } : null);

			return Group({
				title: "运行日志",
				aside: h("span", { style: { display: "flex", gap: 8, alignItems: "center" } },
					Tag(String(entries.length), "outline"),
					Button({ variant: "ghost", onClick: () => load() }, "刷新"),
					Button({ variant: "ghost", onClick: () => setRaw((v) => !v) }, raw ? "看时间线" : "看原始"),
					Button({
						variant: "ghost", disabled: entries.length === 0,
						onClick: async () => {
							const r = await api("POST", "/diag-log/clear", {});
							if (r?.ok) { notify("已清空"); load(); } else notify(r?.error ?? "清空失败");
						}
					}, "清空"))
			},
				Muted("插件自己的运行记录：启动到哪一步、人格卡/瞬态块有没有挂上、会话是新建还是恢复、每轮上下文多长。只留最近 200 条，不落盘。"),
				Muted("这里没有「宿主压缩上下文」的记录 —— 宿主不广播那个事件，插件看不到。上下文变长能在「这一轮上下文长度」里看出来。"),
				entries.length === 0
					? h("div", { className: "fs-empty" }, "还没有记录。重启宿主后回来就能看到启动过程。")
					: raw
						? h("pre", {
							className: "fs-report",
							style: { maxHeight: 420, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }
						}, JSON.stringify(entries, null, 2))
						: h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
							entries.map((e, i) => h("div", {
								key: `${e.at}-${i}`,
								style: {
									display: "flex", gap: 10, alignItems: "baseline",
									padding: "4px 0", borderBottom: "1px solid var(--dsw-alias-border-l1, #eee)", fontSize: 13
								}
							},
								h("span", { style: { color: "var(--dsw-alias-text-3, #888)", fontVariantNumeric: "tabular-nums", flex: "0 0 auto" } }, fmtTime(e.at)),
								h("span", { style: { fontWeight: 500, flex: "0 0 auto", ...(levelStyle(e.level) ?? {}) } }, e.label),
								h("span", { style: { color: "var(--dsw-alias-text-2, #555)", wordBreak: "break-word" } }, describe(e)))))
			);
		}

		return { DiagPane };
	}
});
