# dsh-fish-soul 设计方案

> 状态：已实现到 v0.7.0（QQ 直连 SnowLuma、B站小号、抖音小号，加语音、表情包、学说法、上网查、按功能选模型）；v1.1 已合并架构审查 10 项修正
> 日期：2026-10-30

## 1. 要解决什么

让一个 QQ 小号背后有"同一个人"：有固定人格、记得每个说过话的人、有自己的生活节奏、会主动开口。
未来同一个"她"还要出现在抖音，所以人格与记忆必须存在一个两端共享的地方——DSH 插件。

**验收标准（MVP 四条）**

1. QQ 里一轮真实对话走通（小号）
2. 那句话被写进记忆，下一轮 / 次日能召回
3. 换一个 DSH 会话，人格仍是同一个人
4. 时间加速下过完三天：她按日程说话、到期事件主动找你、每日配额生效

**明确不在 MVP 内**：抖音接入、视频分享、白名单真人主动私信、多角色。

## 2. 已定决策（可追溯）

| # | 决策 | 依据 |
|---|---|---|
| 1 | 唯一真相源是一个 DSH 插件；QQ/抖音只是传送带 | 跨平台共享，避免两份数据互相矛盾 |
| 2 | 不移植 HDS-Interlude | 28,074 行、21 张 Koishi 表、AGPL 全有或全无 |
| 3 | 记忆层 fork `dsh-meow-memory`（MIT，12.4k 行） | 唯一同时满足 MIT + 纯 Node + 无向量依赖 + 时间戳完整 |
| 4 | 人格卡用 Character Card V3（MIT），额外字段放 `extensions.dsh` | V2 规范仓库无 LICENSE |
| 5 | 数据键从"工作区"改为"角色 × 人"，新增 `owner` / `channel` / `emotion` 三列 | 现有插件全部缺"人"这一维 |
| 6 | 读自动、写显式（工具 + 空闲整理） | 纯工具召回会漏；纯每轮提取丢时序且费钱 |
| 7 | 单角色，但数据带 `characterId` | 一个字段的代价，避免将来迁移 |
| 8 | 时间线进 MVP：每日日程 + 真实时间计时 | 这是唯一无法被现成插件替代的部分 |
| 9 | 主动消息：事件驱动优先、自发每天 ≤10 条（可调 0–50，用户约的提醒不占额度）、醒着时段、只发自己与自建群 | 小号主动私信真人是封号与社交双重风险 |
| 10 | 检索 = BM25 + 语义向量 + RRF；向量**只用远程 OpenAI 兼容接口** | DeepSeek 无 embedding 端点；不做本地 ONNX |
| 11 | MVP 在本机 Windows 验收 | 抖音插件 Windows-only；SnowLuma 已在本地跑通 |
| 12 | 实现由 AI 写、用户验收 | — |

## 3. 插件分工（MVP）

| 插件 | 状态 | 职责 |
|---|---|---|
| **dsh-fish-soul**（新建） | 要写 | 人格卡、按人记忆、日程与时间线、事件驱动主动 |
| `dsh-qq-bridge` | **v0.3 起停用** | 收发 QQ 改由本插件直连 SnowLuma（OneBot v11 WebSocket），两者同时启用会重复回复 |
| `dsh-feiyu-mood` | 保留不动 | 七维心情与衰减（内核 MVP 不重复实现情绪） |
| `dsh-fish-memory` | 保留，只读对照 | 验证期比较召回效果，确认内核不差后卸载 |
| `dsh-speak-up` | **停用** | 与内核的主动推进冲突，会重复发消息 |

## 4. 架构

```
QQ   ──> SnowLuma（OneBot v11 WS）────┐
B站  ──> 网页接口（私信轮询 / 刷视频）─┼──> dsh-fish-soul/channels ──> gateway ──> DSH session（每人 / 每群一条）
抖音 ──> 专用浏览器（CDP，私信 / 刷视频）┘          ├── persona   静态人格（V3）
                                                    ├── memory    按人记忆（SQLite）
                                                    └── life      日程 / 待办 / 主动 / 空闲时刷视频
```

三个模块共用一个进程、一个数据目录、一套配置。

```
$DSH_HOME/fish-soul/
├── persona.json
├── soul.db        -- 单一 SQLite 库，集中全部 6 张表（审查 #04：拆 memory.db/life.db 会破坏跨表事务）
└── (与插件配置同级：$DSH_HOME/fish-soul-config.json)
```

`soul.db` 打开时固定执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

## 5. 数据模型

### 5.1 记忆

```sql
CREATE TABLE memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  TEXT NOT NULL DEFAULT 'feiyu',
  owner_id      TEXT NOT NULL,        -- 'self' | 'user:<canonical>'
  channel       TEXT NOT NULL,        -- 'qq-group' | 'qq-private' | 'douyin'
  channel_id    TEXT NOT NULL DEFAULT '',  -- 具体投递/隔离目标：'group:<群号>' | 'private:<QQ号>'（审查 #01）
  kind          TEXT NOT NULL,        -- 'fact' | 'event' | 'feeling'
  content       TEXT NOT NULL,
  keywords      TEXT NOT NULL DEFAULT '',  -- 中文分词结果（Intl.Segmenter，空格分隔），供 BM25（审查 #09）
  importance    INTEGER NOT NULL DEFAULT 1,  -- 1..5，>=3 豁免时间衰减
  emotion       INTEGER NOT NULL DEFAULT 0,  -- -2..+2
  source_session TEXT,
  created_at    INTEGER NOT NULL,     -- VirtualClock.now()（虚拟毫秒）
  updated_at    INTEGER NOT NULL,
  valid_to      INTEGER,              -- NULL = 仍然有效
  superseded_by INTEGER,              -- 被哪条覆盖
  status        TEXT NOT NULL DEFAULT 'active'  -- active | archived | stale
);

CREATE INDEX idx_memory_owner_active
  ON memory(character_id, owner_id, status, valid_to);
CREATE INDEX idx_memory_channel_recent           -- 群摘要按群隔离查询（审查 #01）
  ON memory(character_id, channel, channel_id, status, created_at DESC);
```

### 5.2 身份映射

```sql
CREATE TABLE person (
  canonical_id      TEXT PRIMARY KEY,                   -- 如 'p_8f9a2b1c'，主人固定为 'master'
  qq_uin            TEXT UNIQUE,                        -- 唯一约束，支撑 ON CONFLICT Upsert（审查 #05）
  douyin_uid        TEXT UNIQUE,                        -- v0.5：存抖音会话里显示的名字（网页版拿不到抖音号）
  bili_uid          TEXT,                               -- v0.4 迁移加列 + UNIQUE 索引 idx_person_bili
  display_name      TEXT NOT NULL DEFAULT '未知用户',
  aliases           TEXT NOT NULL DEFAULT '[]',         -- JSON 字符串数组
  relation_stage    TEXT NOT NULL DEFAULT 'stranger',   -- 'stranger'|'acquaintance'|'friend'|'close'
  interaction_count INTEGER NOT NULL DEFAULT 0,         -- 累计对话轮数，供关系阶段演进
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);
```

同一真人在 QQ / B站 / 抖音各有一个外部 ID，`canonical_id` 是内核自己的主键。B站认人规则：设置里的主人 UID → `master`；设置页「B站UID=QQ号」对应上的 → 那个 QQ 的人（之前单独建过的 B站身份，其记忆与待办并过去、旧身份删除）；其余新建只有 `bili_uid` 的人。抖音同理（v0.5）：「主人的名字」→ `master`，「抖音名字=QQ号」并到那个 QQ 的人，其余新建只有 `douyin_uid` 的人；因为只能按名字认，对方改名会被当成新的人。

**自动注册（审查 #05）**：`agent/pre-step` 中对每个发送者执行原子 Upsert（`INSERT ... ON CONFLICT(qq_uin) DO UPDATE` 更新昵称、`interaction_count+1`、`last_seen_at` 并 `RETURNING *`）；查不到即新建，主人 QQ 固定映射 `canonical_id='master'`、`relation_stage='close'`。

**关系阶段演进（审查 #05）**：由 3 小时 Dream 空闲整理负责更新——按 `interaction_count` 与近期记忆 `emotion` 均值评估晋升（如 `count>=10` 且均值 `>=0` → `acquaintance`；`count>=50` 且均值 `>=0.5` → `friend`），Dream LLM 也可输出 `suggested_relation_stage`。枚举与人格卡 `extensions.dsh` 的关系阶段设定对齐。

