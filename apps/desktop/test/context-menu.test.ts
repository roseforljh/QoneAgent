import { expect, test } from "bun:test";
import type { KeyboardEvent, MouseEvent } from "react";
import { contextMenuSelection, openContextMenuFromKeyboard, preserveLinkedImageMenu } from "../src/lib/context-menu";

function gesture(overrides = {}, editable = false) {
  const dispatched: Event[] = [];
  class MouseEventStub extends Event {
    constructor(type: string, init: MouseEventInit) { super(type, init); Object.assign(this, { clientX: init.clientX, clientY: init.clientY }); }
  }
  const target = { closest: () => editable ? target : null };
  const currentTarget = {
    contains: (node: unknown) => node === target,
    ownerDocument: { defaultView: { MouseEvent: MouseEventStub } },
    getBoundingClientRect: () => ({ left: 14, bottom: 38 }),
    dispatchEvent: (event: Event) => { dispatched.push(event); return true; },
  };
  const event = {
    key: "ContextMenu", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, repeat: false,
    target, currentTarget, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; }, ...overrides,
  };
  openContextMenuFromKeyboard(event as unknown as KeyboardEvent<HTMLElement>);
  return { event, dispatched };
}

test("menu key and Shift+F10 enter the row's right-click path without activating it", () => {
  for (const keys of [{}, { key: "F10", shiftKey: true }]) {
    const { event, dispatched } = gesture(keys);
    expect(event.defaultPrevented).toBe(true);
    expect(event.stopped).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ type: "contextmenu", bubbles: true, cancelable: true, clientX: 14, clientY: 38 });
  }
});

test("editing, handled events, modifiers and unrelated shortcuts keep their own behavior", () => {
  for (const keys of [{ key: "Enter" }, { key: "F10" }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { defaultPrevented: true }]) {
    const { event, dispatched } = gesture(keys);
    expect(dispatched).toHaveLength(0);
    expect(event.stopped).toBe(false);
  }
  const editing = gesture({}, true);
  expect(editing.dispatched).toHaveLength(0);
  expect(editing.event.defaultPrevented).toBe(false);
  expect(gesture({ target: {} }).dispatched).toHaveLength(0); // Portal contents do not reopen a row menu.
});

test("code selection preserves indentation and blank lines, and excludes another surface", () => {
  const code = {};
  const elsewhere = {};
  const selection = { rangeCount: 1, isCollapsed: false, anchorNode: code, focusNode: code, toString: () => "\n  const value = 1;\n\t" };
  const container = { contains: (node: unknown) => node === code, ownerDocument: { getSelection: () => selection } } as unknown as HTMLElement;
  expect(contextMenuSelection(container)).toBe("\n  const value = 1;\n\t");
  selection.focusNode = elsewhere;
  expect(contextMenuSelection(container)).toBe("");
  selection.focusNode = code;
  selection.isCollapsed = true;
  expect(contextMenuSelection(container)).toBe("");
  selection.isCollapsed = false;
  selection.rangeCount = 0;
  expect(contextMenuSelection(container)).toBe("");
  expect(contextMenuSelection(null)).toBe("");
});

test("linked images retain the native menu without disabling its default action", () => {
  for (const image of [true, false]) {
    const event = { target: { closest: () => image ? {} : null }, defaultPrevented: false, stopped: false, stopPropagation() { this.stopped = true; } };
    preserveLinkedImageMenu(event as unknown as MouseEvent<HTMLElement>);
    expect(event.stopped).toBe(image);
    expect(event.defaultPrevented).toBe(false);
  }
});
