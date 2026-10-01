import { useState, type ComponentProps } from "react";
import { useStore } from "../../store";
import { openBrowserInDock } from "../../lib/browser-dock";
import { linkFaviconUrl } from "../../lib/link-favicon";
import { cn } from "../../lib/utils";
import { CodexIcon } from "../ui/CodexIcon";
import { composerLinkAppearance } from "./composer-link-appearance";
import { WebLinkContextMenu } from "./dock-context-menu";
import "./markdown-web-link.css";

function WebsiteIcon({ href }: { href: string }) {
  const normalized = href.startsWith("//") ? `https:${href}` : href;
  const appearance = composerLinkAppearance(normalized);
  const remote = appearance.loadRemoteFavicon ? linkFaviconUrl(normalized) : undefined;
  const [loaded, setLoaded] = useState<string>();
  return <span className="q-markdown-web-link-icon" aria-hidden="true" data-markdown-copy="exclude"
    data-favicon-loaded={remote && loaded === remote ? "" : undefined}>
    {appearance.multicolor
      ? <img src={appearance.src} alt="" draggable={false} data-favicon-fallback />
      : <CodexIcon src={appearance.src} data-favicon-fallback />}
    {remote && <img key={remote} src={remote} alt="" width={16} height={16} data-favicon
      decoding="async" loading="lazy" draggable={false} referrerPolicy="no-referrer"
      onLoad={() => setLoaded(remote)} />}
  </span>;
}

/** Keep the actual anchor for copying; use the existing browser Dock navigation. */
export function MarkdownWebLink({ className, href, title, children, onClick, ...props }: ComponentProps<"a">) {
  const website = href != null && /^(?:https?:)?\/\//i.test(href);
  const bareUrl = website && typeof children === "string" && children.trim() === href;
  const link = <a {...props} href={href} title={title ?? href} className={cn("aui-md-a q-markdown-web-link", className)}
    data-breakable-url={bareUrl ? "" : undefined}
    onClick={(event) => {
      onClick?.(event);
      if (event.defaultPrevented || !website || !href) return;
      event.preventDefault();
      openBrowserInDock(href.startsWith("//") ? `https:${href}` : href, useStore.getState().currentSessionId);
    }}>
    {website && <WebsiteIcon href={href} />}
    <span className="q-markdown-web-link-label">{children}</span>
  </a>;
  return website && href ? <WebLinkContextMenu href={href}>{link}</WebLinkContextMenu> : link;
}
