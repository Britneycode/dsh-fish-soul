# dsh-fish-soul

让一个 QQ 小号背后有"同一个人"：固定人格、按人记记忆、有自己的生活节奏、会主动开口；同一个"她"同时出现在 QQ、B站、抖音。

DSH 插件（单角色 `feiyu`）。版本 **0.15.55**。

QQ 交流群：**1125962189**

## 能力

| 面 | 内容 |
|---|---|
| 人格 | 设置页「人格」：7 个内置模板一键换上（第一个「肥鱼 · 通用」只定性格和说话方式、生活细节聊着聊着才有，后面 6 个带现成的生活细节）、可视化编辑、导入 / 导出 SillyTavern 角色卡（PNG / JSON）、撤销上次更换，换完下一轮生效；角色卡（PNG / ccv3 / chara），`{{char}}` / `{{user}}` 宏，世界书（constant / 关键词，可单独导入多本 SillyTavern 世界书：正则 / 整词 / 次要关键词、扫描深度、条数和字数预算）；卡里的作息（`extensions.fish_soul.routine`）用来排每天的日程、「看事情的方式」（`perspective`）进人格段、「不同心情下怎么说话」（`moods`）跟着她当下的心情带上；模板按气质分、不绑职业；聊久了会「慢慢长」（性格 / 看法的变化要多次、跨天、跨聊天的证据才生效，人格页可看可删）；从群聊 / 好友私聊里学梗、说话风格和「什么场合怎么说」（只学别人的话、不带人名，按学到的次数挑几条参考） |
| 记忆 | 按人隔离、本轮即时召回（BM25 + 向量 RRF）、艾宾浩斯衰减（重要度高不淡）、可纠正（留旧档）、出处 `evidence`、每人 ≤150 字印象、8 栏结构化印象、关系阶段演进、好感与情绪、旧聊天记录导入（断点续传，较早的聊天按时间段总结）、导入麦麦的表情包 / 表达方式 / 黑话、记忆页搜索与批量操作（删除 / 恢复 / 重要度 / 私密）、每周压缩存档与容量告警、可选周记（见文末两节）；**聊完自动记**（一次调用产出事实 / 事件 / 感受 + 一句话小结，去重合并）；**隐私**：私聊里的敏感记忆标 `private`，群里检索和召回都不带 |
| 生活 | 虚拟时钟、每日作息与基调、Dream 整理（只补没写的、会标过时）、主动开口与配额 |
| QQ | 直连 SnowLuma（OneBot 11 正向 WS）：私聊 / 群聊、群合批带署名、只听点名、戳一戳、撤回不回、可选插话、打字节奏、`/鱼 暂停`；**群默认拒绝**（`groupAllowList` 为空且没开 `allGroups` 时谁都不回）、**没发出去的回复排队重发**（退避重试，连上即补发，重启不丢） |
| B站 | 扫码登录、私信（只读 / 自动回复）、跨平台认人、空闲自己刷视频（看字幕 / 热评 / 弹幕，喜欢可点赞、想再看可收藏，站内搜索当又一个来源，后三个默认关）、自己发动态 / 回评论（默认关；可选别人评论区里 @ 她也回，@ 时先读一下视频）、Cookie 自动续期、发图 |
| 抖音 | 专用浏览器扫码登录、私信按会话 ID 认人（`0:1:我方:对方`，昵称只作展示；改名 / 同名都不串）、canary 防风控、空闲刷视频、自己发图文 / 回作品评论（默认关；图文须确认配乐成功才发布）、刷到的视频可发**原生视频卡片**给主人（默认关，见下） |
| 习惯 | 心情影响说话（快慢、长短、插话概率、表情包多少）、**去 AI 味**（删 markdown / AI 自称 / 套话，太长按句末截）、**每晚写日记**（私密记忆，第二天想跟谁聊）、合并转发展开、每个群的设定（气氛 / 忌讳）、**按聊天选模型**、群冷热、记忆调试器（输一句话看会想起哪几条）、戳回去 / 表情回应 |
| 语音 | `get_record` → STT；回复 `[语音]` → TTS 发 record（失败 / 太长发文字）；听 / 说可以各配一套地址和 key。**听**支持 OpenAI 兼容（硅基流动 SenseVoice 等，走 `/audio/transcriptions`）、阿里百炼（走 `/chat/completions` + `input_audio`，百炼没有 `/audio/transcriptions`）、MiniMax（`/v1/speech_to_text`）；**说**支持 OpenAI 兼容、小米 MiMo、火山引擎豆包语音（新版控制台只填 API Key 走 V3，默认 Resource ID `seed-tts-2.0`；老版填 AppID + Access Token 走 V1，集群默认 `volcano_tts`）、MiniMax（`/t2a_v2`，音色填控制台的 `voice_id`，可用复刻音色）。单次等待上限可调（默认 60 秒，长句不再被 20 秒掐掉） |
| 模型 | 按功能选模型、按天 × 功能 × 模型统计用量与花费、可选上网查 |
| 群管理 | 可选（默认关）：发新版本时把更新说明发到指定群（自动盯 npm，同一版本只发一次）、处理入群申请（默认自动同意，也可改成私聊通知你、你回「/鱼 同意 / 拒绝」拍板）；设置页「QQ 接入 → 群管理」里配开关与群号 |
| 运维 | 单聊天暂停、动态页、每日自动备份（留 7 份，设置页可恢复到某一份，重启生效）、设置文件读不懂时拒绝覆盖（带 BOM 也能读）、记忆导出 / 原样导回；设置页顶部显示当前版本，**自动检查更新**（npm / GitHub，每 12 小时，只提示不安装，可关） |

