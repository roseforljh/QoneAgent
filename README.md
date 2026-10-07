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
- `system-prompts/01-identity.md` 至 `08-communication.md`：固定 System Prompt 的八个源码模块
- `skills/builtin/`、`skills/installed/`、`skills/cache/`：内置 Skill、用户安装的 Skill 和下载缓存
- `plugins/installed/`、`plugins/cache/`、`plugins/data/`：插件代码、缓存和私有数据
- `projects/<项目>/project.json`：项目名称与源码位置；源码保留在原目录
- `projects/<项目>/sessions/<会话>/session.json`：会话元信息
- `projects/<项目>/sessions/<会话>/attachments/`、`artifacts/`：会话资源与生成媒体；用户本地附件保留原路径
- `logs/runtime.log`：结构化运行日志
- `cache/`：临时缓存
- API Key 和 MCP OAuth Token：Windows Credential Manager

内置 Ponytail 包含 `ponytail`、`ponytail-review`、`ponytail-audit`、`ponytail-debt`、`ponytail-gain`、`ponytail-help` 六个技能，设置页按技能包显示。一级技能包卡片提供批量开关和检查更新，检查更新会更新包内全部技能并保留各自开关状态；总开关关闭全部技能，重新开启则启用全部技能。单击卡片主体打开二级技能面板，每个技能只有独立开关，部分开启时一级卡片显示“部分启用”。内置技能禁止删除或同名覆盖。输入 `/` 后先选择技能包进入子菜单，再选择具体技能生成标签，可通过返回按钮或 Backspace 回到上级。设置、技能 Dock、输入框菜单及选中的技能标签共用官方 Logo；关闭的技能不会进入菜单或模型技能清单。已有主技能的开关和版本配置保持不变，新增技能默认启用。

测试时可用 `QONE_DATA_DIR`、`QONE_DB`、`QONE_LOG_DIR` 覆盖数据、数据库和日志路径。

项目、消息、会话和运行索引由 `runtime/qone.db` 保存。`project.json`、`session.json` 是目录说明，由数据库重建。配置和 MCP 使用各自目录内的 SQLite 数据库；原统一数据库内的配置在启动时迁入对应数据库，不保留旧路径回退读取。Skill 安装内容和缓存、插件代码和私有数据使用各自的目录。插件加载模块已有目录支持，主运行时尚未启用插件执行。

全局提示词只从数据根目录的 `Qone.md` 读取，项目规则读取选定工作区根目录的 `AGENTS.md` 等 Pi 支持文件，不向用户目录或其他父目录扫描。桌面和运行时都按同一个 `QONE_DATA_DIR` 解析目录，WebView 数据路径与源码、安装位置无关。启用内置 `ponytail` 时，运行时会在项目根目录的 `AGENTS.md` 中维护带标记的 Ponytail 提示词区块；文件不存在会自动创建，关闭时只移除该区块并保留项目原有规则。

新的 `Qone.md` 默认包含 Ponytail 全局规则，默认内容维护在 `apps/agent-runtime/src/default-global-instructions.md` 并随运行时打包，后续默认规则可继续追加到该文件。初始化只创建缺失文件，已有文字和主动清空的文件都不会被覆盖，也不会在每次启动时重复追加。Ponytail 小节受内置技能开关约束；关闭时运行时会在全局指导后明确要求忽略该小节，其他全局规则继续适用。技能更新按钮只更新技能文件，不覆盖用户维护的 `Qone.md`。修改全局提示词后重启开发运行时，以刷新已存在的会话。

固定 System Prompt 与 `Qone.md` 分开。运行时按 Identity → Behavior → Execution → Web Access → Coding → Verification → Safety → Communication 的显式顺序读取八个 Markdown 文件，统一换行并以两个换行拼接，作为 Pi 自定义 System Prompt 的首段；用户指导、项目规则、技能及工具上下文仍由现有机制放在后续部分。安装时从随运行时打包的 Markdown 创建缺失模块，保留已有内容；空白或不可读的模块会报错，额外文件不参与加载。相同版本和模块内容产生相同的固定前缀；完整请求仍会随任务上下文改变，实际缓存命中由模型服务决定。修改模块后重启开发运行时以刷新已存在的会话。

## Qone 内置浏览器与 OpenCLI

应用页的“浏览器”是 Qone 自己的 WebView2，数据目录位于 `.qone/runtime/webview/`。用户在这里登录后，登录态由 WebView2 持久保存；OpenCLI 和浏览器自动化共用这一浏览器数据目录。

OpenCLI 的站点适配器通过 Qone 注入的 CDP 目标运行。Qone 不会让 OpenCLI 自动连接或启动用户本机的 Chrome、Edge 或其他外置浏览器；如果内置 CDP 目标不可用，任务直接失败并报告原因。`qone_opencli_discover` 的站点列表只读取适配器注册表，不需要启动浏览器。

用户主动点击浏览器页面的“在外置浏览器中打开”按钮时，才会调用系统默认浏览器；这与 OpenCLI 的自动执行链路分开。完整命令注册表只在运行时缓存，不会全部注入模型上下文。

## 外部发布配置

Updater 插件和设置页入口已经接入。正式打包时通过构建环境变量注入配置，仓库内不保存具体发布服务器地址：

```powershell
$env:QONE_UPDATER_PUBKEY = "你的 updater 公钥"
$env:QONE_UPDATER_ENDPOINT = "https://你的域名/updates/{{target}}/{{arch}}/{{current_version}}"
bun run --cwd apps/desktop tauri:build
```

`QONE_UPDATER_PUBKEY` 只能填公钥，不能填签名私钥；`QONE_UPDATER_ENDPOINT` 必须是实际提供更新 JSON 和安装包的 HTTPS 地址。未设置变量时会沿用空配置，应用仍可构建和启动，但不会检查真实更新。

模型会话只注册 Pi 的文件与 PowerShell 工具以及已连接的 MCP 工具；Skill 由 Pi 加载。浏览器能力可通过 CLI 或 MCP 提供。
