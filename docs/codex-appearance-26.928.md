# Codex 26.928：外观、对比度、强调色

仅离线分析用户指定的安装包。读取 `resources/app.asar` 的 renderer 文件，不启动浏览器、不调用 OpenAI 账户接口、不修改安装目录。

## 提取的值

| 设置 | 原始值／约束 |
| --- | --- |
| 外观 | `system`、`light`、`dark`；系统模式持续跟随 `prefers-color-scheme: dark` |
| 对比度 | 0–100、步长 1；亮色默认 45，暗色默认 60；保存值四舍五入并限制范围 |
| 强调色 | `default`、`blue`、`green`、`yellow`、`pink`、`orange`、`purple`、`black`；另有本地 `custom` |
| 中性色 | `black` 在亮色下显示黑色，在暗色下显示白色；同一选项，不是两个独立枚举 |
| 自定义色 | 六位十六进制 `#rrggbb`；明暗模式单独保存 |

`pYi` 的颜色菜单色块值为：蓝 `#3566f0`、绿 `#19b79e`、黄 `#fdcd54`、粉 `#fa70ab`、橙 `#ff8771`、紫 `#ab5eff`、黑 `#000000`。中性色和默认项的实际色块通过 `G2i/W2i` 随明暗模式变化。

菜单色块不是所有控件都使用的同一个颜色。`Z2i` 内置各色完整色阶，`W2i` 根据模式选择文字色、背景、发送按钮、气泡和选区颜色。数据完整提取到 `apps/desktop/src/lib/appearance-values.json`，无需依赖截图取色或联网 favicon。

桌面种子 `qK`：亮色 surface `#ffffff`、ink `#1a1c1f`、contrast 45；暗色 surface `#181818`、ink `#ffffff`、contrast 60。浏览器 ChatGPT 的 `V0i` 是另一套种子，未混用于桌面参考目标。

## 计算和功能

对比度并非仅改变正文颜色。`p4i` 在默认值附近进行非线性换算，再由 `c4i`、`u4i` / `f4i`、`m4i` 生成底色、控件、浮层、边框、次级文字和图标颜色。Qone 通过小型共享模块映射到现有 CSS 变量，并连接原先覆盖主题色的发送／停止按钮和气泡。链接信息色、焦点颜色、选区也跟随选项变化。

Qone 使用现有 QoneSelect、Radix Slider、原生颜色输入，保留简洁的三行设置，不移植 Codex 的完整主题编辑界面、字体编辑、透明窗口、主题预设浏览器或账户同步。

明暗模式分别保存对比度、强调色和自定义色；“默认”按钮恢复当前模式对比度 45 / 60。系统主题监听常驻，手动明暗选择会退出系统跟随，重新选择系统后恢复跟随。设置在 React 首次渲染前应用，关闭／重新打开设置无需再次触发恢复；支持 storage 事件更新，不覆盖通用设置中的语言和其他字段。

旧的紫／蓝／绿值迁移到新配置。旧“默认”对比度恢复对应模式默认值；旧“增强／减弱”没有真实数值，Qone 兼容迁移为已验证的滑块上／下界 100 / 0，不声称原版存在这三档预设。损坏配置、非法颜色、越界数值均会规范化。

自定义色保持 Qone 的基础按钮能力，前景根据亮度选择黑／白，属于本地适配；预置颜色与原始 `W2i` 值直接核对。Qone 只保存本地设置，不更改用户 OpenAI 账户主题。

## 证据和验证

运行 `bun work/codex-input-link-26-928/extract-appearance-evidence.ts`：核对安装包内 4 个 JS 文件与解包副本逐字节一致，提取 27 个函数、所有预置色阶、桌面种子。`evidence/appearance-sources.json` / `appearance-manifest.json` 记录源 SHA-256 和函数 UTF-16 偏移。

主要来源：`general-settings` 的 `Ka`（滑块 0–100 / step 1）、`xa`（预置／自定义强调色）、`bc`（系统／明／暗选项）；shared 的 `vQ`（8 个颜色枚举）；initial 的 `Y0i`、`pYi`、`Z2i`、`W2i`、`p4i`、`c4i`、`u4i`、`f4i`、`m4i`。

`apps/desktop/test/fixtures/codex-appearance-color-oracle.js` 是提取原函数的独立测试参考，仅执行纯颜色函数，不加载 Codex 应用。`appearance.test.ts` 逐项比较预置色和多个对比度下的生成值，验证系统主题变化、明暗分别保存、恢复默认、旧设置迁移、损坏数据、跨窗口更新和保留语言设置。测试文件不依赖被忽略的临时 work 目录。

运行：`bun test apps/desktop/test/appearance.test.ts apps/desktop/test/startup-theme.test.ts`；`bun x tsc --noEmit -p apps/desktop/tsconfig.json`。实际开发应用中的视觉验收由用户完成。
