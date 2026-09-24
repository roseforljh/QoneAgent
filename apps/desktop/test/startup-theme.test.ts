import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/boot-theme.js", import.meta.url), "utf8");

function resolveTheme(saved: string | null, systemDark: boolean) {
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  runInNewContext(source, {
    document,
    localStorage: { getItem: () => saved },
    matchMedia: () => ({ matches: systemDark }),
  });
  return document.documentElement.dataset.theme;
}

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
