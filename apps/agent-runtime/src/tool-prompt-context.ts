import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Pi omits its default tool guidance when a custom preamble is supplied.
 * Keep tool-owned instructions in a variable section after Qone's fixed prefix. */
export const toolPromptContextExtension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", ({ systemPromptOptions: options }) => {
    const snippets = options.selectedTools.flatMap((name) => {
      const snippet = options.toolSnippets[name]?.trim();
      return snippet ? [`- ${name}: ${snippet}`] : [];
    });
    const guidelines = [...new Set(options.selectedTools.flatMap((name) => options.toolGuidelines[name] ?? []))];
    options.sections.tool_guidance = [
      ...snippets,
      ...guidelines.map((rule) => `- ${rule}`),
    ].join("\n");
  });
};
