# 性能检查与修复记录

日期：2026-10-01。基于当前工作树，HEAD 为 `e61569ed7c2db25eacebaa4300107935ea94c3ec`。

检查覆盖启动依赖、主会话与子代理流式显示、会话搜索、事件持久化与恢复、后台消息队列、会话导航、终端和原生进程通信。已修复确认的高频重复工作及锁阻塞，验证了相关功能更新条件。工作树中原有的本地化、文件预览等改动保留，不能把整个 Git diff 都归为本次性能修改。

## 已修复的问题

| 路径 | 根因与改动 | 保留的行为 |
| --- | --- | --- |
| 主会话消息转换 | 转换器变动使 assistant-ui 重建整段历史；仅用稳定回调和 ref 又会漏更新。增加按消息身份及相关依赖缓存的预转换，给 assistant-ui 使用稳定转换器。 | 本地图片异步授权后显示、旧工具结果补齐、子代理图片归属、图片生成进度和错误均可更新。 |
| 子代理流式通信 | 文本流期间重复查询、解析并发送完整历史。沿用合并窗口发送文本与推理增量，仅在状态边界发送完整快照。 | 推理块完成、消息顺序、后台会话归属、完成或中断快照；快照覆盖未发送增量，不重复累加。 |
| 子代理历史显示 | 每个文本增量重新转换已保存消息。以 WeakMap 复用已保存消息转换，更新当前活动消息。 | 初始任务改变、工具结果改变仍重新转换相关消息，失败与取消状态保留。 |
| 运行时文本缓冲 | 每个 token 拼接不断增长的完整字符串。改为追加字符串块，在快照和保存时合并。 | 中断后的部分回答保存、子代理实时文本与最终结果。 |
| 会话搜索 | 每个会话读取完整消息行；SQL lower 不能保留原有 Unicode 匹配。改成集中查询会话元数据，使用索引顺序游标逐条读取消息正文并进行原有 JS 匹配。 | 标题优先、中文、Unicode 大小写折叠、ASCII 查询匹配 K/İ、最近会话排序、同时间最早消息、最多 50 条、排除失效工作区。 |
| 搜索游标 | Bun 1.3.14 缓存查询的 iterator 提前退出后保留位置，后续搜索会漏结果。使用独立 prepare 游标，并在 finally 中 finalize。 | 连续搜索与提前达到结果上限后仍从最新会话开始。 |
| 数据库读取 | 会话排序、消息时间排序和子代理父会话查询缺少相应索引；新压缩标记也加载历史恢复位置。增加索引，只有旧标记才执行兼容恢复读取。 | 老数据库自带迁移、历史压缩位置与事件恢复。 |
| 事件日志 | 到容量后反复 splice 搬动数组。改为环形缓冲。 | 重放顺序、会话过滤、恢复后的递增序号及零容量行为。 |
| 后台队列 | 每次全局更新复制会话状态并扫描会话列表。只读取运行字段，会话列表引用改变时才重新核对存在性。 | 后台续发、压缩期间暂停、断连和会话删除时解绑。 |
| 会话导航 | 每次测量逐个读取前面所有回合的布局。按文档顺序二分边界，只测量边界和可见回合；缓存已完成消息的文字。 | 当前回合、可见回合、重复回合 ID、间隙、缩放及窄窗口行为。 |
| 原生进程与终端 | 阻塞输入持有生命周期或全局注册表锁；输入队列也阻塞重启。分离输入和生命周期，阻塞操作进入后台工作线程。运行时发送使用 FIFO 队列，重启独立执行。 | 输入顺序、完整写入、重启释放阻塞写入、过期命令拒绝、旧进程事件隔离、终端尺寸及交互输入。 |
| 管理面板与代码主题 | 管理面板订阅整个 store；代码主题使用 CommonJS 聚合入口。改成字段选择器与现有主题的 ESM 文件导入。 | 原面板功能、两套主题数据一致，未增加依赖。 |

主要修改文件：

- [App.tsx](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src/App.tsx)、[runtime-message-converter.ts](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src/lib/runtime-message-converter.ts)、[subagent-messages.ts](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src/lib/subagent-messages.ts)。
- [运行时入口](C:/Users/33039/Desktop/QoneAgent/apps/agent-runtime/src/index.ts)、[subagent-publisher.ts](C:/Users/33039/Desktop/QoneAgent/apps/agent-runtime/src/subagent-publisher.ts)、[subagent-runner.ts](C:/Users/33039/Desktop/QoneAgent/apps/agent-runtime/src/subagent-runner.ts)、[协议](C:/Users/33039/Desktop/QoneAgent/packages/protocol/src/index.ts)。
- [数据库仓储](C:/Users/33039/Desktop/QoneAgent/packages/database/src/repos.ts)、[迁移](C:/Users/33039/Desktop/QoneAgent/packages/database/src/index.ts)、[schema.ts](C:/Users/33039/Desktop/QoneAgent/packages/database/src/schema.ts)、[event-bus.ts](C:/Users/33039/Desktop/QoneAgent/packages/shared/src/event-bus.ts)。
- [会话队列](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src/lib/session-queue-lifecycle.ts)、[终端队列](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src/lib/dock-terminal-session.ts)、[导航测量](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src/lib/conversation-rail-layout.ts)、[会话导航组件](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src/components/assistant-ui/elements/conversation-map.aui.tsx)。
- [原生入口](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src-tauri/src/main.rs)、[conpty.rs](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src-tauri/src/conpty.rs)、[原生回归测试](C:/Users/33039/Desktop/QoneAgent/apps/desktop/src-tauri/src/sidecar_tests.rs)。