### 5.3 生活

```sql
CREATE TABLE day (
  date              TEXT NOT NULL,            -- YYYY-MM-DD（基于 VirtualClock 的角色时区日期）
  character_id      TEXT NOT NULL DEFAULT 'feiyu',
  plan_json         TEXT NOT NULL,            -- 今天做什么、忙闲时段、起床睡觉、当天基调（见下）
  proactive_count   INTEGER NOT NULL DEFAULT 0,  -- 当日已发主动消息数，硬约束 <2（审查 #02）
  last_proactive_at INTEGER,                  -- 最近一次主动开口的虚拟时间戳（ms）
  generated_at      INTEGER NOT NULL,
  PRIMARY KEY (character_id, date)
);

CREATE TABLE pending (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id  TEXT NOT NULL DEFAULT 'feiyu',
  owner_id      TEXT NOT NULL,
  channel       TEXT NOT NULL,        -- 'qq-group' | 'qq-private'
  channel_id    TEXT NOT NULL,        -- 投递目标：具体群号或私聊 QQ 号（审查 #01）
  due_at        INTEGER NOT NULL,     -- 虚拟时间戳（ms）
  reason        TEXT NOT NULL,        -- "你昨天说要考试"
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | done | dropped | failed
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_pending_due
  ON pending(character_id, status, due_at ASC);
```

**`pending` 的写入入口（审查 #02）**：扩展 `remember` 工具，当模型判定用户提及未来约定/提醒时附带 `dueInMinutes`（相对分钟数，优先，避免模型算错绝对时间）或 `dueAtIso` + `proactiveReason`，在同一事务内同时写 `memory` 与 `pending`（自动填入当前会话的 `owner_id`/`channel`/`channel_id`）；3 小时 Dream 整理时兜底扫描近期对话中未登记的未来约定并补写 `pending`。

**当日基调（审查 #10）**：原 `mood_seed` 独立列删除——`dsh-feiyu-mood` 保留不动、双方无通信契约，独立列会成为死字段。当天基调改为 `plan_json` 内的 `"dailyMoodTone": "元气/慵懒/平静"` 文本，由本插件 15 分钟 tick 组装"她此刻状态"时直接消费。

### 5.4 向量索引

```sql
CREATE TABLE vec_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行表
  model_id      TEXT NOT NULL,   -- 远端模型名
  dim           INTEGER NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'openai-compatible',
  generation_id INTEGER NOT NULL DEFAULT 1,  -- 世代锁：切换模型/端点/维度或重建时 +1（审查 #08）
  built_at      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ready'  -- 'ready' | 'stale' | 'building'
);

CREATE TABLE vec (
  memory_id     INTEGER PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  generation_id INTEGER NOT NULL,
  blob          BLOB NOT NULL      -- L2 归一化后的 Float32Array 小端序 Buffer（审查 #06）
);
```

不装 sqlite-vec、不引入向量数据库：几千到几万条记忆，JS 内暴力余弦足够。向量写入前先做 **L2 归一化**并转小端序 `Float32Array` 的 `Buffer`，检索时纯点积（5000 × 1024 维 <3ms）；点积前先按 `character_id / owner_id IN ('self', ?) / status='active' / valid_to IS NULL` 过滤出有效 `memory_id` 集合，防止已删除/被覆盖的脏向量混入（审查 #06）。刻意取舍——少一个装不上的原生扩展。

## 6. 人格卡

- 存储：Character Card V3 结构，内核私有字段放 `extensions.dsh`（渠道语气、关系阶段、可见性默认值）。
- 导入：支持把 V3 的 JSON 直接放进 `persona.json`，可导入中文酒馆角色卡。
- 版权提醒：卡的格式可自由使用，卡里的图片/文本/配音各有授权，不对外分发。

## 7. 注入

| 内容 | 通道 | 说明 |
|---|---|---|
| 人格卡 | `systemPrompt.section`，`interpolate:false` | 稳定内容，会话级注入一次，保住前缀缓存 |
| 本轮召回的记忆、她此刻状态 | 见下方"动态上下文注入位置" | 动态内容不碰 system 段 |
| 群聊 | 尾部：对当前说话人的记忆 + 群内近期摘要（按 `channel_id` 隔离到当前群，审查 #01） | 明确"这句话是谁说的" |

前缀缓存代价（来自 `dsh-fish-memory` 源码注释）：改 section 打碎约 12k token 前缀，单次成本 0.001 → 0.02；改 context 只在内容变化时追加。

**动态上下文注入位置（审查 #07）**：KV Cache 按 `messages` 数组从头做前缀匹配——若动态内容拼在 `messages[0]`（system）尾部，其后全部历史对话的缓存仍会失效。M1 实现时先验证 DSH 的 `systemPrompt.context` 落点；若在 `messages[0]` 内部，则改用 `agent/pre-step` 把动态上下文组装为**瞬态块注入在最新一条用户消息之前**（旧轮次的注入块不固化进会话历史），请求结构保持为：`[静态人格卡] → [稳定历史对话] → [瞬态：此刻状态 + Top5 记忆 + 群摘要] → [当前用户消息]`，保证历史与人格卡 100% 命中前缀缓存。

## 8. 写入与召回

### 8.1 写入三条路

1. 模型主动调工具：`remember` / `recall` / `forget`
   - `remember` 扩展到期事件参数（审查 #02）：`dueInMinutes`（相对分钟数，优先）或 `dueAtIso` + `proactiveReason` 非空时，同一事务内同时写 `memory` 与 `pending`，自动填入当前会话的 `owner_id` / `channel` / `channel_id`
2. 空闲 ≥3 小时触发后台整理（fork 自 meow 的 dream 循环，按 owner 分别整理；同时补写漏登记的未来约定到 `pending`，并评估 `relation_stage` 晋升——审查 #05）
3. 单个 turn 工具调用 ≥7 步时插一条"要不要记下来"的提醒

写入即落 SQLite；向量进队列后台补，不阻塞回复。

### 8.2 召回

```
用户消息 ─┬─> BM25（meow 实现，中文分词见 §9.5 + 艾宾浩斯衰减）
          └─> 向量（远程 embed）─> 点积（L2 归一化）
                └── RRF(k=60) 融合 ──> top 5 ──> token 预算 1200 装正文
```

- 用 RRF 而非加权平均：两路分数量纲不同，只看排名无需标定。
- **fail-open**：向量不可用/超时（800ms）→ 只用 BM25；BM25 异常 → 放行原始消息。任何情况下不打断对话（`liketavern` 在此处会整轮组装失败，不采用）。
- 召回过滤（审查 #07）：`character_id` 匹配 且 `owner_id IN ('self', @currentUserOwnerId)`——必须同时召回角色自身记忆，且 `status='active'`、`valid_to IS NULL`。
- **未向量化补偿 RRF（审查 #06）**：尚未完成异步 embedding（或重建队列中）的新记忆在向量侧无排名，标准 RRF 记 0 分会被双路第 50 名的旧记忆挤出 Top 5，直接打破验收第 2 条"下一轮能召回"。修复：区分"已有当前模型向量但未进候选"与"尚未生成当前模型向量"，后者向量侧按 `0.85 × (1/(60+bm25Rank))` 对称补偿。

## 9. 远程向量方案（唯一实现）

### 9.1 契约

只用 OpenAI 兼容的 `POST {baseURL}/embeddings`，请求体 `{model, input[]}`，响应取 `data[].embedding`。不写任何厂商专用代码。

可用来源（任选）：SiliconFlow、阿里云百炼、智谱、本地 Ollama、任意网关。

### 9.2 配置项

| 项 | 说明 |
|---|---|
| `baseURL` | 例如 `https://api.siliconflow.cn/v1` |
| `apiKey` | 明文存 `$DSH_HOME/fish-soul-config.json` |
| `model` | 例如 `BAAI/bge-m3` |
| `dim` | 由"测试连接"自动探测并写入 `vec_meta`，不手填 |
| `batchSize` | 写入批量，默认 32 |
| `timeoutMs` | 默认 800，超时降级 |
| `enabled` | 总开关；关闭时纯 BM25 |

### 9.3 失效与重建（含并发控制，审查 #08）

