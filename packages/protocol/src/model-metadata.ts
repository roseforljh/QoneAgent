export type ProviderApiType = "openai-compatible" | "codex" | "claude" | "google";

export type ModelCapability = "text" | "image" | "video" | "audio" | "pdf";

export interface ModelReasoningOption {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}

/**
 * The small, provider-neutral subset of model metadata used by Qone.
 * Unknown fields from a provider response are deliberately not persisted.
 */
export interface ModelMetadata {
  id?: string;
  label?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  reasoningOptions?: ModelReasoningOption[];
  input?: ModelCapability[];
  output?: ModelCapability[];
  supportedParameters?: string[];
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ParsedProviderModel {
  id: string;
  label: string;
  metadata?: ModelMetadata;
}

const CAPABILITIES = new Set<ModelCapability>(["text", "image", "video", "audio", "pdf"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replaceAll(",", "").toLowerCase();
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(?:\s*(k|m|g|t))?(?:\s*(?:tokens?|token))?$/);
  if (!match) return undefined;
  const multiplier = match[2] === "k" ? 1024 : match[2] === "m" ? 1024 ** 2 : match[2] === "g" ? 1024 ** 3 : match[2] === "t" ? 1024 ** 4 : 1;
  const number = Number(match[1]) * multiplier;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim().replaceAll(",", ""))
      : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim().replace(/[,$\s]/g, ""))
      : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return values.length ? [...new Set(values)] : undefined;
}

function capabilityArray(value: unknown): ModelCapability[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase().trim())
    .filter((item): item is ModelCapability => CAPABILITIES.has(item as ModelCapability));
  return values.length ? [...new Set(values)] : undefined;
}

function reasoningOptions(value: unknown): ModelReasoningOption[] | undefined {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const options = items.flatMap((item) => {
    if (typeof item === "string" && item.trim()) {
      const name = item.trim();
      const isOptionName = /^(?:toggle|budget(?:_tokens?)?|effort)$/i.test(name);
      return [{ type: isOptionName ? name : "effort", ...(isOptionName ? {} : { values: [name] }) }];
    }
    const option = record(item);
    if (!option || typeof option.type !== "string") return [];
    const values = stringArray(option.values);
    const min = nonNegativeInteger(option.min);
    const max = positiveInteger(option.max);
    return [{
      type: option.type.trim(),
      ...(values ? { values } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    }];
  });
  return options.length ? options : undefined;
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    const result = positiveInteger(value);
    if (result !== undefined) return result;
  }
  return undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const result = record(value);
    if (result) return result;
  }
  return undefined;
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().replace(/^models\//i, "");
  return id || undefined;
}

function hasMetadata(metadata: ModelMetadata): boolean {
  return Object.keys(metadata).some((key) => key !== "id" && key !== "label");
}

/** Parse one OpenAI/Anthropic/Google/models.dev-shaped model record. */
export function parseModelMetadata(value: unknown, fallbackId?: string): ModelMetadata | undefined {
  const source = record(value);
  if (!source) return undefined;
  const limit = firstRecord(source.limit, source.limits);
  const nested = firstRecord(source.metadata, source.modelMetadata, source.details);
  const modalities = firstRecord(source.modalities, source.architecture, source.capabilities, nested?.modalities, nested?.architecture);
  const topProvider = record(source.top_provider);
  const input = capabilityArray(
    modalities?.input ?? modalities?.input_modalities ?? source.input_modalities ?? source.input
      ?? nested?.input_modalities ?? nested?.input,
  );
  const output = capabilityArray(
    modalities?.output ?? modalities?.output_modalities ?? source.output_modalities ?? source.output
      ?? nested?.output_modalities ?? nested?.output,
  );
  const supportedParameters = stringArray(source.supported_parameters ?? source.supportedParameters ?? nested?.supported_parameters ?? nested?.supportedParameters);
  const parsedReasoningOptions = reasoningOptions(source.reasoning_options ?? source.reasoningOptions ?? nested?.reasoning_options ?? nested?.reasoningOptions);
  const reasoning = booleanValue(source.reasoning)
    ?? booleanValue(source.supports_reasoning)
    ?? booleanValue(source.supportsReasoning)
    ?? booleanValue(source.thinking)
    ?? booleanValue(source.supports_thinking)
    ?? booleanValue(source.supportsThinking)
    ?? booleanValue(nested?.reasoning)
    ?? booleanValue(nested?.supports_reasoning)
    ?? booleanValue(nested?.supportsReasoning)
    ?? booleanValue(nested?.thinking)
    ?? (record(source.thinking) ? true : undefined)
    ?? (record(source.thinkingConfig) ? true : undefined)
    ?? (record(nested?.thinking) ? true : undefined)
    ?? (record(nested?.thinkingConfig) ? true : undefined)
    ?? (parsedReasoningOptions ? true : undefined)
    ?? (supportedParameters?.some((item) => /reason|thinking/i.test(item)) ? true : undefined);
  const cost = firstRecord(source.cost, source.pricing, nested?.cost, nested?.pricing);
  const metadata: ModelMetadata = {
    id: normalizeId(source.id ?? source.model_id ?? source.model ?? nested?.id ?? nested?.model_id ?? nested?.model ?? source.name ?? fallbackId),
    label: typeof (source.displayName ?? source.display_name ?? source.name ?? nested?.displayName ?? nested?.display_name ?? nested?.name) === "string"
      ? String(source.displayName ?? source.display_name ?? source.name ?? nested?.displayName ?? nested?.display_name ?? nested?.name)
      : undefined,
    contextWindow: firstPositive(
      source.context_length,
      source.context_window,
      source.contextWindow,
      source.contextLength,
      source.max_context_length,
      source.max_context,
      source.max_context_tokens,
      source.max_input_tokens,
      source.context_size,
      source.max_model_len,
      source.n_ctx,
      source.num_ctx,
      source.maxContext,
      source.context,
      source.contextLimit,
      limit?.context,
      limit?.context_window,
      limit?.max_context,
      limit?.input,
      limit?.input_tokens,
      limit?.max_input_tokens,
      source.inputTokenLimit,
      source.input_token_limit,
      nested?.context_length,
      nested?.context_window,
      nested?.contextWindow,
      nested?.contextLength,
      nested?.max_context_length,
      nested?.max_context,
      nested?.max_context_tokens,
      nested?.max_input_tokens,
      nested?.context_size,
      nested?.max_model_len,
      nested?.maxContext,
      nested?.context,
      nested?.inputTokenLimit,
      nested?.input_token_limit,
      topProvider?.context_length,
    ),
    maxTokens: firstPositive(
      source.max_output_tokens,
      source.max_completion_tokens,
      source.max_tokens,
      source.max_output,
      source.max_output_token,
      source.output_tokens,
      source.output,
      source.output_limit,
      source.outputLimit,
      source.maxTokens,
      source.maxOutput,
      source.max_output,
      limit?.output,
      limit?.output_tokens,
      limit?.max_output,
      limit?.max_output_tokens,
      source.outputTokenLimit,
      source.output_token_limit,
      nested?.max_output_tokens,
      nested?.max_completion_tokens,
      nested?.max_tokens,
      nested?.max_output,
      nested?.max_output_token,
      nested?.output_tokens,
      nested?.output_limit,
      nested?.outputLimit,
      nested?.maxTokens,
      nested?.maxOutput,
      nested?.max_output,
      nested?.outputTokenLimit,
      nested?.output_token_limit,
      topProvider?.max_completion_tokens,
    ),
    reasoning,
    reasoningOptions: parsedReasoningOptions,
    input,
    output,
    supportedParameters,
    toolCall: booleanValue(source.tool_call ?? source.toolCall ?? source.tool_calls),
    structuredOutput: booleanValue(source.structured_output ?? source.structuredOutput),
    temperature: booleanValue(source.temperature),
    cost: cost ? {
      input: nonNegativeNumber(cost.input ?? cost.prompt),
      output: nonNegativeNumber(cost.output ?? cost.completion),
      cacheRead: nonNegativeNumber(cost.cache_read ?? cost.cacheRead),
      cacheWrite: nonNegativeNumber(cost.cache_write ?? cost.cacheWrite),
    } : undefined,
  };
  const cleaned = Object.fromEntries(Object.entries(metadata).filter(([, item]) => item !== undefined)) as ModelMetadata;
  if (cleaned.cost && !Object.keys(cleaned.cost).length) delete cleaned.cost;
  return hasMetadata(cleaned) ? cleaned : undefined;
}

