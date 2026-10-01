# Run 文件变更摘要

## Codex 静态对照：执行行与完成卡片

本轮读取当前安装的 `OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0/app/resources/app.asar`，目标资源为 `webview/assets/sites-end-resource-cff1c624fbb8.js`。这是静态源码证据，没有启动浏览器或修改安装包。

- 执行文件行：状态按 `add/delete/update` 派生 Created/Deleted/Edited。头部的点击处理器切换行内 Diff，增删数字处于这个头部内，点击也切换 Diff。`_S` 文件链接调用 `stopPropagation()` 后经 `Pu({path,cwd,openInSidePanel:!modifiedClick})` 打开文件，独立于 Diff。未展开且有增删行的新增文件显示蓝点。`app-initial-fd3c4b862660.js` 导出的 `ogt`（函数 `RXi`）负责统计：`agent-activity` 模式通过 `group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header` 在行悬停时分别显示新增/删除颜色，文件链接悬停时不改变统计颜色。Qone 复用现有新增/删除主题颜色，并对统计按钮的键盘聚焦提供相同反馈。
- 运行中的变更汇总 `TE`：文件数量与总增删数组成可点击入口，调用 `mu(scope,{conversationId,path})` 打开 Changes；这与工具执行行是两种组件。
- 完成卡片 `DE`：`lu` 资源卡片加 `Ys` 标题。单文件标题 `Edited {filename}`，多文件标题 `Edited # files`；副标题默认是总增删数，悬停或聚焦显示 View changes。`jE` 覆盖入口与 `AE` 按钮打开 Changes。多文件 `NE/PE` 明细不重复操作状态词，普通点击选择该文件的变更，修饰键点击可打开源文件。源码标题片段在字符偏移约 267000，卡片与明细片段在约 272000–275833。

Qone 复用现有 ToolCall/Radix disclosure、MeasuredCollapse、DiffViewer 和工作区侧栏；assistant-ui 已安装组件中没有直接承担保存任务变更卡片与侧栏数据的组件。按照用户最新要求，所有位置的增删统计常态显示新增绿色、删除红色，包含零值；执行行、完成卡片与变更侧栏共用 ChangeCounts，不再区分淡色与悬停着色模式。执行行保留点状下划线文件名；完成卡片使用独立标题、统计和文件明细。长明细通过有界滚动显示，没有照抄 Codex 固定显示前三个文件的策略，也没有接入撤销或重新应用动作。

执行过程使用同一套文件证据，但分成两个层次：`SessionTimeline` 的工具行展示单个工具活动，`RunFileChangesSummary` 在输入框上方展示当前 `activeRunId` 的本轮净变更。摘要只从该 run 的 ToolCall 和 assistant parts 派生，并且仅在运行时 `running` 为真且存在 `activeRunId` 时显示；运行结束后 `running` 变为假或 `activeRunId` 清空即卸载，不会把历史 run 合并到当前摘要。结构化多文件结果拆成多个文件行；编辑参数已经生成但工具尚未结束时显示预览；工具完成后才使用 `details.fileChanges` 的真实旧新内容。状态和统计数字是同一 disclosure 的两个独立按钮；文件名独立打开源文件。失败操作保留失败状态并隐藏已应用差异。组顶部统计复用净变更计算，限定在该组工具，不再取最后一个工具的统计。

## 数据链路

- Qone 的 `file-change-tools.ts` 使用 Pi SDK 的 `operations` 扩展点，在 SDK 自己的文件修改队列内捕获 edit / write 的真实内容。没有修改 Pi 核心，也没有扫描工作区或累计 Git working tree。
- 证据放入既有工具结果 `details.fileChanges`，沿现有 ToolCallRepo 和 assistant parts 存储、恢复。大于 20,000 字符时保留结构化变更证据，避免把 JSON 截成不可解析的字符串。
- 前端从当前消息所属 `runId` 的工具结果派生完成卡片，从当前 `activeRunId` 的工具结果派生 `RunFileChangesSummary` 执行中摘要，没有新增全局累计状态或独立数据库表。同一路径只出现一次；完整内容证据以首次 oldContent 和最后 newContent 计算净 diff，撤销回原内容的文件不显示。
- 执行中摘要挂在 composer 上方，只属于当前 run；不会读取最后一个工具、最后一条消息或整个 session 作为回退来源。Run 完成后摘要卸载，改由该 Run 最后一条 assistant 消息末尾挂载完成卡片。
- 完成后显示变更卡片。标题、总增删数、查看变更按钮和文件明细都打开该 Run 保存的变更面板；点击明细中的数字同样选择该文件。卡片明细中的 Ctrl/Meta 点击可打开工作区内源文件；无法打开源文件时仍可查看保存的 Diff。
- 变更面板使用独立 `changes` 标签页，与读取实时 Git 工作树的 `git` 标签页分开。同一会话/Run 重用标签页，不同任务独立；点击指定文件会更新选择。已删除、工作区外或没有工作区的文件都能显示已保存证据，不要求源文件仍存在。

## 其他修改工具的统一证据约定

任何 patch / apply_patch / replace / 插件 / MCP 工具都可以返回下面的结构，不需要在摘要组件里追加工具名称名单。只能在工具真正修改文件后发布，不能将 read-only Git diff 当作修改证据。

```ts
{
  content: [{ type: "text", text: "Files updated" }],
  details: {
    fileChanges: [
      { path: "/absolute/A.ts", oldContent: "before\n", newContent: "after\n" },
      { path: "/absolute/B.ts", oldContent: null, newContent: "created\n" },
      { path: "/absolute/C.ts", oldContent: "deleted\n", newContent: null }
    ]
  }
}
```

`null` 表示不存在，空字符串表示空文件。推荐提交规范化的绝对路径。工具如果只提供统一 patch，可以发布 `{ path, patch }`；此时保留实际 patch，若先前已有完整内容则应用到该内容上形成净 diff，否则按已知 patch 增量统计和查看，不伪造缺失的整文件内容。

## 历史兼容与范围

新产生的 edit / write 数据可完整恢复摘要、净统计与 Diff Viewer。旧会话的已保存 Pi edit patch 可恢复文件列表和已知差异；旧 write 没有覆盖前的内容，不猜测为全新增。不从自然语言、工具名或 shell 命令文本推测成功修改；未发布结构化证据的任意 shell / 外部工具修改不计入摘要。不存在可用证据时不显示组件。

## 验证

数据测试覆盖 A → B → A、Run 隔离、撤销、覆盖写入、创建/删除空文件、跨消息恢复和失败但已经写盘的证据。组件测试覆盖完成卡片和执行行结构；导航测试覆盖标签页重用、会话/Run 隔离、指定文件选择与组净统计。终端虚拟 DOM 点击自检实际点击状态、统计和文件名，验证展开互不串扰、卡片发送保存变更请求、修饰键源文件导航、面板切换选择以及旧新 Diff 内容。未启动浏览器或打包安装程序。
