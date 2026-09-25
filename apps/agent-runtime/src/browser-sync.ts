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

function runOpenCli(args: string[], timeout = COMMAND_TIMEOUT): Promise<CommandResult> {
  const launch = resolveStdioLaunch("npx", ["--yes", OPENCLI_PACKAGE, ...args]);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(), env: { ...process.env, NO_COLOR: "1" }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("OpenCLI 浏览器操作超时")); }, timeout);
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

function result(value: CommandResult): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: value.stdout || value.stderr || "完成" }] };
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

  constructor(db: Db, _dbPath: string, private readonly changed: (status: BrowserSyncStatus) => void,
    private readonly toolsChanged: () => Promise<void>) {
    this.library = new BrowserLibrary(db);
    this.libraryTool = this.library.tool();
    this.statusValue = { phase: "ready", targetConnected: false };
  }

  status(): BrowserSyncStatus { return { ...this.statusValue }; }

  tools(): ToolDefinition[] {
    return [
      this.browserCommand("qone_browser_state", "Read the current page state from the user's Chrome browser. If Chrome is closed, Qone starts the user's default Chrome profile first.", Type.Object({}), () => ["state"]),
      this.browserCommand("qone_browser_open", "Open a URL in the current user's Chrome tab. If Chrome is closed, Qone starts the user's default Chrome profile first.", Type.Object({ url: Type.String() }), (value) => ["open", value.url]),
      this.browserCommand("qone_browser_click", "Click a visible element in the user's browser. Use the target from qone_browser_state.", Type.Object({ target: Type.String() }), (value) => ["click", value.target]),
      this.browserCommand("qone_browser_fill", "Replace the value of an input in the user's browser.", Type.Object({ target: Type.String(), text: Type.String() }), (value) => ["fill", value.target, value.text]),
      this.browserCommand("qone_browser_type", "Type text into an element in the user's browser.", Type.Object({ target: Type.String(), text: Type.String() }), (value) => ["type", value.target, value.text]),
      this.browserCommand("qone_browser_keys", "Press a keyboard key in the user's browser.", Type.Object({ key: Type.String() }), (value) => ["keys", value.key]),
      this.browserCommand("qone_browser_wait", "Wait for a browser condition such as text, selector, time, or network response.", Type.Object({ kind: Type.Union([Type.Literal("selector"), Type.Literal("text"), Type.Literal("time"), Type.Literal("xhr"), Type.Literal("download")]), value: Type.String() }), (value) => ["wait", value.kind, value.value]),
      this.browserCommand("qone_browser_get", "Read a page property such as URL or title from the user's browser.", Type.Object({ property: Type.Union([Type.Literal("url"), Type.Literal("title"), Type.Literal("text")]) }), (value) => ["get", value.property]),
      this.browserCommand("qone_browser_extract", "Extract the current page as readable Markdown from the user's browser.", Type.Object({}), () => ["extract"]),
      this.browserCommand("qone_browser_tabs", "List tabs available in the user's connected Chrome browser.", Type.Object({}), () => ["tab", "list"]),
      this.libraryTool,
    ];
  }

  private browserCommand(name: string, description: string, parameters: ReturnType<typeof Type.Object>, args: (value: any) => string[]): ToolDefinition {
    return {
      name, label: `OpenCLI · ${name.replace("qone_browser_", "")}`, description, parameters,
      execute: async (_id: string, value: any) => result(await this.runBrowserCommand(args(value))) as never,
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
      if (!this.statusValue.targetConnected) return;
      try { await runOpenCli(["browser", SESSION, "unbind"]); }
      catch { /* Chrome may already have been closed. The local state still needs releasing. */ }
      this.update({ phase: "ready", targetConnected: false, lastError: undefined });
    });
  }

  private async connectInner(): Promise<BrowserSyncStatus> {
    this.update({ phase: "connecting", lastError: undefined });
    try {
      if (!await processRunning()) await launchChrome();
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
