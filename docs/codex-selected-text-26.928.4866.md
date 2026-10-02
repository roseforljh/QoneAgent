# 选中文字后的两个操作

用户授权静态读取 `C:/Program Files/WindowsApps/OpenAI.Codex_26.928.4866.0_x64__2p2nqsd0c76g0/app/resources/app.asar`。仅解析 ASAR 索引读取 JS/CSS，没有启动应用、浏览器、Hook 或联网。图片正文是截图内容，本次功能是选区浮动菜单，不是会话列表排序。

## 原版证据

复现：`python work/codex-selection-26.928.4866/extract.py "C:/Program Files/WindowsApps/OpenAI.Codex_26.928.4866.0_x64__2p2nqsd0c76g0/app/resources/app.asar"`。资源位置与 SHA-256 记录在同目录 `evidence.json`，函数片段为 `*.txt`。

- `app-primary-2b539a729a98.js`，SHA-256 `2c5259d8c72b2b7f3c437c372bdbad340357156036ca02d6e92caa5c08e55b29`：`J4e` 按回调提供添加、更多详情、侧聊入口，点击清空原选区；用户要求省略第二项。
- `R4e/F4e/U4e`：限定同一目标、排除可编辑内容；按可见选区和输入框顶部边界计算位置，距选区上方 8px，横向保留 8px。监听选区、指针、键盘、滚动和尺寸变化，帧合并更新；拖选期间隐藏。
- `Rit`：优先找当前激活、其后其他空闲侧聊，激活并附加选区、聚焦；没有可用侧聊才创建。不会直接发送默认问题。“告诉我更多相关信息”属于另一个 More details / Quick Chat 分支。
- `app-initial-9e0f03d3c485.js`：`HCn` 是圆角分段容器，使用 elevated-secondary 表面、border/70、shadow-lg；`WCn` 使用 `ghostActive/composerSm` 按钮，取消按钮圆角，用垂直分隔线分组。实际导入锚点：`afn → HCn`、`ofn → WCn`，由 app-primary 导入为 `VCe/oE`。

## 实现与边界

- `selected-text-actions.tsx` / `selected-text.css`：两个文字按钮、分隔线、主题颜色、悬停、淡入和 reduced-motion；复用 Radix 虚拟锚点与避让，不按截图坐标定位。
- 已核查 assistant-ui 0.15.21 的 `SelectionToolbarPrimitive.Root/Quote`。Root 使用 document 全局选区并仅按消息 ID 判断，主聊和侧聊会同时响应，且无容器碰撞处理。因此在 `text-selection.ts` 实现按 DOM 容器归属的监听；继续使用 assistant-ui 的 `setQuote`、`ComposerPrimitive.Quote/QuoteText/QuoteDismiss` 与现有草稿绑定。
- `Thread`、用户正文和助手正文接入。排除输入框、控件、工具输出及视口外选区。侧聊内保留两个按钮，但禁用再次创建侧聊，遵守现有运行时禁止嵌套侧聊的约束。
- `use-selected-text-side-chat.ts` 复用本父会话的空闲侧聊并激活。没有空闲侧聊时通过现有幂等请求创建，引用草稿在发布新侧聊状态之前写入；延迟响应不会写入用户已切换到的会话。
- 原发送路径只读 text，队列持久化也没有 quote。本次在 `composer-prompt.ts` 合并引用，`QueueItemInfo.quote`、队列恢复及编辑保存引用，重复判断区分不同引用。引用先作为元数据保存，发送时才在用户问题后逐行转成 Markdown 引用；其中的命令文本不会作为 goal/MCP 指令解析。
- 当前复用 assistant-ui 单条引用模型；新选区替换当前引用。原版还支持多段标注集合及定位原文，这部分不在本次两个入口的实现内。发送后的历史使用已有普通文本协议显示问题和引用。

## 验证

- 68 项桌面相关测试通过，覆盖引用/队列/编辑/草稿/消息按钮/本地化；9 项侧聊 bridge 测试通过；8 项运行时侧聊测试通过。
- 桌面及运行时 TypeScript 检查通过，diff 格式检查通过。
- `work/codex-selection-26.928.4866/dom-smoke.tsx`：JSDOM 加真实 assistant-ui runtime，验证恰好两个按钮、草稿保留、聚焦、主侧聊同消息 ID 隔离、控件与遮挡排除、Escape/拖选关闭、空闲侧聊复用、忙碌时新建、无自动发送和引用实际发送。用 `node work/codex-selection-26.928.4866/bundle-smoke.mjs` 与 `bun work/codex-selection-26.928.4866/dom-smoke.bundled.mjs` 复现。
- 不做浏览器视觉验收、不产出 exe 或安装包。实际 WebView 外观由用户运行 `bun run --cwd apps/desktop tauri dev` 验收。
