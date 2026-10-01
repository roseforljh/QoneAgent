import { localizeError } from "../../lib/error-localization";
import { useLocale } from "../../localization";
import { localizeReachChannel } from "../../lib/reach-channel-localization";
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

function status(channel: ReachChannelInfo, browserConnected: boolean, exaConnected: boolean, t: ReturnType<typeof useLocale>["t"]) {
  if (channel.id === "exa_search" && exaConnected) return { text: t("reach.connected"), className: "is-available" };
  if (channel.action === "opencli" && browserConnected) return { text: t("reach.sessionUnverified"), className: "is-unverified" };
  switch (channel.state) {
    case "available": return { text: t("reach.available"), className: "is-available" };
    case "unverified": return { text: t("reach.unverified"), className: "is-unverified" };
    case "needs-connection": return { text: t("reach.needsConnection"), className: "is-pending" };
    default: return { text: t("reach.unavailable"), className: "is-unavailable" };
  }
}

export function ReachChannels() {
  const { t, locale } = useLocale();
  const display = (channel: ReachChannelInfo) => localizeReachChannel(channel, locale);
  const channels = useStore((state) => state.reachChannels);
  const browserConnected = useStore((state) => Boolean(state.browserStatus?.targetConnected));
  const exaConnected = useStore((state) => Boolean(state.mcpServers.find((server) => server.id === EXA_CONFIG.id)?.connected));
  const githubConnected = useStore((state) => Boolean(state.mcpServers.find((server) => server.id === "mcp-github")?.connected));
  const githubDeviceAuthorization = useStore((state) => state.githubDeviceAuthorization);
  const connected = useStore((state) => state.connected);
  const send = useStore((state) => state.send);
  const [selectedSource, setSelected] = useState<ReachChannelInfo>();
  const selected = selectedSource && display(selectedSource);
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
    }).catch((reason) => setError(t("reach.xueqiuRestoreFailed", { error: localizeError(reason) })));
    void invoke<string | null>("secret_get", { key: GROQ_SECRET }).then(async (value) => {
      if (value) {
        setGroqConfigured(true);
        await send({ type: "secret.set", requestId: crypto.randomUUID(), key: GROQ_SECRET, value });
      }
    }).catch((reason) => setError(t("reach.groqRestoreFailed", { error: localizeError(reason) })));
  }, [connected, send]);

  async function configure(channel: ReachChannelInfo) {
    setBusy(true);
    setError(undefined);
    try {
      if (channel.action === "opencli" || channel.action === "bilibili") {
        if (!await send({ type: "browser.connect", requestId: crypto.randomUUID() })) throw new Error(t("reach.browserConnectFailed"));
      } else if (channel.action === "exa") {
        if (!await send({ type: "permission.set", requestId: crypto.randomUUID(), subjectId: `mcp:${EXA_CONFIG.id}`, permission: "mcp.connect", decision: "allow" })) throw new Error(t("reach.permissionFailed"));
        if (!await send({ type: "mcp.connect", requestId: crypto.randomUUID(), config: EXA_CONFIG })) throw new Error(t("reach.exaConnectFailed"));
      } else if (channel.action === "xueqiu") {
        const value = cookie.trim();
        if (!value || value.length > 8192 || /[\r\n]/.test(value)) throw new Error(t("reach.invalidCookie"));
        await invoke("secret_set", { key: XUEQIU_SECRET, value });
        if (!await send({ type: "secret.set", requestId: crypto.randomUUID(), key: XUEQIU_SECRET, value })) throw new Error(t("reach.cookieSendFailed"));
        setCookie("");
      } else if (channel.action === "podcast") {
        if (podcastAccessToken.trim().length < 8 || podcastRefreshToken.trim().length < 8) throw new Error(t("reach.invalidPodcastTokens"));
        if (!await send({ type: "reach.podcast.configure", requestId: crypto.randomUUID(), accessToken: podcastAccessToken.trim(), refreshToken: podcastRefreshToken.trim() })) throw new Error(t("reach.podcastSaveFailed"));
        setPodcastAccessToken("");
        setPodcastRefreshToken("");
      } else if (channel.action === "github") {
        const clientId = githubClientId.trim();
        if (!clientId) throw new Error(t("reach.githubClientRequired"));
        if (!await send({ type: "permission.set", requestId: crypto.randomUUID(), subjectId: "mcp:mcp-github", permission: "mcp.connect", decision: "allow" })) throw new Error(t("reach.githubPermissionFailed"));
        if (!await send({ type: "mcp.connect", requestId: crypto.randomUUID(), config: { id: "mcp-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authMode: "github-device", oauthClientId: clientId } })) throw new Error(t("reach.githubConnectFailed"));
      }
      await send({ type: "reach.channels", requestId: crypto.randomUUID() });
    } catch (reason) {
      setError(localizeError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeXueqiuCookie() {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("secret_delete", { key: XUEQIU_SECRET });
      if (!await send({ type: "secret.delete", requestId: crypto.randomUUID(), key: XUEQIU_SECRET })) throw new Error(t("reach.cookieDeleteFailed"));
      setCookie("");
    } catch (reason) { setError(localizeError(reason)); }
    finally { setBusy(false); }
  }

  async function saveGroqKey() {
    const value = groqKey.trim();
    if (!value || value.length > 8192 || /[\r\n]/.test(value)) { setError(t("reach.invalidGroqKey")); return; }
    setBusy(true);
    setError(undefined);
    try {
      await invoke("secret_set", { key: GROQ_SECRET, value });
      if (!await send({ type: "secret.set", requestId: crypto.randomUUID(), key: GROQ_SECRET, value })) throw new Error(t("reach.groqSendFailed"));
      setGroqConfigured(true);
      setGroqKey("");
    } catch (reason) { setError(localizeError(reason)); }
    finally { setBusy(false); }
  }

  function closeDialog() {
    setSelected(undefined);
    setCookie(""); setPodcastAccessToken(""); setPodcastRefreshToken(""); setGroqKey("");
  }

  if (!channels.length) return <p className="muted-copy">{connected ? t("reach.loading") : t("reach.connectRuntime")}</p>;
  return <section className="reach-section" aria-label={t("reach.title")}>
    <div className="reach-heading"><div><h2>{t("reach.title")}</h2><p>{t("reach.description")}</p></div><span>{t("reach.count", { count: channels.length })}</span></div>
    <div className="apps-grid reach-grid">
      {channels.map((item) => {
        const channel = display(item);
        const availability = status(channel, browserConnected, exaConnected, t);
        return <button key={channel.id} type="button" className="apps-app-card reach-card" onClick={() => { setError(undefined); setSelected(item); }}>
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
          <p><strong>{t("reach.backend")}</strong>{selected.backend}</p>
          <p><strong>{t("reach.state")}</strong>{status(selected, browserConnected, exaConnected, t).text}</p>
          {selected.detail && <p>{selected.detail}</p>}
          {selected.tools.length > 0 && <p><strong>{t("reach.tools")}</strong>{selected.tools.join(locale === "en" ? ", " : "、")}</p>}
          {selected.action === "xueqiu" && <label className="reach-secret-field">{t("reach.xueqiuCookie")}
            <input type="password" value={cookie} onChange={(event) => setCookie(event.target.value)} autoComplete="off" placeholder={t("reach.cookiePlaceholder")} />
          </label>}
          {selected.action === "podcast" && <>
            <label className="reach-secret-field">access_token<input type="password" value={podcastAccessToken} onChange={(event) => setPodcastAccessToken(event.target.value)} autoComplete="off" /></label>
            <label className="reach-secret-field">refresh_token<input type="password" value={podcastRefreshToken} onChange={(event) => setPodcastRefreshToken(event.target.value)} autoComplete="off" /></label>
            <label className="reach-secret-field">Groq API Key<input type="password" value={groqKey} onChange={(event) => setGroqKey(event.target.value)} autoComplete="off" placeholder={groqConfigured ? t("reach.groqConfigured") : t("reach.groqPlaceholder")} /></label>
            <p>{t("reach.podcastHint")}</p>
          </>}
          {selected.action === "github" && <>
            <p>{t("reach.githubHint")}</p>
            {githubConnected ? <p>{t("reach.githubConnected")}</p> : <label className="reach-secret-field">GitHub OAuth Client ID
              <input value={githubClientId} onChange={(event) => setGithubClientId(event.target.value)} autoComplete="off" placeholder={t("reach.githubClientPlaceholder")} />
            </label>}
            {githubDeviceAuthorization?.serverId === "mcp-github" && <p>{t("reach.githubCode")}<strong>{githubDeviceAuthorization.userCode}</strong></p>}
          </>}
          {error && <p className="browser-integration-error" role="alert">{error}</p>}
        </div>}
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>{t("reach.close")}</Button>
          {selected?.action === "opencli" && <Button disabled={busy || !connected} onClick={() => void configure(selected)}><Link2 size={14} />{t("reach.connectChrome")}</Button>}
          {selected?.action === "bilibili" && !browserConnected && <Button disabled={busy || !connected} onClick={() => void configure(selected)}><Link2 size={14} />{t("reach.connectChromeSubtitles")}</Button>}
          {selected?.action === "xueqiu" && !browserConnected && <Button variant="outline" disabled={busy || !connected} onClick={() => void configure({ ...selected, action: "opencli" })}><Link2 size={14} />{t("reach.connectChrome")}</Button>}
          {selected?.action === "exa" && !exaConnected && <Button disabled={busy || !connected} onClick={() => void configure(selected)}><Link2 size={14} />{t("reach.connectExa")}</Button>}
          {selected?.action === "xueqiu" && selected.state === "unverified" && <Button variant="outline" disabled={busy} onClick={() => void removeXueqiuCookie()}>{t("reach.deleteCookie")}</Button>}
          {selected?.action === "xueqiu" && <Button disabled={busy || !connected || !cookie.trim()} onClick={() => void configure(selected)}>{t("reach.saveCookie")}</Button>}
          {selected?.action === "podcast" && <Button disabled={busy || !connected || !podcastAccessToken.trim() || !podcastRefreshToken.trim()} onClick={() => void configure(selected)}>{t("reach.saveTokens")}</Button>}
          {selected?.action === "podcast" && <Button disabled={busy || !connected || !groqKey.trim()} onClick={() => void saveGroqKey()}>{t("reach.saveGroqKey")}</Button>}
          {selected?.action === "github" && !githubConnected && <Button disabled={busy || !connected || !githubClientId.trim()} onClick={() => void configure(selected)}>{t("reach.connectGithub")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
