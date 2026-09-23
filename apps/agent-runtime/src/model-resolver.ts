import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  isCodexSubscriptionEndpoint,
  modelBaseUrl,
  mergeModelMetadata,
  modelNameCandidates,
  normalizeModelName,
  parseModelMetadata,
  parseModelMetadataResponse,
  type ModelMetadata,
  type ProviderApiType,
} from "@qone/protocol";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

type PiThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelThinkingLevel = "off" | PiThinkingLevel;
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
type PiApi = "openai-completions" | "openai-responses" | "openai-codex-responses" | "anthropic-messages" | "google-generative-ai";
const QUERY_UNSAFE_PI_APIS = new Set<PiApi>([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
]);

export interface ResolvedModelDefinition {
  api: PiApi;
  baseUrl: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  sources: {
    contextWindow: "provider" | "pi" | "models.dev" | "config" | "default";
    maxTokens: "provider" | "pi" | "models.dev" | "config" | "default";
    reasoning: "provider" | "pi" | "models.dev" | "config" | "default";
  };
}

interface ResolverOptions {
  fetchImpl?: typeof fetch;
  modelsDevUrl?: string;
  timeoutMs?: number;
  disableModelsDev?: boolean;
  providerModelsFetcher?: (input: {
    provider: string;
    apiType: ProviderApiType;
    piApi: PiApi;
    /** Runtime URL passed to Pi. Private Codex URLs are query-free. */
    baseUrl: string;
    /** Normalized URL for the provider model directory, retaining query parameters. */
    catalogBaseUrl: string;
    apiKey?: string;
  }) => Promise<unknown>;
}

interface ConfigRecord {
  [key: string]: unknown;
}

const BUILTIN_MODELS: Array<{ provider: string; model: Model<Api> }> = [];
let builtinModelsLoaded = false;

function loadBuiltinModels() {
  if (builtinModelsLoaded) return BUILTIN_MODELS;
  builtinModelsLoaded = true;
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) BUILTIN_MODELS.push({ provider, model: model as Model<Api> });
  }
  return BUILTIN_MODELS;
}

function asRecord(value: unknown): ConfigRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ConfigRecord : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length ? values : undefined;
}

function cloneMap(value: Record<string, string | null> | undefined): ThinkingLevelMap | undefined {
  return value ? { ...value } : undefined;
}

function apiForProvider(apiType: ProviderApiType, config: ConfigRecord): PiApi {
  if (apiType === "claude") return "anthropic-messages";
  if (apiType === "google") return "google-generative-ai";
  if (apiType === "codex") {
    if (config.codexApi === "openai-codex-responses") return "openai-codex-responses";
    if (config.codexApi === "openai-responses") return "openai-responses";
    // "Codex" in merchant API panels normally means the public Responses
    // wire format. Only ChatGPT's backend (or an explicit override above)
    // uses Pi's subscription-specific /codex/responses adapter.
    return isCodexSubscriptionEndpoint(String(config.baseUrl ?? ""))
      ? "openai-codex-responses"
      : "openai-responses";
  }
  return "openai-completions";
}

function catalogBaseUrlFor(apiType: ProviderApiType, piApi: PiApi, value: string): string {
  // modelBaseUrl("codex") intentionally returns the backend root for the
  // dedicated Codex adapter. A proxy explicitly using ordinary Responses
  // needs the normal /v1 base instead.
  return modelBaseUrl(piApi === "openai-codex-responses" ? "codex-subscription" : apiType, value);
}

