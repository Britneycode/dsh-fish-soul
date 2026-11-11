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
			const [framesPerDay, setFramesPerDay] = react.useState("");
			react.useEffect(() => { if (framesPerDay === "" && br.framesPerDay !== undefined) setFramesPerDay(String(br.framesPerDay)); }, [br.framesPerDay]);
			const [form, , patch] = useForm(data, () => ({
				masterName: d.masterName ?? "", masterUid: d.masterUid ?? "", allowList: (d.allowList ?? []).join("\n"), links: (d.links ?? []).join("\n"),
				groups: (d.groups ?? []).join("\n"), callNames: (d.callNames ?? []).join("\n"),
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
				masterName: form.masterName.trim(), masterUid: form.masterUid.trim(), allowList: lines(form.allowList), links: lines(form.links), groups: lines(form.groups), callNames: lines(form.callNames), ...(p.top ?? {}),
				browser: { kind: d.browserPref?.kind ?? "edge", customPath: form.custom ? form.customPath.trim() : "", ...(p.browser ?? {}) },
				browse: { perDay: Number(form.perDay), videosPerSession: Number(form.videosPerSession), mode: br.mode === "browser" ? "browser" : "http", ...(p.browse ?? {}) },
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
					d.channel?.identityBlocked
						? Row({ title: "私信身份未就绪", desc: d.channel?.identityState?.disabledByFlag
							? "身份绑定被手动停用（DOUYIN_IDENTITY_BLOCKED），私信一律不处理、不发送。"
							: "还不知道这个抖音号自己的 uid，所以无法确认会话里对方是谁；私信暂不处理。正常聊过一轮、或抖音自己推过一条会话消息后会自动学到。刷到的视频仍会走 QQ 分享。" })
						: Row({ title: "私信按会话认人", desc: "身份用会话 ID 判定（`0:1:我方:对方`），昵称只作展示：改名、同名都不会串人。发送前会用会话 ID 校验目标，拿不到就发不出去，不会发给错的人。" }),
					Row({ title: "抖音接入" }, poll, sw("抖音接入", d.enabled === true, (v) => save({ top: { enabled: v } }))),
					Row({ title: "自动回复" }, d.autoReply ? null : Muted("只记不回"), sw("自动回复", d.autoReply === true, (v) => save({ top: { autoReply: v } }))),
					...(d.channel?.inbox?.gaps ?? []).map((g) => Row({ title: `私信可能遗漏 · ${g.channelId}`, desc: g.reason },
						Button({ variant: "ghost", disabled: busy, onClick: () => act("/douyin/inbox-gap-ack", { id: g.id }, "已知晓", "操作失败") }, "已知晓"))),
					(d.channel?.inbox?.gapCount ?? 0) > 10 ? Row({ title: `另有 ${d.channel.inbox.gapCount - 10} 条遗漏提示`, desc: "列表只显示前 10 条" },
						Button({ variant: "ghost", disabled: busy, onClick: () => act("/douyin/inbox-gap-ack", {}, "已全部标记知晓", "操作失败") }, "全部已知晓")) : null,
					...(d.channel?.inbox?.review ?? []).map((m) => Row({ title: `私信待核实 · ${m.channelId}`, desc: `会话名及消息来源均未验证，可能串会话；处理也可能已产生副作用。请先到抖音核实：${m.text}` },
						Button({ variant: "ghost", disabled: busy || d.channel?.identityBlocked === true, onClick: () => act("/douyin/inbox-resolve", { id: m.id, action: "retry" }, "已安排下次轮询重新处理", "操作失败") }, "核实未处理，重新处理"),
						Button({ variant: "ghost", disabled: busy, onClick: () => act("/douyin/inbox-resolve", { id: m.id, action: "dismiss" }, "已忽略", "操作失败") }, "已核实，忽略"))),
					(d.channel?.inbox?.counts?.unknown ?? 0) > 10 ? Row({ title: `另有 ${d.channel.inbox.counts.unknown - 10} 条待核实`, desc: "一条待核实会挡住同会话后面所有消息；身份暂停期间不能重试，核实过就可以全部忽略" },
						Button({ variant: "ghost", disabled: busy, onClick: () => act("/douyin/inbox-dismiss-all", {}, "已全部忽略", "操作失败") }, "已核实，全部忽略")) : null,
					(d.channel?.inbox?.counts?.processing ?? 0) > 0 ? Muted(`正在处理 ${d.channel.inbox.counts.processing} 条；如果长时间不变，重启后核实`) : null,
					Row({ title: "主人身份", desc: "填你的抖音数字 uid（从下面「私信待核实」条目里能看到，或让我从会话里读）。这是唯一的主人口径 —— 昵称可被同名冒充、改名又会对不上，所以不参与授权。只填数字就行，前缀会自动补。" },
						Input({ ...bind("masterUid"), placeholder: "7702399256389125000" })),
					Row({ title: "主人的名字", desc: "仅作显示（提示词里怎么称呼）；不授予任何权限" }, Input({ ...bind("masterName"), placeholder: "她私信列表里你的名字" })),
					Row({ title: "回所有能私信她的人", desc: d.replyAll ? "建议在抖音隐私设置里把「谁可以私信我」设为互关好友" : null },
						sw("回所有能私信她的人", d.replyAll === true, (v) => save({ top: { replyAll: v } }))),
					d.replyAll ? null : Row({ title: "白名单", stack: true }, Area({ ...bind("allowList"), placeholder: "原有配置保留；当前不按昵称放行" })),
					Row({ title: "同一个人", stack: true }, Area({ ...bind("links"), placeholder: "原有配置保留；当前不按昵称共享" }))),
				Group({ title: "群聊" },
					Row({ title: "群里被叫到时回", desc: "群聊按说话的人分开认，不会当成一个人；没人 @ 她或叫她名字时只看不说" },
						sw("群里被叫到时回", d.groupReply === true, (v) => save({ top: { groupReply: v } }))),
					Row({ title: "叫她的名字", stack: true }, Area({ ...bind("callNames"), placeholder: "她的抖音昵称等，每行一个（QQ 那边设的称呼也算）" })),
					Row({ title: "这些会话是群", stack: true }, Area({ ...bind("groups"), placeholder: "一般能自动认出来；认不出来的群在这里填会话名，每行一个" }))),
				Group({ title: "刷视频", aside: Tag(`今天 ${br.todayCount ?? 0} / ${br.perDay ?? 3}`, "outline") },
					Row({ title: "空闲时自己刷" },
						browseOn ? Button({ variant: "ghost", disabled: br.running === true || d.enabled !== true || !running, onClick: () => act("/douyin/browse-now", {}, "开始刷了", "没刷成") }, br.running ? "正在刷…" : "现在刷") : null,
						sw("空闲时自己刷", browseOn, (v) => save({ browse: { enabled: v } }))),
					browseOn ? Row({ title: "每天" },
						Num({ min: 0, max: 12, "aria-label": "轮数", ...bind("perDay") }), Muted("轮 ×"),
						Num({ min: 1, max: 6, "aria-label": "每轮条数", ...bind("videosPerSession") }), Muted("条")) : null,
					browseOn ? Row({ title: "走接口刷（不开浏览器）", desc: "直接调抖音网页端接口拉推荐流和评论，不用开专用浏览器；关掉就回到浏览器里滑推荐页（老路）" },
						sw("走接口刷（不开浏览器）", br.mode !== "browser", (v) => save({ browse: { mode: v ? "http" : "browser" } }))) : null,
					browseOn ? Row({ title: "喜欢就点赞", desc: "模型自己说「特别喜欢」才点；走接口这条路要点上面那个接口点赞开关才生效" }, sw("喜欢就点赞", br.like === true, (v) => save({ browse: { like: v } }))) : null,
					browseOn ? Row({ title: "喜欢就收藏", desc: "模型说「想留着以后再看」就收藏（少数几条）；写操作要真机验过，默认关" }, sw("喜欢就收藏", br.collect === true, (v) => save({ browse: { collect: v } }))) : null,
					browseOn ? Row({ title: "抽帧看画面", desc: "把视频开头均匀抽 9 张拼成九宫格，再让模型读成一句话——这样她「看过」而不只是读过文案。每条多一次识图调用" }, sw("抽帧看画面", br.frames === true, (v) => save({ browse: { frames: v } }))) : null,
					browseOn && br.frames === true ? Row({ title: "一天最多看几条", desc: "自己刷的时候，一天最多抽几次帧（每次多一次识图调用）" },
						Num({ min: 0, max: 20, value: framesPerDay, onChange: (e) => setFramesPerDay(e.target.value), onBlur: () => { const n = Number(framesPerDay); if (n !== br.framesPerDay) save({ browse: { framesPerDay: n } }); } }), Muted("条")) : null,
					browseOn ? Row({ title: "刷到有意思的发给你", desc: br.shareInDm !== false ? "带链接和感受，发到你的抖音私信（抖音没连上就发 QQ）；一天最多 2 条" : "带链接和感受，发到你的 QQ 私聊；一天最多 2 条" }, sw("刷到有意思的发给你", br.share !== false, (v) => save({ browse: { share: v } }))) : null,
					browseOn && br.share !== false ? Row({ title: "在抖音私信里分享", desc: "要填「主人的名字」、开自动回复" }, sw("在抖音私信里分享", br.shareInDm !== false, (v) => save({ browse: { shareInDm: v } }))) : null,
					browseOn && br.share !== false && br.shareInDm !== false ? Row({ title: "发原生视频卡片", desc: "在抖音私信里发那条点开就播的原生卡片（不发链接）。要在专用浏览器里打开「分享给朋友」面板，收件人按身份锁定、发完回读确认才算数；抖音改版可能失效。专用浏览器没开着就发不出去" }, sw("发原生视频卡片", d.shareCard === true, (v) => save({ top: { shareCard: v } }))) : null),
				Group({ title: "作品和评论", aside: post.enabled ? Tag(`今天发了 ${so.post?.todayCount ?? 0} / ${post.perDay ?? 1}`, "outline") : null },
					Row({ title: "自己发图文", desc: "把想说的话做成文字卡片，在创作者中心发图文；创作者中心可能要单独登录一次" },
						post.enabled ? Button({ variant: "ghost", disabled: busy || so.post?.running === true || Boolean(so.postPending) || d.enabled !== true || !running, onClick: () => act("/douyin/post-now", {}, "发出去了", "没发成") }, so.post?.running ? "正在发…" : "现在发一条") : null,
						sw("自己发图文", post.enabled === true, (v) => save({ post: { enabled: v } }))),
					post.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 5, "aria-label": "每天最多几条", ...bind("postPerDay") }), Muted("条")) : null,
					so.postPending ? Row({ title: "作品结果待核实", desc: `先到创作者中心核实，不会自动重发：${so.postPending.text || ""}` },
						Button({ variant: "ghost", disabled: busy || so.postPending.status !== "unknown", onClick: () => act("/douyin/post-resolve", { jobId: so.postPending.id, outcome: "not_published" }, "已记录为未发布", "记录失败") }, "已核实未发布"),
						Button({ variant: "ghost", disabled: busy || so.postPending.status !== "unknown", onClick: () => act("/douyin/post-resolve", { jobId: so.postPending.id, outcome: "published" }, "已记录为已发布", "记录失败") }, "已核实已发布")) : null,
					Row({ title: "回评论", desc: "每 20 分钟看看最近 3 个作品的评论区；抖音可能要短信验证，碰到会停下来提醒你" },
						cm.enabled ? Button({ variant: "ghost", disabled: busy || d.enabled !== true || !running, onClick: () => act("/douyin/comments-now", {}, "看完了", "没看成") }, "现在看一眼") : null,
						sw("回评论", cm.enabled === true, (v) => save({ comments: { enabled: v } }))),
					cm.enabled ? Row({ title: "每小时最多" }, Num({ min: 0, max: 30, "aria-label": "每小时最多回几条", ...bind("commentsPerHour") }), Muted("条")) : null,
					cm.enabled ? Row({ title: "允许发表情", desc: "把抖音的表情码（[微笑] 这种）写进提示词，平台会自动渲染成表情图" },
						sw("允许发表情", cm.emoji === true, (v) => save({ comments: { emoji: v } }))) : null,
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
						ch.canary ? State(ch.canary.ok ? "done" : "error", relTime(ch.canary.at, Date.now()), ch.canary.ok ? (ch.canary.recovered?.ok === true ? "上次没通过，刷新后好了" : "上次通过") : "上次没通过") : null,
						report === null ? null : Button({ variant: "ghost", onClick: copy }, "复制报告"),
						Button({ disabled: busy || !running, onClick: selfCheck }, "自检")),
					report === null ? null : h("pre", { className: "fs-report" }, reportText)));
		}

		return { DouyinPane };
	}
});
