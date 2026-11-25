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

/** Keep local file destinations (links and embedded media) without weakening protocol sanitization. */
export const markdownUrlTransform: UrlTransform = (url, key) =>
  (key === "href" || key === "src") && parseMarkdownFileReference(url) ? url : defaultUrlTransform(url);

export function fileReferenceLabel(reference: MarkdownFileReference): string {
  return `${reference.path}${reference.line ? `:${reference.line}${reference.column ? `:${reference.column}` : ""}${reference.endLine ? `–${reference.endLine}` : ""}` : ""}`;
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const INLINE_CODE_PATH_PREFIX = /^(?:[a-z]:[\\/]|\\\\[^\\/\s]+\\[^\\/\s]+\\|\/(?!\/)|\.{1,2}[\\/]|file:)/i;
const INVALID_INLINE_PATH = /(?:[*<>|";`]|&&|\|\||\s--?[a-z])/i;
const KNOWN_EXTENSIONLESS_FILES = /^(?:dockerfile|containerfile|makefile|gnumakefile|justfile|procfile|gemfile|rakefile|brewfile|vagrantfile|jenkinsfile|caddyfile|license|readme|changelog|codeowners)$/i;

function isLikelyFileName(name: string): boolean {
  if (KNOWN_EXTENSIONLESS_FILES.test(name)) return true;
  if (/^\.[a-z][a-z\d._-]*$/i.test(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return !/\s$/.test(name.slice(0, dot)) && /^(?=.*[a-z])[a-z\d]{1,16}$/i.test(name.slice(dot + 1));
}

/** 仅将具备明确文件特征的行内代码转为文件引用，避免误把 `/24`、斜杠命令、路由、正则、目录或命令参数吞成文件芯片。 */
function isInlineFileReference(raw: string, reference: MarkdownFileReference): boolean {
  const path = reference.path;
  if (INVALID_INLINE_PATH.test(path)) return false;
  const segments = path.split("/");
  const name = segments.at(-1);
  if (!name || name === "." || name === "..") return false;
  if (raw.startsWith("/") && segments.filter(Boolean).length < 2) return false;
  if (path.startsWith("//") && segments.filter(Boolean).length < 3) return false;
  return isLikelyFileName(name);
}

/** Reuse file links for complete, explicit paths in inline code, never code blocks or link labels. */
export function remarkMarkdownFileReferences() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "code" || node.type === "link" || node.type === "linkReference") return;
      node.children?.forEach((child, index) => {
        if (child.type === "inlineCode" && child.value && INLINE_CODE_PATH_PREFIX.test(child.value)) {
          const reference = parseMarkdownFileReference(child.value);
          if (reference && isInlineFileReference(child.value, reference)) {
            const name = reference.path.split("/").at(-1)!;
            node.children![index] = {
              type: "link", url: child.value,
              children: [{ type: "text", value: fileReferenceLabel({ ...reference, path: name }) }],
            };
          }
        } else visit(child);
      });
    };
    visit(tree);
  };
}
