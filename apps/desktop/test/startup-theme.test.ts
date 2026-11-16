import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/boot-theme.js", import.meta.url), "utf8");

function boot(items: Record<string, string | null>, systemDark: boolean) {
  const style: Record<string, string> = {};
  const document = {
    documentElement: { dataset: {} as Record<string, string>, style: { setProperty: (name: string, value: string) => { style[name] = value; } } },
    addEventListener() {},
  };
  runInNewContext(source, {
    document,
    window: {},
    localStorage: { getItem: (key: string) => items[key] ?? null },
    matchMedia: () => ({ matches: systemDark }),
  });
  return { dataset: document.documentElement.dataset, style };
}

const resolveTheme = (saved: string | null, systemDark: boolean) => boot({ "qone-theme": saved }, systemDark).dataset.theme;

test("startup skeleton follows the saved sidebar width and collapsed state", () => {
  const open = boot({ "qone:left-sidebar-width:px:v2": "300" }, false);
  expect(open.style["--qone-boot-sidebar-width"]).toBe("300px");
  expect(open.dataset.qoneBootSidebar).toBeUndefined();
  const collapsed = boot({ "qone-sidebar-preferences": JSON.stringify({ state: { collapsed: true } }) }, false);
  expect(collapsed.dataset.qoneBootSidebar).toBe("collapsed");
  expect(collapsed.dataset.qoneBootWeb).toBe("");
});

test("startup theme honors an explicitly saved dark theme", () => {
  expect(resolveTheme("dark", false)).toBe("dark");
});

test("startup theme honors an explicitly saved light theme", () => {
  expect(resolveTheme("light", true)).toBe("light");
});

test("startup theme follows the system when no preference is saved", () => {
  expect(resolveTheme(null, true)).toBe("dark");
  expect(resolveTheme(null, false)).toBe("light");
});

test("explicit system preference and invalid old values follow the system before first paint", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("invalid", true)).toBe("dark");
});
