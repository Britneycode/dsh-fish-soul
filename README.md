# dsh-fish-soul

让一个 QQ 小号背后有"同一个人"：固定人格、按人记记忆、有自己的生活节奏、会主动开口；同一个"她"同时出现在 QQ、B站、抖音。

DSH 插件（单角色 `feiyu`）。版本 **0.11.0**。

## 能力

| 面 | 内容 |
|---|---|
| 人格 | 设置页「人格」：7 个内置模板一键换上（第一个「肥鱼 · 通用」只定性格和说话方式、生活细节聊着聊着才有，后面 6 个带现成的生活细节）、可视化编辑、导入 / 导出 SillyTavern 角色卡（PNG / JSON）、撤销上次更换，换完下一轮生效；角色卡（PNG / ccv3 / chara），`{{char}}` / `{{user}}` 宏，世界书（constant / 关键词）；卡里的作息（`extensions.fish_soul.routine`）用来排每天的日程、「看事情的方式」（`perspective`）进人格段、「不同心情下怎么说话」（`moods`）跟着她当下的心情带上；模板按气质分、不绑职业；聊久了会「慢慢长」（性格 / 看法的变化要多次、跨天、跨聊天的证据才生效，人格页可看可删）；从群聊 / 好友私聊里学梗、说话风格和「什么场合怎么说」（只学别人的话、不带人名，按学到的次数挑几条参考） |
| 记忆 | 按人隔离、本轮即时召回（BM25 + 向量 RRF）、艾宾浩斯衰减（重要度高不淡）、可纠正（留旧档）、出处 `evidence`、每人 ≤150 字印象、8 栏结构化印象、关系阶段演进、好感与情绪、旧聊天记录导入；**聊完自动记**（一次调用产出事实 / 事件 / 感受 + 一句话小结，去重合并）；**隐私**：私聊里的敏感记忆标 `private`，群里检索和召回都不带 |
| 生活 | 虚拟时钟、每日作息与基调、Dream 整理（只补没写的、会标过时）、主动开口与配额 |
| QQ | 直连 SnowLuma（OneBot 11 正向 WS）：私聊 / 群聊、群合批带署名、只听点名、戳一戳、撤回不回、可选插话、打字节奏、`/鱼 暂停` |
| B站 | 扫码登录、私信（只读 / 自动回复）、跨平台认人、空闲自己刷视频、自己发动态 / 回评论（默认关）、Cookie 自动续期、发图 |
| 抖音 | 专用浏览器扫码登录、私信（只读 / 自动回复）、canary 防风控、空闲刷视频、刷到的分享发抖音私信、自己发图文 / 回作品评论（默认关，尽力而为）、表情包复用 |
| 习惯 | 心情影响说话（快慢、长短、插话概率、表情包多少）、**去 AI 味**（删 markdown / AI 自称 / 套话，太长按句末截）、**每晚写日记**（私密记忆，第二天想跟谁聊）、合并转发展开、每个群的设定（气氛 / 忌讳）、**按聊天选模型**、群冷热、记忆调试器（输一句话看会想起哪几条）、戳回去 / 表情回应 |
| 语音 | `get_record` → STT；回复 `[语音]` → TTS 发 record（失败 / 太长发文字）；听 / 说可以各配一套地址和 key（TTS 支持小米 MiMo） |
| 模型 | 按功能选模型、按天 × 功能 × 模型统计用量与花费、可选上网查 |
| 运维 | 单聊天暂停、动态页、每日自动备份（留 7 份）、记忆导出 / 原样导回 |

## 安装

需要 Node ≥ 22.5。抖音专用浏览器需要一台常开的 Windows 桌面。

从 npm：

```
dsh plugin --profile desktop add dsh-fish-soul
```

本地源码：`dsh plugin --profile desktop add ./dsh-fish-soul`。

手工等价：profile 的 `package.json` 把 `dsh-fish-soul` 加进 `dsh.profile.bundles`，并在 `dependencies` 里写 `dsh-fish-soul` 的版本（本地源码则用 `link:` 路径），然后 `pnpm install`。

插件注入 `webServer / tools / systemPrompt / llm / agents / workspaceRegistry`，设置页在 DSH 的插件设置里（「人格 / 记忆 / QQ / B站 / 抖音 / 自走 / 模型 / 习惯 / 动态」）。

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
  channels/           snowluma / onebot / bilibili / douyin
  client*.js          设置页（按需加载）
  routes*.js          HTTP 路由（v07 / v09 / persona / douyin / soul）
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