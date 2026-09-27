import { expect, test } from "bun:test";
import { providerLogoUrls } from "../src/components/settings/provider-logo-urls";

test("uses the website domain before an API subdomain", () => {
  expect(providerLogoUrls("https://api.openai.com/v1")).toEqual([
    "https://api.openai.com/favicon.ico",
    "https://api.openai.com/favicon.png",
    "https://api.openai.com/favicon.svg",
    "https://openai.com/favicon.ico",
    "https://openai.com/favicon.png",
    "https://openai.com/favicon.svg",
  ]);
});

test("keeps custom domains and handles invalid addresses", () => {
  expect(providerLogoUrls("example.com/v1")).toEqual([
    "https://example.com/favicon.ico",
    "https://example.com/favicon.png",
    "https://example.com/favicon.svg",
  ]);
  expect(providerLogoUrls("not a host")).toEqual([]);
  expect(providerLogoUrls("http://localhost:8000/v1")).toEqual([]);
});

test("prefers an explicit logo URL", () => {
  expect(providerLogoUrls("https://api.example.com/v1", "https://cdn.example.com/logo.png")[0]).toBe("https://cdn.example.com/logo.png");
  expect(providerLogoUrls("https://example.com", "data:image/png;base64,invalid")[0]).toBe("https://example.com/favicon.ico");
});