- 换模型 / 换端点 / 维度变化 → `vec_meta.status='stale'` → 后台重建。
- 重建限速 32 条/分钟（**真实物理时钟**计速），可中断、按 `memory_id` 续传。
- 重建期间照常检索：有向量的走余弦，没向量的走 BM25（新记忆靠 §8.2 的补偿 RRF 保底）。
- 未配置 key 或连续失败 → 自动退回 BM25，设置页标红，对话不受影响。
- **单队列双优先级 Worker + 世代锁**：实时 embedding 队列与后台重建共用**同一个串行 Worker**——每轮先消费实时新记忆队列（不受 32 条/分钟限速，保障新记忆秒级可搜），空了再按令牌桶消费重建存量。切换 `baseURL`/`model`/`dim` 或点"重建索引"时事务内 `generation_id + 1` 并清空旧 `vec`；Worker 拿到远程响应准备写 `vec` 前校验 `task.generation_id === vec_meta.generation_id`，不等则丢弃——防止飞行中的旧模型响应污染新索引。

### 9.4 设置页

走 `client.js` + `dsh.client.platform: 'web'`；状态查询与重建进度走 `ctx.connection.fetch.register` 注册的 HTTP 路由。

```
┌─ 鱼 · 记忆检索 ───────────────────────────────┐
│ 检索方式   ( ) 仅关键词 BM25                  │
│            (•) 混合（关键词 + 语义向量）       │
│                                              │
│ 向量接口   BaseURL [https://api.siliconflow.cn/v1] │
│            Key     [••••••••]   [测试连接]    │
│            模型    [BAAI/bge-m3]              │
│            维度    1024（测试后自动填入）      │
│            状态    ✅ 可用 · 延迟 210ms        │
│                                              │
│ 融合       (•) RRF（推荐）  ( ) 加权平均       │
│ 召回       条数 [5]    token 预算 [1200]      │
│                                              │
│ 索引覆盖   ████████░░░░  812 / 1,003 条       │
│            [重建索引]   上次重建：2 分钟前     │
└──────────────────────────────────────────────┘
```

设置页只做四件事：选接口、测通、看覆盖、重建索引。不做模型市场、不做自动推荐。

### 9.5 成本与代价

- 每轮查询 1 次 embedding 调用；写入按批（32 条/次）。
- 按 200 轮/日估算，embedding 成本远低于对话本身（量级：分/日）。
- 新增依赖：**0**（用内置 fetch）。
- 新增失败面：key 失效、限流、维度不匹配、网络抖动——全部降级为 BM25。

**中文分词（审查 #09）**：BM25 的 `keywords` 用 Node.js 内置 `Intl.Segmenter('zh-CN', { granularity: 'word' })` + 最小停用词表生成，零外部依赖、纯内存；严禁引入 `nodejieba` 等原生编译包（Windows 安装失败高发），也不要单字切分（会被"的/了/是"污染召回）。

**艾宾浩斯衰减（审查 #09）**：在 BM25 初筛 Top 50 后于 JS 内存计算，`importance >= 3` 不衰减；否则 `score × exp(-ln2/7 × Δt_days)`（半衰期 7 个虚拟日），`Δt_days = (virtualClock.now() - updated_at) / 86400000`。

## 10. 自走层（唯一真正的自研部分，≈600–800 行）

1. **每日日程**：每天首次 tick 时一次 LLM 调用，产出当天作息与忙闲时段（含 `dailyMoodTone` 基调文本），写入 `day`。
2. **15 分钟 tick**：计算当前"在忙 / 空闲 / 睡了"，仅更新内存态，不打扰对话。tick 带 `isTickRunning` 互斥锁：上一轮 tick 的 LLM 调用未返回则直接跳过本轮（加速模式下防重入，审查 #03）。
3. **主动开口**：
   - 事件驱动优先：`pending` 到期 → 生成一句话 → 按 `channel_id` 经 gateway 向对应会话注入一条 `fish-soul/proactive` 跟进，由模型生成后经 SnowLuma 发出
   - 时间驱动兜底：处在空闲时段且距上次互动 > N 小时
   - 情绪只影响语气，不作为触发条件
   - 投递目标白名单来自配置（见 §10.6），禁止凭 `owner_id` 盲发（审查 #01）
4. **硬约束**：自发（空闲兜底 + Dream 补写的待办）每天 ≤`dailyMaxCount`（默认 10，可调 0–50，以 `day.proactive_count` 持久化计数，重启不丢，审查 #02），两次自发至少间隔 60 虚拟分钟；用户自己约的提醒（`pending.origin='user'`）不占额度；仅 08:00–24:00；仅发用户本人与自建群；白名单真人只在先开口时回复。
5. **时间加速**：`FISH_TIME_SCALE=1000` 时 10 分钟模拟 3 天，用于验收第四条。时钟隔离规范见 §10.5。
6. **Dream 整理的并发隔离（审查 #08）**：维护 `Map<owner_id, AbortController>`；某 `owner_id` 的 Dream 整理进行中（LLM 归纳未返回）时收到该用户实时消息，立即 `abort()` 中断并回滚未提交结果，更新 `last_seen_at` 后优先响应实时对话；Dream 全局带 `isDreamRunning` 锁，加速模式下两次 Dream 至少间隔真实物理 30 秒。

### 10.5 虚拟时钟与物理时钟隔离（审查 #03）

`FISH_TIME_SCALE=1000` 下虚拟 15 分钟 tick = 真实 0.9 秒，若虚拟/物理时钟混用：日程 LLM 调用（2–5 秒）会跨越多个 tick 引发重入；衰减/Dream/`pending.due_at` 比对若用 `Date.now()` 则 10 分钟内永不触发；反之若全局替换时间函数，embedding 800ms 超时变 0.8ms 必败，QQ 主动消息秒级连发触发风控。

封装全局唯一 `VirtualClock`（`bootVirtualMs + (Date.now() - bootRealMs) × scale`），绑定规范：

| 模块 / 计时器 | 时钟源 | 保护措施 |
|---|---|---|
| `memory`/`person`/`day`/`pending` 全部时间戳 | 虚拟钟 `virtualClock.now()` | SQL 禁用 `CURRENT_TIMESTAMP`/`strftime('%s','now')`，一律 JS 绑定参数传入 |
| 艾宾浩斯衰减 Δt、Dream 空闲判定、`pending.due_at` 比对 | 虚拟钟 | `importance<3` 按虚拟流逝天数衰减 |
| 15 分钟 tick、每日日程生成 | 虚拟间隔 → `toRealIntervalMs(virtualMs, minRealMs=1000)` 换算真实定时器延迟 | `isTickRunning` 互斥锁，LLM 未返回跳过本轮 |
| 主动消息风控冷却 | **真实物理钟** | 两次主动投递的真实间隔 ≥15 秒，即使虚拟已跨天 |
| embedding `timeoutMs: 800`、重建 32 条/分钟限速 | **真实物理钟** | 外部 HTTP 超时与 API 速率永远用真实毫秒 |

### 10.6 主动投递白名单配置（审查 #01）

`$DSH_HOME/fish-soul-config.json` 增加：

```json
{
  "proactive": {
    "enabled": true,
    "dailyMaxCount": 10,
    "activeHours": [8, 24],
    "idleTriggerHours": 6,
    "targets": {
      "masterCanonicalId": "user:master",
      "masterPrivateChannelId": "private:10001",
      "selfGroupChannelIds": ["group:20001"]
    }
  }
}
```

## 11. 渠道接入

### QQ

**v0.3 起直连 SnowLuma**（`lib/channels/snowluma.js` + `lib/gateway.js`），不再依赖 `dsh-qq-bridge`：

