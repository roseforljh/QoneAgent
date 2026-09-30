# assistant-ui viewport restoration

`@assistant-ui/react@0.15.21` is patched through Bun's `patchedDependencies`.
Run `bun install` to apply it; do not manually edit the installed package.

The additive `ThreadPrimitive.Viewport.scrollRestoration` prop accepts a stable
per-conversation mutable snapshot (`current: null` on first entry). It saves the
scroll offset and top-anchor turn when the viewport unmounts, then restores the
offset instantly after the official reserve and message refs are registered.
Restoring a running turn marks its initial anchor as already placed. Later new
user anchors still use the original smooth-placement logic. A saved streaming
target can resolve to its persisted adjacent assistant message on re-entry.

Qone retains these UI-only snapshots in memory, keyed by session ID, and prunes
deleted sessions. They are not persisted across application restarts. Project
file loading no longer replaces the conversation viewport with a skeleton.

The patch changes the package source, runtime JS and declarations. The modified
runtime modules are transpiled without the upstream React compiler memoization;
unchanged modules retain their original build. No new runtime dependencies or
application scroll listeners, timers, or follow-state machines are introduced.

When upgrading assistant-ui, review whether it has a native restoration API
before porting this patch. Regression verification:

```sh
bun test apps/desktop/test/thread-scroll-restoration.test.ts
bun x tsc --noEmit -p apps/desktop/tsconfig.json
```

The tests execute the installed package with synthetic DOM geometry; they do not
replace user validation of WebView layout, focus and animation behavior.

## Composer link nodes

`@assistant-ui/react-lexical@0.2.14` is patched to accept additional `nodes`.
Qone registers `ComposerLinkNode` through that prop while keeping the built-in
directive node, runtime sync, history and keyboard plugins. The patch updates
the source, runtime JS and declarations only. It introduces no new dependency.

Regression verification:

```sh
bun test apps/desktop/test/composer-link.test.ts apps/desktop/test/long-paste.test.ts apps/desktop/test/composer-tool-editor.test.ts
bun x tsc --noEmit -p apps/desktop/tsconfig.json
```
