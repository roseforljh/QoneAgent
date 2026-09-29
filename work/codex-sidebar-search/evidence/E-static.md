# E-static：GPT 侧栏搜索实现

Evidence source: `webview/assets/app-initial-ff48311587c5.js` and `webview/assets/sidebar-search-icon-dee5b5ecb91c.js` from the locally unpacked app.asar.

- GPT renders `WP({ animation: "sidebar-search", className: "icon-leading", Icon: Vf, staticIcon: Np({ data-no-autosize: true, icon: {16: Vf, 20: $Ne} }) })`.
- GPT wraps it in the uniform button path `WN({ uniform: true, ... })`.
- GPT arms the mouse animation after `300ms`; the animation is a non-looping 20x20 Lottie at 60fps / 40 frames.
- The search Lottie has a `circle 2` layer rotated `-45°`; its ellipse width animates `100 → 1 → 100` over 20 frames at 60fps. The `handle 2` layer stays fixed.

Implementation mapping:

- `AnimatedSidebarIcon.tsx`: keeps the extracted 16px Codex SVG as the fallback and recreates the 20x20 motion layer with the `-45°` lens group and fixed handle.
- `App.tsx`: routes the sidebar search trigger through `AnimatedSidebarIcon kind="search"`, keeps the 32px button and uses `p-2` for the 16px icon slot.
- `desktop-overrides.css`: implements the 300ms hover delay, one-shot `scaleX(1 → .01 → 1)` lens animation, immediate focus behavior, and reduced-motion fallback. No overall icon scale or rotation is applied.
