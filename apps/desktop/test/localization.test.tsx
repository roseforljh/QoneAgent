import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { en } from "../src/i18n/en";
import { zh, type MessageKey } from "../src/i18n/zh-CN";
import { GENERAL_SETTINGS_KEY, getLanguageSetting, initLocale, resolveLocale, saveLanguageSetting, subscribeLanguage, translate, translateCurrent } from "../src/localization";
import { ImageGeneration } from "../src/components/assistant-ui/elements/image-generation";
import { ToolFallback } from "../src/components/assistant-ui/elements/tool-result";
import { QoneSelect } from "../src/components/ui/Select";
import { serializeMessageAttachments } from "../src/lib/message-attachments";
import { toolPresentationSummary } from "../src/components/assistant-ui/tool-presentation";
import { localizeReachChannel } from "../src/lib/reach-channel-localization";
import { listReachChannels } from "../../agent-runtime/src/reach-channels";
import { generateBootLocale } from "../scripts/generate-boot-locale";
import { runInNewContext } from "node:vm";
import { localizeError } from "../src/lib/error-localization";
import { subagentProfileCopy } from "../src/lib/subagent-profile-copy";

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
let storage: Map<string, string>;
let events: EventTarget;
beforeEach(() => {
  storage = new Map();
  events = new EventTarget();
  for (const key of ["window", "document", "navigator"]) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { lang: "" } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });
});
afterEach(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("both dictionaries have exactly the same keys, interpolation parameters and no empty values", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(zh) as MessageKey[]) {
    expect(en[key].trim().length, key).toBeGreaterThan(0);
    expect(zh[key].trim().length, key).toBeGreaterThan(0);
    expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]));
    expect(en[key], key).not.toMatch(/\p{Script=Han}/u);
  }
  expect(translate("en", "reach.count", { count: 0 })).toBe("Channels: 0");
});

