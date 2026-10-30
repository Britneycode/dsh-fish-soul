# dsh-fish-soul 前端 UI 设计文档（v1.3 · 极简自解释布局版）

> **对应架构方案**：《dsh-fish-soul 设计方案》（v1.1）  
> **宿主技术栈**：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（`packages/client/` · `@deepseek-ai/dsh-ui-settings-plugins` + `@deepseek-ai/dsh-ui-primitives` + `@deepseek-ai/dsh-ui-theme`）  
> **核心设计信条**：**Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**（摒弃冗余的副标题、括号注释与解释性小字，让空间排布、对齐关系与状态色点自然传达语义。）

## 1. 极简视觉原则与宿主对齐

### 1.1 让布局自解释（Layout Does the Explaining）

在 DeepSeek Harness 桌面端插件面板中，界面不应成为架构文档的“文字复读机”，而应通过**结构、对齐、状态反馈与微交互**自解释：

| 传统后台做法（已摒弃） | DSH 极简自解释做法（本版采用） |
| :--- | :--- |
| 在每个配置项下堆砌长串灰色说明文字（如“关闭时仅用本地分词 BM25，保留下方配置”） | **用交互态表达**：切换至「仅关键词 BM25」时，下方向量表单区直接平滑置灰半透明，输入值原样保留，无需一行解释文字 |
| 用多个文字徽章重复标注 `vec_meta.status = ready`、`gen #3`、`timeoutMs: 800` | **用单一状态点表达**：在向量区直接呈现 `● 可用 · 210 ms`，修改模型时原位切换为琥珀色 `● 模型已变更 · 需重建 (#3 → #4)` |
| 将 `维度` 做成可疑的输入框再加括号注释“（测试后自动填入）” | **用附着式只读胶囊表达**：将 `1024 dim` 作为只读等宽胶囊内嵌在 `模型` 输入框右侧，点击「测试连接」后数值直接刷新 |
| 在「她此刻状态」中用四张带标题、副标题、小字注释的厚重卡片堆砌 | **用单行状态头 + 四段式水平时间轴表达**：左看当前动作与心情，右看虚拟时钟与 `1 / 2` 配额点，下方一条 4 段式时间轴直接高亮当前所处时段 |
| 在记忆列表中逐行打印 `keywords:`、`emotion:`、`importance >= 3 豁免衰减` 等冗长字段名 | **用紧凑单行表结构表达**：`[类型] 记忆正文 ··· ★★★★ (豁免图标) · channel_id · 向量状态点 · [×]`，悬浮时才显露删除按钮 |

### 1.2 宿主架构与视觉层级

插件挂载于 `@deepseek-ai/dsh-ui-settings-plugins` 扩展槽位，位于 DeepSeek Harness 桌面端设置窗口右侧主视口（最大宽度 `640px`）：

1. **顶栏与一级分段导航合一**：左侧为插件标识 `鱼 · dsh-fish-soul`，右侧直接放置三段式切换器（`记忆检索` / `自走与主动` / `记忆检视`），零副标题、零章节号角标。
2. **单一表面卡片（Single Surface Grouping）**：每个 Tab 内部使用 `1px` 微光边框（`--border-hairline`）与 `96px` 固定左标签栅格，所有控件左边缘严格对齐在同一垂直轴线上。

## 2. 设计 Token 体系（`@deepseek-ai/dsh-ui-theme`）

| Token 名称 | Dark 暗色（默认） | Light 亮色 | 用途 |
| :--- | :--- | :--- | :--- |
| `--bg-window` | `#0f1116` | `#ffffff` | 设置视口主背景 |
| `--bg-sidebar` | `#0b0d11` | `#f5f6f8` | 桌面端左侧设置导航底色 |
| `--bg-surface` | `#14171f` | `#fbfcfe` | 表单分组卡片表面 |
| `--bg-control` | `#0b0d12` | `#f1f3f6` | 输入框、分段控制器底槽 |
| `--border-hairline` | `rgba(255, 255, 255, 0.06)` | `rgba(15, 23, 42, 0.06)` | `1px` 行间分割线与卡片外框 |
| `--border-subtle` | `rgba(255, 255, 255, 0.10)` | `rgba(15, 23, 42, 0.11)` | 输入框与按钮描边 |
| `--text-primary` | `#eef0f4` | `#111827` | 核心标签、正文与数值 |
| `--text-secondary` | `#8b93a4` | `#4b5563` | 左侧表单字段名 |
| `--text-muted` | `#565e6d` | `#9ca3af` | 次要时间戳、ID 与未激活态 |
| `--accent` | `#4d6bfe` | `#4d6bfe` | DeepSeek 品牌主色（焦点、主按钮、进度条） |
| `--ready` | `#34d399` | `#059669` | 可用态绿点、豁免衰减星标 |
| `--stale` | `#fbbf24` | `#d97706` | 模型变更需重建黄点、`1000×` 加速标识 |
| `--building` | `#60a5fa` | `#2563eb` | 索引重建流光蓝、待向量化补偿点 |
| `--error` | `#f87171` | `#dc2626` | 超时降级红点、删除悬浮色 |
| `--font-sans` | `"Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif` | 同左 | 界面标签与正文 |
| `--font-mono` | `"JetBrains Mono", "SFMono-Regular", Consolas, monospace` | 同左 | 延迟 `ms`、维度 `dim`、配额、进度、ID（`tabular-nums`） |