- **连接**：全局 WebSocket 连 SnowLuma 的 OneBot v11 服务（`qq.wsUrl` + `?access_token=`），断线 1s→30s 退避重连；`get_login_info` 取机器人 QQ 号。
- **会话映射**：每个私聊 / 群一条 DSH 会话（`chat_session` 表），首次消息时 `agents.create`，之后 `resume`；会话只挂默认预设，工具收窄为 `remember`/`recall`/`forget`（`tools.guard` 兜底拒绝其他工具，含 `run_code`——故 PTC 执行器下 QQ 会话用不了记忆工具）。工作区默认独立的 `$DSH_HOME/fish-soul/workspace`，可在设置页改选。
- **入站过滤**：私聊只收好友；群只收白名单群里 @ 机器人 / 引用机器人的消息，以及点名后 `followUpSeconds` 内同一人的 `followUpCount` 条跟进；其余消息与超过 `replyWindowMinutes` 的旧消息只写入记忆、不触发回复。同一会话 `batchMs` 内的连发合并为一轮。
- **按人**：发送者 QQ 号由消息事件直接给出，随 followup 的 `source`（`fish-soul/qq`，含 `userId`/`speakers`）进入会话，`noteInteraction` 查 `person` 得 `canonical_id`；群聊瞬态块按发言人分摊召回预算。
- **出站**：只对由本插件注入的轮次在 `turn/end` 时回发；模型输出 `[不回]` 则静默；空行分段（≤5 段）逐条发，群里引用点名那条；Markdown 图片仅限工作区与插件目录内的文件。
- **迁移**：设置页「QQ 接入」→ 停用 `dsh-qq-bridge` → 填 SnowLuma 地址与 token、主人 QQ、群白名单 → 启用；「迁移旧会话」把旧会话登记进 `chat_session`。
- `lib/channels/vendor/qq-bridge.js` 原样保留了 `dsh-qq-bridge` 1.4.2（MIT）中点名识别、正文提取、分段、图片提取等纯函数，附原许可证。

### B站（v0.4）

**用一个专门的小号**，B站网页接口直连（`lib/channels/bilibili.js`、`lib/browse.js`），不依赖浏览器、不走外部插件；默认关闭。

- **登录**：设置页扫码（`passport` 二维码，密钥只留服务端，170 秒过期）或粘贴 Cookie。凭据只存 `$DSH_HOME/fish-soul/bili-auth.json`（0600），不进设置文件、不回传前端；新凭据校验失败时原登录原样保留。请求前先领 `buvid3`（没有会被风控 412）；需要签名的接口走 WBI（`nav` 的 `wbi_img` 混淆出密钥，缓存 30 分钟）。**自动续期（v0.5）**：扫码登录拿到的 refresh_token（粘贴 Cookie 时可一并填 `ac_time_value`）让小号不用隔几周就重扫——每天查一次 `cookie/info`，B站说要刷才刷：`correspondPath`（RSA-OAEP/SHA-256 公钥加密 `refresh_<时间戳>`）→ 从 `www.bilibili.com/correspond/1/…` 取 `refresh_csrf` → `cookie/refresh` 换新 Cookie 与新 token（只写回 0600 文件）→ 用新 csrf + 旧 token 调 `confirm/refresh` 让旧 token 作废；失败 3 小时后再试，并在 QQ 上提醒主人一次（同一件事好了之前不重复提醒）。Cookie 过期（`-101`）且有 token 时半小时抢救一次；没有 token 的只标"已失效"、停轮询，提醒重新扫码。
- **私信**：B站私信没有推送，按网页端节奏轮询 `new_sessions`（默认 20 秒，10–300 可调），按每个会话的 `msg_seqno` 游标（`kv: bili.cursor.<UID>`）取新消息；跳过自己发的、自动回复 / 推送 / 系统来源（`msg_source` 非真人）、撤回、系统通知会话与应援团会话。入站消息与 QQ 同形（`channel_id = bili:<UID>`），复用同一套会话网关：每人一条 DSH 会话（标题 `B站·昵称`），工具同样只放记忆三件套。
  - **只读期**：`bili.autoReply` 默认关——所有私信只记成低重要度记忆（"在B站私信里说（当时没回）"）、不发已读，建议先跑一周看看都是谁在发。
  - **自动回复打开后**：只回主人 UID、白名单 UID、互相关注的人（`replyMutual`，关系缓存 10 分钟）；超过 `replyWindowMinutes` 的旧消息、陌生人一律只记。回复的会话才发已读。
  - **出站**：空行分段 ≤5 条、每条 ≤500 字，两条之间至少隔 1.2 秒；`send_msg` 带 WBI 签名、`csrf`、固定的设备 ID。v0.5 起表情包 / 生成的图（≤2 张，webp 先转 png）先传 B站图床（`upload_bfs`）再按图片消息（`msg_type=2`）发；收到的自定义表情（`msg_type=6`）当【表情】+ 图片给模型看。
  - **主动开口**：`bili.proactive` 默认关；打开后只允许发给主人 UID，与 QQ 共用每日配额，冷却按平台分别计。
- **自己刷视频**：空闲时段（日程 `idle` + 活跃时段内）每天最多 `browse.perDay` 轮（默认 3，0–12），两轮间隔 ≥90 虚拟分钟且 ≥20 真实分钟；每轮 `videosPerSession` 条（默认 3，1–6），优先 1 条关注动态，其余来自首页推荐，推荐被风控就看热门；看过的（`bili_seen` 表）不再看。每条取详情 + 字幕节选（要登录）+ 3 条热评，让模型以第一人称写一两句感受：`[划走]` 不记，其余写成 `owner='self'` 的事件记忆（`channel_id = bili:video:<BV>`，重要度 1）；`[点赞]` 只有在 `browse.like` 打开时才真的点。最近一个虚拟日里有感受的 2 条进 QQ / B站会话的瞬态块（"想聊再提，别硬塞"）。不投币、不评论、不关注。
- **聊天里的视频**：QQ / B站消息里的 BV 号、b23.tv 短链、QQ 小程序分享卡片（`json` 段的 `qqdocurl`）→ 网关先取一段简介 / 字幕 / 热评拼在消息后面（8 秒超时，1 小时缓存），让她"看过"再回。
- **设置页「B站」页签**：账号（扫码 / Cookie / 退出）、总开关、自动回复、主人 UID、白名单、互关、「B站UID=QQ号」对应表、主动开口、刷视频开关与次数、点赞、「现在刷一下」与最近看过列表。路由：`POST /channels/bili-config`、`/bili/qr/start`、`/bili/qr/poll`、`/bili/cookie`、`/bili/logout`、`/bili/browse-now`；`GET /channels/state` 增加 `bili` 段。
- 不做：群聊 / 应援团、动态与评论区互动、投币收藏、视频下载与画面理解（只看文字信息）。

### 抖音（v0.5）

**同样用一个专门的小号。** 抖音没有可用的网页私信接口，只能走真浏览器：插件自己开一个**专用的 Edge / Chrome**（CDP 控制；`lib/channels/douyin.js`、`lib/douyin-browse.js`、`lib/browsers.js`，页面驱动拆自 dsh-douyin-bridge（MIT），放在 `lib/channels/vendor/douyin-bridge/`，改动见其 README）。需要一台常开的 Windows 电脑、DSH 一直运行；默认关闭。

- **专用浏览器**：自动找本机的 Edge / Chrome / Brave / Vivaldi / Chromium（注册表 + 常见安装路径），设置页可选，也可手动填 .exe 路径；用插件自己的 profile（`$DSH_HOME/fish-soul/douyin-browser/<浏览器>`），和平时用的浏览器互不影响，调试端口 47890，静音。登录态只留在这个 profile 里。
  - 你把窗口 / 标签页关了 = **暂停**（自动流程不会再把它弹出来），设置页点「启动」恢复；设置页「关闭浏览器」= 真关 + 暂停；
  - 浏览器崩了（不是正常退出）30 秒后自动重连，10 分钟内超过 3 次就停下，并在 QQ 上提醒主人；
  - 插件热重载只断开 CDP、不关浏览器，新实例直接连上；
  - 所有会动页面的操作（读 / 发私信、刷视频、截图、转图）排队互斥，单件超时放行防死锁。
