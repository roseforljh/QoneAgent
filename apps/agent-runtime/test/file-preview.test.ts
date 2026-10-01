import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePreviewText, readFilePreview, resolveFilePreviewPath } from "../src/file-preview";
import { MAX_PREVIEW_BYTES } from "../src/workspace";
import { withRuntimeLocale } from "../src/runtime-localization";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("file preview", () => {
  test("reads Markdown and HTML content for their renderers", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qone-preview-"));
    roots.push(root);
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "readme.md"), "# Title\n\n[link](./next.md)\n", "utf8");
    writeFileSync(path.join(root, "docs", "page.html"), "<main>Hello</main>", "utf8");
    await expect(readFilePreview("docs/readme.md", root)).resolves.toMatchObject({ kind: "markdown", content: "# Title\n\n[link](./next.md)\n", truncated: false });
    await expect(readFilePreview("docs/page.html", root)).resolves.toMatchObject({ kind: "html", content: "<main>Hello</main>" });
  });

  test("marks binary data without returning bytes to the renderer", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qone-preview-"));
    roots.push(root);
    writeFileSync(path.join(root, "archive.bin"), Buffer.from([0, 1, 2, 3]));
    const preview = await readFilePreview("archive.bin", root);
    expect(preview).toMatchObject({ kind: "binary", size: 4 });
    expect(preview).not.toHaveProperty("content");
  });

  test.skipIf(process.platform !== "win32")("resolves a root relative link from a real Windows workspace", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qone-preview-"));
    roots.push(root);
    const directory = `docs-${crypto.randomUUID()}`;
    mkdirSync(path.join(root, directory));
    const file = path.join(root, directory, "readme.md");
    writeFileSync(file, "# Document", "utf8");
    await expect(resolveFilePreviewPath(`/${directory}/readme.md`, root)).resolves.toBe(file);
  });

  test("explicitly loads the complete document after a bounded initial preview", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qone-preview-"));
    roots.push(root);
    const content = "a".repeat(MAX_PREVIEW_BYTES) + "\n# End of document\n";
    const file = path.join(root, "guide.md");
    writeFileSync(file, content, "utf8");
    const preview = await readFilePreview(file);
    expect(preview).toMatchObject({ kind: "markdown", truncated: true });
    expect(preview.content?.length).toBe(MAX_PREVIEW_BYTES);
    await expect(readFilePreview(file, undefined, true)).resolves.toMatchObject({ content, truncated: false });
  });

  test("reads absolute files outside a workspace and requires a base for relative paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "qone-preview-"));
    roots.push(root);
    const file = path.join(root, "guide.md");
    writeFileSync(file, "# External document", "utf8");
    await expect(readFilePreview(file)).resolves.toMatchObject({ absolutePath: file, kind: "markdown", content: "# External document" });
    await withRuntimeLocale("en", async () => {
      await expect(readFilePreview("guide.md")).rejects.toThrow("A workspace is required");
      await expect(readFilePreview(root)).rejects.toThrow("Not a regular file");
      await expect(resolveFilePreviewPath("\u0000")).rejects.toThrow("Invalid file path");
    });
    await withRuntimeLocale("zh-CN", async () => {
      await expect(readFilePreview("guide.md")).rejects.toThrow("预览相对路径文件需要工作区");
      await expect(readFilePreview(root)).rejects.toThrow("不是普通文件");
      await expect(resolveFilePreviewPath("\u0000")).rejects.toThrow("文件路径无效");
    });
  });

  test("decodes Unicode documents while keeping actual binary bytes out of text renderers", () => {
    expect(decodePreviewText(new TextEncoder().encode("ok"), false)).toBe("ok");
    expect(decodePreviewText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文文档", "utf16le")]), false)).toBe("中文文档");
    expect(decodePreviewText(Buffer.from([0, 1, 2]), false)).toBeUndefined();
    expect(decodePreviewText(Buffer.from([0xff]), false)).toBeUndefined();
  });
});
