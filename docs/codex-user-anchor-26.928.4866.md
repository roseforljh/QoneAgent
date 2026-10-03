# 用户消息顶部留白修复

## 静态参考

用户授权只读分析 `C:/Program Files/WindowsApps/OpenAI.Codex_26.928.4866.0_x64__2p2nqsd0c76g0/app/resources/app.asar`；仅用 Python 解析 ASAR 索引、读取 JS/CSS，没有运行客户端代码或启动浏览器。

- `webview/assets/app-initial-2e28cd4bbe72.css`，SHA-256 `89098148cf2c30a19bcae4b52d1a067177698ef31f775438bf4a8eb3d7319668`：`_MainContentViewport_g50a1_2` 定义 `--thread-content-top-inset:calc(var(--spacing) * 8)`；全出血布局另外计入工具栏高度。
- `webview/assets/thread-scroll-layout-855541aca351.js`，SHA-256 `3c0d30dd15e60a8d89a7c229c9e94bd5b7760f060dc35a28f7b5e27b2f3a61a2`：默认滚动容器使用 `pt-(--thread-content-top-inset)`；紧凑布局有单独的顶部淡出遮罩。该模块通过 ESM 导入布局、滚动和测量辅助组件，资源是可读的压缩 JavaScript。
- `webview/assets/local-conversation-thread-876674db64a3.js`，SHA-256 `3fa27f4c2287b9ffd5a20c804b97f39db3b3725f0c40a28fe727abe6dc8a2ee9`：提交放置使用 `consumePendingLatestTurnSubmitPlacement` 和响应占位动画，有独立的恢复路径。因此这里只参考其留白定义，不声称两套滚动算法完全一致。

复现读取：ASAR 的 JSON 索引长度为 `uint32LE(12)`，数据区起点为 `8 + uint32LE(4)`；从索引的 `files/webview/files/assets/files` 取对应资源的 offset 和 size，读取后计算 SHA-256。

## 根因与修复

1. `desktop-overrides.css` 中 `.aui-thread-root [data-aui-top-anchor-user]` 的优先级高于此前新增的 `.q-message-user`，将顶部内边距覆盖为 `0.5rem`，所以活动消息依然进入渐变区域。
2. 已有视口 `scroll-padding-top: 2rem` 只对浏览器的滚动对齐生效；assistant-ui 的 `computeTopAnchorTargetScrollTop` 手工计算并调用 `scrollTo`，原实现没有扣除该留白。
3. 取消两处消息内边距补偿，首次列表留白和视口 scroll-padding 共用 `--q-thread-content-top-inset`，值使用现有 spacing 的八倍；不依赖截图坐标、延时或第二次滚动纠正。
4. 在已有 assistant-ui Bun 补丁中同时修正发布 JS 和 TS 源码：目标位置扣除计算后的 scroll-padding，底部 reserve 复用相同目标。保留长消息裁剪、首次放置动画和历史位置恢复。
5. 本地待发送消息的 reveal 路径同样读取视口顶部留白，避免在运行开始前使用不同的可见边界。

## 验证

`thread-scroll-restoration.test.ts` 调用实际安装且已补丁的组件库，覆盖不同留白、长消息、百分比、零边界、占位高度及历史恢复；`thread-scroll-growth.test.ts` 覆盖本地 reveal。视觉验收仍由用户在开发模式中完成。

## 2026-10-03：提交放置与回复占位复核

本次用户指定的 26.928.4866 目录已不存在。`Get-AppxPackage -Name OpenAI.Codex` 返回 26.930.2377.0，实际只读解析的是该版本的 `app/resources/app.asar`。以上旧版本结论是已有记录，下面是新版本实读证据；没有启动浏览器、执行提取代码或修改 Codex。

复核方法仍为前述 ASAR 索引解析。ESM 导入显示会话模块依赖共享 thread-scroll-layout、滚动控制上下文和虚拟列表。对对应资源按索引 offset/size 读取，SHA-256 与 ASAR integrity 字段一致。以下偏移为 UTF-8 解码后的字符偏移。

- `local-conversation-thread-57045698853f.js`，SHA-256 `f1b82ebd4d6e8ad064b02fbeb889d38dc1a48c2c783806eb8b55b93dfd3e57be`。
  - `TD`（约 195581）：提交前保存距底距离、scrollHeight 和 `shouldPlaceLatestTurn`；判断距离时扣除已有 response spacer。
  - `_A`（约 269800）：接收 `consumePendingLatestTurnSubmitPlacement`；约 280960 的分支只消费新回合的提交意图，无提交意图且非首次活动回合时跳过放置。
  - 放置先切换为 static，再设置滚动距离并对 response spacer 做动画；历史恢复则走独立的 instant 路径。拒绝放置的分支使用提交前的 scrollHeight 差补偿原阅读位置。
  - `SA`（284361）计算可用高度 `H = max(0, clientHeight - scrollPaddingBottom)`，初始回复占位为 `max(0, min(H * 2/3, H - 240))`。这些数值是原版证据，未硬编码进 Qone；原版具体几何与 assistant-ui 的顶部锚定算法不完全相同。
- `thread-scroll-layout-2fb3c5987899.js`，SHA-256 `97eb5c1b6d1559205f28e519ec5ac54baf2e54578980764d231ed7d7484f9541`。
  - 约 18932：默认布局使用 `pt-(--thread-content-top-inset)`，滚动正文为 `shrink-0`，底部输入区独立测量。
  - 约 15362：分别提供普通滚动监听与用户滚动监听，并维护独立的 response spacer 控制器。

Qone 本次通过真实 `ThreadPrimitive.Messages`、`MessagePrimitive.Root` 和 `Viewport` 的集成测试复现了两条竞争路径：

