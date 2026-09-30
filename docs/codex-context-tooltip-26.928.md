# Codex 26.928 上下文圆环与悬浮提示

用户授权离线分析安装目录并对齐 Qone；未启动浏览器、Hook 进程或改动安装文件。

执行 `bun work/codex-input-link-26-928/extract-context-evidence.ts` 可从指定安装包的 `resources/app.asar` 读取三个相关 JS/CSS 文件，逐字节核对先前解包副本，再提取函数与 CSS 变量。`evidence/context-manifest.json` 记录安装包内路径、SHA-256 和 UTF-16 偏移。

## 原始实现

- `app-primary` 的 `J$e`：外层 `icon-xs` 为 14px，调用 `are`（shared 导出的 `mxi`），圆环自身默认 12px、线宽 2px、底圈 opacity 0.16；0% 不显示前景圆点，更新过渡 120ms。
- `J$e` 的内容为 `flex w-38 flex-col gap-0.5 text-center`：内容宽 152px、行距 2px；标题、百分比状态、token 用量三行，没有模型名、进度条或长说明。token 取整到千。
- `J$e` 调用 `hc`（shared 导出的 `C5`）：`align: center`、`sideOffset: 4`。`Pli` / `Fli` 定位默认朝上，挂载到 portal，带自动避让、键盘 focus / Escape 行为。
- `Fli` 的默认提示使用 `rounded-2xl`、水平 padding 12px、垂直 padding 5px、主题文字色、5% 文字色边框和浮层阴影。实际使用 `--color-background-tooltip`，并非泛用 `--tooltip-background-color` 的另一套控件。
- `--color-background-tooltip` 暗色取 `--color-surface-elevated-secondary`，该变量在桌面主题里取不透明控件背景或应用表面色；输入框的 `--composer-background-color` 取 `--color-surface-elevated`。均为主题表面色，不能只根据通用 popover 色推断。

## Qone 对齐与明确差异

圆环放在模型选择器左侧。外层宽 14px、圆环 12px，右侧工具栏 gap 4px，保留 28px 高度方便悬停与聚焦。

复用已安装 Radix Tooltip，居中向上提示、4px 偏移，自动避让和 portal，避免原先 CSS 悬浮内容被输入框所在滚动区裁切。152px 为内容宽，外加水平 padding 12px 和边框；不把内容宽误认为卡片总宽。

用户要求卡片与输入框协调，因此 Qone 卡片使用 `bg-muted`，与输入框 `--composer-bg: var(--color-muted)` 使用同一主题变量；当前暗色为 `#262626`，不单独写固定色。卡片保留两行“上下文 + 百分比”和“估算用量 / 总量 tokens”，这是用户要求精简信息后的适配，不声称与原版三行文案完全相同。保留当前用量计算、缩写精度和高用量警示。

静态证据已直接与安装包核对；实际开发应用中的视觉验收由用户完成。
