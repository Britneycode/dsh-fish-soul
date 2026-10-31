# dsh-fish-soul 前端 UI 设计文档（v1.5 · 宿主原生版）

> **对应架构方案**：《dsh-fish-soul 设计方案》（DESIGN-fish-soul.md）  
> **宿主技术栈**：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（`packages/client/` · `ui-theme` 的 `--dsw-alias-*` 令牌 + `ui-primitives` 控件）  
> **核心设计信条**：**Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**  
> **实现文件**：`lib/client.js`（主面板）、`lib/client.douyin.js`（抖音页，按需加载）、`lib/client.soul.js`（记忆检视 / 动态页，按需加载）、`lib/panel.css`（全部样式）

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
| `SegmentedTabs`（sm） | `.fs-tabs` / `.fs-tab`（7 个页签） | `role="tablist"`/`tab`、`aria-selected`、←/→/Home/End 切换并移焦、滑动指示条 |
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

## 3.5 v1.5 新增页面（v0.6.0）

页签：记忆检索 · 自走与主动 · **记忆检视** · **动态** · QQ · B站 · 抖音。记忆检视和动态在 `client.soul.js` 分块里，和抖音页一样通过 `props.ui` 复用主面板的控件。

**记忆检视**（从上到下）

| 组 | 内容 | 交互 |
| :--- | :--- | :--- |
| 人 | `Pill` 一排：全部 / 她自己 / 每个人 | 选中某个人才出现下面的人物卡 |
| 人物卡 | 组标题 = 名字，右侧 `QQ 号 · 互动 n 次 · 哪天认识`；行：称呼（Input）、关系（Select）、印象（Textarea） | 印象下方：`Dream 写的` / `你写的 · 锁定` Tag；`交给 Dream`（解锁）/ `现在整理一次` / `保存`。主人保存的印象自动锁定 |
| 改掉 / 过时的 | 被改写（`改过`）或 Dream 判过时（`过时`）的旧记忆 | `恢复` |
| 记忆 | 顶部一行手动记一条；每条：类型 Tag、内容、重要度星、来源短词、向量状态点 | 悬浮看出处原话；`修改` 展开成行内编辑（内容 / 类型 / 重要度）；`删除` |
| 待办 | 到期时间 + 内容 | — |
| 导入 | `选文件`（.txt / .json / .jsonl）、`麦麦数据库`（填路径 → `读取`） | 预览：格式 · 聊天数 · 消息数；每个说话人一行：`是她` 勾选、条数、已认识 Tag、QQ 号输入（没填的跳过）；`最多调用模型 n 次` → `开始导入`；导入中行右侧转圈 + `导入中 5/12 · 谁 · 新记忆 n` + `停止` |
| 备份 | `每天自动备份` 开关（右侧"上次 x 前"）；备份目录（灰字，含恢复方法） | `立刻备份`、`导出记忆`（下载 JSON） |

**动态**：`暂停中`（每个暂停的聊天 + 到几点 / 一直 + `恢复`）、`最近`（决定流水：Tag = 已发 / 要回 / 插话 / 只记 / 暂停 / 撤回 / 失败 / 主动 / 命令，内容 = 聊天名 + 谁：说了什么，右侧原因 + `想起 n 条` + 相对时间，悬浮看想起了哪些记忆）、`整理记录`（Dream 改了谁的印象、判过时几条）。每 3 秒刷新。

**QQ 页签新增行**：`叫这些名字也算点名`（逗号分隔，空 = 人格名）、`群里主动插话`（开关；开着才出现：`插话概率 n % · n 次/小时`、`说完话后冷却 n 分钟`、`感兴趣的话题`）。会话列表每行加 `暂停中` Tag 与 `暂停` / `恢复` 按钮。

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
| **9** | `GET` | `/api/plugins/fish-soul/inspector/person` | `?ownerId=user:…` | `{ ok, person: { ownerId, displayName, relationStage, qqUin, biliUid, douyinName, interactionCount, firstSeenAt, lastSeenAt }, profile: { text, by, locked, updatedAt } \| null, counts, outdated: [...], pendings: [...] }` |
| **10** | `POST` | `/api/plugins/fish-soul/inspector/person` | `{ ownerId, displayName?, relationStage?, profile?, profileLocked? }` | `{ ok, profile }` |
| **11** | `POST` | `/api/plugins/fish-soul/inspector/dream` | `{ ownerId }` | `{ ok, profile }` |
| **12** | `POST` | `/api/plugins/fish-soul/inspector/memory-edit` | `{ id, content?, kind?, importance? }` | `{ ok, id, replaced? }`（改内容 = 新 id，旧的 superseded） |
| **13** | `POST` | `/api/plugins/fish-soul/inspector/memory-add` | `{ ownerId, content, kind?, importance? }` | `{ ok, id }` |
| **14** | `POST` | `/api/plugins/fish-soul/inspector/memory-restore` | `{ id }` | `{ ok, id }` |
| **15** | `GET` | `/api/plugins/fish-soul/activity` | 无 | `{ ok, decisions: [{ at, kind, channelId, title, who, text, reason, memories? }], dreamLog: [...], paused: [{ channelId, until, title }] }` |
| **16** | `POST` | `/api/plugins/fish-soul/sessions/pause` | `{ channelId, minutes }`（>0 分钟 / -1 一直 / 0 恢复） | `{ ok, channelId, until }` |
| **17** | `GET` / `POST` | `/api/plugins/fish-soul/backup/state` · `/backup/now` · `/backup/config` | `config`：`{ auto?, keep? }` | `{ ok, auto, keep, dir, lastAt, list: [{ file, size, at }] }`（`now` 另回 `{ file, path, size, at }`） |
| **18** | `GET` | `/api/plugins/fish-soul/export/memories` | 无 | 附件 JSON：`[{ ownerId, qqUin?, nickname?, content, kind, importance, emotion, channel, channelId, createdAt, evidence? }]` |
| **19** | `POST` | `/api/plugins/fish-soul/import/history/preview` | `{ text, fileName }` 或 `{ dbPath }`（≤40 MB） | `{ ok, previewId, format, chats, chatCount, messageCount, memoryCount, speakers: [{ key, name, qq, suggestQq, count, self, existing }], estimate: { persons, calls }, warnings }` |
| **20** | `POST` / `GET` | `/api/plugins/fish-soul/import/history/start` · `/state` · `/cancel` | `start`：`{ previewId, selfKeys, mapping: { key: qq }, maxCalls }` | `{ ok, job: { status, fileName, total, done, inserted, duplicates, direct, current, persons, errors } }` |
