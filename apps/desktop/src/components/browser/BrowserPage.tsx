import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { useLocale } from "../../localization";
import { hasTauriBridge } from "../../store";
import { clipBrowserBounds, createDockBrowserSession } from "../../lib/dock-browser-session";
import { Button } from "../ui/Button";
import "./browser-page.css";

const INITIAL_URL = "https://www.bing.com/";
type BrowserTab = { id: string; url: string; loading: boolean; error?: string };
type BrowserSession = ReturnType<typeof createDockBrowserSession>;

function normalizeUrl(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch { return undefined; }
}

function browserTabLabel(value: string): string {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, "");
    return hostname === "bing.com" || hostname.endsWith(".bing.com") ? "Bing" : hostname;
  } catch { return "新标签页"; }
}

export function BrowserPage() {
  const { locale } = useLocale();
  const navigate = useNavigate();
  const hostRefs = useRef(new Map<string, HTMLDivElement>());
  const sessions = useRef(new Map<string, BrowserSession>());
  const syncLayouts = useRef(new Map<string, () => void>());
  const activeTabRef = useRef("auth-page-browser");
  const [tabs, setTabs] = useState<BrowserTab[]>([{ id: "auth-page-browser", url: INITIAL_URL, loading: true }]);
  const [activeTabId, setActiveTabId] = useState("auth-page-browser");
  const [address, setAddress] = useState(INITIAL_URL);
  activeTabRef.current = activeTabId;

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  const updateTab = (id: string, update: (tab: BrowserTab) => BrowserTab) => {
    setTabs((current) => current.map((tab) => tab.id === id ? update(tab) : tab));
  };

  useEffect(() => {
    if (!hasTauriBridge()) return undefined;
    let alive = true;
    const unlisten = listen<{ browserId: string; url: string }>("browser:navigated", (event) => {
      if (!alive) return;
      const { browserId, url } = event.payload;
      updateTab(browserId, (tab) => ({ ...tab, url, loading: false, error: undefined }));
      if (activeTabRef.current === browserId) setAddress(url);
    });
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
      for (const session of sessions.current.values()) session.dispose();
      sessions.current.clear();
      syncLayouts.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!hasTauriBridge()) return undefined;
    const currentIds = new Set(tabs.map((tab) => tab.id));
    for (const [id, session] of sessions.current) {
      if (!currentIds.has(id)) {
        session.dispose();
        sessions.current.delete(id);
        syncLayouts.current.delete(id);
      }
    }
    const resize = () => syncLayouts.current.forEach((sync) => sync());
    for (const tab of tabs) {
      if (!sessions.current.has(tab.id)) {
        const session = createDockBrowserSession(
          invoke,
          tab.id,
          tab.url,
          (reason) => updateTab(tab.id, (current) => ({ ...current, loading: false, error: String(reason) })),
          undefined,
          () => updateTab(tab.id, (current) => ({ ...current, loading: false })),
        );
        sessions.current.set(tab.id, session);
        const sync = () => {
          const host = hostRefs.current.get(tab.id);
          session.update(host ? clipBrowserBounds(host.getBoundingClientRect(), window.innerWidth, window.innerHeight) : undefined, activeTabRef.current === tab.id);
        };
        syncLayouts.current.set(tab.id, sync);
      }
    }
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("transitionend", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("transitionend", resize);
    };
  }, [tabs, activeTabId]);

  useEffect(() => {
    if (activeTab) setAddress(activeTab.url);
  }, [activeTabId]);

  const navigateTo = async (value: string) => {
    const next = normalizeUrl(value);
    if (!next || !activeTab) return;
    updateTab(activeTab.id, (tab) => ({ ...tab, url: next, loading: true, error: undefined }));
    await sessions.current.get(activeTab.id)?.command("browser_navigate", { url: next });
  };

  const evaluate = (script: string) => {
    if (!activeTab) return;
    void sessions.current.get(activeTab.id)?.command("browser_eval", { script });
  };

  const openExternal = async () => {
    const url = normalizeUrl(address);
    if (!url) return;
    try {
      if (hasTauriBridge()) await openUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (reason) { updateTab(activeTab.id, (tab) => ({ ...tab, error: String(reason) })); }
  };

  const openNewTab = () => {
    const id = `auth-page-browser-${crypto.randomUUID()}`;
    setTabs((current) => [...current, { id, url: INITIAL_URL, loading: true }]);
    setActiveTabId(id);
  };

  const closeTab = (id: string) => {
    if (tabs.length === 1) {
      void navigate({ to: "/" });
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === id);
    const nextTabs = tabs.filter((tab) => tab.id !== id);
    setTabs(nextTabs);
    if (activeTabId === id) {
      const next = nextTabs[Math.min(index, nextTabs.length - 1)];
      setActiveTabId(next.id);
      setAddress(next.url);
    }
  };

  return <main className="browser-page">
    <section className="browser-page-body">
      <div className="browser-page-tabbar">
        <div className="browser-page-tabs" role="tablist" aria-label={locale === "en" ? "Browser tabs" : "浏览器标签页"}>
          {tabs.map((tab) => <div key={tab.id} className={`browser-page-tab${tab.id === activeTabId ? " is-active" : ""}`} role="tab" aria-selected={tab.id === activeTabId} tabIndex={tab.id === activeTabId ? 0 : -1} onClick={() => setActiveTabId(tab.id)}>
            <Globe size={14} /><span>{browserTabLabel(tab.url)}</span><button type="button" aria-label={locale === "en" ? "Close tab" : "关闭标签页"} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}><X size={13} /></button>
          </div>)}
          <button type="button" className="browser-page-new-tab" aria-label={locale === "en" ? "New tab" : "打开新标签页"} title={locale === "en" ? "New tab" : "打开新标签页"} onClick={openNewTab}><Plus size={16} /></button>
        </div>
        <button type="button" className="browser-page-external" aria-label={locale === "en" ? "Open in external browser" : "在外置浏览器中打开"} title={locale === "en" ? "Open in external browser" : "在外置浏览器中打开"} onClick={() => void openExternal()}><ExternalLink size={17} /></button>
      </div>
      <form className="browser-page-toolbar" onSubmit={(event) => { event.preventDefault(); void navigateTo(address); }}>
        <div className="browser-page-controls">
          <button type="button" onClick={() => evaluate("history.back()")} disabled={!activeTab || activeTab.loading || !!activeTab.error} aria-label="后退"><ArrowLeft size={15} /></button>
          <button type="button" onClick={() => evaluate("history.forward()")} disabled={!activeTab || activeTab.loading || !!activeTab.error} aria-label="前进"><ArrowRight size={15} /></button>
          <button type="button" onClick={() => evaluate("location.reload()")} disabled={!activeTab || activeTab.loading || !!activeTab.error} aria-label="刷新"><RefreshCw size={14} /></button>
        </div>
        <input className="browser-page-address-input" value={address} onChange={(event) => setAddress(event.target.value)} aria-label={locale === "en" ? "Address" : "网址"} />
        <button type="button" className="browser-page-close" aria-label={locale === "en" ? "Close browser" : "关闭浏览器"} title={locale === "en" ? "Close browser" : "关闭浏览器"} onClick={() => void navigate({ to: "/" })}><X size={15} /></button>
      </form>
      <div className="browser-page-frames">
        {tabs.map((tab) => <div key={tab.id} className={`browser-page-frame${tab.id === activeTabId ? " is-active" : " is-inactive"}`}>
          <div ref={(node) => { if (node) hostRefs.current.set(tab.id, node); else hostRefs.current.delete(tab.id); }} className="browser-page-host" aria-label={locale === "en" ? "Built-in browser page" : "内置浏览器页面"} />
          {!hasTauriBridge() && tab.id === activeTabId && <div className="browser-page-placeholder">请在 Tauri 桌面应用中打开此页面。</div>}
          {tab.loading && hasTauriBridge() && tab.id === activeTabId && <div className="browser-page-placeholder"><LoaderCircle size={20} className="settings-spin" />{locale === "en" ? "Opening browser…" : "正在打开浏览器…"}</div>}
          {tab.error && tab.id === activeTabId && <div className="browser-page-placeholder"><p>{tab.error}</p><Button variant="outline" onClick={() => window.location.reload()}>重新打开页面</Button></div>}
        </div>)}
      </div>
    </section>
  </main>;
}
