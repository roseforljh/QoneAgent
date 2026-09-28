# Codex 26.924.2738 右侧面板静态分析

分析目标：`C:\Program Files\WindowsApps\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0\app\resources\app.asar`

## 目标结构

- Electron WebView 前端资源位于 `webview/assets`。
- 右侧区域由 `JTn` 内容面板框架、`VTn` pane frame、`LQt` tabs/content 容器、`wQt` tab strip 和 `Vy` resizer 组成。
- 面板根节点是 `aside[data-app-shell-focus-area="right-panel"]`，内容使用绝对定位和 `min-height: 0`，避免面板内容把外层布局撑开。
- 面板切换状态、标签列表和当前焦点区由独立状态层维护，标签使用 `role="tablist"` / `role="tab"` / `role="tabpanel"`。

## 已确认的几何参数

- 工具栏默认高度 `46px`，面板专用工具栏高度 `40px`。
- 普通右侧面板最小宽度 `320px`。
- 普通模式最大宽度为 `mainContentWidth - 352px`；统一布局模式会改用主内容剩余宽度。
- 默认宽度策略使用 `600px` 作为基准：在空间足够时按 `min(height * 1.6, mainContentWidth - 500px)` 计算，并受 `640px` 的辅助上限约束。
- 分隔条是可聚焦的 `role="separator"`，支持拖拽、双击恢复默认值和方向键/Home/End 调整。
- 标签宽度在 `90px` 到 `240px` 之间自适应；选中态有轻微背景、边框和阴影，关闭按钮默认隐藏，悬停或聚焦时出现。

## Qone 对齐改动

- [workspace-dock.tsx](../apps/desktop/src/components/assistant-ui/workspace-dock.tsx) 使用独立 pane frame，面板宽度改为按容器实际尺寸计算。
- [dock-layout.ts](../apps/desktop/src/lib/dock-layout.ts) 集中实现最小宽度、主聊天区保留宽度、默认宽度、比例持久化和 resize clamp。
- [workspace-dock.css](../apps/desktop/src/components/assistant-ui/workspace-dock.css) 对齐工具栏高度、标签宽度和状态样式，并实现可见的面板分隔线反馈。
- `App.tsx` 将聊天区与右侧面板放入同一可收缩布局容器，避免右侧面板改变整个页面的外层尺寸。
- 新增全宽展开/恢复按钮，并保留已有终端、浏览器、文件、Git、MCP、技能和子代理标签。

## 复现与验证

```powershell
bun test apps/desktop/test/dock-layout.test.ts
bunx tsc --noEmit -p apps/desktop/tsconfig.json
git diff --check
```

本次未启动 Codex App、浏览器或安装包构建流程。
