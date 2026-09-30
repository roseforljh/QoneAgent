import type { ReachChannelInfo } from "@qone/protocol";

export const reachChannelEnglish = {
  web: { name: "Web reader", description: "Extract public web pages with Jina Reader", backend: "Jina Reader" },
  rss: { name: "RSS / Atom", description: "Read public feeds", backend: "Built-in parser" },
  v2ex: { name: "V2EX", description: "Trending, latest, nodes and replies", backend: "V2EX public API" },
  github: { name: "GitHub", description: "Public repositories and search; connect GitHub MCP for account operations", backend: "GitHub public API", detail: "Public features are available; private repositories and write operations require GitHub MCP." },
  bilibili: { name: "Bilibili", description: "Search public videos; use OpenCLI for subtitles and account operations", backend: "Bilibili public API", detail: "Public video search is available; connect Chrome for subtitles and account features." },
  twitter: { name: "X / Twitter", description: "Read or operate your account through the website adapter", backend: "OpenCLI" },
  reddit: { name: "Reddit", description: "Read or operate your account through the website adapter", backend: "OpenCLI" },
  facebook: { name: "Facebook", description: "Read or operate your account through the website adapter", backend: "OpenCLI" },
  instagram: { name: "Instagram", description: "Read or operate your account through the website adapter", backend: "OpenCLI" },
  xiaohongshu: { name: "Xiaohongshu", description: "Read or operate your account through the website adapter", backend: "OpenCLI" },
  xueqiu: { name: "Xueqiu", description: "Stock quotes, search and trending stocks", backend: "OpenCLI / Xueqiu API" },
  boss: { name: "BOSS Zhipin", description: "Job search, job details and recruitment operations", backend: "OpenCLI" },
  youtube: { name: "YouTube", description: "Search videos and read video metadata", backend: "yt-dlp" },
  exa_search: { name: "Exa Search", description: "Semantic web search", backend: "Exa MCP" },
  linkedin: { name: "LinkedIn", description: "Public pages and account operations", backend: "OpenCLI / Jina Reader", detail: "Account features use your Chrome session through OpenCLI. Try the web reader for public pages." },
  xiaoyuzhou: { name: "Xiaoyuzhou", description: "Podcasts, episodes, subtitles and audio transcription", backend: "OpenCLI / Groq Whisper" },
} satisfies Record<string, NonNullable<ReachChannelInfo["english"]>>;

export type ReachChannelId = keyof typeof reachChannelEnglish;
