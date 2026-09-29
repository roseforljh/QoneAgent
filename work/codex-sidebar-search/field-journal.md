# Field Journal：侧栏搜索对齐

## Evidence → Finding → Path

- Evidence: GPT 的 `WP` 搜索动画在鼠标进入 300ms 后启动，使用 16px 静态图标作为 fallback；按钮实现没有放大状态。
- Finding: 原实现漏掉了 GPT Lottie 的 `-45°` 镜片图层方向，导致镜片像独立水平变形；当前按源动画的旋转轴和固定手柄还原。
- Path: `AnimatedSidebarIcon.tsx` 的 search motion layer → `desktop-overrides.css` 的 hover/focus keyframes → `App.tsx` 的统一 32px 搜索按钮。

## Decision

保留已有新建会话与应用入口改动，只替换搜索入口的动效为 GPT 的镜片 `-45°` 方向收缩回弹，避免扩大回归范围。

## Verification

- `bunx tsc --noEmit -p apps/desktop/tsconfig.json`
- `bun test apps/desktop/test/sidebar-preferences.test.ts`
- `git diff --check`
