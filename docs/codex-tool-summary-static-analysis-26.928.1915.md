# Codex 工具汇总条静态分析与 Qone 对照

## 范围与取证

按用户指定，只读解析 `C:/Program Files/WindowsApps/OpenAI.Codex_26.928.1915.0_x64__2p2nqsd0c76g0/app/resources/app.asar`。未执行安装包脚本、修改安装目录、启动浏览器或打包安装程序。这是该版 Codex 桌面端的静态证据，不等同于 ChatGPT 网页端。

ASAR 解析：前 16 字节中的 uint32LE(12) 为 JSON 索引长度，资源数据起点为 `8 + uint32LE(4)`；在 `files.webview.files.assets.files` 按条目的 offset/size 定位文件。提取的资源位于系统临时目录 `qone-codex-269281915-tools`，未将安装包代码复制进仓库。

## 已核对的源码

- `sites-end-resource-e2d7df4c9a5f.js`
  - `t_ / i_`：汇总容器 `flex min-w-0 max-w-full items-center truncate`，披露头支持开合和汇总切换。
  - `JD / ZD / nO`：区分 active、thinking、summary；运行时使用当前工具标签，完成后使用有序 summaryParts；汇总文本有 `block min-w-0 max-w-full flex-1 truncate`。
  - 工具组明细使用纵向 fade mask，`max-h-56`、`overflow-x-hidden overflow-y-auto`，渐隐距离 `1.5rem`。
- `app-primary-ce6eb321deed.js`
  - `zHe / KHe`：披露头 `inline-flex min-w-0 max-w-full`，图标与摘要分开；摘要 `min-w-0 flex-1 truncate`。
  - `PHe`：箭头默认透明，悬停、键盘焦点、展开时显示；展开旋转 90 度。
  - 披露按钮有 `aria-expanded`、可访问名称和 `focus-visible:ring-2`。
  - `MHe`：展开时做滚动锚定，本轮未改变 Qone 的滚动策略。
- `tool-activity-disclosure-d79714dd490d.js`
  - 折叠体测量高度，隐藏时有 `aria-hidden`、`inert`、`pointerEvents: none`。
- `app-shared-b42a855b3317.css`
  - `.truncate` 是 ellipsis/nowrap/overflow:hidden，**不是阴影**。
  - `.horizontal-scroll-fade-mask-eased`：渐隐距离 `1.5rem`，多段 alpha 蒙版；边缘状态依赖滚动进度；支持 RTL 反向。
  - 这证明该应用有横向边缘渐隐能力，但上述工具汇总分支直接使用的是 truncate，不能声称该分支已调用横向渐隐，或存在固定右侧 box-shadow。

## Qone 根因与补齐

1. `ToolTimeline` 触发器未限制最大宽度，`SwapLabel` 又按文本自然宽度测量并设定像素 width。长汇总撑出消息区域，展开箭头也被挤走。修复为触发器和根节点 `min-w-0 / max-w-full`，可收缩标签与不可收缩图标/统计分离。
2. 原 `FadeScroll` 只解决明细的纵向滚动，不解决标题横向溢出。新增共用 `OverflowFade`：用 ResizeObserver 同时观察可用宽度和自然文本宽度，只有真的被裁切才加边缘蒙版；短行不加蒙版。窗口/侧栏尺寸、流式内容、活动/完成标签变换都会重新计算。RO 回调复用已有尺寸，不逐帧读取布局；卸载断开观察。
3. 渐隐采用 Codex 共用 CSS 已取证的 eased alpha 与 `1.5rem` 距离，使用 mask 而不是写死背景色的遮盖层，支持主题和 RTL。**这是 Qone 在有宽度约束基础上补充的渐隐交互，不声称逐字复制了 Codex 工具条原始阴影。**
4. 原 target 生成在 56 字符处截断命令；工具组只保留前三个目标。移除这两个数据层截断，裁切交给真实容器尺寸。汇总/单项的 title 保留完整路径或命令，运行中与完成后均可查看。
5. 单工具行的操作词与目标放进同一个自然宽度文本层，避免长目标按 flex 比例把短操作词压成残影。图标、增删统计、状态图标、披露箭头位于蒙版外。
6. 复用现有 assistant-ui/Radix 折叠结构、SwapLabel、ShimmerLabel、MeasuredCollapse，不替换整套工具 UI。为披露按钮补键盘焦点样式，将 aria-controls 显式关联测量面板 ID；保持原有 aria-hidden/inert。
7. assistant-ui 官方 ToolGroup/ToolFallback 提供折叠原语和状态显示；本轮查询未找到可直接替代实际溢出渐隐的现成组件，因此仅新增共用文本边缘组件。

