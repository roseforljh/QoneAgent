import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const CODEMODE_LITERAL_GUIDANCE = "Use `/` in Windows drive paths (e.g. `C:/work/file`), or `String.raw` tagged templates for literal backslashes in paths and shell commands.";

/** Pi omits its default tool guidance when a custom preamble is supplied.
 * Keep tool-owned instructions in a variable section after Qone's fixed prefix. */
export const toolPromptContextExtension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", ({ systemPromptOptions: options }) => {
    const snippets = options.selectedTools.flatMap((name) => {
      const snippet = options.toolSnippets[name]?.trim();
      return snippet ? [`- ${name}: ${snippet}`] : [];
    });
    const guidelines = [...new Set(options.selectedTools.flatMap((name) => options.toolGuidelines[name] ?? []))];
    if (options.selectedTools.includes("codemode")) {
      guidelines.push(`For one command or file operation, call the direct tool when available. In Codemode: ${CODEMODE_LITERAL_GUIDANCE} A failed tool call throws and ends the whole script, so wrap independent calls in try/catch or Promise.allSettled.`);
    }
    options.sections.tool_guidance = [
      ...snippets,
      ...guidelines.map((rule) => `- ${rule}`),
    ].join("\n");
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "codemode" || !event.isError) return;
    const calls = (event.details as { calls?: unknown[] } | undefined)?.calls;
    if (!Array.isArray(calls) || calls.length !== 0) return;
    // QuickJS escape SyntaxErrors are surfaced in Pi's Script error block, not as shell errors.
    if (!event.content.some((part) => part.type === "text" && /^Script error:\r?\nSyntaxError:[^\r\n]*\bescape\b/im.test(part.text))) return;
    return {
      content: [...event.content, {
        type: "text",
        text: `Fix the JavaScript string before retrying; no shell or file tool ran. ${CODEMODE_LITERAL_GUIDANCE} For a single command, call the shell tool directly when available.`,
      }],
      structuredContent: event.structuredContent,
    };
  });
};
