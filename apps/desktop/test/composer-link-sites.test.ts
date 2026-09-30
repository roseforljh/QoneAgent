import { expect, test } from "bun:test";
import { composerLinkAppearance, applyComposerLinkAppearance } from "../src/components/assistant-ui/composer-link-appearance";
import { additionalComposerLinkSites } from "../src/components/assistant-ui/composer-link-sites";

test("Cloudflare, Reddit and X use their own icons, including subdomains and legacy/short links", () => {
  const examples = [
    ["https://dash.cloudflare.com/account/workers", "cloudflare", "cloudflare-color.svg"],
    ["https://developers.cloudflare.com/workers/", "cloudflare", "cloudflare-color.svg"],
    ["https://old.reddit.com/r/programming/", "reddit", "reddit-regular-20.svg"],
    ["https://redd.it/abc123", "reddit", "reddit-regular-20.svg"],
    ["https://x.com/example/status/123", "x", "/x.svg"],
    ["https://mobile.twitter.com/example", "x", "/x.svg"],
    ["https://t.co/abc123", "x", "/x.svg"],
  ];
  for (const [href, id, icon] of examples) {
    const result = composerLinkAppearance(href!);
    expect(result.sourceAppId).toBe(id);
    expect(result.src.replaceAll("\\", "/")).toContain(icon!);
  }
});

test("common video, community, development and AI websites use the expected brands", () => {
  const examples = [
    ["https://youtu.be/video", "youtube"],
    ["https://discord.gg/invite", "discord"],
    ["https://b23.tv/abc", "bilibili"],
    ["https://gitlab.com/group/repository", "gitlab"],
    ["https://stackoverflow.com/questions/123", "stackoverflow"],
    ["https://zh.wikipedia.org/wiki/HTTP", "wikipedia"],
    ["https://t.me/example", "telegram"],
    ["https://huggingface.co/datasets", "huggingface"],
    ["https://vercel.com/dashboard", "vercel"],
    ["https://chatgpt.com/c/123", "chatgpt"],
    ["https://chat.openai.com/", "chatgpt"],
    ["https://platform.openai.com/docs", "openai"],
    ["https://claude.ai/new", "claude"],
    ["https://chat.deepseek.com/", "deepseek"],
    ["https://www.google.com/search?q=test", "google"],
    ["https://fb.watch/abc", "facebook"],
    ["https://instagram.com/example", "instagram"],
    ["https://lnkd.in/abc", "linkedin"],
    ["https://www.tiktok.com/@example", "tiktok"],
  ];
  for (const [href, id] of examples) {
    expect(composerLinkAppearance(href!).sourceAppId).toBe(id);
  }
});

test("additional sites match only hostname boundaries, never credentials, paths or lookalikes", () => {
  for (const site of additionalComposerLinkSites) {
    for (const host of site.hosts) {
      expect(composerLinkAppearance(`https://${host.toUpperCase()}/`).sourceAppId).toBe(site.id);
      expect(composerLinkAppearance(`https://www.${host}:8443/`).sourceAppId).toBe(site.id);
      expect(composerLinkAppearance(`https://not${host}/`).sourceAppId).not.toBe(site.id);
      for (const href of [
        `https://${host}.example.invalid/`,
        `https://${host}@example.invalid/`,
        `https://example.invalid/${host}?url=https://${host}/`,
      ]) {
        expect(composerLinkAppearance(href).sourceAppId).toBe("");
        expect(composerLinkAppearance(href).src).toContain("composer-globe-26-928.svg");
      }
    }
  }
});

test("existing Google service icons retain precedence over the new Google domain mapping", () => {
  for (const [href, id] of [
    ["https://docs.google.com/document/d/123", "google-drive"],
    ["https://drive.google.com/drive", "google-drive"],
    ["https://mail.google.com/mail", "gmail"],
    ["https://calendar.google.com/calendar", "google-calendar"],
  ]) expect(composerLinkAppearance(href!).sourceAppId).toBe(id);
});

test("Cloudflare's multicolor image resets to a monochrome mask when editing the URL to X", () => {
  const attributes = new Map<string, string>();
  const styles = new Map<string, string>();
  const element = {
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    style: { setProperty: (key: string, value: string) => styles.set(key, value) },
    title: "",
  } as unknown as HTMLElement;
  applyComposerLinkAppearance(element, "https://dash.cloudflare.com/");
  expect(attributes.get("data-link-multicolor")).toBe("true");
  applyComposerLinkAppearance(element, "https://x.com/");
  expect(attributes.get("data-link-multicolor")).toBe("false");
  expect(attributes.get("rich-link-source-app-id")).toBe("x");
  expect(styles.get("--q-composer-link-icon")?.replaceAll("\\", "/")).toContain("/x.svg");
});

test("shared hosting customer sites keep the generic icon; unknown URLs remain supported", () => {
  for (const href of ["https://customer.pages.dev/", "https://customer.workers.dev/", "https://customer.vercel.app/", "https://example.com/", "invalid URL"]) {
    expect(composerLinkAppearance(href).sourceAppId).toBe("");
    expect(composerLinkAppearance(href).src).toContain("composer-globe-26-928.svg");
  }
  expect(composerLinkAppearance("https://app.box.com/file/123").src).toContain("box-color-logo-light-20.svg");
  expect(composerLinkAppearance("https://www.dropbox.com/file/123").src).toContain("dropbox-color-logo-light-20.svg");
});
