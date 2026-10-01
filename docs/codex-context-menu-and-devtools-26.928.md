# Codex 26.928 开发工具与组件右键处理：静态调查和 Qone 实施记录

## 结果

Qone 已对主窗口、内嵌浏览器和 HTML 预览统一限制开发工具入口：关闭 WebView DevTools、显式拒绝 Tauri 的内部切换命令，并在文档初始化时捕获 F12 和 Tauri 的检查器快捷键。

Windows 原生右键菜单按目标保留操作。空白处不显示浏览器菜单；输入框保留编辑操作；选区保留复制；链接和图片保留原生复制操作，图片保留另存为。检查元素、查看源码、打印、页面另存为、刷新和浏览器新窗口等菜单项被移除。页面自己的组件菜单仍能处理右键。

组件调查已完成，规则和证据见下表。本次组件部分交付静态调查与 Qone 对照，业务菜单功能仍由项目现有组件负责。

## 样本与调查边界

- 安装目录：`C:/Program Files/WindowsApps/OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0/app`。
- 共享 Owl 壳中存在 `ChatGPT.exe` 和 `Codex.exe`；`owl-app.ini` 的数据目录为 Codex，`owl-electron-app.json` 指向 Codex 打包产物。
- `app.asar/package.json`：`openai-codex-electron`、产品 Codex、版本 `26.928.21956`、构建渠道 `prod`、构建号 `12404`。
- ASAR SHA256：`FB7B2EE791BCBDB3C4A6375E9FEC8FB404F3EAFF995F0D293227354B298AFF49`。
- 共用前端资源包含 ChatGPT 会话、文档和图片组件；这些源码可以静态比较，不代表已经验证独立 ChatGPT 客户端的运行表现。
- 本机 WebView2 Runtime 注册版本为 `154.0.4258.37`。

调查只读取本地安装资源，解析 ASAR 和 TypeScript AST，没有执行目标源码、启动目标客户端、Hook 或启动浏览器验收。翻译字典中的菜单名称仅作定位，实际结论以事件处理和菜单生成函数为依据。

证据目录为 `work/codex-context-menu-26-928/evidence/`：

- `sample.json`：样本身份、哈希和直接跟进的导入文件。
- `shell-manifest.json`、`renderer-manifest.json`：源文件路径、哈希及搜索上下文；其中 `offset` 是 Python 的 Unicode 字符索引。
- `functions/<bundle>/manifest.json`：提取函数的 `startUtf16` 和 `endUtf16`。这两个位置是 TypeScript 使用的 UTF-16 索引，不能与上述索引混用。
- `functions/`：原始 AST 打印后的函数，便于核对分支，不改变逻辑。

提取脚本为 `work/codex-context-menu-26-928/extract.py` 和 `functions.mjs`。前者读取 archive，后者从指定 bundle 提取指定函数；目标代码不会被导入执行。

## 开发工具的实际控制

`build-flavor-IWwoo-v9.js` 的 `allowDevtools` 调用 `isInternal`。`src-ghAWefM3.js` 的内部渠道集合为 `dev`、`agent`、`nightly`、`internal-alpha`，生产渠道不在集合中。

主进程把该结果传入窗口管理器的 `allowDevtools`，主窗口的 `webPreferences.devTools` 使用该值；应用菜单的 `toggleDevTools` 项也由该值控制。原生右键的 `showInspectElement` 使用另外一个 `allowInspectElement` 值；启动逻辑只在 `dev` 和 `agent` 渠道启用它。

