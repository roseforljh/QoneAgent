"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  GlobeIcon,
  PlugIcon,
  RotateCwIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import { useStore, hasTauriBridge } from "../../store";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { clipBrowserBounds, createDockBrowserSession } from "../../lib/dock-browser-session";
import { FadeScroll, mono } from "./elements/surfaces";
import { TooltipIconButton } from "./tooltip-icon-button";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";

const rid = () => crypto.randomUUID();
const BROWSER_HOME = "https://www.bing.com";

/** Normalize an address bar entry: bare domains get https://, everything else
 * without a scheme is treated as a search query. */
function toUrl(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  if (!text.includes(" ") && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text)) return `https://${text}`;
  if (text === "localhost" || /^[\w-]+:\d+/.test(text)) return `http://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

// The page area is a real WebView2 child of the main window (src-tauri
// browser.rs); this view only owns the toolbar and reports its rect.
export function DockBrowserView({ active }: { active: boolean }) {
  const { t } = useLocale();
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [address, setAddress] = useState(BROWSER_HOME);
  const [failed, setFailed] = useState<string>();
  const sessionRef = useRef<ReturnType<typeof createDockBrowserSession> | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let alive = true;
    const session = createDockBrowserSession(invoke, BROWSER_HOME, (error) => setFailed(String(error)));
    sessionRef.current = session;
    const sync = () => {
      const bounds = clipBrowserBounds(host.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      session.update(bounds, activeRef.current);
    };
    sync();
    const unNav = listen<{ url: string }>("browser:navigated", (event) => {
      if (alive) setAddress(event.payload.url);
    });
    let raf = 0;
    const tick = () => {
      if (!alive) return;
      sync();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      unNav.then((off) => off()).catch(() => {});
      session.dispose();
      sessionRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const bounds = clipBrowserBounds(host.getBoundingClientRect(), window.innerWidth, window.innerHeight);
    sessionRef.current?.update(bounds, active);
  }, [active]);

  const go = () => {
    const url = toUrl(address);
    if (url) void sessionRef.current?.command("browser_navigate", { url });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/50 px-2 py-1.5">
        <TooltipIconButton tooltip={t("dock.browserBack")} onClick={() => sessionRef.current?.command("browser_eval", { script: "history.back()" })} className="size-7">
          <ArrowLeftIcon className="size-3.5" />
        </TooltipIconButton>
        <TooltipIconButton tooltip={t("dock.browserForward")} onClick={() => sessionRef.current?.command("browser_eval", { script: "history.forward()" })} className="size-7">
          <ArrowRightIcon className="size-3.5" />
        </TooltipIconButton>
        <TooltipIconButton tooltip={t("dock.browserReload")} onClick={() => sessionRef.current?.command("browser_eval", { script: "location.reload()" })} className="size-7">
          <RotateCwIcon className="size-3.5" />
        </TooltipIconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t("dock.browserPlaceholder")}
            spellCheck={false}
            className={cn(mono, "w-full rounded-full bg-foreground/[0.05] px-3 py-1 text-[12px] outline-none placeholder:text-foreground/35")}
          />
        </form>
      </div>
      {/* ms-1.5 keeps the native webview clear of the panel resize separator */}
      <div ref={hostRef} className="relative ms-1.5 min-h-0 flex-1">
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <GlobeIcon className="size-5 text-foreground/35" />
            <p className="text-[13px] text-foreground/50">{t("dock.browserFailed")}</p>
            <p className={cn(mono, "text-[11px] text-foreground/35")}>{failed}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Same row model as assistant-ui's mcp-server-panel: collapsed to name +
// status dot, expands to transport, status and controls.
export function DockMcpView({ refreshNonce }: { refreshNonce: number }) {
  const { t } = useLocale();
  const send = useStore((s) => s.send);
  const servers = useStore((s) => s.mcpServers);
  const [openId, setOpenId] = useState<string>();

  useEffect(() => {
    send({ type: "mcp.list", requestId: rid() });
  }, [send, refreshNonce]);

  const connected = servers.filter((server) => server.connected).length;

  const reconnect = (serverId: string) => {
    const server = servers.find((item) => item.id === serverId);
    if (!server) return;
    send({ type: "mcp.connect", requestId: rid(), config: server });
    window.setTimeout(() => send({ type: "mcp.list", requestId: rid() }), 1200);
  };

  const remove = async (serverId: string, name: string, tokenKey?: string) => {
    if (!await confirmDestructiveAction(t("mcp.deleteConfirm", { name }))) return;
    if (hasTauriBridge()) await invoke("secret_delete", { key: tokenKey ?? `mcp.oauth:${serverId}` }).catch(() => undefined);
    send({ type: "mcp.delete", requestId: rid(), serverId });
    window.setTimeout(() => send({ type: "mcp.list", requestId: rid() }), 500);
  };

  if (!servers.length) return <p className="px-3 py-4 text-[13px] text-foreground/45">{t("mcp.noConnections")}</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className={cn(mono, "shrink-0 px-3 py-2 text-[11px] text-foreground/45")}>
        {t("dock.mcpConnected", { connected, total: servers.length })}
      </p>
      <FadeScroll className="min-h-0 flex-1 py-1">
        {servers.map((server) => {
          const open = openId === server.id;
          const transport = server.command ? `stdio · ${[server.command, ...(server.args ?? [])].join(" ")}` : `http · ${server.url ?? ""}`;
          return (
            <div key={server.id} className="mx-1.5 mb-1 overflow-hidden rounded-lg">
              <button
                type="button"
                onClick={() => setOpenId(open ? undefined : server.id)}
                aria-expanded={open}
                className="text-foreground/80 hover:bg-foreground/[0.05] flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-start transition-colors"
              >
                <ChevronRightIcon className={cn("size-3 shrink-0 text-foreground/40 transition-transform duration-150", open && "rotate-90")} />
                <PlugIcon className="size-3.5 shrink-0 text-foreground/45" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{server.name}</span>
                <span className={cn(mono, "shrink-0 text-[11px] text-foreground/40")}>{server.toolCount ?? 0} tools</span>
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", server.connected ? "bg-emerald-500" : server.oauth ? "bg-amber-500" : "bg-foreground/25")}
                  title={server.connected ? t("mcp.connectedStatus") : t("mcp.disconnectedStatus")}
                />
              </button>
              {open && (
                <div className="px-3 pb-2.5 pt-1">
                  <p className={cn(mono, "truncate text-[11px] text-foreground/45")} title={transport}>{transport}</p>
                  <p className="mt-1 text-[11px] text-foreground/50">{server.connected ? t("mcp.connectedStatus") : t("mcp.disconnectedStatus")}</p>
                  <div className="mt-2 flex items-center gap-1.5">
                    {server.oauth && !server.connected && (
                      <button
                        type="button"
                        onClick={() => send({ type: "mcp.oauth.begin", requestId: rid(), serverId: server.id })}
                        className="rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
                      >
                        {t("mcp.authorize")}
                      </button>
                    )}
                    {!server.connected && (
                      <button
                        type="button"
                        onClick={() => reconnect(server.id)}
                        className="rounded-md bg-foreground/[0.07] px-2 py-1 text-[11px] font-medium text-foreground/75 transition-colors hover:bg-foreground/[0.12]"
                      >
                        {t("dock.mcpReconnect")}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={t("mcp.delete", { name: server.name })}
                      onClick={() => void remove(server.id, server.name, server.oauth?.tokenSecretKey)}
                      className="ms-auto rounded-md p-1 text-foreground/40 transition-colors hover:bg-red-500/10 hover:text-red-500"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </FadeScroll>
    </div>
  );
}

export function DockSkillsView({ workspaceId, refreshNonce }: { workspaceId?: string; refreshNonce: number }) {
  const { t } = useLocale();
  const send = useStore((s) => s.send);
  const skills = useStore((s) => s.skills);
  const workspacePath = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path);

  useEffect(() => {
    send({ type: "skills.list", requestId: rid(), cwd: workspacePath });
  }, [send, workspacePath, refreshNonce]);

  if (!skills.length) return <p className="px-3 py-4 text-[13px] text-foreground/45">{t("skills.none")}</p>;

  return (
    <FadeScroll className="min-h-0 flex-1 py-1">
      {skills.map((skill) => (
        <button
          key={skill.id}
          type="button"
          onClick={() => openPath(skill.path).catch(() => {})}
          className="text-foreground/80 hover:bg-foreground/[0.05] flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-start transition-colors"
        >
          <WandSparklesIcon className="size-3.5 shrink-0 text-violet-500/80 dark:text-violet-400/80" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px]">{skill.name}</span>
            {skill.description && <span className="block truncate text-[11px] text-foreground/45">{skill.description}</span>}
          </span>
        </button>
      ))}
    </FadeScroll>
  );
}
