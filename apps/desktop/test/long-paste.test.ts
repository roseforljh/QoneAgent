import { expect, test } from "bun:test";
import { createEditor, PASTE_COMMAND, type PasteCommandType } from "lexical";
import {
  getPastedTextFileName,
  LONG_PASTE_CHAR_LIMIT,
  shouldConvertLongPaste,
} from "../src/lib/long-paste";
import { getPastedFiles, registerPasteAttachment } from "../src/components/assistant-ui/long-paste-attachment";

test("short pasted text stays in the composer", () => {
  expect(shouldConvertLongPaste("普通的一句话")).toBe(false);
  expect(shouldConvertLongPaste("x".repeat(LONG_PASTE_CHAR_LIMIT - 1))).toBe(false);
});

test("long pasted text becomes a document title based on its first line", () => {
  const text = `PS C:\\Users\\33039\\Desktop\\QoneAgent> bun run\n${"x".repeat(LONG_PASTE_CHAR_LIMIT)}`;
  expect(shouldConvertLongPaste(text)).toBe(true);
  expect(getPastedTextFileName(text)).toBe("PS C:\\Users\\33039\\Desktop\\QoneAgent> bun run");
});

test("very long first lines are safely truncated for display", () => {
  expect(getPastedTextFileName("a".repeat(120))).toHaveLength(96);
});

function createPasteEvent(options: { files?: File[]; items?: Array<{ kind: string; getAsFile: () => File | null }>; text?: string }) {
  let prevented = false;
  const event = {
    clipboardData: {
      files: options.files ?? [],
      items: options.items ?? [],
      getData: (type: string) => type === "text/plain" ? (options.text ?? "") : "",
    },
    preventDefault: () => { prevented = true; },
  } as unknown as PasteCommandType;
  return { event, wasPrevented: () => prevented };
}

test("pasting images from clipboardData.files or items adds attachments and prevents default", () => {
  const editor = createEditor({ namespace: "paste-attachment-test", onError: (error) => { throw error; } });
  const attached: File[] = [];
  let allowed = true;
  const unregister = registerPasteAttachment(editor, {
    canAttach: () => allowed,
    addAttachment: async (file) => { attached.push(file); },
  });

  try {
    const img1 = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const img2 = new File([new Uint8Array([4, 5, 6])], "photo.jpg", { type: "image/jpeg" });

    // 从 clipboardData.files 粘贴多张图片
    const filesPaste = createPasteEvent({ files: [img1, img2] });
    expect(editor.dispatchCommand(PASTE_COMMAND, filesPaste.event)).toBe(true);
    expect(filesPaste.wasPrevented()).toBe(true);
    expect(attached).toEqual([img1, img2]);

    // files 为空时回退读取 clipboardData.items 中的图片
    attached.length = 0;
    const itemsPaste = createPasteEvent({ items: [{ kind: "file", getAsFile: () => img1 }, { kind: "string", getAsFile: () => null }] });
    expect(getPastedFiles(itemsPaste.event)).toEqual([img1]);
    expect(editor.dispatchCommand(PASTE_COMMAND, itemsPaste.event)).toBe(true);
    expect(itemsPaste.wasPrevented()).toBe(true);
    expect(attached).toEqual([img1]);

    // 不支持附件时不拦截
    attached.length = 0;
    allowed = false;
    const blocked = createPasteEvent({ files: [img1] });
    expect(editor.dispatchCommand(PASTE_COMMAND, blocked.event)).toBe(false);
    expect(blocked.wasPrevented()).toBe(false);
    expect(attached).toEqual([]);
  } finally {
    unregister();
  }
});
