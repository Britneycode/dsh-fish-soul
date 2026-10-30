# dsh-fish-soul 设计方案

> 状态：待实现，尚未写任何代码（v1.1 已合并架构审查 10 项修正）
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
| 9 | 主动消息：事件驱动优先、每天 ≤2 条、醒着时段、只发自己与自建群 | 小号主动私信真人是封号与社交双重风险 |
| 10 | 检索 = BM25 + 语义向量 + RRF；向量**只用远程 OpenAI 兼容接口** | DeepSeek 无 embedding 端点；不做本地 ONNX |
| 11 | MVP 在本机 Windows 验收 | 抖音插件 Windows-only；SnowLuma 已在本地跑通 |
| 12 | 实现由 AI 写、用户验收 | — |

## 3. 插件分工（MVP）

| 插件 | 状态 | 职责 |
|---|---|---|
| **dsh-fish-soul**（新建） | 要写 | 人格卡、按人记忆、日程与时间线、事件驱动主动 |
| `dsh-qq-bridge` | 保留 | 收发 QQ 消息 |
| `dsh-feiyu-mood` | 保留不动 | 七维心情与衰减（内核 MVP 不重复实现情绪） |
| `dsh-fish-memory` | 保留，只读对照 | 验证期比较召回效果，确认内核不差后卸载 |
| `dsh-speak-up` | **停用** | 与内核的主动推进冲突，会重复发消息 |

## 4. 架构

```
QQ ──> dsh-qq-bridge ──> DSH session ──> dsh-fish-soul
                                          ├── persona   静态人格（V3）
                                          ├── memory    按人记忆（SQLite）
                                          └── life      日程 / 待办 / 主动
                                                    │
抖音（MVP 不接）────────────────────────────────────┘
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
  douyin_uid        TEXT UNIQUE,
  display_name      TEXT NOT NULL DEFAULT '未知用户',
  aliases           TEXT NOT NULL DEFAULT '[]',         -- JSON 字符串数组
  relation_stage    TEXT NOT NULL DEFAULT 'stranger',   -- 'stranger'|'acquaintance'|'friend'|'close'
  interaction_count INTEGER NOT NULL DEFAULT 0,         -- 累计对话轮数，供关系阶段演进
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);
```

同一真人在 QQ 与抖音各有一个外部 ID，`canonical_id` 是内核自己的主键。

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
   - 事件驱动优先：`pending` 到期 → 生成一句话 → 按 `channel_id` 经 `qq-bridge` 投递
   - 时间驱动兜底：处在空闲时段且距上次互动 > N 小时
   - 情绪只影响语气，不作为触发条件
   - 投递目标白名单来自配置（见 §10.6），禁止凭 `owner_id` 盲发（审查 #01）
4. **硬约束**：每天 ≤2 条（以 `day.proactive_count` 持久化计数，重启不丢，审查 #02）；仅 08:00–24:00；仅发用户本人与自建群；白名单真人只在先开口时回复。
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
| 主动消息风控冷却 | **真实物理钟** | 两次调 `qq-bridge` 的真实间隔 ≥15 秒，即使虚拟已跨天 |
| embedding `timeoutMs: 800`、重建 32 条/分钟限速 | **真实物理钟** | 外部 HTTP 超时与 API 速率永远用真实毫秒 |

### 10.6 主动投递白名单配置（审查 #01）

`$DSH_HOME/fish-soul-config.json` 增加：

```json
{
  "proactive": {
    "enabled": true,
    "dailyMaxCount": 2,
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

`qq-bridge` 投递消息 → 内核在 `agent/pre-step` 取发送者 QQ 号 → 查 `person` 得 `canonical_id` → 按人取记忆；群聊额外注入群内近期摘要。

> **待验证**：`qq-bridge` 把发送者标识放在消息对象的哪个字段。实现第一步就要确认，否则"按人"落不了地。

### 抖音

MVP 不接。理由：抖音插件是 Windows-only 的真浏览器自动化，此刻未安装、未验证；先把 QQ 侧四条验收跑稳，避免两件未验证的事捆在一起。

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
| `qq-bridge` 不暴露发送者 ID | 按人记忆落不了地 | 先验证；不行则退化为按会话分，同时提 issue |
| meow 的代码结构与"按人"改动冲突 | fork 成本超预期 | 退路：自写 1,500–2,000 行，只抄 BM25 与衰减公式 |
| 远程 embedding 不稳定 | 召回质量波动 | 全链路降级 BM25，不影响对话 |
| 前缀缓存被打碎 | 成本上升 | 动态内容注入在最新用户消息前的瞬态块（§7），不走 section |
| 小号行为触发风控 | 封号 | 主动配额 + 仅自己人 + 两周止损条件 |

## 15. 明确不做

- 向量数据库、ANN 索引、重排序模型
- 本地 ONNX 模型（已决定只走远程）
- 多角色、角色市场、人格编辑器以外的创作工具
- 抖音接入（MVP 之后另行评估）
- 记忆加密、云同步

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