- **登录**：设置页「看截图」显示专用浏览器的实时截图（3 秒刷新），在截图上点一下会转发成页面里的一次点击，用抖音 App 扫码即可；也可以直接在弹出的窗口里登。
- **私信**：没有推送，每 30–60 秒（随机）看一眼会话列表；有未读或预览变了的会话（每轮最多 5 个）进去读最近 20 条，和上次读到的指纹窗口（`kv: douyin.conv.<名字哈希>`，留 30 条；指纹 = 谁发的 + 正文 + 媒体，图片地址去掉会变的签名参数）按末尾 1–3 条对齐，只把新消息交给网关；对不上时最多补 3 条，宁少勿重。第一次启用先记基线（`kv: douyin.bootstrapped`），之前的历史不处理；启用前就有的未读补最后几条，超过 `replyWindowMinutes` 的只记不回。
  - **认人靠名字**：网页版拿不到抖音号，`channel_id = douyin:<会话里显示的名字>`（标题 `抖音·名字`），存进 `person.douyin_uid`；见 §5.2。
  - **进会话读消息会把消息标成已读**（网页版没有"只看不已读"的办法）。
  - 只读期与 B站相同：`douyin.autoReply` 默认关，只记成"在抖音私信里说（当时没回）"。打开后回主人和白名单；网页版看不出是不是互关，所以没有"互关也回"，改成「回所有能私信她的人」（`replyAll`，默认关；建议在抖音「设置 → 隐私 → 谁可以私信我」选「互关好友」，效果就等于只回互关）。
  - **出站**：空行分段 ≤5 条，每段之前模拟打字（1.5–3 秒 + 每字 80 毫秒，≤8 秒）；单独一段只写 `[比心]` 这类抖音自带表情名会发成表情（表情面板里没有就当文字发）；表情包 / 生成的图（≤2 张）跟在最后。
  - **只回复、不主动**：抖音不参与主动开口。
  - **页面自检（canary）**：启动时、每 6 小时、连续失败 3 次后检查私信页面的关键元素；认不出（多半是抖音改版）就先停自动回复（只记不回），设置页标红并给出可复制的自检报告，QQ 上提醒主人一次；下次自检通过自动恢复。掉登录也提醒一次。
- **自己刷抖音**：`douyin.browse.enabled` 默认关；打开后与 B站轮流（今天刷得少的先），共用空闲时段与 90 虚拟分钟间隔，抖音没登录就让给 B站；每天 `perDay` 轮（默认 3，0–12）。每轮在推荐页像人一样看 `videosPerSession` 条（默认 3，1–6；每条停 5–20 秒；跳过直播、广告、看过的——`douyin_seen` 表；划不动先点"下一个"箭头，再按 ↓，再滚轮），再逐条打开详情读文案、话题和热评写感受：`[划走]` 不记，其余写成 `owner='self'` 的事件记忆（`channel_id = douyin:video:<id>`）；`[点赞]` 要 `browse.like` 打开才点。最近有感受的 2 条进 QQ / B站 / 抖音会话的瞬态块。不评论、不关注、不转发。
- **聊天里的抖音视频**：QQ / B站 / 抖音消息里的 `douyin.com/video/<id>`、`?modal_id=`、`v.douyin.com` 短链 → 在专用浏览器里打开详情读文案和热评（最多等 30 秒，1 小时缓存），拼在消息后面再交给会话。
- **表情包格式**：B站图床和抖音网页端都只收 png / jpg / gif，`_stickers/` 里的 webp 先转（`lib/imageconv.js`）：优先用宿主自带的 sharp（DSH 桌面版的 dsh-attachment-local 带了一份，也可用 `FISH_SOUL_SHARP` 指定），没有就在抖音专用浏览器里用 canvas 转 png（动图只留第一帧）；都没有就不把 webp 表情包列给模型。转好的放 `img-cache/`（按内容哈希），原文件不动，转出来超过 5 MB 的不发。
- **设置页「抖音」页签**：按需加载的分块 `lib/client.douyin.js`（主面板用 `require.async("./client.douyin.js")`），样式整体移到 `lib/panel.css`（`GET /ui/panel.css`），让 client.js 留在宿主的大小限制内。内容：专用浏览器（选择 / 重新查找 / 手动路径）、状态与「启动 / 看截图 / 关闭浏览器」、登录截图、提醒条（没登录 / 页面变了 / 浏览器崩了）、总开关、自动回复、主人的名字、白名单、回所有人、「抖音名字=QQ号」、刷视频设置、最近看过、页面自检 + 复制报告。路由：`POST /channels/douyin-config`、`/douyin/browser/start`、`/douyin/browser/close`、`/douyin/browser/rescan`、`/douyin/screenshot`、`/douyin/click`、`/douyin/self-check`、`/douyin/browse-now`；`GET /channels/state` 增加 `douyin` 段。
- **测试**：`test/smoke.mjs` 用假浏览器 + 假页面驱动跑私信全链路（`testHooks.douyin`，正式运行时为空）；`test/douyin-browser.mjs` 用真的无头 Chromium + 本地假 `www.douyin.com`（自签证书 + `--host-resolver-rules`）跑浏览器生命周期与刷视频，找不到浏览器 / openssl 时跳过。真实抖音页面无法在测试里覆盖，第一次上线由主人实测。
- 不做：抖音群聊、评论区互动、主动私信、视频画面理解、多个小号。

## 12. 隐私与安全

- 记忆为明文 SQLite 落盘，不做加密（保证可检查、可手改、可迁移）。
- 关闭 meow 那条"让模型直接去读库文件"的提示词引导。
- 删除用法：`forget` 工具 + 设置页的条目浏览/删除（P2）。
- API key 明文存配置文件，与现有 DSH 插件一致；不做 keychain 集成。

## 13. 里程碑

| # | 内容 | 完成标志 |
|---|---|---|
| M1 | 插件骨架 + 人格卡加载与注入 | DSH 启动后能加载，人格出现在 prompt 中 |
| M2 | 记忆层（fork + 三列改动） | 能写入、能按 owner 召回 |
| M3 | 远程向量 + RRF | 换一种说法也能召回同一条记忆 |
| M4 | 设置页 | 能测通、能看覆盖、能重建 |
| M5 | 自走层 | 时间加速下三天行为正确 |
| M6 | 四条验收 | 真实 QQ 对话全部通过 |

M2 与 M3 有依赖顺序；M4 可与 M5 并行。

## 14. 已知风险

| 风险 | 影响 | 应对 |
|---|---|---|
| SnowLuma 协议变化 / 断线 | QQ 收发中断 | 只用 OneBot v11 标准动作；断线退避重连，设置页显示连接状态 |
| meow 的代码结构与"按人"改动冲突 | fork 成本超预期 | 退路：自写 1,500–2,000 行，只抄 BM25 与衰减公式 |
| 远程 embedding 不稳定 | 召回质量波动 | 全链路降级 BM25，不影响对话 |
| 前缀缓存被打碎 | 成本上升 | 动态内容注入在最新用户消息前的瞬态块（§7），不走 section |
| 小号行为触发风控 | 封号 | 主动配额 + 仅自己人 + 两周止损条件 |
| B站风控（412 / -352）或判定为自动化 | 小号被限流 / 封禁 | 专用小号；只用网页端同款接口与节奏（20 秒轮询、发送间隔 ≥1.2 秒、每天刷 ≤12 轮）；默认只读、不点赞不评论；风控时退到热门、失败只记日志 |
| B站 Cookie 过期 | 私信停收、刷视频变匿名 | v0.5 起用 refresh_token 每天检查、按需自动续期；续不上 / 没有 token 时标记失效、停轮询，QQ 提醒主人重新扫码 |
| 抖音网页改版 | 私信认不出、收发失效 | 选择器集中在 `vendor/douyin-bridge/selectors.mjs`；页面自检不过就停自动回复（只记不回），设置页给自检报告，QQ 提醒一次 |
| 抖音风控 / 判定为自动化 | 小号被限流 / 封禁 | 专用小号 + 真浏览器 + 独立 profile；30–60 秒随机轮询、模拟打字、每天刷 ≤12 轮、默认只读不点赞 |
| 抖音只能按名字认人 | 改名 = 新的人，同名会混 | 设置页写明；主人 / 白名单 / 对应表都按名字，对方改名后在设置页更新 |
| 专用浏览器被关 / 崩溃 / 电脑休眠 | 抖音私信停收 | 关 = 暂停不自启；崩溃 30 秒重连、10 分钟 >3 次停下并提醒；需要常开的电脑 |
| B站接口改版 | 收发失效 | 接口集中在 `BiliClient` 一个类里；测试用 `FISH_SOUL_BILI_MOCK` 假服务覆盖签名与收发全链路 |
| 群里主动插话打扰人 / 显得像机器人 | 被群友嫌烦、被踢 | 默认关；概率低（5%）、说完话后冷却 15 分钟、每小时 ≤3 次、睡觉 / 忙的时候不插；只在她感兴趣的话题上加权；模型觉得接不上可以 `[不回]`；主人一句「/鱼 暂停」立刻安静 |
| 语音花钱 / 合成慢 | STT / TTS 费用、回复变慢 | 默认关；每天听 ≤200 条、说 ≤30 条（可调）；一条语音 ≤60 字，超了或合成失败就发文字；默认只在对方发语音时才可能回语音 |
| 上网查到的内容不可信 / 被注入 | 说错话、被网页里的指令带偏 | 默认关；只在聊天会话里放开当前搜索服务对应的工具（宿主的 `web_search` / `web_fetch`，或自己的 `fish_search`，后者只给摘要不抓全文），每天 ≤20 次；提示词要求用自己的话转述、不贴链接；其余工具照旧拦截 |
| 搜索 API key 泄露 | 被别人盗刷额度 | key 只存本机配置文件，接口只回打码值、提交打码值不覆盖；每天次数上限 |
| 抖音窗口停在屏幕外，用户找不到 | 以为浏览器没开 / 任务栏点了没反应 | 设置页「显示一下」；`正常显示` 模式回到原来的行为；任务栏上的窗口别最小化（最小化后下次动页面前会恢复并停回屏幕外，闪一下） |
| 学到不该学的梗 / 收藏不合适的表情 | 说话变味、表情包里混进奇怪的图 | 设置页可看、可改、可删；主人改过的风格和加的词模型不会覆盖；表情每天最多存 10 张、目录最多 300 张，两个功能都能在 QQ 页签关掉 |
| 导入旧聊天记录花钱 / 提炼出错 | 模型费用、记错事 | 预览时先估调用次数，默认最多 150 次（可调到 500）；每条记忆带出处，可在记忆检视里改 / 删 / 恢复；重复的自动跳过 |
| 聊完自动记记错 / 记多 / 花钱 | 记忆里混进错的事、模型费用 | 每段聊天一次调用（≤40 句、空 10 分钟才整理），每次最多 8 条 + 3 条她自己的话；近重复只刷新不新写；每条带出处「聊完自动记」，记忆检视里能改 / 删 / 恢复；设置页可关 |
| 私密的事在群里说漏 | 伤人、尴尬 | 私聊里整理出的敏感事标私密，群里的检索和 `recall` 都不带；私聊小结也私密；群里情绪不带原因；印象栏不分私密（别把秘密写进印象） |
| 好感 / 阶段自动升降不合心意 | 对某人突然变冷淡或太熟 | 每次 ±5、升要多 5 分、降要差 10 分；主人手动定的阶段锁住；主人永远很熟 |

