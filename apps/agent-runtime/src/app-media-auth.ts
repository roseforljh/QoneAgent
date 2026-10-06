import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { qoneAuthDir } from "@qone/shared";
import { MEDIA_APP_IDS, mediaAppFromUrl, type MediaAppId } from "@qone/protocol";
import { runtimeError } from "./runtime-localization";

/** Export only this app's already-saved session; never expose it to the model. */
export async function writeAppCookies(app: MediaAppId, directory: string): Promise<string | undefined> {
  if (!MEDIA_APP_IDS.includes(app) || app === "telegram") return;
  let file: { appId?: string; cookies?: unknown[] };
  try { file = JSON.parse(await readFile(path.join(qoneAuthDir(), `${app}.json`), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw runtimeError("app-media.session_invalid", { p0: app });
  }
  if (file.appId !== app || !Array.isArray(file.cookies)) throw runtimeError("app-media.session_invalid", { p0: app });
  const rows: string[] = [];
  for (const value of file.cookies) {
    if (!value || typeof value !== "object") throw runtimeError("app-media.session_invalid", { p0: app });
    const cookie = value as Record<string, unknown>;
    if (![cookie.domain, cookie.path, cookie.name, cookie.value].every((field) => typeof field === "string" && field.length > 0 && !/[\t\r\n\0]/.test(field))) {
      throw runtimeError("app-media.session_invalid", { p0: app });
    }
    const domain = cookie.domain as string;
    if (!/^(?:\.?[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(domain)) throw runtimeError("app-media.session_invalid", { p0: app });
    if (!allowedCookieDomain(app, domain)) continue;
    if (cookie.expires !== null && cookie.expires !== undefined && (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires))) {
      throw runtimeError("app-media.session_invalid", { p0: app });
    }
    const expires = typeof cookie.expires === "number" && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
    if (expires && expires <= Date.now() / 1000) continue;
    rows.push([`${cookie.httpOnly === true ? "#HttpOnly_" : ""}${domain}`, domain.startsWith(".") ? "TRUE" : "FALSE",
      cookie.path, cookie.secure === true ? "TRUE" : "FALSE", expires, cookie.name, cookie.value].join("\t"));
  }
  if (!rows.length) return;
  const target = path.join(directory, "session.txt");
  await writeFile(target, `# Netscape HTTP Cookie File\n${rows.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  return target;
}

function allowedCookieDomain(app: MediaAppId, domain: string): boolean {
  const host = domain.replace(/^\./, "").toLowerCase();
  if (mediaAppFromUrl(`https://${host}/`) === app) return true;
  // YouTube's browser login uses Google account cookies; yt-dlp needs both
  // cookie families to reuse that session.
  if (app === "youtube" && (host === "google.com" || host.endsWith(".google.com"))) return true;
  return false;
}
