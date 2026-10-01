# Codex 26.928 回答文本字号对齐

只读来源：`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。

## 真实渲染路径

`local-conversation-thread-3c15e330d968.js` 引用 `sites-end-resource-cff1c624fbb8.js` 的回答组件；后者传入 `textStyle: { kind: "assistant-message" }`。`chatgpt-markdown-view-49141f9da9a5.js` 将参数转发至 `app-initial-fd3c4b862660.js` 的 `DZc → AZc → JKc → GKc`，最终使用 `_MarkdownRoot_lyk9f_2`。没有采用独立文档查看器的 `_MarkdownContent_yl0of_2` 样式。

`app-shared-a906948d8868.js` 设置 `sansFontSize.default = 14`、`codeFontSize.default = 12`。`app-initial-fd3c4b862660.js` 的 `fbs` 将实际设置写入字体变量；CSS 中的 `13px` 只是无变量时的回退值，不能当作桌面默认字号。以下参数对应原版默认设置，用户自行调整的字体或窗口缩放不在此结论内。

## 对照结果

| 内容 | 原版默认 | 项目修复前 | 修复后 |
| --- | --- | --- | --- |
| 段落 | 14px，行高 1.625（22.75px） | 子组件强制 15px，继承 1.625（24.375px） | 继承 14px，行高 22.75px |
| 有序／无序列表 | 14px，行高 22.75px | 子组件强制 15px，行高 24.375px | 继承 14px，行高 22.75px |
| 表格 | `max(12px, 14px × .875)` = 12.25px，行高 22.75px | 13px，行高 1.45，表头另外强制 12px | 12.25px，行高 22.75px，单元格统一继承 |
| 行内代码 | `.92em`，正文内为 12.88px | 固定 13px | `.92em`，随正文／表格字号变化 |
| h1／h2／h3 | 正文 × 1.5／1.25／1.125 | 相同 | 保持原比例 |

根因在 `components/assistant-ui/markdown-text.tsx` 的定制段落和列表：`text-[15px]` 覆盖了外层 `.aui-md` 的 14px。只改外层字号无法消除这个覆盖。本次移除子组件字号，公共回答样式明确继承，以复用现有 assistant-ui Markdown 渲染。没有增加 UI 组件、依赖或全局缩放。

本次仅处理回答文本字号及对应行高；思考、工具、代码块和段落间距不属于本次修改。未启动浏览器；视觉验收由用户运行开发模式完成。

## 验证结果

- 实际 assistant-ui 运行时的服务端渲染自检：流式和完成状态均覆盖正文、有序／无序／嵌套列表、表格与行内代码，旧字号类已消除。
- Tailwind 编译与 CSS 优化解析通过；核对公共回答样式的继承规则及字号公式。此检查不等同于浏览器计算样式或视觉验收。
- `bun x tsc --noEmit --project apps/desktop/tsconfig.json` 通过。
- `bun test` 运行 `markdown-gfm`、`markdown-document`、`markdown-web-link`、`markdown-file-link` 四组现有测试，14 项通过。
- `git diff --check` 通过。没有生成安装程序或构建输出。

## 证据校验

| ASAR 资源 | SHA256 |
| --- | --- |
| `app-shared-a906948d8868.js` | `50c38d92886db2b9832ec21932ca80fd0d997e4c3cc716c4139e9085c4f15d25` |
| `app-initial-fd3c4b862660.js` | `8a1dc07f215d429b996f5302de308625fea57adecf9f1fbaf28936d6814b1eea` |
| `app-shared-342447930c78.css` | `916d8fa55c82aedbf6ca0f53eec06274ec9eafe08397bb7e9e495d089781f93d` |
| `app-initial-e55cd978d577.css` | `4467a7668c346b181d2f965e19676a47e76fe8a9c3f08676bfa9af4d35a840b9` |
| `sites-end-resource-cff1c624fbb8.js` | `7dc01a5e524c86538227ecc50d1a2ee7e939c6d94e6749bfc52b400a6e6e6aac` |
