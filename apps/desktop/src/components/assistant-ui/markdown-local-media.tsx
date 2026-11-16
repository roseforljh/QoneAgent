import type { ComponentProps } from "react";
import { mediaMimeTypeFromName } from "@qone/protocol";
import { useConversationStore } from "../../lib/conversation-context";
import { conversationSession } from "../../lib/session-execution-state";
import { parseMarkdownFileReference, type MarkdownFileReference } from "../../lib/markdown-file-reference";
import { resolveFileReferencePath } from "../../lib/workspace-file-navigation";
import { useLocalFilePreview } from "../../lib/local-file-preview";
import { MarkdownFileLink } from "./markdown-file-link";
import { Image } from "./elements/image";

/** `![…](local path)` plays images, video and audio straight from disk. */
function LocalMarkdownMedia({ reference, alt }: { reference: MarkdownFileReference; alt?: string }) {
  const workspacePath = useConversationStore((state) => {
    const workspaceId = conversationSession(state)?.workspaceId;
    return state.workspaces.find((item) => item.id === workspaceId)?.path;
  });
  const path = resolveFileReferencePath(reference.path, workspacePath);
  const preview = useLocalFilePreview(path);
  const name = alt || reference.path.split("/").at(-1) || reference.path;
  if (preview.error || !path) return <MarkdownFileLink reference={reference}>{name}</MarkdownFileLink>;
  if (!preview.url) return null;
  const major = mediaMimeTypeFromName(path)?.split("/", 1)[0];
  if (major === "video") return <video src={preview.url} title={name} controls preload="metadata" playsInline className="my-3 max-h-[min(60vh,480px)] w-full rounded-xl bg-black" />;
  if (major === "audio") return <audio src={preview.url} title={name} controls preload="metadata" className="my-3 w-full" />;
  return <Image.Zoom src={preview.url} alt={name} filename={name}><Image.Preview src={preview.url} alt={name} /></Image.Zoom>;
}

export function MarkdownImage({ src, alt, node: _node, ...props }: ComponentProps<"img"> & { node?: unknown }) {
  const reference = parseMarkdownFileReference(typeof src === "string" ? src : undefined);
  if (reference) return <LocalMarkdownMedia reference={reference} alt={alt} />;
  return <img {...props} src={src} alt={alt ?? ""} loading="lazy" decoding="async" className="my-3 h-auto max-w-full rounded-lg" />;
}

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] };

/** A paragraph holding only embedded media renders as a block so players and zoom frames nest validly. */
export function MarkdownParagraph({ node, ...props }: ComponentProps<"p"> & { node?: HastNode }) {
  const mediaOnly = node?.children?.some((child) => child.tagName === "img")
    && node.children.every((child) => child.tagName === "img" || (child.type === "text" && !child.value?.trim()));
  return mediaOnly ? <div {...props} /> : <p {...props} />;
}
