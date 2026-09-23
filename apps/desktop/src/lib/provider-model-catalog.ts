import { modelListUrl, type ProviderApiType } from "@qone/protocol";
import { invoke } from "@tauri-apps/api/core";
import { hasTauriBridge } from "../store";

export async function fetchProviderModelCatalog(apiType: ProviderApiType, baseUrl: string, provider: string, enteredKey = ""): Promise<unknown> {
  const endpoint = modelListUrl(apiType, baseUrl);
  if (!endpoint) throw new Error("Invalid model endpoint");
  const storedKey = !enteredKey && hasTauriBridge() ? await invoke<string | null>("secret_get", { key: `model.apiKey:${provider}` }).catch(() => null) : null;
  const apiKey = enteredKey || storedKey || "";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiType === "claude") { if (apiKey) headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; }
  else if (apiKey && apiType !== "google") headers.Authorization = `Bearer ${apiKey}`;
  const requestUrl = new URL(endpoint);
  if (apiType === "google" && apiKey) requestUrl.searchParams.set("key", apiKey);
  const response = await fetch(requestUrl, { headers, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
