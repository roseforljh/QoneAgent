import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getAuthDir } from "./data-paths";

function getSecretsFilePath(): string {
  return path.join(getAuthDir(), "secrets.enc.json");
}

function validateSecretKey(key: string): void {
  const parts = key.split(":");
  if (parts.length !== 2) {
    throw new Error("invalid secret key");
  }
  const [namespace, name] = parts;
  if (!namespace || namespace.length > 64 || !/^[a-zA-Z0-9.-]+$/.test(namespace)) {
    throw new Error("invalid secret key");
  }
  if (!name || name.length > 128 || !/^[\p{L}\p{N}._\/-]+$/u.test(name)) {
    throw new Error("invalid secret key");
  }
}

interface SecretFileContent {
  [key: string]: {
    data: string;
    isSafeStorage: boolean;
  };
}

function readSecretFile(): SecretFileContent {
  const file = getSecretsFilePath();
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    const content: unknown = JSON.parse(raw);
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error();
    return content as SecretFileContent;
  } catch {
    throw new Error("Stored credentials could not be read");
  }
}

function writeSecretFile(content: SecretFileContent): void {
  const file = getSecretsFilePath();
  const staging = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staging, JSON.stringify(content, null, 2), "utf8");
    fs.renameSync(staging, file);
  } finally { fs.rmSync(staging, { force: true }); }
}

const FALLBACK_KEY = crypto.scryptSync("qone-local-auth-fallback", "salt", 32);

function fallbackEncrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", FALLBACK_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function fallbackDecrypt(encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", FALLBACK_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

export function setSecret(key: string, value: string): void {
  storeSecrets({ [key]: value }, []);
}

function storeSecrets(values: Record<string, string>, removeKeys: string[]): void {
  for (const key of [...Object.keys(values), ...removeKeys]) validateSecretKey(key);
  const content = readSecretFile();
  for (const key of removeKeys) delete content[key];
  const available = safeStorage.isEncryptionAvailable();
  for (const [key, value] of Object.entries(values)) {
    content[key] = { data: available ? safeStorage.encryptString(value).toString("base64") : fallbackEncrypt(value), isSafeStorage: available };
  }
  writeSecretFile(content);
}

/** Read a batch atomically; missing entries are omitted, unreadable entries are errors. */
export function getSecrets(keys: string[]): Record<string, string> {
  for (const key of keys) validateSecretKey(key);
  const content = readSecretFile();
  return Object.fromEntries(keys.flatMap(key => {
    const entry = content[key];
    if (!entry) return [];
    try {
      if (entry.isSafeStorage && !safeStorage.isEncryptionAvailable()) throw new Error();
      const value = entry.isSafeStorage ? safeStorage.decryptString(Buffer.from(entry.data, "base64")) : fallbackDecrypt(entry.data);
      return [[key, value]];
    } catch { throw new Error("Stored credentials could not be decrypted"); }
  }));
}

export function getSecret(key: string): string | null {
  return getSecrets([key])[key] ?? null;
}

export function deleteSecret(key: string): void {
  validateSecretKey(key);
  const content = readSecretFile();
  if (key in content) {
    delete content[key];
    writeSecretFile(content);
  }
}

/**
 * Persists runtime credentials under the key the protocol already names, and
 * returns the event that may be forwarded to the renderer. Credential-bearing
 * events never reach the renderer; they become a redacted `mcp.oauth.saved`
 * acknowledgement. Returns null when the event must not be forwarded at all.
 */
export function persistRuntimeSecret(event: unknown, acknowledge?: (requestId: string, saved: boolean) => void): unknown | null {
  if (!event || typeof event !== "object") return event;
  const record = event as Record<string, unknown>;
  if (record.type === "claude-code.credentials") {
    const { requestId, serverId, values, removeKeys } = record;
    if (typeof requestId !== "string" || typeof serverId !== "string") return null;
    try {
      if (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some(value => typeof value !== "string") || !Array.isArray(removeKeys) || removeKeys.some(key => typeof key !== "string")) throw new Error();
      storeSecrets(values as Record<string, string>, removeKeys as string[]);
    } catch { acknowledge?.(requestId, false); return null; }
    acknowledge?.(requestId, true);
    return [...new Set([...removeKeys as string[], ...Object.keys(values as object)])].map(key => ({ type: "mcp.oauth.saved", serverId, key }));
  }
  const key = record.key;
  if (record.type === "mcp.oauth.token" || record.type === "mcp.oauth.credential") {
    const secret = record.type === "mcp.oauth.token" ? record.accessToken : record.value;
    if (typeof key !== "string" || typeof secret !== "string" || secret.length === 0) return null;
    try {
      setSecret(key, secret);
    } catch {
      // Never fall back to forwarding the secret when it cannot be stored.
      return { type: "error", message: "OAuth credential could not be stored" };
    }
    return { type: "mcp.oauth.saved", serverId: record.serverId, key };
  }
  if (record.type === "mcp.oauth.invalidated" && typeof key === "string") {
    try {
      deleteSecret(key);
    } catch {
      // Invalidation carries no credential; forwarding it is safe.
    }
  }
  return event;
}
