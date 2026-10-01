# 中英文语言适配检查

检查日期：2026-10-01。范围为桌面前端、启动页、Runtime、协议、Tauri 原生功能及固定 MCP 错误。未启动浏览器，未运行安装包构建，未执行提交或推送。

## 结论

原先确有英文遗漏，集中在启动诊断、工具及附件界面、渠道说明，以及后端直接返回的中文错误和媒体状态。已补齐固定产品文案的主要链路，并增加可重复运行的语言检查。

当前前端字典有 821 个键，中英文键、插值参数一致，无空值、重复键或英文中的固定中文。Runtime 共 254 条双语消息，覆盖媒体、Skill、浏览器工具、附件、文件预览、默认子代理及 MCP 登录失效提示。

这属于源码、协议和自动化测试的检查结果；没有进行窗口视觉验收，不能据此保证所有英文长文案在真实窗口尺寸下的排版效果。

## 检查结果与修复

| 范围 | 结果 |
| --- | --- |
| 语言设置 | 检查 `auto / zh-CN / en`、系统语言偏好顺序、显式语言选择、实时切换、存储读取异常回退和 `html.lang`；存储写入被拒时仍可在当前窗口切换，后续存储事件恢复跨窗口同步 |
| 启动页 | 加载占位、脚本失败和 CSP 诊断均按保存的语言显示；启动字典从正式字典生成并校验一致性 |
| 主界面与设置 | 检查会话、侧栏、Goal、模型、MCP、权限、技能、浏览器、Reach 渠道、工具卡、图片/附件、图表、差异、来源和耗时文案 |
| 渠道数据 | 16 个内置渠道提供英文显示信息；测试覆盖 32 种连接/凭据状态组合，保持渠道 ID 和工具名不变 |
| Runtime 错误 | 中文错误从调用位置移入双语消息表；稳定 code 和 values 可随错误传递，前端在接收时依据当前语言显示；桌面断连、退出和元数据超时提示也接入字典 |
| 并发会话 | 普通桌面命令和绕过 store.send 的模型元数据请求均传入当前 locale；AsyncLocalStorage 隔离异步任务、工具和子代理的语言上下文，避免并发会话串语言 |
| 媒体链路 | 补齐 Gemini/OpenAI 音视频、下载、画面/声音提取、转写、媒体生成和文件保存的固定状态及错误 |
| 默认子代理 | 新的未编辑默认名称/指令带语言键，界面和执行层均可切换；修改模型等配置时保留未改动文案的语言键 |
| 原生功能 | 文件选择器/图片保存标题、附件/图片预览/文件预览/图片保存错误、托盘菜单、完成通知接入本地化；文件预览的路径、文件类型和范围错误使用结构化 code，保留系统诊断 |
| 外部诊断 | 系统和服务商错误保留原始细节；未知的新错误码保留 fallback 消息，避免显示 `[object Object]` |

前端 JSX 静态扫描剩余 28 个显示候选，逐项核对为品牌名、快捷键、单位、API 字段和技术格式，例如 Qone、MCP、SKILL.MD、access_token、WIDTHxHEIGHT。Runtime 的中文字符串扫描除渠道双语来源、系统指令和代码注释外，未发现剩余直接返回的中文错误字串。

最终增补核查发现并修复两条绕过公共语言机制的路径：原生文件预览曾直接返回三个中文错误，模型元数据曾直接发送不含 locale 的 Runtime 命令。增加原生错误码与字典/前端映射的一致性检查，以及实际捕获中英文元数据请求的回归测试；传入旧 locale 的调用参数不会覆盖当前界面选择。

## 主要改动文件

