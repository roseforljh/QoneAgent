# Qone 子代理完整能力实施记录

## 目标

将 Qone 当前的“一次性并行委派”升级为可观察、可恢复、可编排的子代理运行框架，同时保留 Qone 的 SQLite、NDJSON protocol、PiAdapter 和 assistant-ui 渲染链路。

## 已确认的产品选择

- 子代理详情页保持只读，不提供用户直接向子代理输入的 Composer。
- 主 Agent 需要能够查询运行中的子代理内容，并根据状态继续管理子代理。
- 子代理需要能够继承主 Agent 的上下文；默认采用可控的上下文快照，避免无限复制历史。
- 支持子代理嵌套和 workflow/chain/dependency。
- 并发上限、超时、token 预算、重试等运行参数放在“设置 → 子代理”，界面提供推荐默认值。
- 继续使用 assistant-ui 的 `ReadonlyThreadProvider`、现有 tool timeline 和 Qone 右侧 Dock。

## 当前基线

当前 runtime 通过 `dispatch_subagent` 创建独立 run 和临时 Pi session。子代理事件进入 Qone 事件总线，`subagent_runs.parts` 保存执行过程，前端通过 `SubagentRunInfo` 显示列表和详情。执行完成后 session 会被释放，主 Agent 只能拿到最终文本。

## 实施范围

### Runtime

- 保存长期的子代理 session identity。
- 支持上下文快照、子代理嵌套、workflow、chain、dependency。
- 增加子代理状态查询、follow-up、steer、stop、resume、retry。
- 增加独立超时、重试、并发、token 预算和成本统计。
- runtime 重启后恢复可恢复的子代理记录，无法恢复的记录明确标记。

### Protocol / Database

- 扩展子代理运行树、控制命令、状态快照和 usage 字段。
- 保存多轮 child messages、上下文来源、workflow 节点和生命周期事件。
- 保持旧数据库记录可读取，新增字段使用默认值。

### Desktop

- 子代理列表和详情保持只读。
- 保持主聊天胶囊和右侧 Dock 入口。
- 设置页增加子代理配置：并发、超时、预算、重试、上下文、嵌套和后台策略。
- 设置页区分“临时代理”和用户创建的子代理；临时代理可单独选择驱动模型，主 Agent 通过 `dispatch_subagent` 创建临时代理时优先使用该模型，选择“跟随主模型”时沿用当前主 Agent 模型。
- 主 Agent 的运行状态由 protocol 事件和查询结果驱动，不改变主聊天滚动和 Composer。

## 验证要求

- 运行现有 agent-runtime 测试和新增子代理运行树、上下文、控制、恢复测试。
- 运行 protocol/database 类型检查。
- 运行 desktop TypeScript 检查和生产构建。
- 使用 `git diff --check` 检查格式。
- 不启动浏览器验收，不提交，不推送。

## 交付顺序

1. 先扩展数据模型和 protocol，保留旧字段兼容。
2. 再改 runtime 的 session、事件和控制逻辑。
3. 再接入设置页和只读状态展示。
4. 最后运行定向测试、类型检查和生产构建。

## 当前完成状态

- Protocol 和 SQLite 已支持独立 run、父子关系、execution session、workflow 依赖、上下文策略、usage、重试和多轮 messages；旧数据库会自动补列。
- Runtime 已支持并发 dispatch、后台运行、超时、预算停止、自动重试、stop/resume/retry/steer/follow-up、嵌套子代理和依赖步骤并行执行。
- 子代理详情通过 `ReadonlyThreadProvider`、`ThreadPrimitive.Messages`、现有 assistant parts 和 tool timeline 渲染，详情页保持只读。
- 子代理消息、工具 parts、最终结果和 profile 权限/工具白名单会保存在 SQLite；runtime 重启时按 execution session 恢复文本 transcript。
- Desktop 已提供主聊天胶囊、右侧 Dock 列表/详情、关闭和返回，以及“设置 → 子代理 → 运行策略”。

## 严格审查后的修复记录

- 主聊天不再把 `dispatch_subagent` 的 nested messages 注入主消息；主页面只显示子代理胶囊，完整过程只在右侧 Dock 详情页显示。
- 每个新子代理回合先持久化一条 user message；Pi 完成事件会去重；retry 不重复写入 user message；follow-up 会保留独立 user/assistant 回合。
- `wait_subagent` 未传 timeout 时读取“设置 → 子代理”的 timeout，而不是固定 30 秒。
- Pi 原始 transcript 恢复只接受合法 Pi message role，避免把任意 payload 写入 Pi session。
- 增加了初始回合、多回合持久化和并发调度 FIFO 测试。
- 子代理设置页将“运行策略”收纳为独立按钮，点击后进入单独配置页；数值输入缩小并统一间距，嵌套和后台运行改为卡片式开关。
- 胶囊放入最新 assistant 的 `MessagePrimitive.Root` 内部，避开 assistant-ui 顶部锚点预留空间被推到 Composer 上方的问题。
- 胶囊现在区分总数、运行中和排队数；最大并发只限制同时执行数量，不限制会话内累计创建数量。
- `dispatch_subagent` 明确要求按用户要求逐任务调用，后续回合继续调用，不默认限制为三个；完成任务会释放并发许可，超出部分进入 FIFO 队列。
- `session.subagents` 快照与实时 `subagent.updated` 合并，避免旧列表响应覆盖刚创建的子代理。

## 已完成验证

- `bun test apps/agent-runtime/test`：100 pass。
- `bun run --cwd apps/agent-runtime typecheck`：通过。
- `bun run --cwd apps/desktop build`：通过；仅有依赖注释和 chunk size 警告，无构建错误。
- `bun test apps/agent-runtime/test/subagents.test.ts apps/desktop/test/subagent-messages.test.ts`：9 pass。
- `git diff --check`：通过；仅有 Git 的 CRLF 提示。
- `packages/protocol` 和 `packages/database` 当前没有独立 `typecheck` script，已由 runtime typecheck 和 desktop build 间接检查。

## 临时代理显式路由修复

- `dispatch_subagent` 和 `run_subagent_workflow` 的步骤均支持 `capability: "temporary"`，明确选择设置里的临时通用代理；没有单独配置模型时继续使用既有跟随主模型规则。
- `list_subagents` 的临时代理、媒体能力与保存的 profile 均返回可直接用于调用的 `selection`，避免主模型从媒体枚举里猜选项。
- 保留旧调用兼容：省略或传 `null` 的 capability 且没有 profile 时仍使用临时代理；保存的 profile 使用 `subagentId`，capability 省略或为 `null`。
- 显式 capability 与非空 profile ID 不能混用；未知目标、不可用 profile 和未配置媒体能力在创建子运行前报错。工作流预先校验所有步骤，避免无效选择留下已启动的独立步骤。
- `temporary` 只是委派目标，不新增媒体能力或持久化 profile，也不根据任务关键词自动改选目标。
- 回归覆盖设置模型变更、主模型回退、原始附件引用、五种媒体路由、profile、工作流，以及 Responses/Codex Responses 实际工具请求参数。网关要求填写全部参数时，可使用 `temporary` 和中性的 `null` profile 值，不再被迫选择媒体能力。
- 本修复不处理模型提供商返回的 404，也不自动重试或更改用户配置的模型。

## 运行边界

- 子代理详情页按产品要求只读；主 Agent 通过 `inspect_subagent`、`wait_subagent` 和 `control_subagent` 查询或管理子代理。
- Pi 原生 transcript 的工具消息由 Qone 的 `parts` 和 `subagent_messages` 重建，重启恢复的是 Qone 持久化的可观察执行过程。
