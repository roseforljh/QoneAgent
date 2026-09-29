import { createElement } from "react";

type PreviewKind = "html" | "svg" | "markdown" | "mermaid" | "javascript" | "typescript" | "jsx" | "tsx";

const languages: Record<string, PreviewKind> = {
  html: "html", htm: "html",
  svg: "svg",
  md: "markdown", markdown: "markdown",
  mermaid: "mermaid",
  js: "javascript", javascript: "javascript", mjs: "javascript",
  ts: "typescript", typescript: "typescript",
  jsx: "jsx", tsx: "tsx",
};

function previewKind(language: string | undefined): PreviewKind | undefined {
  return languages[language?.trim().toLowerCase() ?? ""];
}

export function canPreviewCode(language: string | undefined, code: string): boolean {
  const kind = previewKind(language);
  return !!kind && !!code.trim() && (kind !== "svg" || /<svg(?:\s|>)/i.test(code));
}

function escapeScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

function htmlDocument(body: string, script?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}${script ? `<script>${escapeScript(script)}</script>` : ""}</body></html>`;
}

function scriptDocument(code: string): string {
  const runner = `
    const output = document.getElementById("preview-output");
    const write = (...args) => { output.textContent += args.map(String).join(" ") + "\\n"; };
    console.log = write;
    console.info = write;
    console.warn = write;
    console.error = write;
    window.addEventListener("error", event => write(event.message));
    window.addEventListener("unhandledrejection", event => write(event.reason));
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    try {
      new AsyncFunction(${JSON.stringify(code).replace(/</g, "\\u003c")})().catch(write);
    } catch (error) {
      write(error);
    }
  `;
  return htmlDocument('<pre id="preview-output"></pre>', runner);
}

export async function createCodePreviewHtml(language: string | undefined, code: string): Promise<string | undefined> {
  if (!canPreviewCode(language, code)) return undefined;
  const kind = previewKind(language);
  if (kind === "html") return code;
  if (kind === "svg") return htmlDocument(code);
  if (kind === "mermaid") {
    const { renderMermaidSVG } = await import("beautiful-mermaid");
    return htmlDocument(renderMermaidSVG(code));
  }
  if (kind === "markdown") {
    const [{ default: Markdown }, { renderToStaticMarkup }, { remarkQoneGfm }] = await Promise.all([
      import("react-markdown"), import("react-dom/server"), import("./markdown-gfm"),
    ]);
    const markup = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkQoneGfm], children: code }));
    return htmlDocument(markup);
  }

  const ts = await import("typescript");
  const isReact = kind === "jsx" || kind === "tsx";
  const result = ts.transpileModule(code, {
    fileName: isReact ? `preview.${kind}` : kind === "typescript" ? "preview.ts" : "preview.js",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: isReact ? ts.ModuleKind.CommonJS : ts.ModuleKind.None,
      jsx: ts.JsxEmit.React,
    },
  });
  const error = result.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));

  if (!isReact) return scriptDocument(result.outputText);

  const { default: runtime } = await import("virtual:qone-react-preview-runtime");
  const run = `
    try {
      window.__qonePreview.mount(${JSON.stringify(result.outputText).replace(/</g, "\\u003c")});
    } catch (error) {
      document.getElementById("preview-error").textContent = String(error);
    }
  `;
  return htmlDocument('<div id="preview-root"></div><pre id="preview-error" style="color:#b91c1c;white-space:pre-wrap"></pre>', `${runtime}\n${run}`);
}
