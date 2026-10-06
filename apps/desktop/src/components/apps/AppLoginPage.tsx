import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, LoaderCircle, Moon, RefreshCw, ShieldCheck, Sun, X } from "lucide-react";
import { useLocale } from "../../localization";
import { hasTauriBridge, useStore } from "../../store";
import { useTheme } from "../../lib/appearance";
import { clipBrowserBounds, createDockBrowserSession } from "../../lib/dock-browser-session";
import { Button } from "../ui/Button";
import qonePenguinUrl from "../../assets/qone-penguin.png";
import { appCookieKey, findDownloadApp } from "./app-catalog";
import type { AuthCookie } from "./auth-types";
import { DOUYIN_BROWSER_ID } from "../../lib/douyin-page-bridge";
import "./app-login.css";

type AppLoginPageProps = { appId: string };

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function cookieHeader(cookies: AuthCookie[]): string {
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function EmbeddedLoginBrowser({
  browserId,
  url,
  onReady,
  onError,
}: {
  browserId: string;
  url: string;
  onReady: () => void;
  onError: (reason: unknown) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasTauriBridge()) return undefined;
    const session = createDockBrowserSession(
      invoke,
      browserId,
      url,
      (reason) => onErrorRef.current(reason),
      undefined,
      () => onReadyRef.current(),
    );
    const sync = () => {
      const bounds = clipBrowserBounds(host.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      session.update(bounds, true);
    };
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(host);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", sync);
      session.dispose();
    };
  }, [browserId, url]);

  return <div ref={hostRef} className="app-login-browser-host" aria-label="内置浏览器页面" />;
}

export function AppLoginPage({ appId }: AppLoginPageProps) {
  const { locale } = useLocale();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const connected = useStore((state) => state.connected);
  const send = useStore((state) => state.send);
  const app = findDownloadApp(appId);
  const browserId = appId === "douyin" ? DOUYIN_BROWSER_ID : `auth-page-${appId}`;
  const [browserReady, setBrowserReady] = useState(false);
  const [browserError, setBrowserError] = useState<string>();
  const [browserGeneration, setBrowserGeneration] = useState(0);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const aliveRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!app || !hasTauriBridge()) return;
    void invoke<{ cookies?: AuthCookie[] } | null>("auth_file_get", { appId: app.id })
      .then((file) => setSaved(Boolean(file?.cookies?.length)))
      .catch((reason) => setError(errorMessage(reason)));
  }, [app]);

  if (!app) {
    return <div className="app-login-missing"><p>找不到这个应用。</p><Link to="/plugins">返回应用</Link></div>;
  }

  const captureCookies = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const cookies = await invoke<AuthCookie[]>("browser_get_cookies", { browserId, url: app.loginUrl });
      // A late native callback must not save a session after the user left.
      if (!aliveRef.current) return;
      if (!cookies.length) throw new Error(locale === "en" ? "No cookies found. Finish signing in first." : "没有读取到 Cookie，请先在页面内完成登录。");
      await invoke("auth_file_save", { appId: app.id, cookies });
      const header = cookieHeader(cookies);
      if (header) {
        const key = appCookieKey(app.id);
        await invoke("secret_set", { key, value: header });
        if (connected && !await send({ type: "secret.set", requestId: crypto.randomUUID(), key, value: header })) {
          throw new Error(locale === "en" ? "Cookie sync failed." : "Cookie 同步失败。");
        }
      }
      if (aliveRef.current) setSaved(true);
    } catch (reason) {
      if (aliveRef.current) setError(errorMessage(reason));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const removeAuth = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await invoke("auth_file_delete", { appId: app.id });
      const key = appCookieKey(app.id);
      await invoke("secret_delete", { key });
      if (connected && !await send({ type: "secret.delete", requestId: crypto.randomUUID(), key })) {
        throw new Error(locale === "en" ? "Session removal sync failed." : "登录态清除同步失败。");
      }
      setSaved(false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const browserCommand = (script: string) => {
    if (!browserReady) return;
    void invoke("browser_eval", { browserId, script }).catch((reason) => setError(errorMessage(reason)));
  };

  return <main className="app-login-page">
    <header className="app-login-header">
      <Link className="app-login-brand" to="/plugins"><img src={qonePenguinUrl} alt="" /><span>Qone</span></Link>
      <div className="app-login-heading">
        <img src={app.icon} alt="" className={`app-login-app-icon is-${app.tone}`} />
        <div><strong>{app.name}</strong><span>{locale === "en" ? "Built-in browser" : "内置浏览器"}</span></div>
      </div>
      <button type="button" className="app-login-theme" onClick={toggleTheme} aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}>
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <Button variant="outline" size="sm" onClick={() => void navigate({ to: "/plugins" })}><X size={14} />{locale === "en" ? "Close browser" : "关闭浏览器"}</Button>
    </header>
    <section className="app-login-body">
      <div className="app-login-browser-toolbar">
        <div className="app-login-browser-controls">
          <button type="button" onClick={() => browserCommand("history.back()")} disabled={!browserReady} aria-label="后退"><ArrowLeft size={15} /></button>
          <button type="button" onClick={() => browserCommand("history.forward()")} disabled={!browserReady} aria-label="前进"><ArrowRight size={15} /></button>
          <button type="button" onClick={() => browserCommand("location.reload()")} disabled={!browserReady} aria-label="刷新"><RefreshCw size={14} /></button>
        </div>
        <span className="app-login-address">{new URL(app.loginUrl).hostname}</span>
        <span className={`app-login-browser-state ${browserReady ? "is-ready" : ""}`}><span />{browserError ? (locale === "en" ? "Failed to open" : "打开失败") : browserReady ? (locale === "en" ? "Ready" : "页面已打开") : (locale === "en" ? "Opening" : "正在打开")}</span>
      </div>
      <div className="app-login-browser-frame">
        <EmbeddedLoginBrowser key={browserGeneration} browserId={browserId} url={app.loginUrl} onReady={() => setBrowserReady(true)} onError={(reason) => { setBrowserReady(false); setBrowserError(errorMessage(reason)); }} />
        {!hasTauriBridge() && <div className="app-login-browser-placeholder">请在 Tauri 桌面应用中打开此页面。</div>}
        {browserError && <div className="app-login-browser-placeholder"><p>{browserError}</p><Button variant="outline" onClick={() => { setBrowserError(undefined); setBrowserGeneration((value) => value + 1); }}>重新打开页面</Button></div>}
      </div>
      <footer className="app-login-footer">
        <div className="app-login-instruction"><ShieldCheck size={17} /><div><strong>{saved ? (locale === "en" ? "Session saved" : "登录态已保存") : (locale === "en" ? "Sign in in this page" : "在此页面完成登录")}</strong><span>{saved ? (locale === "en" ? "You can return to the apps page." : "登录文件已保存到本机。") : (locale === "en" ? "Finish signing in, then capture the session." : "登录完成后点击右侧“获取 Cookie”。")}</span></div></div>
        {error && <p className="app-login-error" role="alert">{error}</p>}
        <div className="app-login-actions">
          {saved && <Button variant="outline" disabled={busy} onClick={() => void removeAuth()}>清除登录态</Button>}
          <Button variant="outline" onClick={() => void navigate({ to: "/plugins" })}>返回应用</Button>
          <Button disabled={busy || !browserReady} onClick={() => void captureCookies()}>{busy ? <LoaderCircle size={15} className="settings-spin" /> : saved ? <Check size={15} /> : <ShieldCheck size={15} />}{saved ? "重新获取 Cookie" : "获取 Cookie"}</Button>
        </div>
      </footer>
    </section>
  </main>;
}