压缩分段、子代理分段和 Markdown 参数兼容性也经过复核，相关测试通过。

## 可复现的合成测量

执行：`bun scripts/performance-benchmark.ts`。数据库仅使用 `:memory:`，没有读取或修改用户会话数据库。Windows x64，Bun 1.3.14；计时为预热后的五次中位数。代码中的数据规模仅为测试样本，不是产品限制。

| 场景 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 2000 容量事件日志，记录 20 万事件 | 27.27 ms | 1.20 ms |
| 200 会话、2 万消息，中文搜索命中 | 69.87 ms | 40.60 ms |
| 同规模，中文搜索没有命中 | 112.03 ms | 72.89 ms |
| 1200 条历史消息，100 次转换 | 339.53 ms | 14.37 ms |
| 1 万回合，靠后位置导航布局读取 | 9006 次 | 25 次 |
| 子代理 100 条保存消息，20 个发送窗口、1000 个文本增量 | 2,433,700 字节 | 4500 字节 |

子代理字节数仅比较这一分支的完整快照和增量事件，排除了初始快照及另行发送的 `agent.event`，不是整个应用的 IPC 字节数。修改后这一文本流期间的额外快照加载次数为 0。消息转换测量复用了全部 1200 条历史消息，图片或工具更新的失效条件由功能测试另外验证。

搜索执行计划使用 `idx_sessions_updated` 与 `idx_messages_session_created`，没有对全部消息正文执行临时排序。正文不读取 parts、attachments 等大字段，保留的匹配正文数量受结果上限约束。

测量源码：[performance-benchmark.ts](C:/Users/33039/Desktop/QoneAgent/scripts/performance-benchmark.ts)。原始数据：[performance-benchmark.json](C:/Users/33039/Desktop/QoneAgent/artifacts/performance-benchmark.json)。这些结果不能代替实际 WebView 帧率、启动耗时和真实数据库的测量。

## 验证

- 最新核心路径定向回归：59 项通过，0 失败，覆盖 10 个文件。包含主消息缓存、子代理文本与推理、搜索、事件重放与持久化、导航、终端队列等。
- 原生 Rust：8 项通过，0 失败；其中包含真实 PowerShell 交互、阻塞终端输入、阻塞运行时输入、FIFO 发送和重启后的过期命令拒绝。
- Runtime TypeScript 检查通过；Desktop TypeScript 检查和 Vite 前端构建通过。没有构建发布版 sidecar 或安装包。
- `git diff --check` 通过；切换导入方式前后的两套代码主题数据相同。
- 广泛回归：`bun test --isolate apps/agent-runtime/test apps/desktop/test` 有 724 项通过，两个 Lexical 测试文件发生模块初始化错误。分别独立启动 Bun 运行 `composer-link.test.ts` 与 `composer-tool-editor.test.ts`，15 项和 10 项均通过。普通合跑另有桥接 mock 冲突，隔离后已通过。全量合跑命令仍存在测试环境问题，不能描述成“全量命令 0 失败”。最后新增的子代理历史缓存测试已包含在 59 项核心回归中。

日志：[核心回归](C:/Users/33039/Desktop/QoneAgent/artifacts/performance-targeted-tests.log)、[广泛隔离回归](C:/Users/33039/Desktop/QoneAgent/artifacts/performance-isolated-tests.log)、[原生测试](C:/Users/33039/Desktop/QoneAgent/artifacts/performance-native-tests.log)、[前端构建](C:/Users/33039/Desktop/QoneAgent/artifacts/performance-desktop-build.log)。

## 仍存在的规模成本

1. **大库搜索仍是线性扫描。** 任意子串及原有 Unicode 折叠语义使常规 lower/LIKE 或分词全文索引不能直接替代。没有命中的大库查询仍同步占用运行时事件循环；本次 2 万消息样本约 73 ms。已消除逐会话全量读取和大正文集合常驻，尚未增加搜索专用工作线程或归一化索引。不能据此承诺百万消息查询没有停顿。
2. **初始消息加载和 DOM 数量仍随历史增长。** 主会话保留 assistant-ui 的定位与滚动恢复；已有 `content-visibility: auto` 减少旧回合绘制，但初次加载仍创建历史消息对象和节点。缓存优化的是重复更新。完整虚拟列表还需要验证跳转、图片尺寸变化、压缩标记和滚动恢复。
3. **前端入口仍偏大。** 当前入口约 2.66 MB，另一个 index chunk 约 1.54 MB；TypeScript 预览约 3.59 MB，按需导入。DiffViewer 的静态引用使一处动态拆分不生效。语言和主题 chunk 按需加载，不能把全部 dist 文件大小当成首屏加载量；尚未测量 WebView 解析和启动耗时。
4. **完整历史与媒体数据仍有必要的保存成本。** 子代理状态边界仍发送完整快照，初次加载仍按子代理读取历史；事件表保留历史事件，大图片的内联内容会增加持久化、恢复和 IPC 成本。本次没有删除历史或缩减功能。Google 上传缓存还存在过期条目仅在相同键再次访问时替换的长期保留成本，尚未以长时间媒体会话测量。

没有启动浏览器或应用做交互验收，没有执行提交、推送、发布或安装包生成。当前没有阻止本次代码检查及核心验证的外部阻塞；真实界面体验和上述规模成本保留给用户运行开发模式时验收。
