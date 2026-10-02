# Codex 26.928.4866 输入框留白对齐

## 来源与范围

静态读取用户指定的 `C:/Program Files/WindowsApps/OpenAI.Codex_26.928.4866.0_x64__2p2nqsd0c76g0/app/resources/app.asar`，仅解析 ASAR 索引读取前端 JS/CSS，没有启动 Codex 或浏览器。

复现入口：`work/codex-composer-26.928.4866/extract.py`；JS/CSS 资源及索引、摘要在同目录。主题值还需从同一 ASAR 的 `webview/assets/app-shared-24ce7a84cb1a.css` 读取。

| 资源 | SHA-256 |
| --- | --- |
| `app-shared-24ce7a84cb1a.css` | `9b094a8d6db2a0c00f8763e9de1d5c1c2de8865c59a9ca236090fcfb0d31eee6` |
| `app-initial-2e28cd4bbe72.css` | `89098148cf2c30a19bcae4b52d1a067177698ef31f775438bf4a8eb3d7319668` |
| `app-initial-9e0f03d3c485.js` | `25fd85da4880d4911062c05ca9c094fb0d38f1651e57e6ac804de4cff3abc4da` |
| `app-primary-2b539a729a98.js` | `2c5259d8c72b2b7f3c437c372bdbad340357156036ca02d6e92caa5c08e55b29` |

## 已核实的桌面多行布局

下表按默认 `--spacing = 0.25rem`、根字号 16px 换算。浏览器版有不同的主题覆盖，不用于桌面对齐。

| 区域 | 原版规则 | 默认尺寸 |
| --- | --- | --- |
| 空附件槽 | `--padding-composer-empty-attachments: 2 × spacing 2 × spacing 1.5 × spacing` | 上 8px、左右 8px、下 6px；即使没有附件也存在，总顶部留白 14px |
| 有附件槽 | `ComposerLayoutAttachments` 的 default spacing 同样有 padding，底部为 `1.5 × spacing` | 同样上 8px、左右 8px、下 6px，另加附件自身高度 |
| 文字区 | `--padding-composer-input: 0 3 × spacing` | 左右 12px，不额外叠加上下 padding |
| 文字区最小高度 | `--min-height-composer: 11 × spacing` | 44px |
| 文字区到操作栏 | `--spacing-composer-input-footer: spacing` | 4px |
| 操作栏 | default multiline footer 左右 `2 × spacing`，底部 `--spacing-composer-footer-bottom: 2 × spacing` | 左右 8px、底部 8px |
| 默认圆角 | `--composer-radius: 5.5 × spacing` | 22px |

`app-initial` 的 `ComposerLayoutAttachments_gcdh7_2[data-composer-spacing=default]:not([data-visible-attachments])` 仅改用空槽 padding，没有把空槽隐藏。`app-primary` 的 Codex 路径在多行布局中保留 `WE.Attachments`，以 `hasVisibleAttachments` 标记内容状态。

## Qone 根因与修复

`elements/attachment.aui.tsx` 在接入选中文字引用时增加了 `empty:hidden`。这隐藏了无附件/无引用时的整个顶部槽；而 `Thread.tsx` 文字区原本就是 `py-0`，于是占位文字、光标和实际正文贴近输入框顶边。

移除 `empty:hidden`，保留原来的 `pt-2 pb-1.5 px-2` 与附件、引用 children。当前输入区 `px-3`、`min-h-11`、操作栏 `mt-1 px-2 pb-2` 已对应上述桌面布局，无需再加整框 padding、占位符单独偏移或内容状态判断。主聊和侧聊复用同一个组件。

继续使用已有 assistant-ui 的 `LexicalComposerInput`、附件和引用 primitives；已查阅组件库文档并核对本机 0.2.14 的 wrapper、editable 和 placeholder 结构，没有新建输入控件或改变草稿、队列、上传逻辑。

## 验证方式

修复前运行 `bun test apps/desktop/test/composer-queue-view.test.tsx`，12 项通过、顶部留白测试失败，失败明确指向 `empty:hidden`。增强该测试以同时检查 8px/6px/8px 对应的已有间距类。

修复后：队列视图、引用、草稿及队列编辑共 39 项通过；链接测试单独运行 15 项通过；桌面 `tsc --noEmit` 与定向 diff 格式检查通过。五个文件合在一个 Bun 测试进程时，链接测试触发 Lexical 的 `CAN_USE_DOM` 初始化顺序异常；拆开运行全部通过，未把这个测试加载问题混入输入框样式修复。

已按项目要求调用 `_rebuild_code(Path('.'))` 更新知识图谱，尊重项目 `.graphifyignore`，没有使用 `collect_files`。图谱成功更新；日志提示 SQL 解析依赖缺失、3 个 JSON 文件没有可提取节点，不影响本次 TSX 和 Markdown 提取。

不启动浏览器、不构建 exe 或安装包。实际 WebView 外观由用户运行 `bun run --cwd apps/desktop tauri dev` 验收。
