# Codex 26.928 开发工具与组件右键处理：静态调查和 Qone 实施记录

## 结果

Qone 已对主窗口、内嵌浏览器和 HTML 预览统一限制开发工具入口：关闭 WebView DevTools、显式拒绝 Tauri 的内部切换命令，并在文档初始化时捕获 F12 和 Tauri 的检查器快捷键。

Windows 原生右键菜单按目标保留操作。空白处不显示浏览器菜单；输入框保留编辑操作；选区保留复制；未被业务菜单接管的链接和图片保留原生复制操作，图片保留另存为。检查元素、查看源码、打印、页面另存为、刷新和浏览器新窗口等菜单项被移除。页面自己的组件菜单仍能处理右键。

组件调查已完成，规则和证据见下表。Qone 已补齐侧栏会话/项目行、Dock 标签、文件树/Git 文件行、文件引用/预览标题、消息文件变更摘要、工具变更文件名、本地技能文件、源码/Diff 和 Markdown 网页链接的业务右键入口，复用现有动作与 Radix 菜单。

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

## 侧栏右键菜单对齐

此前 Qone 侧栏只有行尾的“更多”按钮，右键会落到 WebView 默认菜单，缺少 Codex 的业务菜单入口。Codex 的 `kyi` 还会为业务组件处理右键、菜单键和 Shift+F10；会话菜单按能力显示固定、重命名、归档和删除，项目菜单还可以创建项目内新会话。

Qone 新增 `SidebarContextMenu`，使用已安装的 Radix `ContextMenu`，让以下条目整行共享业务菜单入口：

- 列表模式的会话；
- 项目模式下的会话；
- 项目行。

菜单动作复用已有状态和确认流程。会话提供置顶/取消置顶、重命名、删除；项目提供同样动作，并增加“在项目中新建会话”。Qone 当前没有归档状态和远程项目连接能力，因此不显示 Codex 中这两类无对应实现的选项。重命名输入态会停用行右键菜单，避免覆盖输入框自身的编辑行为。

`ContextMenu.Trigger asChild` 直接附着到现有行根节点，点击、拖拽、行尾按钮和原有更多菜单不改变；右键与 Shift+F10 进入同一动作列表，避免只修鼠标路径造成键盘路径缺失。菜单继续使用现有 `q-sidebar-menu` 表面、间距、危险项颜色和 Codex 图标。

当前样本编译后的 `preserveBrowserContextMenu` 计算为 `s && false`。即使调用方传入该参数，也不能据此声称当前构建会保留浏览器菜单。

## 组件规则与 Qone 对照