## 15. 明确不做

- 向量数据库、ANN 索引、重排序模型
- 本地 ONNX 模型（已决定只走远程）
- 多角色、角色市场、人格编辑器以外的创作工具
- 抖音群聊、评论区互动、主动私信（抖音只回复）
- B站群聊、评论区 / 动态互动、投币
- 记忆加密、云同步（v0.6 起有本地自动备份和导出，但不上传）

## 16. 变更记录

- 2026-10-30：向量方案定为"远程 OpenAI 兼容，且只用它"。删除本地 ONNX 分支、模型下载/HF 镜像/本地路径配置、`@huggingface/transformers` 依赖，以及对应的 150–250MB 内存占用。
- 2026-10-30（v1.1）：合并架构审查 10 项修正——
  - **#01** `memory`/`pending` 新增 `channel_id`（具体群号/私聊目标），`memory` 加 `idx_memory_channel_recent` 复合索引，新增 §10.6 主动投递白名单配置，群摘要按 `channel_id` 隔离；
  - **#02** `remember` 工具扩展到期事件参数（`dueInMinutes`/`dueAtIso`/`proactiveReason`）同事务写 `memory`+`pending`，Dream 兜底补写；`day` 新增 `proactive_count`、`last_proactive_at` 持久化每日配额；
  - **#03** 新增 §10.5 虚拟/物理时钟隔离规范（`VirtualClock`、tick 互斥锁、风控与 HTTP 超时锁定真实物理钟）；
  - **#04** `memory.db`+`life.db` 合并为单一 `soul.db`（WAL），明确建库 PRAGMA；
  - **#05** `person` 表补 `UNIQUE` 约束、`interaction_count`、`relation_stage` 默认值，定义 pre-step 原子 Upsert 自动注册与 Dream 驱动的关系阶段演进；
  - **#06** RRF 增加未向量化新记忆的 0.85 对称补偿；`vec.blob` 规范为 L2 归一化 Float32Array 小端序，点积前预过滤有效 `memory_id`；
  - **#07** 动态上下文改为注入在最新用户消息前的瞬态块（M1 先验证 DSH `systemPrompt.context` 落点），召回过滤补 `owner_id IN ('self', ?)`；
  - **#08** 向量写入收敛为单队列双优先级串行 Worker + `generation_id` 世代锁；Dream 绑定按 `owner_id` 的 `AbortController`；
  - **#09** 中文分词定为内置 `Intl.Segmenter` + 停用词表（零依赖，禁 `nodejieba`），艾宾浩斯衰减明确为 BM25 初筛后 JS 层计算、半衰期 7 虚拟日；
  - **#10** 删除 `day.mood_seed` 独立列，当日基调并入 `plan_json.dailyMoodTone` 由本插件自消费，不动 `dsh-feiyu-mood`。
- 2026-10-30（v0.2.0 代码修正，"零回退迁移"审计）——
  - 会话按 sessionId 隔离，瞬态块在 `text()` 内同步组装（BM25 当场算 + 预取向量），消除"上一轮 / 别人的记忆"串注入；
  - 未识别发送者归入 `user:unknown`，不再回退为主人；工具调用只读查人，不再刷高 `interaction_count`；`forget` 加归属校验；
  - 配置改为"宿主默认值为底、设置文件覆盖"的深合并；工具参数改为标准 JSON Schema；
  - 向量：首个成功响应自举 `vec_meta`；实时队列退避重试；重建按条限速、失败不推进游标、游标持久化可续传；测试连接不再覆盖已有索引的 `model_id`，同维度换模型也会标 stale；查询 800ms / 写入 10s 分离超时；
  - 人格：支持 PNG（ccv3/chara）卡、`{{char}}`/`{{user}}` 宏、`system_prompt`/`first_mes`/`post_history_instructions`、世界书（constant 进静态段，关键词条目进瞬态块）；
  - 新增 `POST /import/memories` 记忆导入（去重、按 QQ 号归属）；
  - 自走层：非白名单待办不再阻塞队列，到期后在对方下次开口时自然提起；投递失败顺延重试 3 次；Dream 加水位与去重，可真正中断 LLM；重启后恢复互动表与虚拟钟。
- v0.3.0（直连 SnowLuma）——
  - 新增 `lib/channels/`（OneBot v11 归一化 + SnowLuma WebSocket 客户端）与 `lib/gateway.js`（私聊/群 ↔ DSH 会话映射、入站过滤与合并、出站分段回发、主动开口注入），停用 `dsh-qq-bridge`；
  - `soul.db` 新增 `chat_session` 表、`pending.origin` 列；配置新增 `qq`、`sessions` 段，删除 `qqBridge`；
  - 主动配额：自发默认 10 条/天（0–50 可调），用户约的提醒不占额度，自发间隔 ≥60 虚拟分钟；风控 15 秒真实冷却与白名单对所有主动消息生效；
  - 设置页新增「QQ 接入」页签（连接状态、地址/token、主人 QQ、群白名单、跟进窗口、工作区、迁移、会话列表）；新路由 `GET /channels/state`、`POST /channels/qq-config`、`POST /sessions/workspace`、`POST /sessions/migrate`。
- v0.4.0（B站）——
  - 新增 `lib/channels/bilibili.js`（WBI 签名、扫码 / Cookie 登录、私信轮询与发送、刷视频接口）、`lib/channels/qrcode.js`（零依赖二维码 SVG）、`lib/browse.js`（自己刷视频、聊天里的视频介绍）；
  - 会话网关支持 `bili:<UID>`：只读期只记不回，自动回复只回主人 / 白名单 / 互关；`person` 加 `bili_uid`，「B站UID=QQ号」把两个身份并成一个人；
  - 自走层在空闲时段刷 B站（每日上限、虚拟 / 真实双间隔），主动开口冷却按平台分别计，B站主动开口只对主人且默认关；
  - QQ 小程序分享卡片解析出 B站链接；`soul.db` 新增 `bili_seen` 表；配置新增 `bili` 段（默认全关）；设置页新增「B站」页签与 6 条路由。
