import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useLocale } from "../../localization";
import { hasTauriBridge, useStore } from "../../store";
import { BrowserIntegration } from "../browser/BrowserIntegration";
import { DOWNLOAD_APPS, appCookieKey } from "./app-catalog";
import type { AuthCookie } from "./auth-types";

export function DownloaderApps() {
  const { locale, t } = useLocale();
  const navigate = useNavigate();
  const connected = useStore((state) => state.connected);
  const send = useStore((state) => state.send);
  const [cookieConfigured, setCookieConfigured] = useState<Set<string>>(new Set());
  const [authConfigured, setAuthConfigured] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!hasTauriBridge()) return;
    void Promise.all(DOWNLOAD_APPS.map(async (app) => {
      const file = await invoke<{ cookies?: AuthCookie[] } | null>("auth_file_get", { appId: app.id });
      return file?.cookies?.length ? app.id : undefined;
    })).then((ids) => setAuthConfigured(new Set(ids.filter((id): id is string => Boolean(id))))).catch((reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    if (!connected || !hasTauriBridge()) return;
    void Promise.all(DOWNLOAD_APPS.map(async (app) => {
      const key = appCookieKey(app.id);
      const value = await invoke<string | null>("secret_get", { key });
      if (!value) return undefined;
      await send({ type: "secret.set", requestId: crypto.randomUUID(), key, value });
      return app.id;
    })).then((ids) => setCookieConfigured(new Set(ids.filter((id): id is string => Boolean(id))))).catch((reason) => setError(String(reason)));
  }, [connected, send]);

  return <section className="downloader-apps" aria-label={locale === "en" ? "Download apps" : "下载应用"}>
    <div className="downloader-apps-heading">
      <div><h2>{locale === "en" ? "Download apps" : "下载应用"}</h2><p>{locale === "en" ? "Sign in locally and save the site session." : "在本机登录并保存网站登录态。"}</p></div>
      <span>{DOWNLOAD_APPS.length} {locale === "en" ? "apps" : "个应用"}</span>
    </div>
    <div className="downloader-app-grid">
      <BrowserIntegration />
      {DOWNLOAD_APPS.map((app) => {
        const configured = authConfigured.has(app.id) || cookieConfigured.has(app.id);
        return <button key={app.id} type="button" className="downloader-app-card" onClick={() => void navigate({ to: "/apps/$appId", params: { appId: app.id } })}>
          <span className={`downloader-app-mark is-${app.tone}`}><img src={app.icon} alt="" /></span>
          <strong>{app.name}</strong>
          <small className={configured ? "is-configured" : ""}>{configured ? t("reach.authConfigured") : (locale === "en" ? "Not signed in" : "未登录")}</small>
        </button>;
      })}
    </div>
    {error && <p className="browser-integration-error" role="alert">{error}</p>}
  </section>;
}
