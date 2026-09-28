# Codex 26.924.2738 输入框静态分析

## 来源与范围

- 目标：`C:\Program Files\WindowsApps\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。
- SHA-256：`89FBA67324FFB8DD54CCF13B6F097172E697549EEB1F26396F86F972C10C5B0C`。
- 方法：解析 ASAR 头部索引，按索引读取 `webview/assets` 中的 JS/CSS；没有运行 Codex、连接服务或使用浏览器。安装包没有附带可用的源映射，因此下文的组件名采用打包文件名、CSS 模块名和界面文案标识。
- 分析的是本机这个版本的静态实现。运行时权限、账号能力、服务端模型列表会改变实际显示结果。

## 组件和数据流

| 区域 | 安装包中的证据 | 静态结论 | QoneAgent 对应位置 |
| --- | --- | --- | --- |
| 输入框容器 | `app-primary-2a3f3664ac09.js`、`app-primary-75218b12d1d9.css` 中的 `data-codex-composer-root`、`data-composer-placement`、`_FlowComposer_18ixn_2` | 容器区分首页、对话等位置；输入、附件、底部动作栏组合渲染，内容区与队列区分层。 | `Thread.tsx` 的 `Composer`、`thread-viewport.css`、`desktop-overrides.css` |
| 输入和建议 | `app-initial-ff48311587c5.js` 的 `composer.atMentionList.*`、`composer.slashCommands.*` | `@` 支持文件、文件夹、聊天、技能、插件等来源；`/` 有独立命令菜单和无结果、加载状态；发送前校验附件和目标环境。 | `composer-triggers.tsx`、`composer-editor-bridge.tsx`、`composer-tools.tsx` |
| 按钮 | `app-primary-2a3f3664ac09.js` 的 `composer.submitButtonTooltip.*` | 同一发送区域随状态显示 Send、Queue、Steer、Resume、Stop。运行中普通追加进入队列，Steer 表示立即送入当前运行；按钮可因上传、项目、权限、连接等条件禁用。 | `Thread.tsx` 的 `ComposerAction`、`composer-queue-enter.tsx` |
| 队列 | `queued-message-list-c4ef4a432900.js` | 队列为输入框上方独立列表，支持顺序调整、编辑、删除、Steer、失败重试、暂停后恢复；单条有独立发送状态。 | `Thread.tsx` 的 `QueueItemRow`、`qone-message-queue.ts`、`composer-queue.css` |
| 模型选择 | `app-primary-2a3f3664ac09.js`、`app-primary-75218b12d1d9.css` 的 `_ModelPicker*`、`_ModelList*` | 选择器有模型列表和思考力度两个视图，模型行是可选状态项；部分模型可能锁定，账户配置可加入默认模型、速度档等附加项。 | `model-picker.tsx`、`model-picker.css`、`model-picker-data.ts` |
| 思考力度 | `app-primary-2a3f3664ac09.js` 的 `composer.mode.local.reasoning.*`、`composer.modelPicker.workPower.*` | 档位来自模型能力，至少存在 None、Minimal、Light、Medium、High、Extra High、Max、Ultra、Persistent 等文案；选择器使用可拖动且支持左右键的力度控制。具体可选集合由模型与账号能力决定。 | `run-options-popover.tsx` 的 `ThinkingWave`、`model-settings.ts`、`store.ts` |

## 队列和发送状态

`queued-message-list-c4ef4a432900.js` 明确检查 `submission.status` 的 `queued`、`pending`、`sending`、`outcome-unknown`；`pausedReason`、`canSendNow`、`isInterrupted` 另外控制交互。`outcome-unknown` 表示投递结果未确认，界面警告先核对对话，不自动重发，以免重复发送。

| 条件 | 安装包中的行为或文案 |
| --- | --- |
| 空闲且有可发送内容 | Send。 |
| 正在运行且提交普通后续消息 | Queue，等当前运行完成。 |
| 正在运行且选择立即介入 | Steer，把这条后续消息送到当前运行；队列行有单独的 Steer 操作。 |
| 当前响应正在输出 | Stop；输入框中有内容时仍可能允许排队。 |
| 中断后队列暂停 | 队列头展示 “Queue paused because you interrupted” 和 Resume。 |
| 单条发送失败 | 显示暂停说明，提供 Retry、Edit、Delete。 |
| 发送中 | `pending`/`sending` 禁用冲突操作并展示 Sending。 |
| 投递结果未知 | 显示 “Delivery could not be confirmed”，要求先核对对话。 |
| 暂停队列时另发新消息 | 弹窗要求决定保留队列发送或清除旧队列；对应 `composer.pausedQueueSubmit.*`。 |

队列列表使用最大高度 `30dvh`、纵向滚动、隐藏滚动条和浅色分隔；行内附件可显示图像缩略图、粘贴文本和附件数量。列表中多条可重排，但编辑或投递中的行会限制相关操作。QoneAgent 当前队列协议只有排队与引导投递等基本状态；不能仅靠 CSS 伪造 `outcome-unknown`、重试和暂停恢复，后续若要完全复刻，需要在协议与运行时补全可靠的投递确认状态机。

## 模型选择器视图逻辑

`app-primary-2a3f3664ac09.js` 的选择器内部使用 `simple`/`advanced` 视图。通常先显示 `simple` 力度卡片；卡片中央的模型名控件（`_Dt` 的 `onToggle`）切到 `advanced` 模型列表，选模型后返回 `simple`，菜单保持打开。若没有可调力度，则 `eOt` 直接采用 `advanced`。卡片右上角的 `onResetToDefault` 重置模型选择，并非重置思考档位。两块视图同时保留在 DOM 中，非当前视图设 `inert` 和 `aria-hidden`，以避免隐藏内容被键盘访问。打开后会把焦点放到已选模型或第一个可用项；上下键以及 Tab 在菜单项之间移动，力度滑块自己处理方向键。列表切换时滚动到顶部，容器用 `ResizeObserver` 测量两个视图高度并平滑改变高度。

模型选项使用 `menuitemradio` 和 `aria-checked`，锁定的模型有说明和解锁入口；默认模型是推荐模型集合，属于 Codex 自身能力，不应硬编码到 QoneAgent 的供应商模型列表。选择器的模型名和思考力度在触发按钮上并列显示，力度文字采用次级色。思考力度有键盘操作提示；`Ultra` 会提示更快消耗额度。QoneAgent 的模型列表由当前供应商配置生成，力度由 `thinkingLevelOptionsForApi` 动态生成，因此不会硬编码 Codex 的模型和档位。

## 可核对的样式数值

| 位置 | 安装包 CSS/组件值 |
| --- | --- |
| 模型弹层 | 宽度 `63.5 × --spacing`；打开动画约 `320ms`，`cubic-bezier(.23,1,.32,1)`。 |
| 模型列表 | 最大高度 `316px` 与可用弹层高度取较小值，超出纵向滚动。 |
| 视图容器 | 高度过渡 `320ms`，`cubic-bezier(.19,1,.22,1)`；内容进出另有透明度和位移动画。 |
| 触发器 | 模型图标、名称和力度标签水平排列，间距 `4px`；名称截断，力度为次级文字颜色。 |
| 桌面输入框 | 主题变量 `--composer-radius` 为 `5.5 × --spacing`（默认间距下约 `22px`）；支持多行输入，附件、输入区和自适应底部动作栏组合。交互被阻止时内容区设 `inert`。 |
| 桌面发送/停止按钮 | `--spacing-token-button-composer` 为 `7 × --spacing`（默认间距下约 `28px`）；圆形，禁用时透明度 `0.5`，有焦点轮廓和透明度过渡。浏览器模式覆盖为 `9 × --spacing`，本报告以桌面模式为准。 |
| 队列 | 最大高度 `30dvh`，独立滚动；行之间为细分隔。 |
| QoneAgent 输入框 | 继续使用现有圆角、边框、背景和队列轨道，避免把 Codex 的主题变量原样写死。 |

## 本次项目映射

- 输入框底部左侧显示权限图标与模式文字；右侧显示模型名与思考力度。权限弹层只负责权限模式和完全访问授权。
- 模型选择器默认显示力度卡片，点击卡片中央模型名进入模型列表，选中后返回力度卡片并保留弹层。没有可调力度或模型时直接显示模型列表。QoneAgent 没有 Codex 的推荐模型服务，卡片右上角回转按钮选择当前供应商列表首个模型；这沿用项目原有的首个模型回退规则。
- 思考程度复用项目已有企鹅和雪花 `ThinkingWave`，读写原有的 `thinkingByModel`，不添加另一套状态。
- 发送按钮的可访问名称随运行状态切换为“发送消息/加入队列”，停止按钮使用本地化名称。
- 现有队列继续使用 `@assistant-ui/react` 的 `ComposerPrimitive.Queue` 与 `QueueItemPrimitive`，保留已实现的编辑、删除和 Steer；上表中的其余 Codex 队列状态为静态逆向结论，当前 QoneAgent 未实现。

## 复核方式

ASAR 前 16 字节中含头部大小和 JSON 索引长度；读取索引的 `files.webview.files.assets.files`，按每个文件的 `offset`/`size` 从 `8 + 头部大小` 处读取资源。JSON 后有对齐填充，不能把 `16 + JSON长度` 当作资源起点。上述文件名、文案标识和 CSS 模块名可按此方法在同一版本安装包中复核。项目代码通过 TypeScript 类型检查；按项目要求，界面运行验收由用户执行。