内嵌 guest WebView 有单独的策略。例如 `main-DkWgQSQe.js` 的 `NW` 明确设定 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`，同时设置 `devTools=true`。因此不能把主窗口的生产策略概括为“所有 WebView 都关闭开发工具”。Qone 按本次要求统一覆盖主窗口和子 WebView。

## 通用右键菜单与组件菜单

Codex 主窗口通过 `electron-context-menu` 注册通用原生菜单。`installNativeContextMenu` 为图片追加复制、保存和可用时的文件定位，`GXe` 根据 `isEditable`、选区、链接和媒体类型生成编辑菜单。

Windows 通用模板还可能保留全选，选区可出现搜索操作；Qone 的限制采用本次要求的较小菜单集合。菜单项的显示、启用状态和真正的复制粘贴执行都来自原生引擎。

业务组件共用 `app-shared-a906948d8868.js` 的 `kyi`，导出别名为 `KS`。它支持鼠标右键、键盘菜单键和 Shift+F10，接受 `items` 或异步 `getItems`。有 Electron bridge 时调用 `showContextMenu`，否则使用页面菜单。

这个函数先调用子组件原有处理器，尊重 `defaultPrevented`，再决定是否打开业务菜单。异步加载期间再次按下指针、再次右键、按 Escape 或窗口失焦会取消；菜单为空时不会打开。菜单关闭后恢复仍然存在的焦点元素，并检查选中项是否启用。

当前样本编译后的 `preserveBrowserContextMenu` 计算为 `s && false`。即使调用方传入该参数，也不能据此声称当前构建会保留浏览器菜单。

## 组件规则与 Qone 对照

| 组件或区域 | 样本中可核对的处理 | Qone 当前对应行为 |
| --- | --- | --- |
| 空白页面 | 通用原生模板按目标生成，Windows 模板含全选等条件项 | 移除浏览器操作；无可用复制或编辑项时不显示菜单 |
| 输入框、重命名框、Lexical 编辑区 | 原生壳按 `isEditable` 生成剪切、复制、粘贴；消息动作菜单明确排除 `input`、`textarea`、`select` 和 `contenteditable=true` | 保留原生编辑项和引擎启用状态；复制粘贴快捷键及输入法事件继续传播 |
| 普通文本选区 | 原生菜单按选区提供复制；代码菜单在打开时读取选区 | 原生选区复制仍可用，不以全局 DOM 右键拦截取代选区处理 |
| 侧栏本地会话 | `rTo` 使用共同的菜单生成链，右键额外读取 Git/工作树状态；`oho` 在多选时限制可批量执行的操作，包含固定、取消固定、归档及已读状态 | 现有 `SidebarEntityMenu` 和 assistant-ui 更多菜单负责固定、重命名、删除；这些动作及其确认流程保持可用 |
| ChatGPT 会话侧栏 | `Ues` 按会话权限和忙碌状态控制固定、重命名、分享、归档及删除；重命名要求非空并裁剪空白，删除有确认界面 | 当前 Qone 会话菜单继续使用自己的状态和删除确认，不从翻译文本推断权限 |
| 项目行 | `Has` 按本地/远程项目及可用回调生成固定、编辑项目、文件管理器定位、工作树新会话、连接编辑、批量已读/归档、分区移动及移除项目 | Qone 项目更多菜单继续使用现有工作区动作；普通行不会出现 WebView 默认浏览器菜单 |
| 标签页与分区 | `qHr` 把页签包在共同菜单触发器里；`tab-context-menu` 的 `O` 按布局和能力生成移到左、右、底部的操作；底部能力涉及终端区域 | 原有 Dock 标签和更多按钮操作继续工作；原生限制覆盖动态创建的子 WebView |
| 文件引用和文件树 | `rla` 异步加载打开目标与 GitHub 定位，`ila` 按宿主能力生成预览、打开方式、保存副本、复制路径/内容、文件管理器定位；`gra` 根据树的状态决定是否接管右键 | Qone 的文件链接、预览和文件操作仍由现有组件及原生命令负责；文本选区复制保留 |
| 代码及 diff | `use-code-diff-context-menu` 的 `Ne` 生成请求修改、打开目标、新标签、GitHub、复制路径/相对路径、切换换行；“复制选区”在每次打开时读取当前选区并更新启用状态 | Qone 保留代码选区的原生复制和现有代码工具按钮；该调查没有新增请求修改或 GitHub 操作 |
| 普通图片 | 壳的 `installNativeContextMenu` 增加复制、保存；只有能解析成本地文件时才提供文件定位，保存还有主框架条件 | 原生图片复制、地址复制和另存为保留；检查器和浏览器新窗口项被过滤 |
| 生成图片、图片侧栏 | `Se` 按图片能力提供新标签、地址复制、添加到会话、图片复制、文件定位及下载副本；图片侧栏在编辑或点击非图片目标时阻止父菜单接管 | 现有图库、附件和图片操作继续负责业务能力；原生层提供必要图片操作 |
| Mini 消息动作 | `context-menu-58f1f3f247c7.js` 的 `ne` 仅在提供回复或反应回调时启用；支持菜单键/Shift+F10，避开编辑控件，图片动作还检查下载能力 | 作为该样本特定表面的调查结果记录，Qone 的消息动作继续由现有 assistant-ui 组件处理 |
| 终端 | `xterm-display-helpers` 注册自己的 `contextmenu` 处理，将隐藏 textarea 和选择状态准备好再交给原生输入流程 | 不吞掉终端的右键事件或 Ctrl+Shift+C/V；现有终端输入与复制粘贴路径保留 |
| 提示、悬浮预览、菜单内容 | 标签缩略图在右键时清理 hover；`q3o` 的 `onContextMenuCapture` 清理悬浮计时和状态 | 项目现有提示层右键关闭逻辑仍能收到事件；已有弹层和组件菜单的传播规则保留 |

表中的业务动作是源码提供的条件能力，不表示每个账号、每个菜单或每种组件状态都会显示所有项。

### 关键函数位置

以下位置均为 UTF-16 起始索引，可在对应 `functions/<bundle>/manifest.json` 交叉核对。

| bundle | 函数 | 起始索引 | 用途 |
| --- | --- | ---: | --- |
| `.vite/build/build-flavor-IWwoo-v9.js` | `allowDevtools` | 3374 | 开发工具渠道判断 |
| `.vite/build/src-ghAWefM3.js` | `ci` / `isInternal` | 41086 / 41263 | 内部渠道集合与判定 |
| `.vite/build/main-DkWgQSQe.js` | `NW` | 1528210 | guest WebView 的独立设置 |
| 同上 | `pke` | 1860170 | 内嵌浏览器自己的原生菜单，含注释、链接、编辑和导航等条件项 |
| 同上 | `GXe` | 3594328 | 通用原生右键模板 |
| 同上 | `installNativeContextMenu` | 3636227 | 主窗口图片追加项和检查器开关 |
| `app-shared-a906948d8868.js` | `kyi` | 6404942 | 共同业务菜单触发与异步生命周期 |
| `app-initial-fd3c4b862660.js` | `twn` | 2168924 | 链接右键、禁用链接、点击和拖动处理 |
| 同上 | `qHr` / `wUr` | 3616322 / 3628255 | 页签和页签栏事件处理 |
| 同上 | `gra` | 5371695 | 文件树右键接管条件 |
| 同上 | `rla` / `ila` | 5466908 / 5467328 | 文件目标查询与菜单生成 |
| 同上 | `oho` / `rTo` | 6951680 / 7194579 | 会话批量菜单与会话行 |
| 同上 | `q3o` | 8120600 | 悬浮菜单状态与右键捕获 |
| 同上 | `Ues` / `Has` | 8296826 / 8421892 | ChatGPT 会话行与项目菜单 |
| `use-code-diff-context-menu-2c71a77d6482.js` | `Ne` | 6205 | diff 菜单及当前选区处理 |
| `generated-image-context-menu-dfd8c6be92fd.js` | `Se` | 847 | 图片能力菜单 |
| `context-menu-58f1f3f247c7.js` | `ne` | 4300 | 消息反应与回复菜单 |
| `tab-context-menu-51b18dbef9a0.js` | `O` | 465 | 标签页分区移动菜单 |

## Qone 的根因与修复

原来的主窗口配置和动态浏览器 builder 没有显式关闭 DevTools。更关键的是 Tauri 2.11.6 的 `core:default` 包含 `core:webview:default`，后者包含内部开发工具切换命令。Tauri 还会在 debug 文档中注入 Ctrl+Shift+I 快捷键，因此只修改 React 事件处理或只关闭 WebView 快捷键无法覆盖整个入口。

修复分三层：

1. `tauri.conf.json` 和动态浏览器 builder 设置 `devtools=false`。
2. capability 显式加入 `core:webview:deny-internal-toggle-devtools`，拒绝继承的内部切换命令。
3. 原生插件在每个 WebView 创建时安装策略，并在所有框架的文档初始化阶段捕获 F12、Ctrl+Shift+I 和 Cmd+Option+I。普通编辑、复制粘贴、终端复制及应用快捷键继续传播。

Windows 通过 `ICoreWebView2_11::ContextMenuRequested` 过滤引擎提供的菜单。判断依据是原生目标的可编辑、选区、链接和图片属性，以及微软定义的非本地化菜单名称。只保留原生 command，过滤子菜单树及其他项，并清理多余分隔线；目标页面的语言和 DOM 类名不参与判断。

原生菜单执行保留 WebView 自己的复制粘贴处理，包含富文本和附件的剪贴板语义。组件 `preventDefault` 后不会进入原生菜单流程；插件没有全局右键 `stopPropagation`。每个 WebView 只注册一次原生处理器，导航继续使用同一策略，没有轮询或 DOM 扫描。

策略先关闭默认菜单，安装成功后恢复经过过滤的菜单；过滤失败时保持该次菜单已处理状态并记录错误。需要支持 `ICoreWebView2_11` 的 WebView2 Runtime；旧运行时无法安装此处理器时保留菜单关闭状态，键盘编辑仍可用。

`dev_network.rs` 的 debug 网络诊断保持原有实现，使用原生 `CallDevToolsProtocolMethod`。这里限制的是桌面 UI 的用户入口，运行时工具授权仍由现有权限系统决定。

显式引用了 WebView2 已使用的 `windows-core 0.61`，以使用匹配版本的 COM `Interface`。项目其他 Windows API 继续使用现有 `windows 0.62`；Cargo.lock 只增加该已有包的直接依赖关系，没有新增运行时包或升级依赖。

## 本次改动文件

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src-tauri/src/webview_policy.rs` | 原生插件、菜单目标策略、过滤与 4 项策略测试 |
| `apps/desktop/src-tauri/src/webview-policy.js` | 文档初始化快捷键限制，作用于所有框架 |
| `apps/desktop/src-tauri/src/main.rs` | 注册统一策略插件 |
| `apps/desktop/src-tauri/src/browser.rs` | 创建子 WebView 时关闭 DevTools |
| `apps/desktop/src-tauri/tauri.conf.json` | 主 WebView 关闭 DevTools |
| `apps/desktop/src-tauri/capabilities/default.json` | 显式拒绝开发工具切换命令 |
| `apps/desktop/src-tauri/Cargo.toml`、`Cargo.lock` | 直接引用现有 WebView2 COM 依赖版本 |
| `apps/desktop/test/webview-policy.test.ts` | 快捷键传播、组件右键和配置权限回归 |
| 本文 | 样本、组件规则、实施边界与验证记录 |

