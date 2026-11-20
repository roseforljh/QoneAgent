import { runtimeText, runtimeError } from "./runtime-localization";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { isDouyinUrl, isSecureServiceUrl, type BrowserSyncStatus } from "@qone/protocol";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ffmpegExecutable, ytDlpExecutable } from "./reach-channels.js";
import { findSite, siteMatchesHost } from "@qone/protocol";
import { browserScreenshotResult } from "./web-image.js";
import { currentBrowserSessionId, withBrowserSessionId, type AppOpenCliBridge } from "./app-opencli-bridge.js";

// Source directory in development; the bundle's own directory (binaries) when packaged.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const SESSION = "qone";
const COMMAND_TIMEOUT = 90_000;
const BROWSER_WAIT_MAX_SECONDS = 60;

type CommandResult = { stdout: string; stderr: string };

export type EmbeddedOpenCliRunner = (
  site: string,
  args: string[],
  timeout?: number,
  signal?: AbortSignal,
  allowBrowserPages?: boolean,
) => Promise<CommandResult>;

/** OpenCLI follows sysexits.h; 69 (EX_UNAVAILABLE) means the built-in browser target is unavailable. */

export class OpenCliError extends Error {
  constructor(message: string, readonly exitCode: number | null) { super(message); }
}

type OpenCliArgument = {
  name: string;
  type?: string;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  default?: unknown;
  help?: string;
};

type OpenCliCommand = {
  command: string;
  site: string;
  name: string;
  description: string;
  access?: string;
  strategy?: string;
  browser?: boolean;
  args?: OpenCliArgument[];
  siteSession?: string | null;
};

type OpenCliFormat = "json" | "yaml" | "table" | "plain" | "md" | "csv";

const OPENCLI_CATALOG_TTL = 5 * 60_000;
const MAX_TOOL_OUTPUT = 80_000;

/** Enforce the selected site backend before any process or built-in browser session starts. */
export function assertOpenCliRoute(args: readonly string[]): void {
  if (args[0]?.trim().toLowerCase() === "douyin" || args.some((arg) =>
    (arg.match(/https?:\/\/[^\s"'<>]+/gi) ?? []).some(isDouyinUrl))) {
    throw runtimeError("browser-sync.douyin_embedded_route_required", {});
  }
}

export function runOpenCli(args: string[], timeout = COMMAND_TIMEOUT, signal?: AbortSignal, extraEnv?: Record<string, string | undefined>, allowBrowserPages = false): Promise<CommandResult> {
  if (!allowBrowserPages) assertOpenCliRoute(args);
  // Every execution entry except the private catalog reader must carry the
  // endpoint prepared by AppOpenCliBridge. Without this fail-closed guard,
  // OpenCLI can fall back to its own Browser Bridge and reach the user's browser.
  if (!extraEnv?.OPENCLI_CDP_ENDPOINT?.trim()) throw new Error("OpenCLI requires Qone's built-in browser target");
  return runOpenCliProcess(args, timeout, signal, extraEnv);
}

function runOpenCliProcess(args: string[], timeout: number, signal?: AbortSignal, extraEnv?: Record<string, string | undefined>): Promise<CommandResult> {
  const launch = bundledOpenCli(args);
  if (!launch) throw new Error("Bundled OpenCLI is unavailable; refusing to start an unbound external browser");
  const toolDirectories = [...new Set([ytDlpExecutable(), ffmpegExecutable()].filter((value): value is string => Boolean(value)).map((value) => path.dirname(value)))];
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(), env: { ...process.env, ...extraEnv, ...launch.env, NO_COLOR: "1", PATH: [...toolDirectories, process.env.PATH].filter(Boolean).join(path.delimiter) }, windowsHide: true, signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = timeout > 0 ? setTimeout(() => { child.kill(); reject(runtimeError("browser-sync.opencli_operation_timed_out", {})); }, timeout) : undefined;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new OpenCliError((stderr || stdout || runtimeText("browser-sync.opencli_exit_code", { p0: code })).trim(), code));
    });
  });
}

export function normalizeBrowserWaitValue(kind: string, value: string): string {
  if (kind !== "time") return value;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Browser time waits must be a non-negative number of seconds");
  return String(Math.min(Math.floor(seconds), BROWSER_WAIT_MAX_SECONDS));
}

