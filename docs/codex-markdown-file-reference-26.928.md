# Codex 正文文件引用组件

## 本轮范围

用户截图 `Snipaste_2026-10-01_05-46-58.png` 中的“主题样式 / 左栏背景 / 主区样式”是带自定义标签的文件引用。先完成静态逆向，用户确认“开始实施”后已接入 Qone 正文 Markdown。没有运行浏览器或修改安装包。

读取本机当前安装版本 `OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0/app/resources/app.asar`。截图中的文字只作为界面观察对象。

## 组件与证据

| 包内资源 | 函数 / 选择器 | 确认内容 |
| --- | --- | --- |
| `webview/assets/app-initial-fd3c4b862660.js` | `cBc`，字符偏移约 10506800 | 文件路径经 `ss(path)` 选择类型图标；显示标签可独立传入，缺省标签和提示来自结构化文件引用。组合 `iMc` 与 `vBc`。 |
| 同上 | `iMc`，字符偏移 10336483 | 通用 Mention：icon、label、appearance、tone、fontWeight、layout、underlineOnHover。默认 inline-mention、medium、inline-flow、accent。 |
| 同上 | `vBc`，字符偏移 10521018 | 外层 `data-file-reference`，支持键盘 Enter / Space；`Vs` 显示 tooltip，缺省提示为文件路径。导航保留 path、cwd、hostId、line、column、endLine 等数据；普通点击是否打开侧栏由 openInSidePanel 等实际参数决定，修饰键支持其他打开方式。 |
| `webview/assets/app-shared-342447930c78.css` | `._Mention_rqv78_2` | 信息色与正文色按 80% / 20% 混合；medium 字重；默认无底色。inline-flow 允许标签断行。 |
| 同上 | IconContainer / Icon / Label | 图标宽高 16px，图标容器高 1lh，图标垂直居中；图标与文字间距 3px。标签可按词断行。 |
| 同上 | `[data-underline-on-hover]` | 在支持 hover 的设备上，悬停时显示 currentColor 的 dashed 下划线，厚度 0.5px，偏移 2px。 |
| `webview/assets/app-initial-e55cd978d577.css` | `._InlineMentionFocusRing_lyk9f_2` | 键盘聚焦显示主题 ring；换行片段使用 box-decoration-break: clone。 |
| `webview/assets/app-shared-a906948d8868.js` | `PC` 导出 → `w_i` / `D_i` / `k_i` | 按文件扩展名选图标；CSS 系列使用 css 图标，tsx/jsx 使用 react 图标，ts 使用 typescript 图标。未知类型走文件图标，不靠显示标签猜文件类型。 |

颜色是主题计算结果。当前截图的 Linear 主题颜色链与输入框 Mention 相同，已有分析见 `docs/codex-input-links-26.928.md`；不能把这个浅紫色解释为 CSS 或 React 文件专属颜色。

截图的深色圆角块是悬停提示框，不是正文引用本身的背景。标签可写“主题样式”，实际路径仍保存为指向 CSS 文件的 href/reference，不需要把路径写进正文标签。

## Qone 实现

已采用这套正文文件引用样式，继续使用 assistant-ui 的 Markdown 扩展点。组件库没有直接支持本地文件导航的同类组件，因此只增加文件 anchor 分支。

- `mention-colors.css` 共享输入框和正文的主题色，`markdown-file-link.css` 实现 16px 图标、3px 间距、无底色行内流、hover 虚线及键盘焦点。
- `MarkdownFileLink` 复用 Radix Tooltip 和 `openWorkspaceFile`，保留自定义标签，悬停显示完整工作区路径和行号。Enter / Space 与点击都打开文件侧栏。
- `markdown-file-reference.ts` 解析 Windows / POSIX / 相对路径、file URI、编码空格与 Unicode、`:line:column`、`#Lline` 及行号范围。`urlTransform` 只为确认的文件 anchor 保留原目标，其他协议继续由 react-markdown 过滤，图片不放开 file 协议。
- HTTP(S) 与协议相对网址打开浏览器侧栏，引用编号继续走引用组件，页内锚点和 mailto 保持链接语义。工作区外文件引用显示路径，但不可点击；现有文件读取协议仅支持工作区内文件。
- 文件侧栏目标携带 line / column / endLine；`WorkspaceFileContent` 将目标行或范围高亮，并只滚动文件视口。列号保留在导航数据和提示中，目前以所在行为定位单位。
- `SyntaxHighlighter` 的文件模式保留前置空行和缩进，为加载时的纯文本与完成后的 Shiki 输出提供相同的行标记，避免 trim 导致错位；普通代码块行为不变。
- 从实际图标注册表提取缺少的 18 个类型图标，公共类型继续复用项目资源。脚本 `work/codex-input-link-26-928/extract-file-icons.ts`，来源、偏移和 SHA256 见同目录 `file-icons-manifest.json`。

## 验证

- `bun test`：文件引用解析、真实 Markdown 渲染、图标与自定义标签、工作区边界、引用编号和纯文本行号保留，共 11 项通过。
- 文件变更视图回归 6 项通过；输入框链接回归单独运行 15 项通过。合并进程运行视图和输入框测试会触发 Lexical `CAN_USE_DOM` 初始化顺序错误，仅用原有 `run-file-changes-view.test.tsx` 和 `composer-link.test.ts` 也能复现；此问题不影响上述分进程验证，未扩大本次修改范围。
- DOM 自检使用本机已有 jsdom（没有新增项目依赖）：实际点击和键盘事件派发正确目标，外部路径不派发；Shiki 异步高亮完成后，目标行及范围仍保持正确；只滚动文件视口。临时脚本运行后删除。
- `bun x tsc --noEmit -p apps/desktop/tsconfig.json` 与 `git diff --check`。
- 未启动浏览器；视觉效果由用户在 `tauri dev` 验收。
