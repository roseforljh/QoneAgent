// Runs before the first paint: theme and sidebar geometry keep the startup
// skeleton aligned with the real layout, and its window buttons work at once.
(() => {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("qone-theme");
    const dark = saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "dark" : "light";
    const width = Number(localStorage.getItem("qone:left-sidebar-width:px:v2"));
    if (width >= 240) root.style.setProperty("--qone-boot-sidebar-width", `${Math.min(width, 520)}px`);
    if (JSON.parse(localStorage.getItem("qone-sidebar-preferences") ?? "{}")?.state?.collapsed === true) root.dataset.qoneBootSidebar = "collapsed";
  } catch {
    root.dataset.theme ??= "light";
  }
  if (!window.electronBridge) root.dataset.qoneBootWeb = "";
  document.addEventListener("click", (event) => {
    const command = event.target.closest?.("[data-qone-boot-window]")?.dataset.qoneBootWindow;
    if (command) window.electronBridge?.invoke(command).catch(() => {});
  });
})();
