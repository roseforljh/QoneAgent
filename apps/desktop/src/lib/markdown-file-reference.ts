import { defaultUrlTransform, type UrlTransform } from "react-markdown";

export interface MarkdownFileReference {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
}

/** Parse explicit Markdown destinations, never the model's display label. */
export function parseMarkdownFileReference(href: string | undefined): MarkdownFileReference | undefined {
  if (!href || href !== href.trim() || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
  let path = href;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.search) return undefined;
      path = `${url.hostname ? `//${url.hostname}` : ""}${url.pathname}${url.hash}`;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch { return undefined; }
  } else if (path.startsWith("//")) {
    // A protocol-relative web URL is not a UNC path; UNC uses \\ or file://.
    return undefined;
  }
  try { path = decodeURIComponent(path); } catch { return undefined; }
  if (/[\u0000-\u001f\u007f?]/.test(path) || path.startsWith("#")) return undefined;
  const windows = /^[a-z]:[\\/]/i.test(path);
  if (!windows && /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[^:]+\.[^:]+:\d+(?::\d+)?$/.test(path)) return undefined;

  // GitHub-style fragments and the absolute-path:line:column format used by Codex.
  const location = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?$/.exec(path)
    ?? /:(\d+)(?::(\d+))?$/.exec(path);
  let line: number | undefined;
  let column: number | undefined;
  let endLine: number | undefined;
  if (location) {
    [line, column, endLine] = location.slice(1).map((value) => value === undefined ? undefined : Number(value));
    if ([line, column, endLine].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) return undefined;
    if (endLine !== undefined && endLine < line!) return undefined;
    path = path.slice(0, location.index);
  }
  if (!path || path.includes("#") || (windows ? path.slice(2).includes(":") : path.includes(":"))) return undefined;
  return { path: path.replaceAll("\\", "/"), ...(line ? { line } : {}), ...(column ? { column } : {}), ...(endLine ? { endLine } : {}) };
}

/** Keep local anchor destinations without weakening image or protocol sanitization. */
export const markdownUrlTransform: UrlTransform = (url, key) =>
  key === "href" && parseMarkdownFileReference(url) ? url : defaultUrlTransform(url);

export function fileReferenceLabel(reference: MarkdownFileReference): string {
  return `${reference.path}${reference.line ? `:${reference.line}${reference.column ? `:${reference.column}` : ""}${reference.endLine ? `–${reference.endLine}` : ""}` : ""}`;
}
