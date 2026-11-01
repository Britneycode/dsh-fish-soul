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
			share: z.boolean().default(true) // 刷到特别想分享的，给主人发链接 + 感受（走主动开口的限制）
		}).default({}),
		post: z.object({ // 自己发动态（纯文字）
			enabled: z.boolean().default(false),
			perDay: z.number().default(1)
		}).default({}),
		comments: z.object({ // 回自己评论区里的留言
			enabled: z.boolean().default(false),
			perHour: z.number().default(6)
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
