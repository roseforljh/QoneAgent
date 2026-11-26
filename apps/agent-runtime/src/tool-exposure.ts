import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type Namespace = { name: string; description: string };

const REACH_TOOLS = new Set(["qone_bilibili_search", "qone_youtube_search", "qone_github_public", "qone_rss_read", "qone_v2ex", "qone_podcast_transcribe"]);
const REACH: Namespace = { name: "reach", description: "Public web data without a browser: GitHub API, V2EX, Bilibili and YouTube search, RSS feeds, podcast transcription" };
const APP_MEDIA: Namespace = { name: "app_media", description: "Download, inspect and list videos from Douyin, Bilibili, YouTube and other video apps" };
const BROWSER: Namespace = { name: "browser", description: "Qone built-in browser and OpenCLI site adapters — use only when web search, direct URL fetch, or service MCPs cannot cover login, anti-bot, or interactive rendering" };
// 已连接的通用网页搜索/抓取 MCP 核心工具直接声明，避免模型因搜不到工具而默认打开浏览器。
const DIRECT_WEB_MCP_TOOLS = new Set([
  "web_search_exa",
  "web_fetch_exa",
  "firecrawl_search",
  "firecrawl_scrape",
  "tavily_search",
  "tavily_extract",
  "brave_web_search",
  "perplexity_ask",
  "fetch",
]);

function isDirectWebMcpTool(rawToolName: string, tool: ToolDefinition, externalBrowser?: boolean): boolean {
  if (externalBrowser) return false;
  if (DIRECT_WEB_MCP_TOOLS.has(rawToolName)) return true;
  // 按工具命名语义与参数字段自动识别任意网页搜索/抓取 MCP，不再局限于固定工具名表
  const isWebAction = /(?:^|[_-])(?:web[_-]?search|search[_-]?web|web[_-]?fetch|fetch[_-]?url|read[_-]?url|scrape|crawl)(?:$|[_-])/i.test(rawToolName);
  if (!isWebAction) return false;
  const props = (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Boolean(props && ("url" in props || "urls" in props || "query" in props || "q" in props));
}

function isBuiltInBrowserToolName(name: string): boolean {
  return name.startsWith("qone_browser_") || name.startsWith("qone_opencli_") || name.startsWith("qone_twitter_");
}

/**
 * Which tools stay declared and which load on demand. Core coding, shell,
 * subagent, memory, goal, and direct web search/fetch tools are always declared;
 * built-in browser tools and heavy integrations (MCP servers, SSH servers, app
 * media, public web APIs) are `deferred`: found with `tool_search` or called
 * from codemode scripts, so their schemas cost nothing until they are needed.
 */
export function namespaceFor(tool: ToolDefinition, servers?: Namespace): Namespace | undefined {
  const meta = tool as ToolDefinition & { qoneToolName?: string; qoneMcpServerName?: string; qoneExternalBrowserMcp?: boolean };
  const qoneName = meta.qoneToolName;
  if (qoneName?.startsWith("mcp:")) {
    const parts = qoneName.split(":");
    const server = parts[1]!;
    const rawToolName = parts.slice(2).join(":");
    if (isDirectWebMcpTool(rawToolName, tool, meta.qoneExternalBrowserMcp)) return undefined;
    const displayName = meta.qoneMcpServerName?.trim();
    const label = displayName && displayName !== server ? `${displayName} (${server})` : server;
    const prefix = meta.qoneExternalBrowserMcp
      ? `External browser fallback MCP server ${label} (prefer web search/fetch and Qone built-in browser first; use only when built-in browser cannot support the task)`
      : `MCP server ${label}`;
    return { name: `mcp_${server.replace(/[^a-zA-Z0-9_]/g, "_")}`, description: prefix };
  }
  if (isBuiltInBrowserToolName(tool.name)) return BROWSER;
  if (REACH_TOOLS.has(tool.name)) return REACH;
  if (tool.name.startsWith("qone_douyin_") || tool.name.startsWith("qone_app_")) return APP_MEDIA;
  if (tool.name.startsWith("server_") && servers) return servers;
  return undefined;
}

export interface ToolLoadout { tools: ToolDefinition[]; catalog: string }

const firstSentence = (text: string) => text.trim().split(/(?<=[.!?。])\s|\n/)[0]!.trim().slice(0, 160);

/**
 * A server id alone ("mcp-cloudflare-docs") hides what an MCP server can do, so the
 * model never thinks to search it. Its tools' own first sentences name the service
 * and capability; tool_search and codemode index this text with the namespace.
 */
function mcpDescription(namespace: Namespace, tools: ToolDefinition[]): Namespace {
  const sentences = [...new Set(tools.map((tool) => firstSentence(tool.description ?? "")).filter(Boolean))];
  const summary = sentences.join(" ");
  const capped = summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;
  return { ...namespace, description: `${namespace.description}, connected. ${capped}`.trim() };
}

export function applyToolExposure(tools: ToolDefinition[], servers?: Namespace): ToolLoadout {
  const members = new Map<string, { namespace: Namespace; tools: ToolDefinition[] }>();
  for (const tool of tools) {
    const namespace = namespaceFor(tool, servers);
    if (!namespace) continue;
    const entry = members.get(namespace.name) ?? { namespace, tools: [] };
    entry.tools.push(tool);
    members.set(namespace.name, entry);
  }
  const resolved = new Map([...members].map(([name, { namespace, tools: group }]) =>
    [name, name.startsWith("mcp_") ? mcpDescription(namespace, group) : namespace]));
  const groups = new Map([...resolved].map(([name, namespace]) => [name, namespace.description]));
  const result = tools.map((tool) => {
    const namespace = resolved.get(namespaceFor(tool, servers)?.name ?? "");
    if (!namespace) return tool;
    // 延迟加载工具在 tool_search 后才进入活跃列表；移除其 promptSnippet/promptGuidelines，避免次轮重建时改动 systemPrompt 击穿前缀缓存。
    const { promptSnippet: _snippet, promptGuidelines: _guidelines, ...rest } = tool as ToolDefinition & { promptSnippet?: unknown; promptGuidelines?: unknown };
    return { ...rest, exposure: "deferred", namespace } as ToolDefinition;
  });
  const catalog = [...groups].map(([name, description]) => `- ${name}: ${description}`).join("\n");
  return {
    tools: result,
    catalog: catalog && `<on-demand-tools>\nFind tools by task with the tool_search tool, or inside one codemode script with searchTools(query, { namespace }) and tools[name](args); scripts have no tools.tool_search. Available namespaces:\n${catalog}\n</on-demand-tools>`,
  };
}

/**
 * Tools the transcript declared, in the order they first appeared: names called in
 * assistant `toolCall` blocks and names `tool_search` loaded (`details.loaded`).
 * A rebuilt session re-declares them in this order so the provider-visible tool
 * list, and with it the cached prompt prefix, matches the one before the rebuild.
 */
export function usedToolNames(messages: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages.flat()) {
    if (!message || typeof message !== "object") continue;
    const { content, toolName, details } = message as { content?: unknown; toolName?: unknown; details?: { loaded?: unknown } };
    if (toolName === "tool_search" && Array.isArray(details?.loaded)) {
      for (const name of details.loaded) if (typeof name === "string") names.add(name);
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall" && typeof (block as { name?: unknown }).name === "string") names.add((block as { name: string }).name);
    }
  }
  return names;
}