function runtimeBaseUrl(catalogBaseUrl: string, piApi: PiApi): string {
  if (!catalogBaseUrl || !QUERY_UNSAFE_PI_APIS.has(piApi)) return catalogBaseUrl;
  // pi-ai delegates these APIs to SDKs that append the request path to the
  // base URL as a string. A query would therefore become `?x=1/v1/...`.
  // Keep query parameters on the directory URL, but never on the runtime URL.
  const url = new URL(catalogBaseUrl);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function modelMetadataFromPi(model: Model<Api>): ModelMetadata {
  return {
    id: model.id,
    label: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
  };
}

function apiMatches(target: PiApi, api: Api): boolean {
  return api === target;
}

function findBuiltinModel(modelId: string, api: PiApi): { provider: string; model: Model<Api> } | undefined {
  const requested = new Set(modelNameCandidates(modelId));
  const matches = loadBuiltinModels().filter((item) => modelNameCandidates(item.model.id).some((candidate) => requested.has(candidate)));
  return matches.sort((left, right) => {
    const rightScore = builtinModelScore(right, modelId, api);
    const leftScore = builtinModelScore(left, modelId, api);
    if (rightScore !== leftScore) return rightScore - leftScore;
    const providerDifference = left.provider.localeCompare(right.provider);
    if (providerDifference) return providerDifference;
    return left.model.api.localeCompare(right.model.api);
  })[0];
}

function builtinModelScore(item: { provider: string; model: Model<Api> }, modelId: string, api: PiApi): number {
  const requestedCandidates = modelNameCandidates(modelId);
  const itemCandidates = modelNameCandidates(item.model.id);
  const exactName = itemCandidates[0] === requestedCandidates[0];
  const basenameName = itemCandidates.some((candidate) => requestedCandidates.includes(candidate));
  const lower = (requestedCandidates.at(-1) ?? normalizeModelName(modelId)).toLowerCase();
  const canonicalProvider = lower.startsWith("gpt-") || /^o[134](?:[-.]|$)/.test(lower)
    ? item.provider === "openai"
    : lower.includes("claude")
      ? item.provider === "anthropic"
      : lower.includes("gemini") || lower.includes("gemma")
        ? item.provider === "google"
        : lower.includes("deepseek")
          ? item.provider === "deepseek"
          : lower.includes("grok")
            ? item.provider === "xai"
            : false;
  const mapQuality = Object.values(item.model.thinkingLevelMap ?? {}).filter((value) => value !== null).length;
  return (exactName ? 100_000 : basenameName ? 50_000 : 0)
    + (apiMatches(api, item.model.api) ? 10_000 : 0)
    + (canonicalProvider ? 1_000 : 0)
    + mapQuality;
}

interface MetadataIndex {
  exact: Map<string, ModelMetadata>;
  aliases: Map<string, ModelMetadata>;
}

function mergeCatalogMetadata(existing: ModelMetadata | undefined, next: ModelMetadata): ModelMetadata {
  if (!existing) return next;
  const existingScore = metadataScore(existing);
  const nextScore = metadataScore(next);
  if (nextScore > existingScore || (nextScore === existingScore && (next.maxTokens ?? 0) > (existing.maxTokens ?? 0))) {
    return mergeModelMetadata(next, existing) ?? next;
  }
  return mergeModelMetadata(existing, next) ?? existing;
}

function addIndexedMetadata(index: MetadataIndex, id: string, metadata: ModelMetadata) {
  const candidates = modelNameCandidates(id);
  const exact = candidates[0];
  if (!exact) return;
  index.exact.set(exact, mergeCatalogMetadata(index.exact.get(exact), metadata));
  for (const alias of candidates.slice(1)) index.aliases.set(alias, mergeCatalogMetadata(index.aliases.get(alias), metadata));
}

function lookupIndexedMetadata(index: MetadataIndex, id: string): ModelMetadata | undefined {
  const candidates = modelNameCandidates(id);
  for (const candidate of candidates) {
    const exact = index.exact.get(candidate);
    if (exact) return exact;
  }
  const alias = candidates.at(-1);
  return alias ? index.aliases.get(alias) : undefined;
}

function modelDevMap(data: unknown): MetadataIndex {
  const result: MetadataIndex = { exact: new Map(), aliases: new Map() };
  const root = asRecord(data);
  if (!root) return result;
  for (const provider of Object.keys(root).sort()) {
    const providerRecord = asRecord(root[provider]);
    const models = asRecord(providerRecord?.models);
    if (!models) continue;
    for (const id of Object.keys(models).sort()) {
      const metadata = parseModelMetadata(models[id], id);
      if (!metadata) continue;
      // models.dev may list one model under several gateways. Prefer the
      // most complete entry and use the largest published limits when the
      // entries describe the same model. The provider-name sort above keeps
      // ties deterministic and the lookup still uses only the model name.
      addIndexedMetadata(result, metadata.id ?? id, metadata);
    }
  }
  return result;
}

function metadataScore(metadata: ModelMetadata): number {
  const values: unknown[] = [metadata.contextWindow, metadata.maxTokens, metadata.reasoning, metadata.reasoningOptions, metadata.input, metadata.output, metadata.supportedParameters];
  return values.reduce<number>((score, value) => score + (value === undefined ? 0 : Array.isArray(value) && value.length === 0 ? 0 : 1), 0);
}

function normalizeReasoningValue(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["none", "off", "disabled", "disable", "false", "0", "no"].includes(normalized)) return "none";
  if (normalized === "minimum" || normalized === "min") return "minimal";
  if (normalized === "maximum" || normalized === "very-high" || normalized === "veryhigh" || normalized === "extra-high") return "max";
  if (normalized === "xhigh" || normalized === "x-high") return "xhigh";
  return normalized;
}

