# Codex 正文网页链接

## 范围与来源

对齐用户截图 `Snipaste_2026-10-01_06-20-19.png`、`06-20-33.png`：网站图标、行内文字、无底色及 hover 虚线。

只读分析本机 `OpenAI.Codex_26.928.2636.0` 的 `resources/app.asar`。本轮校验了提取 JS/CSS 的 SHA256，四个资源均与当前安装包一致。没有运行应用代码、启动浏览器或修改安装目录。

可复现提取脚本：`work/codex-input-link-26-928/extract-markdown-web-link-evidence.ts`。九个函数的原始代码、资源 SHA256 和 UTF-16 偏移保存在同目录 `evidence/markdown-web-links`。

## 静态证据

| 资源 / 函数 | 确认的规则 |
| --- | --- |
| initial JS `Izc`，UTF-16 偏移 10496106 | 默认 `appearance="inline-mention"`，传递真实 href、标题和导航参数。 |
| initial JS `Bzc`，10499406 | 普通正文链接用 `iMc` 渲染 children；`xLc` 提供图标；`underlineOnHover` 开启。 |
| initial JS `iMc`，10336621 | 默认字重 medium、inline-flow、accent 色；图标与标签独立，图标 slot 排除复制内容。 |
| initial JS `xLc`，10472470；`cU` | 已登记服务通过本地图标呈现；没有可用图标时进入 favicon 分支。域名识别来自 shared `b1`，图标选择来自 shared `l1`。 |
| initial JS `_Lc`，10471203 | 先显示地球图标；favicon 图片 `onLoad` 后才显示。图片异步解码、不可拖动、`referrerPolicy="no-referrer"`。 |
| initial JS `pLc`，10470845 | 仅 HTTP(S)，使用 `t0.gstatic.com/faviconV2`，请求参数只包含编码后的 origin、32px 尺寸和 `drop_404_icon=true`，不附带路径、查询、凭据或 hash。 |
| shared CSS `._Mention_rqv78_2` | 信息色与正文色按 80% / 20% 混合；500 字重；图标 16px，容器 1lh，垂直居中，间隔 3px；标签正常换行。 |
| shared CSS `[data-underline-on-hover]` | 默认无下划线；hover 使用 currentColor 的 dashed 下划线，厚度 0.5px，偏移 2px。 |
| initial CSS `._InlineMentionFocusRing_lyk9f_2` | 键盘焦点 ring，跨行使用 box-decoration-break: clone。 |

外层 `ExternalMarkdownLink` 支持 Markdown 容器传入的 `linkColor`；因此不能把所有上下文都解释为固定紫色。Qone 在普通助手正文复用现有 `mention-colors.css` 的同源链接色，以匹配本轮 Linear 主题截图。该色的计算证据见 `codex-input-links-26.928.md`。

## 实现

- 两层 assistant-ui Markdown 的 anchor 扩展点统一使用 `MarkdownLink`：引用编号、文件引用保留原处理，网页链接进入 `MarkdownWebLink`。
- `inline-mention.css` 共享文件和网页链接的颜色、字重、焦点及 hover 虚线。移除网页链接原有 `text-primary` 和常驻下划线。
- `markdown-web-link.css`、`WebsiteIcon` 实现 Codex 的图标和标签结构，保留长 URL 的断行能力。href 和标签不互相替换。
- 复用现有服务图标表，补充 `loadRemoteFavicon` 供正文使用；输入框行为不变。原注册表有本地图标的服务不发 favicon 请求。Qone 自行扩展的网站图标用作备用图标，站点 favicon 成功后呈现官方图案。
- favicon 使用已逆向的服务地址；仅发送 origin，懒加载、异步解码，复用 WebView 图片缓存；加载失败时保留备用图标，不重试循环或挤压文字。不会为文件链接、mailto、页内锚点或引用编号加载 favicon。
- 普通点击继续打开原浏览器侧栏；保留真实 anchor 的 href、原 Markdown title 和用户标签。

## 验证

- Markdown 渲染和 favicon 测试覆盖本地服务图标、陌生网站回退、彩色备用图标、长 URL、自定义标签、页内锚点、mailto、协议相对 URL 及请求中排除私有路径和查询。
- DOM 自检覆盖 favicon 加载成功、失败、地址切换和浏览器侧栏点击事件；使用本机已有 jsdom，未新增项目依赖或联网获取测试图标。
- 用项目自带 Tailwind 编译器在内存中验证 CSS 依赖链、正常态/hover 规则、图标尺寸与浅色/深色链接变量，类型检查和 diff 检查通过。
- 网页/文件链接与站点表测试共 21 项通过，输入框链接测试单独运行 15 项通过；DOM/CSS 自检通过，临时自检文件已删除。
- 未运行浏览器验收或打包安装程序。favicon 的实际图案取决于站点资源与网络；失效时展示备用图标。
