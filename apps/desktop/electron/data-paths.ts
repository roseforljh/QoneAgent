import path from "node:path";
import fs from "node:fs";

export function getRootDataDir(): string {
  if (process.env.QONE_DATA_DIR && process.env.QONE_DATA_DIR.trim().length > 0) {
    const configured = process.env.QONE_DATA_DIR.trim();
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) {
    throw new Error("Could not determine the Qone data directory");
  }
  return path.join(home, ".qone");
}

export function getRuntimeDir(): string {
  const dir = path.join(getRootDataDir(), "runtime");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAuthDir(): string {
  const dir = path.join(getRootDataDir(), "auth");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureGlobalInstructions(): void {
  const root = getRootDataDir();
  fs.mkdirSync(root, { recursive: true });
  getAuthDir();
  const file = path.join(root, "Qone.md");
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, "", { flag: "wx", encoding: "utf8" });
    } catch {
      // 忽略已存在的情况
    }
  }
}
