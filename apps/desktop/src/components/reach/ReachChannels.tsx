import { useEffect, useState } from "react";
import { Link2, Radio, Search } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { ReachChannelInfo } from "@qone/protocol";
import { hasTauriBridge, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

const EXA_CONFIG = { id: "mcp-reach-exa", name: "Exa", url: "https://mcp.exa.ai/mcp" };
const XUEQIU_SECRET = "reach.xueqiu.cookie";
const GROQ_SECRET = "reach.groq.apiKey";
const GITHUB_CLIENT_ID = import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";

function status(channel: ReachChannelInfo, browserConnected: boolean, exaConnected: boolean) {
  if (channel.id === "exa_search" && exaConnected) return { text: "已连接", className: "is-available" };
  if (channel.action === "opencli" && browserConnected) return { text: "登录态待验证", className: "is-unverified" };
  switch (channel.state) {
    case "available": return { text: "可直接使用", className: "is-available" };
    case "unverified": return { text: "部分可用", className: "is-unverified" };
    case "needs-connection": return { text: "需要连接", className: "is-pending" };
    default: return { text: "尚不可用", className: "is-unavailable" };
  }
}

export function ReachChannels() {
  const channels = useStore((state) => state.reachChannels);
  const browserConnected = useStore((state) => Boolean(state.browserStatus?.targetConnected));
  const exaConnected = useStore((state) => Boolean(state.mcpServers.find((server) => server.id === EXA_CONFIG.id)?.connected));
  const githubConnected = useStore((state) => Boolean(state.mcpServers.find((server) => server.id === "mcp-github")?.connected));
  const githubDeviceAuthorization = useStore((state) => state.githubDeviceAuthorization);
  const connected = useStore((state) => state.connected);
  const send = useStore((state) => state.send);
  const [selected, setSelected] = useState<ReachChannelInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [cookie, setCookie] = useState("");
  const [podcastAccessToken, setPodcastAccessToken] = useState("");
  const [podcastRefreshToken, setPodcastRefreshToken] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [groqConfigured, setGroqConfigured] = useState(false);
  const [githubClientId, setGithubClientId] = useState(GITHUB_CLIENT_ID);

  useEffect(() => {
    if (connected) void send({ type: "reach.channels", requestId: crypto.randomUUID() });
  }, [connected, send]);

  useEffect(() => {
    setSelected((current) => current ? channels.find((channel) => channel.id === current.id) ?? current : undefined);
  }, [channels]);

  useEffect(() => {
    if (!connected || !hasTauriBridge()) return;
    void invoke<string | null>("secret_get", { key: XUEQIU_SECRET }).then(async (value) => {
      if (value) await send({ type: "secret.set", requestId: crypto.randomUUID(), key: XUEQIU_SECRET, value });
    }).catch((reason) => setError(`雪球凭据恢复失败：${String(reason)}`));
    void invoke<string | null>("secret_get", { key: GROQ_SECRET }).then(async (value) => {
      if (value) {
        setGroqConfigured(true);
        await send({ type: "secret.set", requestId: crypto.randomUUID(), key: GROQ_SECRET, value });
      }
    }).catch((reason) => setError(`Groq 凭据恢复失败：${String(reason)}`));
  }, [connected, send]);

  async function configure(channel: ReachChannelInfo) {
    setBusy(true);
    setError(undefined);
    try {
      if (channel.action === "opencli" || channel.action === "bilibili") {
        if (!await send({ type: "browser.connect", requestId: crypto.randomUUID() })) throw new Error("浏览器连接请求失败");
      } else if (channel.action === "exa") {
        if (!await send({ type: "permission.set", requestId: crypto.randomUUID(), subjectId: `mcp:${EXA_CONFIG.id}`, permission: "mcp.connect", decision: "allow" })) throw new Error("无法设置连接权限");
        if (!await send({ type: "mcp.connect", requestId: crypto.randomUUID(), config: EXA_CONFIG })) throw new Error("Exa 连接请求失败");
      } else if (channel.action === "xueqiu") {
        const value = cookie.trim();
        if (!value || value.length > 8192 || /[\r\n]/.test(value)) throw new Error("请输入有效的 Cookie");
        await invoke("secret_set", { key: XUEQIU_SECRET, value });
        if (!await send({ type: "secret.set", requestId: crypto.randomUUID(), key: XUEQIU_SECRET, value })) throw new Error("无法将 Cookie 发送到运行时");
        setCookie("");
      } else if (channel.action === "podcast") {
        if (podcastAccessToken.trim().length < 8 || podcastRefreshToken.trim().length < 8) throw new Error("请输入有效的小宇宙访问令牌和刷新令牌");
        if (!await send({ type: "reach.podcast.configure", requestId: crypto.randomUUID(), accessToken: podcastAccessToken.trim(), refreshToken: podcastRefreshToken.trim() })) throw new Error("小宇宙令牌保存失败");
        setPodcastAccessToken("");
        setPodcastRefreshToken("");
      } else if (channel.action === "github") {
        const clientId = githubClientId.trim();
        if (!clientId) throw new Error("请输入 GitHub OAuth Client ID");
        if (!await send({ type: "permission.set", requestId: crypto.randomUUID(), subjectId: "mcp:mcp-github", permission: "mcp.connect", decision: "allow" })) throw new Error("无法设置 GitHub 连接权限");
        if (!await send({ type: "mcp.connect", requestId: crypto.randomUUID(), config: { id: "mcp-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authMode: "github-device", oauthClientId: clientId } })) throw new Error("GitHub MCP 连接请求失败");
      }
      await send({ type: "reach.channels", requestId: crypto.randomUUID() });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeXueqiuCookie() {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("secret_delete", { key: XUEQIU_SECRET });
      if (!await send({ type: "secret.delete", requestId: crypto.randomUUID(), key: XUEQIU_SECRET })) throw new Error("无法通知运行时删除 Cookie");
      setCookie("");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function saveGroqKey() {
    const value = groqKey.trim();
    if (!value || value.length > 8192 || /[\r\n]/.test(value)) { setError("请输入有效的 Groq API Key"); return; }
    setBusy(true);
    setError(undefined);
    try {
      await invoke("secret_set", { key: GROQ_SECRET, value });
      if (!await send({ type: "secret.set", requestId: crypto.randomUUID(), key: GROQ_SECRET, value })) throw new Error("无法将 Groq Key 发送到运行时");
      setGroqConfigured(true);
      setGroqKey("");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  function closeDialog() {
    setSelected(undefined);
    setCookie(""); setPodcastAccessToken(""); setPodcastRefreshToken(""); setGroqKey("");
  }

  if (!channels.length) return <p className="muted-copy">{connected ? "正在读取渠道…" : "连接运行时后显示渠道"}</p>;
  return <section className="reach-section" aria-label="网站与搜索渠道">
    <div className="reach-heading"><div><h2>网站与搜索渠道</h2><p>公开数据直接读取；账号渠道使用你现有的登录态。</p></div><span>{channels.length} 个渠道</span></div>
    <div className="apps-grid reach-grid">
      {channels.map((channel) => {
        const availability = status(channel, browserConnected, exaConnected);
        return <button key={channel.id} type="button" className="apps-app-card reach-card" onClick={() => { setError(undefined); setSelected(channel); }}>
          <span className="reach-card-icon" aria-hidden="true">{channel.id === "exa_search" ? <Search size={20} /> : <Radio size={20} />}</span>
          <strong>{channel.name}</strong>
          <small className={`reach-card-state ${availability.className}`}>{availability.text}</small>
          <span className="reach-card-desc">{channel.description}</span>
          <small className="reach-card-backend">{channel.backend}</small>
        </button>;
      })}
    </div>
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) closeDialog(); }}>
      <DialogContent className="reach-dialog">
        <DialogHeader>
          <DialogTitle>{selected?.name}</DialogTitle>
          <DialogDescription>{selected?.description}</DialogDescription>
        </DialogHeader>
        {selected && <div className="reach-dialog-body">
          <p><strong>后端：</strong>{selected.backend}</p>
          <p><strong>状态：</strong>{status(selected, browserConnected, exaConnected).text}</p>
          {selected.detail && <p>{selected.detail}</p>}
          {selected.tools.length > 0 && <p><strong>AI 工具：</strong>{selected.tools.join("、")}</p>}
          {selected.action === "xueqiu" && <label className="reach-secret-field">雪球 Cookie
            <input type="password" value={cookie} onChange={(event) => setCookie(event.target.value)} autoComplete="off" placeholder="从你已登录的雪球浏览器会话复制" />
          </label>}
          {selected.action === "podcast" && <>
            <label className="reach-secret-field">access_token<input type="password" value={podcastAccessToken} onChange={(event) => setPodcastAccessToken(event.target.value)} autoComplete="off" /></label>
            <label className="reach-secret-field">refresh_token<input type="password" value={podcastRefreshToken} onChange={(event) => setPodcastRefreshToken(event.target.value)} autoComplete="off" /></label>
            <label className="reach-secret-field">Groq API Key<input type="password" value={groqKey} onChange={(event) => setGroqKey(event.target.value)} autoComplete="off" placeholder={groqConfigured ? "已配置，可输入新 Key 更新" : "无字幕音频转写时填写"} /></label>
            <p>小宇宙令牌写入本机 OpenCLI 配置文件供后端刷新；Groq Key 保存在 Windows 凭据管理器。音频转写上限 25 MB。</p>
          </>}
          {selected.action === "github" && <>
            <p>公开仓库无需配置。私有仓库和账号操作可连接 GitHub MCP。</p>
            {githubConnected ? <p>GitHub MCP 已连接。</p> : <label className="reach-secret-field">GitHub OAuth Client ID
              <input value={githubClientId} onChange={(event) => setGithubClientId(event.target.value)} autoComplete="off" placeholder="填入 GitHub OAuth 应用的 Client ID" />
            </label>}
            {githubDeviceAuthorization?.serverId === "mcp-github" && <p>在 GitHub 授权页输入代码：<strong>{githubDeviceAuthorization.userCode}</strong></p>}
          </>}
          {error && <p className="browser-integration-error" role="alert">{error}</p>}
        </div>}
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>关闭</Button>
          {selected?.action === "opencli" && <Button disabled={busy || !connected} onClick={() => void configure(selected)}><Link2 size={14} />连接 Chrome</Button>}
          {selected?.action === "bilibili" && !browserConnected && <Button disabled={busy || !connected} onClick={() => void configure(selected)}><Link2 size={14} />连接 Chrome 获取字幕</Button>}
          {selected?.action === "xueqiu" && !browserConnected && <Button variant="outline" disabled={busy || !connected} onClick={() => void configure({ ...selected, action: "opencli" })}><Link2 size={14} />连接 Chrome</Button>}
          {selected?.action === "exa" && !exaConnected && <Button disabled={busy || !connected} onClick={() => void configure(selected)}><Link2 size={14} />连接 Exa</Button>}
          {selected?.action === "xueqiu" && selected.state === "unverified" && <Button variant="outline" disabled={busy} onClick={() => void removeXueqiuCookie()}>删除 Cookie</Button>}
          {selected?.action === "xueqiu" && <Button disabled={busy || !connected || !cookie.trim()} onClick={() => void configure(selected)}>保存 Cookie</Button>}
          {selected?.action === "podcast" && <Button disabled={busy || !connected || !podcastAccessToken.trim() || !podcastRefreshToken.trim()} onClick={() => void configure(selected)}>保存令牌</Button>}
          {selected?.action === "podcast" && <Button disabled={busy || !connected || !groqKey.trim()} onClick={() => void saveGroqKey()}>保存 Groq Key</Button>}
          {selected?.action === "github" && !githubConnected && <Button disabled={busy || !connected || !githubClientId.trim()} onClick={() => void configure(selected)}>连接 GitHub MCP</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
