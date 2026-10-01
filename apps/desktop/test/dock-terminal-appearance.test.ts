import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ITerminalOptions } from "@xterm/xterm";
import { bindDockTerminalAppearance, readDockTerminalAppearance } from "../src/lib/dock-terminal-appearance";

const saved = new Map<string, PropertyDescriptor | undefined>();
const root = {};
const host = { isConnected: true } as HTMLElement;
let style: { backgroundColor: string; color: string; fontFamily: string; fontSize: string };
let selection: string;
let mutation: () => void;
let disconnected: boolean;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function flush() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}
beforeEach(() => {
  style = { backgroundColor: "rgb(20, 20, 20)", color: "rgb(223, 223, 223)", fontFamily: "Consolas, monospace", fontSize: "13px" };
  selection = "rgba(140, 90, 230, 0.35)";
  disconnected = false;
  frames = new Map();
  nextFrame = 0;
  const globals = {
    document: { documentElement: root },
    getComputedStyle: (element: unknown) => element === root ? { getPropertyValue: () => selection } : style,
    MutationObserver: class {
      constructor(callback: () => void) { mutation = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

test("终端从页面解析后的颜色和字体取值，不回退成独立黑底", () => {
  for (const background of ["rgb(20, 20, 20)", "rgb(250, 250, 250)", "rgb(28, 30, 36)"]) {
    style.backgroundColor = background;
    const options = readDockTerminalAppearance(host);
    expect(options.theme?.background).toBe(background);
    expect(options.theme?.foreground).toBe(style.color);
    expect(options.theme?.cursor).toBe(style.color);
    expect(options.theme?.cursorAccent).toBe(background);
    expect(options.theme?.selectionBackground).toBe(selection);
    expect(options.fontFamily).toBe(style.fontFamily);
    expect(options.fontSize).toBe(13);
  }
});

test("已挂载终端在主题切换后更新并重绘，合并同帧通知且不重复调整尺寸", () => {
  let redraws = 0;
  let fits = 0;
  const term = { options: readDockTerminalAppearance(host), rows: 24, refresh(start: number, end: number) { expect([start, end]).toEqual([0, 23]); redraws++; } };
  const stop = bindDockTerminalAppearance(host, term, () => fits++);
  style.backgroundColor = "rgb(250, 250, 250)";
  style.color = "rgb(10, 10, 10)";
  selection = "rgba(30, 90, 180, 0.35)";
  mutation(); mutation(); mutation();
  expect(frames.size).toBe(1);
  flush();
  expect(term.options.theme?.background).toBe(style.backgroundColor);
  expect(term.options.theme?.foreground).toBe(style.color);
  expect(term.options.theme?.selectionBackground).toBe(selection);
  expect(redraws).toBe(2);
  expect(fits).toBe(0);
  mutation(); flush();
  expect(redraws).toBe(2);
  stop();
});

test("字体变化重新拟合行列，解绑取消待执行更新", () => {
  let fits = 0;
  const term = { options: {} as ITerminalOptions, rows: 0, refresh() { throw new Error("empty renderer must not redraw"); } };
  const stop = bindDockTerminalAppearance(host, term, () => fits++);
  style.fontFamily = "Menlo, monospace";
  style.fontSize = "16px";
  mutation(); flush();
  expect(term.options.fontFamily).toBe(style.fontFamily);
  expect(term.options.fontSize).toBe(16);
  expect(fits).toBe(2);
  mutation();
  stop();
  expect(disconnected).toBe(true);
  expect(frames.size).toBe(0);
  flush();
  expect(fits).toBe(2);
});