## 3. 组件状态矩阵（`vec_meta.status` 四态）

| 状态 | 触发条件 | 状态行表现 | 进度条与操作区表现 |
| :--- | :--- | :--- | :--- |
| **`disabled`** | 选择 `仅关键词 BM25` | 向量配置区整体半透明置灰（保留输入值） | 索引区置灰 |
| **`ready`** | 测试通过且模型未改 | `● 可用 · 210 ms`（绿点） | `812 / 1,003 (81.0%)` 蓝条 · `[重建索引]` |
| **`stale`** | 修改了 `BaseURL` 或 `模型` | `● 模型已变更，需重建索引 (#3 → #4)`（黄点） | 进度条转琥珀黄 · 高亮 `[重建索引]` |
| **`building`** | 正在按 `32 条/分钟` 重建 | `● 重建中 · 32 条/分钟`（蓝点脉冲） | 流光动画实时递增 · `[暂停重建]`（支持断点续传） |
| **`error`** | Key 为空或超时 `>800ms` | `● 连接失败/超时 · 已降级纯 BM25`（红点） | 保持原进度快照 · 对话 fail-open 不受影响 |

## 4. 前后端 HTTP 路由契约表（`client.js` ↔ `ctx.connection.fetch.register`）

| 序号 | 方法 | 路径 | 请求体 (Request JSON) | 响应体 (Response JSON) |
| :--- | :--- | :--- | :--- | :--- |
| **1** | `GET` | `/api/plugins/fish-soul/retrieval/state` | 无 | `{ ok, config: { enabled, baseURL, hasApiKey, model, fusionMethod, topK, tokenBudget }, vecMeta: { dim, generationId, status, latencyMs }, coverage: { vectorizedCount, totalActiveCount, lastCursorMemoryId, isWorkerRunning } }` |
| **2** | `POST` | `/api/plugins/fish-soul/retrieval/config` | `{ enabled, baseURL, apiKey, model, fusionMethod, topK, tokenBudget }` | `{ ok, staleTriggered, vecMeta: { dim, generationId, status } }` |
| **3** | `POST` | `/api/plugins/fish-soul/retrieval/probe` | `{ baseURL, apiKey, model, timeoutMs: 800 }` | 成功：`{ ok: true, status: 'ready', latencyMs: 210, detectedDim: 1024 }`<br>降级：`{ ok: false, status: 'error', latencyMs: 804, fallbackMode: 'bm25-only' }` |
| **4** | `POST` | `/api/plugins/fish-soul/retrieval/rebuild` | `{ action: 'start' \| 'pause' \| 'resume' }` | `{ ok: true, status: 'building' \| 'ready', generationId, vectorizedCount, totalActiveCount, lastCursorMemoryId }` |
| **5** | `GET` | `/api/plugins/fish-soul/life/state` | 无 | `{ ok, clock: { virtualNowMs, timeScale, realCooldownSec }, today: { dailyMoodTone, currentSlotIndex, schedule, proactiveCount, dailyMaxCount, isTickRunning }, proactiveConfig }` |
| **6** | `POST` | `/api/plugins/fish-soul/life/proactive-config` | `{ enabled, dailyMaxCount, activeHours, idleTriggerHours, targets: { masterPrivateChannelId, selfGroupChannelIds } }` | `{ ok: true, savedAt }` |
| **7** | `GET` | `/api/plugins/fish-soul/inspector/overview` | `?ownerId=all\|self\|user:master` | `{ ok: true, currentGenerationId, persons: [...], memories: [...], pendings: [...] }` |
| **8** | `POST` | `/api/plugins/fish-soul/inspector/forget` | `{ targetType: 'memory', id: 1003 }` | `{ ok: true, deletedId: 1003, cascadedVecDeleted: true }` |
