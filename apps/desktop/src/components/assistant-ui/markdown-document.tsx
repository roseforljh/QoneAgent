import { useContext, type ComponentProps } from "react";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { FileReferenceContext } from "../../lib/file-reference-context";
import { documentMarkdownUrlTransform, remarkDocumentHeadings } from "../../lib/document-markdown";
import { parseMarkdownFileReference } from "../../lib/markdown-file-reference";
import { resolveFileReferencePath } from "../../lib/workspace-file-navigation";
import { useLocalFilePreview } from "../../lib/local-file-preview";
import { useLocale } from "../../localization";
import { MarkdownText } from "./elements/markdown-text";
import { MarkdownLink } from "./markdown-link";

function DocumentLink({ href, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const onClick = props.onClick;
  return <MarkdownLink {...props} href={href} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || !href?.startsWith("#")) return;
    let id: string;
    try { id = decodeURIComponent(href.slice(1)); } catch { return; }
    const document = event.currentTarget.closest("[data-markdown-document]");
    const target = [...(document?.querySelectorAll<HTMLElement>("[id]") ?? [])].find((element) => element.id === id);
    const viewport = document?.closest<HTMLElement>("[data-file-viewport]");
    if (!target || !viewport) return;
    event.preventDefault();
    viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  }} />;
}

function DocumentImage({ src, alt, node: _node, ...props }: ComponentProps<"img"> & { node?: unknown }) {
  const context = useContext(FileReferenceContext);
  const reference = parseMarkdownFileReference(src);
  const path = reference ? resolveFileReferencePath(reference.path, context?.directory, context?.root) : undefined;
  const preview = useLocalFilePreview(path, path, context?.root ?? context?.directory);
  const { t } = useLocale();
  if (preview.error) return <span role="alert" className="text-sm text-destructive" title={preview.error}>{alt || t("dock.filePreviewFailed")}</span>;
  if (reference && !preview.url) return <span className="text-sm text-muted-foreground">{alt || t("dock.fileLoading")}</span>;
  return <img {...props} src={preview.url ?? src} alt={alt ?? ""} loading="lazy" decoding="async" className="my-3 h-auto max-w-full rounded-lg" />;
}

const components = { a: DocumentLink, img: DocumentImage };
const plugins = [remarkDocumentHeadings];

export function MarkdownDocument({ text }: { text: string }) {
  return <article data-markdown-document className="q-markdown-document mx-auto w-full max-w-3xl px-6 pt-8 pb-12 select-text break-words">
    <TextMessagePartProvider text={text}>
      <MarkdownText components={components} urlTransform={documentMarkdownUrlTransform} remarkPlugins={plugins} />
    </TextMessagePartProvider>
  </article>;
}