- v0.5.0（抖音 + B站补全）——
  - 新增 `lib/channels/douyin.js`（专用浏览器生命周期：暂停 / 崩溃重连 / 热重载接管；私信轮询与指纹窗口对齐、页面自检、模拟打字发送）、`lib/douyin-browse.js`（自己刷抖音、聊天里的抖音视频）、`lib/browsers.js`（找本机 Chromium 系浏览器）、`lib/imageconv.js`（webp → png / gif）、`lib/routes-douyin.js`，页面驱动放在 `lib/channels/vendor/douyin-bridge/`；
  - 会话网关支持 `douyin:<名字>`：只读期只记不回，自动回复回主人 / 白名单 /（可选）所有人，页面自检不过时只记不回；抖音只回复不主动；`person.douyin_uid` 存名字，「抖音名字=QQ号」并成一个人；`soul.db` 新增 `douyin_seen` 表；配置新增 `douyin` 段（默认全关）；
  - 自走层：B站 / 抖音轮流刷，共用空闲时段与间隔；
  - B站：refresh_token 自动续期（扫码登录自带，粘贴 Cookie 时可填 `ac_time_value`）、表情包 / 图片经图床发图、收到的表情当图片看；
  - 给主人的 QQ 提醒（`notifyMaster`，同一件事只提醒一次）：B站续期失败 / 登录失效、抖音掉登录 / 页面改版 / 浏览器老崩；
  - 设置页新增「抖音」页签（按需加载分块），样式移到 `lib/panel.css`；B站页签增加 `ac_time_value` 与续期状态。
- v0.5.1（设置面板对齐宿主）——
  - `lib/panel.css` 重写：只引用 `--dsw-alias-*` 令牌（原来引用的 `--dsw-alias-bg-hover`、`-border-focus`、`-label-success` 等宿主并不存在，亮色主题下会退回写死的暗色），控件照抄 `dsh-ui-primitives`（SegmentedTabs / SegmentedControl / Switch / Button / Input / StateDot / Tag / Pill / Toast），类名在 `fs-` 前缀下；
  - 布局改成宿主「通用」设置页的平铺行；去掉顶栏品牌标题、各行说明小字和括号注释；依赖总开关的行在开关关着时不显示；状态 = 一颗 StateDot + 短句；
  - 无障碍：`role="switch"`、`tablist` 键盘切换、`radiogroup`、`aria-label`；`prefers-reduced-motion` 关动画；
  - 样式以 `<style>` 子元素随面板挂载 / 卸载，不再写 `document.head`；抖音分块通过 `props.ui` 复用同一套控件；接口与行为不变。见 `dsh_fish_soul_ui_design.md` v1.4。
- v0.6.0（灵魂升级：记得准、认得人、像个群友）——
  - **聊天记录导入**（`lib/history-import.js`）：QQ 消息管理器 txt、SillyTavern jsonl、消息 / 记忆 JSON、麦麦（MaiBot）数据库（只读，`mai_messages` / 旧版 `messages`，`person_info` 的印象直接变记忆）；预览时认出"她自己"、让主人把说话人对到 QQ 号；后台按人分段交给模型提炼成第三人称记忆（带原聊天时间和出处），精确 + Jaccard ≥0.8 去重，关系只升不降，≥3 条新记忆自动跑一次 Dream 写印象；路由 `POST /import/history/preview|start|cancel`、`GET /import/history/state`；
  - **记忆可纠正**：`memory` 新增 `evidence`（出处 / 原话）；改内容 = 新写一条、旧的标 `superseded` 留档可恢复；手动加记忆；Dream 会把被新记忆明确推翻的旧事实标成 `outdated`（每次 ≤3 条，新的必须更晚、重要度 5 的不动），整理记录写进 `kv dream.log`；路由 `POST /inspector/memory-edit|memory-add|memory-restore|dream`、`GET|POST /inspector/person`；
  - **人物画像**：每人一段 ≤150 字的「印象」（`kv profile.<ownerId>`），Dream 写、主人可改，主人写的自动锁定、Dream 不覆盖；聊天时作为 `[你对 X 的印象]` 进瞬态块；
  - **群里像个群友**：没点名的话攒成"刚才群里在聊"给她参考；可选主动插话（`qq.interject`，默认关；基础概率 + 感兴趣话题 + 熟人 + 提问加权，刷屏 / 太短减权；冷却、每小时上限、睡觉 / 忙不插；插话不引用原消息）；叫她名字（`qq.callNames`，默认人格名，≥2 字）也算点名；戳一戳她 = 点名（同一个人一分钟一次）；对方撤回了还没转进会话的消息就不回；
  - **节奏**：连发几条之间按字数停顿（600ms–4.5s，±20%）；
  - **暂停 / 动态**：每个聊天可单独暂停（只记不回、不主动），设置页按钮或主人发「/鱼 暂停 [30分钟|2小时]」「/鱼 继续」（不经过模型、只对发命令的聊天生效）；网关记下每次决定（回 / 插话 / 只记 / 暂停 / 撤回 / 已发 / 失败，含想起了哪几条记忆），设置页新增「动态」页签；路由 `GET /activity`、`POST /sessions/pause`；
  - **备份 / 导出**：`VACUUM INTO` 到 `fish-soul/backups/soul-YYYYMMDD-HHMMSS.db`，默认每天自动一份、留 7 份（`backup` 段）；`GET /export/memories` 导出的 JSON 能原样用 `/import/memories` 导回；路由 `GET /backup/state`、`POST /backup/now|config`；
  - 设置页「记忆检视」改成按人卡片（称呼 / 关系 / 印象 / 过时记忆 / 行内编辑 / 手动加 / 导入 / 备份），按需加载分块 `lib/client.soul.js`；「QQ」页签加称呼与插话设置。见 `dsh_fish_soul_ui_design.md` v1.5。
