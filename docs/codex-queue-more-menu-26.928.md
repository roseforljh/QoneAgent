# Codex 26.928 等待队列“…”菜单

分析目标：`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。

ASAR SHA-256：`FB7B2EE791BCBDB3C4A6375E9FEC8FB404F3EAFF995F0D293227354B298AFF49`。只读静态提取，未执行安装包、Hook 或连接账号服务。

## 三个菜单项

| 顺序 | 菜单项 | 实际行为及显示条件 |
| --- | --- | --- |
| 1 | 编辑消息 | 从可投递队列取出消息，完整内容进入输入框。保存和取消使用消息身份及仍存在的前后邻项恢复位置。 |
| 2 | 在侧边聊天中打开 | 仅在提供侧聊创建回调时显示。转移消息到独立右侧聊天，继承历史作为参考，不切换或打断主会话。侧聊本身不再提供这个入口。 |
| 3 | 关闭排队／开启排队 | 根据 `followUpQueueMode` 动态切换，写入 `steer` 或 `queue`。默认 `queue`；遗留 `interrupt` 归一为 `steer`。仅影响后续运行中的输入，不移动已有队列。 |

投递中隐藏菜单；非 queued 状态禁用触发器。Qone 使用现有 Radix 菜单、统一 `.q-sidebar-menu` / `.q-sidebar-menu-item` 样式、项目内 Codex 编辑／侧聊／队列图标，以及 assistant-ui 队列和输入框原语。编辑态触发器禁用，转移态只显示进度。

图标追踪：队列资源导入 `tit as T` 和 `xrt as k`；在 `app-shared` 导出表中分别映射到 `A8n`（`pencil-light-16`）和 `I5n`（`plus-chat-bubble-right-light-16`）。排队开关的 `ke` 为同资源内的 20×20 queue SVG。英文文案按原始资源使用 `Turn off queueing` / `Turn on queueing`。

## 侧聊完整调用链

| 提取资源 | 锚点 | 证据 |
| --- | --- | --- |
| `queued-message-list-f05bbea78b04.js` | `QueuedMessageList`、`onOpenInSideChatMessage`、`isQueueingEnabled` | 菜单顺序、文案、回调存在性与投递状态限制。 |
| `app-primary-84ad97f06929.js` | `Int`、`onCreateSideConversation`、`queued_side_chat`、`followUpQueueMode` | 用转移票据传递原消息上下文、附件、运行配置；模式开关写入共享偏好。 |
| `app-initial-fd3c4b862660.js` | `yts`、`beginEdit`、`restoreEdit`、`transfer` | `remove → callback`；抛错或返回 null 时 `restore(ticket)`，保留原身份和位置。 |
| `local-conversation-thread-3c15e330d968.js` | `Jg`、`onCreateSideConversation` | 本地线程提供独立侧聊创建入口；侧聊或尚未创建的主线程没有该入口。 |
| `local-conversation-side-chat-1ba4a10a39ef.js` | `rn`、`zt`、`sideConversation`、`ephemeral`、`prepareConversation` | 默认右侧 pending tab；fork 原线程，同 cwd/workspace，`ephemeral: true`、`addForkedSyntheticItem: false`；附加侧聊授权边界并禁止子代理；创建后投递消息。 |
| `local-conversation-side-chat-tab-3bce9e9e66c8.js` | 侧聊 tab 生命周期 | 临时聊天关闭确认、停止侧聊与销毁缓存。 |

资源区偏移和每个资源 SHA-256 记录在 `work/codex-26-928-message-queue/evidence.json` 与 `more-actions-evidence.json`。复现命令：

```powershell
python work/codex-26-928-message-queue/extract_queue.py 'C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar'
python work/codex-26-928-message-queue/extract_more_actions.py 'C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar'
```

## Qone 对齐实现

- `composer-queue.tsx`：三个菜单、原有图标与统一菜单组件；编辑、转移恢复项按完整队列位置显示；侧聊队列复用同一组件并隐藏再次创建侧聊的入口。
- `run-options.ts` / `store.ts` / `App.tsx`：共享持久化排队偏好，提交时动态读取；发送按钮同步显示加入队列或引导。模型、思考和权限配置保持独立。
- `qone-message-queue.ts`：转移暂时退出投递通道，保留 scheduled 恢复副本；不占用编辑槽，不阻塞父会话后续投递；失败依 surviving anchors 恢复消息身份、附件和位置。
- `side-conversation.ts` / `SideConversationService`：独立请求和响应身份，不复用会切换主会话的 `session.created`。SQLite 事务一次完成历史快照、边界、子队列及父队列所有权转移；持久化转移标记防止重试或进程重启后的旧快照重复投递。
- `use-side-conversation-runtime.ts` / `side-conversation-panel.tsx`：按自己的 session 路由输入、草稿、队列、停止、工具和审批。保留原输入附件、继承模型／思考／权限选项；等待工作区和队列恢复完成后才允许提交。
- `workspace-dock.tsx`：复用右侧 tab、宽度调整及动画；关闭确认后等待运行时删除确认，只停止和删除侧聊。
- `pi-adapter.ts` / `skills.ts`：侧聊单独的资源加载器与授权边界，实际不注册子代理工具；父线程工具保持原行为。

Qone 使用本地 Pi / SQLite 的历史快照与队列事务实现上述行为。运行时断线会重试原转移身份；已创建的侧聊保留到明确关闭，以恢复异常中断时的消息所有权。没有实现 Codex 云环境的远程 fork 流程。

## 验证

队列、附件、草稿、组件静态渲染、转移事务、断线重试、迟到响应、父子隔离、侧聊工具边界及既有运行时桥接回归：133 项通过。前端和运行时 TypeScript 检查通过。

```powershell
bun test apps/desktop/test/queue-more-actions.test.ts apps/agent-runtime/test/side-conversation.test.ts
bun test apps/desktop/test/side-conversation-bridge.test.ts
bun test apps/desktop/test/chat-run-error.test.ts
bun test apps/agent-runtime/test/side-conversation-tools.test.ts
bun x tsc --noEmit -p apps/desktop/tsconfig.json
bun run --cwd apps/agent-runtime typecheck
```

未启动浏览器、Tauri 或打包安装程序。实际桌面交互由用户运行 `bun run --cwd apps/desktop tauri dev` 验收。
