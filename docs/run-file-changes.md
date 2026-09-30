# Run 文件变更摘要

## 数据链路

- Qone 的 `file-change-tools.ts` 使用 Pi SDK 的 `operations` 扩展点，在 SDK 自己的文件修改队列内捕获 edit / write 的真实内容。没有修改 Pi 核心，也没有扫描工作区或累计 Git working tree。
- 证据放入既有工具结果 `details.fileChanges`，沿现有 ToolCallRepo 和 assistant parts 存储、恢复。大于 20,000 字符时保留结构化变更证据，避免把 JSON 截成不可解析的字符串。
- 前端从当前消息所属 `runId` 的工具结果派生摘要，没有新增全局累计状态或独立数据库表。同一路径只出现一次；完整内容证据以首次 oldContent 和最后 newContent 计算净 diff，撤销回原内容的文件不显示。
- 仅在 Run completed 后、该 Run 最后一条 assistant 消息末尾挂载。活动过程、streaming 和 Tool Timeline 不挂载摘要。
- File Tree 参考 assistant-ui Elements 的扁平 `path/name/depth/kind/additions/deletions` 节点与总数结构，改为默认收起的单行；文件列表有高度限制。点击行以 Dialog 打开现有 Diff Viewer，只向 Viewer 提交变化 hunks。

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

覆盖 A → B → A、Run 隔离、撤销、覆盖写入、创建/删除空文件、跨消息恢复、并发 SDK 编辑、权限拒绝、失败但已经写盘的证据、跨工具多文件结果、大结果持久化与 compact 默认展示。验收无需启动浏览器或打包安装程序。
