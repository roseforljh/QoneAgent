import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink } from "lucide-react";
import { useLocale } from "../../localization";
import { hasTauriBridge, useStore } from "../../store";
import { BrowserIntegration } from "../browser/BrowserIntegration";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { DOWNLOAD_APPS, appCookieKey, TELEGRAM_API_HASH_KEY, TELEGRAM_API_ID_KEY } from "./app-catalog";
import type { AuthCookie } from "./auth-types";
import { AppStatusIndicator, type AppStatus } from "./AppStatusIndicator";

export function DownloaderApps() {
  const { locale } = useLocale();
  const navigate = useNavigate();
  const connected = useStore((state) => state.connected);
  const send = useStore((state) => state.send);
  const [cookieConfigured, setCookieConfigured] = useState<Set<string>>(new Set());
  const [authConfigured, setAuthConfigured] = useState<Set<string>>(new Set());
  const [failedApps, setFailedApps] = useState<Set<string>>(new Set());
  const [authLoading, setAuthLoading] = useState(true);
  const [cookieLoading, setCookieLoading] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState<string>();

  useEffect(() => {
    let active = true;
    if (!hasTauriBridge()) { setAuthLoading(false); return () => { active = false; }; }
    void Promise.allSettled(DOWNLOAD_APPS.map(async (app) => {
      if (app.id === "telegram") {
        const [id, hash] = await Promise.all([invoke<string | null>("secret_get", { key: TELEGRAM_API_ID_KEY }), invoke<string | null>("secret_get", { key: TELEGRAM_API_HASH_KEY })]);
        return id && hash ? app.id : undefined;
      }
      const file = await invoke<{ cookies?: AuthCookie[] } | null>("auth_file_get", { appId: app.id });
      return file?.cookies?.length ? app.id : undefined;
    })).then((results) => {
      if (!active) return;
      const configured = new Set<string>();
      const failed = new Set<string>();
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value) configured.add(result.value);
        if (result.status === "rejected") failed.add(DOWNLOAD_APPS[index].id);
      });
      setAuthConfigured(configured);
      setFailedApps(failed);
      setAuthLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    if (!connected || !hasTauriBridge()) { setCookieLoading(false); return () => { active = false; }; }
    setCookieLoading(true);
    void Promise.allSettled(DOWNLOAD_APPS.map(async (app) => {
      if (app.id === "telegram") {
        const [id, hash] = await Promise.all([invoke<string | null>("secret_get", { key: TELEGRAM_API_ID_KEY }), invoke<string | null>("secret_get", { key: TELEGRAM_API_HASH_KEY })]);
        return id && hash ? app.id : undefined;
      }
      const key = appCookieKey(app.id);
      const value = await invoke<string | null>("secret_get", { key });
      if (!value) return undefined;
      await send({ type: "secret.set", requestId: crypto.randomUUID(), key, value });
      return app.id;
    })).then((results) => {
      if (!active) return;
      const configured = new Set<string>();
      const failed = new Set<string>();
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value) configured.add(result.value);
        if (result.status === "rejected") failed.add(DOWNLOAD_APPS[index].id);
      });
      setCookieConfigured(configured);
      setFailedApps((current) => {
        const next = new Set(current);
        failed.forEach((id) => next.add(id));
        configured.forEach((id) => next.delete(id));
        return next;
      });
      setCookieLoading(false);
    });
    return () => { active = false; };
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
        const status: AppStatus = authLoading || cookieLoading ? "loading" : failedApps.has(app.id) ? "error" : configured ? "success" : "pending";
        const statusLabel = status === "loading" ? (locale === "en" ? "Loading" : "加载中") : status === "success" ? (locale === "en" ? "Configured" : "已配置") : status === "error" ? (locale === "en" ? "Failed" : "失败") : (locale === "en" ? "Not configured" : "未配置");
        return <button key={app.id} type="button" className="downloader-app-card" onClick={() => setSelectedAppId(app.id)}>
          <AppStatusIndicator status={status} label={statusLabel} />
          <span className={`downloader-app-mark is-${app.tone}`}><img src={app.icon} alt="" /></span>
          <strong>{app.name}</strong>
        </button>;
      })}
    </div>
    <Dialog open={Boolean(selectedAppId)} onOpenChange={(open) => { if (!open) setSelectedAppId(undefined); }}>
      {selectedAppId && (() => {
        const app = DOWNLOAD_APPS.find((item) => item.id === selectedAppId);
        if (!app) return null;
        const configured = authConfigured.has(app.id) || cookieConfigured.has(app.id);
        const openWebsite = () => {
          setSelectedAppId(undefined);
          void navigate({ to: "/apps/$appId", params: { appId: app.id } });
        };
        return <DialogContent className="downloader-app-dialog">
          <DialogHeader>
            <div className="downloader-app-dialog-heading">
              <span className={`downloader-app-mark is-${app.tone}`}><img src={app.icon} alt="" /></span>
              <div><DialogTitle>{app.name}</DialogTitle><DialogDescription>{configured ? (locale === "en" ? "Login information is saved locally." : "登录信息已保存在本机。") : (locale === "en" ? "Choose how to continue." : "选择接下来要进行的操作。")}</DialogDescription></div>
            </div>
          </DialogHeader>
          <div className="downloader-app-dialog-body">{configured ? (locale === "en" ? "You can reopen the login page to refresh the saved session." : "可以重新打开登录页面，更新本机保存的登录态。") : (locale === "en" ? "Open the built-in page and finish signing in there." : "打开内置页面，在里面完成登录并保存认证信息。")}</div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedAppId(undefined)}>{locale === "en" ? "Cancel" : "取消"}</Button>
            <Button variant="outline" onClick={openWebsite}><ExternalLink size={15} />{locale === "en" ? "Open website" : "打开网站"}</Button>
          </DialogFooter>
        </DialogContent>;
      })()}
    </Dialog>
  </section>;
}
