# dsh-fish-soul 前端 UI 设计文档（v1.4 · 宿主原生版）

> **对应架构方案**：《dsh-fish-soul 设计方案》（DESIGN-fish-soul.md）  
> **宿主技术栈**：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（`packages/client/` · `ui-theme` 的 `--dsw-alias-*` 令牌 + `ui-primitives` 控件）  
> **核心设计信条**：**Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**  
> **实现文件**：`lib/client.js`（主面板）、`lib/client.douyin.js`（抖音页，按需加载）、`lib/panel.css`（全部样式）

## 1. 原则

### 1.1 让布局自解释

| 以前 | 现在 |
| :--- | :--- |
| 每行下面一句灰色说明（“关着：只记不回（建议先这样跑一周）”“网页版拿不到抖音号……”） | 去掉。必要的状态只用一个短词贴在控件旁（`只记不回`），长解释留在 DESIGN 文档 |
| 关掉总开关后，下面的表单半透明置灰 | **直接不显示**：依赖总开关的行只在开着时出现（主动开口、QQ 接入、混合检索的向量组、刷视频） |
| 状态行堆字段（`已连接 · 昵称（QQ）· 好友 n`、`gen #3 → #4`） | **一颗 StateDot + 一个短句**；细节放进 `title` 悬浮提示 |
| 顶栏品牌标题 + 图标 | 去掉。设置导航里已经有「鱼 · 记忆与自走」，面板从页签开始 |
| 卡片 + 88px 左标签栅格 | 宿主「通用」设置页的**平铺行**：标题左、控件右、0.5px 分隔线；长文本（多行名单）用上下堆叠行 |
| 小字说明“建议在抖音设置……” 常驻 | 只在打开「回所有能私信她的人」时出现这一句（唯一保留的说明，属于需要用户去做的事） |

### 1.2 宿主契约

1. **只用 `--dsw-alias-*` 令牌**（`lib/panel.css` 里没有任何非 alias 的 `--dsw-*` 引用；圆角用宿主刻度的字面值 4 / 8 / 12 / 16）。唯一的字面颜色是 B站二维码底的白色（图像，不是界面）。
2. **不 `require` 任何 Harness Client 包**：控件照抄 `@deepseek-ai/dsh-client-ui-primitives` 的结构、无障碍语义和样式，改名到 `fs-` 前缀下（见 §2）。主题包改名不会让面板崩，最坏只是样式退化。
3. **样式随面板挂载/卸载**：`panel.css` 只拉一次，以 `<style>` 子元素渲染在面板里，面板卸载即移除，不写 `document.head`。
4. 面板宽度按设置窗口右栏（800 − 188 − 48 ≈ 564px）设计，最大 720px；窄于 560px 时行自动折成上下两段。
5. 亮 / 暗主题都已用宿主真实的 `design-platform.css` + `base.css` 渲染核对过。

## 2. 控件对照（`ui-primitives` → `fs-*`）

| 宿主原语 | 面板里 | 保留的行为 |
| :--- | :--- | :--- |
| `SegmentedTabs`（sm） | `.fs-tabs` / `.fs-tab`（6 个页签） | `role="tablist"`/`tab`、`aria-selected`、←/→/Home/End 切换并移焦、滑动指示条 |
| `SegmentedControl` | `.fs-seg`（检索方式、融合） | `role="radiogroup"`/`radio` + `aria-checked`，滑动指示条 |
| `Switch` | `.fs-switch` | `<button role="switch" aria-checked aria-label>`，开 = `brand-primary` |
| `Button`（sm） | `.fs-btn` + `primary` / `ghost` / `danger` | 28px、outline 内描边、hover / active / disabled |
| `settings-form` 的 input | `.fs-input`（含 `num`、`textarea`、`select`） | 32px、0.5px `border-l4`、聚焦 `state-business-primary` 描边 |
| `StateDot` | `.fs-dot` / `.fs-spin` | done / warning / error / idle 圆点，ongoing 转圈；`prefers-reduced-motion` 关动画 |
| `Tag` | `.fs-tag[data-tone]` | neutral / outline / success / info / warning / danger |
| `Pill` | `.fs-pill[aria-pressed]`（记忆按人筛选） | active 用 `button-ghost-active-*` |
| `Toast` | `.fs-toast` | 顶部居中、`toast-bg` / `toast-label`（两种主题都是深色底） |

## 3. 状态表达（检索页「向量」组标题右侧）

| 状态 | 条件 | 显示 | 索引行 |
| :--- | :--- | :--- | :--- |
| 关键词 | 检索方式 = 关键词 | 向量组整组不显示 | — |
| `ready` | 测试通过、模型没改 | `● 可用 · 182ms`（绿） | 进度条 + `继续重建` / `重建` |
| `stale` | 改了接口地址或模型 | `● 模型变了，需要重建索引`（黄） | 进度条转黄，`重建` 变主按钮 |
| `building` | 正在重建 | `◌ 正在重建`（转圈） | 进度条转蓝，`暂停` |
| `error` | 没配置 / 连不上 | `● 未配置`（灰）/ `● 连不上，先只用关键词`（红） | 重建按钮禁用；对话照常（fail-open） |

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
