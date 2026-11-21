import { createAssistantMessageEventStream, type Api, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { anthropicMediaStreamSimple } from "./anthropic-media.js";
import { googleStreamSimple } from "./google-media.js";
import { openAICompletionsStreamSimple } from "./openai-audio.js";
import { codexResponsesMediaStreamSimple, openAIResponsesMediaStreamSimple } from "./openai-responses-media.js";
import { repairRejectedSchema, wireTools, type WireTool } from "./tool-schema-recovery.js";

function streamFor(
  model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions, input: readonly string[],
): AssistantMessageEventStream {
  switch (model.api) {
    case "google-generative-ai": return googleStreamSimple(model, context, options, input.includes("video"), input);
    case "openai-completions": return openAICompletionsStreamSimple(model, context, options, input);
    case "anthropic-messages": return anthropicMediaStreamSimple(model, context, options, input);
    case "openai-responses": return openAIResponsesMediaStreamSimple(model, context, options, input);
    case "openai-codex-responses": return codexResponsesMediaStreamSimple(model, context, options, input);
    default: throw new Error(`Unsupported model API: ${model.api}`);
  }
}

type Repair = { original: string; schema: WireTool["schema"] };

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
    let sentPayload: unknown;
    let responseStatus: number | undefined;
    function attempt(repair?: { name: string } & Repair) {
      return streamFor(model, context, {
        ...options,
        onResponse: (response, requestModel) => {
          responseStatus = response.status;
          return options?.onResponse?.(response, requestModel);
        },
        onPayload: async (payload, requestModel) => {
          const body = (await options?.onPayload?.(payload, requestModel)) ?? payload;
          if (repair || activeRepairs.size) {
            for (const entry of wireTools(model.api, body)) {
              const candidate = repair?.name === entry.name ? repair : activeRepairs.get(entry.name);
              if (candidate && JSON.stringify(entry.schema) === candidate.original) {
                // Replace only this SDK-generated wire field. The executing tool and its schema are untouched.
                entry.declaration[entry.key] = candidate.schema;
              }
            }
          }
          if (!repair) sentPayload = body;
          return body;
        },
      }, input);
    }
    const first = attempt();
    const output = createAssistantMessageEventStream();
    void (async () => {
      let started = false;
      for await (const event of first) {
        if (!started && event.type === "error" && event.reason === "error" && !options?.signal?.aborted) {
          const fix = repairRejectedSchema(event.error.errorMessage ?? "", wireTools(model.api, sentPayload), responseStatus);
          if (fix) {
            // Learn only a successful first downgrade for the exact declaration. Do not compound changes.
            const original = JSON.stringify(fix.tool.schema);
            const previous = activeRepairs.get(fix.tool.name);
            if (!previous || JSON.stringify(previous.schema) !== original) {
              const repair = { name: fix.tool.name, original, schema: fix.schema };
              let second: AssistantMessageEventStream;
              try { second = attempt(repair); }
              catch { output.push(event); return; }
              for await (const next of second) {
                if (next.type === "done") repairs.set(repair.name, repair);
                output.push(next);
              }
              return;
            }
          }
        }
        started = true;
        sentPayload = undefined;
        output.push(event);
      }
    })();
    return output;
  };
}
