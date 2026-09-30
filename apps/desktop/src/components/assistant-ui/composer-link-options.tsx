import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, $getNodeByKey, HISTORY_PUSH_TAG } from "lexical";
import { Popover } from "radix-ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasTauriBridge } from "../../store";
import { useLocale } from "../../localization";
import { Button } from "../ui/Button";
import { CodexIcon } from "../ui/CodexIcon";
import openIcon from "../../assets/codex-icons/open-link-light-16.svg";
import textIcon from "../../assets/codex-icons/text-select-light-16.svg";
import linkIcon from "../../assets/codex-icons/link-light-16.svg";
import { $composerLinkInfo, $editComposerLink } from "./composer-link-editor";
import { isComposerLinkHref } from "./composer-link-node";

type LinkDraft = NonNullable<ReturnType<typeof $composerLinkInfo>> & {
  element: HTMLElement;
  mode: "actions" | "text" | "url";
  value: string;
  error: boolean;
};

/** Codex tNc: clicking a link opens actions, then edits its text or URL. */
export function ComposerLinkOptionsPlugin() {
  const [editor] = useLexicalComposerContext();
  const { t } = useLocale();
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const close = useCallback(() => setDraft(null), []);

  useEffect(() => {
    const activate = (event: MouseEvent | KeyboardEvent) => {
      if (!editor.isEditable() || !(event.target instanceof Element)) return;
      if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) return;
      const element = event.target.closest<HTMLElement>(".q-composer-link[text-link-href]");
      if (!element || !editor.getRootElement()?.contains(element)) return;
      const info = editor.getEditorState().read(() => $composerLinkInfo($getNearestNodeFromDOMNode(element)));
      if (!info) return;
      event.preventDefault();
      event.stopPropagation();
      setDraft({ ...info, element, mode: "actions", value: "", error: false });
    };
    return editor.registerRootListener((root, previous) => {
      previous?.removeEventListener("click", activate);
      previous?.removeEventListener("keydown", activate, true);
      root?.addEventListener("click", activate);
      root?.addEventListener("keydown", activate, true);
    });
  }, [editor]);

  useEffect(() => {
    if (!draft) return;
    const removeUpdate = editor.registerUpdateListener(({ editorState }) => {
      const current = editorState.read(() => $composerLinkInfo($getNodeByKey(draft.key)));
      if (!draft.element.isConnected || !current || current.text !== draft.text || current.href !== draft.href) close();
    });
    const removeEditable = editor.registerEditableListener((editable) => { if (!editable) close(); });
    return () => { removeUpdate(); removeEditable(); };
  }, [draft, close, editor]);

  useEffect(() => {
    if (!draft) return;
    draft.element.setAttribute("aria-expanded", "true");
    return () => { draft.element.setAttribute("aria-expanded", "false"); };
  }, [draft?.element]);

  if (!draft) return null;
  const save = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const value = draft.value.trim();
    if ((draft.mode === "text" && !value) || (draft.mode === "url" && value && !isComposerLinkHref(value))) {
      setDraft({ ...draft, error: true });
      return;
    }
    editor.update(() => {
      $editComposerLink(draft.key, draft.mode === "text" ? value : draft.text, draft.mode === "url" ? value || null : draft.href);
    }, { tag: HISTORY_PUSH_TAG });
    close();
  };
  return <Popover.Root open onOpenChange={(open) => { if (!open) close(); }}>
    <Popover.Anchor virtualRef={{ current: draft.element }} />
    <Popover.Portal>
      <Popover.Content
        className={`q-composer-link-options ${draft.mode !== "actions" ? "is-editing" : ""}`}
        side="top" align="start" sideOffset={8} aria-label={t("composer.linkOptions")}
        onCloseAutoFocus={(event) => { event.preventDefault(); editor.focus(); }}
        onPointerDownOutside={(event) => { if (event.target instanceof Node && draft.element.contains(event.target)) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (draft.mode !== "actions") { event.preventDefault(); setDraft({ ...draft, mode: "actions", error: false }); } }}
      >
        {draft.mode === "actions" ? <>
          <Button variant="ghost" size="sm" autoFocus onClick={() => {
            if (hasTauriBridge()) void openUrl(draft.href)
              .then(() => setDraft((current) => current?.key === draft.key ? null : current))
              .catch(() => setDraft((current) => current?.key === draft.key ? { ...current, error: true } : current));
            else { window.open(draft.href, "_blank", "noopener,noreferrer"); close(); }
          }}><CodexIcon src={openIcon} className="size-4" />{t("composer.openLink")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, mode: "text", value: draft.text, error: false })}><CodexIcon src={textIcon} className="size-4" />{t("composer.editLinkText")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, mode: "url", value: draft.href, error: false })}><CodexIcon src={linkIcon} className="size-4" />{t("composer.editLinkUrl")}</Button>
          {draft.error && <span role="alert" className="text-xs text-destructive">{t("composer.linkOpenFailed")}</span>}
        </> : <form onSubmit={save}>
          <input autoFocus autoComplete="off" aria-label={t(draft.mode === "text" ? "composer.linkText" : "composer.linkUrl")} aria-invalid={draft.error} value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value, error: false })} />
          <Button size="sm" variant="ghost" type="submit">{t(draft.mode === "url" && !draft.value.trim() ? "composer.removeLink" : "common.save")}</Button>
          {draft.error && <span role="alert" className="text-xs text-destructive">{t("composer.invalidLink")}</span>}
        </form>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
