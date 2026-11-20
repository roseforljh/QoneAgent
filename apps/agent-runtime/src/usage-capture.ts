import type { CacheObservation } from "@qone/protocol";

/** What the statistics page records for one model request. */
export interface ProviderUsageReport {
  provider: string;
  model: string;
  cache: CacheObservation;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/**
 * Whether one streamed chunk proves the provider sent cache-read data.
 * A null or missing field is not a reported zero; only a number proves it.
 */
export function cacheReportedIn(api: string, raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const chunk = raw as Record<string, any>;
  const reported = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (api === "anthropic-messages") {
    const usage = chunk.type === "message_start" ? chunk.message?.usage : chunk.usage;
    return reported(usage?.cache_read_input_tokens);
  }
  if (api === "google-generative-ai" || api === "google-vertex") return reported(chunk.usageMetadata?.cachedContentTokenCount);
  if (api === "openai-completions") {
    const usage = chunk.usage ?? (Array.isArray(chunk.choices) ? chunk.choices[0]?.usage : undefined);
    return [usage?.prompt_tokens_details?.cached_tokens, usage?.prompt_cache_hit_tokens, usage?.cached_tokens].some(reported);
  }
  if (api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") {
    const usage = chunk.response?.usage ?? chunk.usage;
    return [usage?.input_tokens_details?.cached_tokens, usage?.cached_tokens].some(reported);
  }
  return false;
}

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** Pi's final usage numbers, with the cache flag taken from the same request's streamed chunks. */
export function usageFromResponse(model: { provider: string; id: string }, usage: Usage | undefined, cache: CacheObservation): ProviderUsageReport | undefined {
  if (!usage) return undefined;
  return {
    provider: model.provider, model: model.id, cache,
    input: number(usage.input), output: number(usage.output),
    cacheRead: number(usage.cacheRead), cacheWrite: number(usage.cacheWrite),
  };
}

export interface StreamOptionsLike {
  onProviderStreamEvent?: (data: any, model?: any) => any;
}

/** Only the parts of Pi's stream this wrapper touches; the value itself is passed through untouched. */
export interface StreamResultLike {
  result(): Promise<{ usage?: Usage }>;
}

export interface ObservingOptions extends StreamOptionsLike {
  /** Set by observeRequestUsage; called with the finished request's usage. */
  reportUsage?(usage: Usage | undefined): void;
}

/**
 * Observes one provider request without changing it.
 *
 * - The request's own raw chunks arrive through `options.onProviderStreamEvent`;
 *   the original handler is always forwarded, so nothing Pi or Qone does with
 *   those events is lost.
 * - The final usage is read from the existing stream's `result()` promise, which
 *   is already resolved when the request finishes. The stream object itself is
 *   returned unchanged, so `for await (... of response)` keeps working.
 */
export function observeRequestUsage(
  api: string,
  model: { provider: string; id: string },
  options: StreamOptionsLike | undefined,
  report: (usage: ProviderUsageReport) => void,
): ObservingOptions {
  const original = options?.onProviderStreamEvent;
  let cache: CacheObservation = "unknown";
  let reported = false;
  return {
    ...options,
    onProviderStreamEvent: (data, eventModel) => {
      try { if (cache !== "reported" && cacheReportedIn(api, data)) cache = "reported"; } catch { /* never break a run */ }
      return original?.(data, eventModel);
    },
    reportUsage: (usage) => {
      if (reported) return;
      reported = true;
      try {
        const value = usageFromResponse(model, usage, cache);
        if (value) report(value);
      } catch { /* Telemetry must never break a run. */ }
    },
  };
}

/** Reports the finished request once, without consuming or replacing the stream. */
export function observeStreamResult(stream: StreamResultLike, options: ObservingOptions | undefined): void {
  const report = options?.reportUsage;
  if (!report) return;
  void stream.result()
    .then((message) => report(message?.usage))
    // An aborted or failed request may have no result; it is still counted by the caller.
    .catch(() => report(undefined));
}
