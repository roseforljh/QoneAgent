import { existsSync } from "node:fs";
import path from "node:path";
import type { ReachChannelInfo } from "@qone/protocol";

const OPENCLI_SITES = ["twitter", "reddit", "facebook", "instagram", "xiaohongshu"] as const;

function executable(name: string): string | undefined {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    process.env.QONE_TOOLS_DIR && path.join(process.env.QONE_TOOLS_DIR, file),
    path.join(path.dirname(process.execPath), file),
    path.join(path.dirname(process.execPath), "binaries", file),
    path.resolve(import.meta.dir, "../../desktop/src-tauri/binaries", file),
    path.join(process.cwd(), "apps", "desktop", "src-tauri", "binaries", file),
    ...((process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, file))),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

export function ytDlpExecutable(): string | undefined {
  const configured = process.env.QONE_YT_DLP;
  return configured && existsSync(configured) ? configured : executable("yt-dlp");
}

interface ChannelContext { browserConnected: boolean; mcpConnected: (id: string) => boolean; hasXueqiuCookie?: boolean; podcastConfigured?: boolean; hasGroqKey?: boolean }

export function listReachChannels(context: ChannelContext): ReachChannelInfo[] {
  const publicChannel = (id: string, name: string, description: string, backend: string, tools: string[], detail?: string): ReachChannelInfo =>
    ({ id, name, description, backend, tools, state: "available", detail });
  const openCliChannel = (id: string, name: string, description: string, detail?: string): ReachChannelInfo => ({
    id, name, description, backend: "OpenCLI", tools: ["qone_opencli_discover", "qone_opencli_run"],
    state: context.browserConnected ? "unverified" : "needs-connection",
    detail: context.browserConnected ? "浏览器桥接已连接；网站登录态和命令需执行时验证" : detail ?? "连接 Chrome 并在网站登录后使用",
    action: "opencli",
  });
  const channels: ReachChannelInfo[] = [
    publicChannel("web", "网页阅读", "通过 Jina Reader 提取公开网页正文", "Jina Reader", ["qone_web_read"]),
    publicChannel("rss", "RSS / Atom", "读取公开订阅源", "内置解析器", ["qone_rss_read"]),
    publicChannel("v2ex", "V2EX", "热门、最新、节点与回复", "V2EX 公开 API", ["qone_v2ex"]),
    { ...publicChannel("github", "GitHub", "公开仓库与搜索；账号操作可连接 GitHub MCP", "GitHub 公开 API", ["qone_github_public"], "公开功能可用；私有仓库和写入需配置 GitHub MCP"), action: "github" },
    { ...publicChannel("bilibili", "哔哩哔哩", "公开视频搜索；字幕和账号操作使用 OpenCLI", "B站公开 API", ["qone_bilibili_search", "qone_opencli_run"], "公开视频搜索可用；字幕和账号功能需连接 Chrome"), action: "bilibili" },
    ...OPENCLI_SITES.map((id) => openCliChannel(id, ({ twitter: "X / Twitter", reddit: "Reddit", facebook: "Facebook", instagram: "Instagram", xiaohongshu: "小红书" } as Record<string, string>)[id]!, "通过网站适配器读取或操作账号")),
    { id: "xueqiu", name: "雪球", description: "股票行情、搜索与热门股票", backend: "OpenCLI / 雪球 API", tools: ["qone_opencli_discover", "qone_opencli_run", "qone_xueqiu"], state: context.hasXueqiuCookie || context.browserConnected ? "unverified" : "needs-connection", detail: context.hasXueqiuCookie ? "Cookie 已配置，实际有效性需请求时验证" : "可连接 Chrome 复用登录态，也可粘贴 Cookie 用雪球 API", action: "xueqiu" },
    openCliChannel("boss", "Boss 直聘", "职位搜索、岗位详情与招聘操作"),
    {
      id: "youtube", name: "YouTube", description: "搜索视频与读取视频元数据", backend: "yt-dlp",
      tools: ytDlpExecutable() ? ["qone_youtube", "qone_opencli_run"] : ["qone_opencli_discover", "qone_opencli_run"], state: ytDlpExecutable() ? "available" : "unverified",
      detail: ytDlpExecutable() ? "yt-dlp 可用；字幕失败时可尝试 OpenCLI" : "yt-dlp 未找到；可尝试 OpenCLI 的 YouTube 适配器", action: "youtube",
    },
    {
      id: "exa_search", name: "Exa 搜索", description: "全网语义搜索", backend: "Exa MCP",
      tools: context.mcpConnected("mcp-reach-exa") ? ["MCP: Exa"] : [],
      state: context.mcpConnected("mcp-reach-exa") ? "available" : "needs-connection",
      detail: context.mcpConnected("mcp-reach-exa") ? undefined : "点击卡片连接 Exa MCP", action: "exa",
    },
    {
      id: "linkedin", name: "LinkedIn", description: "公开页面与账号操作", backend: "OpenCLI / Jina Reader",
      tools: ["qone_web_read", "qone_opencli_discover", "qone_opencli_run"], state: context.browserConnected ? "unverified" : "needs-connection", detail: "账号功能经 OpenCLI 复用 Chrome 登录态；公开页面可尝试网页阅读", action: "opencli",
    },
    {
      id: "xiaoyuzhou", name: "小宇宙", description: "播客、单集、字幕与音频转写", backend: "OpenCLI / Groq Whisper",
      tools: ["qone_opencli_discover", "qone_opencli_run", "qone_podcast_transcribe"], state: context.podcastConfigured ? "unverified" : "needs-connection", detail: context.podcastConfigured ? (context.hasGroqKey ? "令牌和 Groq Key 已配置，实际有效性需请求验证；音频上限 25 MB" : "令牌已配置；无字幕音频转写还需 Groq API Key") : "点击卡片配置小宇宙 access_token 和 refresh_token", action: "podcast",
    },
  ];
  return channels;
}
