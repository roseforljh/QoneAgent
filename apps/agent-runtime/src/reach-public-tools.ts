import { runtimeText, runtimeError } from "./runtime-localization";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { XMLParser } from "fast-xml-parser";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { siteForAppId } from "@qone/protocol";

const MAX_BYTES = 2_000_000;
const TEXT_LIMIT = 80_000;
const USER_AGENT = "QoneAgent/0.1 (public web reader)";
const BILIBILI_HOME_URL = siteForAppId("bilibili")!.homeUrl;
const XUEQIU_HOME_URL = siteForAppId("xueqiu")!.homeUrl;

function publicUrl(input: string): URL {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !host.includes(".") ||
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host) !== 0) {
    throw runtimeError("reach-public-tools.only_public_website_http_s_urls_are_allowed", {});
  }
  return url;
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80") || normalized.startsWith("::ffff:")) return true;
  const [a, b] = address.split(".").map(Number);
  return isIP(address) === 4 && (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224);
}

async function requirePublicResolution(url: URL): Promise<void> {
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw runtimeError("reach-public-tools.the_website_resolved_to_a_private_network_address", {});
}

async function boundedFetch(url: URL, headers: Record<string, string> = {}): Promise<string> {
  let current = url;
  const carriesCredentials = Object.keys(headers).some((name) => /^(authorization|cookie|proxy-authorization)$/i.test(name));
  for (let redirects = 0; redirects < 4; redirects++) {
    await requirePublicResolution(current);
    const response = await fetch(current, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, application/xml, text/xml, text/plain, */*", ...headers },
      signal: AbortSignal.timeout(20_000), redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw runtimeError("reach-public-tools.the_website_redirect_has_no_target_url", {});
      const next = publicUrl(new URL(location, current).href);
      if (carriesCredentials && next.origin !== current.origin) throw runtimeError("reach-public-tools.requests_carrying_credentials_cannot_redirect_to_another_origin", {});
      current = next;
      continue;
    }
    if (!response.ok) throw runtimeError("reach-public-tools.website_request_failed_http", { p0: response.status });
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw runtimeError("reach-public-tools.website_response_is_too_large", {});
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw runtimeError("reach-public-tools.website_response_is_too_large", {});
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  throw runtimeError("reach-public-tools.too_many_website_redirects", {});
}

function output(value: unknown) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: body.length > TEXT_LIMIT ? runtimeText("reach-public-tools.result_truncated", { p0: body.slice(0, TEXT_LIMIT) }) : body }], details: undefined };
}

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return String((value as Record<string, unknown>)["#text"] ?? "");
  return "";
}

export function parseFeed(xml: string, limit = 20): { title: string; url: string; published?: string; summary?: string }[] {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", processEntities: true }).parse(xml) as Record<string, any>;
  const root = parsed.rss?.channel ?? parsed.feed ?? parsed["rdf:RDF"];
  if (!root) throw runtimeError("reach-public-tools.this_is_not_a_valid_rss_or_atom_feed", {});
  return list(root.item ?? root.entry).slice(0, Math.max(1, Math.min(limit, 50))).map((item: any) => {
    const link = typeof item.link === "string" ? item.link : list(item.link).find((entry: any) => entry?.["@rel"] === "alternate") ?? list(item.link)[0];
    return {
      title: textValue(item.title),
      url: typeof link === "string" ? link : String(link?.["@href"] ?? ""),
      published: textValue(item.pubDate ?? item.published ?? item.updated) || undefined,
      summary: textValue(item.description ?? item.summary ?? item["content:encoded"]).slice(0, 600) || undefined,
    };
  });
}

async function runCli(command: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    let size = 0;
    const collect = (chunk: Buffer) => { size += chunk.byteLength; if (size <= MAX_BYTES) chunks.push(chunk.toString()); else child.kill(); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { child.kill(); reject(runtimeError("reach-public-tools.tool_execution_timed_out", {})); }, timeout);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const body = chunks.join("").trim();
      if (size > MAX_BYTES) reject(runtimeError("reach-public-tools.tool_output_is_too_large", {}));
      else if (code === 0) resolve(body);
      else reject(new Error(body || runtimeText("reach-public-tools.tool_exit_code", { p0: code })));
    });
  });
}

export function createReachPublicTools(options: { ytDlp: () => string | undefined; githubToken?: () => string | undefined; xueqiuCookie?: () => string | undefined }): ToolDefinition[] {
  const tools = [
    {
      name: "qone_rss_read", label: "RSS · read", description: "Read public RSS or Atom feed items without login.",
      parameters: Type.Object({ url: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, { url, limit }: { url: string; limit?: number }) => output(parseFeed(await boundedFetch(publicUrl(url)), limit)),
    },
    {
      name: "qone_v2ex", label: "V2EX · public API", description: "Read V2EX hot/latest topics, a node, a topic, or its replies through the public API.",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("hot"), Type.Literal("latest"), Type.Literal("node"), Type.Literal("topic"), Type.Literal("replies")]), value: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, { kind, value, limit }: { kind: string; value?: string; limit?: number }) => {
        if (["node", "topic", "replies"].includes(kind) && !value) throw runtimeError("reach-public-tools.a_node_name_or_topic_id_is_required", {});
        const endpoints: Record<string, string> = {
          hot: "/api/topics/hot.json", latest: "/api/topics/latest.json",
          node: `/api/topics/show.json?node_name=${encodeURIComponent(value ?? "")}`,
          topic: `/api/topics/show.json?id=${encodeURIComponent(value ?? "")}`,
          replies: `/api/replies/show.json?topic_id=${encodeURIComponent(value ?? "")}`,
        };
        const data = JSON.parse(await boundedFetch(new URL(endpoints[kind]!, "https://www.v2ex.com"))) as unknown;
        return output(Array.isArray(data) ? data.slice(0, limit ?? 20) : data);
      },
    },
    {
      name: "qone_github_public", label: "GitHub · public API", description: "Read structured public GitHub API data such as repositories, issues, users, or repository search without requiring gh login. Use GitHub MCP only for authenticated or account operations.",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("repo"), Type.Literal("issues"), Type.Literal("user"), Type.Literal("search")]), value: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, { kind, value, limit }: { kind: string; value: string; limit?: number }) => {
        const slug = value.trim();
        if (kind !== "search" && !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(slug)) throw runtimeError("reach-public-tools.invalid_github_repository_or_username", {});
        if (["repo", "issues"].includes(kind) && slug.split("/").length !== 2) throw runtimeError("reach-public-tools.enter_owner_repo", {});
        const routes: Record<string, string> = {
          repo: `/repos/${slug}`, issues: `/repos/${slug}/issues?per_page=${limit ?? 20}`,
          user: `/users/${slug}`, search: `/search/repositories?q=${encodeURIComponent(slug)}&per_page=${limit ?? 20}`,
        };
        const token = options.githubToken?.();
        const data = JSON.parse(await boundedFetch(new URL(routes[kind]!, "https://api.github.com"), {
          Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
        })) as unknown;
        return output(data);
      },
    },
    {
      name: "qone_bilibili_search", label: "Bilibili · search", description: "Search public Bilibili videos using the built-in public search API. For account pages, posts, comments, or other site operations use qone_opencli_discover followed by qone_opencli_run. For a result's metadata use qone_app_inspect; for subtitles, video parsing, or summaries use qone_video_download and qone_video_use_file.",
      parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
      execute: async (_id, { query, limit }: { query: string; limit?: number }) => {
        const url = new URL("https://api.bilibili.com/x/web-interface/search/all/v2");
        url.searchParams.set("keyword", query); url.searchParams.set("page", "1");
        const data = JSON.parse(await boundedFetch(url, { Referer: BILIBILI_HOME_URL })) as { code?: number; message?: string; data?: { result?: { data?: unknown[] }[] } };
        if (data.code !== 0) throw runtimeError("reach-public-tools.bilibili_search_failed", { p0: data.message ?? data.code });
        return output((data.data?.result ?? []).flatMap((group) => group.data ?? []).slice(0, limit ?? 10));
      },
    },
    {
      name: "qone_xueqiu", label: runtimeText("reach-public-tools.xueqiu_api"), description: "Read Xueqiu stock quotes, stock search, or hot stocks through its API. Requires a Cookie configured in the application card.",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("quote"), Type.Literal("search"), Type.Literal("hot")]), value: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, { kind, value, limit }: { kind: string; value?: string; limit?: number }) => {
        const cookie = options.xueqiuCookie?.();
        if (!cookie) throw runtimeError("reach-public-tools.configure_a_cookie_in_the_xueqiu_card_on_the", {});
        if (kind !== "hot" && !value?.trim()) throw runtimeError("reach-public-tools.enter_a_stock_symbol_or_search_term", {});
        if (kind === "quote" && !/^[A-Z0-9.]{2,20}$/i.test(value!)) throw runtimeError("reach-public-tools.invalid_stock_symbol_format", {});
        const route = kind === "quote"
          ? `https://stock.xueqiu.com/v5/stock/quote.json?symbol=${encodeURIComponent(value!)}&extend=detail`
          : kind === "search"
            ? `${XUEQIU_HOME_URL}stock/search.json?code=${encodeURIComponent(value!)}&size=${limit ?? 10}`
            : `https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=${limit ?? 10}&type=10`;
        const data = JSON.parse(await boundedFetch(new URL(route), { Cookie: cookie, Referer: XUEQIU_HOME_URL })) as unknown;
        return output(data);
      },
    },
    {
      name: "qone_youtube_search", label: "YouTube · search", description: "Search YouTube by keyword only. For a known video URL, use qone_app_inspect; for downloading, use qone_app_download.",
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
      execute: async (_id, { query, limit }: { query: string; limit?: number }) => {
        const executable = options.ytDlp();
        if (!executable) throw runtimeError("reach-public-tools.yt_dlp_is_unavailable_check_the_youtube_backend_status", {});
        const target = `ytsearch${limit ?? 5}:${query.trim()}`;
        return output(await runCli(executable, ["--flat-playlist", "--dump-single-json", "--skip-download", target], 90_000));
      },
    },
  ] as ToolDefinition[];
  return options.ytDlp() ? tools : tools.filter((tool) => tool.name !== "qone_youtube_search");
}
