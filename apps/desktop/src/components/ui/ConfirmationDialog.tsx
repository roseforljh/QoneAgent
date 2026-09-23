import { useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { Button } from "./Button";
import { useLocale } from "../../localization";
import { getConfirmationRequest, resolveConfirmation, subscribeConfirmation } from "../../lib/confirm-action";
import "./confirmation-dialog.css";

export function ConfirmationDialogHost() {
  const request = useSyncExternalStore(subscribeConfirmation, getConfirmationRequest, getConfirmationRequest);
  const { t } = useLocale();

  return (
    <AlertDialog.Root open={Boolean(request)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="q-confirm-layer" />
        <AlertDialog.Content className="q-confirm-dialog" onEscapeKeyDown={() => resolveConfirmation(false)}>
          <div className="q-confirm-icon" aria-hidden="true"><AlertTriangle size={18} /></div>
          <div className="q-confirm-content">
            <AlertDialog.Title>{t("common.confirmAction")}</AlertDialog.Title>
            <AlertDialog.Description>{request?.message}</AlertDialog.Description>
          </div>
          <div className="q-confirm-actions">
            <AlertDialog.Cancel asChild><Button variant="ghost" size="sm" onClick={() => resolveConfirmation(false)}>{t("common.cancel")}</Button></AlertDialog.Cancel>
            <AlertDialog.Action asChild><Button variant="destructive" size="sm" onClick={() => resolveConfirmation(true)}>{t("common.delete")}</Button></AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
