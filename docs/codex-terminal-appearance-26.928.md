# Codex 26.928 终端外观与 Qone 修复

用户授权分析的样本：`C:\Program Files\WindowsApps\OpenAI.Codex_26.928.2636.0_x64__2p2nqsd0c76g0\app\resources\app.asar`。本次只离线读取 Electron 前端 JS/CSS；未执行目标代码、修改安装目录、启动浏览器或生成安装包。

ASAR SHA-256：`FB7B2EE791BCBDB3C4A6375E9FEC8FB404F3EAFF995F0D293227354B298AFF49`。

## 静态证据

复现命令：`node work/codex-terminal-appearance/extract.mjs`。脚本直接读取当前安装包 ASAR 索引与文件字节，保存资源 SHA-256、JS 导入锚点及 UTF-16 字符偏移到 `work/codex-terminal-appearance/evidence/manifest.json`。脚本和证据位于项目已有的忽略目录 `work`。

| 资源与位置 | 已核实行为 |
| --- | --- |
| `app-shared-342447930c78.css`，偏移 205475 附近 | 桌面终端背景引用应用 surface；前景、选区、ANSI 色引用应用主题变量 |
| `terminal-panel-295366ae7230.js`，偏移 11148 | 主题变化后设置 `terminal.options.theme` 并 `refresh`，保持已有 renderer 和进程 |
| 同文件，偏移 14918 | 面板设置主题背景/文字色，内层 `ps-4 pt-2 pb-3`，即左 16px、上 8px、下 12px |
| `xterm-display-helpers-90c5cd21abf5.js`，函数 `c`，偏移 287154 | 用 `getComputedStyle` 解析主题 CSS 颜色，将背景、文字、光标、选区和 ANSI 色传给 xterm |
| `terminal-panel-d0f289883c52.css` | `.xterm`、`.xterm-viewport` 透明底色；滚动条使用应用边界色 |

核心资源 SHA-256：

- terminal panel JS：`50596af2035ae29b1ca51a68bf3572a439e98bf9650c8e31b61f23527815463e`
- terminal panel CSS：`7dbba3bed0635d658a0af672b1dd0574edf0e3bcd39bcc41688941bf1e8cc049`
- display helpers JS：`97639ecad6358d601d21e5cd323e6a2ac94472b4898da97ce7b526c415c98832`

## Qone 根因与改动

旧终端资源只初始化一次前景色，背景固定为透明；xterm 自带 CSS 的 viewport 默认黑色没有覆盖。主题切换后已有终端也不更新，背景、光标、选区和字体各用独立默认值。外框阴影、操作组分隔线、被拉宽的标签和常显操作进一步增加了面板的独立感。

- `dock-terminal-appearance.ts`：读取终端宿主的实际背景、文字色、全局等宽字体与字号，以及现有选区主题色；根主题属性变化时按帧合并更新，仅字体变化重新拟合行列，不涉及 PTY 生命周期。
- `dock-terminal-resource.ts` / `dock-terminal-view.tsx`：挂载时绑定主题、卸载时释放观察器与待执行帧；面板和 renderer 使用同一页面底色，光标使用细竖线。
- `workspace-dock.css`：对齐正文留白，覆盖 xterm 两层默认底色，弱化分隔线并取消外框阴影；保留程序显式 ANSI 单元格背景。
- `workspace-dock.tsx` / `dock-terminal-actions.tsx`：紧凑标签显示创建时对应的工作区路径，选中标签保留关闭按钮，清屏和重启移入已有 Radix 菜单；终端、添加、关闭和菜单图标复用本项目 Codex 资源。路径标签不是 shell 当前 `cd` 路径的实时跟踪。

未新增依赖或修改后端终端执行逻辑；标准 ANSI 调色板保持 xterm 原值，未复制 Codex 整套颜色体系。UI 数值来自现有主题/布局变量及已核实样本的留白规则，无指定用户名、项目路径或固定深浅主题颜色。

## 验证

`bunx tsc --noEmit -p apps/desktop/tsconfig.json`；`bun test apps/desktop/test/dock-terminal-appearance.test.ts apps/desktop/test/dock-terminal-session.test.ts apps/desktop/test/dock-layout.test.ts apps/desktop/test/dock-scope.test.ts`；相关文件 `git diff --check`。

回归覆盖解析主题值、已挂载终端深浅主题切换、同帧通知合并、字体变化拟合、卸载取消更新，以及原有终端进程复用/关闭/重启行为。视觉效果由用户通过 `bun run --cwd apps/desktop tauri dev` 验收；本次不声明浏览器或桌面运行验收通过。

结果：桌面 TypeScript 检查通过，4 个测试文件的 10 个测试通过（57 次断言），相关 diff 与新文件的格式检查通过。