function normalizeOptionType(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "budget" || normalized === "budget_token" ? "budget_tokens" : normalized;
}

function normalizeParameterName(value: string): string {
  return value.trim().replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[.-]/g, "_");
}

function normalizeConfiguredThinking(value: unknown): ModelThinkingLevel {
  const normalized = normalizeReasoningValue(String(value ?? "none"));
  if (normalized === "none") return "off";
  if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized as PiThinkingLevel;
  return "off";
}

function metadataThinkingValues(metadata: ModelMetadata): Set<string> | undefined {
  const values = metadata.reasoningOptions?.flatMap((option) => option.values ?? []).map(normalizeReasoningValue);
  return values?.length ? new Set(values) : undefined;
}

function thinkingMapFromMetadata(metadata: ModelMetadata, api: PiApi): ThinkingLevelMap | undefined {
  if (metadata.reasoning === false) return { off: "none", minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
  const values = metadataThinkingValues(metadata);
  const hasToggle = metadata.reasoningOptions?.some((option) => normalizeOptionType(option.type) === "toggle") ?? false;
  // A toggle-only model has no provider effort vocabulary. Keep the normal
  // Pi levels open so the provider can choose its own enabled behavior, but
  // always provide a concrete off value for adapters such as Qwen/DeepSeek.
  if (!values && hasToggle) return { off: "none" };
  if (!values) return undefined;
  const map: ThinkingLevelMap = {};
  map.off = values.has("none") || hasToggle ? "none" : null;
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    if (api === "google-generative-ai" && (level === "xhigh" || level === "max")) {
      map[level] = null;
    } else {
      map[level] = values.has(level) ? level : null;
    }
  }
  return map;
}

function hasReasoningOption(metadata: ModelMetadata, type: string): boolean {
  const normalized = normalizeOptionType(type);
  return metadata.reasoningOptions?.some((option) => normalizeOptionType(option.type) === normalized) ?? false;
}

function urlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizedProviderId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Pi's catalog contains gateway-specific entries for the same model. Their
 * limits are useful as model-name metadata, but their compat flags describe
 * the catalog provider's wire protocol and must not silently leak into an
 * unrelated user endpoint.
 */
