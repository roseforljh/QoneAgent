# 网站链接图标

本目录 SVG 复制自项目已安装的 `@tabler/icons@3.48.0`（`@tabler/icons-react` 的依赖），用于输入框中新增的网站链接图标。原始 SVG 未改写，MIT 许可证随目录保留。

- `x`、`youtube`、`discord`、`facebook`、`instagram`、`linkedin`、`tiktok`：`icons/filled/brand-*.svg`。
- `gitlab`、`stackoverflow`、`wikipedia`、`telegram`：`icons/outline/brand-*.svg`。

Reddit、Box、Dropbox 优先使用 `assets/codex-icons` 中已有资源；Cloudflare 等复用已有 `@lobehub/icons-static-svg` 依赖。网站映射集中在 `components/assistant-ui/composer-link-sites.ts`，不请求远程 favicon。
