// B站 / 抖音的配置结构（从 index.js 拆出来，免得那边太长）

// B站：登录凭据不在这里（存 $DSH_HOME/fish-soul/bili-auth.json）
export function biliConfigSchema(z) {
	return z.object({
		enabled: z.boolean().default(false),
		autoReply: z.boolean().default(false), // 关 = 只记不回（建议先跑一周）
		masterUid: z.string().default(''),
		allowList: z.array(z.string()).default([]),
		replyMutual: z.boolean().default(true), // 互关的人也回
		links: z.array(z.string()).default([]), // "B站UID=QQ号"，同一个人
		proactive: z.boolean().default(false), // 主动给主人发 B站私信
		pollSeconds: z.number().default(20),
		batchMs: z.number().default(3000),
		replyWindowMinutes: z.number().default(10),
		browse: z.object({
			enabled: z.boolean().default(true),
			perDay: z.number().default(3),
			videosPerSession: z.number().default(3),
			like: z.boolean().default(false),
			share: z.boolean().default(true), // 刷到特别想分享的，给主人发链接 + 感受（走主动开口的限制）
			favorite: z.boolean().default(false), // 想再看的收藏到默认收藏夹
			favoritePerDay: z.number().default(2),
			danmaku: z.boolean().default(true), // 看视频时也看几条弹幕（只读）
			search: z.boolean().default(false), // 按关键词站内搜一下，当作刷视频的又一个来源（只读）
			searchKeywords: z.array(z.string()).default([]), // 想引导就填几个词；空 = 让她自己按最近看过的提
			searchPerDay: z.number().default(2) // 一天最多搜几次
		}).default({}),
		post: z.object({ // 自己发动态（纯文字）
			enabled: z.boolean().default(false),
			perDay: z.number().default(1)
		}).default({}),
		comments: z.object({ // 回自己评论区里的留言
			enabled: z.boolean().default(false),
			perHour: z.number().default(6),
			atMe: z.boolean().default(false), // 别人视频评论区里 @ 她也回（公开可见，默认关）
			atReadVideo: z.boolean().default(false) // @ 她时先读一下视频的简介和字幕再回（多两次接口调用，默认关）
		}).default({})
	}).default({});
}

// 抖音：登录态在专用浏览器的 profile 里（$DSH_HOME/fish-soul/douyin-browser/<浏览器>），不在这里
export function douyinConfigSchema(z) {
	return z.object({
		enabled: z.boolean().default(false),
		autoReply: z.boolean().default(false), // 关 = 只记不回
		masterName: z.string().default(''), // 主人在抖音私信里显示的名字
		allowList: z.array(z.string()).default([]), // 会话名
		replyAll: z.boolean().default(false), // 回所有能私信她的人（建议抖音里设"谁可以私信我 = 互关好友"）
		links: z.array(z.string()).default([]), // "抖音名字=QQ号"，同一个人
		groups: z.array(z.string()).default([]), // 认不出来的抖音群：手动填会话名，按群聊处理（按发言的人分开认）
		groupReply: z.boolean().default(false), // 抖音群里有人 @ 她 / 叫她名字时回（默认关：群里只看不说）
		callNames: z.array(z.string()).default([]), // 抖音群里叫她的名字（比如她的抖音昵称）；QQ 那边的称呼 / 人格卡名字也算
		batchMs: z.number().default(3000),
		replyWindowMinutes: z.number().default(10),
		browser: z.object({
			kind: z.string().default('edge'),
			customPath: z.string().default('')
		}).default({}),
		window: z.string().default('background'), // background = 窗口停在屏幕外不打扰；visible = 正常显示
		browse: z.object({
			enabled: z.boolean().default(false),
			perDay: z.number().default(3),
			videosPerSession: z.number().default(3),
			like: z.boolean().default(false),
			share: z.boolean().default(true), // 刷到特别想分享的，给主人发链接 + 感受（走主动开口的限制）
			shareInDm: z.boolean().default(true) // 抖音刷到的分享发在抖音私信里（主人；抖音没开 / 没连上就发 QQ）
		}).default({}),
		post: z.object({ // 自己发图文作品（文字卡片 + 文案，走创作者中心，尽力而为）
			enabled: z.boolean().default(false),
			perDay: z.number().default(1)
		}).default({}),
		comments: z.object({ // 回自己作品下的评论（页面操作，尽力而为，可能要短信验证）
			enabled: z.boolean().default(false),
			perHour: z.number().default(4)
		}).default({})
	}).default({});
}
