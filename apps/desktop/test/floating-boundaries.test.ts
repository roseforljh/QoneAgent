import { expect, test } from "bun:test";
import { getFloatingBoundaries } from "../src/lib/floating-boundaries";

function fixture() {
  const ownerDocument = {
    body: null as unknown as HTMLElement,
    defaultView: {
      getComputedStyle: (element: HTMLElement) => (element as unknown as { style: { overflowX: string; overflowY: string } }).style,
    },
  };
  function element(parent: HTMLElement | null, { role = "", tag = "DIV", x = "visible", y = "visible" } = {}) {
    return {
      ownerDocument,
      parentElement: parent,
      tagName: tag,
      getAttribute: (attribute: string) => attribute === "role" ? role : null,
      style: { overflowX: x, overflowY: y },
    } as unknown as HTMLElement;
  }
  const body = element(null);
  ownerDocument.body = body;
  return { element, body, ownerDocument };
}

test("accent and language menus use the settings scrollport and dialog instead of the full window", () => {
  const f = fixture();
  const dialog = f.element(f.body, { role: "dialog", x: "hidden", y: "hidden" });
  const scrollport = f.element(dialog, { x: "auto", y: "auto" });
  const row = f.element(scrollport);
  const select = f.element(row);
  expect(getFloatingBoundaries(f.element(select))).toEqual([scrollport, dialog]);
});

test("a model editor uses its own dialog and does not inherit an outer settings scrollport", () => {
  const f = fixture();
  const outerDialog = f.element(f.body, { role: "dialog" });
  const outerScrollport = f.element(outerDialog, { y: "auto" });
  const editor = f.element(outerScrollport, { role: "dialog", y: "auto" });
  expect(getFloatingBoundaries(f.element(editor))).toEqual([editor]);
});

test("a dialog remains a boundary even when its overflow is visible", () => {
  const f = fixture();
  const dialog = f.element(f.body, { role: "dialog" });
  expect(getFloatingBoundaries(f.element(dialog))).toEqual([dialog]);
});

test("native dialogs and alert dialogs also contain nested choices", () => {
  const f = fixture();
  for (const options of [{ tag: "DIALOG" }, { role: "alertdialog" }]) {
    const dialog = f.element(f.body, options);
    expect(getFloatingBoundaries(f.element(dialog))).toEqual([dialog]);
  }
});

test("horizontal clipping and vertical scrolling both constrain the popup", () => {
  const f = fixture();
  const horizontalClip = f.element(f.body, { x: "clip" });
  const verticalScroll = f.element(horizontalClip, { y: "scroll" });
  const hidden = f.element(verticalScroll, { y: "hidden" });
  expect(getFloatingBoundaries(f.element(hidden))).toEqual([hidden, verticalScroll, horizontalClip]);
});

test("ordinary layout wrappers and the body do not turn into artificial popup boundaries", () => {
  const f = fixture();
  f.body.style.overflowY = "hidden";
  expect(getFloatingBoundaries(f.element(f.element(f.body)))).toEqual([]);
});

test("opening after the parent changes its overflow uses its current clipping behavior", () => {
  const f = fixture();
  const parent = f.element(f.body);
  const anchor = f.element(parent);
  expect(getFloatingBoundaries(anchor)).toEqual([]);
  parent.style.overflowY = "auto";
  expect(getFloatingBoundaries(anchor)).toEqual([parent]);
  parent.style.overflowY = "visible";
  expect(getFloatingBoundaries(anchor)).toEqual([]);
});

test("detached documents fall back to the positioning library's viewport boundary", () => {
  const f = fixture();
  const anchor = f.element(f.body);
  Object.assign(f.ownerDocument, { defaultView: null });
  expect(getFloatingBoundaries(anchor)).toEqual([]);
});
