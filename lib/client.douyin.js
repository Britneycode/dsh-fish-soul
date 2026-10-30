/**
 * dsh-fish-soul — 设置面板「抖音」Tab（client.douyin.js，按需加载的包内分块）
 *
 * 主面板 client.js 里 require.async("./client.douyin.js") 拿到 DouyinPane；
 * 分块不能同步 require 别的面板文件，api / relTime 由主面板通过 props 传进来。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	chunk: "client.douyin.js",
	factory: (require) => {
		const react = require("react");
		const h = react.createElement;
		const CUSTOM = "__custom__";

		const row = (label, ...kids) => h("div", { className: "fs-row" }, h("span", { className: "fs-label" }, label), ...kids);
		const inline = (style, ...kids) => h("div", { className: "fs-inline", style }, ...kids);
		const sub = (text) => h("span", { className: "sub" }, text);
		const hint = (text, red) => h("span", { className: "fs-hint", style: red ? { color: "#f87171" } : null }, text);
		const sw = (checked, onChange, disabled) => h("label", { className: "fs-switch" },
			h("input", { type: "checkbox", checked, disabled, onChange: (e) => onChange(e.target.checked) }));
		const SPREAD = { justifyContent: "space-between", width: "100%", flexWrap: "nowrap" };
		const NOWRAP = { flexWrap: "nowrap" };
		const lines = (v) => String(v).split(/\n+/).map((x) => x.trim()).filter(Boolean);

		const STATE_TEXT = {
			running: "运行中", starting: "启动中…", checking: "连接断了，正在看是怎么回事…", closing: "正在关闭…",
			paused: "已暂停", stopped: "没在运行", error: "出错了"
		};

		/** 登录截图：每 3 秒刷一张，点图片 = 点那个窗口。 */
		function LoginView({ api, notify, refresh }) {
			const [shot, setShot] = react.useState(null);
			const load = react.useCallback(async () => {
				const r = await api("POST", "/douyin/screenshot", { checkLogin: true });
				if (r?.ok) {
					setShot(r);
					if (r.loggedIn === true) { notify("抖音已登录"); refresh(); }
				}
			}, [api]);
			react.useEffect(() => {
				load();
				const t = setInterval(load, 3000);
				return () => clearInterval(t);
			}, [load]);
			const click = async (e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				await api("POST", "/douyin/click", { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
				setTimeout(load, 700);
			};
			return h("div", { className: "fs-shot", onClick: click, title: "点这里等于点那个浏览器窗口" },
				shot === null ? h("div", { style: { padding: "40px", textAlign: "center" } }, hint("截图加载中…"))
					: h("img", { alt: "抖音浏览器截图", src: shot.image, draggable: false }));
		}

		function DouyinPane({ data, refresh, notify, api, relTime }) {
			const d = data?.douyin ?? {};
			const host = d.host ?? {};
			const ch = d.channel ?? {};
			const br = d.browse ?? {};
			const [form, setForm] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [report, setReport] = react.useState(null);
			const [showShot, setShowShot] = react.useState(false);

			react.useEffect(() => {
				if (data && form === null) setForm({
					masterName: d.masterName ?? "", allowList: (d.allowList ?? []).join("\n"), links: (d.links ?? []).join("\n"),
					customPath: d.browserPref?.customPath ?? "", perDay: br.perDay ?? 3, videosPerSession: br.videosPerSession ?? 3,
					custom: (d.browserPref?.customPath ?? "") !== ""
				});
			}, [data, form]);
			if (!data || !form) return null;
			const patch = (p) => setForm({ ...form, ...p });

			const act = async (path, body, okMsg, failMsg) => {
				setBusy(true);
				const r = await api("POST", path, body);
				setBusy(false);
				if (!r?.ok) notify(r?.error ?? failMsg);
				else { if (okMsg) notify(okMsg); refresh(); }
				return r;
			};
			const save = (p = {}) => act("/channels/douyin-config", {
				masterName: form.masterName.trim(),
				allowList: lines(form.allowList),
				links: lines(form.links),
				...(p.top ?? {}),
				browser: { kind: d.browserPref?.kind ?? "edge", customPath: form.custom ? form.customPath.trim() : "", ...(p.browser ?? {}) },
				browse: { perDay: Number(form.perDay), videosPerSession: Number(form.videosPerSession), ...(p.browse ?? {}) }
			}, null, "保存失败");
			const field = (name, props, tag = "input") => h(tag, {
				className: "fs-input mono", value: form[name], onChange: (e) => patch({ [name]: e.target.value }), onBlur: () => save(), ...props
			});

			const browsers = host.browsers ?? [];
			const pickValue = form.custom ? CUSTOM : (d.browserPref?.kind ?? "edge");
			const pick = (v) => {
				if (v === CUSTOM) { patch({ custom: true }); return; }
				patch({ custom: false, customPath: "" });
				save({ browser: { kind: v, customPath: "" } });
			};
			const running = host.state === "running";
			const stateText = host.state === "paused" && host.pausedWhy ? `已暂停（${host.pausedWhy}）` : (STATE_TEXT[host.state] ?? host.state ?? "没在运行");
			const stateClass = running ? (host.loggedIn === true ? "fs-status-ready" : "fs-status-stale") : host.state === "error" ? "fs-status-error" : "fs-status-stale";
			const who = host.browser ? `${host.browser.name}${host.browser.version ? ` ${host.browser.version}` : ""}` : "";
			const pollText = !d.enabled ? "未启用"
				: !running ? "浏览器没在运行"
				: host.loggedIn !== true ? "登录后开始收私信"
				: ch.lastError ? ch.lastError
				: ch.lastPollAt ? `收私信中 · ${relTime(ch.lastPollAt, Date.now())}看过` : "启动中…";

			const notices = [];
			if (d.enabled && running && host.loggedIn === false) notices.push(["没登录", "在下面的截图里（或者弹出来的浏览器窗口里）用抖音 App 扫码登录，建议用给鱼准备的小号"]);
			if (d.enabled && ch.replyPaused) notices.push(["页面变了", "抖音网页好像改版了，自动回复先停了；点「页面自检」看看哪里认不出来，可以把报告复制给开发者"]);
			if (d.enabled && host.state === "error" && host.lastError) notices.push(["浏览器", host.lastError]);

			const selfCheck = async () => {
				setBusy(true);
				const r = await api("POST", "/douyin/self-check", {});
				setBusy(false);
				setReport(r?.report ?? { ok: false, error: r?.error ?? "自检失败" });
				refresh();
			};
			const reportText = report === null ? "" : JSON.stringify({ at: new Date().toISOString(), browser: who, ...report }, null, 2);
			const copy = async () => {
				try { await navigator.clipboard.writeText(reportText); notify("已复制"); } catch { notify("复制失败，手动选中复制吧"); }
			};
			const recent = d.recent ?? [];

			return h(react.Fragment, null,
				notices.length === 0 ? null : h("div", { className: "fs-notice" },
					...notices.map(([t, text]) => h("span", { key: t }, h("b", null, `${t}：`), text))),
				h("div", { className: "fs-surface" },
					row("专用浏览器", inline({ width: "100%", flexWrap: "nowrap" },
						h("select", { className: "fs-select", value: pickValue, onChange: (e) => pick(e.target.value) },
							...browsers.map((b) => h("option", { key: b.kind, value: b.kind }, `${b.name}${b.version ? ` ${b.version}` : ""}`)),
							browsers.length === 0 ? h("option", { key: "none", value: d.browserPref?.kind ?? "edge", disabled: true }, "没找到浏览器") : null,
							h("option", { key: CUSTOM, value: CUSTOM }, "手动指定路径…")),
						h("button", { className: "fs-btn", disabled: busy, onClick: () => act("/douyin/browser/rescan", {}, "重新找了一遍", "没找到") }, "重新查找"))),
					form.custom ? row("浏览器路径", field("customPath", { placeholder: "例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" })) : null,
					row("状态", inline(SPREAD,
						h("span", { className: `fs-status ${stateClass}` }, h("span", { className: "fs-dot" }),
							h("span", null, `${stateText}${running && who ? ` · ${who}` : ""}${running ? (host.loggedIn === true ? " · 已登录" : host.loggedIn === false ? " · 未登录" : "") : ""}`)),
						inline(NOWRAP,
							running ? null : h("button", { className: "fs-btn fs-btn-primary", disabled: busy || d.enabled !== true, onClick: () => act("/douyin/browser/start", {}, "浏览器启动了", "没启动起来") }, "启动"),
							running ? h("button", { className: "fs-btn", onClick: () => setShowShot(!showShot) }, showShot ? "收起截图" : "看截图") : null,
							running ? h("button", { className: "fs-btn fs-btn-warn", disabled: busy, onClick: () => act("/douyin/browser/close", {}, "浏览器关了（点「启动」恢复）", "关不掉") }, "关闭浏览器") : null))),
					running && (host.loggedIn !== true || showShot) ? h(LoginView, { api, notify, refresh }) : null,
					row("", hint("插件自己的浏览器 profile，和你平时用的浏览器分开；你把那个窗口关了就算暂停，不会自己再弹出来。电脑要一直开着、DSH 要一直运行才能收私信。"))),
				h("div", { className: "fs-surface" },
					row("抖音接入", inline(SPREAD, sw(d.enabled === true, (v) => save({ top: { enabled: v } })), sub(pollText))),
					row("自动回私信", inline(NOWRAP, sw(d.autoReply === true, (v) => save({ top: { autoReply: v } })),
						sub(d.autoReply ? (d.replyAll ? "回所有能私信她的人" : "回主人和白名单") : "关着：只记不回（建议先这样跑一周）"))),
					row("主人的名字", field("masterName", { placeholder: "你在她私信列表里显示的名字（和主人 QQ 算同一个人）" })),
					row("白名单", field("allowList", { rows: 2, style: { height: "auto", resize: "vertical" }, placeholder: "每行一个私信列表里显示的名字；其他人只记不回" }, "textarea")),
					row("回所有能私信她的人", inline(NOWRAP, sw(d.replyAll === true, (v) => save({ top: { replyAll: v } })),
						sub("网页版看不出是不是互关：打开前建议在抖音「设置 → 隐私 → 谁可以私信我」选「互关好友」"))),
					row("同一个人", field("links", { rows: 2, style: { height: "auto", resize: "vertical" }, placeholder: "每行一个：抖音名字=QQ号（记忆合到一起）" }, "textarea")),
					row("", hint("网页版拿不到抖音号，只能按私信列表里显示的名字认人：对方改名会被当成新的人；鱼进会话读消息会把消息标成已读。抖音只回复、不主动发私信。"))),
				h("div", { className: "fs-surface" },
					row("空闲时自己刷", inline(SPREAD, sw(br.enabled === true, (v) => save({ browse: { enabled: v } })),
						inline(NOWRAP,
							h("span", { className: "fs-pill mono" }, `今天 ${br.todayCount ?? 0} / ${br.perDay ?? 3} 轮`),
							h("button", { className: "fs-btn", disabled: br.running === true || d.enabled !== true || !running, onClick: () => act("/douyin/browse-now", {}, "开始刷了，一两分钟后看下面的列表", "没刷成") },
								br.running ? "正在刷…" : "现在刷一下")))),
					row("每天", inline(NOWRAP,
						field("perDay", { className: "fs-input num mono", type: "number", min: 0, max: 12 }), sub("轮，每轮"),
						field("videosPerSession", { className: "fs-input num mono", type: "number", min: 1, max: 6 }), sub("条"))),
					row("喜欢就点赞", inline(NOWRAP, sw(br.like === true, (v) => save({ browse: { like: v } })), sub("不评论、不关注、不转发")))),
				h("div", { className: "fs-surface" },
					recent.length === 0
						? h("div", { className: "fs-mem-row" }, hint("还没刷过"))
						: recent.map((v) => h("div", { className: "fs-mem-row", key: v.id },
							h("div", { className: "fs-mem-left" },
								h("span", { className: "fs-kind" }, v.liked ? "♥" : v.skipped ? "划走" : "推荐"),
								h("span", { className: "fs-mem-text", title: `${v.title}${v.impression ? `\n${v.impression}` : ""}` },
									`《${v.title || "没写文案"}》${v.author ? ` · ${v.author}` : ""}${v.impression ? ` —— ${v.impression}` : ""}`)),
							h("div", { className: "fs-mem-right mono" },
								h("a", { href: `https://www.douyin.com/video/${v.id}`, target: "_blank", rel: "noreferrer", style: { color: "inherit" } }, "打开"),
								h("span", null, relTime(v.seenAt, Date.now())))))),
				h("div", { className: "fs-surface" },
					row("页面自检", inline(SPREAD,
						sub(ch.canary ? `${ch.canary.ok ? "上次正常" : "上次没过"} · ${relTime(ch.canary.at, Date.now())}` : "认不认得出抖音的私信页面（会打开私信面板）"),
						inline(NOWRAP,
							h("button", { className: "fs-btn", disabled: busy || !running, onClick: selfCheck }, "页面自检"),
							report === null ? null : h("button", { className: "fs-btn", onClick: copy }, "复制报告")))),
					report === null ? null : h("pre", { className: "fs-report mono" }, reportText)));
		}

		return { DouyinPane };
	}
});
