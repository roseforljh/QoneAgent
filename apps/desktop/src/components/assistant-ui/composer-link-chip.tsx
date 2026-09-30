import type { DirectiveChipProps } from "@assistant-ui/react-lexical";
import type { CSSProperties } from "react";
import { composerLinkAppearance } from "./composer-link-appearance";
import { composerLinkDirectiveType } from "./composer-link-formatter";
import { ComposerToolChip } from "./composer-tools";

export function ComposerDirectiveChip(props: DirectiveChipProps) {
  if (props.directiveType !== composerLinkDirectiveType) return <ComposerToolChip {...props} />;
  const appearance = composerLinkAppearance(props.directiveId);
  return <span
    className="q-composer-link"
    data-link-title=""
    text-link-href={props.directiveId}
    rich-link-source-app-id={appearance.sourceAppId}
    data-link-multicolor={appearance.multicolor === true}
    title={props.directiveId}
    tabIndex={0}
    role="button"
    aria-haspopup="dialog"
    style={{ "--q-composer-link-icon": `url("${appearance.src}")` } as CSSProperties}
  >{props.label}</span>;
}
