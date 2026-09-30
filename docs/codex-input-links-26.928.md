# Codex 26.928 输入框链接：逆向证据与 Qone 实现

目标：`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。
采用离线 JS/CSS 分析；未修改安装目录、启动浏览器或编译安装包。

上一版的“外链箭头、设置页蓝色、继承字重”并非 Codex 的普通 URL 样式。本次针对用户两张截图继续追踪，而非根据颜色印象猜值。

## 可复查的证据

`work/codex-input-link-26-928/extract-link-evidence.ts` 提取 17 个函数，`evidence/manifest.json` 记录源文件 SHA-256 和 UTF-16 偏移。
`extract-link-icons.ts` 用 TypeScript AST 定位独立 SVG 函数，在隔离上下文中用 JSX 数据收集器还原 SVG，不加载应用运行时。`link-icons-manifest.json` 记录图标符号、偏移和 SVG SHA-256。

| 证据 | 真实规则 | Qone 对应实现 |
| --- | --- | --- |
| `vmr` / `xrr` / `Srr` | 独立 HTTP(S) 地址先去两端空白，拒绝内部空白；原始 URL 保持可编辑文本 | `composer-link-node.ts`、`composer-link-paste.tsx` |
| `ymr` / `b1` / `Amr` | URL 的 hostname 等于服务域名或其子域名，才设置 sourceAppId | `composer-link-appearance.ts` |
| `Lfr` / `Hfr` / `u1` / `Drr` | 服务图标与域名表分开；GitHub 使用 `Fdr`，缺图标时回退 `emi` 地球图标 | 提取 11 个实际服务 SVG；Qone 后续复用已有资源补上 Box、Dropbox 图标，SharePoint 仍回退地球 |
| `Oxi` / shared CSS `._Mention_rqv78_2` | 普通 URL 字重 medium；信息色与正文色按 80% / 20% 混合；16px 图标、3px 间距、垂直居中；URL 可断行 | `composer-links.css` |
| `jmr` | 剪贴板 HTML 只有一个有文字的 anchor、无其他正文或媒体时，识别为带标题链接 | `pastedHtmlLink` |
| 选区粘贴路径 | 选中文字后粘贴 URL 保留原文字并附带地址 | Qone 用 assistant-ui DirectiveNode 保留标题，运行时序列化为标准 Markdown |
| `Orr` | 输入 URL 后空格可以形成链接，空格不属于链接 | URL 文本转换和尾部正文拆分；明确粘贴的边界不与相邻正文合并 |
| `tNc` / `kI` | 点击后提供打开链接、编辑文字、编辑地址；空地址移除链接；编辑地址允许 HTTP(S)、mailto | `composer-link-options.tsx`、`composer-link-editor.ts` |

## 截图里的浅紫色来源

`linear-dark-f292b3b1106f.js` 的 chromeTheme 为 accent `#606acc`、ink `#e3e4e6`，默认 contrast 为 60。
`f4i` 将 accent 向白色混合 `0.3 + 0.6 × 0.15 = 0.39`，每个通道取整，得到 text-info `#9ea4e0`。
Mention 再按 `text-info × 80% + ink × 20%` 混合，取显示通道得到 **rgb(172, 177, 225)**。
用户第一张截图的链接区域主文字像素正好是这个颜色（读取截图时采样到 416 个该色像素）。这解释了之前默认蓝色为何明显不对。

Qone 以独立链接 token 复现参考截图：暗色使用上述 Linear Dark 信息色与 ink；亮色使用 `linear-light-68b2f60d891c.js` 的 accent `#5e6ad2` 和 ink `#1b1b1b`。这些值是提取的主题数据，不借用设置页颜色，也不修改应用其他控件的主题。

## Qone 自行增加的网站适配

用户授权增加知名网站图标后，新增映射集中在 `composer-link-sites.ts`，不混入 Codex 原始证据表。

支持 Cloudflare、Reddit、X/Twitter、YouTube、Discord、Bilibili、GitLab、Stack Overflow、Wikipedia、Telegram、Hugging Face、Vercel、ChatGPT、OpenAI、Claude、DeepSeek、Google、Facebook、Instagram、LinkedIn、TikTok 共 21 类网站。同时识别登记的官方短链，例如 `redd.it`、`t.co`、`youtu.be`、`b23.tv`、`t.me`、`lnkd.in`。

图标优先使用已有 Codex 资源（Reddit、Box、Dropbox），其余复用已安装的 LobeHub 和 Tabler 图标，没有新增依赖或远程 favicon 请求。Tabler SVG 及 MIT 许可证保存在 `assets/website-icons`。

仍按 `hostname === domain || hostname.endsWith('.' + domain)` 匹配；原 Google 服务的具体域名优先于新增的 Google 通用图标，ChatGPT 也优先于 OpenAI 通用域名。不把 `pages.dev`、`workers.dev`、`vercel.app` 上用户创建的站点统一认作平台品牌。

新增验证：`bun test apps/desktop/test/composer-link-sites.test.ts`，覆盖官方域名/别名、子域名、恶意相似域名、凭据与路径伪装、服务优先级、编辑 URL 后的图标与彩色状态切换。

## 行为与验证边界

- 普通 URL 可直接在输入框编辑，修改域名重选图标；带标题链接通过弹窗编辑。
- 文件剪贴板由附件流程处理，长文本的高优先级处理保持有效。
- 带标题链接序列化为 `[标题](<URL>)`，复用标准 Markdown 解析恢复，保留工具/技能指令；链接目标不会在发送或草稿字符串中丢失。
- Qone 保持 Lexical 与 assistant-ui；Codex 的选区文字链接是 ProseMirror mark，Qone 的带标题链接是原子节点，编辑方式有此差异。没有移植连接器服务的联网预览。
- 移除链接的状态在当前编辑器与 Lexical JSON 中保留。项目草稿保存纯字符串，因此裸 URL 在重新加载字符串草稿后仍会按 URL 识别。
- 代码测试覆盖识别、当前待提交选区、文件/长文本优先级、URL 编辑、相邻正文边界、标题与地址序列化、域名匹配、图标更新、移除、mailto、撤销/重做；HTML 的 DOMParser 分支和实际弹窗视觉由用户在开发应用中验收。

运行验证：`bun test apps/desktop/test/composer-link.test.ts apps/desktop/test/long-paste.test.ts apps/desktop/test/composer-tool-editor.test.ts`；`bun x tsc --noEmit -p apps/desktop/tsconfig.json`。无自动提交或推送。
