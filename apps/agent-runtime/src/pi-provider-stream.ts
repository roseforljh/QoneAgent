import { createAssistantMessageEventStream, type Api, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { anthropicMediaStreamSimple } from "./anthropic-media.js";
import { googleStreamSimple } from "./google-media.js";
import { openAICompletionsStreamSimple } from "./openai-audio.js";
import { codexResponsesMediaStreamSimple, openAIResponsesMediaStreamSimple } from "./openai-responses-media.js";
import { repairRejectedSchemas, wireTools, type WireTool } from "./tool-schema-recovery.js";

function streamFor(
  model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions, input: readonly string[],
): AssistantMessageEventStream {
  switch (model.api) {
    case "google-vertex":
    case "google-generative-ai": return googleStreamSimple(model, context, options, input.includes("video"), input);
    case "openai-completions": return openAICompletionsStreamSimple(model, context, options, input);
    case "anthropic-messages": return anthropicMediaStreamSimple(model, context, options, input);
    case "openai-responses": return openAIResponsesMediaStreamSimple(model, context, options, input);
    case "openai-codex-responses": return codexResponsesMediaStreamSimple(model, context, options, input);
    default: throw new Error(`Unsupported model API: ${model.api}`);
  }
}

type Repair = { original: string; schema: WireTool["schema"] };
const MAX_SCHEMA_RETRIES = 8;

/** A provider registration owns the learned repairs; changing its config discards them. */
export function createConfiguredModelStream() {
  const learned = new Map<string, Map<string, Repair>>();
  return function streamConfiguredModel(
    model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, input: readonly string[],
  ): AssistantMessageEventStream {
    const modelKey = JSON.stringify([model.provider, model.id, model.api, model.baseUrl]);
    const repairs = learned.get(modelKey) ?? new Map<string, Repair>();
    learned.set(modelKey, repairs);
    const activeRepairs = new Map(repairs);
    const pendingRepairs = new Map<string, Repair>();
    const downgradedInTurn = new Set<string>();
    let sentPayload: unknown;
    let responseStatus: number | undefined;

    function attempt() {
      responseStatus = undefined;
      return streamFor(model, context, {
        ...options,
        onResponse: (response, requestModel) => {
          responseStatus = response.status;
          return options?.onResponse?.(response, requestModel);
        },
        onPayload: async (payload, requestModel) => {
          const body = (await options?.onPayload?.(payload, requestModel)) ?? payload;
          if (pendingRepairs.size || activeRepairs.size) {
            for (const entry of wireTools(model.api, body)) {
              const candidate = pendingRepairs.get(entry.name) ?? activeRepairs.get(entry.name);
              if (candidate && JSON.stringify(entry.schema) === candidate.original) {
                // Replace only this SDK-generated wire field. The executing tool and its schema are untouched.
                entry.declaration[entry.key] = candidate.schema;
              }
            }
          }
          sentPayload = body;
          return body;
        },
      }, input);
    }

    const output = createAssistantMessageEventStream();
    void (async () => {
      let current = attempt();
      let retries = 0;
      while (true) {
        let started = false;
        let retried = false;
        for await (const event of current) {
          if (!started && event.type === "error" && event.reason === "error" && !options?.signal?.aborted && retries < MAX_SCHEMA_RETRIES) {
            const fixes = repairRejectedSchemas(event.error.errorMessage ?? "", wireTools(model.api, sentPayload), responseStatus);
            const primary = fixes[0];
            if (primary && !downgradedInTurn.has(primary.tool.name)) {
              // 同一工具最多降级一次，杜绝重复降级循环；同批次其他未降级工具的相同非法字面量一并修复。
              const previous = activeRepairs.get(primary.tool.name);
              const primaryOriginal = JSON.stringify(primary.tool.schema);
              if (!previous || JSON.stringify(previous.schema) !== primaryOriginal) {
                for (const fix of fixes) {
                  if (downgradedInTurn.has(fix.tool.name)) continue;
                  const original = JSON.stringify(fix.tool.schema);
                  const prior = activeRepairs.get(fix.tool.name);
                  if (prior && JSON.stringify(prior.schema) === original) continue;
                  pendingRepairs.set(fix.tool.name, { original, schema: fix.schema });
                  downgradedInTurn.add(fix.tool.name);
                }
                retries++;
                try {
                  current = attempt();
                  retried = true;
                  break;
                } catch {
                  output.push(event);
                  return;
                }
              }
            }
          }
          started = true;
          sentPayload = undefined;
          if (event.type === "done" && pendingRepairs.size) {
            for (const [name, repair] of pendingRepairs) repairs.set(name, repair);
          }
          output.push(event);
        }
        if (!retried) return;
      }
    })();
    return output;
  };
}