1. follower 在库的 reserve 尚未测量前执行 instant reveal，提前写入一个受旧 scrollHeight 限制的位置；随后库再次执行 smooth 放置。现在根据运行中的 user/assistant 消息对判断归属，不依赖较晚注册的 DOM ref；活动消息对完全由库放置。只有 assistant 尚未出现时使用 pending reveal。
2. 库放置产生的向下 scroll 事件，被控制器当成用户恢复追底；真实回复底部在输入区上方时，负距离仍满足原先的 `distance <= tolerance`，下一次内容增长就把为回复预留的空白滚走。现在存在 reserve 时，单凭程序 scroll 事件不恢复追底；明确的鼠标、触摸、滚轮、按键和回底按钮路径继续保留。

修改位置：`thread-scroll-follower.tsx`、`thread-scroll-controller.ts`。未改水平气泡布局、顶部留白值或依赖补丁。

原 `user-message-top-anchor.test.tsx` 只渲染普通 div，未注册库的消息锚点，无法覆盖上述竞争。已将该场景明确为 pending reveal，并新增真实消息组件测试：短消息、长消息裁剪、视口位于页面标题下方、reserve 生成、单次 smooth 放置、回复增长时 reserve 减少且气泡不跳动。

验证：7 个滚动相关测试文件共 35 项通过；`bun x tsc --noEmit -p apps/desktop/tsconfig.json` 通过。测试用 JSDOM 与可控几何验证组件行为，不是 WebView 视觉验收；没有启动浏览器或构建安装包。

## 2026-10-03：底部尾部与 footer fade 复核

继续读取 26.930.2377.0 的 `thread-scroll-layout-2fb3c5987899.js` 和 `thread-scroll-layout-24b9bd243051.css`：

- Codex 将消息内容、footer inset 和 response spacer 分开测量。`local-conversation-thread-57045698853f.js` 的 `Me/Pe/Re` 对用户滚动、空白区可见性进行处理并缩减 spacer，`J` 在进入追底时清空 spacer；它不是一块永久不变的空白。Qone 使用 assistant-ui 的几何 reserve，本轮没有替换为原版 spacer 算法。
- 默认布局的间距属于 transcript 内容结构，footer 仍是独立 sticky inset；不能把外层 flex gap 当成消息尾部之外的自由滚动空间。Qone 原来用 viewport 外层 `gap-7`，但自定义控制器只测消息列表和 footer 的几何边界，导致浏览器可滚动尾部与控制器的 real tail 不一致。
- `thread-scroll-layout-2fb3c5987899.js` 将 fade 放在 sticky 占位上，将 surface 放在底部 absolute footer 上。其导入的 `app-initial-1da99842592d.js` 导出 `iXt` 对应 `twr`（字符偏移 3353954）：`surface` 使用 `-top-8 mt-8 bottom-0 bg-surface`，`fade` 使用 `-top-8 h-8 bg-gradient-to-t from-surface`。这就是主聊天底部的背景渐变来源，不是 composer 本身的 box-shadow。

Qone 修复：将原有内容间距移入消息列表和结束内容的测量盒，移除 viewport 外层 gap；footer 改为聊天背景色，并增加不改变布局高度的 8-spacing 渐变层。滚轮、触摸和滚动条向下进入顶部锚定预留区时标记为用户 hold，后续 ResizeObserver 不再强制回弹。

新增回归覆盖：内容尾部间距与 native scroll limit 一致、结束内容增长、滚轮/触摸/滚动条向下滚入 top-anchor reserve 不回弹。测试采用可控几何，实际 WebView 视觉验收由用户完成。未启动浏览器、未构建安装包。
## 2026-10-03：26.930.2377 执行披露与滚动补查

用户指定的旧安装目录已不存在，当前可读取版本为 `C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。本次只读解析了其中的 `local-conversation-turn-6ffe41e7c8ab.js`、`sites-end-resource-8e6efbcb797f.js` 和 `tool-activity-disclosure-54de483a3409.js`。

- Codex 的整轮 agent activity 只有在最终回答已开始且存在可渲染活动时才允许外层收起；最终回答前始终展开。
- 执行活动的明细披露运行时按 `running` 默认展开，完成态使用独立的完成态开合状态；详情视口为 `max-h-56 overflow-y-auto`，并带纵向边缘渐隐。用户点击后保留选择。
- 当前新版的跟随状态仍是 `static`、`prework_watch`、`prework_follow`、`user_follow`。新回合放置只切到 `static`，随后在 prework 内容溢出响应预留区时进入 `prework_follow`；放置动作本身不等于用户暂停。

Qone 本轮修复：`SessionTimeline` 的执行过程和阶段工具组默认收起，运行中标题仍显示当前活动；点击后可以展开并保留到内容增长，回合完成时回到完成态默认收起。折叠状态通过 `aria-expanded`、`aria-hidden` 和 `inert` 保持可访问性，失败数量继续显示在阶段标题中，避免收起后丢失错误信号。

同时修正 `thread-scroll-controller`：新回合和用户气泡 reveal 不再把 `held` 永久设为 true，而是进入原版的 prework 观察态；只有真实向上滚动、滚动条拖动或触摸手势才暂停。带有 assistant-ui 顶部锚定预留区的程序滚动不会被误判为用户回到底部，回复增长先消耗预留空间，超出后才跟随底部。因此用户气泡仍保持在内容区上方，底部继续为回复和输入区保留空间。

验证：相关工具/执行/滚动测试通过，合计 38 项通过；滚动策略、消息分组和 follower 回归测试另有 31 项通过；TypeScript 检查和 `git diff --check` 通过。没有启动浏览器、没有构建安装包。