| 组件或区域 | 样本中可核对的处理 | Qone 当前对应行为 |
| --- | --- | --- |
| 空白页面 | 通用原生模板按目标生成，Windows 模板含全选等条件项 | 移除浏览器操作；无可用复制或编辑项时不显示菜单 |
| 输入框、重命名框、Lexical 编辑区 | 原生壳按 `isEditable` 生成剪切、复制、粘贴；消息动作菜单明确排除 `input`、`textarea`、`select` 和 `contenteditable=true` | 保留原生编辑项和引擎启用状态；复制粘贴快捷键及输入法事件继续传播 |
| 普通文本选区 | 原生菜单按选区提供复制；代码菜单在打开时读取选区 | 原生选区复制仍可用，不以全局 DOM 右键拦截取代选区处理 |
| 侧栏本地会话 | `rTo` 使用共同的菜单生成链，右键额外读取 Git/工作树状态；`oho` 在多选时限制可批量执行的操作，包含固定、取消固定、归档及已读状态 | `SidebarContextMenu` 与现有更多按钮复用固定、重命名、删除回调及确认流程，列表模式与项目模式均覆盖 |
| ChatGPT 会话侧栏 | `Ues` 按会话权限和忙碌状态控制固定、重命名、分享、归档及删除；重命名要求非空并裁剪空白，删除有确认界面 | 当前 Qone 会话菜单继续使用自己的状态和删除确认，不从翻译文本推断权限 |
| 项目行 | `Has` 按本地/远程项目及可用回调生成固定、编辑项目、文件管理器定位、工作树新会话、连接编辑、批量已读/归档、分区移动及移除项目 | Qone 项目右键提供现有固定、重命名、删除和项目内新会话；触发范围仅为项目行，重命名态保留输入框菜单 |
| 标签页与分区 | `qHr` 使用 `fHr` 生成关闭当前、其他和右侧标签；文件标签类型另提供路径菜单；`tab-context-menu` 的 `O` 按布局和能力生成分区移动操作 | Dock 提供关闭当前/其他/右侧，文件标签额外提供默认应用打开、复制路径和文件定位；复用单标签确认和资源清理；分区移动没有对应布局能力 |
| 文件引用和文件树 | `rla` 异步加载打开目标与 GitHub 定位，`ila` 按宿主能力生成预览、打开方式、保存副本、复制路径/内容、文件管理器定位；`gra` 根据树的状态决定是否接管右键 | 文件引用、树/Git 行、变更文件行和预览标题共用路径菜单，按能力提供打开、默认应用、复制路径和文件定位 |
| 消息中的文件资源 | `pn` 区分上传附件与路径附件；仅有实际 `fsPath`/`path` 且非共享会话链接的资源进入文件菜单 | 文件变更摘要的单文件标题/多文件行、工具变更文件名和本地技能文件复用路径菜单；普通上传附件只有数据或 URL，保留已有下载操作，不把文件名当作本地路径 |
| 代码及 diff | `use-code-diff-context-menu` 的 `Ne` 生成请求修改、打开目标、新标签、GitHub、复制路径/相对路径、切换换行；“复制选区”在每次打开时读取当前选区并更新启用状态 | 源码和 Git/保存的 Diff 共用选区/路径菜单，刷新选区启用状态并保留代码空白；没有增加请求修改或 GitHub 操作 |
| Markdown 网页链接 | `tCn` 生成内嵌/外部浏览器打开、复制链接及有下载能力时的另存为 | HTTP/HTTPS 链接提供内嵌浏览器、系统浏览器和复制链接，普通链接图片继续使用原生图片菜单 |
| 普通图片 | 壳的 `installNativeContextMenu` 增加复制、保存；只有能解析成本地文件时才提供文件定位，保存还有主框架条件 | Qone 图片右键提供已有的图片地址复制和图片另存为；图片预览、输入图片和不支持的图片能力仍沿用现有组件 |
| 生成图片、图片侧栏 | `Se` 按图片能力提供新标签、地址复制、添加到会话、图片复制、文件定位及下载副本；图片侧栏在编辑或点击非图片目标时阻止父菜单接管 | Qone 已对图片预览及全屏预览提供地址复制/另存为；加入会话、图片剪贴板和文件管理器动作没有对应能力，继续不显示 |
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
| 同上 | `fHr` | 3597002 | 组合标签专属操作和关闭当前/其他/右侧 |
| 同上 | `sla` / `Oua` / `h_a` | 5471984 / 5484002 / 5599177 | 路径菜单包装、artifact 标签及文件预览标签的菜单来源 |
| 同上 | `gra` | 5371695 | 文件树右键接管条件 |
| 同上 | `rla` / `ila` | 5466908 / 5467328 | 文件目标查询与菜单生成 |
| 同上 | `oho` / `rTo` | 6951680 / 7194579 | 会话批量菜单与会话行 |
| 同上 | `q3o` | 8120600 | 悬浮菜单状态与右键捕获 |
| 同上 | `Ues` / `Has` | 8296826 / 8421892 | ChatGPT 会话行与项目菜单 |
| `use-code-diff-context-menu-2c71a77d6482.js` | `Ne` | 6205 | diff 菜单及当前选区处理 |
| `generated-image-context-menu-dfd8c6be92fd.js` | `Se` | 847 | 图片能力菜单 |
| `context-menu-58f1f3f247c7.js` | `ne` | 4300 | 消息反应与回复菜单 |
| `tab-context-menu-51b18dbef9a0.js` | `O` | 465 | 标签页分区移动菜单 |
| `user-message-attachments-8ac9d6a061d0.js` | `pn` | 29776 | 上传附件与具有真实路径的附件分支 |

### 深入核对后补齐的入口

继续追踪 `qHr` 的 `getItems` 回调，定位到 `fHr`（`app-initial-fd3c4b862660.js`，UTF-16 起始位置 `3597002`）。它先检查标签仍存在且仍可操作，再加入关闭当前、关闭其他、关闭右侧标签；最后两项按可关闭目标启用。Qone 已实现这三项，复用单标签的确认与资源清理，从最右侧逐个执行。两种批量关闭共用锁，防止确认期间交叉执行；不存在的目标不触发关闭。取消或失败时停止后续关闭，已经完成的关闭保持生效；确认期间新增的标签不加入本次目标。

`fHr` 还调用标签类型的 `getContextMenuItems`，因此文件标签不应只有关闭动作。继续追踪 `Oua` 和 `h_a`，二者都按宿主和路径能力加载 `workspace-file-tab-context-menu-18030ea54753.js`，该模块导出的 `sla` 最终调用 `rla`。Qone 文件标签因此复用 `WorkspacePathMenuItems` 的默认应用打开、复制路径和文件定位；相对路径无法解析时只提供复制，不向系统传递无效路径。菜单内容复用同一组件，避免文件行和文件标签各自维护规则。

