# assistant-ui patches

Applied through Bun's `patchedDependencies`; run `bun install`. Do not edit the
installed packages by hand.

## Viewport restoration — `@assistant-ui/react@0.15.36`

The additive `ThreadPrimitive.Viewport.scrollRestoration` prop accepts a stable
per-conversation mutable snapshot (`current: null` on first entry). It saves the
scroll offset and top-anchor turn when the viewport unmounts, then restores the
offset instantly after the official reserve and message refs are registered.
Restoring a running turn marks its initial anchor as already placed. Later new
user anchors still use the original smooth-placement logic. A saved streaming
target can resolve to its persisted adjacent assistant message on re-entry.
Completed history (no active anchor) restores from both no-anchor branches of
`mountTopAnchorReserve`; upstream's own range-clamp restoration is untouched.

Qone retains these UI-only snapshots in memory, keyed by session ID, and prunes
deleted sessions. They are not persisted across application restarts.

## Composer link nodes — `@assistant-ui/react-lexical@0.2.23`

Accepts additional Lexical `nodes`. Upstream builds the composer with Lexical's
extension API, so the patch derives a memoized extension per `nodes` array
(Qone passes a module-level constant, so the editor is never rebuilt).

## Detached uploads — `@assistant-ui/core@0.3.36`

A thread switch disposes the outgoing composer, and upstream cancels its
in-flight attachment uploads there. Qone keeps those uploads running and
mirrors their completion into the outgoing session's draft
(`src/lib/composer-draft-binding.ts`), so `__internal_dispose` no longer calls
`_cancelAllAttachmentAdds`. Sends are still aborted.

## Porting to a new version

1. Unpack the new package, apply the old patch's `src/` hunks and fix rejects.
2. Rebuild the changed `dist` modules from the patched sources:
   `bun apps/desktop/scripts/transpile-aui.ts <packageRoot> <src files...>`
   (plain `react` imports, no React-compiler memoization — as before).
3. Update the matching `dist/*.d.ts` declarations by hand.
4. `git diff` the package root into `patches/`, update `patchedDependencies`.

Regression verification:

```sh
bun test apps/desktop/test/thread-scroll-restoration.test.ts apps/desktop/test/thread-scroll-follower.test.tsx
bun test apps/desktop/test/composer-drafts.test.ts apps/desktop/test/composer-link.test.ts apps/desktop/test/long-paste.test.ts
apps/desktop/node_modules/.bin/tsc --noEmit -p apps/desktop
```
