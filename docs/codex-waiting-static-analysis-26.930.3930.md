# Codex 等待反馈静态分析（26.930.3930.0）

分析日期：2026-10-04。依据用户指定目录进行离线、只读分析，没有执行目标程序或访问服务端。

## 样本与证据

样本：`C:\Program Files\WindowsApps\OpenAI.Codex_26.930.3930.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。

| 归档内资源（均位于 webview/assets） | 关键证据 |
| --- | --- |
| `local-conversation-turn-c0ea6c3c6308.js` | `Ns` 根据运行状态、正文、计划、探索活动、工具活动和阻塞请求选择 thinking / exploring / planning / none；`ll` 渲染普通等待块或准备环境反馈。 |
| `app-initial-74dc12f48352.js` | 导出 `co` 对应 `LKc`，普通等待块：可选图标、单行截断文字、默认 Thinking；文字组件 `OVs` 调用 `kVs` 的间歇扫光。`IVs` 初始化持续时间 1000ms、重复间隔 4000ms、首次延迟 600ms。 |
| `app-initial-341eb5dd9ad5.css` | `_cadencedShimmerSweep_wne66_35` 使用遮罩，父层位移 -50% → 125%，文字高亮层反向位移 50% → -125%；1 秒、steps(48,end)、单次播放，减少动态效果时禁用。 |
| `inline-followup-markdown-f2bbacb053a5.js` | 导出 `h` 对应 `q`，判断条目是否已有可展示内容。 |
| `sites-end-resource-673e94ebe0e8.js` | 工具活动组可接收 thinkingFallbackMessage，把等待反馈合并入活动组，避免额外重复显示。 |
| `app-shared-6fb15e58cd7f.css` | 通用 loading-shimmer 基础周期 2 秒；它与普通等待块实际使用的间歇扫光不同，不能仅搜索通用 CSS 就认为普通聊天采用该周期。 |

复现提取：读取 ASAR 前 16 字节；JSON 索引长度为偏移 12 的 uint32LE，数据区起点为 `8 + uint32LE(偏移4)`。从 `files.webview.files.assets.files` 查资源，按 `数据区起点 + entry.offset`、`entry.size` 读取即可。随后沿 `ll → mr（导入 co）→ LKc → OVs → kVs` 查看普通等待组件；搜索 `_cadencedShimmer` 查看对应 CSS。无需安装解包依赖。

## 交互结论

1. 活跃回合还没有可展示内容时就渲染 Thinking；渲染条件不依赖首个正文或工具事件。
2. 正文、计划、工具活动、探索活动及阻塞请求拥有各自的反馈，避免叠加普通等待块。
3. 已有活动组时可在该组继续显示等待标题；新内容接替等待反馈。
4. 文字立即出现；600ms 延迟只作用于第一次扫光。扫光持续 1 秒，每 4 秒重复。
5. 静态分析只能确认这些分支与样式，不能证明目标应用的实际帧率或所有实验配置下的显示方式。

## Qone 根因与实现

发送时 store 已设置 running，消息转换层也已创建空的运行中 assistant 消息；`AssistantParts` 只渲染真实内容分组，未接入已有的 `assistantWaitingPhase`，导致首包前没有反馈。

- 在公共 `AssistantParts` 渲染入口接入判断，因此主会话和侧聊复用同一行为，不等待 runId 或首个模型事件。
- 准备、等待模型和工具后的思考阶段保持同一“正在思考”文案，避免无意义的标题跳动；阶段数据来自真实状态。
- 有效阶段标题、运行中工具、当前正文/媒体、运行中的思考、自动压缩和图片生成接替普通等待反馈；完成、取消和失败移除等待块。
- 阶段标题工具无独立工具行，参数尚无有效标题时不能抑制等待反馈。
- 复用现有 ShimmerLabel，采用目标版本的遮罩和反向位移。用 CSS 4 秒周期的前 25% 执行 1 秒扫光，其余时间停在文字区域之外，避免增加每个标签的 JavaScript 定时器。高亮颜色使用 Qone 主题变量；基础文字保留，减少动态效果时隐藏高亮层。

验证使用真实 assistant-ui 消息渲染、相关回归测试、TypeScript 和不落盘的 Vite 构建。界面视觉效果由用户在开发模式验收。