function responseCandidates(data: unknown): Array<{ id?: string; value: unknown }> {
  if (Array.isArray(data)) return data.map((value) => ({ value, id: typeof value === "string" ? value : undefined }));
  const root = record(data);
  if (!root) return [];
  const list = root.data ?? root.models ?? root.items;
  if (Array.isArray(list)) return list.map((value) => ({ value }));
  const modelMap = record(list);
  if (modelMap) return Object.entries(modelMap).map(([id, value]) => ({ id, value }));
  return [];
}

/** Parse a provider `/models` response while retaining safe model metadata. */
export function parseModelMetadataResponse(data: unknown): ParsedProviderModel[] {
  const byId = new Map<string, ParsedProviderModel>();
  for (const candidate of responseCandidates(data)) {
    if (typeof candidate.value === "string") {
      const id = normalizeId(candidate.value);
      if (id && !byId.has(id)) byId.set(id, { id, label: id });
      continue;
    }
    const source = record(candidate.value);
    const id = normalizeId(source?.id ?? source?.model_id ?? source?.model ?? source?.name ?? candidate.id);
    if (!id) continue;
    const metadata = parseModelMetadata(source, id);
    const label = metadata?.label ?? id;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, label, ...(metadata ? { metadata } : {}) });
      continue;
    }
    byId.set(id, {
      ...existing,
      label: existing.label === id ? label : existing.label,
      ...(metadata ? { metadata: mergeModelMetadata(existing.metadata, metadata) } : {}),
    });
  }
  return [...byId.values()];
}

/** Merge metadata field-by-field. Earlier arguments have higher priority. */
export function mergeModelMetadata(...sources: Array<ModelMetadata | undefined>): ModelMetadata | undefined {
  const result: ModelMetadata = {};
  for (const source of sources) {
    if (!source) continue;
    for (const key of ["id", "label", "contextWindow", "maxTokens", "reasoning", "reasoningOptions", "input", "output", "supportedParameters", "toolCall", "structuredOutput", "temperature", "cost"] as const) {
      const value = source[key];
      if (result[key] === undefined && value !== undefined && (!(Array.isArray(value)) || value.length > 0)) {
        result[key] = value as never;
      }
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function normalizeModelName(value: string): string {
  return value.trim().replace(/^models\//i, "").toLowerCase();
}

/**
 * Return stable name-only lookup keys. Provider-qualified ids such as
 * `openai/gpt-5` keep their exact key and also expose `gpt-5` as a fallback
 * alias so a merchant catalog can still describe the same model by name.
 */
export function modelNameCandidates(value: string): string[] {
  const normalized = normalizeModelName(value);
  if (!normalized) return [];
  const candidates = [normalized];
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0 && slash < normalized.length - 1) candidates.push(normalized.slice(slash + 1));
  return [...new Set(candidates)];
}

export function modelNamesEqual(left: string, right: string): boolean {
  return normalizeModelName(left) === normalizeModelName(right);
}
