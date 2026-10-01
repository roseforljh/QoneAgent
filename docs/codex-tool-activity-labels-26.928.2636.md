# Codex 26.928.2636 工具活动标签与 Qone 修复

## 范围与证据

按用户指定，只读分析 `C:/Program Files/WindowsApps/OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0/app/resources/app.asar`。从 ASAR 索引重新读取下列资源，字节比对确认与临时目录 `C:/Users/33039/AppData/Local/Temp/qone-codex-269282636-current` 的提取文件完全一致。没有执行安装目录代码、修改安装包或启动浏览器。

| 资源 | SHA-256 |
| --- | --- |
| `active-tool-activity-label-d7b103efce2b.js` | `94ef5667e8ee8f93c1fc6d9941a9edb97eafbb38e40577c3b2f4d5c5b5752072` |
| `sites-end-resource-cff1c624fbb8.js` | `7dc01a5e524c86538227ecc50d1a2ee7e939c6d94e6749bfc52b400a6e6e6aac` |
| `agent-activity-item-b10048f4814f.js` | `a1c3b4a1e3eefa336a7816a38cdcf37df685c506400256ece9c336b014aee3e0` |
| `zh-CN-3ed9eb1db28a.js` | `c6ac10a9fb407a393ea002d9aa818a4c7ed0e215e9c8bf0cfe2b798a98e3756f` |
| `inline-followup-markdown-d4d8c1981b3c.js` | `f776b8ffbf68bd82564e1f591bd10211ba0c409955a431a14ff435c1187e073c` |

## 静态结论

- 活动标签模块的 `D / O / k` 从后往前找当前工具，按 read、search、list_files 等语义生成动作和目标。读取的原始模板是 `<action>Reading</action> <detail>{target}</detail>`，中文为“正在读取 {target}”。
- `sites-end-resource` 的 `HS` 给完成的单次读取生成 `toolSummaryForCmd.read`，模板为 `<verb>Read</verb> {path}`，中文为“已读取 {path}”。
- 同一资源的 `nO / Y_` 用 `completedHeader.summaryParts` 生成多工具汇总。其中 exploration 的中文为“已读取文件”，不带各个文件目标。单项动作和组标题属于两种显示语义。
- `agent-activity-item` 的 `ur` 将普通 reasoning 从工具活动分组输入中排除；这不能直接作为 Qone 隐藏思考内容或跨失败阶段合并工具的依据。
- `inline-followup-markdown` 的 `Ge / N` 汇总 groupable 活动，遇到 standalone 活动或显式 startsGroup 才断开分组，并不按 read / command 的工具大类切组。普通 reasoning 被前一步过滤，因此不会切出新标题；`Je` 使已完成的单项活动回到独立行。
- 同一资源的 `Ae / je` 按来源、文件变更、探索、命令、网页搜索生成完成摘要；`Ye` 在最新活动仍进行时选择当前工具或 thinking。网页来源和实际集成在 `sites-end-resource` 的 `Z_ / Q_` 使用不同文案；中文资源分别是“已使用 {sources}”和“已使用 {sources} 集成”。

以上证据来自 Codex 桌面包，不代表已动态核验 ChatGPT 网页端。

## Qone 根因与修复

`SessionTimeline` 的单项行此前复用类别汇总标题；`toolTarget / toolFullTarget` 又把缺失目标回退为工具名；`ToolCall` 最后无条件渲染动作和目标。因此单次读取也变成“读取了文件 + 目标”，思考分隔的独立读取重复使用通用标题。

修复在公共标签、目标生成和活动显示层完成：单项使用按工具语义生成的进行态、完成态动作；组标题保留分类汇总；未知目标为空，只有实际存在目标才渲染目标文本。实时工具参数优先于旧流式预览，避免标题停留在未完成的路径。

显示层新增 `executionActivityItems`：同一阶段内跨普通思考片段汇总工具活动，思考和各个工具保留在可展开明细中；正文、失败、压缩、媒体和展示内容形成边界。原始 part 索引与压缩记录不变；独立单工具、单纯思考保留各自披露。最新正在进行的思考由组标题显示“正在思考”，历史工具仍显示完成动作。分组只扫描当前显示区间，避免媒体分段重复扫描整段历史。

