# Codex 文件变更完成卡片的收起策略

## 调查范围与结论

针对 `Snipaste_2026-10-01_16-30-40.png` 中“已编辑 9 个文件”的卡片，静态读取本机 Codex 26.928.2636 的安装包。这里的证据来自 Codex 桌面应用，不是 ChatGPT 网页。没有启动浏览器、修改安装包或修改 Qone 界面。

Codex 默认只显示前三个文件，其余文件通过“再显示 N 个文件”展开；展开后提供“收起文件”。截图中的九个文件对应三行明细加“再显示 6 个文件”。这个数量是该版本 Codex 的实现事实，不代表 Qone 已获准采用固定数量。

## 与 Qone 优化前的对照

| 项目 | Codex | Qone 优化前 |
| --- | --- | --- |
| 默认明细 | 三个文件，剩余数量单独提示 | 全部文件直接渲染 |
| 多文件容器 | 卡片明细自身没有高度上限或内部滚动 | `max-h-72 overflow-y-auto`，上限以内全部显示 |
| 展开与收起 | 按钮展开完整列表，随后可收起 | 没有对应按钮 |
| 长路径 | 目录淡化并截短，文件名优先保留 | 整条路径单一 `truncate`，末尾文件名容易消失 |
| 单个文件 | 标题直接显示文件名，不重复明细列表 | 已采用相同结构 |
| 详细变更 | 标题、查看变更入口、文件行进入 Changes | 已有保存变更面板及指定文件导航 |

Qone 对应实现是 `apps/desktop/src/components/assistant-ui/elements/run-file-tree.tsx` 的 `RunFileChangesCard`。拥挤来自默认信息量及路径分配方式；仅限制列表最大高度，不能降低上限以内的视觉占用。

## 静态实现证据

安装包：

```text
C:/Program Files/WindowsApps/OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0/app/resources/app.asar
```

以下资源均位于 `webview/assets/`，字符偏移为 JavaScript 文本的零基位置。

| 资源 | SHA-256 |
| --- | --- |
| `sites-end-resource-cff1c624fbb8.js` | `7dc01a5e524c86538227ecc50d1a2ee7e939c6d94e6749bfc52b400a6e6e6aac` |
| `zh-CN-3ed9eb1db28a.js` | `c6ac10a9fb407a393ea002d9aa818a4c7ed0e215e9c8bf0cfe2b798a98e3756f` |
| `app-primary-84ad97f06929.js` | `533eaa44435adf88ae2c7f5e61aac747db1ad1deafd2d02bdaf2606a37e80f7b` |
| `app-shared-a906948d8868.js` | `50c38d92886db2b9832ec21932ca80fd0d997e4c3cc716c4139e9085c4f15d25` |

### 默认收起与交互

资源卡片 `DE` 位于 `sites-end-resource` 的字符偏移 `265138`。展开状态初始为 `false`，列表由以下逻辑决定：

```js
[E,D] = useState(false)
oe = E ? F.files : F.files.slice(0,BE)
ce = F.files.length - oe.length
// UE 初始化 BE = 3
```

剩余数大于零时，按钮调用 `j(); D(true)`；展开且总数大于 `BE` 时，收起按钮调用 `j(); D(false)`。完整列表仍保存在 `F.files`，没有截断数据或改变总统计。

`ME` 提供真实按钮、`aria-expanded` 和展开状态箭头。中文文案为 `codex.unifiedDiff.showMoreFiles`（“再显示 # 个文件”）及 `codex.unifiedDiff.collapseFiles`（“收起文件”）。

`FE` 位于字符偏移 `280735`，将路径拆成目录与文件名：目录使用 `min-w-0 truncate text-codex-description`；文件名使用 `max-w-full shrink-0 truncate text-default`。目录优先让出空间，极窄布局下文件名也可以截断；完整路径另以 `sr-only` 提供。

标题覆盖入口 `jE`、右侧 `AE` 和文件行 `NE/PE` 负责导航。普通文件点击选择 Changes 中的文件；Ctrl/Meta 点击走源文件导航。单文件直接使用 `Edited {filename}` 标题。

### 展开时保持标题位置

`j()` 在改变展开状态之前调用 `Ff(k.current,d)`，`k` 绑定卡片标题区域。

导入链为 `app-primary` 的 `Uh` → `MHe`（字符偏移 `309899`）。它找到最近的 timeline 滚动容器，记录标题的屏幕纵坐标，在下一帧及所属 turn 尺寸变化时，将标题位置差补偿到 `scrollTop`。这保持阅读位置，不意味着把所有展开内容一次滚进屏幕。

补偿除以上下文比例；`app-shared` 的 `tE` → `p5`（字符偏移 `5691425`）读取该上下文，默认值为 `1`。补偿窗口为 `350ms`；`wheel`、`touchmove`、`pointerdown`、`keydown` 会终止补偿，并清理观察器、动画帧与监听器。

### 复核方法

用只读方式解析 ASAR：JSON header 从字节 `16` 开始，长度为 `uint32LE(12)`；数据区起点为 `8 + uint32LE(4)`。在 `header.files.webview.files.assets.files` 中查找资源，按数据区起点加条目 `offset` 读取 `size` 字节，校验上表哈希，再定位上述函数及导出别名。

本轮已实际运行提取及导出追踪脚本，核对默认状态、数量、展开/收起分支、路径样式、翻译以及滚动补偿实现。静态证据能够确认这些代码行为；未进行界面动态验收。

## 对截图的处理建议

保留标题、总增删数与查看变更入口，默认仅呈现少量文件，通过剩余数量展开；路径改为目录与文件名分别分配空间。这样可以同时减少默认高度并提高文件识别能力。若后续实施，具体默认数量需要结合用户偏好确定，并接入 Qone 现有展开与滚动机制；本轮没有写入固定数量或新增 UI 行为。

## 用户授权后的实现

用户随后要求开始优化，Qone 已采用默认三个文件、其余展开并可收起的结构。复用现有 Radix disclosure 与 MeasuredCollapse，使用项目内 Codex 箭头；额外文件收起后通过 `inert` 与 `aria-hidden` 禁用交互。新增 `FileChangePath` 将目录与文件名分别分配空间，支持正斜杠与 Windows 反斜杠路径。

去掉卡片内部高度上限与滚动条，列表高度变化交给现有会话滚动控制器处理，没有新增独立的滚动锁或复制 Codex 的 350ms 定位补偿。保存的完整变更、总统计、右键菜单、文件导航及单文件卡片行为沿用原实现。

验证：24 项文件变更与滚动相关测试通过；桌面 TypeScript 检查通过；终端虚拟 DOM 点击自检验证默认三行、展开九行、收起后不可交互、普通/修饰键导航、中文文案、Run 切换重置和三文件边界。未启动浏览器或生成安装包。
