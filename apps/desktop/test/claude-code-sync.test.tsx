import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { ClaudeCodeSyncResult, RuntimeCommand, RuntimeEvent } from "@qone/protocol";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://qone.local", pretendToBeVisual: true });
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) {
  let value: unknown = key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom.window : dom.window[key as keyof Window];
  if (["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key)) value = (value as Function).bind(dom.window);
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
dom.window.localStorage.setItem("qone-general-settings", JSON.stringify({ language: "zh-CN" }));
Object.assign(dom.window, { electronBridge: {} });
const originalBridge = { ...await import("../src/lib/desktop-bridge") };
let receive: ((event: { payload: string }) => void) | undefined;
const commands: RuntimeCommand[] = [];
mock.module("../src/lib/desktop-bridge", () => ({ ...originalBridge,
  invoke: async (name: string, args?: { cmd: string }) => { if (name === "runtime_send" && args) commands.push(JSON.parse(args.cmd)); return null; },
  listen: async (_name: string, callback: typeof receive) => { receive = callback; return () => {}; },
}));
const { createRoot } = await import("react-dom/client");
const { useStore, initBridge } = await import("../src/store");
const { ClaudeCodeSyncButton } = await import("../src/components/settings/ClaudeCodeSyncButton");
const { PersonalizationSection } = await import("../src/components/settings/personalization-section");
const { McpSection } = await import("../src/components/settings/mcp-section");
const { SkillsSection } = await import("../src/components/settings/SkillsSection");
const { ModelsSection } = await import("../src/components/settings/models-section");
const { ConfigurationSection } = await import("../src/components/settings/configuration-section");
const { requestClaudeSync } = await import("../src/lib/claude-code-sync");
const { useMcpIcons } = await import("../src/lib/mcp-icons");
const { getConfirmationRequest, resolveConfirmation } = await import("../src/lib/confirm-action");
const { translateCurrent: t } = await import("../src/localization");
initBridge(); await Promise.resolve();
const originalState = useStore.getState();
const emit = (event: RuntimeEvent) => receive?.({ payload: JSON.stringify(event) });
const lastSync = () => commands.filter((cmd): cmd is Extract<RuntimeCommand, { type: "claude-code.sync" }> => cmd.type === "claude-code.sync").at(-1)!;
const result = (status: ClaudeCodeSyncResult["status"], extra: Partial<ClaudeCodeSyncResult> = {}): ClaudeCodeSyncResult => ({ target: "prompt", status, revision: "revision", found: 1, added: 0, updated: 0, skipped: 0, failed: 0, conflicts: [], issues: [], ...extra });
const reply = (value: ClaudeCodeSyncResult) => emit({ type: "claude-code.synced", requestId: lastSync().requestId, result: value });
const button = (text: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
async function mounted(ui: React.ReactNode, run: (host: HTMLDivElement) => Promise<void>) {
  const host = dom.window.document.createElement("div"); dom.window.document.body.append(host); const root = createRoot(host);
  try { await act(async () => root.render(ui)); await run(host); }
  finally { await act(async () => root.unmount()); host.remove(); }
}
function edit(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}
afterAll(() => {
  useStore.setState(originalState, true); dom.window.close();
  for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

test("MCP standby stays enabled and opens its actions without connecting", async () => {
  const server = { id: "standby-test", name: "Standby test", command: "node", args: ["server.js"], available: true, connected: false, toolCount: 3 };
  const connectedServer = { id: "connected-test", name: "Connected test", command: "node", args: ["other.js"], available: true, connected: true, toolCount: 2 };
  useStore.setState({ connected: true, mcpServers: [server, connectedServer], mcpConnectingIds: [] });
  const before = commands.length;
  await mounted(<McpSection />, async host => {
    const findCard = (name: string) => [...host.querySelectorAll<HTMLElement>(".settings-mcp-card")].find(item => item.querySelector("strong")?.textContent === name)!;
    const card = findCard(server.name);
    expect(card.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(card.querySelector(".settings-mcp-badge.is-standby")?.textContent).toBe(t("mcp.standbyStatus"));
    expect(card.classList.contains("is-error")).toBe(false);
    expect(findCard(connectedServer.name).querySelector(".settings-mcp-badge.is-connected")?.textContent).toBe(t("mcp.connectedStatus"));
    await act(async () => card.click());
    expect(dom.window.document.querySelector(".settings-mcp-action-dialog")).not.toBeNull();
    expect(commands.slice(before).some(command => command.type === "mcp.connect")).toBe(false);
  });
});

test("all three settings sections expose one sync entry", () => {
  useStore.setState({ connected: true, globalPromptLoaded: true });
  for (const Component of [PersonalizationSection, McpSection, SkillsSection]) {
    const markup = renderToStaticMarkup(<Component />);
    expect(markup.split(t("claudeSync.button")).length - 1).toBe(1);
  }
});

test("button waits for results, blocks duplicate clicks, distinguishes no installation and surfaces correlated errors", async () => {
  await mounted(<ClaudeCodeSyncButton target="prompt" />, async () => {
    const before = commands.length;
    await act(async () => { button(t("claudeSync.button")).click(); });
    const waiting = button(t("claudeSync.syncing")); expect(waiting.disabled).toBe(true);
    await act(async () => waiting.click()); expect(commands.length - before).toBe(1);
    await act(async () => reply(result("not-installed", { found: 0 })));
    expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe(t("claudeSync.status.not-installed"));
    await act(async () => button(t("claudeSync.done")).click());
    await act(async () => button(t("claudeSync.button")).click());
    await act(async () => emit({ type: "error", requestId: lastSync().requestId, message: "Cannot read CLAUDE.md" }));
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toBe("Cannot read CLAUDE.md");
  });
  await expect(requestClaudeSync("mcp", async () => false)).rejects.toThrow();
});

test("conflicting MCP replacement requires confirmation and displays partial storage failures", async () => {
  await mounted(<ClaudeCodeSyncButton target="mcp" />, async () => {
    await act(async () => button(t("claudeSync.button")).click());
    const before = commands.length;
    await act(async () => reply(result("confirm", { target: "mcp", conflicts: ["Existing"], revision: "confirmed-revision" })));
    expect(commands).toHaveLength(before);
    expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain("Existing");
    await act(async () => button(t("claudeSync.replace")).click());
    expect(lastSync()).toMatchObject({ target: "mcp", apply: true, revision: "confirmed-revision" });
    await act(async () => reply(result("complete", { target: "mcp", failed: 1, issues: [{ name: "Existing", code: "storage" }] })));
    expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe(t("claudeSync.partial"));
    expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain(t("claudeSync.issue.storage"));
  });
});

test("prompt confirmation pauses old autosave, cancel preserves draft, success cannot be overwritten even with unchanged stored content", async () => {
  useStore.setState({ connected: true, globalPromptLoaded: true, globalPrompt: "stored rules" });
  await mounted(<PersonalizationSection />, async host => {
    const textarea = host.querySelector<HTMLTextAreaElement>(".settings-global-prompt-input")!;
    await act(async () => edit(textarea, "unsaved draft")); expect(textarea.value).toBe("unsaved draft");
    await act(async () => button(t("claudeSync.button")).click());
    expect(textarea.disabled).toBe(true);
    await act(async () => reply(result("confirm", { conflicts: ["Qone.md"] })));
    const before = commands.filter(cmd => cmd.type === "global-prompt.set").length;
    await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
    expect(commands.filter(cmd => cmd.type === "global-prompt.set")).toHaveLength(before);
    await act(async () => button(t("common.cancel")).click());
    expect(textarea.disabled).toBe(false); expect(textarea.value).toBe("unsaved draft");
    await act(async () => button(t("claudeSync.button")).click());
    await act(async () => reply(result("ready")));
    expect(lastSync().apply).toBe(true);
    await act(async () => { emit({ type: "global-prompt", content: "stored rules", path: "Qone.md", directory: "test" }); reply(result("complete", { skipped: 1 })); });
    expect(textarea.value).toBe("stored rules"); expect(textarea.disabled).toBe(false);
    await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
    expect(commands.filter(cmd => cmd.type === "global-prompt.set")).toHaveLength(before);
    await act(async () => button(t("claudeSync.done")).click());
    await act(async () => edit(textarea, "manual edit"));
    await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
    expect(commands.at(-1)).toMatchObject({ type: "global-prompt.set", content: "manual edit" });
  });
});

test("MCP sync belongs to the title row and preset reconnect reuses imported credentials", async () => {
  const server = { id: "claude-cf", name: "cloudflare-api", url: "https://mcp.cloudflare.com/mcp", authMode: "oauth" as const, headers: { "X-Test": "$mcp.env:claude-cf/header" } };
  useStore.setState({ connected: true, mcpServers: [server], mcpConnectingIds: [] });
  await mounted(<McpSection />, async host => {
    const sync = button(t("claudeSync.button"));
    expect(sync.closest(".settings-section-toolbar")?.querySelector("h2")?.textContent).toBe(t("mcp.title"));
    expect(sync.parentElement?.querySelector(`[aria-label="${t("claudeSync.remove")}"]`)).not.toBeNull();
    expect(host.querySelectorAll(".settings-mcp-card").length).toBeGreaterThan(0);
    expect([...host.querySelectorAll(".settings-mcp-card strong")].some(item => item.textContent === server.name)).toBe(false);
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Cloudflare"]')!;
    await act(async () => toggle.click());
    expect(commands.filter(cmd => cmd.type === "mcp.connect").at(-1)).toMatchObject({ config: server });
    await act(async () => emit({ type: "error", requestId: commands.filter(cmd => cmd.type === "mcp.connect").at(-1)!.requestId, message: "test" }));
    expect(useStore.getState().mcpConnectingIds).not.toContain(server.id);
    await act(async () => (toggle.closest(".settings-mcp-card") as HTMLElement).click());
    await act(async () => button(t("mcp.reconnect")).click());
    expect(commands.filter(cmd => cmd.type === "mcp.connect").at(-1)).toMatchObject({ config: server, reconnect: true });
  });
  // Synced custom services look like presets: official icon, switch, and switching off keeps the config.
  const deepwiki = { id: "claude-deepwiki", name: "deepwiki", command: "npx", args: ["-y", "mcp-deepwiki@latest"], connected: true, toolCount: 3 };
  useStore.setState({ mcpServers: [deepwiki], mcpConnectingIds: [] });
  useMcpIcons.setState({ [deepwiki.id]: "data:image/png;base64,AA==" }, true);
  await mounted(<McpSection />, async host => {
    const card = [...host.querySelectorAll(".settings-mcp-card")].find(item => item.querySelector("strong")?.textContent === "deepwiki")!;
    expect(card.querySelector<HTMLImageElement>(".settings-mcp-avatar")?.src).toBe("data:image/png;base64,AA==");
    await act(async () => card.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(commands.at(-1)).toMatchObject({ type: "mcp.disconnect", serverId: deepwiki.id });
  });
  // One pasted line adds the service: a known service lands on its preset and keys become encrypted references.
  useStore.setState({ mcpServers: [], mcpConnectingIds: [] });
  await mounted(<McpSection />, async () => {
    await act(async () => button(t("mcp.addService")).click());
    const input = dom.window.document.querySelector<HTMLInputElement>(".settings-mcp-quick-add input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "EXA_API_KEY=plain-key npx -y exa-mcp-server");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    expect(dom.window.document.querySelector(".settings-mcp-quick-add p")?.textContent).toContain("exa");
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(commands.find(cmd => cmd.type === "secret.set" && cmd.key === "mcp.env:mcp-exa/EXA_API_KEY")).toBeTruthy();
    const connect = commands.filter(cmd => cmd.type === "mcp.connect").at(-1);
    expect(connect).toMatchObject({ config: { id: "mcp-exa", name: "Exa", command: "npx", env: { EXA_API_KEY: "$mcp.env:mcp-exa/EXA_API_KEY" } } });
    expect(JSON.stringify(connect)).not.toContain("plain-key");
  });
  // A README example value must be replaced in place before anything is saved.
  useStore.setState({ mcpServers: [], mcpConnectingIds: [] });
  await mounted(<McpSection />, async () => {
    await act(async () => button(t("mcp.addService")).click());
    const doc = dom.window.document;
    const type = async (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await type(doc.querySelector<HTMLInputElement>(".settings-mcp-quick-add input")!, '{"mcpServers":{"tavily":{"command":"npx","args":["-y","tavily-mcp"],"env":{"TAVILY_API_KEY":"YOUR_API_KEY"}}}}');
    const field = doc.querySelector<HTMLInputElement>('.settings-mcp-quick-fields input[aria-label="TAVILY_API_KEY"]')!;
    expect(field.value).toBe("");
    expect(button(t("mcp.add")).disabled).toBe(true);
    await type(field, "tvly-real");
    expect(button(t("mcp.add")).disabled).toBe(false);
    await act(async () => { button(t("mcp.add")).click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(commands.find(cmd => cmd.type === "secret.set" && cmd.key === "mcp.env:mcp-tavily/TAVILY_API_KEY" && cmd.value === "tvly-real")).toBeTruthy();
    expect(JSON.stringify(commands)).not.toContain("YOUR_API_KEY");
    // A failed connection keeps the popover and the typed values so the key can be fixed in place.
    let connect = commands.filter(cmd => cmd.type === "mcp.connect").at(-1)!;
    await act(async () => { emit({ type: "error", requestId: connect.requestId, message: "invalid api key" }); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(doc.querySelector(".settings-mcp-quick-add p")?.textContent).toContain("invalid api key");
    expect(doc.querySelector<HTMLInputElement>('.settings-mcp-quick-fields input[aria-label="TAVILY_API_KEY"]')!.value).toBe("tvly-real");
    // Success closes it only once the service is really connected.
    await act(async () => { button(t("mcp.add")).click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    connect = commands.filter(cmd => cmd.type === "mcp.connect").at(-1)!;
    expect(doc.querySelector(".settings-mcp-quick-add")).not.toBeNull();
    await act(async () => {
      emit({ type: "mcp.list", servers: [{ ...connect.config, connected: false }] });
      emit({ type: "mcp.connected", serverId: connect.config.id, toolCount: 3 });
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(doc.querySelector(".settings-mcp-quick-add")?.getAttribute("data-state") ?? "closed").toBe("closed");
  });
  const github = { id: "mcp-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authMode: "github-device" as const, oauthClientId: "saved-client" };
  useStore.setState({ mcpServers: [github], mcpConnectingIds: [] });
  await mounted(<McpSection />, async host => {
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="GitHub"]')!.click());
    expect(commands.filter(cmd => cmd.type === "mcp.connect").at(-1)).toMatchObject({ config: github });
    expect(dom.window.document.querySelector('[aria-label="' + t("mcp.githubLoginTitle") + '"]')).toBeNull();
  });
});

test("synced skills can be removed after confirmation and disappear only after runtime success", async () => {
  const skill = { id: "synced", name: "synced", path: "C:/claude/skills/synced/SKILL.md", description: "synced skill" };
  useStore.setState({ connected: true, skills: [skill] });
  await mounted(<SkillsSection />, async host => {
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="' + t("skills.delete", { name: skill.name }) + '"]')!;
    expect(remove).not.toBeNull();
    const before = commands.length;
    await act(async () => remove.click()); expect(getConfirmationRequest()).not.toBeNull();
    await act(async () => resolveConfirmation(false)); expect(commands.length).toBe(before);
    await act(async () => remove.click()); await act(async () => resolveConfirmation(true));
    const cmd = commands.filter(cmd => cmd.type === "skills.delete").at(-1)!;
    expect(cmd).toMatchObject({ skillId: skill.id }); expect(remove.disabled).toBe(true);
    expect(useStore.getState().skills).toHaveLength(1);
    await act(async () => emit({ type: "skills.deleted", requestId: cmd.requestId, skillId: skill.id }));
    expect(useStore.getState().skills).toEqual([]); expect(host.querySelector('[aria-label="' + t("skills.delete", { name: skill.name }) + '"]')).toBeNull();
  });
});

test("external model configuration events refresh open model and provider settings", async () => {
  await act(async () => { emit({ type: "pong", requestId: "file-change", compaction: { autoCompactionEnabled: false, compactionThreshold: 75 } }); });
  expect(useStore.getState().compactionThreshold).toBe(75);
  expect(useStore.getState().autoCompactionEnabled).toBe(false);
  const config = (model: string) => ({ id: `live/${model}`, provider: "live", model, config: { baseUrl: "https://example.com" }, enabled: true, updatedAt: 0 });
  dom.window.localStorage.setItem("qone-model-providers", "[]");
  await act(async () => { emit({ type: "model.list", configs: [config("before-edit")] }); });
  for (const Component of [ModelsSection, ConfigurationSection]) await mounted(<Component />, async host => {
    await act(async () => { emit({ type: "model.list", configs: [config("after-edit"), config("another")] }); });
    expect(JSON.parse(dom.window.localStorage.getItem("qone-model-providers")!)[0].models.map((model: { id: string }) => model.id)).toEqual(["after-edit", "another"]);
    if (Component === ModelsSection) {
      expect(host.textContent).toContain("after-edit");
      expect(host.textContent).not.toContain("before-edit");
    } else expect(host.querySelector(".settings-provider-copy")?.textContent).toContain("2");
    await act(async () => { emit({ type: "model.list", configs: [config("before-edit")] }); });
  });
});

test("saved imported headers do not trigger an automatic connection and edits retain headers, OAuth and SSE", async () => {
  const server = { id: "imported", name: "Imported", transport: "sse" as const, url: "https://example.com/mcp", authMode: "oauth" as const, headers: { "X-Key": "$mcp.env:imported/key" } };
  const before = commands.length;
  await act(async () => { emit({ type: "mcp.oauth.saved", serverId: server.id, key: "mcp.env:imported/key" }); emit({ type: "mcp.oauth.saved", serverId: server.id, key: "mcp.oauth:imported.tokens" }); emit({ type: "mcp.list", servers: [server] }); });
  expect(commands.slice(before).some(cmd => cmd.type === "secret.set" || cmd.type === "mcp.connect")).toBe(false);
  await mounted(<McpSection />, async host => {
    const card = [...host.querySelectorAll<HTMLElement>(".settings-mcp-card")].find(item => item.textContent?.includes("Imported"))!;
    await act(async () => card.click());
    await act(async () => button(t("mcp.editService")).click());
    await act(async () => button(t("mcp.connect")).click());
    expect(commands.filter(cmd => cmd.type === "mcp.connect").at(-1)).toMatchObject({ config: server });
  });
});

test("saved key and account presets reconnect unchanged; switching off keeps configurations and credentials", async () => {
  const firecrawl = { id: "imported-fc", name: "firecrawl", command: "C:/custom/start-firecrawl-mcp.cmd", disabled: true };
  const email = { id: "mcp-gmail", name: "Gmail", command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"], disabled: true };
  for (const saved of [firecrawl, email]) {
    const name = saved === firecrawl ? "Firecrawl" : "Gmail";
    useStore.setState({ mcpServers: [saved], mcpConnectingIds: [], oauthAuthorization: undefined, githubDeviceAuthorization: undefined });
    await mounted(<McpSection />, async host => {
      const toggle = host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)!;
      expect(toggle.closest(".settings-mcp-card")?.classList.contains("is-error")).toBe(false);
      await act(async () => toggle.click());
      expect(commands.filter(cmd => cmd.type === "mcp.connect").at(-1)).toMatchObject({ config: saved });
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => emit({ type: "mcp.list", servers: [{ ...saved, disabled: undefined, connected: true, connecting: false }] }));
      const before = commands.length;
      await act(async () => toggle.click());
      expect(commands.slice(before)).toEqual([expect.objectContaining({ type: "mcp.disconnect", serverId: saved.id })]);
    });
  }
  const cf = { id: "imported-cf", name: "cloudflare-api", url: "https://mcp.cloudflare.com/mcp", authMode: "oauth" as const, connected: true };
  useStore.setState({ mcpServers: [cf], mcpConnectingIds: [] });
  await mounted(<McpSection />, async host => {
    const before = commands.length;
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Cloudflare"]')!.click());
    expect(commands.slice(before)).toEqual([expect.objectContaining({ type: "mcp.disconnect", serverId: cf.id })]);
  });
  // First-time configuration still asks for the key.
  useStore.setState({ mcpServers: [], mcpConnectingIds: [] });
  await mounted(<McpSection />, async host => {
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Firecrawl"]')!.click());
    expect(dom.window.document.querySelector('input[type="password"]')).not.toBeNull();
  });
});

test("manual MCP dialog portals above settings and connects with only URL and optional API key", async () => {
  useStore.setState({ connected: true, mcpServers: [], mcpConnectingIds: [] });
  await mounted(<McpSection />, async host => {
    await act(async () => button(t("mcp.addService")).click());
    await act(async () => button(t("mcp.quickAdd.manual")).click());
    // 弹窗必须通过 portal 挂载在 document.body 下，避免被 settings-dialog-content 的 mask-image 裁剪
    expect(host.querySelector(".settings-subdialog-layer")).toBeNull();
    const dialog = dom.window.document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    const urlInput = dialog.querySelector<HTMLInputElement>('input[placeholder="https://…"]')!;
    const keyInput = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(urlInput).not.toBeNull();
    expect(keyInput).not.toBeNull();
    // 默认远程模式下不展示 OAuth / 命令 / 环境变量等冗余输入项
    expect(dialog.querySelector("textarea")).toBeNull();

    const type = (el: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    await act(async () => {
      type(urlInput, "https://mcp.demo.dev/sse");
      type(keyInput, "sk-secret-123");
    });
    const before = commands.length;
    await act(async () => {
      button(t("mcp.connect")).click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const recent = commands.slice(before);
    expect(recent.find((cmd) => cmd.type === "secret.set" && cmd.key === "mcp.env:demo/header-authorization" && cmd.value === "Bearer sk-secret-123")).toBeTruthy();
    const connectCmd = recent.find((cmd) => cmd.type === "mcp.connect");
    expect(connectCmd).toMatchObject({
      config: {
        id: "demo",
        name: "demo",
        url: "https://mcp.demo.dev/sse",
        headers: { Authorization: "$mcp.env:demo/header-authorization" },
      },
    });
    expect(JSON.stringify(connectCmd)).not.toContain("sk-secret-123");
    expect(dom.window.document.querySelector(".settings-subdialog-layer")).toBeNull();
  });
});
