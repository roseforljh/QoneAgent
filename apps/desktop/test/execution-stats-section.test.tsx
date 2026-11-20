import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { ExecutionStatsInfo, RuntimeCommand } from "@qone/protocol";

const at = new Date(2025, 4, 20, 12, 0, 0).getTime();

const zero = (provider: string, model: string) => ({
  provider, model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, cacheObservedTokens: 0, cacheObservedRequests: 0, cacheObservedReadTokens: 0,
});

/** Mixture of "reported" and unknown cache rows is the merged runtime output already. */
const stats = (overrides: Partial<ExecutionStatsInfo> = {}): ExecutionStatsInfo => ({
  period: {
    from: at - 3_600_000, to: at,
    total: { ...zero("", ""), requests: 4, inputTokens: 910, outputTokens: 300, cacheReadTokens: 80, cacheHitRate: 80 },
    rows: [
      { ...zero("alpha", "shared"), requests: 3, inputTokens: 900, outputTokens: 300, cacheReadTokens: 80, cacheHitRate: 80 },
      { ...zero("beta", "shared"), requests: 1, inputTokens: 10 },
    ],
    sources: [
      { source: "memory", total: { ...zero("", ""), requests: 1, inputTokens: 40, outputTokens: 10 },
        rows: [{ ...zero("alpha", "shared"), requests: 1, inputTokens: 40, outputTokens: 10 }] },
      { source: "other", total: { ...zero("", ""), requests: 1, inputTokens: 10 },
        rows: [{ ...zero("beta", "shared"), requests: 1, inputTokens: 10 }] },
    ],
  },
  incidents: [{ provider: "alpha", model: "shared", count: 2, lastAt: at }, { provider: "beta", model: "shared", count: 5, lastAt: at }],
  models: [{ provider: "alpha", model: "shared" }, { provider: "beta", model: "shared" }],
  recording: true,
  memoryAccess: false,
  ...overrides,
});

