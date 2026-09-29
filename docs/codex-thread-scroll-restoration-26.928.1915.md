# Codex 会话滚动恢复与 Qone 对照

## 范围

2026-09-30，只读静态分析本机 Codex 26.928.1915：
`C:/Program Files/WindowsApps/OpenAI.Codex_26.928.1915.0_x64__2p2nqsd0c76g0/app/resources/app.asar`。
用户称目标为“GPT”；本机 Get-AppxPackage 返回 Codex，没有确认独立 ChatGPT 安装。本报告是 Codex 本地会话页面的证据，不代表 ChatGPT 网页版。未启动浏览器、Hook、运行提取代码或修改客户端。

ASAR 索引解析：uint32LE(12) 是 JSON 索引长度，数据区起点为 8 + uint32LE(4)。以下偏移为解码后 JavaScript 字符位置。

## Codex 的实现

主要资源：`webview/assets/local-conversation-thread-c87324d6b895.js`。
SHA256：`1d29070e9a2efd23472f74b76b94db9fff32833f2defc25110c9d2888c537458`。
该模块导入共享滚动布局、滚动控制器和虚拟列表；证据来自代码调用链，并非只根据字段名称推测。

1. **按会话保存状态。** 约 201125 处建立 jD 状态；mA 的 layout-effect 清理函数通过 `y.set(jD,n,...)` 保存该 conversationId 的 `distanceFromBottomPx`、`latestTurn` 和 `virtualizedTurnList`。latestTurn 含 turnKey、是否运行、阶段、followMode 和测量高度。保存时会扣除/规范化 response spacer，避免临时空白占位污染恢复位置。
2. **再次进入先读取。** 约 317000 处 `q.get(jD,o)` 取回状态，将距离和虚拟列表快照作为 `initialScrollOffset`、`initialVirtualizedTurnListRestoreState` 传入。没有快照时走单独的默认路径。
3. **恢复位置使用 instant。** mA 中恢复函数通过 `L.scrollToDistanceFromBottomPx(e,'instant')` 恢复；有完成标记避免重复恢复，并允许在内容可测量后继续完成恢复。不是从顶部执行一段平滑滚动动画。
4. **恢复测量信息。** `virtualized-turn-list-d62f3c306a77.js` 在初始化时读取 `initialRestoreState.turnHeightsByKey`，用旧测量值建立列表几何，后续测量变化时补偿视口。不能把它简化成只恢复一个 scrollTop。
5. **新消息定位有独立触发。** 约 195992 处生成 `shouldPlaceLatestTurn`、原距离和原总高度；mA 消费 `consumePendingLatestTurnSubmitPlacement`。最新 turn key 变化但没有提交意图、也不是首次活动回合特例时，直接跳过放置。新提交的置顶行为不等于打开会话行为。
6. **跟随模式独立保存。** 约 246448 处 gk 处理 `static`、`prework_watch`、`prework_follow`、`user_follow`；用户离开底部和点击回底按钮触发不同状态转换。不是每次渲染统一追底。

共享布局 `thread-scroll-layout-d931d017eb67.js` 在 layout effect 内处理初始位置和激活恢复；新回合有单独的占位/动画路径。因此关键是区分生命周期和用户意图，并非取消所有滚动动画。

## Qone 的实际触发链

- `project-section.tsx` 的项目标题同时调用 `selectWorkspace` 和折叠切换。
- `store.ts` 的 selectWorkspace 改变 workspaceLoadingId；即使 currentSessionId 没变，Thread 的 conversationLoading 也会因项目加载而变为 true。
- `Thread.tsx` 在 conversationLoading 时返回骨架屏，卸载 Viewport；加载完成后重新挂载。
- selectSession 设置 messagesLoadingSessionId，同样走骨架屏分支；Viewport 还使用 `key={currentSessionId}`，明确隔离会话实例。
- `session-execution-state.ts` 保存消息、运行和工具状态，但没有保存阅读位置或顶端锚定状态。
- assistant-ui 0.15.21 的 `getActiveTopAnchorTurn` 根据 isRunning 和末尾 user/assistant 消息注册活动锚点；这不是仅监听一次“用户发送”事件。
- `mountTopAnchorReserve` 用挂载实例内的 lastScrolledAnchorId 防止重复平滑置顶。实例重建时该记录丢失，活动回合会再次执行 `viewport.scrollTo({..., behavior:'smooth'})`。
- 因而 `scrollToBottomOnInitialize=false` 和 `scrollToBottomOnThreadSwitch=false` 无法禁止这条独立的 top-anchor 路径。

静态代码可确认上述卸载、状态缺失和活动回合重复置顶链路。已完成会话也会丢失位置，但若其出现相同平滑动画，还需单独验证焦点、布局等触发因素；不能把活动回合结论扩展到所有情况。

## 对修复方向的约束

保留官方新用户消息置顶。项目文件加载不应销毁仍在显示的聊天视口；会话阅读状态应与会话 ID 关联；重新进入时恢复位置和锚点状态，不能重播新提交动画。删除 key 或关闭初始化追底都不能单独解决这些问题。

本轮只分析并记录证据，没有修改 Qone 运行时代码；不主张复制 Codex 整套自定义滚动状态机。
