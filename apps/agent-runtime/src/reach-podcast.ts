import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const credentialPath = () => path.join(os.homedir(), ".opencli", "xiaoyuzhou.json");

export function podcastConfigured(): boolean {
  const file = credentialPath();
  if (!existsSync(file)) return false;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return typeof value.access_token === "string" && value.access_token.length > 0 &&
      typeof value.refresh_token === "string" && value.refresh_token.length > 0;
  } catch { return false; }
}

export function configurePodcast(accessToken: string, refreshToken: string): void {
  const folder = path.dirname(credentialPath());
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(credentialPath(), JSON.stringify({
    access_token: accessToken.trim(),
    refresh_token: refreshToken.trim(),
    expires_at: Date.now(),
  }, null, 2), { encoding: "utf8", mode: 0o600 });
}
