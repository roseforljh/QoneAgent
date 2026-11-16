import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type Namespace = { name: string; description: string };

const REACH_TOOLS = new Set(["qone_bilibili_search", "qone_youtube_search", "qone_github_public", "qone_rss_read", "qone_podcast_transcribe"]);
const REACH: Namespace = { name: "reach", description: "Public web data without a browser: GitHub API, Bilibili and YouTube search, RSS feeds, podcast transcription" };
const APP_MEDIA: Namespace = { name: "app_media", description: "Download, inspect and list videos from Douyin, Bilibili, YouTube and other video apps" };

/**
 * Which tools stay declared and which load on demand. Core coding, shell,
 * browser, subagent, memory and goal tools are always declared; integrations
 * whose descriptions are large or numerous (MCP servers, SSH servers, app
 * media, public web APIs) are `deferred`: found with `tool_search` or called
 * from codemode scripts, so their schemas cost nothing until they are needed.
 */
export function namespaceFor(tool: ToolDefinition, servers?: Namespace): Namespace | undefined {
  const qoneName = (tool as ToolDefinition & { qoneToolName?: string }).qoneToolName;
  if (qoneName?.startsWith("mcp:")) {
    const server = qoneName.split(":")[1]!;
    return { name: `mcp_${server.replace(/[^a-zA-Z0-9_]/g, "_")}`, description: `MCP server ${server}` };
  }
  if (REACH_TOOLS.has(tool.name)) return REACH;
  if (tool.name.startsWith("qone_douyin_") || tool.name.startsWith("qone_app_")) return APP_MEDIA;
  if (tool.name.startsWith("server_") && servers) return servers;
  return undefined;
}

export interface ToolLoadout { tools: ToolDefinition[]; catalog: string }

export function applyToolExposure(tools: ToolDefinition[], servers?: Namespace): ToolLoadout {
  const groups = new Map<string, { namespace: Namespace; names: string[] }>();
  const result = tools.map((tool) => {
    const namespace = namespaceFor(tool, servers);
    if (!namespace) return tool;
    const group = groups.get(namespace.name) ?? { namespace, names: [] };
    group.names.push(tool.name);
    groups.set(namespace.name, group);
    return { ...tool, exposure: "deferred", namespace } as ToolDefinition;
  });
  const catalog = [...groups.values()]
    .map(({ namespace, names }) => `- ${namespace.name}: ${namespace.description} (${names.join(", ")})`)
    .join("\n");
  return {
    tools: result,
    catalog: catalog && `<on-demand-tools>\nThese tools are not loaded yet. Load the ones you need with tool_search (for example tool_search "server exec"), or call them from codemode as tools.<name>(…). Each group:\n${catalog}\n</on-demand-tools>`,
  };
}

/** Names of tools called in Pi assistant messages (`{ type: "toolCall", name }` content blocks). */
export function usedToolNames(messages: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages.flat()) {
    const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall" && typeof (block as { name?: unknown }).name === "string") names.add((block as { name: string }).name);
    }
  }
  return names;
}
