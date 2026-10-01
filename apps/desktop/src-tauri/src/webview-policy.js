// Capture before Tauri's debug shortcut and before page/editor key handlers.
// Native configuration and ACL also block DevTools; this avoids dispatching
// a denied toggle command and applies to child WebViews and nested frames.
(() => {
  window.addEventListener("keydown", (event) => {
    const toggle = event.code === "KeyI" && (
      (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey) ||
      (event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey)
    );
    if (event.key === "F12" || event.code === "F12" || toggle) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
})();
