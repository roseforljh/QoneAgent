# Dependency patches

JavaScript dependency patches use Bun's `patchedDependencies`; run `bun install`.
Do not edit installed packages by hand. The app-local PSReadLine source patch is
built separately as described below.

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

## Cursor-line reflow — `@xterm/xterm@6.0.0`

With `reflowCursorLine` enabled, upstream reflows text but clamps the cursor to
its old row/column. `Buffer.resize` now preserves its logical line and cell
offset, including wide characters and trimmed scrollback. Local ConPTY terminals
opt into this; SSH terminals keep their existing behavior. See xterm.js #5295.
Both shipped JS entry points carry the same source change; their stale source-map
links are removed. Update both when porting the patch.

## ConPTY worker cleanup — `node-pty@1.2.0-beta.18`

The bundled ConPTY exits with its last client, but node-pty leaves its input pipe
and output worker alive on natural exit. The patch closes input and starts the
existing output-drain cleanup, resetting it on trailing data. Qone uses this
version's bundled ConPTY for resize cursor synchronization (microsoft/terminal
#19535), rather than the OS backend's console-list cleanup helper.

Targeted terminal checks (Windows, no browser or installer):

```sh
bun test apps/desktop/test/terminal-reflow.test.ts apps/desktop/test/terminal-worker-cleanup.test.ts apps/desktop/test/terminal-reopen-race.test.ts apps/desktop/test/dock-terminal-session.test.ts
bun test apps/desktop/test/electron-runtime-integration.test.ts --test-name-pattern 'the dock terminal'
bun test apps/desktop/test/electron-process-tree.test.ts --test-name-pattern 'dock terminal'
```

## Immediate resize and submit — `PSReadLine@2.4.5`

PSReadLine skips resize checks for 50 ms after rendering and can accept Enter
without rendering again. The patch checks actual dimensions before skipping
rendering/recomputing input coordinates, and renders before accepting a command
if the dimensions changed. Key batching, prediction, history and bindings remain
unchanged; there are no production sleeps.

`apps/desktop/scripts/prepare-psreadline.ts` fetches upstream tag `v2.4.5`, verifies
archive SHA-256 `f2160930a98fcf5200ed50b37b1653e0f685036d5d4bcafa88da6912e5dff9cd`,
applies the patch and builds an app-local module using the .NET SDK. Git runs from
the repository root: `git apply` from a repository subdirectory otherwise skips
these external paths while returning success. Source, build workspace and command
working directory are separate. The module's recipe and file hashes are cached.

Windows `build:electron` prepares it automatically. TerminalManager prepends the
app's `binaries` directory to `PSModulePath` for pwsh only; the system installation
is untouched. Existing release resources include the module. To prepare it before
running the real-shell regression directly:

```sh
bun apps/desktop/scripts/prepare-psreadline.ts
```

The real-shell regression uses isolated history and real xterm parsing without a
browser. It covers immediate resize + typing + Enter, immediate resize + Enter
alone in both directions, Chinese output and clearing. No resize grace period or
explicit module import is used.

The renderer side matters too: ConPTY output carries absolute positions for the
size it was rendered at, and xterm parses written data on a timer. The dock
therefore resizes only after already-received output is parsed
(`term.write("", fit)` in `dock-terminal-resource.ts`); otherwise old-size
cursor moves land on the new grid and ConPTY's next cursor query is answered
from that wrong position, leaving input text on the next prompt line.

## Porting assistant-ui to a new version

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
