# Codex 上下文压缩条目的位置

- 分析目标：本机 `C:\Program Files\WindowsApps\OpenAI.Codex_26.928.1915.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。
- SHA-256：`86729CD40329FE33B668E0C76BDD405B93EA50DC8A1D30B939524D5DFA783E06`。
- 方法：使用 Node 文件 API 解析 ASAR 索引，只读提取 JS 片段；未启动浏览器、修改安装包或连接服务。本结论针对 Codex 桌面包，不代表另行验证了 ChatGPT 网页端。

## 官方实现证据

`webview/assets/app-shared-6472dfc83b38.js`：

1. `item/started` 分支将 `contextCompaction` 转成带 `completed:!1`、`startedAtMs` 和 `source` 的条目，再通过 `Um(r,d)` 写入本轮有序条目。
2. 显示数据转换的 `case contextCompaction` 在遍历条目时执行 `w.push({type:context-compaction,id:n.id,status:...,startedAtMs:...,source:r})`。位置由条目顺序决定，不由用户消息锚点决定。
3. 手动压缩有独立 pending synthetic item；正式条目到达后移除 pending 条目。

`webview/assets/agent-activity-item-777a3ee2f585.js` 将 `context-compaction` 分类为 `standalone`，而非工具分组中的普通工具。

`webview/assets/sites-end-resource-e2d7df4c9a5f.js` 根据运行、完成、中断和手动/自动来源选择文案；含 `localConversation.contextAutomaticallyCompacted`、`contextManuallyCompacted`、`compactionInterrupted`。这是有状态的时间线条目。

可复核方法：ASAR 文件起始第 12 字节处的 uint32LE 是 JSON 头长度；从第 16 字节读 JSON。数据起点是 `8 + uint32LE(4)`，按 `files.webview.files.assets.files[文件名]` 的 `offset/size` 读取上述 JS，搜索以上事件名和类型名。

## QoneAgent 根因与修复

旧实现的自动压缩事件只带 `throughMessageId`，绑定本轮用户消息；`Thread.tsx` 再将其转换为 `betweenContent`，因此无论压缩发生在第几个工具之后，都被放到回答之前。

现在保留用户锚点用于历史兼容，同时记录 `runId` 和发生时的 `partIndex`。这个索引按非 reasoning 内容计数，显示层根据当前 reasoning 显示策略换算成实际索引。开始和结束复用同一标记及位置；显示层按边界拆开工具或图像分组，独立渲染压缩条目。

持久化读取保留索引；旧自动压缩记录在存在有序消息 parts 时，根据 `messageSequence < 压缩事件 sequence` 恢复位置。无法恢复的旧记录保留原锚点，不根据最终回答长度猜测压缩发生位置。