export function bundledOpenCli(args: string[]): { command: string; args: string[]; env: Record<string, string> } | undefined {
  // The desktop shell passes its Electron binary; a standalone dev runtime uses the system Node.
  const node = process.env.QONE_NODE_EXECUTABLE || "node";
  const roots = [
    moduleDirectory,
    path.resolve(moduleDirectory, "../../desktop/binaries"),
    path.join(process.cwd(), "apps", "desktop", "binaries"),
  ];
  for (const root of roots) {
    const entry = path.join(root, "opencli", "qone-entry.mjs");
    if (existsSync(entry)) return { command: node, args: [entry, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return undefined;
}

export function createEmbeddedOpenCliRunner(bridge: AppOpenCliBridge): EmbeddedOpenCliRunner {
  return (site, args, timeout = COMMAND_TIMEOUT, signal, allowBrowserPages = false) => {
    const target = site === "browser" ? args.find((arg) => /^https?:\/\//i.test(arg)) : openCliTargetUrl(site, args);
    if (!target) throw new Error(`No built-in browser target is available for ${site}`);
    return runEmbeddedOpenCli(bridge, site, args, target, timeout, signal, allowBrowserPages);
  };
}

async function runEmbeddedOpenCli(
  bridge: AppOpenCliBridge,
  site: string,
  args: string[],
  target: string,
  timeout: number,
  signal?: AbortSignal,
  allowBrowserPages = false,
): Promise<CommandResult> {
  const prepared = await bridge.prepare(site, target, signal);
  try {
    const targetPattern = openCliTargetPattern(site, target);
    const env = { OPENCLI_CDP_ENDPOINT: prepared.endpoint, OPENCLI_CDP_TARGET: targetPattern };
    return await runOpenCli(args, timeout, signal, env, allowBrowserPages);
  } finally {
    bridge.release(prepared.requestId);
  }
}

function result(value: CommandResult): { content: [{ type: "text"; text: string }] } {
  const text = value.stdout || value.stderr || runtimeText("browser-sync.done");
  return { content: [{ type: "text", text: text.length > MAX_TOOL_OUTPUT ? runtimeText("browser-sync.output_truncated", { p0: text.slice(0, MAX_TOOL_OUTPUT) }) : text }] };
}

export function loginRequiredResult(error: unknown, site?: string): { content: [{ type: "text"; text: string }] } | undefined {
  if (!(error instanceof OpenCliError) || error.exitCode !== 77) return undefined;
  return result({
    stdout: JSON.stringify({
      status: "login_required",
      site: site || undefined,
      scope: "operation",
      detail: error.message,
      next: "Only this operation requires sign-in. If the task is to read a supplied link, follow the direct URL reading policy before asking the user to sign in. If sign-in is necessary for the requested task, tell the user to sign in on the page shown in Qone's built-in browser and end the turn; retry after the user confirms. Sign-in state is kept for later sessions.",
    }),
    stderr: "",
  });
}

export function parseOpenCliCatalog(text: string): OpenCliCommand[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw runtimeError("browser-sync.invalid_opencli_command_registry_format", {});
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (typeof value.command !== "string" || typeof value.site !== "string" || typeof value.name !== "string") return [];
    const args = Array.isArray(value.args)
      ? value.args.flatMap((arg) => {
          if (!arg || typeof arg !== "object" || typeof (arg as Record<string, unknown>).name !== "string") return [];
          const option = arg as Record<string, unknown>;
          return [{
            name: option.name as string,
            type: typeof option.type === "string" ? option.type : undefined,
            required: typeof option.required === "boolean" ? option.required : undefined,
            positional: typeof option.positional === "boolean" ? option.positional : undefined,
            choices: Array.isArray(option.choices) ? option.choices.filter((choice): choice is string => typeof choice === "string") : undefined,
            default: option.default,
            help: typeof option.help === "string" ? option.help : undefined,
          } satisfies OpenCliArgument];
        })
      : undefined;
    return [{
      command: value.command,
      site: value.site,
      name: value.name,
      description: typeof value.description === "string" ? value.description : "",
      access: typeof value.access === "string" ? value.access : undefined,
      strategy: typeof value.strategy === "string" ? value.strategy : undefined,
      browser: typeof value.browser === "boolean" ? value.browser : undefined,
      args,
      siteSession: typeof value.siteSession === "string" ? value.siteSession : value.siteSession === null ? null : undefined,
    } satisfies OpenCliCommand];
  });
}

function hasCliOption(args: string[], ...names: string[]): boolean {
  return args.some((arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)));
}

export function buildOpenCliCommandArgs(value: {
  site: string;
  command: string;
  args?: string[];
  format?: OpenCliFormat;
  window?: "foreground" | "background";
  siteSession?: "ephemeral" | "persistent";
  keepTab?: boolean;
  profile?: string;
}): string[] {
  const site = value.site.trim();
  const command = value.command.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(site) || !/^[a-z0-9][a-z0-9_-]*$/i.test(command)) {
    throw runtimeError("browser-sync.opencli_site_and_command_may_only_contain_letters_numbers", {});
  }
  const args = [...(value.args ?? [])];
  if (!hasCliOption(args, "--format", "-f")) args.push("--format", value.format ?? "json");
  if (value.window && !hasCliOption(args, "--window")) args.push("--window", value.window);
  if (value.siteSession && !hasCliOption(args, "--site-session")) args.push("--site-session", value.siteSession);
  if (typeof value.keepTab === "boolean" && !hasCliOption(args, "--keep-tab")) args.push("--keep-tab", String(value.keepTab));
  if (value.profile?.trim() && !hasCliOption(args, "--profile")) args.push("--profile", value.profile.trim());
  return [site, command, ...args];
}