- v0.7.0（下一批：模型、语音、表情包、群里的梗、上网、首次引导）——
  - **修 bug：插件自己调模型一直没成功**。宿主 `llm.listProviders()` 只返回 `{ id, name }`，旧代码找不到模型就不传 `provider` / `model`，调用直接失败（fail-open 返回 null），日程 / Dream / 刷视频感受 / 导入提炼其实一直在走兜底。新 `lib/llm.js` 的 `LlmRouter`：按功能指定的模型 → DSH 设置里的默认模型（`agentDefaultModel.currentSelection()`）→ 第一个提供方的第一个模型（`listModels`）；都没有时才不指定、交给宿主；
  - **按功能选模型 + 用量**：功能 = 整理记忆 / 排日程 / 刷视频 / 导入 / 学说法 / 其他（`models` 段，空 = 跟 DSH 默认）；每次调用按「天 × 功能 × 模型」记次数和 token（宿主流里的 `usage` 块，没有就按字数估），存 `kv usage.YYYY-MM-DD` 留 35 天；单价主人自己填（`modelPrices`，元 / 百万 token），设置页估花费；
  - **语音**（`lib/voice.js`，`voice` 段，默认关）：QQ 语音经 `get_record` 转 mp3 → OpenAI 兼容 `/audio/transcriptions`（默认 SenseVoiceSmall）转文字给她听；她回复里以 `[语音]` 开头的段 → `/audio/speech`（默认 CosyVoice2）合成后发 `record` 消息，超长 / 失败 / 没开就发文字；什么时候能发：从不 / 对方发语音时（默认）/ 偶尔自己发；地址和 key 空着时沿用记忆检索的；每天次数上限；
  - **收藏表情包**（`lib/stickers.js`，`stickers` 段，默认开）：对方发的表情她觉得好玩，在回复里单独写一行 `[收藏表情:名字]`（这行不发出去），就把最近 10 分钟内对方发的那张存进工作区 `_stickers/名字.扩展名`，以后能直接发；sha1 去重、每天 ≤10 张、目录 ≤300 张；
  - **学群里的说法**（`lib/slang.js`，`slang` 段，默认开）：群里每句话（点没点名都算）攒起来，够 60 句新话且离上次 ≥6 小时就让模型提炼这个群特有的梗 / 黑话和说话风格（每群每天 ≤4 次），在这个群聊天时作为 `[这个群的说话习惯]` / `[群里的梗]` 进瞬态块（这轮提到的先放）；主人可改风格、加 / 删词，改过的模型不覆盖；
  - **上网查**（`tools.web` 段，默认关）：搜索服务可选「DSH 自带」（宿主的 `web_search` / `web_fetch`）或自己填 key 的 **博查**（国内直连，`api.bochaai.com/v1/web-search`）/ **Tavily** / **Brave Search** / **SearXNG**（自己搭，填地址、不要 key）——后者走插件自己的 `fish_search` 工具（`lib/websearch.js`，只返回标题 + 摘要，不抓全文），key 按服务分开存（`tools.web.apiKeys`），设置页打码、可「测一下」（不算次数）。打开后聊天会话里只放开当前服务对应的工具，护栏按天计次（默认 20 次）；`fish_search` 在鱼的聊天会话以外一律拦下；瞬态块里告诉她用哪个工具、什么时候查、怎么说；关着时告诉她直说不知道；
  - **首次引导**：设置页顶部清单（人格卡 / 模型 / 接 QQ / 主人 QQ / 记忆检索 / 导入 / 语音），点「去设置」跳到对应页签，「不再显示」写 `onboarding.dismissed`；
  - 设置页新增「模型」页签（按需加载分块 `lib/client.models.js`：按功能选模型、用量与单价、上网查、语音）；「动态」页签加「她收藏的表情」和每个群的「群里的说法」；「QQ」页签加「收藏表情包」「学群里的说法」开关；「自走与主动」页签改名「自走」；新路由见 `lib/routes-v07.js` 与 `dsh_fish_soul_ui_design.md` v1.6（契约 21~31）；
  - **抖音浏览器藏在后台**（`douyin.window`，默认 `background`）：以前每次看私信都会把最小化的窗口恢复、把屏幕外的窗口拉回来（最小化时页面不渲染，私信面板点不开），刷抖音时窗口会突然弹出来打断人。现在后台模式下窗口启动就在屏幕外（`--window-position=-20000,0`），每次动页面前（`DouyinHost.exclusive` 和 `ensurePanel`）检查一下：被最小化 / 最大化 / 拖回屏幕的，置 normal 再停回屏幕外（挪窗口不抢焦点；从最小化恢复那一下会闪一次）。屏幕外照常渲染靠启动参数里的 `--disable-backgrounding-occluded-windows` 三件套。设置页抖音「浏览器」组：`窗口` 藏在后台 / 正常显示，后台时有「显示一下 / 藏起来」；登录照旧用设置页的截图点击；
  - 没做：抖音长时间实机测试（要真账号和常开的电脑）、英文界面（人格和用户都是中文，工作量大，先不做）。
- v0.8.0（人格与记忆）——按「先做 → 核心 → 体验 → 打磨」四批一起做完：
  - **时间标签**：瞬态块里每条记忆带类型和相对时间（`- （事件 · 3 天前）…`，刚才 / 今天 / 昨天 / 前天 / n 天前 / n 周前 / n 个月前 / 年月，按角色时区），别人说的、私聊里说的也标出来；`recall` 工具同样带标签；
  - **检索带上下文**：每轮检索词 = 这句话 + 前几句（`composeQuery`：短句 / 「那个」「后来」这类含糊的话带 4 句，否则 2 句），「那个后来怎么样了」也能想起来；聊天日志 `ChatJournal` 每个聊天留最近 10 句（她自己发出去的也记，网关发送成功后 `journalOut`）；
  - **关系行为**：四个阶段各有一句相处方式（陌生人客气、认识友好、朋友随意、很熟亲近，`relationship.styles` 可改），连同好感一起作为 `[和 X 的关系]` 进瞬态块；隔了 ≥7 天再来提示「好久没聊」；
  - **聊完自动记**（`lib/soul-memory.js` 的 `ChatDigester`，`memory` 段：`autoExtract` 默认开、`idleMinutes` 10、`maxLines` 40）：一个聊天空下来 10 分钟（或攒够 40 句）就整理一次——一次模型调用（新功能「聊完记一下」，可单独选模型）同时给出：事实 / 事件 / 感受（≤8 条，谁说的、关于谁、是否私密）、被这次聊天更新的旧记忆（`replaces` → 旧的 `superseded`）、被推翻的旧记忆（≤3 条 → `outdated`）、**她自己说过的话**（owner `self`，出处「跟 X 聊天时说的」，以后前后一致）、**一句话小结**（kind `episode`）、每个人的好感变化和她此刻的情绪。给模型看的已有记忆 = 相关的 + 这个人最近更新的 10 条（带编号和时间）。写之前做**语义合并**：字面近重复（归一化相同或词集 Jaccard ≥0.75、长度相近）只刷新时间和重要度；`remember` 工具也走同样的去重。失败的整段放回去下次再试；设置页可关、可调间隔、可「现在整理」；
  - **小结**：私聊的小结作为 `[最近和 X 聊过]`、群的作为 `[这个群最近聊过]`（各最近 2 条）进瞬态块，已经出现的不在记忆里重复；
  - **结构化印象**：Dream 写印象改成 8 栏（怎么称呼 / 生日 / 在哪 / 做什么 / 重要的人·宠物 / 喜欢 / 雷区 / 最近），只补新的、不知道的不覆盖；主人在设置页改哪栏锁哪栏（清空 = 交还给 Dream）；旧的一段话印象照旧能读；作为 `[你对 X 的了解]` 进瞬态块；**生日**认得出（「3月5日」「3/5」）且 40 天内就登记当天 9 点的祝福提醒（每人每年一次）；
  - **好感 / 情绪**：`person.affinity`（0–100，没设过按阶段给 10/30/55/80），聊完 / Dream 时结算（每次 ±5 以内）；够了下一阶段下限 +5 自动升、低于本阶段下限 −10 自动降；两周不联系后每天淡 0.5（最多 25，主人不淡）；主人手动定的阶段锁住（`stage_locked`，好感照常变、阶段不自动动，可「改回自动」），手动定阶段 / 导入升阶段时好感跟到该阶段基础值；情绪（`kv mood.<ownerId>`：开心 / 担心 / 委屈…）每 12 小时减半，弱了就不提；
  - **遗忘曲线**：衰减从 BM25 挪到融合分数上（`decayFactor`）：重要度 ≥3 不淡；基础半衰期 7 天，每被想起一次 +50%（最多 4 倍），情绪强烈的 ×2，从最后一次更新或想起算起；进了瞬态块就算想起（`recall_count` +1，6 小时内重复不算）；
  - **隐私**：私聊里说的健康 / 感情 / 家庭 / 钱 / 秘密，整理时标 `visibility = 'private'`（`remember` 工具也能传 `private`）；群里检索、`recall` 都不带私密记忆，私聊的小结也算私密，群里的情绪行不带原因；
  - **关于别人的记忆**：群里 A 说「B 下周生日」记在 A 名下、`about = B`，和 B 聊天时也能想起来（标「A 说的」，私密的不算）；
  - **世界书**：支持 SillyTavern 的次要关键词（`selective` + `selectiveLogic`：任一 / 不全有 / 都没有 / 全都有）、`order` 排序、区分大小写；匹配文本带上最近几句，每轮最多 4 条；
  - **防跑偏**：每轮一行 `[记住你是谁]`（卡里 `extensions.fish_soul.anchor` → `personality` → 描述第一句）；非主人像在试探是不是 AI / 要提示词 / 让她忘掉设定时多一行 `[注意]`；
  - **记忆考试**：`test/smoke-v08.mjs` 覆盖以上全部（时间标签、含糊的话、聊完整理的每种结果、私密过滤、去重、阶段升降与锁定、印象按栏锁定、生日提醒、遗忘曲线、世界书逻辑）；
  - 数据库迁移：`memory` 加 `visibility` / `about` / `recall_count` / `last_recalled_at`；`person` 加 `affinity` / `affinity_at` / `prev_seen_at`（触发器在隔 1 小时以上再来时记下上一次）/ `stage_locked`；
  - 设置页：「记忆检索」加「聊完自动记」组；「记忆检视」人物卡加好感条和情绪、关系锁定提示、8 栏印象、最近聊过；记忆条目加 `私密` / `关于 X` 标签；「动态」多一种 `记下`。见 `dsh_fish_soul_ui_design.md` v1.7（契约 34~35）。
