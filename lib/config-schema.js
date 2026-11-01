// 插件 Config 的结构（从 index.js 拆出来，免得那边太长；B站 / 抖音那部分在 config-platforms.js）
import { biliConfigSchema, douyinConfigSchema } from './config-platforms.js';
import { DEFAULT_DAILY_MAX } from './life.js';

export function fishSoulConfigSchema(z) {
	return z.object({
		masterQqUin: z.string().default(''),
		qq: z.object({
			enabled: z.boolean().default(false),
			wsUrl: z.string().default('ws://127.0.0.1:3001'), // SnowLuma OneBot 11 正向 WS（Universal）
			accessToken: z.string().default(''),
			groupAllowList: z.array(z.string()).default([]), // 空 = 所有群（仍然只听点名）
			followUpCount: z.number().default(3),
			followUpSeconds: z.number().default(120),
			batchMs: z.number().default(1500),
			replyWindowMinutes: z.number().default(10),
			callNames: z.array(z.string()).default([]), // 叫这些名字也算点名；空 = 人格卡名字（≥2 个字才算）
			interject: z.object({ // 群里没点名时自己插一句（默认关）
				enabled: z.boolean().default(false),
				chance: z.number().default(0.05),
				cooldownMinutes: z.number().default(15),
				maxPerHour: z.number().default(3),
				keywords: z.array(z.string()).default([])
			}).default({})
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
			sttPerDay: z.number().default(200)
		}).default({}),
		stickers: z.object({
			collect: z.boolean().default(true), // 她觉得好玩的表情包存进 _stickers
			perDay: z.number().default(10)
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
			}).default({})
		}).default({}),
		onboarding: z.object({ dismissed: z.boolean().default(false) }).default({}),
		memory: z.object({ // v0.8 聊完自动记：一段聊天空下来 idleMinutes 分钟（或攒够 maxLines 句）就整理一次
			autoExtract: z.boolean().default(true),
			idleMinutes: z.number().default(10),
			maxLines: z.number().default(40)
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
			topK: z.number().default(5),
			tokenBudget: z.number().default(1200)
		}).default({}),
		proactive: z.object({
			enabled: z.boolean().default(true),
			dailyMaxCount: z.number().default(DEFAULT_DAILY_MAX),
			activeHours: z.array(z.number()).default([8, 24]),
			idleTriggerHours: z.number().default(6),
			shareMaxPerDay: z.number().default(2), // 刷到想分享的视频，一天最多主动发几条
			targets: z.object({
				masterCanonicalId: z.string().default('user:master'),
				masterPrivateChannelId: z.string().default(''),
				selfGroupChannelIds: z.array(z.string()).default([])
			}).default({})
		}).default({})
	});
}
