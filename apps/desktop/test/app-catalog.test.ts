import { expect, test } from "bun:test";
import { appCookieKey, DOWNLOAD_APPS, TELEGRAM_API_HASH_KEY, TELEGRAM_API_ID_KEY } from "../src/components/apps/app-catalog";

test("download app credential keys satisfy the native secret-key contract", () => {
  const keyPattern = /^[A-Za-z][A-Za-z0-9.-]{0,63}:[A-Za-z0-9._/-]{1,128}$/;
  expect(TELEGRAM_API_ID_KEY).toMatch(keyPattern);
  expect(TELEGRAM_API_HASH_KEY).toMatch(keyPattern);
  for (const app of DOWNLOAD_APPS) expect(appCookieKey(app.id)).toMatch(keyPattern);
});

test("Bilibili is available through the shared browser login flow", () => {
  const bilibili = DOWNLOAD_APPS.find((app) => app.id === "bilibili");
  expect(bilibili).toMatchObject({
    name: "哔哩哔哩",
    loginUrl: "https://www.bilibili.com/",
  });
  expect(bilibili?.icon).toContain("bilibili.svg");
});
