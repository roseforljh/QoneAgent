import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/startup-diagnostics.js", import.meta.url), "utf8");

function boot(ready = false) {
  const listeners = new Map<string, (event: unknown) => void>();
  const reports: string[] = [];
  const root = {
    children: [{ textContent: "正在加载 Qone…" }],
    style: { cssText: "" },
    replaceChildren() { this.children = []; },
    append(...nodes: { textContent: string }[]) { this.children.push(...nodes); },
  };
  const document = {
    documentElement: { dataset: { qoneBooted: ready ? "true" : undefined } },
    getElementById: () => root,
    createElement: () => ({ textContent: "", style: { cssText: "" } }),
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
  };
  class Script { constructor(public src: string) {} }
  runInNewContext(source, {
    document,
    window: {
      addEventListener: document.addEventListener,
      __TAURI_INTERNALS__: { invoke: async (_command: string, { message }: { message: string }) => { reports.push(message); } },
    },
    HTMLScriptElement: Script,
    ErrorEvent: class {},
    console: { error() {} },
  });
  return { root, reports, emit: (type: string, event: unknown) => listeners.get(type)!(event), Script };
}

test("module import failure replaces the existing loading placeholder and reaches native diagnostics", () => {
  const app = boot();
  app.emit("unhandledrejection", { reason: new Error("Failed to fetch dynamically imported module: /src/main.tsx") });
  expect(app.root.children[0].textContent).toBe("Qone 启动失败");
  expect(app.root.children[1].textContent).toContain("/src/main.tsx");
  expect(app.reports[0]).toContain("Failed to fetch");
});

test("failure of the bootstrap itself is visible before any module executes", () => {
  const app = boot();
  app.emit("error", { target: new app.Script("http://127.0.0.1:1420/src/main.tsx") });
  expect(app.root.children[1].textContent).toContain("/src/main.tsx");
  expect(app.reports).toHaveLength(1);
});

test("a CSP failure names the blocked resource and directive", () => {
  const app = boot();
  app.emit("securitypolicyviolation", { effectiveDirective: "script-src-elem", blockedURI: "http://127.0.0.1:1420/blocked.js" });
  expect(app.reports[0]).toContain("script-src-elem");
  expect(app.root.children[1].textContent).toContain("blocked.js");
});

test("startup diagnostics never replace an already mounted application", () => {
  const app = boot(true);
  const original = app.root.children;
  app.emit("unhandledrejection", { reason: new Error("Later operation failed") });
  expect(app.root.children).toBe(original);
  expect(app.reports).toEqual([]);
});
