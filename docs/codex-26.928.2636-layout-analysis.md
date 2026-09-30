# Codex 26.928.2636 三栏布局与拖拽分析

样本：`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar`

ASAR SHA-256：`FB7B2EE791BCBDB3C4A6375E9FEC8FB404F3EAFF995F0D293227354B298AFF49`。
本次离线读取 JavaScript/CSS，没有执行目标代码、修改安装目录或启动浏览器。

## 可复核证据

资源位于 `work/codex-layout-navigation/evidence/codex-26.928.2636/`。
`extract-layout-evidence.mjs` 用 TypeScript AST 提取了 12 个相关函数；`layout-functions/manifest.json` 记录源文件 SHA-256 和 UTF-16 字符偏移，可重新生成核对。函数文件仅供阅读，不是可直接运行的源码。

| 行为 | 原始证据 | 规则 |
| --- | --- | --- |
| 左栏正常尺寸 | `DS`、`OIt`、`kIt`、`fqr` | 普通模式默认 340px、最小 240px、最大 520px；以整个 shell 宽度计算并预留 240px；保存像素宽度 |
| 左栏关闭 | `SS`、`fqr.setSize`，初始化 `bIt=.5` | 原始拖动宽度低于最小值一半时关闭，达到阈值重新打开；普通模式阈值 120px |
| 其他左栏模式 | 主 bundle 的 `leftPanelSlot` 调用方 | 上下文导航模式可覆盖最小宽度为 290px，并保留 navigation rail；该模式的关闭阈值为 145px。Qone 当前对应普通侧栏，没有添加此产品导航模式 |
| 左栏内容排版 | `fqr`、`Pqr`、CSS `._LeftPanel_bo1ta_2` | 内容框使用正常 `width/minWidth`，外框使用收起进度计算的宽度，通过 overflow 裁切；不会在收起时切成图标布局 |
| 右栏正常尺寸 | `Gjt`、`Kjt`，bundle 的 `Ujt/Wjt/Hjt` | 最小 320px；regular 分栏预留主区 352px，unified 模式预留 320px；右栏保存边界区间内的比例 |
| 右栏关闭 | `d2r` 的 `allowPointerOverflow:true` 与 `setSize` | 原始宽度低于 160px 时关闭，达到 160px 重新打开 |
| 右栏全宽 | `d2r.setSize` | 超过分栏最大宽度，且主区剩余不足 160px 时进入全宽；同次拖拽反向可回到分栏 |
| 全宽是否收左栏 | `SPn`、`zIt` | 取决于标签能力、singleTab 和 compact-full-width 策略，不是任意右栏进入全宽都关闭左栏；Qone 沿用当前普通标签模式 |
| 拖拽生命周期 | `awr` | 起始位置与起始尺寸计算原始差值，除以窗口缩放；window 监听 move/up/cancel/lost capture；校验 pointerId，结束才持久化；取消使用最后尺寸 |
| 导航刻度显示 | `thread-user-message-navigation-rail-app` 的 `Qt/Pt` 与 `floating-navigation-rail-layout` 的 `h` | 少于 4 个用户消息项不显示；内容左侧空间至少 48 CSS px；按 rectWidth/offsetWidth 消除缩放影响；观察容器与内容尺寸/布局变化 |

## Qone 根因与修复

此前把原始宽度提前 clamp 到最小值，关闭条件无法触发；左右栏互相扣宽并恢复比例还会形成尺寸反馈。左栏本应保存像素，上轮报告写成保存比例，现已纠正。

- `sidebar-layout.ts`：尺寸和关闭阈值对应普通 Codex 左栏；新像素存储键不会把旧比例当像素；缺失存储不会再由 `Number(null)` 变为零。
- `resizable-sidebar.tsx` / `pane-layout.css`：侧栏关闭到 0，内容保持正常宽度并裁切；展开按钮移到聊天标题栏；整个 shell 约束左栏，右栏不反过来改变左栏偏好。
- `pane-pointer-resize.ts` / `use-pane-resize.ts`：两侧共享 window 拖拽，保留原始越界尺寸。关闭与全宽期间保留拖拽句柄和监听，同次拖拽可反向恢复；拖动只写内存，结束才保存，卸载清理不保存未完成尺寸。
- `project-section.tsx`：项目/会话行从 `layout` 改为 `layout="position"`，保留位置动画并取消宽度变化引发的文字缩放补间。拖拽期间暂停悬停跑马灯，收起时不改变内容结构。
- `workspace-dock.tsx` / `dock-layout.ts`：低于 160px 关闭、另一方向进入全宽；保留 tabs 与终端资源；实际观察左栏宽度变化来更新右栏可用空间。外框与内容裁切框分开，使用样本里的 spring 参数完成收起。
- `conversation-map.aui.tsx` / `conversation-rail-layout.ts`：以 48 CSS px 的固定内容列留白判断显示，观察实际内容列与消息列表；空间不足时卸载导航及预览。后续核实发现仅改阈值不足以修复，具体见下面的导航补充。

继续复用 assistant-ui 的会话、视口和侧栏项能力；安装的组件库没有对应的桌面三栏拖拽组件，因此仅新增小型公共拖拽机制，没有新增依赖。

## 验证与范围

TypeScript 检查通过；6 个相关 Bun 测试文件共 19 项通过、95 个断言、0 失败；git diff --check 通过。测试覆盖：左右阈值、同次拖拽恢复、全宽返回分栏、只在结束保存、缩放、多指针、cancel/lost capture、卸载清理、存储异常、侧栏收起内容结构、导航留白、会话滚动恢复。

