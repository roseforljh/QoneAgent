import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { act } from "react";
import { ECC_BUILTIN_SUBAGENTS, type RuntimeCommand, type RuntimeEvent, type SkillInfo } from "@qone/protocol";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://qone.local", pretendToBeVisual: true });
const domGlobals = ["HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const originalDomGlobals = new Map(domGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const name of domGlobals) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name].bind && typeof dom.window[name] === "function" && name[0] === name[0].toLowerCase() ? dom.window[name].bind(dom.window) : dom.window[name] });
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
Object.assign(dom.window, { __TAURI_INTERNALS__: {} });
// JSDOM has no layout observer; popup navigation does not depend on its callbacks.
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
const { createRoot } = await import("react-dom/client");
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
const { SkillPackageCard } = await import("../src/components/settings/SkillPackageCard");
const { groupSkills } = await import("../src/lib/skill-groups");
const { ComposerSlashRow, ComposerToolChip } = await import("../src/components/assistant-ui/composer-tools");
const { SkillsSection } = await import("../src/components/settings/SkillsSection");
const { BuiltinSubagentSettings } = await import("../src/components/settings/BuiltinSubagentDialog");
const { ComposerTriggers } = await import("../src/components/assistant-ui/composer-triggers");
const { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime } = await import("@assistant-ui/react");
const { translateCurrent: t } = await import("../src/localization");
initBridge();
await Promise.resolve();
const originalState = useStore.getState();
const skill: SkillInfo = { id: "ponytail", name: "ponytail", description: "Keep code simple", path: "C:/Qone/skills/builtin/ponytail/SKILL.md", builtin: true, enabled: true, source: "DietrichGebert/ponytail", revision: "a".repeat(40) };
const emit = (event: RuntimeEvent) => onRuntimeEvent?.({ payload: JSON.stringify(event) });
const collection = ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"].map((name) => ({ ...skill, id: name, name }));

afterAll(() => {
  if (originalResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
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

test("member cards expose only the switch and protection label without update, delete or nested buttons", () => {
  const markup = renderToStaticMarkup(<SkillCard skill={skill} />);
  expect(markup).toContain('role="switch"');
  expect(markup).toContain('aria-checked="true"');
  expect(markup).not.toContain(t("skills.builtin.update"));
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

test("built-in subagent settings expose the complete ECC catalog with switches", () => {
  const markup = renderToStaticMarkup(<BuiltinSubagentSettings profiles={[]} onToggle={() => {}} />);
  expect(ECC_BUILTIN_SUBAGENTS).toHaveLength(68);
  expect(markup).toContain("a11y-architect");
  expect(markup).toContain("typescript-reviewer");
  expect(markup.match(/role="switch"/g)?.length).toBe(68);
  expect(markup.match(/aria-checked="false"/g)?.length).toBe(68);
  expect(markup).not.toContain(">启用<");
  expect(markup).not.toContain("settings-subdialog");
  expect(markup).not.toContain("<h3");
  expect(markup).not.toContain("aria-modal");
});

test("package updates wait for all members, report failures and bulk switches do not open the dialog", async () => {
  useStore.setState({ connected: true, skills: collection });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    function Package() {
      const skills = useStore((state) => state.skills);
      return <SkillPackageCard group={groupSkills(skills)[0]!} />;
    }
    await act(async () => root.render(<Package />));
    const update = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("skills.builtin.update"))!;
    const before = sent.length;
    await act(async () => update.click());
    const commands = sent.slice(before).filter((item) => item.type === "skills.builtin.update");
    expect(commands.map((item) => item.skillId)).toEqual(collection.map((item) => item.id));
    expect(update.disabled).toBe(true);
    expect(host.textContent).toContain(t("skills.builtin.updating"));
    for (const command of commands.slice(0, -1)) {
      await act(async () => emit({ type: "skills.builtin.changed", requestId: command.requestId, skill: collection.find((item) => item.id === command.skillId)!, updated: false }));
    }
    expect(update.disabled).toBe(true);
    const last = commands.at(-1)!;
    await act(async () => emit({ type: "skills.builtin.changed", requestId: last.requestId, skill: collection.at(-1)!, updated: false }));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(t("skills.builtin.current"));
    expect(update.disabled).toBe(false);
    const retryStart = sent.length;
    await act(async () => update.click());
    const retries = sent.slice(retryStart).filter((item) => item.type === "skills.builtin.update");
    await act(async () => emit({ type: "error", requestId: retries[0]!.requestId, message: "Network unavailable" }));
    expect(update.disabled).toBe(true);
    for (const command of retries.slice(1)) {
      await act(async () => emit({ type: "skills.builtin.changed", requestId: command.requestId, skill: collection.find((item) => item.id === command.skillId)!, updated: true }));
    }
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("ponytail: Network unavailable");
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(useStore.getState().skills[0]?.revision).toBe(skill.revision);
    for (const enabled of [false, true]) {
      const toggleStart = sent.length;
      await act(async () => (host.querySelector('[role="switch"]') as HTMLButtonElement).click());
      const toggles = sent.slice(toggleStart).filter((item) => item.type === "skills.builtin.set-enabled");
      expect(toggles).toHaveLength(collection.length);
      expect(toggles.every((item) => item.enabled === enabled)).toBe(true);
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
      for (const command of toggles) {
        await act(async () => emit({ type: "skills.builtin.changed", requestId: command.requestId, skill: { ...collection.find((item) => item.id === command.skillId)!, enabled } }));
      }
      expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(String(enabled));
    }
    await act(async () => useStore.setState({ skills: collection.map((item, index) => ({ ...item, enabled: index === 0 })) }));
    expect(host.textContent).toContain(t("skills.package.partial"));
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("member toggles change only that skill and surface correlated errors", async () => {
  useStore.setState({ connected: true, skills: collection });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    function Member() {
      const skills = useStore((state) => state.skills);
      return <SkillCard skill={skills[0]!} />;
    }
    await act(async () => root.render(<Member />));
    const before = sent.length;
    await act(async () => (host.querySelector('[role="switch"]') as HTMLButtonElement).click());
    expect(sent.slice(before)).toHaveLength(1);
    const command = sent.at(-1)!;
    expect(command).toMatchObject({ type: "skills.builtin.set-enabled", skillId: "ponytail", enabled: false });
    await act(async () => emit({ type: "error", requestId: command.requestId, message: "Permission denied" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Permission denied");
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    await act(async () => (host.querySelector('[role="switch"]') as HTMLButtonElement).click());
    const retry = sent.at(-1)!;
    await act(async () => {
      emit({ type: "skills.builtin.changed", requestId: retry.requestId, skill: { ...skill, enabled: false } });
      useStore.setState({ skills: [{ ...skill, enabled: false }, ...collection.slice(1)] });
    });
    await act(async () => root.render(<Member />));
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(useStore.getState().skills.slice(1).every((item) => item.enabled)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("all ponytail skills show the official logo in slash suggestions and selected chips; other skills keep their fallback", async () => {
  const names = ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"];
  const skills = names.map((name) => ({ ...skill, id: name, name }));
  const before = useStore.getState().skills;
  useStore.setState({ skills });
  const wrapper = dom.window.document.createElement("div");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    for (const item of skills) {
      wrapper.innerHTML = renderToStaticMarkup(<ComposerSlashRow entry={{ id: `skill:${item.id}`, kind: "skill", skill: item, label: `/skill:${item.name}`, description: item.description }} />);
      expect(wrapper.textContent).toContain(`/skill:${item.name}`);
      expect(wrapper.querySelector<HTMLImageElement>("img")?.getAttribute("src")?.replace(/\\/g, "/")).toContain("assets/ponytail/logo.svg");
      await act(async () => root.render(<ComposerToolChip directiveId={`skill:${item.name}`} directiveType="qone-command" label={item.name} />));
      expect(host.querySelector<HTMLImageElement>("img")?.getAttribute("src")?.replace(/\\/g, "/")).toContain("assets/ponytail/logo.svg");
      expect(host.getElementsByTagName("svg")).toHaveLength(0);
    }
    const custom = { ...skill, builtin: false, id: "custom", name: "custom" };
    wrapper.innerHTML = renderToStaticMarkup(<ComposerSlashRow entry={{ id: "skill:custom", kind: "skill", skill: custom, label: "/skill:custom", description: custom.description }} />);
    expect(wrapper.getElementsByTagName("img")).toHaveLength(0);
    expect(wrapper.getElementsByTagName("svg")).toHaveLength(1);
    await act(async () => root.render(<ComposerToolChip directiveId="skill:unknown" directiveType="qone-command" label="unknown" />));
    expect(host.getElementsByTagName("img")).toHaveLength(0);
    expect(host.getElementsByTagName("svg")).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useStore.setState({ skills: before });
  }
});

test("settings show one package whose click opens all six independently managed skills and restores focus on close", async () => {
  useStore.setState({ connected: true, skills: collection });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SkillsSection />));
    const packages = host.querySelectorAll<HTMLButtonElement>("[data-skill-package]");
    expect(packages).toHaveLength(1);
    expect(packages[0]!.textContent).toContain(t("skills.package.count", { count: 6 }));
    expect(host.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(host.textContent).toContain(t("skills.builtin.update"));
    expect(host.querySelector("button button")).toBeNull();
    expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => packages[0]!.click());
    const dialog = dom.window.document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelectorAll('[role="switch"]')).toHaveLength(6);
    expect(dialog.textContent).not.toContain(t("skills.builtin.update"));
    for (const item of collection) expect(dialog.textContent).toContain(item.name);
    await act(async () => useStore.setState({ skills: collection.map((item) => item.id === "ponytail-review" ? { ...item, enabled: false } : item) }));
    expect(dialog.querySelector(`[aria-label="${t("skills.builtin.enabled", { name: "ponytail-review" })}"]`)?.getAttribute("aria-checked")).toBe("false");
    await act(async () => dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(dom.window.document.activeElement).toBe(packages[0]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("slash keyboard and pointer selection drill into a package before inserting a concrete skill, with back and escape", async () => {
  useStore.setState({ connected: true, skills: collection, workspaces: [{ id: "skills-test", name: "Skills", path: "C:/Skills" }], currentWorkspaceId: "skills-test", currentSessionId: undefined });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  let runtime!: ReturnType<typeof useExternalStoreRuntime>;
  const commands: Array<{ kind: string; name?: string }> = [];
  const ignore = () => {};
  const select = (command: { kind: string; name?: string }) => { commands.push(command); };
  function Composer() {
    runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}><ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root><ComposerPrimitive.Input /><ComposerTriggers onToolSelect={ignore} onCommandSelect={select} onMentionStateChange={ignore} onSlashStateChange={ignore} /></ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot></AssistantRuntimeProvider>;
  }
  const open = async () => {
    await act(async () => runtime.thread.composer.setText("/"));
    const input = host.querySelector("textarea")!;
    input.focus(); input.setSelectionRange(0, 0);
    await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Home", bubbles: true })));
    input.setSelectionRange(1, 1);
    await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "End", bubbles: true })));
    return input;
  };
  const key = async (input: HTMLTextAreaElement, name: string) => {
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await act(async () => root.render(<Composer />));
    const input = await open();
    expect([...host.querySelectorAll('[role="option"]')].map((item) => item.textContent)).toEqual([`/ponytail${t("skills.package.count", { count: 6 })}`]);
    await key(input, "Enter");
    expect(commands).toEqual([]);
    expect(runtime.thread.composer.getState().text).toBe("/");
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(6);
    expect(host.textContent).toContain("/skill:ponytail-review");
    await key(input, "Backspace");
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
    await key(input, "Enter");
    await key(input, "ArrowDown");
    await key(input, "Enter");
    expect(commands).toEqual([{ kind: "skill", name: "ponytail-review" }]);
    expect(runtime.thread.composer.getState().text).toBe("");
    await open();
    const pointerDown = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    host.querySelector('[role="option"]')!.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
    await act(async () => (host.querySelector('[role="option"]') as HTMLButtonElement).click());
    expect(commands).toHaveLength(1);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(6);
    await act(async () => (host.querySelector(".q-composer-slash-back") as HTMLButtonElement).click());
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
    await key(input, "Enter");
    await key(input, "Escape");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(commands).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
