import github from "../../assets/codex-icons/composer-github-26-928.svg";
import figma from "../../assets/codex-icons/composer-figma-26-928.svg";
import gmail from "../../assets/codex-icons/composer-gmail-26-928.svg";
import calendar from "../../assets/codex-icons/composer-google-calendar-26-928.svg";
import drive from "../../assets/codex-icons/composer-google-drive-26-928.svg";
import linear from "../../assets/codex-icons/composer-linear-26-928.svg";
import notion from "../../assets/codex-icons/composer-notion-26-928.svg";
import recruiting from "../../assets/codex-icons/composer-recruiting-assistant-26-928.svg";
import salesforce from "../../assets/codex-icons/composer-salesforce-26-928.svg";
import slack from "../../assets/codex-icons/composer-slack-26-928.svg";
import globe from "../../assets/codex-icons/composer-globe-26-928.svg";
import box from "../../assets/codex-icons/box-color-logo-light-20.svg";
import dropbox from "../../assets/codex-icons/dropbox-color-logo-light-20.svg";
import { additionalComposerLinkSites } from "./composer-link-sites";

// Codex 26.928: kmr host registry and Ufr icon registry are separate.
const sources = [
  { id: "box", hosts: ["box.com"] },
  { id: "dropbox", hosts: ["dropbox.com"] },
  { id: "google-calendar", hosts: ["calendar.google.com"] },
  { id: "google-drive", hosts: ["docs.google.com", "drive.google.com", "sheets.google.com", "slides.google.com"] },
  { id: "figma", hosts: ["figma.com"] },
  { id: "github", hosts: ["github.com"] },
  { id: "linear", hosts: ["linear.app"] },
  { id: "gmail", hosts: ["mail.google.com"] },
  { id: "notion", hosts: ["app.notion.com", "notion.so"] },
  { id: "recruiting-assistant", hosts: ["recruiting.apps.openai.org", "recruiting.extapps.openai.org", "recruiting.extapps-staging.openai.org", "recruiting.staging-apps.openai.org"] },
  { id: "salesforce", hosts: ["force.com", "salesforce.com"] },
  { id: "sharepoint", hosts: ["sharepoint.com"] },
  { id: "slack", hosts: ["slack.com"] },
] as const;
const icons: Record<string, { src: string; multicolor?: boolean }> = {
  // Qone fills the original registry's gaps using the existing Codex assets.
  box: { src: box, multicolor: true }, dropbox: { src: dropbox, multicolor: true },
  github: { src: github }, figma: { src: figma, multicolor: true }, gmail: { src: gmail, multicolor: true },
  "google-calendar": { src: calendar, multicolor: true }, "google-drive": { src: drive, multicolor: true },
  linear: { src: linear }, notion: { src: notion }, "recruiting-assistant": { src: recruiting, multicolor: true },
  salesforce: { src: salesforce, multicolor: true }, slack: { src: slack, multicolor: true },
};

export function composerLinkAppearance(href: string) {
  let hostname = "";
  try { hostname = new URL(href).hostname.toLowerCase(); } catch { /* Generic icon for invalid/transitional text. */ }
  const matchesHost = ({ hosts }: { hosts: readonly string[] }) => hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  const source = sources.find(matchesHost);
  if (source) return { sourceAppId: source.id, ...(icons[source.id] ?? { src: globe }), loadRemoteFavicon: icons[source.id] == null };
  const site = additionalComposerLinkSites.find(matchesHost);
  return { sourceAppId: site?.id ?? "", src: site?.src ?? globe, multicolor: site?.multicolor, loadRemoteFavicon: true };
}

export function applyComposerLinkAppearance(dom: HTMLElement, href: string): void {
  const appearance = composerLinkAppearance(href);
  dom.setAttribute("text-link-href", href);
  dom.setAttribute("rich-link-source-app-id", appearance.sourceAppId);
  dom.setAttribute("data-link-multicolor", String(appearance.multicolor === true));
  dom.style.setProperty("--q-composer-link-icon", `url("${appearance.src}")`);
  dom.title = href;
}