本记录确认已定位规则与实现对齐，不把静态代码验证当作视觉验收。未启动浏览器、Tauri 开发窗口或构建安装包；实际鼠标手感与界面外观由用户在 tauri dev 中验收。

## 会话导航显示与关闭：补充核实

针对 `Snipaste_2026-10-01_05-42-58.png` 中圈出的刻度条和预览，进一步追踪了完整组件及其公共 Tooltip。`extract-navigation-evidence.mjs` 提取 10 个函数，`navigation-functions/manifest.json` 保存每个来源的 SHA-256 与 UTF-16 偏移。没有执行样本。

| 对象 | 可复核函数 | 实际规则 |
| --- | --- | --- |
| 外层导航入口 | `bookmarked-thread-user-message-navigation` / `C` | `enabled=false` 时不挂载；首次先通过 idle callback（最长等待 2000ms）或 setTimeout(0) 延迟初始化。会话调用方还受历史可用状态控制；Qone 使用现有会话加载完成后挂载的入口 |
| 刻度条 | `Qt` / `kt` | 少于 4 条用户消息不显示 |
| 刻度条空间 | `Pt` / `h` | 测 `[data-thread-user-message-navigation-content]` 的固定内容列与滚动区左沿，留白至少 48 CSS px；没有空间时 return null。不是测当前用户气泡，也不是按滚到哪条消息决定显隐 |
| 刻度条位置 | `Pt` / `At` | portal 挂在滚动区父节点，不占滚动内容位置；首次显示淡入 150ms。已追踪的组件没有滚动停止或闲置后自动隐藏的逻辑 |
| 预览打开 | `At` / `Pli` | hover 通过公共 Tooltip 的 delayOpen 等待 250ms；点击、聚焦、开始拖动刻度可立即打开。`At` 中 150ms 的 timer 用于预加载详情，不能当成预览显示延迟 |
| 预览离开 | `Pli` / `wli` / `D5` | 交互式预览使用安全三角与 100ms 离开宽限；允许从刻度进入卡片操作书签；离开交互区域时关闭 |
| 预览拖动 | `At` | 拖动中更新预览目标，保持打开；在列表外松手时清除预览；拖动造成的尾随 click 被抑制 |
| 全局关闭 | `Nli` / `Pli` | Esc、窗口失焦、显式 dismiss、触发器失焦到卡片之外等会关闭或取消待打开的预览；provider 还有同类 tooltip 的 300ms 免等待切换窗口 |

Qone 本轮根因修复：

- `Thread.tsx`：使用现有 `q-thread-content` 宽度建立不占位置的固定测量列，不依赖右对齐气泡或旧消息的 content-visibility。
- `conversation-map.aui.tsx`：之前仅设 invisible，body portal 中的预览不会随之隐藏；现在空间不足直接卸载，校验测量所属视口、会话与侧边，避免旧测量用于新会话。之前观察 viewport.firstElementChild 会观察到导航自身，现观察固定列和真实消息列表。导航 portal 挂在滚动区父节点，显隐不再增减 flex gap。
- `conversation-map.tsx`：继续复用已安装的 Base UI PreviewCard、安全区域和 Esc/outside dismiss，调整打开/离开延迟，补齐立即打开、拖动目标更新、列表外松手、窗口失焦和会话切换的生命周期。Base UI 的 Popup 原生离开关闭仅处理 hover-open，主动打开后从卡片离开的路径额外使用同一 100ms 宽限；返回刻度或卡片会取消关闭。卡片键盘失焦也关闭。

这里对齐的是可核实的显示条件及交互生命周期；没有移植 Codex 的全局 Tooltip provider、历史分页产品模式和全局 300ms tooltip 切换策略。未据此新增“滚动后隐藏”规则。

补充验证：TypeScript 检查通过；导航空间、导航静态渲染、自动滚动及会话滚动恢复 4 个测试文件共 15 项通过、66 个断言、0 失败；git diff --check 通过。测试验证固定列测量、缩放、左右留白边界、无内容时隐藏、4 项门槛和初始预览关闭，以及现有滚动逻辑。没有把静态渲染测试当成鼠标交互测试；悬停安全区域、失焦及实际拖动手感尚待用户在开发模式验收。

## 同次拖动关闭后重新展开的动画

Qone 原实现左栏使用 `dragging && !collapsed`、右栏使用 `dragging && view && !maximized` 将整个宽度动画设为零时长。关闭时条件不成立，动画正常；反向展开后条件立刻成立，因此直接从 0 跳到最小宽度。仅在越过阈值的一帧启用动画也不足够，后续 pointermove 仍可能打断过渡。

样本 `fqr` 的宽度与 `BS` 开合进度分离，`IIt/LIt` 只在开合状态变化时更新进度；右栏 `d2r` 通过 `Tqr` 将 `GS` 进度与内容宽度相乘；`gIt(size, progress, closedSize)` 对进度 clamp 到 0..1 后插值。拖动更新内容尺寸不会把开合进度设为 1。

修复：新增公共 `pane-motion.ts` / `use-pane-motion.ts`，由 MotionValue 独立保存内容宽度和开合进度，显示宽度为 `size * clamp(progress, 0, 1)`。左右组件使用相同机制；宽度更新只影响尺寸，开合变化才驱动进度，拖动中反向恢复保留动画。继续采用项目已有 spring 参数与减少动态效果设置；右栏保留正常打开、全宽尺寸变化的过渡以及关闭完成后的隐藏行为。

验证：TypeScript 通过；5 个相关测试文件共 17 项通过、101 个断言、0 失败；git diff --check 通过。新增测试使用实际 Motion 引擎和可控时钟，覆盖左右关闭后持续反向展开、后续指针移动不中断动画、动画途中反向、减少动态效果及进度越界；未启动浏览器或构建安装包。
