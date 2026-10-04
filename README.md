# QoneAgent

基于 Pi 0.86.0、Bun、React/Vite 和 Tauri 2 的 Windows Desktop Agent。

## 开发与验证

```powershell
bun install --frozen-lockfile
bun test apps/agent-runtime/test
bun run --cwd apps/agent-runtime typecheck
bun run --cwd apps/desktop build:release
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
bun run apps/agent-runtime/test/smoke.ts
```

`build:release` 会编译 `qone-runtime` Bun sidecar，再构建前端。生成的 sidecar 位于 `apps/desktop/src-tauri/binaries/`，已被 Git 忽略。

## 运行时数据

默认保存到 Windows 用户目录 `C:\Users\<用户名>\.qone\`：

- `runtime/qone.db`：SQLite 索引和持久化数据
- `config/settings.db`：模型配置、全局设置和权限
- `mcp/servers.db`：MCP 服务配置；凭据仍保存在 Windows Credential Manager
- `runtime/window-state.json`、`runtime/webview/`：窗口状态和 WebView 数据
- `Qone.md`：全局提示词，直接放在数据根目录
- `system-prompts/01-identity.md` 至 `07-communication.md`：固定 System Prompt 的七个源码模块
- `skills/builtin/`、`skills/installed/`、`skills/cache/`：内置 Skill、用户安装的 Skill 和下载缓存
- `plugins/installed/`、`plugins/cache/`、`plugins/data/`：插件代码、缓存和私有数据
- `projects/<项目>/project.json`：项目名称与源码位置；源码保留在原目录
- `projects/<项目>/sessions/<会话>/session.json`：会话元信息
- `projects/<项目>/sessions/<会话>/attachments/`、`artifacts/`：会话资源与生成媒体；用户本地附件保留原路径
- `logs/runtime.log`：结构化运行日志
- `cache/`：临时缓存
- API Key 和 MCP OAuth Token：Windows Credential Manager

测试时可用 `QONE_DATA_DIR`、`QONE_DB`、`QONE_LOG_DIR` 覆盖数据、数据库和日志路径。

项目、消息、会话和运行索引由 `runtime/qone.db` 保存。`project.json`、`session.json` 是目录说明，由数据库重建。配置和 MCP 使用各自目录内的 SQLite 数据库；原统一数据库内的配置在启动时迁入对应数据库，不保留旧路径回退读取。Skill 安装内容和缓存、插件代码和私有数据使用各自的目录。插件加载模块已有目录支持，主运行时尚未启用插件执行。

全局提示词只从数据根目录的 `Qone.md` 读取，项目规则读取选定工作区根目录的 `AGENTS.md` 等 Pi 支持文件，不向用户目录或其他父目录扫描。桌面和运行时都按同一个 `QONE_DATA_DIR` 解析目录，WebView 数据路径与源码、安装位置无关。

固定 System Prompt 与 `Qone.md` 分开。运行时按 Identity → Behavior → Execution → Coding → Verification → Safety → Communication 的显式顺序读取七个 Markdown 文件，统一换行并以两个换行拼接，作为 Pi 自定义 System Prompt 的首段；用户指导、项目规则、技能及工具上下文仍由现有机制放在后续部分。安装时从随运行时打包的 Markdown 创建缺失模块，保留已有内容；空白或不可读的模块会报错，额外文件不参与加载。相同版本和模块内容产生相同的固定前缀；完整请求仍会随任务上下文改变，实际缓存命中由模型服务决定。修改模块后重启开发运行时以刷新已存在的会话。

## OpenCLI 当前浏览器

应用页的“OpenCLI 当前浏览器”通过 OpenCLI Browser Bridge 直接连接用户的 Chrome。AI 直接读取页面并执行导航、点击、输入、等待和提取操作，复用 Chrome 当前登录态，不复制 Cookies，也不创建 Qone 独立浏览器。程序启动不会自动连接；点击连接按钮或 AI 首次调用浏览器工具时才建立连接。

首次使用需要安装 Node.js 20.18.1 或更高版本和 OpenCLI Browser Bridge 扩展。Chrome 已打开时，Qone 绑定现有标签页；Chrome 未打开时，只有需要登录态或页面操作的适配器才会按 OpenCLI 的规则启动浏览器上下文。支持公共 API 的适配器直接发 HTTP 请求，不打开浏览器。任务结束时只关闭 Qone 自己启动的标签页，用户原本打开的 Chrome 不会被关闭。

Qone 接入 OpenCLI 的完整站点适配器入口。AI 可先按站点按需发现命令，再通过通用入口执行 Twitter/X、Bilibili、小红书、GitHub 等 OpenCLI 适配器；OpenCLI 自己决定使用公共 HTTP、Cookie 请求、网络拦截还是页面操作。完整命令注册表只在运行时缓存，不会全部注入模型上下文。Chrome、Edge、Brave 和 Firefox 的书签、浏览历史仍从本机配置读取并保存到 Qone 数据库，AI 可搜索这些记录。

## 外部发布配置

Updater 插件和设置页入口已经接入。正式打包时通过构建环境变量注入配置，仓库内不保存具体发布服务器地址：

```powershell
$env:QONE_UPDATER_PUBKEY = "你的 updater 公钥"
$env:QONE_UPDATER_ENDPOINT = "https://你的域名/updates/{{target}}/{{arch}}/{{current_version}}"
bun run --cwd apps/desktop tauri:build
```

`QONE_UPDATER_PUBKEY` 只能填公钥，不能填签名私钥；`QONE_UPDATER_ENDPOINT` 必须是实际提供更新 JSON 和安装包的 HTTPS 地址。未设置变量时会沿用空配置，应用仍可构建和启动，但不会检查真实更新。

模型会话只注册 Pi 的文件与 PowerShell 工具以及已连接的 MCP 工具；Skill 由 Pi 加载。浏览器能力可通过 CLI 或 MCP 提供。