test("dictionary source never silently overwrites duplicate keys", () => {
  for (const name of ["en", "zh-CN"]) {
    const source = ts.createSourceFile(name + ".ts", readFileSync(new URL(`../src/i18n/${name}.ts`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const keys: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) keys.push(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(new Set(keys).size, name).toBe(keys.length);
  }
});

test("auto detection respects supported language preference order and saved explicit choices", () => {
  expect(resolveLocale("auto", ["en-GB", "zh-CN"])).toBe("en");
  expect(resolveLocale("auto", ["zh-Hant", "en"])).toBe("zh-CN");
  expect(resolveLocale("auto", ["fr", "zh_CN"])).toBe("zh-CN");
  expect(resolveLocale("auto", ["fr", "de"])).toBe("en");
  expect(resolveLocale("auto", [])).toBe("en");
  expect(resolveLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  expect(resolveLocale("en", ["zh-CN"])).toBe("en");
});

test("switching language preserves appearance settings, updates the document and notifies subscribers", () => {
  storage.set(GENERAL_SETTINGS_KEY, JSON.stringify({ appearance: { dark: { accent: "green" } }, language: "zh-CN" }));
  const dispose = initLocale();
  let changes = 0;
  const unsubscribe = subscribeLanguage(() => changes++);
  expect(document.documentElement.lang).toBe("zh-CN");
  saveLanguageSetting("en");
  expect(document.documentElement.lang).toBe("en");
  expect(getLanguageSetting()).toBe("en");
  expect(JSON.parse(storage.get(GENERAL_SETTINGS_KEY)!).appearance.dark.accent).toBe("green");
  expect(changes).toBe(1);
  unsubscribe(); dispose();
  saveLanguageSetting("zh-CN");
  expect(changes).toBe(1);
});

test("invalid persisted settings and blocked storage fall back to system language", () => {
  for (const value of ["{", "null", "[]", "42", '{"language":"invalid"}']) {
    storage.set(GENERAL_SETTINGS_KEY, value);
    expect(getLanguageSetting()).toBe("auto");
    expect(translateCurrent("common.close")).toBe("Close");
  }
  Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage denied"); } });
  expect(translateCurrent("common.close")).toBe("Close");
});

test("blocked storage writes still switch this window and later storage changes restore synchronization", () => {
  storage.set(GENERAL_SETTINGS_KEY, JSON.stringify({ language: "zh-CN", appearance: { dark: { accent: "green" } } }));
  const dispose = initLocale();
  const setItem = window.localStorage.setItem;
  window.localStorage.setItem = () => { throw new Error("Storage denied"); };
  expect(() => saveLanguageSetting("en")).not.toThrow();
  expect(getLanguageSetting()).toBe("en");
  expect(document.documentElement.lang).toBe("en");
  expect(translateCurrent("common.close")).toBe("Close");
  expect(JSON.parse(storage.get(GENERAL_SETTINGS_KEY)!).language).toBe("zh-CN");
  events.dispatchEvent(Object.assign(new Event("storage"), { key: GENERAL_SETTINGS_KEY }));
  expect(getLanguageSetting()).toBe("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  window.localStorage.setItem = setItem;
  saveLanguageSetting("en");
  expect(JSON.parse(storage.get(GENERAL_SETTINGS_KEY)!)).toMatchObject({ language: "en", appearance: { dark: { accent: "green" } } });
  dispose();
});

test("native and runtime structured errors follow the current UI language and preserve external messages", () => {
  const native = { code: "native.attachmentRead", values: { error: "文件.txt: OS error 5" } };
  const runtime = { message: "old language", localization: { code: "skills.the_skill_description_cannot_be_empty", values: {} } };
  saveLanguageSetting("en");
  expect(localizeError(native)).toBe("Could not read the attachment: 文件.txt: OS error 5");
  expect(localizeError(runtime)).toBe("The skill description cannot be empty");
  saveLanguageSetting("zh-CN");
  expect(localizeError(native)).toBe("无法读取附件：文件.txt: OS error 5");
  expect(localizeError(runtime)).toBe("Skill 描述不能为空");
  expect(localizeError(new Error("provider error"))).toBe("provider error");
  expect(localizeError({ code: "unknown", message: "original diagnostic" })).toBe("original diagnostic");
  expect(localizeError({ message: "new runtime diagnostic", localization: { code: "future.code" } })).toBe("new runtime diagnostic");
});

test("every native error code has translated copy and file preview failures preserve diagnostics", () => {
  const source = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
  const codes = [...source.matchAll(/NativeError::(?:new|detail)\("([^"]+)"/g)].map((match) => match[1]!);
  expect(codes.length).toBeGreaterThan(0);
  expect(source).not.toMatch(/Err\("[^"\n]*\p{Script=Han}/u);
  for (const locale of ["en", "zh-CN"] as const) {
    saveLanguageSetting(locale);
    for (const code of codes) {
      expect(Object.hasOwn(zh, code), code).toBe(true);
      expect(localizeError({ code, values: { error: "OS error 5" } }), code).toBe(translate(locale, code as MessageKey, { error: "OS error 5" }));
    }
    const key = "native.filePreviewFailed";
    expect(localizeError({ code: key, values: { error: "C:/中文目录/文件.txt: OS error 5" } })).toBe(translate(locale, key, { error: "C:/中文目录/文件.txt: OS error 5" }));
  }
});

test("built-in profile copy switches language while user-authored names and instructions remain intact", () => {
  const profile = { name: "原始默认名", instructions: "原始默认指令", nameKey: "subagent.name.stt", instructionsKey: "subagent.instructions.stt" };
  expect(subagentProfileCopy(profile, "en").name).toBe("Speech to text");
  expect(subagentProfileCopy(profile, "en").instructions).not.toMatch(/\p{Script=Han}/u);
  expect(subagentProfileCopy(profile, "zh-CN").name).toBe("语音转文字");
  const custom = { name: "我的中文代理", instructions: "按用户指定流程处理。" };
  expect(subagentProfileCopy(custom, "en")).toEqual(custom);
});

test("representative UI defaults and adapter errors follow both languages at call time", async () => {
  for (const locale of ["zh-CN", "en"] as const) {
    saveLanguageSetting(locale);
    const image = renderToStaticMarkup(createElement(ImageGeneration, { prompt: "User text", generating: true }));
    expect(image).toContain(translate(locale, "image.generating"));
    const fallback = renderToStaticMarkup(createElement(ToolFallback, { presentation: { kind: "unknown", debugJson: "{}" } }));
    expect(fallback).toContain(translate(locale, "chat.debugFallback"));
    const select = renderToStaticMarkup(createElement(QoneSelect, { value: "", options: [], onChange() {} }));
    expect(select).toContain(translate(locale, "common.select"));
    expect(toolPresentationSummary({ kind: "diff", name: "文档.txt" }, locale)).toBe(translate(locale, "tool.fileUpdated", { name: "文档.txt" }));
    await expect(serializeMessageAttachments({ role: "user", content: [], attachments: [{
      id: "a", type: "image", name: "vector.svg", contentType: "image/svg+xml", status: { type: "complete" },
      content: [{ type: "image", image: "data:image/svg+xml;base64,PHN2Zz4=" }],
    }] })).rejects.toThrow(translate(locale, "attachment.unsupportedImage", { name: "vector.svg" }));
  }
});

test("all built-in channel states have English display copy without changing commands or original names", () => {
  for (let flags = 0; flags < 32; flags++) {
    const channels = listReachChannels({
      browserConnected: Boolean(flags & 1), hasXueqiuCookie: Boolean(flags & 2), podcastConfigured: Boolean(flags & 4),
      hasGroqKey: Boolean(flags & 8), mcpConnected: () => Boolean(flags & 16),
    });
    expect(channels).toHaveLength(16);
    for (const channel of channels) {
      expect(channel.english, channel.id).toBeDefined();
      const display = localizeReachChannel(channel, "en");
      for (const field of ["name", "description", "backend", "detail"] as const) {
        expect(display[field] ?? "", channel.id + "." + field).not.toMatch(/\p{Script=Han}/u);
        expect(Boolean(display[field]), channel.id + "." + field).toBe(Boolean(channel[field]));
      }
      expect(display.id).toBe(channel.id);
      expect(display.tools).toEqual(channel.tools);
      expect(localizeReachChannel(channel, "zh-CN")).toBe(channel);
    }
  }
});

test("generated startup copy is current and uses the same locale resolver before React", async () => {
  const source = readFileSync(new URL("../public/boot-locale.js", import.meta.url), "utf8");
  expect(await generateBootLocale()).toBe(source);
  for (const [setting, languages] of [["en", ["zh-CN"]], ["zh-CN", ["en-US"]], ["auto", ["fr", "en-GB"]], ["auto", ["zh-TW"]]] as const) {
    const node = { dataset: { qoneBootText: "startup.loading" }, textContent: "" };
    const label = { dataset: { qoneBootLabel: "startup.loading" }, setAttribute(_name: string, value: string) { node.textContent = value; } };
    const document = { documentElement: { lang: "" }, querySelectorAll: (selector: string) => selector.includes("text") ? [node] : [label] };
    const window: { qoneBootText?: (key: string) => string } = {};
    runInNewContext(source, { document, window, navigator: { languages }, localStorage: { getItem: () => JSON.stringify({ language: setting }) } });
    const expected = resolveLocale(setting, languages);
    expect(document.documentElement.lang).toBe(expected);
    expect(node.textContent).toBe(translate(expected, "startup.loading"));
    expect(window.qoneBootText!("startup.failed")).toBe(translate(expected, "startup.failed"));
  }
});
