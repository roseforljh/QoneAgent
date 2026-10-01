# Codex 26.928 等待队列：引导、编辑、删除

分析日期：2026-10-01。仅离线读取用户指定的 Codex 安装包；未修改安装目录、运行 Codex、连接账号服务或启动浏览器。

## 证据

- ASAR：`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。
- SHA-256：`FB7B2EE791BCBDB3C4A6375E9FEC8FB404F3EAFF995F0D293227354B298AFF49`。
- 索引头：`[4, 5738752, 5738748, 5738744]`；资源区始于 `8 + header_size`。
- 复现脚本：`work/codex-26-928-message-queue/extract_queue.py`；运行时传入上述 ASAR 路径。
- 原始资源路径及资源 SHA-256：`work/codex-26-928-message-queue/evidence.json`。

| 资源 | 可搜索锚点 | 结论 |
| --- | --- | --- |
| `webview/assets/queued-message-list-f05bbea78b04.js` | `QueuedMessageList`、`isEditing`、`submission.status`、`composer.queuedMessage.sendNowTooltip` | 引导的说明是“Submit without interrupting the model”；投递中的消息限制编辑、引导及删除。`outcome-unknown` 要求先核对对话，不能直接重试。 |
| `webview/assets/app-primary-84ad97f06929.js` | `function Unt`、`handleEditMessage`、`beginEdit`、`restoreEdit` | 编辑取得消息和 `previousMessageId`、`nextMessageId` 等位置票据；恢复完整输入上下文，支持撤销恢复队列。 |
| 同上 | `handleSendNowMessage`、`queuedMessageActions` | 队列“引导”走消息投递动作，不等同于打断当前模型。 |
| 同上 | `handleDeleteMessage`、`remove`、`restore` | 删除以消息身份为单位，返回可恢复票据；异步结果仍关联原消息。 |
| `webview/assets/app-shared-a906948d8868.js` | `thread-follower-steer-turn`、`outcome-unknown` | 当前轮次投递与未知结果有独立路径，不能把确认超时当作明确失败。 |

Qone 继续复用已安装的 assistant-ui `createMessageQueue`、`ComposerPrimitive.Queue`、`QueueItemPrimitive`。同时核对了组件库文档及固定版本源码；附件恢复复用项目已有的 `getDraftComposer` / `restoreDraft` 集成。

## 根因与修复

| 根因 | 修复后的行为 |
| --- | --- |
| 编辑只隐藏消息，并在它到达队首时暂停整个队列。 | 编辑消息暂时退出可发送队列；其他消息继续按顺序发送。保存和取消按仍存在的前后消息恢复位置，保留持久化身份。 |
| 先替换消息再异步读附件；失败时使用旧附件，或者发送空附件。 | 附件验证成功后才提交编辑。失败保留原消息及编辑草稿；主动移除的附件不会回来。未准备完整的输入不持久化为纯文字消息。 |
| 编辑通过逐个 `addAttachment` 重建附件，产生恢复期间的竞态并丢失原生文件信息。 | 一次恢复原附件对象，保留原生图片、文件、文件夹路径及引用信息，不重读或重建文件。 |
| 编辑标记在运行时退出时清空，恢复队列可能自动发送仍在编辑的原文。 | 保留各会话的编辑归属；重连恢复时先取出编辑项再放行队列。原文以 `scheduled` 状态保留恢复副本；整个应用重新启动且没有编辑草稿时，副本恢复为普通队列消息。 |
| 多条引导的前端附件准备和后端附件准备均可能交换顺序；每次放到引导列表最前方也会反转展示。 | 前后端分别串行处理同一会话的引导投递，引导列表按点击顺序展示。 |
| 异步准备后未检查原轮次是否结束，可能将输入留在空闲 Pi 会话或送到新轮次。 | 点击时固定目标 run ID；准备及入队后检查目标轮次，清理本轮遗留输入，不清理替代轮次的队列。 |
| 确认超时被当作失败；旧请求的迟到拒绝可以干扰新的尝试；回退固定插到队首。 | 超时维持待确认；依据确认事件移除或按原位置回退。每次尝试独立标识，忽略过期结果；确认回退后立即同步持久化。 |
| 删除仍在读附件的消息后，其准备锁和相邻消息的重复比较可能继续阻塞队列。 | 删除立即解除该消息的准备锁；失效的异步结果不能复活消息；不同文字或已删除的前项不再阻塞附件比较。 |
| 已投递消息的重复请求可能再次送入模型。 | 按 queue item ID 查验已投递用户消息及当前待投递项，避免重复入队。数据库按主键查验，不加载整段历史。 |

原输入框有其他草稿时仍阻止覆盖；本次没有新增 Codex 的全局撤销系统、拖拽排序或暂停队列设置。

## 引导即时显示和执行摘要顺序

再次直接读取安装包内的 `app-shared-a906948d8868.js`，核对其 SHA-256 与已有证据一致。`hon` 在发送 `turn/steer` 请求之前，先用 `Eue` 构造 `steeringUserMessage` 并插入当前 turn 的 items；请求成功后才将其状态设为 `accepted`。因此消息显示、服务端接受和模型实际消费是不同阶段。

Qone 的显式 `steerNow` 调用当前 run 的投递接口；新增 `use-steering-messages.ts` 订阅现有 assistant-ui 队列，在点击时把引导项显示成对话中的用户消息，输入框等待栏不再显示它。内部保留原身份和恢复位置，确认失败仍能恢复普通队列；正式历史按同一消息 ID 接替临时显示，避免重复消息。进行中的工具和文本保留在该引导消息之前。

截图中的错序还涉及三个独立条件：

- 已完成的前段回复可能只有工具记录，没有最终正文。执行摘要仍需置于工具列表上方，不能依赖最终正文是否存在。
- 当前流式段为空时必须传递 `parts: []`。传递 `undefined` 会启用旧消息的兼容逻辑，把同一个 run 的旧工具再次带入引导后的回复。
- 收到包含引导消息的正式历史时，同时清理该段流式状态和待刷新增量，避免先显示历史、再把旧流式块短暂显示到新用户消息之后。

本次补充修改涉及 `App.tsx`、`composer-queue.tsx`、`assistant-parts.tsx`、`execution-disclosure-state.ts`、`store-bridge.ts` 和 `use-steering-messages.ts`。新增测试覆盖点击后的即时显示、失败恢复、点击顺序、附件保留、身份去重、空流式段、历史接替和执行摘要的实际渲染顺序；结合原队列和运行时测试，共 101 项通过。前端和运行时类型检查均通过；本轮修改的 diff 格式检查通过。

## 修改位置

- 队列状态和附件准备：`apps/desktop/src/lib/qone-message-queue.ts`。
- 原子恢复和引用：`apps/desktop/src/lib/queue-composer-edit.ts`。
- 会话生命周期：`session-queue-lifecycle.ts`、`session-execution-state.ts`、`store-bridge.ts`。
- 提交与界面：`App.tsx`、`Thread.tsx`、`store.ts`、中英文文案。
- 后端目标轮次及顺序：`apps/agent-runtime/src/pi-adapter.ts`、`session-input-queue.ts`、`index.ts`。
- 已投递身份查询：`packages/database/src/repos.ts`。

## 验证

相关测试使用实际安装的 assistant-ui 外部运行时验证附件编辑和切换会话；Pi 投递顺序和轮次结束场景使用可控会话替身验证，不调用真实模型。

```powershell
bun test apps/desktop/test/qone-message-queue.test.ts apps/desktop/test/queue-actions.test.ts apps/desktop/test/queue-composer-edit.test.ts apps/desktop/test/composer-drafts.test.ts apps/desktop/test/file-attachment-adapter.test.ts apps/agent-runtime/test/message-queue.test.ts apps/agent-runtime/test/session-input-queue.test.ts apps/agent-runtime/test/pi-session-isolation.test.ts
bun x tsc --noEmit -p apps/desktop/tsconfig.json
bun run --cwd apps/agent-runtime typecheck
```

未启动浏览器、Tauri 界面或打包安装程序。实际桌面交互由用户运行 `bun run --cwd apps/desktop tauri dev` 验收。

前一轮验证结果：上述 8 个测试文件共 **70 项通过、0 项失败**；前端和运行时 TypeScript 检查均通过；当轮修改的 diff 格式检查通过。完整日志保留在本次 `work` 目录。本轮补充验证结果见“引导即时显示和执行摘要顺序”。

## 输入框与等待队列的布局对齐

静态依据为 Codex 26.928 同一安装包中的 `app-primary-547a6c7b4fb3.css`、`app-initial-e55cd978d577.css`、`app-shared-342447930c78.css`，以及 `app-primary-84ad97f06929.js` 的 `RGe`、`LGe`、`WGe`。已提取资源位于 `work/codex-input-link-26-928/extracted/`。

| 参考位置 | 本轮对齐结果 |
| --- | --- |
| attached rail 的 `--radius-2xl`、`--composer-rail-tuck`、单一伪元素外框 | 队列上方圆角 16px，向输入框后方嵌入 4px；输入框保持完整 24px 圆角。侧框不重复绘制，行间没有额外分隔线。 |
| `WGe` 的 `px-2.5 py-0.5`、28px 控件和 `leading-5` | 复用 Codex 图标，队列行左右 10px、上下 2px；正文行高 20px，操作按钮 28px。 |
| `QueuedMessageList` 的 `max-h-[30dvh]`、`gap-px`、`vertical-scroll-fade-mask` | 队列限制为窗口高度的 30%，隐藏滚动条；支持滚动时间线的 WebView 使用 CSS 渐隐溢出边缘，不增加滚动监听器。 |
| `_ComposerLayout*` 的空附件区 padding、输入最小高度、footer 间距 | 空附件区保留 8px 顶部和 6px 底部留白；输入最小高度 44px、水平 padding 12px、行高 20px；footer 与输入间距 4px，左右和底部 padding 8px。 |
| `--elevation-composer`、`--elevation-composer-dark` | 浅色使用完整三层阴影，窄窗口收窄模糊范围；深色按应用主题使用内阴影。拖入反馈通过 inset outline 保留，不改变布局尺寸。 |

队列视图拆分为 `composer-queue.tsx` 和 `composer-queue-icons.tsx`，仍复用 `ComposerPrimitive.Queue` 和 `QueueItemPrimitive`。编辑恢复行只显示一次；保存或取消后，实际状态为普通队列项时撤下恢复行，防止旧编辑标记造成重复。删除编辑项会清除其草稿。

布局依据 `QueueBundle.getSnapshot()` 中包含编辑、引导、转移状态的完整持久化顺序，将每个恢复行放到下一个可见项之前。不能用初始编辑位置，也不能将总隐藏项数量直接从索引中减去：隐藏项可能在恢复行后面，多条转移也会同时占据恢复位置。混合状态以相同规则处理。

队列缩略图和输入框附件共用 `useAttachmentPreviewSrc`，复用原生路径授权、预览缓存和 object URL 回收。仅附件的消息显示文件名，避免空白队列行。引导消息在对话尚未接替显示时保留锁定状态；同一身份出现在对话后退出等待栏。

本轮修改位置：`Thread.tsx`、`composer-queue.tsx`、`composer-queue-icons.tsx`、`composer-queue.css`、`elements/attachment.aui.tsx`、`hooks/use-attachment-src.ts`、`lib/qone-message-queue.ts`。新增 `composer-queue-view.test.tsx` 中的 13 项实际 assistant-ui 组件静态渲染测试，覆盖首/中/尾/唯一项编辑、邻居删除和引导、保存/取消旧标记、空栏、附件、部分引导接替显示、编辑与多条转移并存。静态渲染每次创建运行时，不能证明持续挂载时的队列刷新。测试不调用模型、不启动浏览器。CSS 通过 PostCSS 语法解析；桌面实际像素和交互验收留给用户运行 `bun run --cwd apps/desktop tauri dev`。

布局补充验证结果：`composer-queue-view`、队列/附件/草稿测试、引导消息和执行摘要测试、消息转换与历史接替测试，以及运行时输入队列和会话隔离测试，共 13 个文件、124 项通过、0 项失败。完整日志：`work/codex-26-928-message-queue/queue-ui-tests.log`。合跑时还修正了 `chat-run-error.test.ts` 的 Tauri 模块替身：保留原导出，仅替换 IPC，避免破坏真实组件的预览导入。CSS 的 PostCSS 语法解析和 diff 格式检查通过；图谱已按最新代码增量更新。

布局补充最终类型检查：桌面 `bun x tsc --noEmit -p apps/desktop/tsconfig.json` 与运行时 `bun run --cwd apps/agent-runtime typecheck` 均 exit 0；日志分别为 `desktop-typecheck.log` 和 `runtime-typecheck.log`。未启动浏览器、未生成安装程序。

## 首次提交刷新缺失与截图差异的修正

用户提供的 `Snipaste_2026-10-01_10-46-47.png` 和 `Snipaste_2026-10-01_10-47-08.png` 显示：参考队列两侧内缩、背景与输入框分层；Qone 的队列与输入框等宽、同色。此前遗漏了这两个样式条件，也没有验证持续使用同一个运行时的首次提交。

“多次输入才进入队列”的复现：固定同一个实际 assistant-ui `ExternalStoreRuntimeCore` / `AssistantRuntimeImpl`，通过 composer 发送第一条文字，在 `sync` 不产生任何 IPC 回包时，本地 `adapter.items` 已有该消息，但 composer 订阅者最后收到的队列仍为空。修复前新增测试明确失败：期望 `["first input"]`，实际 `[]`。

根因是 React 集成只订阅 `steerItems`。普通入队、删除和编辑改变的是 `items`，不会改变 `steerItems` 的引用，因此不会重新发布外部运行时。assistant-ui 的队列 adapter 没有自行订阅 controller 的接口；运行时在 React 更新 adapter 时才通知 composer。

`use-message-queue-adapter.ts` 统一订阅现有 controller，并以两个通道数组组成稳定、不可变的 adapter 快照。主对话与侧边对话都传入该快照，引导消息也读取同一快照。两数组均未变化时保留快照引用，避免忙碌状态通知引起无用更新；会话切换更换订阅。刷新不依赖额外输入、持久化回包、定时器或内部通知 API。

新增 `queue-runtime-refresh.test.ts` 的 8 项验证始终保留运行时实例，覆盖第一次提交、连续提交与删除、编辑保存/取消、引导及明确失败回退、会话切换、多个视图共享队列、附件准备前显示与删除后迟到结果、快照引用稳定。原静态组件测试也改为使用同一个生产 hook。

样式的静态依据：

- `app-primary-547a6c7b4fb3.css` 的 `_rail_1hrlq_1` 使用 `margin-inline:var(--home-composer-inline-inset)`；`app-shared-342447930c78.css` 定义该变量为 `calc(var(--spacing) * 3.25)`，标准 spacing 下为 13 CSS px。Qone 使用相同相对间距，移除 `width:100%`，依靠 flex 拉伸扣除两侧 margin，避免溢出。
- `app-primary-84ad97f06929.js` 中 rail 默认使用 `bg-surface-elevated-secondary`；桌面主题映射为不透明控件背景。输入框的 `--color-background-composer-surface` 映射为不透明 elevated primary。Qone 已有 `--muted` 和 `--q-surface` 分别对应这两个主题角色，现分别用于队列与输入框。此前输入框也错误使用了 `--muted`。这些颜色继续由现有浅色、深色和对比度设置计算，没有写死截图中的颜色。
- 公共 shell 自带背景、圆角变量，侧边输入框也能使用相同表面层次。

本次运行共 16 个相关测试文件、135 项通过、0 项失败；桌面 TypeScript 检查通过，队列 CSS 的 PostCSS 解析通过。该结果包括新增首次提交回归测试，不能用此前的静态渲染结果替代。没有启动浏览器、Tauri 界面或生成安装程序；桌面像素和实际交互仍由用户运行开发模式验收。
