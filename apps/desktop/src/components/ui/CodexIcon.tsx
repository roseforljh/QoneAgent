import type { HTMLAttributes } from "react";
import textSelect from "../../assets/codex-icons/text-select-light-16.svg";
import documentText from "../../assets/codex-icons/document-text-light-16.svg";
import target from "../../assets/codex-icons/target-light-16.svg";
import plus from "../../assets/codex-icons/plus-md-light-16.svg";
import folder from "../../assets/codex-icons/folder-light-16.svg";

type CodexIconProps = HTMLAttributes<HTMLSpanElement> & { src: string };

/** Render monochrome SVG assets with the surrounding text color. */
export function CodexIcon({ src, style, ...props }: CodexIconProps) {
  const mask = `url("${src}")`;
  return <span
    data-slot="codex-icon"
    aria-hidden="true"
    {...props}
    style={{
      display: "inline-block",
      pointerEvents: "none",
      backgroundColor: "currentColor",
      maskImage: mask,
      WebkitMaskImage: mask,
      maskSize: "contain",
      WebkitMaskSize: "contain",
      maskPosition: "center",
      WebkitMaskPosition: "center",
      maskRepeat: "no-repeat",
      WebkitMaskRepeat: "no-repeat",
      ...style,
    }}
  />;
}

export function CodexTextSelectIcon(props: Omit<CodexIconProps, "src">) {
  return <CodexIcon src={textSelect} {...props} />;
}

export function CodexDocumentTextIcon(props: Omit<CodexIconProps, "src">) {
  return <CodexIcon src={documentText} {...props} />;
}

export function CodexTargetIcon(props: Omit<CodexIconProps, "src">) {
  return <CodexIcon src={target} {...props} />;
}

export function CodexPlusIcon(props: Omit<CodexIconProps, "src">) {
  return <CodexIcon src={plus} {...props} />;
}

export function CodexFolderIcon(props: Omit<CodexIconProps, "src">) {
  return <CodexIcon src={folder} {...props} />;
}
