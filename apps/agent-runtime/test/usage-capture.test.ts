import { describe, expect, test } from "bun:test";
import { cacheReportedIn, observeRequestUsage, observeStreamResult } from "../src/usage-capture";

const pendingUsageChunk = { choices: [{ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } } }] };

const model = { provider: "openai", id: "gpt-test" };

describe("usage capture", () => {
  test("observes each request's own chunks and reports its final usage once", async () => {
    const reports: any[] = [];
    const forwarded: unknown[] = [];
    const original = (data: unknown) => { forwarded.push(data); };
    // The wrapped options always forward the original handler: nothing Pi does is lost.
    const options = observeRequestUsage("openai-completions", model, { onProviderStreamEvent: original }, (usage) => reports.push(usage));
    await options.onProviderStreamEvent?.(pendingUsageChunk, {});
    expect(forwarded).toEqual([pendingUsageChunk]);
    // The stream itself is untouched: the agent loop iterates it.
    const stream = { result: async () => ({ usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 } }) };
    observeStreamResult(stream, options);
    await Bun.sleep(0);
    expect(reports).toEqual([{ provider: "openai", model: "gpt-test", cache: "reported", input: 100, output: 20, cacheRead: 900, cacheWrite: 0 }]);
    // A second call on the same request (end + result) never double counts.
    options.reportUsage?.({ input: 100, output: 20 });
    expect(reports).toHaveLength(1);
  });

  test("a provider that never sends cache fields stays unknown even though Pi kept 0", async () => {
    const reports: any[] = [];
    const options = observeRequestUsage("openai-completions", model, undefined, (usage) => reports.push(usage));
    await options.onProviderStreamEvent?.({ choices: [{ delta: { content: "hi" } }] }, {});
    observeStreamResult({ result: async () => ({ usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } }) }, options);
    await Bun.sleep(0);
    expect(reports[0].cache).toBe("unknown");
  });

  test("a failed request resolves without a result and is still not a cache claim", async () => {
    const reports: any[] = [];
    const options = observeRequestUsage("anthropic-messages", model, undefined, (usage) => reports.push(usage));
    observeStreamResult({ result: async () => { throw new Error("network"); } }, options);
    await Bun.sleep(0);
    expect(reports).toEqual([]);
  });

  test("cache fields count only when the provider sent a number on that request's own chunks", () => {
    expect(cacheReportedIn("openai-completions", { choices: [{ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } }] })).toBe(true);
    expect(cacheReportedIn("openai-completions", { usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0 } })).toBe(true);
    expect(cacheReportedIn("openai-completions", { usage: { prompt_tokens: 10 } })).toBe(false);
    expect(cacheReportedIn("openai-completions", { choices: [{ delta: { content: "hi" } }] })).toBe(false);
    expect(cacheReportedIn("anthropic-messages", { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: null } } })).toBe(false);
    expect(cacheReportedIn("anthropic-messages", { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 0 } } })).toBe(true);
    expect(cacheReportedIn("anthropic-messages", { type: "message_start", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 7 } } })).toBe(false);
    expect(cacheReportedIn("anthropic-messages", { type: "message_delta", usage: { cache_read_input_tokens: 0 } })).toBe(true);
    expect(cacheReportedIn("google-generative-ai", { usageMetadata: { promptTokenCount: 9, cachedContentTokenCount: 0 } })).toBe(true);
    expect(cacheReportedIn("google-generative-ai", { usageMetadata: { promptTokenCount: 9 } })).toBe(false);
    expect(cacheReportedIn("openai-responses", { response: { usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 0 } } } })).toBe(true);
    expect(cacheReportedIn("openai-responses", { response: { usage: { input_tokens: 9 } } })).toBe(false);
    // Not an API Pi supports here: unrecorded rather than guessed.
    expect(cacheReportedIn("mistral-conversations", { usage: { prompt_tokens: 3 } })).toBe(false);
  });

  test("per-request chunks only mark cache data for that same request", async () => {
    const reports: any[] = [];
    const response = { usage: { input: 10, output: 2, cacheRead: 40, cacheWrite: 0 } };
    const withData = observeRequestUsage("openai-completions", model, undefined, (u) => reports.push(u));
    await withData.onProviderStreamEvent?.(pendingUsageChunk, {});
    observeStreamResult({ result: async () => response }, withData);
    const plain = observeRequestUsage("openai-completions", model, undefined, (u) => reports.push(u));
    observeStreamResult({ result: async () => response }, plain);
    await Bun.sleep(0);
    expect(reports.map((report) => report.cache)).toEqual(["reported", "unknown"]);
  });

  test("no usage on the response means no record", async () => {
    const reports: any[] = [];
    const options = observeRequestUsage("openai-completions", model, undefined, (u) => reports.push(u));
    observeStreamResult({ result: async () => ({}) }, options);
    await Bun.sleep(0);
    expect(reports).toEqual([]);
  });
});