外链不只有原生复制菜单。`tCn`（同 bundle，起始位置 `2146526`）生成内嵌浏览器打开、系统浏览器打开、复制链接及有下载能力时的另存为。Qone 已具备前三项，Markdown HTTP/HTTPS 链接因此新增对应菜单；邮件和页面锚点保留原有行为，链接内的普通图片保留原生图片菜单。`Se`（`generated-image-context-menu-dfd8c6be92fd.js`，起始位置 `847`）进一步确认图片业务菜单包含复制地址和下载副本。Qone 已把已有图片预览的另存为和 HTTP 地址复制接到图片本体、全屏预览和图库预览。继续追踪的函数及索引位于 `work/codex-context-menu-26-928/evidence/deep-functions/`，提取命令为 `bun work/codex-context-menu-26-928/deep-functions.mjs`，只解析 AST，不执行目标源码。

文件操作统一使用 `WorkspacePathContextMenu`，覆盖文件树目录/文件、Git 行、保存的变更文件行、Markdown 文件引用及预览标题。文件路径可以复制；已解析的绝对路径才提供系统文件定位；现有文件打开回调继续负责预览或 Diff 导航。删除的文件变更仍可查看保存的 Diff，但不提供打开当前文件的动作。源码和 Diff 使用 `CodeContextMenu`，提供当前区域选区复制、绝对路径及可解析时的相对路径。与样本对选区调用 `trim()` 的行为不同，Qone 保留代码缩进、空行及末尾空白，并排除其他区域的选区。

按上述文件资源规则核对 Qone 调用方后，再补齐三处入口：消息末尾文件变更摘要的单文件标题/多文件行、工具变更记录的文件名、本地技能列表。摘要菜单提供查看已保存变更、打开当前文件、复制路径和可用时的文件定位；工具文件名和技能行按自己的打开能力生成菜单。已成功删除的文件禁用当前文件打开和文件定位，摘要的 Ctrl/Meta 点击也回到查看已保存变更；删除失败的记录仍可打开现有文件。菜单附着到文件目标，保留左键导航与独立的差异展开按钮。这里是将样本的通用文件能力规则应用于 Qone 现有表面，并非声称这些 Qone 卡片与样本组件一一相同。

进一步核对的边界：`pn` 的上传分支没有可用于文件管理器的本地路径；Qone 普通上传附件同样不能仅凭文件名增加系统文件动作。Mini 的回复/反应菜单要求真实回调，Qone 消息继续使用现有 assistant-ui 操作。MCP 服务行已有授权、重连和删除控件，本次没有从菜单字典推断额外右键；子代理跳转也不当作文件路径处理。终端、编辑框和普通选区保留原生操作。分区移动、归档、GitHub 文件定位等依赖尚无对应实现的能力，本次不新增空菜单动作。

已安装的 assistant-ui 组件没有这些业务右键封装，使用项目现有 Radix `ContextMenu`，没有新增依赖。直接核对已安装 Radix 2.3.7 的 `ContextMenu.Trigger`，其实现处理鼠标和触屏事件，没有主动处理菜单键和 Shift+F10。因此新增共用键盘处理，向当前触发行发送同一个 `contextmenu` 事件，尊重已有 `preventDefault`，排除编辑控件、其他修饰键、重复按键和 Portal 内容。项目触发器只附着到项目行，避免包住下方会话和空白区域。

新增菜单使用项目已有 Codex 图标与 `q-sidebar-menu` 样式；禁用项有明确外观，浮层沿用现有动画和减少动画偏好。终端和普通文字选区继续走原生行为。样本中的消息反应、GitHub 文件定位、请求修改、分区移动、工作簿/幻灯片、加入会话、图片剪贴板等菜单，本次未为 Qone 增加尚无对应业务能力的操作。

相关实现集中在 `dock-context-menu.tsx`、`lib/context-menu.ts` 和 `lib/dock-state.ts`，调用方为 `workspace-dock.tsx`、`run-changes-panel.tsx`、`run-file-changes-attachment.tsx`、`elements/run-file-tree.tsx`、`file-change-activity.tsx`、`elements/file-change-header.tsx`、`dock-extra-views.tsx`、文件预览和 Markdown 链接组件及侧栏行组件；中英菜单文案同步更新。

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

本次业务菜单：桌面端 TypeScript 检查通过；11 个相关测试文件共 48 项、245 个断言通过，覆盖菜单触发组合、精确选区、编辑快捷键、链接图片原生菜单、图片菜单、单标签/批量关闭、文件路径、已删除文件和文件摘要行为。另在现有本地 jsdom 环境运行 13 项 DOM 事件自检，实际打开 Radix 菜单并执行关闭、复制、文件定位、链接、图片、摘要、工具文件名和技能文件动作，确认 Tooltip/文件菜单透传 Shift+F10，重命名输入框和链接图片保持原生默认行为。该自检模拟原生命令，没有打开系统文件管理器或浏览器；真实原生操作和动画手感仍由用户验收。

DOM 自检脚本：`work/codex-context-menu-26-928/context-menu-dom-smoke.tsx`。脚本使用本机已有的 jsdom，只作为离线证据复现，不给项目增加运行或测试依赖。

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
