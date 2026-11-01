/**
 * dsh-fish-soul — 设置面板「抖音」页（client.douyin.js，按需加载的包内分块）
 *
 * 主面板 client.js 用 require.async("./client.douyin.js") 拿到 DouyinPane；分块不能同步 require 主文件，
 * api / relTime / 控件（props.ui：照抄 dsh-ui-primitives 的 Switch / Button / Row / Group …）都由主面板传进来。
 */
window.__ModuleLoader__.load({
	id: "dsh-fish-soul",
	chunk: "client.douyin.js",
	factory: (require) => {
		const react = require("react");
		const CUSTOM = "__custom__";
		const WINDOW_MODES = [{ value: "background", label: "藏在后台" }, { value: "visible", label: "正常显示" }];
		const lines = (v) => String(v).split(/\n+/).map((x) => x.trim()).filter(Boolean);

		/** 登录截图：每 3 秒刷一张，点图片 = 点那个窗口。 */
		function LoginView({ api, notify, refresh, ui }) {
			const { h, Empty, Dot } = ui;
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
			return h("figure", { className: "fs-shot", onClick: click, title: "点击会点到那个浏览器窗口" },
				shot === null ? Empty(Dot("ongoing")) : h("img", { alt: "抖音浏览器截图", src: shot.image, draggable: false }));
		}

		const HOST_STATE = {
			running: ["done", "运行中"], starting: ["ongoing", "启动中"], checking: ["ongoing", "连接断了，正在检查"], closing: ["ongoing", "正在关闭"],
			paused: ["idle", "已暂停"], stopped: ["idle", "未运行"], error: ["error", "出错了"]
		};

		function DouyinPane({ data, refresh, notify, api, relTime, ui }) {
			const { h, Switch, Button, IconButton, State, Tag, Muted, Row, Group, Input, Num, Area, Select, Item, Seg, useForm } = ui;
			const d = data?.douyin ?? {};
			const host = d.host ?? {};
			const ch = d.channel ?? {};
			const br = d.browse ?? {};
			const [busy, setBusy] = react.useState(false);
			const [report, setReport] = react.useState(null);
			const [showShot, setShowShot] = react.useState(false);
			const [form, , patch] = useForm(data, () => ({
				masterName: d.masterName ?? "", allowList: (d.allowList ?? []).join("\n"), links: (d.links ?? []).join("\n"),
				customPath: d.browserPref?.customPath ?? "", perDay: br.perDay ?? 3, videosPerSession: br.videosPerSession ?? 3,
				custom: (d.browserPref?.customPath ?? "") !== "",
				postPerDay: d.post?.perDay ?? 1, commentsPerHour: d.comments?.perHour ?? 4
			}));
			const so = d.social ?? {};
			const post = d.post ?? {};
			const cm = d.comments ?? {};
			const socialLog = [
				...(so.post?.recent ?? []).map((x, i) => ({ key: `p${i}${x.at}`, tag: Tag("图文", "outline"), text: x.content, at: x.at })),
				...(so.comments?.recent ?? []).map((x, i) => ({ key: `c${i}${x.at}`, tag: Tag(x.status === "replied" ? "回了" : x.status === "failed" ? "没发出" : "没回", x.status === "failed" ? "danger" : undefined),
					text: `${x.name}：${x.content}${x.reply ? ` → ${x.reply}` : ""}`, at: x.at }))
			].sort((x, y) => y.at - x.at).slice(0, 10);
			if (!data || !form) return null;

			const act = async (path, body, okMsg, failMsg) => {
				setBusy(true);
				const r = await api("POST", path, body);
				setBusy(false);
				if (!r?.ok) notify(r?.error ?? failMsg);
				else { if (okMsg) notify(okMsg); refresh(); }
				return r;
			};
			const save = (p = {}) => act("/channels/douyin-config", {
				masterName: form.masterName.trim(), allowList: lines(form.allowList), links: lines(form.links), ...(p.top ?? {}),
				browser: { kind: d.browserPref?.kind ?? "edge", customPath: form.custom ? form.customPath.trim() : "", ...(p.browser ?? {}) },
				browse: { perDay: Number(form.perDay), videosPerSession: Number(form.videosPerSession), ...(p.browse ?? {}) },
				post: { perDay: Number(form.postPerDay), ...(p.post ?? {}) },
				comments: { perHour: Number(form.commentsPerHour), ...(p.comments ?? {}) }
			}, null, "保存失败");
			const bind = (name) => ({ value: form[name], onChange: (e) => patch({ [name]: e.target.value }), onBlur: () => save() });
			const sw = (label, checked, onChange, disabled) => h(Switch, { label, checked, onChange, disabled });

			const browsers = host.browsers ?? [];
			const pick = (v) => {
				if (v === CUSTOM) { patch({ custom: true }); return; }
				patch({ custom: false, customPath: "" });
				save({ browser: { kind: v, customPath: "" } });
			};
			const running = host.state === "running";
			const who = host.browser ? `${host.browser.name}${host.browser.version ? ` ${host.browser.version}` : ""}` : "";
			const [hs, ht] = HOST_STATE[host.state] ?? ["idle", host.state ?? "未运行"];
			const hostState = running && host.loggedIn === false ? State("warning", "未登录")
				: State(hs, host.state === "paused" && host.pausedWhy ? `${ht} · ${host.pausedWhy}` : running && who ? who : ht, host.lastError || undefined);
			const poll = !d.enabled || !running || host.loggedIn !== true ? null
				: ch.lastError ? State("error", ch.lastError) : ch.lastPollAt ? State("done", relTime(ch.lastPollAt, Date.now()), "上次看私信") : State("ongoing", "启动中");

			const notices = [];
			if (d.enabled && ch.replyPaused) notices.push(["页面变了", "自动回复已暂停，跑一次页面自检看看"]);
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
				try { await navigator.clipboard.writeText(reportText); notify("已复制"); } catch { notify("复制失败，手动选中复制"); }
			};
			const recent = d.recent ?? [];
			const browseOn = br.enabled === true;

			return h(react.Fragment, null,
				notices.length === 0 ? null : h("div", { className: "fs-notice", role: "alert" },
					...notices.map(([t, text]) => h("span", { key: t }, h("b", null, t), ` · ${text}`))),
				Group({ title: "浏览器" },
					Row({ title: "专用浏览器" },
						Select({ value: form.custom ? CUSTOM : (d.browserPref?.kind ?? "edge"), "aria-label": "专用浏览器", onChange: (e) => pick(e.target.value) },
							...browsers.map((b) => h("option", { key: b.kind, value: b.kind }, `${b.name}${b.version ? ` ${b.version}` : ""}`)),
							browsers.length === 0 ? h("option", { key: "none", value: d.browserPref?.kind ?? "edge", disabled: true }, "没找到浏览器") : null,
							h("option", { key: CUSTOM, value: CUSTOM }, "手动指定路径…")),
						IconButton("refresh", "重新查找", () => act("/douyin/browser/rescan", {}, "已重新查找", "没找到"), { disabled: busy })),
					form.custom ? Row({ title: "浏览器路径" }, Input({ ...bind("customPath"), placeholder: "C:\\…\\chrome.exe" })) : null,
					Row({ title: "状态" }, hostState,
						running ? null : Button({ variant: "primary", disabled: busy || d.enabled !== true, onClick: () => act("/douyin/browser/start", {}, "浏览器已启动", "没启动起来") }, "启动"),
						running && host.loggedIn === true ? Button({ variant: "ghost", "aria-expanded": showShot, onClick: () => setShowShot(!showShot) }, showShot ? "收起截图" : "截图") : null,
						running ? Button({ variant: "danger", disabled: busy, onClick: () => act("/douyin/browser/close", {}, "浏览器已关闭", "关不掉") }, "关闭") : null),
					Row({ title: "窗口", desc: d.window === "visible" ? "最小化了的话，她看私信 / 刷视频时会弹出来" : "停在屏幕外，不会弹出来打扰你；别在任务栏把它最小化" },
						running && d.window !== "visible" ? Button({ variant: "ghost", disabled: busy, onClick: () => act("/douyin/window", { show: !d.windowShown }, null, "窗口挪不动") }, d.windowShown ? "藏起来" : "显示一下") : null,
						h(Seg, { label: "窗口", value: d.window === "visible" ? "visible" : "background", options: WINDOW_MODES, onChange: (v) => save({ top: { window: v } }) })),
					running && (host.loggedIn !== true || showShot) ? h(LoginView, { api, notify, refresh, ui }) : null),
				Group({ title: "私信" },
					Row({ title: "抖音接入" }, poll, sw("抖音接入", d.enabled === true, (v) => save({ top: { enabled: v } }))),
					Row({ title: "自动回复" }, d.autoReply ? null : Muted("只记不回"), sw("自动回复", d.autoReply === true, (v) => save({ top: { autoReply: v } }))),
					Row({ title: "主人的名字" }, Input({ ...bind("masterName"), placeholder: "她私信列表里你的名字" })),
					Row({ title: "回所有能私信她的人", desc: d.replyAll ? "建议在抖音隐私设置里把「谁可以私信我」设为互关好友" : null },
						sw("回所有能私信她的人", d.replyAll === true, (v) => save({ top: { replyAll: v } }))),
					d.replyAll ? null : Row({ title: "白名单", stack: true }, Area({ ...bind("allowList"), placeholder: "私信列表里显示的名字，每行一个" })),
					Row({ title: "同一个人", stack: true }, Area({ ...bind("links"), placeholder: "抖音名字=QQ 号，每行一个" }))),
				Group({ title: "刷视频", aside: Tag(`今天 ${br.todayCount ?? 0} / ${br.perDay ?? 3}`, "outline") },
					Row({ title: "空闲时自己刷" },
						browseOn ? Button({ variant: "ghost", disabled: br.running === true || d.enabled !== true || !running, onClick: () => act("/douyin/browse-now", {}, "开始刷了", "没刷成") }, br.running ? "正在刷…" : "现在刷") : null,
						sw("空闲时自己刷", browseOn, (v) => save({ browse: { enabled: v } }))),
					browseOn ? Row({ title: "每天" },
						Num({ min: 0, max: 12, "aria-label": "轮数", ...bind("perDay") }), Muted("轮 ×"),
						Num({ min: 1, max: 6, "aria-label": "每轮条数", ...bind("videosPerSession") }), Muted("条")) : null,
					browseOn ? Row({ title: "喜欢就点赞" }, sw("喜欢就点赞", br.like === true, (v) => save({ browse: { like: v } }))) : null,
					browseOn ? Row({ title: "刷到有意思的发给你", desc: br.shareInDm !== false ? "带链接和感受，发到你的抖音私信（抖音没连上就发 QQ）；一天最多 2 条" : "带链接和感受，发到你的 QQ 私聊；一天最多 2 条" }, sw("刷到有意思的发给你", br.share !== false, (v) => save({ browse: { share: v } }))) : null,
					browseOn && br.share !== false ? Row({ title: "在抖音私信里分享", desc: "要填「主人的名字」、开自动回复" }, sw("在抖音私信里分享", br.shareInDm !== false, (v) => save({ browse: { shareInDm: v } }))) : null),
				Group({ title: "作品和评论", aside: post.enabled ? Tag(`今天发了 ${so.post?.todayCount ?? 0} / ${post.perDay ?? 1}`, "outline") : null },
					Row({ title: "自己发图文", desc: "把想说的话做成文字卡片，在创作者中心发图文；创作者中心可能要单独登录一次" },
						post.enabled ? Button({ variant: "ghost", disabled: busy || so.post?.running === true || d.enabled !== true || !running, onClick: () => act("/douyin/post-now", {}, "发出去了", "没发成") }, so.post?.running ? "正在发…" : "现在发一条") : null,
						sw("自己发图文", post.enabled === true, (v) => save({ post: { enabled: v } }))),
					post.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 5, "aria-label": "每天最多几条", ...bind("postPerDay") }), Muted("条")) : null,
					Row({ title: "回评论", desc: "每 20 分钟看看最近 3 个作品的评论区；抖音可能要短信验证，碰到会停下来提醒你" },
						cm.enabled ? Button({ variant: "ghost", disabled: busy || d.enabled !== true || !running, onClick: () => act("/douyin/comments-now", {}, "看完了", "没看成") }, "现在看一眼") : null,
						sw("回评论", cm.enabled === true, (v) => save({ comments: { enabled: v } }))),
					cm.enabled ? Row({ title: "每小时最多" }, Num({ min: 0, max: 30, "aria-label": "每小时最多回几条", ...bind("commentsPerHour") }), Muted("条")) : null,
					so.blockedUntil ? Row({ title: "等验证" }, State("error", `抖音要验证，${Math.max(1, Math.ceil((so.blockedUntil - Date.now()) / 3600000))} 小时内先不试；去浏览器里验证一下`)) : null,
					so.lastError ? Row({ title: "上次出错" }, State("error", so.lastError)) : null,
					socialLog.length === 0 ? null : h("div", { className: "fs-list" }, socialLog.map((x) => Item({ key: x.key, lead: x.tag, text: x.text, title: x.text, meta: [h("span", { key: "t" }, relTime(x.at, Date.now()))] })))),
				recent.length === 0 ? null : Group({ title: "最近看过" },
					h("div", { className: "fs-list" }, recent.map((v) => Item({
						key: v.id, lead: Tag(v.liked ? "赞" : v.skipped ? "划走" : "推荐", v.liked ? "danger" : undefined),
						text: `${v.title || "没写文案"}${v.impression ? ` — ${v.impression}` : ""}`,
						title: `${v.title || ""}${v.author ? ` · ${v.author}` : ""}${v.impression ? `\n${v.impression}` : ""}`,
						meta: [h("a", { key: "a", href: `https://www.douyin.com/video/${v.id}`, target: "_blank", rel: "noreferrer" }, v.author || "打开"), h("span", { key: "t" }, relTime(v.seenAt, Date.now()))]
					})))),
				Group({ title: "页面自检" },
					Row({ title: "能否认出私信页" },
						ch.canary ? State(ch.canary.ok ? "done" : "error", relTime(ch.canary.at, Date.now()), ch.canary.ok ? "上次通过" : "上次没通过") : null,
						report === null ? null : Button({ variant: "ghost", onClick: copy }, "复制报告"),
						Button({ disabled: busy || !running, onClick: selfCheck }, "自检")),
					report === null ? null : h("pre", { className: "fs-report" }, reportText)));
		}

		return { DouyinPane };
	}
});
