import { isSensitiveMcpField } from "@qone/protocol";

export const isSensitiveEntry = isSensitiveMcpField;

const SENSITIVE_KEY_EXACT = new Set([
  "apikey", "xapikey", "token", "authtoken", "bearertoken", "accesstoken", "refreshtoken",
  "secret", "clientsecret", "password", "passwd", "authorization", "credential", "credentials", "privatekey", "cookie",
]);

export function containsSecretConfig(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith("bearer ") || normalized.startsWith("basic ");
  }
  if (Array.isArray(value)) return value.some(containsSecretConfig);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "").replaceAll(".", "");
    return SENSITIVE_KEY_EXACT.has(normalized) || containsSecretConfig(child);
  });
}