- `apps/desktop/src/localization.ts`、`locale-core.ts`、`i18n/en.ts`、`i18n/zh-CN.ts`：语言解析、同步和正式字典。
- `apps/desktop/public/boot-locale.js`、`startup-diagnostics.js`、`scripts/generate-boot-locale.ts`、`scripts/audit-localization.ts`：启动语言和静态扫描。
- `packages/protocol/src/localized-error.ts`、`runtime-copy.ts`、`runtime-copy-core.ts`、`subagent-copy.ts`、`index.ts`：消息表、错误标识、locale 和默认子代理语言键。
- `apps/agent-runtime/src/runtime-localization.ts`、`index.ts`、`file-preview.ts`、媒体/附件/技能/浏览器相关模块：运行时语言上下文、状态与错误本地化。
- `apps/desktop/src/lib/error-localization.ts`、`subagent-profile-copy.ts`、`store.ts`、`store-bridge.ts` 和相关组件：请求语言、结构化错误及默认文案显示。
- `apps/desktop/src-tauri/src/native_error.rs`、`native_copy.rs`、`main.rs`：原生错误和菜单/通知文案。
- `packages/mcp/src/auth-error.ts`：登录失效错误的稳定标识。
- `apps/desktop/test/localization.test.tsx`、`chat-run-error.test.ts`、`apps/agent-runtime/test/runtime-localization.test.ts`、`file-preview.test.ts`：专项测试和防遗漏检查。

工作树存在其他并行修改；以上列出语言任务相关位置，不把整个工作树 diff 都归为本次语言改动。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 桌面全部 86 个测试文件，逐文件独立进程运行 | 478 pass，0 failed files |
| Runtime 全套 51 个测试文件 | 268 pass，0 fail |
| Runtime 语言及文件预览专项 | 14 pass，0 fail，包含真实 NDJSON Runtime 同时接收中英文请求并返回对应错误及稳定 code |
| 最终桌面语言专项 | 12 pass，0 fail；覆盖未知错误码回退、原生错误映射和存储写入拒绝 |
| 最终桌面桥接专项 | 29 pass，0 fail；覆盖普通命令与元数据请求均跟随当前语言，以及断连提示 |
| Desktop / Runtime TypeScript 检查 | 通过 |
| `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --offline` | 通过 |
| `bun run --cwd apps/desktop build` | 通过，仅前端构建；有依赖注释和大 chunk 等构建警告 |
| 启动字典 `--check` / `git diff --check` | 通过 |

桌面测试在同一进程合并运行时出现 7 项失败和 2 个加载错误，涉及压缩流程、图片预览和 Lexical 模块。逐文件独立运行全部通过；合并运行还有 Tauri mock 缺少导出的加载冲突。这是目前测试执行方式的限制，未为本次语言任务重写测试基础设施。

## 保留原文的边界

- 用户输入、文件名、项目名、模型/服务自定义名称、用户编辑过的子代理说明和第三方内容不会自动翻译。
- 历史会话、历史工具结果和历史错误保持生成时的语言。
- 旧版已保存的子代理配置没有默认文案语言键，无法可靠区分产品默认值与用户自定义内容，因此不依据中文字符串猜测并覆盖。新生成的默认配置带明确语言键。
- 已发起运行的工具文案使用该次请求的语言；切换界面语言不会改写正在运行任务及历史记录的自然语言内容。结构化错误在接收/调用 `localizeError` 时按当前语言显示；已保存为字符串的错误不会在切换后追溯翻译。
- AI 自由生成回复及服务商/操作系统返回的诊断不属于固定 UI 字典，保留实际返回内容。
- 部分底层开发诊断仍使用英文，例如无效协议 ID、缺失工作区、代码预览依赖错误及不支持的平台。它们不会导致英文界面漏出固定中文，但中文界面仍可能显示英文技术细节，因此不能宣称所有诊断均已双语化。
- 存储不可写时的语言选择仅在当前窗口生效，重启后按原保存设置或系统语言恢复。
- 英文长文案的视觉排版与原生菜单/通知的实际显示留给用户运行 `bun run --cwd apps/desktop tauri dev` 验收。

无凭据或授权阻塞。上述历史内容、第三方内容和视觉验收边界仍然存在，不能将结果表述为“任何地方都不可能出现中文”。