function canInheritBuiltinCompat(
  provider: string,
  baseUrl: string,
  api: PiApi,
  builtin: { provider: string; model: Model<Api> },
): boolean {
  if (builtin.model.api !== api) return false;
  const providerId = normalizedProviderId(provider);
  const genericProviderId = /(?:compatible|proxy|gateway|custom|merchant)/.test(providerId);
  const providerAliases: Record<string, string[]> = {
    openai: ["openai", "chatgpt"],
    "openai-codex": ["openaicodex", "chatgpt", "codex"],
    anthropic: ["anthropic", "claude"],
    google: ["google", "gemini"],
    openrouter: ["openrouter"],
    deepseek: ["deepseek"],
    zai: ["zai", "bigmodel"],
    "zai-coding-cn": ["zaicodingcn", "zai", "bigmodel"],
    "qwen-token-plan": ["qwen", "dashscope"],
    "qwen-token-plan-cn": ["qwentokenplancn", "qwen", "dashscope"],
    together: ["together"],
  };
  const aliases = providerAliases[builtin.provider] ?? [builtin.provider];
  const providerMatches = !genericProviderId && aliases.some((alias) => providerId === normalizedProviderId(alias));
  if (providerMatches) return true;
  const endpointHost = urlHost(baseUrl);
  const catalogHost = urlHost(builtin.model.baseUrl);
  if (endpointHost && catalogHost && endpointHost === catalogHost) return true;
  // The provider id can be a user-defined slug while the endpoint is still a
  // well-known service. Keep this list deliberately narrow; unknown gateways
  // should use URL/model inference below instead.
  const knownEndpointByProvider: Record<string, RegExp> = {
    openai: /(?:^|\.)api\.openai\.com$/,
    "openai-codex": /(?:^|\.)chatgpt\.com$/,
    anthropic: /(?:^|\.)anthropic\.com$/,
    google: /(?:^|\.)googleapis\.com$/,
    openrouter: /(?:^|\.)openrouter\.ai$/,
    deepseek: /(?:^|\.)deepseek\.com$/,
    zai: /(?:^|\.)z\.ai$/,
    "zai-coding-cn": /(?:^|\.)z\.ai$/,
    together: /(?:^|\.)together\.ai$/,
  };
  return Boolean(endpointHost && knownEndpointByProvider[builtin.provider]?.test(endpointHost));
}

function builtinCompatForModel(
  api: PiApi,
  builtin: Model<Api> | undefined,
  transportMatches: boolean,
): Record<string, unknown> | undefined {
  const raw = builtin ? asRecord(builtin.compat) : undefined;
  if (!raw) return undefined;
  if (transportMatches) return raw;
  // Adaptive thinking is a Claude model/API capability, not a gateway URL
  // convention. Preserve that one model-level flag while keeping transport
  // headers and field names endpoint-scoped.
  if (api === "anthropic-messages" && raw.forceAdaptiveThinking === true) {
    return { forceAdaptiveThinking: true };
  }
  return undefined;
}

