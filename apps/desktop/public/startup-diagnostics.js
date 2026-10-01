// Runs before the module graph: errors in imports cannot reach React's boundary.
(() => {
  const text = (key) => window.qoneBootText?.(key) ?? key;
  function fail(message) {
    if (document.documentElement.dataset.qoneBooted === "true") return;
    console.error("[qone:startup]", message);
    window.__TAURI_INTERNALS__?.invoke("frontend_diagnostic", { message }).catch(() => {});
    const root = document.getElementById("root");
    if (!root) return;
    root.replaceChildren();
    const heading = document.createElement("h1");
    heading.textContent = text("startup.failed");
    const detail = document.createElement("pre");
    detail.textContent = message;
    detail.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
    root.style.cssText = "box-sizing:border-box;min-height:100vh;padding:24px;background:Canvas;color:CanvasText;font:14px/1.6 system-ui";
    root.append(heading, detail);
  }
  window.addEventListener("error", (event) => {
    if (event.target instanceof HTMLScriptElement) {
      fail(`${text("startup.scriptFailed")}: ${event.target.src}`);
    } else if (event instanceof ErrorEvent) {
      fail(event.error?.stack || `${event.message}\n${event.filename}:${event.lineno}`);
    }
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    fail(event.reason?.stack || String(event.reason));
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    fail(`${text("startup.cspBlocked")}: ${event.effectiveDirective}\n${text("startup.resource")}: ${event.blockedURI}`);
  });
})();
