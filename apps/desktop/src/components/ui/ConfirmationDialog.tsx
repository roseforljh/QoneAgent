import { useEffect, useSyncExternalStore } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { Button } from "./Button";
import { useLocale } from "../../localization";
import { getConfirmationRequest, resolveConfirmation, subscribeConfirmation } from "../../lib/confirm-action";
import { acquireNativeOverlayLock } from "../../lib/dock-browser-session";
import "./confirmation-dialog.css";

export function ConfirmationDialogHost() {
  const request = useSyncExternalStore(subscribeConfirmation, getConfirmationRequest, getConfirmationRequest);
  const { t } = useLocale();
  const destructive = request?.destructive !== false;
  useEffect(() => (request ? acquireNativeOverlayLock() : undefined), [request]);

  return (
    <AlertDialog.Root open={Boolean(request)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="q-confirm-layer" />
        <AlertDialog.Content className="q-confirm-dialog" data-tone={destructive ? "destructive" : "default"} onEscapeKeyDown={() => resolveConfirmation(false)}>
          <div className="q-confirm-icon" aria-hidden="true">{destructive ? <AlertTriangle size={18} /> : <Download size={18} />}</div>
          <div className="q-confirm-content">
            <AlertDialog.Title>{request?.title ?? t("common.confirmAction")}</AlertDialog.Title>
            <AlertDialog.Description>{request?.message}</AlertDialog.Description>
          </div>
          <div className="q-confirm-actions">
            <AlertDialog.Cancel asChild><Button variant="secondary" size="sm" onClick={() => resolveConfirmation(false)}>{request?.cancelLabel ?? t("common.cancel")}</Button></AlertDialog.Cancel>
            <AlertDialog.Action asChild><Button variant={destructive ? "destructive" : "default"} size="sm" onClick={() => resolveConfirmation(true)}>{request?.confirmLabel ?? t("common.delete")}</Button></AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
