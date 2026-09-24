// Apply the saved theme before the first paint so the startup placeholder
// never flashes white while the application modules are loading.
(() => {
  try {
    const saved = localStorage.getItem("qone-theme");
    const dark = saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
