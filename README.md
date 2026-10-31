# dsh-fish-soul

让一个 QQ 小号背后有"同一个人"：固定人格、按人记记忆、有自己的生活节奏、会主动开口；同一个"她"同时出现在 QQ、B站、抖音。

DSH 插件（单角色 `feiyu`）。版本 **0.7.0**。

## 能力

| 面 | 内容 |
|---|---|
| 人格 | 角色卡（PNG / ccv3 / chara），`{{char}}` / `{{user}}` 宏，世界书（constant / 关键词） |
| 记忆 | 按人隔离、本轮即时召回（BM25 + 向量 RRF）、艾宾浩斯衰减、可纠正（留旧档）、出处 `evidence`、每人 ≤150 字印象、旧聊天记录导入 |
| 生活 | 虚拟时钟、每日作息与基调、Dream 整理、关系阶段演进、主动开口与配额 |
| QQ | 直连 SnowLuma（OneBot 11 正向 WS）：私聊 / 群聊、群合批带署名、只听点名、戳一戳、撤回不回、可选插话、打字节奏、`/鱼 暂停` |
| B站 | 扫码登录、私信（只读 / 自动回复）、跨平台认人、空闲自己刷视频、Cookie 自动续期、发图 |
| 抖音 | 专用浏览器扫码登录、私信（只读 / 自动回复）、canary 防风控、空闲刷视频、表情包复用 |
| 语音 | `get_record` → STT；回复 `[语音]` → TTS 发 record（失败 / 太长发文字） |
| 模型 | 按功能选模型、按天 × 功能 × 模型统计用量与花费、可选上网查 |
| 运维 | 单聊天暂停、动态页、每日自动备份（留 7 份）、记忆导出 / 原样导回 |

## 安装

需要 Node ≥ 22.5。抖音专用浏览器需要一台常开的 Windows 桌面。

```
dsh plugin --profile desktop add ./dsh-fish-soul
```

手工等价：profile 的 `package.json` 把 `dsh-fish-soul` 加进 `dsh.profile.bundles`，并在 `dependencies` 里加 `link:` 路径，然后 `pnpm install`。

插件注入 `webServer / tools / systemPrompt / llm / agents / workspaceRegistry`，设置页在 DSH 的插件设置里（「记忆 / QQ / B站 / 抖音 / 自走 / 模型 / 动态」）。

## 配置与数据

`$DSH_HOME` 缺省 `~/.dsh`。

| 路径 | 内容 |
|---|---|
| `fish-soul-config.json` | 全部设置（含 embedding `apiKey`） |
| `fish-soul/soul.db` | 单一 SQLite：记忆、人物、日程、会话映射、向量、kv |
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
  gateway.js          QQ 会话 / 群合批 / 工具护栏
  llm.js              按功能路由模型（LlmRouter）
  voice.js            语音收发
  stickers.js         表情包收藏
  persona.js          角色卡解析
  importer.js         记忆导入
  history-import.js   聊天记录导入（txt / jsonl / json / MaiBot）
  backup.js           备份与导出
  channels/           snowluma / onebot / bilibili / douyin
  client*.js          设置页（按需加载）
  routes*.js          HTTP 路由
test/
  smoke.mjs           模拟宿主的主流程（含 smoke-v05 / v06 / v07）
  douyin-browser.mjs  真 Chromium + 假 www.douyin.com
```

## 测试

```
npm test
```

模拟宿主 + 真实 headless Chromium 跑两套；找不到 Chromium 系浏览器或 `openssl` 时，浏览器用例自动跳过。

## 许可

MIT