# Codex 图标资源

`file-*-26-928.svg` 是从 Codex `26.928.2636.0` 文件类型注册表提取的 18 枚专用图标，用于正文文件引用。提取脚本与逐个资源的 SHA256、函数偏移见 `work/codex-input-link-26-928/extract-file-icons.ts`、`file-icons-manifest.json`；组件分析见 `docs/codex-markdown-file-reference-26.928.md`。

`composer-*-26-928.svg` 是本次从 Codex `26.928.2636.0` 服务图标注册表提取的 11 枚输入框链接图标。保留原始 viewBox（20、24、40 或 192），显示时由原 Mention 规则缩放为 16px；提取脚本、哈希与函数偏移见 `work/codex-input-link-26-928/link-icons-manifest.json` 和 `docs/codex-input-links-26.928.md`。

本目录的 843 个 SVG 从本机安装的 Codex `26.924.2738.0` 的 `resources/app.asar` 中提取，来源为 `webview/assets/app-shared-c568b0b98683.js` 内嵌的图标资源。保留原始名称、尺寸、路径和颜色；其中 `sketch` 两枚图标的共享路径已展开。此目录不包含应用打包的 Lucide SVG。

单色图标可通过 `components/ui/CodexIcon.tsx` 以 CSS mask 使用，颜色继承文本颜色，且只有被静态导入的 SVG 会进入前端构建。多色图标直接作为图片使用。

Codex 的第三方声明未为这批自有图标列出可再分发的独立许可；对外发布前需要确认资源的使用许可。
