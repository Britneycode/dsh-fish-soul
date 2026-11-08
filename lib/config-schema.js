// 插件 Config 的结构（从 index.js 拆出来，免得那边太长；B站 / 抖音那部分在 config-platforms.js）
import { biliConfigSchema, douyinConfigSchema } from './config-platforms.js';
import { DEFAULT_DAILY_MAX, DEFAULT_IDLE_REAL_GAP_MIN } from './life.js';

export function fishSoulConfigSchema(z) {
	return z.object({
		masterQqUin: z.string().default(''),
		qq: z.object({
			enabled: z.boolean().default(false),
			wsUrl: z.string().default('ws://127.0.0.1:3001'), // SnowLuma OneBot 11 正向 WS（Universal）
			accessToken: z.string().default(''),
			groupAllowList: z.array(z.string()).default([]), // 白名单：空 = 谁都不放行（默认拒绝）；群要在这里列出才会被回应
			allGroups: z.boolean().default(false), // 显式放开：true = 所有群（仍然只听点名）
			followUpCount: z.number().default(3),
			followUpSeconds: z.number().default(120),
			followUpSmart: z.boolean().default(false), // #59 她自己说"这轮聊完了"就不接着听（默认关）
			batchMs: z.number().default(3000),
			replyWindowMinutes: z.number().default(10),
			callNames: z.array(z.string()).default([]), // 叫这些名字也算点名；空 = 人格卡名字（≥2 个字才算）
			interject: z.object({ // 群里没点名时自己插一句（默认关）
				enabled: z.boolean().default(false),
				chance: z.number().default(0.05),
				cooldownMinutes: z.number().default(15),
				maxPerHour: z.number().default(3),
				keywords: z.array(z.string()).default([]),
				masterQuiet: z.boolean().default(true), // #59 主人在跟她聊时少插话（默认开）
				masterQuietMinutes: z.number().default(5) // 主人多久内说过话算"在聊"
			}).default({}),
			groupAdmin: z.object({ // 群管理：发版公告 + 入群申请（默认全关；群号在这里配，不进仓库）
				enabled: z.boolean().default(false),
				groupId: z.string().default(''), // 要管的群（公告发这里、入群申请也管这里）
				announce: z.boolean().default(true), // 发版时在群里公告更新说明
				autoApprove: z.boolean().default(true), // 入群申请自动同意；关 = 私聊通知主人，主人回"/鱼 同意/拒绝"
				approveReason: z.string().default(''),
				rejectReason: z.string().default(''),
				releasePollMinutes: z.number().default(5), // 多久问一次 npm 有没有新版本
				requestPollSeconds: z.number().default(60) // 多久问一次有没有没处理的入群申请
			}).default({})
		}).default({}),
		attachments: z.object({ // QQ 附件：txt/md 这类直接读进提示词；pdf/docx 存到插件数据目录再报路径
			readText: z.boolean().default(true),
			saveBinary: z.boolean().default(false)
		}).default({}),
		lore: z.object({ // 世界书：扫描最近几条消息、每轮最多带几条、总字数预算（条目自己写了 scanDepth 的以条目为准）
			scanDepth: z.number().default(4),
			maxEntries: z.number().default(6),
			budgetChars: z.number().default(1200)
		}).default({}),
		update: z.object({ // 版本更新：只检查、提示，不自动安装
			autoCheck: z.boolean().default(true)
		}).default({}),
		backup: z.object({
			auto: z.boolean().default(true), // 每天自动备份 soul.db
			keep: z.number().default(7)
		}).default({}),
		// v0.7：按功能选模型（{ provider, model }，空 = DSH 默认模型）+ 单价（元 / 百万 token，只用来估花费）
		models: z.dict(z.any()).default({}),
		modelPrices: z.dict(z.any()).default({}),
		voice: z.object({ // 语音：听 QQ 语音、偶尔发语音（听 / 说可以各配一套地址和 key；空 = 沿用下面的 baseURL/apiKey）
			enabled: z.boolean().default(false),
			baseURL: z.string().default(''), // 听说共用（老配置）；ttsBaseURL / sttBaseURL 优先
			apiKey: z.string().default(''),
			sttBaseURL: z.string().default(''), // 听（ASR）单独用的地址，空 = 用上面的
			sttApiKey: z.string().default(''),
			ttsBaseURL: z.string().default(''), // 说（TTS）单独用的地址，空 = 用上面的
			ttsApiKey: z.string().default(''),
			sttModel: z.string().default(''),
			ttsModel: z.string().default(''),
			ttsVoice: z.string().default(''),
			speak: z.string().default('mirror'), // never / mirror（对方发语音时可以回语音）/ sometimes
			maxChars: z.number().default(60),
			ttsPerDay: z.number().default(30),
			sttPerDay: z.number().default(200),
			timeoutSec: z.number().default(60) // 单次请求最多等几秒（长句合成经常超过 20 秒）
		}).default({}),
		stickers: z.object({
			collect: z.boolean().default(true), // 她觉得好玩的表情包存进 _stickers
			perDay: z.number().default(10),
			// B站 私信能用平台自带的表情（写 `[doge]` 这种码，服务端自己渲染）。
			// 默认关：多一个外部请求，且面板是按账号的，开之前得先确认能拿到。
			biliPanel: z.boolean().default(false),
			biliPanelListed: z.number().default(30) // 提示词里最多列几个码（面板有 400+，放不下）
		}).default({}),
		images: z.object({ // 发图：打开后模型可以发工作区里任意图片（默认只发 _stickers 里的表情包）
			sendAny: z.boolean().default(false)
		}).default({}),
		slang: z.object({
			enabled: z.boolean().default(true), // 学群里的梗 / 说话风格
			minLines: z.number().default(60),
			intervalHours: z.number().default(6),
			expressions: z.boolean().default(true), // 学「什么场合怎么说」（只学别人的话、不带人名）
			privateChats: z.boolean().default(true) // 好友私聊也学（只在那个私聊里用）
		}).default({}),
		tools: z.object({
			web: z.object({ // 让她能上网查东西（默认关）：DSH 自带的 web_search，或自己填的搜索 API key
				enabled: z.boolean().default(false),
				perDay: z.number().default(20),
				provider: z.string().default('host'), // host | bocha | tavily | brave | searxng
				apiKeys: z.dict(z.string()).default({}), // 每个搜索服务各存一个 key，切换不丢
				baseURL: z.string().default('') // SearXNG 地址
			}).default({}),
			// #37 聊天会话（QQ / B站 / 抖音）放行哪些工具：memory 只放记忆 + 联网（默认）| master 主人的私聊会话放开宿主全部工具 | all 所有会话全放
			sessionAllow: z.string().default('memory')
		}).default({}),
		onboarding: z.object({ dismissed: z.boolean().default(false) }).default({}),
		storage: z.object({ auto: z.boolean().default(true), keep: z.number().default(0), warnMB: z.number().default(1024), freeMB: z.number().default(512) }).default({}),
		// 聊天原文存档（本地 SQLite，0600 权限）。
		// ⚠️ 默认开：它是记忆体系的「原始记录层」—— 睡前整理（Dream）要靠它核对记忆有没有记错
		//    （原来默认关 + 要显式列会话 = 这一层一直是空的，Dream 只能拿结论校验结论）。
		// channels 留空 = **所有会话**都记；填了就只记这些。
		chatArchive: z.object({ enabled: z.boolean().default(true), channels: z.array(z.string()).default([]), days: z.number().default(30) }).default({}),
		memory: z.object({ // v0.8 聊完自动记：一段聊天空下来 idleMinutes 分钟（或攒够 maxLines 句）就整理一次
			autoExtract: z.boolean().default(true),
			weeklyAuto: z.boolean().default(false),
			idleMinutes: z.number().default(10),
			maxLines: z.number().default(40),
			// Dream 复核时要不要拿「聊天原文」当参照（默认关）。
			// 关着就只看她已经记下的结论 —— 结论本身错了她发现不了。
			// 开了要配合 chatArchive（原文存在那）。取不到原文就自动退回只看记忆。
			transcriptReview: z.boolean().default(false),
			transcriptMaxLines: z.number().default(40) // 一次最多给多少条原文（夹到 1~200）
		}).default({}),
		growth: z.object({ // 她慢慢长出来的变化：聊完整理时攒证据，够了才生效（人格页可看 / 删 / 清空）
			enabled: z.boolean().default(true),
			autoApply: z.boolean().default(true) // false = 证据够了也先等主人确认
		}).default({}),
		relationship: z.object({ // 每个关系阶段怎么说话（空 = 内置说法）
			styles: z.dict(z.string()).default({})
		}).default({}),
		bili: biliConfigSchema(z), // B站：登录凭据不在这里（存 $DSH_HOME/fish-soul/bili-auth.json）
		douyin: douyinConfigSchema(z), // 抖音：登录态在专用浏览器的 profile 里，不在这里
		sessions: z.object({
			workspacePath: z.string().default('') // 空 = $DSH_HOME/fish-soul/workspace（专用工作区"鱼"）
		}).default({}),
		embedding: z.object({
			enabled: z.boolean().default(true),
			baseURL: z.string().default(''),
			apiKey: z.string().default(''),
			model: z.string().default(''),
			timeoutMs: z.number().default(800)
		}).default({}),
		retrieval: z.object({
			fusionMethod: z.string().default('rrf'),
			tierWeights: z.object({ recent: z.number().default(1.1), longTerm: z.number().default(1.2), weekly: z.number().default(0.9) }).default({}),
			topK: z.number().default(5),
			tokenBudget: z.number().default(1200)
		}).default({}),
		proactive: z.object({
			enabled: z.boolean().default(true),
			dailyMaxCount: z.number().default(DEFAULT_DAILY_MAX),
			activeHours: z.array(z.number()).default([8, 24]),
			idleTriggerHours: z.number().default(6),
			// #75：主人刚说过话就别立刻主动开口（真实分钟，0 = 关掉这道护栏）
			idleRealGapMinutes: z.number().default(DEFAULT_IDLE_REAL_GAP_MIN),
			// #75：自走日程开关。关掉 = 不生成日程、不注入时段、不用忙/闲卡住主动与刷视频
			scheduleEnabled: z.boolean().default(true),
			shareMaxPerDay: z.number().default(2), // 刷到想分享的视频，一天最多主动发几条
			targets: z.object({
				masterCanonicalId: z.string().default('user:master'),
				masterPrivateChannelId: z.string().default(''),
				selfGroupChannelIds: z.array(z.string()).default([])
			}).default({})
		}).default({})
	});
}
