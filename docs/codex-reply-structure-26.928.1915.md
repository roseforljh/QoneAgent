# Codex 回答结构静态分析

## 范围与方法

用户授权核对本地 Codex 回复结构。原指定 26.924.6891 路径不可用，Get-AppxPackage 返回当前安装版本 26.928.1915。
只读分析 `C:/Program Files/WindowsApps/OpenAI.Codex_26.928.1915.0_x64__2p2nqsd0c76g0/app/resources/app.asar` 的 webview JS；没有运行安装包代码、启动浏览器、联网或修改安装目录。这是 Codex 桌面端证据，不代表 ChatGPT 网页端。

## 可复核证据

ASAR：读取前 16 字节，uint32LE(12) 为 JSON 索引长度，数据起点为 8 + uint32LE(4)。按 files.webview.files.assets.files 下条目的 offset、size 读取：

- `split-items-into-render-groups-2ecd7311f452.js`：函数 p 分别产出 userItems、agentItems、assistantItem、postAssistantItems。识别 assistant-message.phase 的 commentary / final_answer；最终回答从过程条目中取出。latest 模式另有 currentCommentaryItem，不能把所有文本一概视为正文。
- `agent-activity-item-777a3ee2f585.js`：函数 ur 将 exec、patch、普通 mcp-tool-call 等分类为 groupable，将 assistant-message、context-compaction 等分类为 standalone。原始 reasoning 分支返回 null。独立图片、审批和特殊工具有例外规则。
- `conversation-markdown-a3ee2dfa1cc3.js`：导出结构处理函数 A/N/Ke/qe 描述工具组及 exploration 子组；摘要包含文件、搜索、列表、命令、工具等实际数量，详情保留 Read / Searched / Ran 及目标。这部分是序列化结构证据，不能单独当作界面截图。
- `app-primary-ce6eb321deed.js`：localConversation.workedFor.v2 的说明明确是 agent activity 与 completed turn 最终回复之间的 divider，文案 Worked for {time}。
- `local-conversation-turn-bf34e7fdd14b.js`：渲染区分 agent-activity；最终回答流式状态检查 phase===final_answer。

结构概括：一轮用户输入 → 有序过程区（旁白、可分组工具、独立系统事件）→ 回合耗时分隔 → 最终回答。不是给每个底层模型消息生成一个“耗时”标题。

## Qone 本次修正与差异

1. session-timeline 原先在结束时用 toolRegionElapsed 覆盖操作摘要，导致多个分组全显示“耗时 1秒”；先前改为按操作计数，后续复核又改为按语义类别生成简短摘要。具体目标和结果仍在工具行中。
2. assistant-message-parts 原先遇到 messageSequence 变化就生成新工具 parentId，连续工具因此被人为拆开；现按连续内容区间生成工具组 ID。旁白、思考、图片等真实条目仍构成分组边界，空白文本边界也保留。
3. 保留 Qone 用户明确要求的思考预览，并放在大执行折叠区内。没有照搬 Codex 隐藏原始 reasoning 的策略。
4. 后续对齐中，Qone 为有序文本 part 增加 commentary/final_answer 阶段。Pi 消息含工具调用时按过程处理；无工具且正常结束的文本按最终回答处理。流式文本在工具后暂记 pending，直到消息结束确定阶段。旧记录继续使用原有分界回退。这是基于 Pi 事件的分类，并不等同于 Codex 原生的消息协议。
5. 后续对齐中，整轮耗时状态移到过程之后、最终回答之前；上下文压缩将过程拆开时只显示一次。连续的读取、搜索、列表工具组成探索组，编辑和命令组成另一组，过程仍保留原有顺序。

## 验证

消息顺序和分组测试、带真实耗时数据的工具组服务端渲染测试、思考与压缩分组回归测试、桌面端 TypeScript 检查。界面视觉验收由用户完成。

## 补充：执行过程何时出现折叠入口

指定版本 `sites-end-resource-e2d7df4c9a5f.js` 的 `kO` 先计算 `shouldAllowCollapse`：普通会话要有可展示的过程内容、最终回复已经开始且回合未取消。特殊的 `activity` 上下文可通过 `allowCollapseBeforeFinal` 提前允许。`AO` 仅在允许折叠且有可折叠条目时渲染 `TO` 折叠头；否则过程内容直接保持展开。`local-conversation-turn-bf34e7fdd14b.js` 把最终回复是否开始、取消状态和 `activity` 上下文传给这一层。截图中运行期间看不到外层展开/收起，与普通会话的这一分支一致。

Qone 原 `AssistantExecution` 始终渲染外层 `CollapsibleTrigger`，且最终回复开始时通过 effect 强制写入折叠覆盖值。现改为最终回复开始前只显示非交互状态文本和展开的过程内容，最终回复开始后才提供折叠入口；自动折叠继续由最终回复和活动是否结束推导，用户之后的手动选择仍保留。内层工具/思考详情的折叠入口不受影响。

后续对齐增加了 Pi 契约、阶段/分组、assistant-ui 服务端渲染和压缩分段测试，并通过桌面端 TypeScript 检查。未启动浏览器或构建安装包；界面视觉验收仍由用户在 `tauri dev` 中完成。

## 补充：运行状态的位置

再次只读核对 `sites-end-resource-e2d7df4c9a5f.js` 的 `AO`：`kO` 在普通会话最终回答开始前返回 `shouldAllowCollapse: false`，因此 `worked-for` 条目留在活动列表中，随活动列表渲染。`app-primary-ce6eb321deed.js` 将运行中的条目标为 `Working for {time}`，完成后标为 `Worked for {time}`。这解释了运行态状态出现在活动末尾的来源。

Qone 按用户的显示要求，将运行中、暂停和等待批准的状态行放在过程前；完成后且未进入最终回答的状态仍放在过程后。最终回答开始后的折叠头位置保持不变。只改变状态行的位置，不改变过程条目的顺序。

## 补充：活动组摘要与聊天内文件差异

重新核对 `inline-followup-markdown-81008ccffed3.js` 的 `je`：文件变更、探索、命令等按类别计数，文件路径使用 Set 去重。`sites-end-resource-e2d7df4c9a5f.js` 的 `nO` / `Y_` 将这些类别拼成完成摘要；英文资源给出 `Edited a file`、`ran a command` 等文案，计数用于单复数，不显示文件名或命令内容。`JD` 的展开内容另行逐行渲染工具目标。因此 Qone 截图中的“编辑 1 项 (App.tsx) · 运行 1 项 (完整命令)”并非该版本 Codex 的组摘要样式。

同一文件中的 `ND` 对 `patch` 调用 `Aw`，`Aw` 按变更文件调用 `Mw`，`Mw` 将统一 diff 传入 `Lw`。`Lw` 使用 `FileDiff`、`diffStyle: unified` 和 `hunkSeparators: simple` 显示内嵌预览。它是变更 hunk 加附近上下文，并非整份文件，也并非严格只显示加减行。Qone 的 `DiffViewer.computeDiff` 之前把全部未改行放进渲染数组；本轮改为复用项目已有的 `createTwoFilesPatch` 生成 hunk，只渲染 hunk 与省略分隔。文件详情、工作区 diff 等共用此组件，因而一起受益。

本轮新增摘要分类和 diff hunk 测试，并通过桌面端 TypeScript 检查。没有启动浏览器或构建安装包。
