import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export function executionAdviceExtension(find: (provider: string, model: string, tool: string, input: unknown) => string | undefined): ExtensionFactory {
  return (pi) => {
    const seen = new Set<string>();
    const pending = new Map<string, { tool: string; input: unknown }[]>();
    pi.on("before_agent_start", () => { seen.clear(); pending.clear(); });
    pi.on("tool_call", (event, { model }) => {
      if (!model) return;
      const advice = find(model.provider, model.id, event.toolName, event.input);
      if (!advice || seen.has(advice)) return;
      // Nested calls do not have their own model-visible result. Append to the new outer result.
      const owner = event.parentToolCallId?.split("/")[0] ?? event.toolCallId;
      const calls = pending.get(owner) ?? [];
      calls.push({ tool: event.toolName, input: event.input });
      pending.set(owner, calls);
    });
    pi.on("tool_result", (event, { model }) => {
      if (event.parentToolCallId || !model) return;
      const calls = pending.get(event.toolCallId);
      pending.delete(event.toolCallId);
      if (!calls) return;
      for (const { tool, input } of calls) {
        // Recheck consent at delivery, not only when the command started.
        const advice = find(model.provider, model.id, tool, input);
        if (!advice || seen.has(advice)) continue;
        seen.add(advice);
        return {
          content: [...event.content, { type: "text", text: `Execution tip: ${advice}` }],
          structuredContent: event.structuredContent,
        };
      }
    });
  };
}
