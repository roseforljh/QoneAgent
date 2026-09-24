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

## 外部发布配置

Updater 插件和设置页入口已经接入。正式打包时通过构建环境变量注入配置，仓库内不保存具体发布服务器地址：

```powershell
$env:QONE_UPDATER_PUBKEY = "你的 updater 公钥"
$env:QONE_UPDATER_ENDPOINT = "https://你的域名/updates/{{target}}/{{arch}}/{{current_version}}"
bun run --cwd apps/desktop tauri:build
```

`QONE_UPDATER_PUBKEY` 只能填公钥，不能填签名私钥；`QONE_UPDATER_ENDPOINT` 必须是实际提供更新 JSON 和安装包的 HTTPS 地址。未设置变量时会沿用空配置，应用仍可构建和启动，但不会检查真实更新。

模型会话只注册 Pi 的文件与 PowerShell 工具以及已连接的 MCP 工具；Skill 由 Pi 加载。浏览器能力可通过 CLI 或 MCP 提供。
