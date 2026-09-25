import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { BrowserSyncStatus } from "@qone/protocol";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Db } from "@qone/database";
import { BrowserLibrary } from "./browser-library.js";
import { resolveStdioLaunch } from "@qone/mcp";

const OPENCLI_PACKAGE = "@jackwener/opencli@1.8.8";
const SESSION = "qone";
const COMMAND_TIMEOUT = 90_000;
const BROWSER_START_DELAY = 800;

type CommandResult = { stdout: string; stderr: string };

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

export function runOpenCli(args: string[], timeout = COMMAND_TIMEOUT): Promise<CommandResult> {
  const launch = bundledOpenCli(args) ?? resolveStdioLaunch("npx", ["--yes", OPENCLI_PACKAGE, ...args]);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(), env: { ...process.env, NO_COLOR: "1" }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("OpenCLI 操作超时")); }, timeout);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error((stderr || stdout || `OpenCLI 退出码 ${code}`).trim()));
    });
  });
}

export function bundledOpenCli(args: string[]): { command: string; args: string[] } | undefined {
  const roots = [
    path.dirname(process.execPath),
    path.join(path.dirname(process.execPath), "binaries"),
    path.resolve(import.meta.dir, "../../desktop/src-tauri/binaries"),
    path.join(process.cwd(), "apps", "desktop", "src-tauri", "binaries"),
  ];
  for (const root of roots) {
    const node = path.join(root, process.platform === "win32" ? "node.exe" : "node");
    const main = path.join(root, "opencli", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
    if (existsSync(node) && existsSync(main)) return { command: node, args: [main, ...args] };
  }
  return undefined;
}

function result(value: CommandResult): { content: [{ type: "text"; text: string }] } {
  const text = value.stdout || value.stderr || "完成";
  return { content: [{ type: "text", text: text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n[输出已截断]` : text }] };
}

export function parseOpenCliCatalog(text: string): OpenCliCommand[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("OpenCLI 命令注册表格式无效");
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
    throw new Error("OpenCLI 的 site 和 command 只能包含字母、数字、下划线或短横线");
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
  const normalizedQuery = query?.trim().toLowerCase();
  const filtered = commands.filter((command) => {
    if (normalizedSite && command.site.toLowerCase() !== normalizedSite) return false;
    if (!normalizedQuery) return true;
    return `${command.site} ${command.name} ${command.description}`.toLowerCase().includes(normalizedQuery);
  });
  if (!normalizedSite && !normalizedQuery) {
    const sites = new Map<string, number>();
    for (const command of commands) sites.set(command.site, (sites.get(command.site) ?? 0) + 1);
    return { totalCommands: commands.length, sites: [...sites.entries()].map(([name, count]) => ({ name, count })) };
  }
  return {
    totalMatches: filtered.length,
    commands: filtered.slice(0, Math.max(1, Math.min(limit, 100))).map((command) => ({
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processRunning(): Promise<boolean> {
  const command = process.platform === "win32" ? "tasklist" : "pgrep";
  const args = process.platform === "win32" ? ["/FI", "IMAGENAME eq chrome.exe", "/NH"] : ["-f", "(Google Chrome|chrome|chromium)"];
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0 && (process.platform === "win32" ? /chrome\.exe/i.test(output) : output.trim().length > 0)));
  });
}

function chromeExecutable(): string | undefined {
  if (process.platform === "win32") {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter((value): value is string => Boolean(value));
    const candidates = roots.map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    return candidates.find((candidate) => existsSync(candidate));
  }
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "google-chrome";
}

function chromeProfileDirectory(): string | undefined {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return undefined;
  try {
    const statePath = path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data", "Local State");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { profile?: { last_used?: unknown } };
    return typeof state.profile?.last_used === "string" && state.profile.last_used.trim()
      ? state.profile.last_used.trim() : undefined;
  } catch { return undefined; }
}

function launchChrome(): Promise<void> {
  const executable = chromeExecutable();
  if (!executable) throw new Error("未找到 Google Chrome，无法启动当前浏览器配置");
  const profile = chromeProfileDirectory();
  const args = ["--new-window", "about:blank"];
  if (profile) args.unshift(`--profile-directory=${profile}`);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true, stdio: "ignore", windowsHide: false,
    });
    child.once("error", (error) => reject(error));
    child.unref();
    void wait(BROWSER_START_DELAY).then(resolve);
  });
}

export class BrowserSyncService {
  private readonly library: BrowserLibrary;
  private readonly libraryTool: ToolDefinition;
  private statusValue: BrowserSyncStatus;
  private pending: Promise<unknown> = Promise.resolve();
  private startedBrowser = false;
  private openCliCatalog?: { loadedAt: number; commands: OpenCliCommand[] };
  private openCliCatalogPromise?: Promise<OpenCliCommand[]>;

  constructor(db: Db, _dbPath: string, private readonly changed: (status: BrowserSyncStatus) => void,
    private readonly toolsChanged: () => Promise<void>) {
    this.library = new BrowserLibrary(db);
    this.libraryTool = this.library.tool();
    this.statusValue = { phase: "ready", targetConnected: false };
  }

  status(): BrowserSyncStatus { return { ...this.statusValue }; }

  tools(): ToolDefinition[] {
    return [
      this.openCliDiscoverTool(),
      this.openCliRunTool(),
      this.browserCommand("qone_browser_state", "Read the current page state from the user's Chrome browser. If Chrome is closed, Qone starts the user's default Chrome profile first.", Type.Object({}), () => ["state"]),
      this.browserCommand("qone_browser_open", "Open a URL for an interactive browser task in the user's Chrome tab. For supported websites, use qone_opencli_run first so OpenCLI can select a browserless adapter when available. If Chrome is closed, Qone starts the user's default Chrome profile first.", Type.Object({ url: Type.String() }), (value) => ["open", value.url]),
      this.browserCommand("qone_browser_click", "Click a visible element in the user's browser. Use the target from qone_browser_state.", Type.Object({ target: Type.String() }), (value) => ["click", value.target]),
      this.browserCommand("qone_browser_fill", "Replace the value of an input in the user's browser.", Type.Object({ target: Type.String(), text: Type.String() }), (value) => ["fill", value.target, value.text]),
      this.browserCommand("qone_browser_type", "Type text into an element in the user's browser.", Type.Object({ target: Type.String(), text: Type.String() }), (value) => ["type", value.target, value.text]),
      this.browserCommand("qone_browser_keys", "Press a keyboard key in the user's browser.", Type.Object({ key: Type.String() }), (value) => ["keys", value.key]),
      this.browserCommand("qone_browser_wait", "Wait for a browser condition such as text, selector, time, or network response.", Type.Object({ kind: Type.Union([Type.Literal("selector"), Type.Literal("text"), Type.Literal("time"), Type.Literal("xhr"), Type.Literal("download")]), value: Type.String() }), (value) => ["wait", value.kind, value.value]),
      this.browserCommand("qone_browser_get", "Read a page property such as URL or title from the user's browser.", Type.Object({ property: Type.Union([Type.Literal("url"), Type.Literal("title"), Type.Literal("text")]) }), (value) => ["get", value.property]),
      this.browserCommand("qone_browser_extract", "Extract the current page as readable Markdown from the user's browser.", Type.Object({}), () => ["extract"]),
      this.browserCommand("qone_browser_tabs", "List tabs available in the user's connected Chrome browser.", Type.Object({}), () => ["tab", "list"]),
      this.browserCloseTool(),
      this.twitterCommand("qone_twitter_search", "Read Twitter/X search results as structured data in the background. Use this for read-only Twitter/X questions instead of opening x.com with qone_browser_open.", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer()) }), (value) => ["twitter", "search", value.query, "--limit", String(value.limit ?? 20)]),
      this.twitterCommand("qone_twitter_tweets", "Read a Twitter/X user's latest tweets as structured data in the background. Use this for read-only Twitter/X questions instead of opening x.com with qone_browser_open.", Type.Object({ username: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer()) }), (value) => ["twitter", "tweets", ...(value.username ? [value.username] : []), "--limit", String(value.limit ?? 20)]),
      this.twitterCommand("qone_twitter_profile", "Read a Twitter/X profile as structured data in the background. Use this for read-only Twitter/X profile questions instead of opening x.com with qone_browser_open.", Type.Object({ username: Type.Optional(Type.String()) }), (value) => ["twitter", "profile", ...(value.username ? [value.username] : [])]),
      this.twitterCommand("qone_twitter_timeline", "Read the logged-in Twitter/X home timeline as structured data in the background. Use this for read-only timeline questions instead of opening x.com with qone_browser_open.", Type.Object({ type: Type.Optional(Type.Union([Type.Literal("for-you"), Type.Literal("following")])), limit: Type.Optional(Type.Integer()) }), (value) => ["twitter", "timeline", "--type", value.type ?? "for-you", "--limit", String(value.limit ?? 20)]),
      this.twitterCommand("qone_twitter_trending", "Read Twitter/X trending topics as structured data in the background. Use this for read-only trend questions instead of opening x.com with qone_browser_open.", Type.Object({ limit: Type.Optional(Type.Integer()) }), (value) => ["twitter", "trending", "--limit", String(value.limit ?? 20)]),
      this.libraryTool,
    ];
  }

  private openCliDiscoverTool(): ToolDefinition {
    return {
      name: "qone_opencli_discover",
      label: "OpenCLI · discover adapters",
      description: "Discover OpenCLI site adapter commands on demand. Pass a site such as twitter, bilibili, xiaohongshu, or github to receive only that site's commands and parameters. Without a site, returns only a compact site/count index to keep context small. Use qone_opencli_run for adapter commands; OpenCLI decides whether the command uses direct HTTP, cookies, network interception, or browser UI.",
      parameters: Type.Object({
        site: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer()),
        refresh: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id: string, value: { site?: string; query?: string; limit?: number; refresh?: boolean }) => {
        const commands = await this.loadOpenCliCatalog(Boolean(value.refresh));
        return result({ stdout: JSON.stringify(compactOpenCliCatalog(commands, value.site, value.query, value.limit), null, 2), stderr: "" }) as never;
      },
    } as ToolDefinition;
  }

  private openCliRunTool(): ToolDefinition {
    return {
      name: "qone_opencli_run",
      label: "OpenCLI · site adapter",
      description: "Run any OpenCLI site adapter command. This is the primary path for supported websites and should be preferred over qone_browser_* tools. OpenCLI chooses the adapter's native strategy: browserless public HTTP when available, authenticated requests with the user's session when needed, network interception, or UI automation. Call qone_opencli_discover first when the site command or parameters are unknown. Arguments are raw CLI arguments in order, for example [\"opencli\", \"--limit\", \"10\"] is not needed: pass [\"keyword\", \"--limit\", \"10\"].",
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
      execute: async (_id: string, value: { site: string; command: string; args?: string[]; format?: OpenCliFormat; window?: "foreground" | "background"; siteSession?: "ephemeral" | "persistent"; keepTab?: boolean; profile?: string }) => {
        const args = buildOpenCliCommandArgs(value);
        return result(await this.exclusive(() => runOpenCli(args))) as never;
      },
    } as ToolDefinition;
  }

  private async loadOpenCliCatalog(force = false): Promise<OpenCliCommand[]> {
    const now = Date.now();
    if (!force && this.openCliCatalog && now - this.openCliCatalog.loadedAt < OPENCLI_CATALOG_TTL) return this.openCliCatalog.commands;
    if (!force && this.openCliCatalogPromise) return this.openCliCatalogPromise;
    const load = runOpenCli(["list", "--format", "json"]).then(({ stdout }) => {
      const commands = parseOpenCliCatalog(stdout);
      if (!commands.length) throw new Error("OpenCLI 没有返回可用适配器命令");
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
      execute: async (_id: string, value: any) => result(await this.runBrowserCommand(args(value))) as never,
    } as ToolDefinition;
  }

  private twitterCommand(name: string, description: string, parameters: ReturnType<typeof Type.Object>, args: (value: any) => string[]): ToolDefinition {
    return {
      name, label: `OpenCLI · ${name.replace("qone_twitter_", "Twitter ")}`, description, parameters,
      execute: async (_id: string, value: any) => result(await this.runTwitterCommand(args(value))) as never,
    } as ToolDefinition;
  }

  private browserCloseTool(): ToolDefinition {
    return {
      name: "qone_browser_close",
      label: "OpenCLI · close",
      description: "Close only the Chrome tab/window that Qone started for this task, then release the connection. If the user's Chrome was already open, release the connection without closing the user's browser.",
      parameters: Type.Object({}),
      execute: async () => {
        await this.release();
        return result({ stdout: "浏览器连接已释放；仅关闭了 Qone 自己启动的浏览器。", stderr: "" }) as never;
      },
    } as ToolDefinition;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => undefined);
    return next;
  }

  async initialize(): Promise<void> {
    await this.toolsChanged();
  }

  async connect(): Promise<BrowserSyncStatus> {
    return this.exclusive(() => this.connectInner());
  }

  async release(): Promise<void> {
    await this.exclusive(async () => {
      const closeOwnedBrowser = this.startedBrowser;
      if (!this.statusValue.targetConnected && !closeOwnedBrowser) return;
      if (closeOwnedBrowser) {
        try { await runOpenCli(["browser", SESSION, "tab", "close"]); }
        catch { /* The tab may already have been closed by the user. */ }
      }
      try { await runOpenCli(["browser", SESSION, "unbind"]); }
      catch { /* Chrome may already have been closed. The local state still needs releasing. */ }
      this.startedBrowser = false;
      this.update({ phase: "ready", targetConnected: false, lastError: undefined });
    });
  }

  private async connectInner(): Promise<BrowserSyncStatus> {
    this.update({ phase: "connecting", lastError: undefined });
    try {
      if (!await processRunning()) {
        await launchChrome();
        this.startedBrowser = true;
      }
      await runOpenCli(["browser", SESSION, "bind"]);
      this.refreshLibrary();
      this.update({ phase: "ready", targetConnected: true, lastError: undefined });
      await this.toolsChanged();
      return this.status();
    } catch (error) {
      this.update({ phase: "error", targetConnected: false, lastError: String(error) });
      throw error;
    }
  }

  private runBrowserCommand(args: string[]): Promise<CommandResult> {
    return this.exclusive(async () => {
      if (!this.statusValue.targetConnected) await this.connectInner();
      return runOpenCli(["browser", SESSION, ...args]);
    });
  }

  private runTwitterCommand(args: string[]): Promise<CommandResult> {
    return this.exclusive(() => runOpenCli([...args, "--format", "json"]));
  }

  private update(patch: Partial<BrowserSyncStatus>) {
    this.statusValue = { ...this.statusValue, ...patch };
    this.changed(this.status());
  }

  private refreshLibrary() {
    try {
      const counts = this.library.sync();
      this.update({ bookmarkCount: counts.bookmarks, historyCount: counts.history,
        libraryError: counts.errors.length ? counts.errors.join("；") : undefined });
    } catch (error) { this.update({ libraryError: String(error) }); }
  }
}
