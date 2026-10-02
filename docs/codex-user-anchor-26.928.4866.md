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
