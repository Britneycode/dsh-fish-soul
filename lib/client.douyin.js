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
		// 视频服务商：值必须跟 lib/video-gen.js 的 PROVIDERS 一致（改了那边这里就对不上了）。
		const VIDEO_PROVIDERS = [
			{ value: "volc", label: "火山方舟" },
			{ value: "minimax", label: "MiniMax" },
			{ value: "openai-compat", label: "OpenAI 兼容" },
			{ value: "openmotion", label: "OpenMotion 本地渲染" }
		];
		// 各家常用接口地址示例（接口地址、API Key、模型名都必须填；填错会被对方拒绝）。
		const VIDEO_BASE_URLS = {
			volc: "https://ark.cn-beijing.volces.com/api/v3",
			minimax: "https://api.minimax.cn",
			"openai-compat": "https://api.openai.com/v1",
			openmotion: "http://127.0.0.1:4173"
		};
		const VIDEO_RATIOS = [{ value: "9:16", label: "9:16 竖屏" }, { value: "16:9", label: "16:9 横屏" }, { value: "1:1", label: "1:1 方形" }];
		const VIDEO_RESOLUTIONS = [{ value: "480P", label: "480P" }, { value: "768P", label: "768P" }, { value: "2K", label: "2K" }];
		const lines = (v) => String(v).split(/\n+/).map((x) => x.trim()).filter(Boolean);

		/** 登录截图：每 3 秒刷一张，点图片 = 点那个窗口。 */
		function LoginView({ api, notify, refresh, ui }) {
			const { h, Empty, Dot } = ui;
			const [shot, setShot] = react.useState(null);
			const timerRef = react.useRef(null);
			const aliveRef = react.useRef(true);
			const load = react.useCallback(async () => {
				const r = await api("POST", "/douyin/screenshot", { checkLogin: true });
				if (!aliveRef.current) return;
				if (r?.ok) {
					setShot(r);
					if (r.loggedIn === true) { notify("抖音已登录"); refresh(); }
				}
			}, [api, notify, refresh]);
			react.useEffect(() => {
				aliveRef.current = true;
				load();
				const t = setInterval(load, 3000);
				return () => { aliveRef.current = false; clearInterval(t); if (timerRef.current) clearTimeout(timerRef.current); };
			}, [load]);
			const click = async (e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				await api("POST", "/douyin/click", { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
				if (timerRef.current) clearTimeout(timerRef.current);
				timerRef.current = setTimeout(load, 700);
			};
			return h("figure", {
				className: "fs-shot", role: "button", tabIndex: 0, "aria-label": "抖音浏览器截图，点击操作窗口",
				onClick: click,
				onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); api("POST", "/douyin/click", { x: 0.5, y: 0.5 }).then(() => { if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = setTimeout(load, 700); }); } },
				title: "点击会点到那个浏览器窗口"
			},
				shot === null ? Empty(Dot("ongoing")) : h("img", { alt: "抖音浏览器截图", src: shot.image, draggable: false }));
		}

		const HOST_STATE = {
			running: ["done", "运行中"], starting: ["ongoing", "启动中"], checking: ["ongoing", "连接断了，正在检查"], closing: ["ongoing", "正在关闭"],
			paused: ["idle", "已暂停"], stopped: ["idle", "未运行"], error: ["error", "出错了"]
		};

		function DouyinPane({ data, refresh, notify, api, relTime, ui }) {
			const { h, Switch, Button, IconButton, State, Tag, Muted, Row, Group, Input, Num, Area, Select, Item, Seg, Secret, useForm, useConfirm = () => [async () => true, null] } = ui;
			const [confirm, confirmNode] = useConfirm();
			const d = data?.douyin ?? {};
			const host = d.host ?? {};
			const ch = d.channel ?? {};
			const br = d.browse ?? {};
			const [busy, setBusy] = react.useState(false);
			const [report, setReport] = react.useState(null);
			const [showShot, setShowShot] = react.useState(false);
			const [framesPerDay, setFramesPerDay] = react.useState("");
			const [noteText, setNoteText] = react.useState("");
			react.useEffect(() => { if (framesPerDay === "" && br.framesPerDay !== undefined) setFramesPerDay(String(br.framesPerDay)); }, [br.framesPerDay]);
			// 待确认的抖音身份（昵称配了但还没主人确认过）。
			// 放在面板里而不是自动绑定 —— 主人是唯一能看懂 uid 的人。
			const [candidates, setCandidates] = react.useState([]);
			const loadCandidates = react.useCallback(async () => {
				try {
					const r = await api("POST", "/douyin/uin-candidates", {});
					setCandidates(Array.isArray(r?.candidates) ? r.candidates : []);
				} catch { setCandidates([]); }
			}, [api]);
			react.useEffect(() => { void loadCandidates(); }, [loadCandidates]);
			const [form, , patch] = useForm(data, () => ({
				masterName: d.masterName ?? "", masterUid: d.masterUid ?? "", allowList: (d.allowList ?? []).join("\n"), links: (d.links ?? []).join("\n"),
				groups: (d.groups ?? []).join("\n"), callNames: (d.callNames ?? []).join("\n"),
				customPath: d.browserPref?.customPath ?? "", perDay: br.perDay ?? 3, videosPerSession: br.videosPerSession ?? 3,
				custom: (d.browserPref?.customPath ?? "") !== "",
				postPerDay: d.post?.perDay ?? 1, commentsPerHour: d.comments?.perHour ?? 4, replyWindowMinutes: d.replyWindowMinutes ?? 120,
				// 视频：apiKey 一律空串起步 —— 明文 key 不回显到面板（回显里只有掩码）；enabled 不放进 form，避免旧值反写。
				videoProvider: d.video?.provider ?? "volc",
				videoBaseURL: d.video?.baseURL ?? "",
				videoApiKey: "",
				videoModel: d.video?.model ?? "",
				videoDurationSec: d.video?.durationSec ?? 5,
				videoAspect: d.video?.aspectRatio ?? "9:16",
				videoResolution: d.video?.resolution ?? "768P",
				videoPerDay: d.video?.perDay ?? 1
			}));
			const so = d.social ?? {};
			const post = d.post ?? {};
			const video = d.video ?? {};
			const cm = d.comments ?? {};
			const socialLog = [
				...(so.post?.recent ?? []).map((x, i) => ({ key: `p${i}${x.at}`, tag: Tag("图文", "outline"), text: x.content, at: x.at })),
				...(so.comments?.recent ?? []).map((x, i) => ({ key: `c${i}${x.at}`, tag: Tag(x.status === "replied" ? "回了" : x.status === "failed" ? "没发出" : "没回", x.status === "failed" ? "danger" : undefined),
					text: `${x.name}：${x.content}${x.reply ? ` → ${x.reply}` : ""}`, at: x.at }))
			].sort((x, y) => y.at - x.at).slice(0, 10);
			if (!data || !form) return null;

			const act = async (path, body, okMsg, failMsg) => {
				setBusy(true);
				try {
					const r = await api("POST", path, body);
					if (!r?.ok) notify(r?.error ?? failMsg);
					else { if (okMsg) notify(okMsg); refresh(); }
					return r;
				} finally {
					setBusy(false);
				}
			};
			const save = async (p = {}) => {
				const hadKey = form.videoApiKey !== "";
				const r = await act("/channels/douyin-config", {
					masterName: form.masterName.trim(), masterUid: form.masterUid.trim(), allowList: lines(form.allowList), groups: lines(form.groups), callNames: lines(form.callNames), ...(p.top ?? {}),
					browser: { kind: d.browserPref?.kind ?? "edge", customPath: form.custom ? form.customPath.trim() : "", ...(p.browser ?? {}) },
					browse: { perDay: Number(form.perDay), videosPerSession: Number(form.videosPerSession), mode: br.mode === "browser" ? "browser" : "http", ...(p.browse ?? {}) },
					post: { perDay: Number(form.postPerDay), ...(p.post ?? {}) },
					video: {
						provider: form.videoProvider,
						baseURL: String(form.videoBaseURL ?? "").trim(),
						// 🔴 apiKey **只在用户真填了新的才带**：带上空串会把面板上存的 key 冲掉。
						...(form.videoApiKey !== "" ? { apiKey: form.videoApiKey } : {}),
						model: String(form.videoModel ?? "").trim(),
						durationSec: Number(form.videoDurationSec),
						aspectRatio: form.videoAspect,
						resolution: form.videoResolution,
						perDay: Number(form.videoPerDay),
						...(p.video ?? {})
					},
					comments: { perHour: Number(form.commentsPerHour), ...(p.comments ?? {}) }
				}, null, "保存失败");
				if (r?.ok && hadKey) patch({ videoApiKey: "" });
				return r;
			};
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
					Row({ title: "抖音接入" }, poll, sw("抖音接入", d.enabled === true, (v) => save({ top: { enabled: v } }))),
					Row({ title: "专用浏览器" },
						Select({ value: form.custom ? CUSTOM : (d.browserPref?.kind ?? "edge"), "aria-label": "专用浏览器", onChange: (e) => pick(e.target.value) },
							...browsers.map((b) => h("option", { key: b.kind, value: b.kind }, `${b.name}${b.version ? ` ${b.version}` : ""}`)),
							browsers.length === 0 ? h("option", { key: "none", value: d.browserPref?.kind ?? "edge", disabled: true }, "没找到浏览器") : null,
							h("option", { key: CUSTOM, value: CUSTOM }, "手动指定路径…")),
						IconButton("refresh", "重新查找", () => act("/douyin/browser/rescan", {}, "已重新查找", "没找到"), { disabled: busy })),
					form.custom ? Row({ title: "浏览器路径" }, Input({ ...bind("customPath"), "aria-label": "浏览器路径", placeholder: "C:\\…\\chrome.exe" })) : null,
					Row({ title: "状态" }, hostState,
						running ? null : Button({ variant: "primary", disabled: busy || d.enabled !== true, onClick: () => act("/douyin/browser/start", {}, "浏览器已启动", "没启动起来") }, "启动"),
						running && host.loggedIn === true ? Button({ "aria-expanded": showShot, onClick: () => setShowShot(!showShot) }, showShot ? "收起截图" : "截图") : null,
						running ? Button({ variant: "danger", disabled: busy, onClick: async () => { if (await confirm({ title: "关闭专用浏览器", description: "关闭正在运行的抖音浏览器？", danger: true })) await act("/douyin/browser/close", {}, "浏览器已关闭", "关不掉"); } }, "关闭") : null),
					Row({ title: "窗口", desc: d.window === "visible" ? "最小化了的话，她看私信 / 刷视频时会弹出来" : "停在屏幕外，不会弹出来打扰你；别在任务栏把它最小化" },
						running && d.window !== "visible" ? Button({ disabled: busy, onClick: () => act("/douyin/window", { show: !d.windowShown }, null, "窗口挪不动") }, d.windowShown ? "藏起来" : "显示一下") : null,
						h(Seg, { label: "窗口", value: d.window === "visible" ? "visible" : "background", options: WINDOW_MODES, onChange: (v) => save({ top: { window: v } }) })),
					running && (host.loggedIn !== true || showShot) ? h(LoginView, { api, notify, refresh, ui }) : null),
				Group({ title: "私信" },
					d.channel?.identityBlocked
						? Row({ title: "私信身份未就绪", meta: d.channel?.identityState?.disabledByFlag ? "已被 DOUYIN_IDENTITY_BLOCKED 手动停用" : "尚未学到这个抖音号自己的 uid，正常聊过一轮后自动学到" },
							State("warning", "未就绪"))
						: Row({ title: "私信按会话认人", meta: (d.channel?.identityState?.selfUids ?? []).length ? `本号 uid：${d.channel.identityState.selfUids.join(" / ")}` : "按会话 ID 0:1:我方:对方 认人", desc: "昵称只作展示，改名或同名都不会串人；发送前用会话 ID 校验目标" },
							State("done", "已就绪")),
					Row({ title: "自动回复" }, d.autoReply ? null : Muted("只记不回"), sw("自动回复", d.autoReply === true, (v) => save({ top: { autoReply: v } }))),
					(d.channel?.inbox?.counts?.processing ?? 0) > 0 ? Muted(`正在处理 ${d.channel.inbox.counts.processing} 条；如果长时间不变，重启后核实`) : null,
					Row({ title: "主人身份", meta: "可选，仅用于标为主人，不影响收发私信", desc: "填你自己的抖音数字 uid；注意上面显示的是机器人自己这个号的 uid，不是你的。只填数字就行" },
						Input({ ...bind("masterUid"), inputMode: "numeric", "aria-label": "主人身份 uid", placeholder: "你的抖音数字 uid" })),
					Row({ title: "主人的名字", desc: "仅作显示，不授予任何权限" }, Input({ ...bind("masterName"), "aria-label": "主人的名字", placeholder: "她私信列表里你的名字" })),
					d.channel?.identityState?.masterUidMismatch
						? Row({ title: "这个 uid 认不出来" }, State("warning",
							`你填的 ${d.channel.identityState.masterUidMismatch.filled} 跟已学到的抖音身份对不上，多半填成了账号短号。留空就行；已学到的身份：${d.channel.identityState.masterUidMismatch.learned.join(" / ")}`,
							undefined, true))
						: null,
					(candidates ?? []).length === 0 ? null : Group({ title: "待确认的抖音身份" },
						Muted("请核对 uid 是不是你自己，确认后点「是我」。"),
						...(candidates ?? []).map((c) => Row({ key: c.name, title: `${c.name} → QQ ${c.qq}`,
							meta: `抖音 uid ${c.uid}${c.at ? ` · ${new Date(c.at).toLocaleString()}` : ""}` },
							Button({ variant: "primary", disabled: busy, onClick: async () => {
								setBusy(true);
								try {
									const r = await api("POST", "/douyin/uin-confirm", { name: c.name });
									if (r?.ok) { notify(`已确认：${c.name}`); await loadCandidates(); refresh(); }
									else notify(r?.error ?? "没确认成");
								} finally { setBusy(false); }
							} }, "是我"),
							Button({ variant: "outline", disabled: busy, onClick: async () => {
								setBusy(true);
								try {
									const r = await api("POST", "/douyin/uin-dismiss", { name: c.name });
									if (r?.ok) { notify(`已忽略：${c.name}`); await loadCandidates(); refresh(); }
									else notify(r?.error ?? "操作失败");
								} finally { setBusy(false); }
							} }, "不是我")))),
					Row({ title: "回所有能私信她的人", desc: d.replyAll ? "建议在抖音隐私设置里把「谁可以私信我」设为互关好友" : null },
						sw("回所有能私信她的人", d.replyAll === true, (v) => save({ top: { replyAll: v } }))),
					Row({ title: "超过多久的消息只记不回", desc: "断线补拉或重启后积压的老消息，超过这个时间就只记进记忆、不回复" },
							Num({ min: 1, max: 1440, value: form.replyWindowMinutes, "aria-label": "分钟", onChange: (e) => patch({ replyWindowMinutes: e.target.value }), onBlur: () => save({ top: { replyWindowMinutes: form.replyWindowMinutes === "" ? 120 : Number(form.replyWindowMinutes) } }) }), Muted("分钟")),
					d.replyAll ? null : Row({ title: "白名单", stack: true }, Area({ ...bind("allowList"), "aria-label": "白名单", placeholder: "对方的抖音数字 uid，每行一个；昵称不参与放行" }))),
				Group({ title: "群聊" },
					Row({ title: "群里被叫到时回", desc: "群聊按说话的人分开认，不会当成一个人；没人 @ 她或叫她名字时只看不说" },
						sw("群里被叫到时回", d.groupReply === true, (v) => save({ top: { groupReply: v } }))),
					Row({ title: "叫她的名字", stack: true }, Area({ ...bind("callNames"), "aria-label": "叫她的名字", placeholder: "她的抖音昵称等，每行一个" })),
					Row({ title: "这些会话是群", stack: true }, Area({ ...bind("groups"), "aria-label": "这些会话是群", placeholder: "认不出来的群在这里填会话名，每行一个" }))),
				Group({ title: "刷视频", aside: Tag(`今天 ${br.todayCount ?? 0} / ${br.perDay ?? 3}`, "outline") },
					Row({ title: "空闲时自己刷" },
						browseOn ? Button({ disabled: busy || br.running === true || d.enabled !== true || !running, onClick: () => act("/douyin/browse-now", {}, "开始刷了", "没刷成") }, br.running ? "正在刷…" : "现在刷") : null,
						sw("空闲时自己刷", browseOn, (v) => save({ browse: { enabled: v } }))),
					browseOn ? Row({ title: "每天" },
						Num({ min: 0, max: 12, "aria-label": "轮数", ...bind("perDay") }), Muted("轮 ×"),
						Num({ min: 1, max: 6, "aria-label": "每轮条数", ...bind("videosPerSession") }), Muted("条")) : null,
					browseOn ? Row({ title: "走接口刷", desc: "直接调抖音网页端接口拉推荐流和评论，不用开专用浏览器；关掉就回到浏览器里滑推荐页" },
						sw("走接口刷", br.mode !== "browser", (v) => save({ browse: { mode: v ? "http" : "browser" } }))) : null,
					browseOn ? Row({ title: "喜欢就点赞", desc: "模型判断特别喜欢时才点赞" }, sw("喜欢就点赞", br.like === true, (v) => save({ browse: { like: v } }))) : null,
					browseOn ? Row({ title: "喜欢就收藏", desc: "模型说想留着以后再看时收藏，默认关" }, sw("喜欢就收藏", br.collect === true, (v) => save({ browse: { collect: v } }))) : null,
					browseOn ? Row({ title: "抽帧看画面", desc: "把视频开头均匀抽 9 张拼成九宫格让模型识图；每条多一次识图调用" }, sw("抽帧看画面", br.frames === true, (v) => save({ browse: { frames: v } }))) : null,
					browseOn && br.frames === true ? Row({ title: "一天最多看几条", desc: "自己刷的时候，一天最多抽几次帧" },
						Num({ min: 0, max: 20, value: framesPerDay, "aria-label": "一天最多看几条", onChange: (e) => setFramesPerDay(e.target.value), onBlur: () => { if (framesPerDay === "") return; const n = Number(framesPerDay); if (Number.isFinite(n) && n !== br.framesPerDay) save({ browse: { framesPerDay: n } }); } }), Muted("条")) : null,
					browseOn ? Row({ title: "刷到有意思的发给你", desc: br.shareInDm !== false ? "带链接和感受发到你的抖音私信，没连上就发 QQ；一天最多 2 条" : "带链接和感受发到你的 QQ 私聊；一天最多 2 条" }, sw("刷到有意思的发给你", br.share !== false, (v) => save({ browse: { share: v } }))) : null,
					browseOn && br.share !== false ? Row({ title: "在抖音私信里分享", desc: "要填「主人的名字」、开自动回复" }, sw("在抖音私信里分享", br.shareInDm !== false, (v) => save({ browse: { shareInDm: v } }))) : null,
					browseOn && br.share !== false && br.shareInDm !== false ? Row({ title: "发原生视频卡片", desc: "在抖音私信里发点开就播的原生卡片；需专用浏览器开着，且按收件人身份锁定" }, sw("发原生视频卡片", d.shareCard === true, (v) => save({ top: { shareCard: v } }))) : null),
				Group({ title: "作品和评论", aside: (post.enabled || video.enabled) ? h("span", { className: "fs-group-aside" },
					post.enabled ? Tag(`今天发了 ${so.post?.todayCount ?? 0} / ${post.perDay ?? 1}`, "outline") : null,
					video.enabled ? Tag(`今天视频 ${so.video?.todayCount ?? 0} / ${video.perDay ?? 1}`, "outline") : null) : null },
					Row({ title: "自己发图文", desc: "把想说的话做成文字卡片，在创作者中心发图文；创作者中心可能要单独登录一次" },
						post.enabled ? Button({ disabled: busy || so.post?.running === true || so.video?.running === true || Boolean(so.postPending) || d.enabled !== true || !running, onClick: async () => {
							if (await confirm({ title: "现在发一条图文？", description: "将在抖音创作者中心公开发布一条图文动态。", confirmLabel: "发布" })) await act("/douyin/post-now", { text: noteText.trim() }, "发出去了", "没发成");
						} }, so.post?.running ? "正在发…" : "现在发一条") : null,
						sw("自己发图文", post.enabled === true, (v) => save({ post: { enabled: v } }))),
					post.enabled ? Row({ title: "指定内容", desc: "留空则按她此刻的心情随机写一条" }, Input({ value: noteText, onChange: (e) => setNoteText(e.target.value), placeholder: "想发什么就写在这里", "aria-label": "图文指定内容" })) : null,
					post.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 5, "aria-label": "每天最多几条", ...bind("postPerDay") }), Muted("条")) : null,
					// 视频：生成要调付费接口（按条计费）—— 开关旁边必须写清楚这是花钱的操作，点击前也要二次确认。
					Row({ title: "自己发视频", desc: "生成视频要调用付费接口（按条计费），每发一条都真花钱；创作者中心也要先登录过" },
						video.enabled ? Button({ variant: "ghost", disabled: busy || so.video?.running === true || so.post?.running === true || Boolean(so.postPending) || d.enabled !== true || !running, onClick: async () => {
							const ok = await confirm({ title: "确认生成并发布视频？", description: "将调用已配置的付费视频接口（按条计费），完成后自动上传到抖音创作者中心并发布。", confirmLabel: "开始生成并发布" });
							if (ok) await act("/douyin/video-now", {}, "已开始生成视频，完成后会自动发布", "没发成");
						} }, so.video?.running ? "正在发…" : "现在发一条视频") : null,
						sw("自己发视频", video.enabled === true, (v) => save({ video: { enabled: v } }))),
					video.enabled ? Row({ title: "服务商" },
						Select({ value: form.videoProvider, "aria-label": "视频服务商", onChange: (e) => { const v = e.target.value; patch({ videoProvider: v }); save({ video: { provider: v } }); } },
							...VIDEO_PROVIDERS.map((o) => h("option", { key: o.value, value: o.value }, o.label)))) : null,
					video.enabled ? Row({ title: "接口地址" }, Input({ ...bind("videoBaseURL"), placeholder: VIDEO_BASE_URLS[form.videoProvider] ?? "", "aria-label": "视频接口地址" })) : null,
					video.enabled ? Row({ title: "API Key" },
						h(Secret, { label: "视频 API Key", value: form.videoApiKey, placeholder: video.hasApiKey ? (video.apiKeyMasked ?? "已保存") : "粘贴 API Key", onChange: (e) => patch({ videoApiKey: e.target.value }), onBlur: () => { if (form.videoApiKey !== "") return save(); } })) : null,
					video.enabled ? Row({ title: "模型" }, Input({ ...bind("videoModel"), placeholder: "服务商那边的模型名", "aria-label": "视频模型" })) : null,
					video.enabled ? Row({ title: "时长" }, Num({ min: 4, max: 15, "aria-label": "视频时长", ...bind("videoDurationSec") }), Muted("秒")) : null,
					video.enabled ? Row({ title: "画面比例" },
						Select({ value: form.videoAspect, "aria-label": "画面比例", onChange: (e) => { const v = e.target.value; patch({ videoAspect: v }); save({ video: { aspectRatio: v } }); } },
							...VIDEO_RATIOS.map((o) => h("option", { key: o.value, value: o.value }, o.label)))) : null,
					video.enabled ? Row({ title: "分辨率" },
						Select({ value: form.videoResolution, "aria-label": "分辨率", onChange: (e) => { const v = e.target.value; patch({ videoResolution: v }); save({ video: { resolution: v } }); } },
							...VIDEO_RESOLUTIONS.map((o) => h("option", { key: o.value, value: o.value }, o.label)))) : null,
					video.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 5, "aria-label": "每天最多几条视频", ...bind("videoPerDay") }), Muted("条")) : null,
					so.postPending ? Row({ title: so.postPending.kind === "video" ? "视频结果待核实" : "图文结果待核实", meta: so.postPending.text || "先到创作者中心核实，不会自动重发" },
						Button({ disabled: busy || so.postPending.status !== "unknown", onClick: () => act("/douyin/post-resolve", { jobId: so.postPending.id, outcome: "not_published" }, "已记录为未发布", "记录失败") }, "已核实未发布"),
						Button({ disabled: busy || so.postPending.status !== "unknown", onClick: () => act("/douyin/post-resolve", { jobId: so.postPending.id, outcome: "published" }, "已记录为已发布", "记录失败") }, "已核实已发布")) : null,
					Row({ title: "回评论", desc: "每 20 分钟看看最近 3 个作品的评论区；抖音可能要短信验证，碰到会停下来提醒你" },
						cm.enabled ? Button({ disabled: busy || d.enabled !== true || !running, onClick: () => act("/douyin/comments-now", {}, "看完了", "没看成") }, "现在看一眼") : null,
						sw("回评论", cm.enabled === true, (v) => save({ comments: { enabled: v } }))),
					cm.enabled ? Row({ title: "每小时最多" }, Num({ min: 0, max: 30, "aria-label": "每小时最多回几条", ...bind("commentsPerHour") }), Muted("条")) : null,
					cm.enabled ? Row({ title: "允许发表情", desc: "把抖音的表情码（[微笑] 这种）写进提示词，平台会自动渲染成表情图" },
						sw("允许发表情", cm.emoji === true, (v) => save({ comments: { emoji: v } }))) : null,
					so.blockedUntil ? Row({ title: "等验证" }, State("error", `抖音要验证，${Math.max(1, Math.ceil((so.blockedUntil - Date.now()) / 3600000))} 小时内先不试；去浏览器里验证一下`, undefined, true)) : null,
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
					report === null ? null : h("pre", { className: "fs-report" }, reportText)),
				confirmNode);
		}

		return { DouyinPane };
	}
});
