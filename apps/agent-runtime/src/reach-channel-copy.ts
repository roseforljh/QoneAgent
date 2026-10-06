import type { ReachChannelInfo } from "@qone/protocol";

export const reachChannelEnglish = {
  rss: { name: "RSS / Atom", description: "Read public feeds", backend: "Built-in parser" },
  v2ex: { name: "V2EX", description: "Trending, latest, nodes and replies", backend: "V2EX public API" },
  github: { name: "GitHub", description: "Public repositories and search; connect GitHub MCP for account operations", backend: "GitHub public API", detail: "Public features are available; private repositories and write operations require GitHub MCP." },
  tiktok: { name: "TikTok", description: "Read and operate TikTok through the website adapter", backend: "OpenCLI" },
  bilibili: { name: "Bilibili", description: "Search, read and operate Bilibili; download videos", backend: "OpenCLI / Qone media tools", detail: "Site operations use OpenCLI; video files use Qone's media tools." },
  twitter: { name: "X / Twitter", description: "Search and read posts, profiles and timelines", backend: "OpenCLI" },
  reddit: { name: "Reddit", description: "Search posts, read comments, profiles and communities", backend: "OpenCLI" },
  facebook: { name: "Facebook", description: "Read or operate your account through the website adapter", backend: "OpenCLI" },
  instagram: { name: "Instagram", description: "Read or operate your account through the website adapter", backend: "OpenCLI" },
  xiaohongshu: { name: "Xiaohongshu", description: "Read or operate your account through the website adapter", backend: "OpenCLI" },
  xueqiu: { name: "Xueqiu", description: "Stock quotes, search and trending stocks", backend: "OpenCLI / Xueqiu API" },
  boss: { name: "BOSS Zhipin", description: "Job search, job details and recruitment operations", backend: "OpenCLI" },
  youtube: { name: "YouTube", description: "Search, inspect and download videos", backend: "OpenCLI / Qone media tools" },
  exa_search: { name: "Exa Search", description: "Semantic web search", backend: "Exa MCP" },
  linkedin: { name: "LinkedIn", description: "Public pages and account operations", backend: "OpenCLI", detail: "Use OpenCLI with your saved website session." },
  xiaoyuzhou: { name: "Xiaoyuzhou", description: "Podcasts, episodes, subtitles and audio transcription", backend: "OpenCLI / Groq Whisper" },
} satisfies Record<string, NonNullable<ReachChannelInfo["english"]>>;

export type ReachChannelId = keyof typeof reachChannelEnglish;
