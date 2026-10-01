# Codex 26.928.2636 文件阅读器与 Qone 对齐记录

本轮目标：单击正文文件引用后，在当前会话右侧打开独立文件标签；Markdown 默认按文档渲染，其他文件按实际类型查看。

## 分析范围与证据

- 用户指定的安装资源：`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。
- ASAR SHA256：`fb7b2ee791bcbdb3c4a6375e9fec8fb404f3eaff995f0d293227354b298aff49`。
- 静态提取：`work/codex-file-reader-26-928`。`manifest.json` 记录 8 个完整资源的来源、大小与 SHA256，本轮全部校验通过。`vBc.js`、`tU.js`、`XJ.js`、`ila.js` 是便于阅读的函数摘录。
- 目标是 Electron 的 JS 资源。导入、导出与动态 import 构成此次分析的模块锚点；使用 PowerShell/Bun 读取本地资源，没有执行 Codex 样本、联网、Hook 或修改安装包。
- 静态调用链结论可信度高；界面行为属于静态分析结论，实际界面验收由用户完成。

| 证据位置 | 确认内容 |
| --- | --- |
| `app-initial-fd3c4b862660.js`，`vBc`，字符偏移 10521156 | 文件引用保存 path、cwd、hostId、line、column、endLine；普通点击按 `openInSidePanel` 路由，Enter/Space 也触发打开。修饰键有独立打开方式。 |
| 同文件，`tU`，偏移 4010922 | 侧栏打开进入文件预览路由；读取元数据后按内容类型选择查看器，异步打开检查替换目标的 `contentInstance`，避免过期操作替换新标签。 |
| 同文件，`XJ`，偏移 5607330；`A_a`，偏移 5612016 | 文件标签默认目标为 right，身份由 host/environment/path 确定。重复打开复用标签与内容实例；行号、列号和末行传入预览器。Markdown 渲染和源码分别保留滚动状态。 |
| 同文件，`R5r`，偏移 4004770 | Markdown 选择 markdown 查看器，代码选择带语言标识的文本查看器。 |
| 同文件，`i7r` / `o7r`，偏移 4007298 / 4007843 | 本地预览分 image、pdf、audio、video、markdown；不支持的 Office、归档及二进制类型有独立识别结果，按打开策略使用系统应用或专用查看器。 |
| `text-document-preview-3537b0e438d7.js` | Markdown 使用专门渲染组件；正文置于限宽、独立滚动容器，而非代码高亮框。 |
| `library-file-preview-kind-a76bcefc8e29.js` | 资料库按 MIME 和文件名区分 image、pdf、artifact、markdown、html、text、unsupported。CSV/DOCX/IPYNB/PPTX/TSV/XLSX 使用专用 artifact 查看器；不能据此宣称普通本地文件全都可以直接内嵌。 |

## 根因与实现

原入口把文件引用送到工作区目录浏览器，读取协议只允许工作区内文件，内容统一进入代码视图；新增阅读器后还需要确保事件实际创建 `file` 标签，而不是 `files` 标签。现在入口通过 `filePreviewTab` 创建和复用独立阅读器。

- `packages/protocol/src/file-preview.ts` 定义格式分类和预览结果；`packages/protocol/src/index.ts` 增加 `file.preview` 请求、响应、校验和能力声明。
- `apps/agent-runtime/src/file-preview.ts` 读取真实路径和元数据，遵守显式拒绝规则。支持绝对路径、工作区相对路径和 Windows 的 `/docs/...` 根相对文档链接，识别 UTF-8/带 BOM 的 UTF-16 与二进制内容。
- `apps/desktop/src/lib/workspace-file-navigation.ts` 在解析前统一 Windows 分隔符；文档相对链接和图片以文档目录为基准，根相对链接以所在项目为基准。工作区外文档使用自己的目录。
- `apps/desktop/src/lib/dock-state.ts` 与 `components/assistant-ui/workspace-dock.tsx` 管理独立文件标签。不同文件分别打开，重复点击复用原标签；标签显示文件名，复用项目中的 Codex 类型图标。
- `apps/desktop/src/lib/file-preview-state.ts` 按标签和 requestId 分配结果；旧结果和错误不覆盖新请求，关闭标签后的迟到错误不污染会话；断线后可重读。
- `apps/desktop/src/components/assistant-ui/file-reader.tsx`、`file-preview-content.tsx`、`markdown-document.tsx` 实现查看、源码切换、刷新、加载全文和默认应用打开。
- Markdown 复用已有 `@assistant-ui/react-markdown` 和 `TextMessagePartProvider`，没有新增渲染依赖；复用 GFM、KaTeX、代码高亮和 Mermaid。标题提供稳定锚点，重复标题分别编号，页内跳转只滚动阅读器。
- `apps/desktop/src-tauri/src/main.rs` 按真实路径授权选中文件，验证允许目录；`tauri.conf.json` 为本地 PDF/媒体补齐 frame-src 和 media-src，兼容 Windows 的 `http://asset.localhost`。
- 中英文阅读器文案位于 `apps/desktop/src/i18n/zh-CN.ts` 和 `en.ts`。

## 当前查看范围

| 类型 | 阅读器行为 |
| --- | --- |
| Markdown | 默认渲染标题、表格、任务列表、公式、代码块、图片与页内锚点；可切换源码。 |
| 文本 / 代码 | 保留空行和缩进，按语言高亮；文件引用含行号时定位并标记对应行或范围。 |
| HTML | 在禁止脚本的 sandbox iframe 中渲染，可查看源码。相对资源的完整站点运行属于浏览器预览功能。 |
| 图片 | 本地资源直接预览，SVG 可切换源码；实际支持格式取决于 WebView 解码能力。 |
| PDF | 内嵌 WebView PDF 查看器。 |
| 音频 / 视频 | 内嵌媒体控件；标签不活跃时暂停。编码支持取决于 WebView。 |
| Office / 归档 / 其他二进制 | 显示类型图标和默认应用打开入口。本轮未新增 Office 转换引擎，也不把二进制内容当文本渲染。 |

大文本沿用已有 512,000 字节初始预览上限，界面明确提示部分内容，并提供加载全文。路径不存在、文件权限失败或运行时断开会显示错误；没有为截图里的示例路径创建占位文件或写入固定目录。

## 验证

- 27 项针对性测试通过：真实 Windows 根相对读取、反斜杠/父目录/文件系统根目录解析、完整内容加载、Unicode 解码、工作区外文件、独立标签/重复点击/行号、异步乱序/迟到错误/重连、真实 Markdown 的 GFM/数学/标题锚点以及协议过滤。
- 16 项关联回归测试通过：原工作区请求状态、文件引用解析和原有本地图片预览。
- 桌面与运行时 TypeScript 类型检查通过。
- Tauri `cargo check` 通过。
- `git diff --check` 通过。
- `bun run --cwd apps/desktop build` 通过；有依赖注解、动态导入和 chunk 大小提示，没有构建错误。
- 之前全量桌面测试出现既有 compaction 失败和 Lexical DOM 初始化顺序问题；本轮不以这些失败替代针对性验证，也未改动相关流程。
- 未启动浏览器验收、未编译安装包、未提交或推送。

用户手动运行 `bun run --cwd apps/desktop tauri dev`，用真实存在的 Markdown、代码、图片、HTML、PDF 与媒体文件检查右侧标签和查看效果。