export function compactOpenCliCatalog(commands: OpenCliCommand[], site?: string, query?: string, limit = 40): unknown {
  const normalizedSite = site?.trim().toLowerCase();
  const normalizedQuery = query?.trim().toLowerCase() ?? "";
  const keywords = [...new Set(normalizedQuery.split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  const filtered = commands.flatMap((command) => {
    if (normalizedSite && command.site.toLowerCase() !== normalizedSite) return [];
    const name = command.name.toLowerCase();
    const text = `${normalizedSite ? "" : command.site} ${name} ${command.description}`.toLowerCase();
    const score = keywords.reduce((total, word) => total + (name === word ? 3 : name.includes(word) ? 2 : text.includes(word) ? 1 : 0), 0);
    return !keywords.length || score > 0 ? [{ command, score: score + (normalizedQuery === name ? 1 : 0) }] : [];
  }).sort((a, b) => b.score - a.score);
  if (!normalizedSite && !normalizedQuery) {
    const sites = new Map<string, number>();
    for (const { command } of filtered) sites.set(command.site, (sites.get(command.site) ?? 0) + 1);
    return { totalCommands: commands.length, sites: [...sites.entries()].map(([name, count]) => ({ name, count })) };
  }
  return {
    totalMatches: filtered.length,
    commands: filtered.slice(0, Math.max(1, Math.min(limit, 100))).map(({ command }) => ({
      site: command.site,
      command: command.name,
      description: command.description,
      access: command.access,
      strategy: command.strategy,
      browser: command.browser,
      siteSession: command.siteSession,
      args: command.args?.map((arg) => ({ name: arg.name, type: arg.type, required: arg.required, positional: arg.positional, choices: arg.choices, default: arg.default, help: arg.help })),
    })),
  };
}

export class BrowserSyncService {
  private statusValue: BrowserSyncStatus;
  private pending: Promise<unknown> = Promise.resolve();
  private operations = new AbortController();
  private embeddedBrowser?: { requestId: string; url?: string; sessionId?: string };
  private openCliCatalog?: { loadedAt: number; commands: OpenCliCommand[] };
  private openCliCatalogPromise?: Promise<OpenCliCommand[]>;

  constructor(private readonly changed: (status: BrowserSyncStatus) => void,
    private readonly toolsChanged: () => Promise<void>, private readonly appOpenCliBridge?: AppOpenCliBridge) {
    this.statusValue = { phase: "ready", targetConnected: false };
  }

  status(): BrowserSyncStatus { return { ...this.statusValue }; }

  tools(): ToolDefinition[] {
    return [
      this.openCliDiscoverTool(),
      this.openCliRunTool(),
      this.browserCommand("qone_browser_state", "Read the current page state from Qone's built-in browser.", Type.Object({}), () => ["state"]),
      this.browserCommand("qone_browser_open", "Open the exact URL in Qone's built-in browser when direct fetch is unavailable or insufficient, or the task requires rendered state or interaction.", Type.Object({ url: Type.String() }), (value) => ["open", value.url]),
      this.browserCommand("qone_browser_click", "Click a visible element in Qone's built-in browser. Use the target from qone_browser_state.", Type.Object({ target: Type.String() }), (value) => ["click", value.target]),
      this.browserCommand("qone_browser_fill", "Replace the value of an input in Qone's built-in browser.", Type.Object({ target: Type.String(), text: Type.String() }), (value) => ["fill", value.target, value.text]),
      this.browserCommand("qone_browser_type", "Type text into an element in Qone's built-in browser.", Type.Object({ target: Type.String(), text: Type.String() }), (value) => ["type", value.target, value.text]),
      this.browserCommand("qone_browser_keys", "Press a keyboard key in Qone's built-in browser.", Type.Object({ key: Type.String() }), (value) => ["keys", value.key]),
      this.browserCommand("qone_browser_wait", "Wait for a browser condition such as text, selector, time, or network response. For kind=time, value is seconds and is capped at 60.", Type.Object({ kind: Type.Union([Type.Literal("selector"), Type.Literal("text"), Type.Literal("time"), Type.Literal("xhr"), Type.Literal("download")]), value: Type.String() }), (value) => ["wait", value.kind, normalizeBrowserWaitValue(value.kind, value.value)]),
      // OpenCLI 的 `get text` 必须带元素 target，不能读整页；整页正文统一走 qone_browser_extract。
      this.browserCommand("qone_browser_get", "Read the current page URL or title from Qone's built-in browser. Use qone_browser_extract for page text.", Type.Object({ property: Type.Union([Type.Literal("url"), Type.Literal("title")]) }), (value) => ["get", value.property]),
      this.browserExtractTool(),
      this.browserScreenshotTool(),
      this.browserTabsTool(),
      this.browserCloseTool(),
      this.twitterCommand("qone_twitter_search", "Read adapter search results as structured data.", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer()) }), (value) => ["twitter", "search", value.query, "--limit", String(value.limit ?? 20)]),
      this.twitterCommand("qone_twitter_tweets", "Read an account's latest posts as structured data.", Type.Object({ username: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer()) }), (value) => ["twitter", "tweets", ...(value.username ? [value.username] : []), "--limit", String(value.limit ?? 20)]),
      this.twitterCommand("qone_twitter_profile", "Read an account profile as structured data.", Type.Object({ username: Type.Optional(Type.String()) }), (value) => ["twitter", "profile", ...(value.username ? [value.username] : [])]),
      this.twitterCommand("qone_twitter_timeline", "Read the signed-in account timeline as structured data.", Type.Object({ type: Type.Optional(Type.Union([Type.Literal("for-you"), Type.Literal("following")])), limit: Type.Optional(Type.Integer()) }), (value) => ["twitter", "timeline", "--type", value.type ?? "for-you", "--limit", String(value.limit ?? 20)]),
      this.twitterCommand("qone_twitter_trending", "Read trending topics as structured data.", Type.Object({ limit: Type.Optional(Type.Integer()) }), (value) => ["twitter", "trending", "--limit", String(value.limit ?? 20)]),
    ];
  }

  private openCliDiscoverTool(): ToolDefinition {
    return {
      name: "qone_opencli_discover",
      label: "OpenCLI · discover adapters",
      description: "Discover available site adapter commands for structured or account operations. Pass a site and operation keywords, then use the returned command and args with qone_opencli_run. Commands run through Qone's built-in browser profile.",
      parameters: Type.Object({
        site: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer()),
        refresh: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id: string, value: { site?: string; query?: string; limit?: number; refresh?: boolean }) => {
        if (value.site?.trim().toLowerCase() === "douyin") assertOpenCliRoute([value.site]);
        const commands = await this.loadOpenCliCatalog(Boolean(value.refresh));
        return result({ stdout: JSON.stringify(compactOpenCliCatalog(commands, value.site, value.query, value.limit), null, 2), stderr: "" }) as never;
      },
    } as ToolDefinition;
  }

  private openCliRunTool(): ToolDefinition {
    return {
      name: "qone_opencli_run",
      label: "OpenCLI · site adapter",
      description: "Run a site adapter through Qone's built-in browser profile for structured operations, authenticated data, account pages, or explicit browser-session work. Use qone_opencli_discover first when the command or parameters are unknown. Pass raw adapter arguments in order without the executable name.",
      parameters: Type.Object({
        site: Type.String(),
        command: Type.String(),
        args: Type.Optional(Type.Array(Type.String())),
        format: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("yaml"), Type.Literal("table"), Type.Literal("plain"), Type.Literal("md"), Type.Literal("csv")])),
        window: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")])),
        siteSession: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("persistent")])),
        keepTab: Type.Optional(Type.Boolean()),
        profile: Type.Optional(Type.String()),
      }),
      execute: async (_id: string, value: { site: string; command: string; args?: string[]; format?: OpenCliFormat; window?: "foreground" | "background"; siteSession?: "ephemeral" | "persistent"; keepTab?: boolean; profile?: string }, signal?: AbortSignal) => {
        const args = buildOpenCliCommandArgs(value);
        try { return result(await this.exclusive(owner => this.runOpenCliAdapter(value.site, args, owner), signal)) as never; }
        catch (error) { return (loginRequiredResult(error, value.site) ?? Promise.reject(error)) as never; }
      },
    } as ToolDefinition;
  }

  private async loadOpenCliCatalog(force = false): Promise<OpenCliCommand[]> {
    const now = Date.now();
    if (!force && this.openCliCatalog && now - this.openCliCatalog.loadedAt < OPENCLI_CATALOG_TTL) return this.openCliCatalog.commands;
    if (!force && this.openCliCatalogPromise) return this.openCliCatalogPromise;
    const load = runOpenCliProcess(["list", "--format", "json"], COMMAND_TIMEOUT).then(({ stdout }) => {
      const commands = parseOpenCliCatalog(stdout).filter((command) => command.site.toLowerCase() !== "douyin");
      if (!commands.length) throw runtimeError("browser-sync.opencli_returned_no_available_adapter_commands", {});
      this.openCliCatalog = { loadedAt: Date.now(), commands };
      return commands;
    });
    this.openCliCatalogPromise = load;
    try { return await load; }
    finally { if (this.openCliCatalogPromise === load) this.openCliCatalogPromise = undefined; }
  }

  private browserCommand(name: string, description: string, parameters: ReturnType<typeof Type.Object>, args: (value: any) => string[]): ToolDefinition {
    return {
      name, label: `OpenCLI · ${name.replace("qone_browser_", "")}`, description, parameters,
      execute: async (_id: string, value: any, signal?: AbortSignal) => {
        try { return result(await this.runBrowserCommand(args(value), signal)) as never; }
        catch (error) { return (loginRequiredResult(error, this.browserSite()) ?? Promise.reject(error)) as never; }
      },
    } as ToolDefinition;
  }

  private browserScreenshotTool(): ToolDefinition {
    return {
      name: "qone_browser_screenshot",
      label: "OpenCLI · screenshot",
      description: "Capture the current Qone built-in browser page as a PNG image and return it for visual inspection. Use this after qone_browser_extract when the page contains relevant images, charts, screenshots, or other visual content. This uses the shared built-in browser session and captures the full page.",
      parameters: Type.Object({}),
      execute: async (_id, _value, signal) => {
        try { return browserScreenshotResult((await this.runBrowserCommand(["screenshot", "--full-page"], signal)).stdout) as never; }
        catch (error) { return (loginRequiredResult(error, this.browserSite()) ?? Promise.reject(error)) as never; }
      },
    } as ToolDefinition;
  }

  private browserExtractTool(): ToolDefinition {
    return {
      name: "qone_browser_extract",
      label: "OpenCLI · extract",
      description: "Extract the current Qone built-in browser page as readable Markdown. Use qone_browser_screenshot separately when visual inspection is required. Open the requested URL first so the current tab is the target page.",
      parameters: Type.Object({ includeScreenshot: Type.Optional(Type.Boolean({ description: "Capture a full-page screenshot only when visual inspection is required" })) }),
      execute: async (_id, value: { includeScreenshot?: boolean }, signal) => {
        try {
          const { extracted, screenshot } = await this.runBrowserExtraction(value.includeScreenshot === true, signal);
          const text = result(extracted).content;
          if (!screenshot) return { content: text } as never;
          try {
            const visual = browserScreenshotResult(screenshot.stdout);
            return { content: [...text, visual.content[1]] } as never;
          } catch (error) {
            return { content: [...text, { type: "text", text: `Page screenshot was unavailable; page images were not inspected. ${String(error)}` }] } as never;
          }
        } catch (error) {
          return (loginRequiredResult(error, this.browserSite()) ?? Promise.reject(error)) as never;
        }
      },
    } as ToolDefinition;
  }

  private twitterCommand(name: string, description: string, parameters: ReturnType<typeof Type.Object>, args: (value: any) => string[]): ToolDefinition {
    return {
      name, label: `OpenCLI · ${name.replace("qone_twitter_", "Twitter ")}`, description, parameters,
      execute: async (_id: string, value: any, signal?: AbortSignal) => {
        try { return result(await this.runTwitterCommand(args(value), signal)) as never; }
        catch (error) { return (loginRequiredResult(error, "twitter") ?? Promise.reject(error)) as never; }
      },
    } as ToolDefinition;
  }

  private browserTabsTool(): ToolDefinition {
    return {
      name: "qone_browser_tabs",
      label: "OpenCLI · tabs",
      description: "List existing tabs available to this conversation in Qone's built-in browser without opening a page or showing the browser panel.",
      parameters: Type.Object({}),
      execute: async (_id, _value, signal) => {
        if (!this.appOpenCliBridge) throw new Error("Built-in browser bridge is unavailable");
        const tabs = await this.appOpenCliBridge.listTabs(signal);
        return result({ stdout: JSON.stringify(tabs, null, 2), stderr: "" }) as never;
      },
    } as ToolDefinition;
  }

  private browserCloseTool(): ToolDefinition {
    return {
      name: "qone_browser_close",
      label: "OpenCLI · close",
      description: "Close the current Qone built-in browser page and release its task session.",
      parameters: Type.Object({}),
      execute: async () => {
        await this.release(true);
        return result({ stdout: runtimeText("browser-sync.built_in_browser_page_closed"), stderr: "" }) as never;
      },
    } as ToolDefinition;
  }

  private exclusive<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = signal ? AbortSignal.any([signal, this.operations.signal]) : this.operations.signal;
    const sessionId = currentBrowserSessionId();
    const next = this.pending.then(() => {
      owner.throwIfAborted();
      return withBrowserSessionId(sessionId, () => work(owner));
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  async initialize(): Promise<void> {
    await this.toolsChanged();
  }

  async connect(): Promise<BrowserSyncStatus> {
    return this.exclusive(() => this.connectInner());
  }

  async openUrl(url: string): Promise<void> {
    if (!isSecureServiceUrl(url)) throw new Error("Browser navigation requires an HTTPS URL");
    await this.runBrowserCommand(["open", url]);
  }

  async currentUrl(): Promise<string> {
    const result = await this.runBrowserCommand(["get", "url"]);
    const url = result.stdout.trim();
    if (!url) throw new Error("Browser returned an empty URL");
    return url;
  }

  async release(close = false): Promise<void> {
    this.operations.abort();
    this.operations = new AbortController();
    this.pending = Promise.resolve();
    const browser = this.embeddedBrowser;
    this.embeddedBrowser = undefined;
    if (browser) this.appOpenCliBridge?.release(browser.requestId, close);
    this.update({ phase: "ready", targetConnected: false, lastError: undefined, errorCode: undefined });
  }

  private async connectInner(): Promise<BrowserSyncStatus> {
    this.update({ phase: "connecting", lastError: undefined, errorCode: undefined });
    this.update({ phase: "ready", targetConnected: true, lastError: undefined, errorCode: undefined });
    await this.toolsChanged();
    return this.status();
  }

  private runBrowserCommand(args: string[], signal?: AbortSignal): Promise<CommandResult> {
    return this.exclusive(async owner => {
      const url = args[0] === "open" ? args[1] : undefined;
      if (args[0] === "open" && (!url || !/^https?:\/\//i.test(url) || !URL.canParse(url))) {
        throw new Error("Browser navigation requires an HTTP or HTTPS URL");
      }
      if (!this.statusValue.targetConnected) await this.connectInner();
      return this.runEmbeddedBrowser(["browser", SESSION, ...args], owner, url);
    }, signal);
  }

  private runBrowserExtraction(includeScreenshot = false, signal?: AbortSignal): Promise<{ extracted: CommandResult; screenshot?: CommandResult }> {
    return this.exclusive(async owner => {
      if (!this.statusValue.targetConnected) await this.connectInner();
      const extracted = await this.runEmbeddedBrowser(["browser", SESSION, "extract"], owner);
      if (!includeScreenshot) return { extracted };
      try {
        return { extracted, screenshot: await this.runEmbeddedBrowser(["browser", SESSION, "screenshot", "--full-page"], owner) };
      } catch {
        owner.throwIfAborted();
        return { extracted };
      }
    }, signal);
  }

  private runTwitterCommand(args: string[], signal?: AbortSignal): Promise<CommandResult> {
    return this.exclusive(owner => this.runOpenCliAdapter("twitter", [...args, "--format", "json"], owner), signal);
  }

  private browserSite(): string | undefined {
    const browser = this.embeddedBrowser;
    if (browser?.sessionId !== currentBrowserSessionId() || !browser?.url) return undefined;
    try { return new URL(browser.url).hostname; }
    catch { return undefined; }
  }

  private async runOpenCliAdapter(site: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
    const target = openCliTargetUrl(site, args);
    if (!target) throw new Error(`No built-in browser target is available for ${site}`);
    return this.runEmbeddedOpenCli(site, args, target, signal);
  }

  private async runEmbeddedOpenCli(site: string, args: string[], target: string, signal?: AbortSignal, allowBrowserPages = false): Promise<CommandResult> {
    if (!this.appOpenCliBridge) throw new Error("Built-in browser bridge is unavailable");
    return runEmbeddedOpenCli(this.appOpenCliBridge, site, args, target, COMMAND_TIMEOUT, signal, allowBrowserPages);
  }

  private async runEmbeddedBrowser(args: string[], signal: AbortSignal, url?: string): Promise<CommandResult> {
    if (!this.appOpenCliBridge) throw new Error("Built-in browser bridge is unavailable");
    signal.throwIfAborted();
    const sessionId = currentBrowserSessionId();
    const reuseRequestId = this.embeddedBrowser && this.embeddedBrowser.sessionId === sessionId
      ? this.embeddedBrowser.requestId
      : undefined;
    if (this.embeddedBrowser && !reuseRequestId) {
      // 切换到不同会话时释放旧句柄，避免跨会话复用同一个页面视图。
      this.appOpenCliBridge.release(this.embeddedBrowser.requestId);
      this.embeddedBrowser = undefined;
    }
    // 只有显式打开才带目标 URL，其余操作只能复用当前会话已有的视图。
    const prepared = await this.appOpenCliBridge.prepare("browser", url, signal, reuseRequestId);
    if (signal.aborted) {
      if (!reuseRequestId) this.appOpenCliBridge.release(prepared.requestId);
      signal.throwIfAborted();
    }
    this.embeddedBrowser = {
      requestId: reuseRequestId ?? prepared.requestId,
      url: prepared.url ?? url,
      sessionId,
    };
    // 上一步操作让页面发起了通行密钥登录（已被内置浏览器拒绝），继续操作只会白等，直接报需要登录。
    if (prepared.loginRequired === "passkey") throw new OpenCliError("The page asked for a passkey sign-in. Qone's built-in browser cannot use passkeys, so the request was rejected; the user has to sign in on this page with another method.", 77);
    return runOpenCli(args, COMMAND_TIMEOUT, signal, {
      OPENCLI_CDP_ENDPOINT: prepared.endpoint,
      OPENCLI_CDP_TARGET: this.browserSite(),
    }, true);
  }

  private update(patch: Partial<BrowserSyncStatus>) {
    this.statusValue = { ...this.statusValue, ...patch };
    this.changed(this.status());
  }

}

function openCliTargetPattern(site: string, target: string): string {
  return findSite(site)?.host ?? new URL(target).hostname;
}

function openCliTargetUrl(site: string, args: string[]): string | undefined {
  const target = findSite(site);
  for (const arg of args) {
    if (!/^https?:\/\//i.test(arg)) continue;
    try {
      const parsed = new URL(arg);
      if (target && siteMatchesHost(target.appId, parsed.hostname)) return parsed.toString();
    } catch { /* Use the site home when an adapter argument is not a URL. */ }
  }
  return target?.homeUrl;
}
