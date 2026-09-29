import { useEffect } from "react";
import { useAui } from "@assistant-ui/react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";

/**
 * Keep Enter behavior in one place. assistant-ui's lexical input intentionally
 * blocks Enter while a run is active; Qone can submit to its external queue in
 * that state. `submitMode="none"` on the input prevents the built-in handler
 * from racing this plugin.
 */
export function ComposerQueueEnterPlugin({ menuOpen, compacting }: { menuOpen: boolean; compacting: boolean }) {
  const [editor] = useLexicalComposerContext();
  const aui = useAui();

  useEffect(() => editor.registerCommand(
    KEY_ENTER_COMMAND,
    (event) => {
      if (!event || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey) return false;
      if (menuOpen) return false;
      if (compacting) { event.preventDefault(); return true; }
      const thread = aui.thread.getState();
      const composer = aui.composer.getState();
      if (!composer.canSend || (thread.isRunning && !thread.capabilities.queue)) return false;
      event.preventDefault();
      aui.composer.send();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  ), [aui, compacting, editor, menuOpen]);

  return null;
}