## 验证边界

新增测试覆盖短行/实际溢出、目标增长、容器 resize、隐藏后展开、观察清理、完整目标、超过三项目标、单工具统计、披露区域 ID 关联。

- 最后一次相关回归：8 个测试文件，27 pass / 0 fail，113 个断言。
- 最后一次 `bun x tsc --noEmit -p apps/desktop/tsconfig.json`：通过。
- `git diff --check`：通过。
- 整个桌面测试目录合跑曾返回 223 pass / 10 fail / 2 errors，涉及 compaction-flow、dock-browser-session 和 Lexical 模块初始化。独立重跑 compaction-flow（4 项）及 composer-tool-editor（10 项）均通过，说明不能把合跑结果标为全绿。未扩展到本轮工具条之外修改这些测试或浏览器生命周期实现。
- 知识图谱用 `graphify.watch._rebuild_code` 重建，遵守项目忽略配置。

不生成 exe 或安装包。静态渲染和尺寸桩测试不能代替实际 WebView 视觉验收；界面效果由用户启动开发环境确认。

## 工具标题状态与文案补查（2026-09-30）

同一 ASAR 的 `active-tool-activity-label-2105b6ba5d7a.js` 从后往前选最近的执行中项目，按已解析的命令类型给出 Reading / Searching / Listing / Running 等进行时标题；命令结束才改成 Ran。`sites-end-resource-e2d7df4c9a5f.js` 的 `ZD` 按 thinking / active / summary 分支渲染标题，完成分支将 `summaryParts` 组成自然语言摘要，失败的动态工具调用还有专门的 failed 文案。`tool-activity-disclosure-d79714dd490d.js` 在 status 为 running 时默认展开明细，完成后按完成态的开合状态显示，用户可分别切换。

Qone 对应修复：工具组运行标题跟随最后一个实际在执行的工具；仅有待执行项时选最后一个待执行项；这一组完成即切到完成摘要，不再受整个 assistant 消息的运行状态牵连。运行中命令使用进行时；失败操作不再计入“已编辑 / 已运行”摘要。活动组默认展开，完成后默认折叠，两种状态各自保留手动开合选择。取证是桌面包静态代码，交互视觉仍由开发环境验收。

### 工具已完成、模型仍在运行时的光波

`inline-followup-markdown-81008ccffed3.js` 的 `Ye` 用“最新可见活动组 + 整轮仍在进行 + 活动片段尚未关闭”决定是否继续显示动态标题。它从后往前找未完成的活动项；如果找不到，返回 `kind: thinking`。`sites-end-resource-e2d7df4c9a5f.js` 的 `ZD` 随后把 thinking 分支交给带光波的标题渲染。已完成的工具项仍保留完成态，光波由模型等待态承接。

Qone 此前在 `AgentPreparation` 中只要最后一个 part 是工具就压掉等待提示，工具返回后便出现既无活动工具光波、也无模型等待光波的空档。现改为仅在工具实际未结束时压掉等待提示；工具全结束但 assistant 消息仍运行时，在工具行后显示“正在思考”光波。文本开始、推理开始或整轮结束即撤下该提示。
