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

1. session-timeline 原先在结束时用 toolRegionElapsed 覆盖操作摘要，导致多个分组全显示“耗时 1秒”；现改为按操作计数，如“读取 2 项 · 搜索 1 项”。具体目标和结果仍在工具行中。
2. assistant-message-parts 原先遇到 messageSequence 变化就生成新工具 parentId，连续工具因此被人为拆开；现按连续内容区间生成工具组 ID。旁白、思考、图片等真实条目仍构成分组边界，空白文本边界也保留。
3. 保留 Qone 用户明确要求的思考预览，并放在大执行折叠区内。没有照搬 Codex 隐藏原始 reasoning 的策略。
4. Qone 当前协议未提供 Codex 的完整 commentary/final_answer 分类。本次保留现有正文分界策略，不声称已经复制 Codex 全部消息模型。

## 验证

消息顺序和分组测试、带真实耗时数据的工具组服务端渲染测试、思考与压缩分组回归测试、桌面端 TypeScript 检查。界面视觉验收由用户完成。

## 补充：执行过程何时出现折叠入口

指定版本 `sites-end-resource-e2d7df4c9a5f.js` 的 `kO` 先计算 `shouldAllowCollapse`：普通会话要有可展示的过程内容、最终回复已经开始且回合未取消。特殊的 `activity` 上下文可通过 `allowCollapseBeforeFinal` 提前允许。`AO` 仅在允许折叠且有可折叠条目时渲染 `TO` 折叠头；否则过程内容直接保持展开。`local-conversation-turn-bf34e7fdd14b.js` 把最终回复是否开始、取消状态和 `activity` 上下文传给这一层。截图中运行期间看不到外层展开/收起，与普通会话的这一分支一致。

Qone 原 `AssistantExecution` 始终渲染外层 `CollapsibleTrigger`，且最终回复开始时通过 effect 强制写入折叠覆盖值。现改为最终回复开始前只显示非交互状态文本和展开的过程内容，最终回复开始后才提供折叠入口；自动折叠继续由最终回复和活动是否结束推导，用户之后的手动选择仍保留。内层工具/思考详情的折叠入口不受影响。
