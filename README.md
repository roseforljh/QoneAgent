# QoneAgent

基于 Pi 1.5.2（`@earendil-works/pi-*`）、Bun、React/Vite 和 Electron 45 的 Windows Desktop Agent。

## 开发与验证

```powershell
bun install --frozen-lockfile
bun run dev                                  # 同时启动 agent-runtime 与 Electron 桌面
bun test apps/agent-runtime/test
bun test apps/desktop/test
bun run --cwd apps/agent-runtime typecheck
bun run --cwd apps/desktop build:release
bun run apps/agent-runtime/test/smoke.ts
```

`build:release` 把 agent-runtime 打包为 `apps/desktop/binaries/qone-runtime.mjs`（由 Electron 以 Node 模式运行，不附带独立 JS 运行时），准备 OpenCLI、yt-dlp、uv、B 站 CLI、FFmpeg 和 PSReadLine，再用 electron-builder 打出 NSIS 安装包到 `apps/desktop/release/`。FFmpeg 由 `scripts/build-ffmpeg.sh` 从官方源码构建精简 LGPL 版本，Windows 上通过 WSL（Debian/Ubuntu）交叉编译。`binaries/` 和 `release/` 已被 Git 忽略。

开发版和安装版共用同一个 Electron userData 目录：safeStorage 的加密密钥按 userData 区分，分开会导致两边存下的凭据互相解不开。

## 运行时数据