## 验证

- Bun 回归：4 项通过、45 个断言，覆盖 F12、Tauri 快捷键、非英文键值、普通编辑、输入法、终端复制及组件右键传播。
- 原生测试：12 项通过，其中新增策略 4 项，原有终端、凭据及运行时生命周期测试 8 项。
- `bunx tsc --noEmit -p apps/desktop/tsconfig.json` 通过。
- 本次文件的 `git diff --check` 与新原生模块格式检查通过。

原生第一次验证遇到工作区 Cargo 构建缓存目录被移除，随后改用 `%LOCALAPPDATA%/QoneAgent/cargo-policy-validation` 的独立缓存完成验证。

日志：`artifacts/webview-policy-native-tests.log`、`artifacts/webview-policy-shortcut-tests.log`、`artifacts/webview-policy-typecheck.log`。

没有启动浏览器或制作安装包。真实界面的菜单显示、原生窗口焦点和操作手感由用户通过 `bun run --cwd apps/desktop tauri dev` 验收；本次自动验证覆盖策略逻辑、事件传播、类型和原生编译。

## WebView2 参考

- [自定义和过滤原生右键菜单](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/context-menus)
- [ContextMenuItem 的非本地化 Name 与命令属性](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2contextmenuitem)
- [Settings 中的 DevTools 与默认菜单开关](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings)
- [ContextMenuRequested API 设计与示例](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/ContextMenuRequested.md)
