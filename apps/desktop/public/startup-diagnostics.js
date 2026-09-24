// Runs before the module graph: errors in imports cannot reach React's boundary.
(() => {
  function fail(message) {
    if (document.documentElement.dataset.qoneBooted === "true") return;
    console.error("[qone:startup]", message);
    window.__TAURI_INTERNALS__?.invoke("frontend_diagnostic", { message }).catch(() => {});
    const root = document.getElementById("root");
    if (!root) return;
    root.replaceChildren();
    const heading = document.createElement("h1");
    heading.textContent = "Qone 启动失败";
    const detail = document.createElement("pre");
    detail.textContent = message;
    detail.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
    root.style.cssText = "box-sizing:border-box;min-height:100vh;padding:24px;background:Canvas;color:CanvasText;font:14px/1.6 system-ui";
    root.append(heading, detail);
  }
  window.addEventListener("error", (event) => {
    if (event.target instanceof HTMLScriptElement) {
      fail(`脚本加载失败：${event.target.src}`);
    } else if (event instanceof ErrorEvent) {
      fail(event.error?.stack || `${event.message}\n${event.filename}:${event.lineno}`);
    }
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    fail(event.reason?.stack || String(event.reason));
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    fail(`CSP 拦截：${event.effectiveDirective}\n资源：${event.blockedURI}`);
  });
})();
