import { existsSync } from "node:fs";
import path from "node:path";
import { findSite, SITE_CONFIG, type ReachChannelInfo } from "@qone/protocol";
import { reachChannelEnglish, type ReachChannelId } from "./reach-channel-copy.js";

const openCliSiteIds = SITE_CONFIG.filter((site) => site.reachMode === "opencli").map((site) => site.id as ReachChannelId);

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

export function ffmpegExecutable(): string | undefined {
  const configured = process.env.QONE_FFMPEG;
  return configured && existsSync(configured) ? configured : executable("ffmpeg");
}

export function biliExecutable(): string | undefined {
  const configured = process.env.QONE_BILI_CLI;
  return configured && existsSync(configured) ? configured : executable("bili");
}

export function biliLaunch(): { command: string; prefix: string[] } | undefined {
  const installed = biliExecutable();
  if (installed) return { command: installed, prefix: [] };
  const uvx = executable("uvx");
  return uvx ? { command: uvx, prefix: ["--quiet", "--from", "bilibili-cli[audio]==0.6.2", "bili"] } : undefined;
}

interface ChannelContext { browserConnected: boolean; mcpConnected: (id: string) => boolean; podcastConfigured?: boolean; hasGroqKey?: boolean }

export function listReachChannels(context: ChannelContext): ReachChannelInfo[] {
  const publicChannel = (id: ReachChannelId, name: string, description: string, backend: string, tools: string[], detail?: string): ReachChannelInfo =>
    ({ id, name, description, backend, tools, state: "available", detail, english: reachChannelEnglish[id] });
  const openCliChannel = (id: ReachChannelId, detail?: string): ReachChannelInfo => {
    const site = findSite(id);
    const name = site?.reachName ?? id;
    const description = site?.reachDescription ?? "通过网站适配器读取或操作账号";
    return ({
    id, name, description, backend: "OpenCLI", tools: ["qone_opencli_discover", "qone_opencli_run"],
    state: context.browserConnected ? "unverified" : "needs-connection",
    detail: context.browserConnected ? "内置浏览器已就绪；网站登录态和命令需执行时验证" : detail ?? "打开内置浏览器并在网站登录后使用",
    action: "opencli",
    loginUrl: findSite(id)?.loginUrl,
    english: { ...reachChannelEnglish[id], detail: context.browserConnected
      ? "Built-in browser ready; website sessions and commands will be verified when used."
      : "Open the built-in browser and sign in to the website to use this channel." },
  });
  };
  const channels: ReachChannelInfo[] = [
    publicChannel("rss", "RSS / Atom", "读取公开订阅源", "内置解析器", ["qone_rss_read"]),
    publicChannel("v2ex", "V2EX", "热门、最新、节点与回复", "V2EX 公开 API", ["qone_v2ex"]),
    { ...publicChannel("github", "GitHub", "公开仓库与搜索；账号操作可连接 GitHub MCP", "GitHub 公开 API", ["qone_github_public"], "公开功能可用；私有仓库和写入需配置 GitHub MCP"), action: "github" },
    { id: "tiktok", name: "TikTok", description: "读取和操作 TikTok 网站内容", backend: "OpenCLI", tools: ["qone_opencli_discover", "qone_opencli_run", "qone_app_inspect", "qone_app_download"], state: context.browserConnected ? "unverified" : "needs-connection", detail: context.browserConnected ? "内置浏览器已就绪，网站登录态由浏览器维护" : "打开内置浏览器并在 TikTok 登录", action: "opencli", loginUrl: findSite("tiktok")?.loginUrl, english: { ...reachChannelEnglish.tiktok, detail: context.browserConnected ? "Built-in browser ready; website sessions are maintained there." : "Open the built-in browser and sign in to TikTok." } },
    { id: "bilibili", name: "哔哩哔哩", description: "搜索、读取和操作 B 站内容；下载视频", backend: "OpenCLI / Qone 媒体工具", tools: ["qone_opencli_discover", "qone_opencli_run", "qone_app_inspect", "qone_app_list", "qone_app_download", "qone_video_download", "qone_video_use_file"], state: context.browserConnected ? "unverified" : "needs-connection", detail: context.browserConnected ? "网站操作使用内置浏览器；视频文件使用 Qone 媒体工具" : "打开内置浏览器并在 B 站登录；视频文件使用 Qone 媒体工具", action: "bilibili", loginUrl: findSite("bilibili")?.loginUrl, english: reachChannelEnglish.bilibili },
    ...openCliSiteIds.map((id) => openCliChannel(id)),
    { id: "xueqiu", name: "雪球", description: "股票行情、搜索与热门股票", backend: "OpenCLI", tools: ["qone_opencli_discover", "qone_opencli_run"], state: context.browserConnected ? "unverified" : "needs-connection", detail: context.browserConnected ? "内置浏览器已就绪；网站登录态和命令需执行时验证" : "打开内置浏览器并在雪球登录", action: "opencli", loginUrl: findSite("xueqiu")?.loginUrl, english: { ...reachChannelEnglish.xueqiu, backend: "OpenCLI", detail: context.browserConnected ? "Built-in browser ready; website sessions and commands will be verified when used." : "Open the built-in browser and sign in to Xueqiu." } },
    {
      id: "youtube", name: "YouTube", description: "搜索视频、读取元数据与下载", backend: "OpenCLI / Qone 媒体工具", loginUrl: findSite("youtube")?.loginUrl,
      tools: ytDlpExecutable() ? ["qone_opencli_discover", "qone_opencli_run", "qone_youtube_search", "qone_app_inspect", "qone_app_list", "qone_app_download"] : ["qone_opencli_discover", "qone_opencli_run"], state: context.browserConnected ? "unverified" : "needs-connection",
      detail: ytDlpExecutable() ? "网站操作使用内置浏览器 OpenCLI；视频文件使用 Qone 媒体工具" : "yt-dlp 未找到；网站操作仍可使用内置浏览器 OpenCLI",
      action: "youtube",
      english: { ...reachChannelEnglish.youtube, detail: ytDlpExecutable() ? "The built-in browser OpenCLI route is enabled; use qone_app_download for a known video URL and qone_youtube_search for keyword search." : "yt-dlp was not found; the built-in browser route is still available." },
    },
    {
      id: "exa_search", name: "Exa 搜索", description: "全网语义搜索", backend: "Exa MCP",
      tools: context.mcpConnected("mcp-reach-exa") ? ["MCP: Exa"] : [],
      state: context.mcpConnected("mcp-reach-exa") ? "available" : "needs-connection",
      detail: context.mcpConnected("mcp-reach-exa") ? undefined : "点击卡片连接 Exa MCP", action: "exa",
      english: { ...reachChannelEnglish.exa_search, detail: context.mcpConnected("mcp-reach-exa") ? undefined : "Select this card to connect Exa MCP." },
    },
    {
      id: "xiaoyuzhou", name: "小宇宙", description: "播客、单集、字幕与音频转写", backend: "OpenCLI / Groq Whisper",
      tools: ["qone_opencli_discover", "qone_opencli_run", "qone_podcast_transcribe"], state: context.podcastConfigured ? "unverified" : "needs-connection", detail: context.podcastConfigured ? (context.hasGroqKey ? "令牌和 Groq Key 已配置，实际有效性需请求验证；大音频会自动分段转写" : "令牌已配置；无字幕音频转写还需 Groq API Key") : "点击卡片配置小宇宙 access_token 和 refresh_token", action: "podcast",
      english: { ...reachChannelEnglish.xiaoyuzhou, detail: context.podcastConfigured ? (context.hasGroqKey ? "Tokens and Groq key configured; validity will be verified on request. Large audio files are split automatically." : "Tokens configured; a Groq API key is also required to transcribe audio without subtitles.") : "Select this card to configure Xiaoyuzhou access_token and refresh_token." },
    },
  ];
  return channels;
}