test("model selection filters data without changing the two global execution controls", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { useStore } = await import("../src/store");
  // Pin the language so the assertions also prove both message tables are complete.
  const { GENERAL_SETTINGS_KEY, initLocale } = await import("../src/localization");
  dom.window.localStorage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify({ language: "zh-CN" }));
  initLocale();
  const { ExecutionSection } = await import("../src/components/settings/execution/execution-section");
  const { dispatchExecutionStatsError, dispatchExecutionStatsState, resetExecutionStatsRequests, useExecutionStatsStore } =
    await import("../src/lib/execution-stats-state");
  const initial = useStore.getState();
  const sent: RuntimeCommand[] = [];
  useStore.setState({ connected: true, send: (async (command: RuntimeCommand) => { sent.push(command); return true; }) as never });

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  /** Answers the pending command the way the runtime would, through the real event path. */
  const reply = async (state: ExecutionStatsInfo = stats()) => {
    const command = sent.at(-1)!;
    await act(async () => {
      dispatchExecutionStatsState({ type: "stats.state", requestId: command.requestId, state });
    });
    // A successful write re-reads the visible range; answer that reload too.
    const reread = sent.at(-1)!;
    if (reread.type === "stats.get" && reread.requestId !== command.requestId) {
      await act(async () => { dispatchExecutionStatsState({ type: "stats.state", requestId: reread.requestId, state }); });
    }
  };
  const pending = () => sent.at(-1)!;
  const toggle = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((button) => button.textContent === label)!;
  const trigger = (label: string) => host.querySelector<HTMLButtonElement>(`.execution-filters button[aria-label="${label}"]`)!;
  const select = async (label: string, value: string) => {
    await act(async () => trigger(label).click());
    const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent === value)!;
    await act(async () => option.click());
  };
  const model = (value: string) => select("模型", value);
  const range = (value: string) => select("时间段", value);
  const totalOf = (label: string) => [...host.querySelectorAll(".execution-total")]
    .find((node) => node.querySelector("span")?.textContent === label)?.querySelector("strong")?.textContent;
  const sourceText = () => host.querySelector(".execution-sources")?.textContent;

  try {
    await act(async () => root.render(<ExecutionSection />));
    expect(pending().type).toBe("stats.get");
    expect((pending() as Extract<RuntimeCommand, { type: "stats.get" }>).range).toBe("today");

    const periodTimes = () => [...host.querySelectorAll<HTMLTimeElement>(".execution-period time")];
    const expectPeriod = ({ from, to }: ExecutionStatsInfo["period"]) => {
      expect(periodTimes().map((time) => time.dateTime)).toEqual([from, to].map((value) => new Date(value).toISOString()));
      expect(periodTimes().map((time) => time.textContent)).toEqual([from, to].map((value) =>
        new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "medium" })));
      expect(host.querySelector(".execution-totals time")).toBeNull();
    };
    await reply();
    expectPeriod(stats().period);
    expect(trigger("模型").textContent).toBe("shared · alpha");
    expect(totalOf("缓存命中率")).toBe("80%");
    expect(totalOf("已记录错误")).toBe("2");
    expect(sourceText()).toContain("后台记忆");
    expect(sourceText()).not.toContain("其他");
    const recordSwitch = () => toggle("错误记录");
    const memorySwitch = () => toggle("记忆接入");
    const switches = () => [...host.querySelectorAll('[role="switch"]')].map((node) => [node.textContent, node.getAttribute("aria-checked")]);
    expect(switches()).toEqual([["错误记录", "true"], ["记忆接入", "false"]]);

    // Provider/model scopes the data, not the switches.
    const initialRequests = sent.length;
    await model("shared · beta");
    expect(totalOf("请求次数")).toBe("1");
    expect(totalOf("总 Token")).toBe("10");
    expect(totalOf("已记录错误")).toBe("5");
    expect(totalOf("缓存命中率")).toBe("未知");
    expect(sourceText()).toContain("其他");
    expect(sourceText()).not.toContain("后台记忆");
    expect(switches()).toEqual([["错误记录", "true"], ["记忆接入", "false"]]);
    await model("全部模型");
    expect(totalOf("请求次数")).toBe("4");
    expect(totalOf("已记录错误")).toBe("7");
    expect(switches()).toEqual([["错误记录", "true"], ["记忆接入", "false"]]);
    expect(sent).toHaveLength(initialRequests);

    await act(async () => memorySwitch().click());
    expect(pending()).toEqual({ type: "stats.memoryAccess.set", enabled: true, requestId: pending().requestId });
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    await reply(stats({ memoryAccess: true }));
    await model("shared · alpha");
    expect(switches()).toEqual([["错误记录", "true"], ["记忆接入", "true"]]);

    // Range switch re-reads the period instead of filtering locally.
    await range("近 30 天");
    expect(pending()).toMatchObject({ type: "stats.get", range: "30d" });
    expect(totalOf("请求次数")).toBeUndefined(); // No numbers from "today" while 30d loads.

    const historical = stats({ memoryAccess: true, period: { ...stats().period, from: new Date(2025, 3, 21, 0, 0, 0).getTime(),
      total: { ...zero("", ""), requests: 1, inputTokens: 10 }, rows: [{ ...zero("beta", "m2"), requests: 1, inputTokens: 10 }], sources: [] } });
    await reply(historical);
    expectPeriod(historical.period);
    expect(trigger("模型").textContent).toBe("shared · alpha");
    expect(totalOf("请求次数")).toBe("0");
    expect(host.textContent).toContain("这个时间段还没有使用记录");
    await model("m2 · beta");
    expect(totalOf("请求次数")).toBe("1");
    expect(totalOf("缓存命中率")).toBe("未知");
    expect(switches()).toEqual([["错误记录", "true"], ["记忆接入", "true"]]);
    await model("shared · alpha");

    // Cache reads and writes are metered separately and must count toward totals.
    const cached = stats();
    await range("近 30 天");
    const requested = sent.at(-1) as Extract<RuntimeCommand, { type: "stats.get" }>;
    expect(requested.range).toBe("30d");
    cached.period.total = { ...zero("", ""), requests: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 1_000, cacheWriteTokens: 40, cacheHitRate: 90 };
    cached.period.rows = [{ ...zero("alpha", "shared"), requests: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 1_000, cacheWriteTokens: 40, cacheHitRate: 90 }];
    await act(async () => { dispatchExecutionStatsState({ type: "stats.state", requestId: requested.requestId, state: cached }); });
    const compact = (value: number) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
    expect(totalOf("总 Token")).toBe(compact(1_160));
    expect(totalOf("缓存读取 Token")).toBe(compact(1_000));
    expect(totalOf("缓存写入 Token")).toBe("40");
    expect(totalOf("缓存命中率")).toBe("90%");

    // Late answers must not mix another range's usage or incident counts into 7d.
    await range("今天");
    const stale = pending();
    await range("近 7 天");
    const olderGet = pending();
    await range("近 7 天");
    const newerGet = pending();
    const sevenDay = stats({ incidents: [{ provider: "alpha", model: "shared", count: 9, lastAt: at }] });
    sevenDay.period.rows = [{ ...zero("alpha", "shared"), requests: 8, inputTokens: 50, outputTokens: 5, cacheHitRate: 71.5 }];
    await act(async () => {
      dispatchExecutionStatsState({ type: "stats.state", requestId: newerGet.requestId, state: sevenDay });
      dispatchExecutionStatsState({ type: "stats.state", requestId: stale.requestId, state: stats() });
      dispatchExecutionStatsState({ type: "stats.state", requestId: olderGet.requestId, state: stats() });
    });
    expect(totalOf("请求次数")).toBe("8");
    expect(totalOf("已记录错误")).toBe("9");
    expect(useExecutionStatsStore.getState().pending).toBe(0);

    // A switch write answered for "today" must not replace the 7d data.
    await act(async () => recordSwitch().click());
    const recordToggle = pending();
    expect(recordToggle).toEqual({ type: "stats.record.set", record: false, requestId: recordToggle.requestId });
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    const off = stats({ recording: false });
    await act(async () => { dispatchExecutionStatsState({ type: "stats.state", requestId: recordToggle.requestId, state: off }); });
    expect(totalOf("请求次数")).toBe("8");
    expect(totalOf("已记录错误")).toBe("9");
    expect(recordSwitch().getAttribute("aria-checked")).toBe("false");
    expect(pending()).toMatchObject({ type: "stats.get", range: "7d" });
    await reply({ ...sevenDay, recording: false });

    // An unknown request id changes nothing, not even the switches.
    await act(async () => { dispatchExecutionStatsState({ type: "stats.state", requestId: "not-a-request", state: stats() }); });
    expect(recordSwitch().getAttribute("aria-checked")).toBe("false");

    // An unrequested push can refresh settings without changing the data on screen.
    await act(async () => { dispatchExecutionStatsState({ type: "stats.state", state: stats({ recording: false, memoryAccess: true }) }); });
    expect(totalOf("已记录错误")).toBe("9");
    expect(switches()).toEqual([["错误记录", "false"], ["记忆接入", "true"]]);
    expect(memorySwitch().disabled).toBe(false);

    await act(async () => recordSwitch().click());
    expect(pending()).toMatchObject({ type: "stats.record.set", record: true });
    await act(async () => { dispatchExecutionStatsError(pending().requestId, "保存失败"); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("保存失败");
    expect(recordSwitch().getAttribute("aria-checked")).toBe("false");

    // A dropped connection releases the busy switches instead of leaving them disabled.
    await act(async () => recordSwitch().click());
    expect(recordSwitch().disabled).toBe(true);
    await act(async () => { resetExecutionStatsRequests(); });
    expect(useExecutionStatsStore.getState().pending).toBe(0);
    expect(recordSwitch().disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(initial);
    dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
