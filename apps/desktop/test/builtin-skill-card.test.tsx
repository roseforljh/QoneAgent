import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeCommand, RuntimeEvent, SkillInfo } from "@qone/protocol";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://qone.local", pretendToBeVisual: true });
const domGlobals = ["HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const originalDomGlobals = new Map(domGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const name of domGlobals) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name].bind && typeof dom.window[name] === "function" && name[0] === name[0].toLowerCase() ? dom.window[name].bind(dom.window) : dom.window[name] });
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
Object.assign(dom.window, { __TAURI_INTERNALS__: {} });
dom.window.localStorage.setItem("qone-general-settings", JSON.stringify({ language: "zh-CN" }));

let onRuntimeEvent: ((event: { payload: string }) => void) | undefined;
const sent: RuntimeCommand[] = [];
const originalCore = { ...await import("@tauri-apps/api/core") };
mock.module("@tauri-apps/api/core", () => ({ ...originalCore, invoke: async (name: string, args?: { cmd: string }) => {
  if (name === "runtime_send" && args) sent.push(JSON.parse(args.cmd));
} }));
mock.module("@tauri-apps/api/event", () => ({ listen: async (_name: string, callback: typeof onRuntimeEvent) => { onRuntimeEvent = callback; return () => {}; } }));
const { initBridge, useStore } = await import("../src/store");
const { SkillCard } = await import("../src/components/settings/SkillCard");
const { translateCurrent: t } = await import("../src/localization");
initBridge();
await Promise.resolve();
const originalState = useStore.getState();
const skill: SkillInfo = { id: "ponytail", name: "ponytail", description: "Keep code simple", path: "C:/Qone/skills/builtin/ponytail/SKILL.md", builtin: true, enabled: true, source: "DietrichGebert/ponytail", revision: "a".repeat(40) };
const emit = (event: RuntimeEvent) => onRuntimeEvent?.({ payload: JSON.stringify(event) });

afterAll(() => {
  useStore.setState(originalState, true);
  dom.window.close();
  for (const [name, descriptor] of originalDomGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  for (const [name, descriptor] of [["window", originalWindow], ["document", originalDocument], ["IS_REACT_ACT_ENVIRONMENT", originalAct]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("built-in cards expose the switch, update and protection label without a delete action or nested buttons", () => {
  const markup = renderToStaticMarkup(<SkillCard skill={skill} />);
  expect(markup).toContain('role="switch"');
  expect(markup).toContain('aria-checked="true"');
  expect(markup).toContain(t("skills.builtin.update"));
  expect(markup).toContain(t("skills.builtin.protected"));
  expect(markup).toContain("aaaaaaa");
  const wrapper = dom.window.document.createElement("div");
  wrapper.innerHTML = markup;
  expect(wrapper.querySelector<HTMLImageElement>(".settings-provider-icon img")?.getAttribute("src")?.replace(/\\/g, "/")).toContain("assets/ponytail/logo.svg");
  expect(wrapper.querySelector("button button")).toBeNull();
  expect([...wrapper.querySelectorAll("button")].some((button) => /删除|delete/i.test(button.textContent ?? ""))).toBe(false);
  expect(renderToStaticMarkup(<SkillCard skill={{ ...skill, enabled: false }} />)).toContain('aria-checked="false"');
  expect(renderToStaticMarkup(<SkillCard skill={{ ...skill, builtin: false }} />)).not.toContain('role="switch"');
});

test("updates correlate responses, show progress/latest/errors and synchronize skill state; toggles use the same bridge", async () => {
  useStore.setState({ connected: true, skills: [skill] });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SkillCard skill={skill} />));
    const update = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("skills.builtin.update"))!;
    await act(async () => update.click());
    const command = sent.findLast((item) => item.type === "skills.builtin.update")!;
    expect(command).toMatchObject({ skillId: "ponytail" });
    expect(update.disabled).toBe(true);
    expect(host.textContent).toContain(t("skills.builtin.updating"));
    await act(async () => emit({ type: "skills.builtin.changed", requestId: command.requestId, skill, updated: false }));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(t("skills.builtin.current"));
    expect(update.disabled).toBe(false);
    await act(async () => update.click());
    const second = sent.findLast((item) => item.type === "skills.builtin.update")!;
    await act(async () => emit({ type: "error", requestId: second.requestId, message: "Network unavailable" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Network unavailable");
    expect(useStore.getState().skills[0]?.revision).toBe(skill.revision);
    await act(async () => (host.querySelector('[role="switch"]') as HTMLButtonElement).click());
    const toggle = sent.findLast((item) => item.type === "skills.builtin.set-enabled")!;
    expect(toggle).toMatchObject({ skillId: "ponytail", enabled: false });
    await act(async () => emit({ type: "skills.builtin.changed", requestId: toggle.requestId, skill: { ...skill, enabled: false } }));
    expect(useStore.getState().skills[0]?.enabled).toBe(false);
    await act(async () => root.render(<SkillCard skill={useStore.getState().skills[0]!} />));
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
