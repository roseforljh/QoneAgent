import type { CSSProperties } from "react";
import type { MessageKey } from "../../localization";
import mcpLogo from "@lobehub/icons-static-svg/icons/mcp.svg";
import cloudflareLogo from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import notionLogo from "@lobehub/icons-static-svg/icons/notion.svg";
import githubLogo from "@lobehub/icons-static-svg/icons/github.svg";
import context7Logo from "../../assets/context7-logo.svg";
import playwrightLogo from "../../assets/playwright-logo.svg";
import reaLogo from "../../assets/rea-logo.svg";
import outlookLogo from "../../assets/outlook-logo.svg";
import gmailLogo from "../../assets/gmail-logo.svg";
import qqmailLogo from "../../assets/qqmail-logo.svg";
import neteaseMailLogo from "../../assets/netease-mail-logo.svg";
import firecrawlLogo from "@lobehub/icons-static-svg/icons/firecrawl-color.svg";
import exaLogo from "@lobehub/icons-static-svg/icons/exa-color.svg";
import tavilyLogo from "@lobehub/icons-static-svg/icons/tavily-color.svg";
import braveLogo from "@lobehub/icons-static-svg/icons/brave-color.svg";
import perplexityLogo from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import { Mail } from "lucide-react";

// 官方 MCP 预设：stdio 走 npx、远程走 Streamable HTTP，点开关即启用（关闭 = mcp.delete 移除）。
// 带 tokenEnv/env 的项需要对应环境变量存在才能连上，描述里已注明。
export const MCP_PRESETS: { id: string; name: string; descKey: MessageKey; logo: string; mono?: boolean; lightBadge?: boolean; config: { command?: string; args?: string[]; url?: string; tokenEnv?: string; env?: Record<string, string>; authMode?: "oauth" } }[] = [
  { id: "mcp-playwright", name: "Playwright", descKey: "mcp.presetPlaywright", logo: playwrightLogo, lightBadge: true, config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
  { id: "mcp-context7", name: "Context7", descKey: "mcp.presetContext7", logo: context7Logo, lightBadge: true, config: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
  { id: "mcp-rea", name: "REA", descKey: "mcp.presetRea", logo: reaLogo, config: { command: "npx", args: ["-y", "rea-agents", "mcp"] } },
  { id: "mcp-cloudflare-docs", name: "Cloudflare", descKey: "mcp.presetCloudflare", logo: cloudflareLogo, config: { url: "https://mcp.cloudflare.com/mcp", authMode: "oauth" } },
  { id: "mcp-notion", name: "Notion", descKey: "mcp.presetNotion", logo: notionLogo, mono: true, lightBadge: true, config: { url: "https://mcp.notion.com/mcp", authMode: "oauth" } },
  { id: "mcp-github", name: "GitHub", descKey: "mcp.presetGitHub", logo: githubLogo, mono: true, lightBadge: true, config: { url: "https://api.githubcopilot.com/mcp/" } },
];

export const configuredGithubClientId = import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";

// 邮箱预设：收发件必须填凭证，开关点开的是预填好 IMAP/SMTP 的添加对话框，而不是直接连。
export const EMAIL_PRESETS: { id: string; name: string; nameKey?: MessageKey; descKey: MessageKey; logo?: string; mono?: boolean; badgeStyle?: CSSProperties; lucide?: typeof Mail; prefill: { command: string; args: string; env: string } }[] = [
  { id: "mcp-outlook-mail", name: "Outlook Mail", nameKey: "mcp.outlookName", descKey: "mcp.presetOutlook", logo: outlookLogo, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=outlook.office365.com\nIMAP_PORT=993\nSMTP_HOST=smtp.office365.com\nSMTP_PORT=587" } },
  { id: "mcp-gmail", name: "Gmail", descKey: "mcp.presetGmail", logo: gmailLogo, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=imap.gmail.com\nIMAP_PORT=993\nSMTP_HOST=smtp.gmail.com\nSMTP_PORT=465" } },
  { id: "mcp-qqmail", name: "QQ Mail", nameKey: "mcp.qqName", descKey: "mcp.presetQqMail", logo: qqmailLogo, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=imap.qq.com\nIMAP_PORT=993\nSMTP_HOST=smtp.qq.com\nSMTP_PORT=465" } },
  { id: "mcp-netease-mail", name: "NetEase Mail", nameKey: "mcp.neteaseName", descKey: "mcp.presetNetEase", logo: neteaseMailLogo, mono: true, badgeStyle: { background: "#d43c33", color: "#fff" }, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=imap.163.com\nIMAP_PORT=993\nSMTP_HOST=smtp.163.com\nSMTP_PORT=465" } },
  { id: "mcp-custom-mail", name: "Custom Mail", nameKey: "mcp.customMailName", descKey: "mcp.presetCustomMail", lucide: Mail, prefill: { command: "npx", args: "-y mcp-email-server", env: "EMAIL_ADDRESS=\nEMAIL_PASSWORD=\nIMAP_HOST=\nIMAP_PORT=993\nSMTP_HOST=\nSMTP_PORT=465" } },
];

// 填 key 即用的网络服务预设：Key 存在系统凭据中，MCP 配置只保存凭据引用。
export const KEY_PRESETS: { id: string; name: string; nameKey?: MessageKey; descKey: MessageKey; logo?: string; mono?: boolean; badgeStyle?: CSSProperties; lucide?: typeof Mail; prefill: { command: string; args: string; env: string } }[] = [
  { id: "mcp-firecrawl", name: "Firecrawl", descKey: "mcp.presetFirecrawl", logo: firecrawlLogo, prefill: { command: "npx", args: "-y firecrawl-mcp", env: "FIRECRAWL_API_KEY=" } },
  { id: "mcp-exa", name: "Exa", descKey: "mcp.presetExa", logo: exaLogo, prefill: { command: "npx", args: "-y exa-mcp-server", env: "EXA_API_KEY=" } },
  { id: "mcp-tavily", name: "Tavily", descKey: "mcp.presetTavily", logo: tavilyLogo, prefill: { command: "npx", args: "-y tavily-mcp", env: "TAVILY_API_KEY=" } },
  { id: "mcp-brave-search", name: "Brave Search", descKey: "mcp.presetBrave", logo: braveLogo, prefill: { command: "npx", args: "-y @brave/brave-search-mcp-server --transport stdio", env: "BRAVE_API_KEY=" } },
  { id: "mcp-perplexity", name: "Perplexity", descKey: "mcp.presetPerplexity", logo: perplexityLogo, prefill: { command: "npx", args: "-y server-perplexity-ask", env: "PERPLEXITY_API_KEY=" } },
];

export { mcpLogo };