import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";

let browser: Browser | null = null;
let page: Page | null = null;

async function launchBrowser() {
  const candidates = [
    process.env.QONE_BROWSER_EXECUTABLE,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
  ];
  const executablePath = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  const headless = process.env.QONE_BROWSER_HEADLESS !== "false";
  if (executablePath) return chromium.launch({ executablePath, headless });
  try {
    return await chromium.launch({ channel: "msedge", headless });
  } catch {
    return chromium.launch({ headless });
  }
}

async function ensurePage() {
  if (!browser) browser = await launchBrowser();
  if (!page || page.isClosed()) page = await browser.newPage();
  return page;
}

function respond(id: number, response: { ok: true; value: unknown } | { ok: false; error: string }) {
  process.stdout.write(`${JSON.stringify({ id, ...response })}\n`);
}

async function dispatch(op: string, params: Record<string, unknown>) {
  if (op === "close") {
    await browser?.close();
    browser = null;
    page = null;
    return "Closed.";
  }
  const current = await ensurePage();
  switch (op) {
    case "open":
    case "navigate":
      await current.goto(String(params.url), { waitUntil: "domcontentloaded" });
      return { url: current.url(), title: await current.title() };
    case "snapshot": {
      const aria = await current.locator("body").ariaSnapshot();
      const interactive = await current.evaluate(() => Array.from(
        document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link]"),
      ).slice(0, 200).map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").trim().slice(0, 80),
        href: (element as HTMLAnchorElement).href || undefined,
        id: element.id || undefined,
      })));
      return JSON.stringify({ url: current.url(), title: await current.title(), aria, interactive }).slice(0, 20_000);
    }
    case "click":
      if (params.selector) await current.click(String(params.selector));
      else if (params.role && params.name) await current.getByRole(params.role as never, { name: String(params.name) }).click();
      else throw new Error("click needs selector or role+name");
      return { url: current.url() };
    case "type":
      await current.fill(String(params.selector), String(params.text));
      if (params.submit) await current.press(String(params.selector), "Enter");
      return "Typed.";
    case "extract": {
      const value = params.selector
        ? await current.locator(String(params.selector)).innerText()
        : await current.evaluate(() => document.body.innerText);
      return value.slice(0, 20_000);
    }
    case "screenshot":
      await current.screenshot({ path: String(params.path), fullPage: true });
      return params.path;
    case "download": {
      const [download] = await Promise.all([
        current.waitForEvent("download"),
        current.locator(String(params.selector)).click(),
      ]);
      await download.saveAs(String(params.path));
      return params.path;
    }
    default:
      throw new Error(`unknown browser operation: ${op}`);
  }
}

let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  queue = queue.then(async () => {
    if (!line.trim()) return;
    let request: { id: number; op: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`invalid browser request: ${String(error)}\n`);
      return;
    }
    try {
      respond(request.id, { ok: true, value: await dispatch(request.op, request.params ?? {}) });
    } catch (error) {
      respond(request.id, { ok: false, error: String(error) });
    }
  });
});

async function shutdown() {
  await browser?.close().catch(() => {});
  process.exit(0);
}

input.on("close", () => void queue.then(shutdown));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