## 安装

**第一次装、想照着一步步走**：[从零跑起来](https://github.com/Britneycode/dsh-fish-soul/blob/main/docs/QUICKSTART.md) —— 五步到她在 QQ 里回你第一句话，每步都写了怎么确认成功、卡住了是什么原因。

需要 Node ≥ 22.5。抖音专用浏览器需要一台常开的 Windows 桌面。

从 npm：

```
dsh plugin --profile desktop add dsh-fish-soul
```

本地源码：`dsh plugin --profile desktop add ./dsh-fish-soul`。

手工等价：profile 的 `package.json` 把 `dsh-fish-soul` 加进 `dsh.profile.bundles`，并在 `dependencies` 里写 `dsh-fish-soul` 的版本（本地源码则用 `link:` 路径），然后 `pnpm install`。

插件注入 `webServer / tools / systemPrompt / llm / agents / workspaceRegistry`。在支持主面板的 DSH 版本中，左侧栏「鱼」可打开独立工作台；设置页入口也保留。旧宿主若不提供侧栏面板插槽，仍可从设置页打开（六大类：「记忆 / 角色 / 日常 / 平台 / 模型 / 系统」，每类下按任务拆子页）。

已在 DSH **0.2.1-rc.5** 上验证；更早的 rc 版本未逐一验证，遇到问题请先升级复测。

设置页读不到时怎么分辨：

- **HTTP 404**：插件后台根本没加载（或宿主没把 `/api/plugins/fish-soul/*` 转给插件）。看宿主日志里有没有 `[fish-soul] 启动闸门已挂`。
- **503「插件还在启动 / 插件启动失败，挂在第 N 步…」**：插件加载了，但初始化还没走完或中途失败。宿主日志里有对应的 `[fish-soul] 启动失败：挂在第 N/M 步「…」` 和错误堆栈；走完会打 `[fish-soul] 路由已挂`。

## 配置与数据

`$DSH_HOME` 缺省 `~/.dsh`。

| 路径 | 内容 |
|---|---|
| `fish-soul-config.json` | 全部设置（含 embedding `apiKey`） |
| `fish-soul/soul.db` | 单一 SQLite：记忆、人物、日程、会话映射、向量、kv |
| `fish-soul/persona.json` / `persona.png` | 人格卡（json 优先）；设置页改过的存成 persona.json，旧的进 `persona-backups/`（留 20 份），`persona.prev.json` 用来撤销 |
| `fish-soul/bili-auth.json` | B站凭据（0600，类 Unix 上） |
| `fish-soul/douyin-browser/<浏览器>/` | 抖音登录态（专用浏览器 profile） |
| `fish-soul/workspace/` | 默认专用工作区「鱼」，表情包在 `_stickers/` |
| `fish-soul/backups/` | 每日 `VACUUM INTO` 备份 |
| `fish-soul/img-cache/` | webp → png 缓存 |
| `fish-soul/chat-archive.db` | 聊天存档（默认开，按人/按天） |
| `fish-soul/archives/` | 聊天存档归档文件 |

### 抖音私信安全暂停与收件恢复

**身份按会话 ID 判定，不按昵称。** 单聊会话 ID 是 `0:1:<我方uid>:<对方uid>`，抖音在每条消息上都给；它自带双方 uid，所以「这条消息属于哪个会话、对方是谁」可以由平台数据独立确认，不需要昵称。实现见 `lib/douyin-conversation.js`。

三道闸门：读的时候按会话挑响应（不再挑「消息最多」的那条，那是串会话的根源）；入库前要求会话 ID 是单聊形状且能推出对端，拿不到就整批拒绝并留缺口提示；发送时把会话 ID 一路带到驱动层，每段内容提交前校验当前会话，拿不到就发不出去。重发队列也持久化会话 ID（重发可能隔了几分钟，期间会话可能被切走）。

授权同样只看身份：设置页「主人身份」填 `douyin:<你的数字 uid>`；昵称 `masterName` 只用于显示，旧的「昵称 = QQ 号」对应表不再生效（保留但不再授权）。白名单也填身份键。

**一键回退**：`lib/channels/douyin.js` 的 `DOUYIN_IDENTITY_BLOCKED` 设成 `true` 即恢复成「私信一律不处理、不发送」。

收件读取前会记录读取意图；读取失败或中断时会记一条缺口（设置页不再展示这类提示，缺口 7 天后自动清理）。收件记录与游标以事务写入；处理中的任务中断后标记为结果未知，同会话后续待处理消息会等它 —— 设置页不再提供人工核实，结果未知超过 24 小时自动作废，那个会话才继续走。窗口不重叠时只记缺口，无法保证发现所有缺失；上游在入库前可能已标记消息已读，缺口记录不能找回消息，也不能保证完整收取或恰好执行一次。现有接口缓存可能跨会话混入数据，待核实消息的会话名和来源都不可信，不应据此自动关联身份。

### 原生视频卡片分享

设置页「抖音 → 刷到有意思的发给你 → 发原生视频卡片」（默认关）。开启后，刷到特别想分享的视频会发抖音私信里那条**点开就播的原生卡片**，不发链接、不下载文件。这条路**不经过模型**：作品 ID 和感受在入队时就落盘，模型只负责「说什么」，漏抄链接或回个「[不回]」都不影响卡片发出去。

收件人只认**已确认身份的主人**：设置页「主人身份」填 `douyin:<你的数字 uid>`，且双方已经聊过（会话 ID 确认过）。分享面板里每个按钮都叫「分享」，所以按按钮上的 `data-userid` 精确匹配 —— 缺失、重复、被遮挡、不在视口一律**不发送**，绝不按名字点。

证据只有一条：回到目标私信，读原生卡片气泡里平台自己的 `parsedContent.itemId`，和要分享的作品 ID 对上才算数。「分享成功」的提示、文字链接、上传的视频都不算。

🔴 **不保证「恰好一次」**。卡片和说明分两阶段落盘：卡片没确认就不能拿「文字发成功了」结账；卡片确认了、说明失败只重试说明，不重发卡片；提交后结果未知一律不自动重发（可能已经发出去了），留在待核实里等人工确认。抖音改版会坏 —— 坏的时候会给出具体失败原因，不会假装成功。

### 入站媒体安全边界

QQ 附件、入站图片和语音里的 URL 都是不可信输入：只下载解析到公网 IPv4 的 HTTP(S) 地址（仅 80/443 端口），每次跳转重新检查，并按实际字节限制大小；不自动使用环境代理。IPv6-only 地址、内网地址、自定义端口及入站 `file://`/本地语音路径默认拒绝，无法读取时保留占位或显示听不了。内网 SnowLuma 或需要代理的媒体地址可能因此不可用；不要把公网 URL 的限制误认为覆盖其他业务的联网请求。QQ 本地附件仍按工作区/数据目录白名单处理。

## 开发与审查

修改代码或审查 PR 前，请阅读 [工程经验与 PR 准入](docs/engineering-lessons.md)。

## 目录

```
lib/
  index.js            插件入口：配置 schema、工具、瞬态块、路由
  db.js               soul.db、DDL、身份映射
  retrieval.js        BM25 + 向量 RRF、单队列双优先级 worker
  segment.js          中文分词（Intl.Segmenter）与停用词
  life.js             虚拟时钟、作息、Dream、主动开口
  clock.js            虚拟钟 / 物理钟隔离
  soul-memory.js      聊完自动记、检索词组装、关系阶段、印象、情绪
  behavior.js         心情影响行为、去 AI 味、日记、记忆调试
  gateway.js          QQ 会话 / 群合批 / 工具护栏
  gateway-behavior.js 网关里的习惯（v0.9 混入）
  gateway-media.js    网关里的图片 / 私信（混入）
  llm.js              按功能路由模型（LlmRouter）
  voice.js            语音收发（听 / 说可分开配）
  stickers.js         表情包收藏
  slang.js            学说法：梗、说话风格、说话方式
  persona.js          角色卡解析、规整、保存 / 撤销
  persona-templates.js 内置人格模板
  growth.js           她慢慢长出来的变化（证据、生效、退场）
  social.js           B站 / 抖音共用的发动态与回评论（SocialBase）
  douyin-social.js    抖音发图文、回作品评论
  browse.js           B站自己刷视频
  websearch.js        上网查
  importer.js         记忆导入
  history-import.js   聊天记录导入（txt / jsonl / json / MaiBot）
  backup.js           备份与导出
  chat-archive.js     聊天存档（默认开）
  storage.js          存档存储、weekly.js 周记
  outbox.js           私信出站队列（三态发送、持久化 conv_id）
  safe-download.js    图片下载护栏、bounded-response.js 响应上限
  douyin-inbox.js     抖音私信持久化收件箱、douyin-conversation.js 会话身份纯函数
  douyin-delivery.js  抖音私信发送、douyin-http.js 纯 HTTP 读接口
  douyin-post-jobs.js 抖音发作品队列、douyin-browse.js 抖音刷视频
  worldinfo.js        世界书（safeRegexTest 限时）
  memory-bulk.js      批量记忆、memory-label.js 记忆来源标签
  config-schema.js / config-platforms.js 配置 schema
  self-update.js      一键更新、update-check.js 更新检查
  session-health.js   抖音登录健康、snowluma-token.js SnowLuma token
  browsers.js         浏览器发现、imageconv.js 图片格式转换
  video-frames.js     视频抽帧、qq-group-admin.js 群管理
  time-util.js        sleep / pad2 等共用工具
  capability.js       能力陈述防误记
  attachments.js      附件处理、bili-emotes.js B站表情
  gateway-util.js     网关工具函数、maibot-extras.js MaiBot 导入辅助
  channels/           snowluma / onebot / bilibili / douyin
  channels/vendor/    抖音页面桥（douyin-bridge/）、qq-bridge.js
  client*.js          设置页（按需加载）
  routes*.js          HTTP 路由（v07 / v09 / persona / douyin / soul / update / worldinfo）
test/
  smoke.mjs           模拟宿主的主流程（依次跑 smoke-v05 ~ v09、smoke-persona、smoke-social 子套件）
  douyin-browser.mjs  真 Chromium + 假 www.douyin.com
  eval/               真模型评测：persona-eval（人格 19 场景）、growth-eval（慢慢长）、inject-eval（防注入）
```

## 测试

```
npm test        # 模拟宿主 + 真实 headless Chromium 跑两套；找不到 Chromium 系浏览器或 `openssl` 时，浏览器用例自动跳过
npm run eval    # 用真模型做人格评测（规则 + 模型评审，需要配好可用的模型），结果写在 test/eval/reports/
```

## 许可

MIT
### 周记（可选）

在「记忆检视」的「周记」中，可手动生成或开启自动生成。默认关闭；开启或手动运行前会提示：该功能使用「写日记」配置的模型，记忆内容（包括私密内容）可能发送至远程模型并产生调用费用。每次最多处理 20 条已结束自然周的记忆，按人物、会话和隐私范围分批；模型失败不会更改原记忆。

周记是带来源的派生记忆，不会删除原文，也不等于释放磁盘空间。可在记忆检视中查看来源；原记忆内容、范围、隐私或状态变更后，关联周记自动失效且不能恢复，已处理原文不会自动重新生成。数据库备份保留周记及其来源关系；普通 JSON 记忆导入不恢复派生周记，请使用数据库备份恢复。

### 存档与容量管理

「记忆检视 → 记忆存档」可搜索当前库的全部记忆记录（包括已归档和失效记录）。每周空闲时默认创建完整数据库压缩快照；可暂停、手动生成、查看和删除。生成先通过 SQLite 一致性快照，再 gzip 并解压校验 SHA-256，成功后才完成；周记整理前也会先确保近期存在校验通过的存档。恢复先解压并运行数据库校验，确认后在下次启动时替换库，替换前会保留当前库的恢复前备份。快照保留历史，不会自动删除；在线记忆也不会因压缩被删除，所以压缩存档**不等于减少在线数据库占用**。

容量界面显示数据库、存档、备份、聊天文本的占用和磁盘剩余空间，并允许设置告警阈值；上下文指标仅按字符估计记忆片段的预算占用，连续接近上限时在页面标题栏提示，不代表模型完整上下文 Token 用量。预算不够放下某条匹配记忆时，会尝试后续较短的匹配结果，而不是直接停止。磁盘不足时停止创建存档。存档和备份位于本地，未加密，可能包含私密记忆；删除在线记录不会删除先前的存档或备份，请单独管理。

QQ 重发队列只重试明确未送达的消息。重发过程中如果程序中断，消息会标记为**状态未知**，不会自动重发；请先在 QQ 中核实，避免重复发送。断线期间队列降低检查频率，连接恢复后会立即尝试补发。

「聊天文本存档」**默认开启**（`chatArchive.enabled`，v0.15.25 起）：会话列表**留空 = 记下所有会话**；只有填了会话 ID（如 `private:123`、`group:456`）才按白名单过滤。**不想要就在设置页关掉，或按会话删**。仅保存插件实际接入并写入聊天日志的文本，不包含附件、未被接入的消息或历史消息，不能保证平台聊天全量；历史请另行导入。文本单独存于未加密的本地数据库，可分会话查看或删除，默认保留 30 天、过期文本在插件运行期间清理；离线期间不会清理。缩短期限可能立即删除过期文本；用户自行制作的备份和复制件需要另行删除。
