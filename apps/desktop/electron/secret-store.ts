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
  if (!name || name.length > 128 || !/^[a-zA-Z0-9._\/-]+$/.test(name)) {
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
    return JSON.parse(raw) as SecretFileContent;
  } catch {
    return {};
  }
}

function writeSecretFile(content: SecretFileContent): void {
  const file = getSecretsFilePath();
  fs.writeFileSync(file, JSON.stringify(content, null, 2), "utf8");
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
  validateSecretKey(key);
  const content = readSecretFile();
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value);
    content[key] = {
      data: encrypted.toString("base64"),
      isSafeStorage: true,
    };
  } else {
    content[key] = {
      data: fallbackEncrypt(value),
      isSafeStorage: false,
    };
  }
  writeSecretFile(content);
}

export function getSecret(key: string): string | null {
  validateSecretKey(key);
  const content = readSecretFile();
  const entry = content[key];
  if (!entry) return null;
  try {
    if (entry.isSafeStorage) {
      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(entry.data, "base64");
        return safeStorage.decryptString(buffer);
      }
      return null;
    }
    return fallbackDecrypt(entry.data);
  } catch {
    return null;
  }
}

export function deleteSecret(key: string): void {
  validateSecretKey(key);
  const content = readSecretFile();
  if (key in content) {
    delete content[key];
    writeSecretFile(content);
  }
}

export function persistRuntimeSecret(line: string): string {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object") {
      if (parsed.type === "mcp.oauth.token" && parsed.key && parsed.token) {
        setSecret(`mcp.oauth.token:${parsed.key}`, parsed.token);
      } else if (parsed.type === "mcp.oauth.credential" && parsed.key && parsed.credential) {
        setSecret(`mcp.oauth.credential:${parsed.key}`, parsed.credential);
      } else if (parsed.type === "mcp.oauth.invalidated" && parsed.key) {
        deleteSecret(`mcp.oauth.token:${parsed.key}`);
        deleteSecret(`mcp.oauth.credential:${parsed.key}`);
      }
    }
  } catch {
    // 忽略格式错误
  }
  return line;
}