默认保存到 Windows 用户目录 `C:\Users\<用户名>\.qone\`：

- `runtime/qone.db`：SQLite 索引和持久化数据
- `settings.json`：模型、MCP、权限和偏好的唯一配置源，用户和 AI 均可直接编辑，保存后自动生效
- `config/state.json`：MCP 图标、MCP 工具目录缓存和 Claude Code 同步状态等内部缓存
- `auth/secrets.enc.json`：API Key、MCP OAuth Token 和 MCP 环境变量，由 Electron safeStorage（Windows DPAPI）加密；系统加密不可用时退回本机 AES-256-GCM
- `auth/ssh/`：服务器连接使用的私钥
- `runtime/window-state.json`：窗口尺寸和位置
- `Qone.md`：全局提示词，直接放在数据根目录
- `system-prompts/01-identity.md` 至 `08-communication.md`：固定 System Prompt 的八个源码模块
- `skills/builtin/`、`skills/installed/`、`skills/cache/`：内置 Skill、用户安装的 Skill 和下载缓存
- `plugins/installed/`、`plugins/cache/`、`plugins/data/`：插件代码、缓存和私有数据
- `projects/<项目>/project.json`：项目名称与源码位置；源码保留在原目录
- `projects/<项目>/sessions/<会话>/session.json`：会话元信息
- `projects/<项目>/sessions/<会话>/attachments/`、`artifacts/`：会话资源与生成媒体；用户本地附件保留原路径
- `logs/runtime.log`：结构化运行日志
- `cache/`：临时缓存

内置 Ponytail 包含 `ponytail`、`ponytail-review`、`ponytail-audit`、`ponytail-debt`、`ponytail-gain`、`ponytail-help` 六个技能，设置页按技能包显示。一级技能包卡片提供批量开关和检查更新，检查更新会更新包内全部技能并保留各自开关状态；总开关关闭全部技能，重新开启则启用全部技能。单击卡片主体打开二级技能面板，每个技能只有独立开关，部分开启时一级卡片显示“部分启用”。内置技能禁止删除或同名覆盖。输入 `/` 后先选择技能包进入子菜单，再选择具体技能生成标签，可通过返回按钮或 Backspace 回到上级。设置、技能 Dock、输入框菜单及选中的技能标签共用官方 Logo；关闭的技能不会进入菜单或模型技能清单。已有主技能的开关和版本配置保持不变，新增技能默认启用。

测试时可用 `QONE_DATA_DIR`、`QONE_DB`、`QONE_LOG_DIR` 覆盖数据、数据库和日志路径。

项目、消息、会话和运行索引由 `runtime/qone.db` 保存。`project.json`、`session.json` 是目录说明，由数据库重建。配置只保存在 `settings.json`，不再与数据库双向同步，也不创建配置数据库或执行旧库迁移。直接在主对话中要求安装 MCP、安装 Skill 或修改参数，AI 会通过文件操作完成，客户端监听文件并刷新列表和后续运行的会话；正在执行的任务不被强制打断。Skill 安装内容和缓存、插件代码和私有数据使用各自的目录。插件加载模块已有目录支持，主运行时尚未启用插件执行。

全局提示词只从数据根目录的 `Qone.md` 读取，项目规则读取选定工作区根目录的 `AGENTS.md` 等 Pi 支持文件，不向用户目录或其他父目录扫描。桌面和运行时都按同一个 `QONE_DATA_DIR` 解析目录，内置浏览器与源码、安装位置无关。启用内置 `ponytail` 时，运行时会在项目根目录的 `AGENTS.md` 中维护带标记的 Ponytail 提示词区块；文件不存在会自动创建，关闭时只移除该区块并保留项目原有规则。

新的 `Qone.md` 默认包含 Ponytail 全局规则，默认内容维护在 `apps/agent-runtime/src/default-global-instructions.md` 并随运行时打包，后续默认规则可继续追加到该文件。初始化只创建缺失文件，已有文字和主动清空的文件都不会被覆盖，也不会在每次启动时重复追加。Ponytail 小节受内置技能开关约束；关闭时运行时会在全局指导后明确要求忽略该小节，其他全局规则继续适用。技能更新按钮只更新技能文件，不覆盖用户维护的 `Qone.md`。修改全局提示词、在 `skills/installed/` 安装或删除技能后自动刷新，无需重启。

固定 System Prompt 与 `Qone.md` 分开。运行时按 Identity → Behavior → Execution → Web Access → Coding → Verification → Safety → Communication 的显式顺序读取八个 Markdown 文件，统一换行并以两个换行拼接，作为 Pi 自定义 System Prompt 的首段；用户指导、项目规则、技能及工具上下文仍由现有机制放在后续部分。安装时从随运行时打包的 Markdown 创建缺失模块，保留已有内容；空白或不可读的模块会报错，额外文件不参与加载。相同版本和模块内容产生相同的固定前缀；完整请求仍会随任务上下文改变，实际缓存命中由模型服务决定。修改模块后重启开发运行时以刷新已存在的会话。

## MCP 服务

MCP 默认按需启动，不对应常驻进程：

- 启动时只读 `config/state.json` 里的工具目录缓存，命中的服务处于“待命”，不拉进程、不恢复凭据。
- 缓存缺失的服务在后台发现一次工具：stdio 服务逐个排队，HTTP/SSE 并行；发现完立即关闭从未被实际使用的 stdio 连接。
- Agent 第一次调用某个服务的工具，或用户手动点“连接/重连”时，才真正启动进程并恢复加密凭据；同一服务的并发调用共用一次握手。
- 进程启动后保持到应用退出，不做空闲自动回收，避免关掉浏览器页面、调试上下文等有状态数据。进程意外退出后，下一次调用会自动重连。
- MCP、SSH 服务器、B 站/抖音等媒体应用和公开 Web 数据工具的定义默认不注入模型上下文，通过 `tool_search` 或 codemode 按需装载；核心文件、PowerShell、子代理、记忆和目标工具始终可用。

设置页每张卡片显示当前状态：待命、已连接、连接中、未连接。禁用或删除服务会同时撤销工具可用性并清除目录缓存。

## Qone 内置浏览器与 OpenCLI

应用页的“浏览器”是 Qone 自己的 Electron `WebContentsView`，登录态保存在应用会话中，与源码和安装位置无关。OpenCLI 和浏览器自动化共用这一浏览器和 CDP 目标。

OpenCLI 的站点适配器通过 Qone 注入的 CDP 目标运行。Qone 不会让 OpenCLI 自动连接或启动用户本机的 Chrome、Edge 或其他外置浏览器；如果内置 CDP 目标不可用，任务直接失败并报告原因。`qone_opencli_discover` 的站点列表只读取适配器注册表，不需要启动浏览器。

用户主动点击浏览器页面的“在外置浏览器中打开”按钮时，才会调用系统默认浏览器；这与 OpenCLI 的自动执行链路分开。完整命令注册表只在运行时缓存，不会全部注入模型上下文。

## 更新与发布

应用内更新读取 GitHub Releases（默认仓库 `roseforljh/QoneAgent`，可用 `QONE_UPDATE_REPO` 覆盖），支持断点续传下载，Windows 下静默安装并在下载完成后提示重启。

正式发布走 `.github/workflows/release.yml` 手动触发：构建 FFmpeg 和 Windows 安装包，自动递增补丁版本号、打 tag，并把 `apps/desktop/release/*.exe` 上传到 GitHub Release。

```powershell
bun run --cwd apps/desktop build:release    # 本机打包，不发布
```
