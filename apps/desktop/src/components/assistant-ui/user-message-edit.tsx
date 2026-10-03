import { ComposerPrimitive } from "@assistant-ui/react";
import { useLocale } from "../../localization";
import { Button } from "../ui/Button";
import { ComposerAttachments } from "./elements/attachment.aui";

export function UserMessageEditComposer() {
  const { t } = useLocale();
  return (
    <ComposerPrimitive.Root className="q-user-message-edit w-full max-w-[70%] rounded-2xl bg-muted/50">
      <ComposerAttachments />
      <ComposerPrimitive.Input
        autoFocus
        submitMode="none"
        placeholder={t("chat.editMessage")}
        aria-label={t("chat.editMessage")}
        className="q-user-message-edit-input relative min-h-11 max-h-48 w-full resize-none bg-transparent px-3 py-2 text-sm leading-5 outline-none"
      />
      <div className="q-user-message-edit-actions flex justify-end gap-1.5 px-3 pb-3">
        <ComposerPrimitive.Cancel asChild>
          <Button type="button" variant="outline" size="sm">{t("chat.cancelEdit")}</Button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <Button type="submit" size="sm">{t("chat.saveEdit")}</Button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}
