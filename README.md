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

默认保存到 Windows `%APPDATA%\QoneAgent\`：

- `agent.db`：SQLite 持久化数据
- `artifacts/`：截图和下载的文件
- `logs/runtime.log`：结构化运行日志
- API Key 和 MCP OAuth Token：Windows Credential Manager

可用 `QONE_DB`、`QONE_LOG_DIR`、`QONE_ARTIFACTS_DIR` 覆盖测试路径。

## OpenCLI 当前浏览器

应用页的“OpenCLI 当前浏览器”通过 OpenCLI Browser Bridge 直接连接用户的 Chrome。AI 直接读取页面并执行导航、点击、输入、等待和提取操作，复用 Chrome 当前登录态，不复制 Cookies，也不创建 Qone 独立浏览器。程序启动不会自动连接；点击连接按钮或 AI 首次调用浏览器工具时才建立连接。

首次使用需要安装 Node.js 20.18.1 或更高版本和 OpenCLI Browser Bridge 扩展。Chrome 已打开时，Qone 绑定现有标签页；Chrome 未打开时，Qone 会尝试启动默认 Chrome 配置并绑定空白标签页，再导航到目标网址。每次 AI 任务结束后会解除绑定，不关闭用户的 Chrome 页面。Chrome、Edge、Brave 和 Firefox 的书签、浏览历史仍从本机配置读取并保存到 Qone 数据库，AI 可搜索这些记录。

## 外部发布配置

Updater 插件和设置页入口已经接入。正式打包时通过构建环境变量注入配置，仓库内不保存具体发布服务器地址：

```powershell
$env:QONE_UPDATER_PUBKEY = "你的 updater 公钥"
$env:QONE_UPDATER_ENDPOINT = "https://你的域名/updates/{{target}}/{{arch}}/{{current_version}}"
bun run --cwd apps/desktop tauri:build
```

`QONE_UPDATER_PUBKEY` 只能填公钥，不能填签名私钥；`QONE_UPDATER_ENDPOINT` 必须是实际提供更新 JSON 和安装包的 HTTPS 地址。未设置变量时会沿用空配置，应用仍可构建和启动，但不会检查真实更新。

模型会话只注册 Pi 的文件与 PowerShell 工具以及已连接的 MCP 工具；Skill 由 Pi 加载。浏览器能力可通过 CLI 或 MCP 提供。