function inferredCompat(
  api: PiApi,
  modelId: string,
  provider: string,
  baseUrl: string,
  metadata: ModelMetadata,
  builtinCompat: Record<string, unknown> | undefined,
  config: ConfigRecord,
): Record<string, unknown> | undefined {
  const configured = asRecord(config.compat);
  const compat: Record<string, unknown> = { ...(builtinCompat ?? {}) };
  const endpointLower = `${provider}/${baseUrl}`.toLowerCase();
  const modelLower = modelId.toLowerCase();
  const configuredValue = (key: string) => configured?.[key] !== undefined;
  const infer = (key: string, value: unknown) => {
    // A confirmed Pi/provider compat value is stronger than a name-based
    // inference. Explicit user config is stronger than both.
    if (!configuredValue(key) && compat[key] === undefined) compat[key] = value;
  };
  const inferThinkingFormat = (value: string, force = false) => {
    if (!configuredValue("thinkingFormat") && (force || compat.thinkingFormat === undefined)) compat.thinkingFormat = value;
  };
  const parameters = new Set((metadata.supportedParameters ?? []).map(normalizeParameterName));
  if (api === "openai-completions") {
    if (parameters.has("max_completion_tokens") && !parameters.has("max_tokens")) compat.maxTokensField = "max_completion_tokens";
    else if (parameters.has("max_tokens") && !parameters.has("max_completion_tokens")) compat.maxTokensField = "max_tokens";
    const budgetParameter = [...parameters]
      .find((parameter) => ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"].includes(parameter));
    if (budgetParameter) compat.thinkingTokenBudgetField = budgetParameter;
    const hasReasoningEffortParameter = parameters.has("reasoning_effort")
      || (metadata.reasoningOptions?.some((option) => normalizeOptionType(option.type) === "effort") ?? false);
    const endpointIsOpenRouter = /openrouter/.test(endpointLower);
    const endpointIsDeepSeek = /deepseek/.test(endpointLower);
    const endpointIsQwen = /dashscope|qwen/.test(endpointLower);
    const endpointIsZai = /api\.z\.ai|open\.bigmodel\.cn|bigmodel|(?:^|[^a-z])z[-_.]?ai(?:[^a-z]|$)/.test(endpointLower);
    const endpointIsTogether = /together/.test(endpointLower);
    const metadataFormat = parameters.has("enable_thinking")
      ? "qwen"
      : parameters.has("chat_template_kwargs")
        ? "qwen-chat-template"
        : undefined;
    // An endpoint's protocol wins over a model-family guess. A gateway can
    // expose DeepSeek/Qwen/GLM through a different normalized wire format.
    const endpointFormat = endpointIsOpenRouter ? "openrouter"
      : endpointIsDeepSeek ? "deepseek"
        : endpointIsQwen ? "qwen"
          : endpointIsZai ? "zai"
            : endpointIsTogether ? "together"
              : undefined;
    const modelFormat = /deepseek/.test(modelLower) ? "deepseek"
      : /(?:^|[^a-z])qwen(?:\d+(?:\.\d+)?|[-_]|$)|dashscope/.test(modelLower) ? "qwen"
        : /(?:^|[^a-z])(?:z[-_.]?ai|bigmodel)(?:[^a-z]|$)|(?:^|[^a-z])glm(?:[-_.]?\d)/.test(modelLower) ? "zai"
          : /(?:^|[^a-z])together(?:[^a-z]|$)/.test(modelLower) ? "together"
            : undefined;
    const thinkingFormat = endpointFormat ?? metadataFormat ?? modelFormat;
    const modelBasename = modelLower.slice(modelLower.lastIndexOf("/") + 1);
    if (!thinkingFormat && hasReasoningEffortParameter) {
      // A provider-declared effort option is enough to use the standard
      // OpenAI field even when the model name is not an OpenAI name.
      infer("supportsReasoningEffort", true);
    }
    if (!thinkingFormat && metadata.reasoning && /^(?:gpt-|o[134](?:[-.]|$))/.test(modelBasename)) {
      // OpenAI reasoning models use the standard field on an otherwise
      // generic completions endpoint. This is a model/API inference, not a
      // copy of a gateway-specific compat record.
      infer("supportsReasoningEffort", true);
    }
    if (thinkingFormat) {
      inferThinkingFormat(thinkingFormat, Boolean(endpointFormat));
      if (thinkingFormat === "deepseek") {
        infer("supportsStore", false);
        infer("supportsDeveloperRole", false);
        if (!parameters.has("max_completion_tokens")) infer("maxTokensField", "max_tokens");
        infer("requiresReasoningContentOnAssistantMessages", true);
        // DeepSeek's `thinking` object is not evidence that the endpoint
        // accepts OpenAI's separate `reasoning_effort` field.
        // DeepSeek's native thinking object is not evidence that the endpoint
        // also accepts OpenAI's separate `reasoning_effort` field. Only add it
        // when the live/model metadata explicitly advertises that parameter.
        infer("supportsReasoningEffort", hasReasoningEffortParameter);
      } else if (thinkingFormat === "qwen") {
        infer("supportsDeveloperRole", false);
        if (!parameters.has("max_completion_tokens")) infer("maxTokensField", "max_tokens");
        infer("supportsReasoningEffort", hasReasoningEffortParameter);
      } else if (thinkingFormat === "zai") {
        infer("supportsStore", false);
        infer("supportsDeveloperRole", false);
        if (!parameters.has("max_completion_tokens")) infer("maxTokensField", "max_tokens");
        infer("supportsReasoningEffort", hasReasoningEffortParameter);
      } else if (thinkingFormat === "together") {
        infer("supportsReasoningEffort", hasReasoningEffortParameter);
      }
    }
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    // ChatGPT's private `/backend-api/codex/responses` endpoint currently
    // rejects this otherwise-standard Responses field. Ordinary public
    // Responses endpoints support it; an explicit compat override can still
    // opt a custom Codex gateway back in.
    compat.supportsMaxOutputTokens ??= api === "openai-codex-responses"
      ? !isCodexSubscriptionEndpoint(baseUrl)
      : true;
  } else if (api === "anthropic-messages") {
    const hasEffort = hasReasoningOption(metadata, "effort");
    // Current Claude 4.x metadata can advertise both effort and budget
    // controls. Effort is the adaptive wire format in that case; budget-only
    // models keep Pi's legacy enabled/budget_tokens format.
    if (hasEffort) compat.forceAdaptiveThinking ??= true;
  }
  Object.assign(compat, configured ?? {});
  return Object.keys(compat).length ? compat : undefined;
}

function explicitOverride(config: ConfigRecord, key: string, defaultValue: number): number | undefined {
  const overrides = asRecord(config.metadataOverrides);
  const value = positiveInteger(config[key]);
  if (overrides?.[key] === true || overrides?.[key] === "manual") return value;
  if (config.autoMetadata !== true && value !== undefined && value !== defaultValue) return value;
  return undefined;
}

function explicitInput(config: ConfigRecord): ("text" | "image")[] | undefined {
  const values = stringArray(config.input);
  if (!values) return undefined;
  const overrides = asRecord(config.metadataOverrides);
  if (overrides?.input === true || overrides?.input === "manual" || config.autoMetadata !== true) {
    return ["text", ...(values.includes("image") ? ["image" as const] : [])];
  }
  return undefined;
}

function explicitThinking(config: ConfigRecord): boolean | undefined {
  const value = normalizeConfiguredThinking(config.thinking);
  const overrides = asRecord(config.metadataOverrides);
  const isManual = overrides?.thinking === true || overrides?.thinking === "manual" || config.autoMetadata !== true;
  return isManual && config.thinking !== undefined ? value !== "off" : undefined;
}

function providerMetadata(config: ConfigRecord): ModelMetadata | undefined {
  return parseModelMetadata(config.modelMetadata, typeof config.model === "string" ? config.model : undefined);
}

function mergeWithSource(
  provider: ModelMetadata | undefined,
  pi: ModelMetadata | undefined,
  modelsDev: ModelMetadata | undefined,
  config: ConfigRecord,
): { metadata: ModelMetadata; contextSource: ResolvedModelDefinition["sources"]["contextWindow"]; outputSource: ResolvedModelDefinition["sources"]["maxTokens"]; reasoningSource: ResolvedModelDefinition["sources"]["reasoning"] } {
  const context = explicitOverride(config, "maxContext", DEFAULT_CONTEXT_WINDOW);
  const output = explicitOverride(config, "maxOutput", DEFAULT_MAX_TOKENS);
  const thinking = explicitThinking(config);
  const merged = mergeModelMetadata(provider, pi, modelsDev) ?? {};
  if (context !== undefined) merged.contextWindow = context;
  if (output !== undefined) merged.maxTokens = output;
  if (thinking !== undefined) merged.reasoning = thinking;
  const contextSource = context !== undefined ? "config" : provider?.contextWindow !== undefined ? "provider" : pi?.contextWindow !== undefined ? "pi" : modelsDev?.contextWindow !== undefined ? "models.dev" : "default";
  const outputSource = output !== undefined ? "config" : provider?.maxTokens !== undefined ? "provider" : pi?.maxTokens !== undefined ? "pi" : modelsDev?.maxTokens !== undefined ? "models.dev" : "default";
  const reasoningSource = thinking !== undefined ? "config" : provider?.reasoning !== undefined ? "provider" : pi?.reasoning !== undefined ? "pi" : modelsDev?.reasoning !== undefined ? "models.dev" : "default";
  return { metadata: merged, contextSource, outputSource, reasoningSource };
}

async function fetchJsonWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class ModelMetadataResolver {
  private modelsDevPromise?: Promise<MetadataIndex>;
  private readonly fetchImpl: typeof fetch;
  private readonly modelsDevUrl: string;
  private readonly timeoutMs: number;
  private readonly disableModelsDev: boolean;
  private readonly providerModelsFetcher?: ResolverOptions["providerModelsFetcher"];
  private providerCatalogPromises = new Map<string, Promise<MetadataIndex>>();

  constructor(options: ResolverOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.modelsDevUrl = options.modelsDevUrl ?? "https://models.dev/api.json";
    this.timeoutMs = options.timeoutMs ?? 2_500;
    this.disableModelsDev = options.disableModelsDev ?? false;
    this.providerModelsFetcher = options.providerModelsFetcher;
  }

  private async getModelsDev(): Promise<MetadataIndex> {
    if (this.disableModelsDev) return { exact: new Map(), aliases: new Map() };
    const existing = this.modelsDevPromise;
    if (existing) return existing;
    let promise: Promise<MetadataIndex>;
    promise = fetchJsonWithTimeout(this.fetchImpl, this.modelsDevUrl, this.timeoutMs)
      .then((data) => modelDevMap(data))
      .catch(() => {
        if (this.modelsDevPromise === promise) this.modelsDevPromise = undefined;
        return { exact: new Map(), aliases: new Map() };
      });
    this.modelsDevPromise = promise;
    return promise;
  }

  private async getProviderCatalog(input: { provider: string; apiType: ProviderApiType; piApi: PiApi; baseUrl: string; catalogBaseUrl: string; apiKey?: string }): Promise<MetadataIndex> {
    if (!this.providerModelsFetcher || !input.catalogBaseUrl) return { exact: new Map(), aliases: new Map() };
    const cacheKey = `${input.provider}\u0000${input.apiType}\u0000${input.catalogBaseUrl}`;
    let promise = this.providerCatalogPromises.get(cacheKey);
    if (!promise) {
      promise = this.providerModelsFetcher(input)
        .then((data) => {
          const index: MetadataIndex = { exact: new Map(), aliases: new Map() };
          for (const model of parseModelMetadataResponse(data)) {
            addIndexedMetadata(index, model.id, model.metadata ?? { id: model.id, label: model.label });
          }
          return index;
        })
        .catch(() => {
          if (this.providerCatalogPromises.get(cacheKey) === promise) this.providerCatalogPromises.delete(cacheKey);
          return { exact: new Map(), aliases: new Map() };
        });
      this.providerCatalogPromises.set(cacheKey, promise);
    }
    return promise;
  }

  /** Drop model-directory entries after credentials or endpoint settings change. */
  invalidateProviderCatalog(provider?: string) {
    if (!provider) {
      this.providerCatalogPromises.clear();
      return;
    }
    const prefix = `${provider}\u0000`;
    for (const key of this.providerCatalogPromises.keys()) {
      if (key.startsWith(prefix)) this.providerCatalogPromises.delete(key);
    }
  }

  async resolve(input: { provider: string; model: string; config: ConfigRecord; apiKey?: string }): Promise<ResolvedModelDefinition> {
    const { provider, model: modelId, config } = input;
    const apiType = (String(config.apiType ?? "openai-compatible") as ProviderApiType);
    const api = apiForProvider(apiType, config);
    const catalogBaseUrl = catalogBaseUrlFor(apiType, api, String(config.baseUrl ?? ""));
    const baseUrl = runtimeBaseUrl(catalogBaseUrl, api);
    const builtin = findBuiltinModel(modelId, api);
    const transportMatchesBuiltin = Boolean(builtin && canInheritBuiltinCompat(provider, baseUrl, api, builtin));
    const builtinCompat = builtinCompatForModel(api, builtin?.model, transportMatchesBuiltin);
    const providerCatalog = await this.getProviderCatalog({ provider, apiType, piApi: api, baseUrl, catalogBaseUrl, apiKey: input.apiKey });
    // A live merchant directory is fresher than the metadata cached in the
    // saved model config. Keep the cache as a field-level fallback, then use
    // Pi's catalog and models.dev for anything still missing.
    const providerInfo = mergeModelMetadata(lookupIndexedMetadata(providerCatalog, modelId), providerMetadata(config));
    const piInfo = builtin ? modelMetadataFromPi(builtin.model) : undefined;
    const partial = mergeModelMetadata(providerInfo, piInfo);
    const needsModelsDev = !partial?.contextWindow || !partial.maxTokens || partial.reasoning === undefined || (!providerInfo?.reasoningOptions && !builtin?.model.thinkingLevelMap);
    const devInfo = needsModelsDev ? lookupIndexedMetadata(await this.getModelsDev(), modelId) : undefined;
    const merged = mergeWithSource(providerInfo, piInfo, devInfo, config);
    const metadata = merged.metadata;
    const explicit = explicitInput(config);
    const inputCapabilities = explicit ?? (metadata.input?.includes("image") ? ["text", "image"] : ["text"]);
    const reasoning = metadata.reasoning ?? normalizeConfiguredThinking(config.thinking) !== "off";
    let thinkingLevelMap = providerInfo?.reasoningOptions
      ? thinkingMapFromMetadata(providerInfo, api)
      : builtin?.model.thinkingLevelMap
        ? cloneMap(builtin.model.thinkingLevelMap)
        : thinkingMapFromMetadata(devInfo ?? metadata, api);
    if (!reasoning) thinkingLevelMap = { off: "none", minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
    const compat = inferredCompat(api, modelId, provider, baseUrl, metadata, builtinCompat, config);
    const cost = metadata.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    return {
      api,
      baseUrl,
      name: String(config.displayName ?? metadata.label ?? modelId),
      reasoning,
      input: inputCapabilities,
      cost: {
        input: cost.input ?? 0,
        output: cost.output ?? 0,
        cacheRead: cost.cacheRead ?? 0,
        cacheWrite: cost.cacheWrite ?? 0,
      },
      contextWindow: explicitOverride(config, "maxContext", DEFAULT_CONTEXT_WINDOW) ?? metadata.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: explicitOverride(config, "maxOutput", DEFAULT_MAX_TOKENS) ?? metadata.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(compat ? { compat } : {}),
      ...(asRecord(config.samplingParams) ? { samplingParams: config.samplingParams as Record<string, unknown> } : {}),
      sources: {
        contextWindow: merged.contextSource,
        maxTokens: merged.outputSource,
        reasoning: merged.reasoningSource,
      },
    };
  }
}

export function providerApiToPiApi(apiType: ProviderApiType, config: ConfigRecord = {}): PiApi {
  return apiForProvider(apiType, config);
}

export function providerBaseUrl(apiType: ProviderApiType, piApi: PiApi, value: string): string {
  return runtimeBaseUrl(catalogBaseUrlFor(apiType, piApi, value), piApi);
}

export function resetBuiltinModelCacheForTests() {
  BUILTIN_MODELS.length = 0;
  builtinModelsLoaded = false;
}
