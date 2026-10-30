# vendor/douyin-bridge

抖音网页端的浏览器控制与私信读写代码，取自
[pcmxiao/dsh-douyin-bridge](https://github.com/pcmxiao/dsh-douyin-bridge)
v0.1.0（commit `6e4bb7f`，2026-10-27），MIT 许可（见同目录 `LICENSE`）。

fish-soul 只用它的「浏览器 + 页面操作」部分，不用它的桥接 / 会话 / 工具层
（会话、记忆、回复规则都由 fish-soul 自己管）。

## 文件对应

| 本目录 | 原文件 | 说明 |
| --- | --- | --- |
| `browser.mjs` | `lib/browser.mjs` | 零依赖 CDP 浏览器控制 |
| `selectors.mjs` | `lib/selectors.mjs` | 选择器降级链 + 页面体检（canary） |
| `media.mjs` | `lib/media.mjs` | 图片 / 表情 / 语音等消息识别与合并 |
| `pb.mjs` | `lib/pb.mjs` | protobuf 解码 |
| `douyin-api.mjs` | `lib/douyin-api.mjs` | hook 抖音自己的 IM 接口读私信 |
| `douyin-util.mjs` | `lib/douyin.mjs` 第 47–98 行 | 解析工具 |
| `douyin-detail.mjs` | `lib/douyin.mjs` 第 233–377 行 | 视频详情 `detail()` |
| `douyin-panel.mjs` | `lib/douyin.mjs` 第 801–1441 行 + `hasInput` | 私信面板 / 进会话 |
| `douyin-dm.mjs` | `lib/douyin.mjs` 第 1442–2625 行 | 读 / 发私信、发图、发表情、登录态、会话列表 |

原 `douyin.mjs` 有 112 KB，拆开只是为了单个文件小一些；拆分时函数体没有改。
搜索、分享、评论、贴纸、状态文件、桥接本体（`bridge.mjs` 等）没有引入。

## fish-soul 的改动

- `browser.mjs`
  - `Browser` / `getBrowser` 增加 `extraArgs`（额外启动参数，例如 `--mute-audio`）；
  - `browserProcesses()` 除了 `msedge.exe` / `chrome.exe`，也按实际启动的 exe 名找残留进程（Brave、Vivaldi 等）；
  - 新增 `Browser.quit()`：通过 CDP `Browser.close` 真正关掉浏览器（连上的是已有实例时 `close()` 只断连接）。
  - 新增 `Browser.onEvent`：每个 CDP 事件先给上层看一眼（用来判断用户是不是自己把窗口 / 标签页关了）。
- `media.mjs`：`mergeMessages()` 末尾原来把已经放进结果的 API 消息又追加了一遍，
  会让窗口对比把旧消息当成新消息；改成只补没匹配上的更新消息。
- `douyin-dm.mjs`：`shapeResult()` 带上分享视频的 `shareAweme`（视频 id）。
- 拆分带来的 import 调整（`sleep`、`hasInput` 移到公共位置）。

刷推荐页时读当前视频的做法参考了
[LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent)（MIT）的 `core.mjs`，代码是 fish-soul 自己写的（`lib/douyin-browse.js`）。
