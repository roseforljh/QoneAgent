import type { HTMLAttributes } from "react";
import type { McpServerInfo } from "@qone/protocol";
import mcpLogo from "@lobehub/icons-static-svg/icons/mcp.svg";
import cloudflareLogo from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import notionLogo from "@lobehub/icons-static-svg/icons/notion.svg";
import githubLogo from "@lobehub/icons-static-svg/icons/github.svg";
import firecrawlLogo from "@lobehub/icons-static-svg/icons/firecrawl-color.svg";
import exaLogo from "@lobehub/icons-static-svg/icons/exa-color.svg";
import tavilyLogo from "@lobehub/icons-static-svg/icons/tavily-color.svg";
import braveLogo from "@lobehub/icons-static-svg/icons/brave-color.svg";
import perplexityLogo from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import context7Logo from "../../assets/context7-logo.svg";
import playwrightLogo from "../../assets/playwright-logo.svg";
import outlookLogo from "../../assets/outlook-logo.svg";
import gmailLogo from "../../assets/gmail-logo.svg";
import qqmailLogo from "../../assets/qqmail-logo.svg";
import neteaseMailLogo from "../../assets/netease-mail-logo.svg";
import globeLogo from "../../assets/codex-icons/globe-light-16.svg";
import { CodexMcpIcon, type ExecutionIcon } from "./execution-icons";
import { translate, type Locale } from "../../localization";

export interface ToolIntegration {
  id: string;
  name: string;
  logo: string;
  kind?: "source";
}

const BUILTIN_MCP_LOGOS: Record<string, string> = {
  "mcp-playwright": playwrightLogo,
  "mcp-context7": context7Logo,
  "mcp-cloudflare-docs": cloudflareLogo,
  "mcp-notion": notionLogo,
  "mcp-github": githubLogo,
  "mcp-outlook-mail": outlookLogo,
  "mcp-gmail": gmailLogo,
  "mcp-qqmail": qqmailLogo,
  "mcp-netease-mail": neteaseMailLogo,
  "mcp-firecrawl": firecrawlLogo,
  "mcp-exa": exaLogo,
  "mcp-tavily": tavilyLogo,
  "mcp-brave-search": braveLogo,
  "mcp-perplexity": perplexityLogo,
};

const BUILTIN_MCP_NAMES: Record<string, string> = {
  "mcp-playwright": "Playwright",
  "mcp-context7": "Context7",
  "mcp-cloudflare-docs": "Cloudflare",
  "mcp-notion": "Notion",
  "mcp-github": "GitHub",
  "mcp-outlook-mail": "Outlook Mail",
  "mcp-gmail": "Gmail",
  "mcp-qqmail": "QQ Mail",
  "mcp-netease-mail": "NetEase Mail",
  "mcp-firecrawl": "Firecrawl",
  "mcp-exa": "Exa",
  "mcp-tavily": "Tavily",
  "mcp-brave-search": "Brave Search",
  "mcp-perplexity": "Perplexity",
};

const BUILTIN_TOOLS: Record<string, ToolIntegration> = {
  qone_web_read: { id: "web", name: "网页", logo: globeLogo, kind: "source" },
  qone_github_public: { id: "github", name: "GitHub", logo: githubLogo },
};

function mcpServerId(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp:")) return undefined;
  const separator = toolName.indexOf(":", 4);
  return separator > 4 ? toolName.slice(4, separator) : undefined;
}

/** Resolve a tool to the same integration identity used by the MCP settings. */
export function toolIntegration(
  toolName: string,
  servers: readonly McpServerInfo[],
  locale: Locale = "zh-CN",
): ToolIntegration | undefined {
  const builtin = Object.hasOwn(BUILTIN_TOOLS, toolName) ? BUILTIN_TOOLS[toolName] : undefined;
  if (builtin) return builtin.id === "web" ? { ...builtin, name: translate(locale, "chat.toolSourceWeb") } : builtin;

  const configuredServer = servers.find((item) => toolName.startsWith(`mcp:${item.id}:`));
  const serverId = configuredServer?.id ?? mcpServerId(toolName);
  if (!serverId) return undefined;
  return {
    id: serverId,
    name: configuredServer?.name || (Object.hasOwn(BUILTIN_MCP_NAMES, serverId) ? BUILTIN_MCP_NAMES[serverId] : undefined) || serverId,
    logo: Object.hasOwn(BUILTIN_MCP_LOGOS, serverId) ? BUILTIN_MCP_LOGOS[serverId]! : mcpLogo,
  };
}

/** Render a colored integration logo while preserving the execution icon API. */
export function integrationIcon(integration: ToolIntegration | undefined): ExecutionIcon {
  if (!integration || integration.logo === mcpLogo) return CodexMcpIcon;
  return function IntegrationGlyph({ size, style, ...props }: HTMLAttributes<HTMLSpanElement> & { size?: number }) {
    return <span
      {...props}
      aria-hidden="true"
      style={{
        ...(size ? { width: size, height: size } : {}),
        backgroundImage: `url("${integration.logo}")`,
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundSize: "contain",
        display: "inline-block",
        ...style,
      }}
    />;
  };
}
