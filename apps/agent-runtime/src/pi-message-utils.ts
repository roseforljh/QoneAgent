import { modelListUrl, type ProviderApiType } from "@qone/protocol";
import { providerBaseUrl } from "./model-resolver.js";

export async function fetchProviderModels({ apiType, piApi, baseUrl, catalogBaseUrl, apiKey }: {
  apiType: ProviderApiType; piApi: Parameters<typeof providerBaseUrl>[1]; baseUrl: string; catalogBaseUrl: string; apiKey?: string;
}): Promise<unknown> {
  const endpointBase = catalogBaseUrl || providerBaseUrl(apiType, piApi, baseUrl);
  if (!endpointBase) return [];
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiType === "claude") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiType !== "google" && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url = modelListUrl(apiType, endpointBase);
  if (!url) return [];
  const requestUrl = new URL(url);
  if (apiType === "google" && apiKey) requestUrl.searchParams.set("key", apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetch(requestUrl, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`provider models HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

export function assertModelToolNames(names: Iterable<string>): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 64) throw new Error(`Invalid model tool name: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate model tool name: ${name}`);
    seen.add(name);
  }
}

export function splitModelName(name: string): [string, string] {
  const slash = name.indexOf("/");
  const colon = name.indexOf(":");
  const cut = slash < 0 ? colon : colon < 0 ? slash : Math.min(slash, colon);
  return cut < 0 ? [name, ""] : [name.slice(0, cut), name.slice(cut + 1)];
}

export function parseAutomaticMediaDelegation(value: string): { result: string; status: string } | undefined {
  try {
    const parsed = JSON.parse(value) as { status?: unknown; result?: unknown; error?: unknown };
    if (typeof parsed !== "object" || parsed === null || typeof parsed.status !== "string") return undefined;
    const result = typeof parsed.result === "string" && parsed.result.trim()
      ? parsed.result.trim()
      : typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim() : "";
    return result ? { result, status: parsed.status } : undefined;
  } catch {
    return undefined;
  }
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as { content?: unknown; message?: unknown; text?: unknown };
  if (typeof record.text === "string") return record.text;
  if (record.message && record.message !== value) return extractTextContent(record.message);
  if (!Array.isArray(record.content)) return "";
  return record.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}