准备阶段显示“正在准备读取”“正在准备使用 Context7”，不展示 MCP 协议标识或参数生成细节。网页来源使用来源文案，网页搜索、网页读取使用对应动作；混合集成摘要的英文按最终显示顺序处理大小写。命令分类只依据已知命令工具，其他工具的 command 字段仍可作为目标；查询参数格式只用于已知查询工具，避免按工具名子串误判。未知工具和服务器使用安全的字典自有属性查找。

## 阶段目的标题（本轮补充）

仅依靠工具名只能得到“编辑了文件、读取文件、运行命令”这类结果摘要，无法可靠推断模型此刻要解决的阶段目的。为此增加内部进度工具 `qone_set_activity_title`：模型在阶段目的发生变化时提供短标题，例如“排查停止状态为何被覆盖”，标题随普通工具调用一起进入消息 parts 并可跨数据库重载恢复。该工具不访问文件、不联网、不改变权限或任务状态，也不计入工具数量和文件统计。

渲染层按该标题切分活动阶段；标题作为阶段摘要，工具和思考仍在展开明细中按原始顺序显示。标题缺失、失败、超长或参数无效时不猜测阶段目的，继续使用已有的动作摘要。标题作为纯文本渲染，避免模型输入被当作 HTML；失败和上下文压缩仍保留在原位置。

复用项目现有 assistant-ui runtime、Collapsible、SwapLabel、ShimmerLabel、OverflowFade。已检查本地 `@assistant-ui/react-ui` 的导出组件，未提供可直接替代本项目工具语义标签解析的组件；本轮没有新增 UI 组件或依赖。

## 验证与边界

回归覆盖单次读取、搜索、列目录、缺失参数、实时参数覆盖、跨思考的阶段分组、混合工具、失败阶段边界、正文/媒体/压缩边界、历史重载、进行态与历史完成态、网页来源、网页搜索、集成名称和图标、文件变更行、长目标显示。`execution-activity-view.test.tsx` 使用实际 `AssistantParts` 和 assistant-ui runtime 渲染，验证折叠摘要、运行时展开明细及其顺序，补足纯摘要函数测试的验证范围。

验证结果：本轮相关回归为 16 个桌面/运行时测试文件，共 122 项通过、0 失败、437 个断言；运行时和协议依赖类型检查通过，`git diff --check` 通过。桌面类型检查仍被并行任务修改的 `apps/desktop/src/lib/thread-scroll-controller.ts` 中 `restored` 的既有 TypeScript 错误阻断，与本轮标题改动无关。视觉验收由用户运行开发环境完成。交接记录中的两张截图原路径本轮已不存在，本轮没有重新查看截图。

## 完成核对

| 用户目标 | 当前证据 |
| --- | --- |
| 判断 P1 的动作与目标重复拼接是否符合参考实现 | `HS` 的单项模板与 `nO / Y_` 的组摘要为不同分支；单项渲染测试验证完整动作与真实目标，无目标回退 |
| 修复 P2 的重复、机械阶段标题 | `Ge / N / Je` 的分组逻辑取证；实际 `AssistantParts` 渲染测试验证跨思考读取共用一个阶段标题 |
| 让标题表达阶段目的 | `qone_set_activity_title` 由模型显式提供目的，历史 parts 可恢复；无标题时保留通用摘要回退 |
| 解决相同显示链路里的类似问题 | 参数、准备态、网页来源、集成、命令误判和查询子串误判均有对应回归 |
| 保留执行过程的顺序和失败信息 | 分组和实际渲染测试验证失败独立、前后分组有序；压缩、正文、媒体和历史重载测试通过 |
| 按指定目录逆向，复用组件和图标 | 原始 ASAR 资源哈希、函数取证；复用 assistant-ui runtime 和项目现有披露、动画、Codex/集成图标 |
