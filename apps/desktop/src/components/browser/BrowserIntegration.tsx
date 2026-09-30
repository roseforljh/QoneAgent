import { useLocale } from "../../localization";
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Link2, LoaderCircle, Puzzle } from "lucide-react";
import { useStore } from "../../store";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

const EXTENSION_URL = "https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk";

export function BrowserIntegration() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const status = useStore((state) => state.browserStatus);
  const [error, setError] = useState<string>();
  const [installPromptOpen, setInstallPromptOpen] = useState(false);
  const working = status?.phase === "syncing" || status?.phase === "connecting";

  useEffect(() => {
    if (status?.errorCode === "bridge-unavailable") setInstallPromptOpen(true);
  }, [status?.errorCode, status?.lastError]);

  const connect = async () => {
    setError(undefined);
    if (!await send({ type: "browser.connect", requestId: crypto.randomUUID() })) setError(t("browser.connectFailed"));
  };

  const statusError = status?.errorCode === "npx-unavailable"
    ? t("browser.nodeRequired") : status?.lastError;
  const summary = working ? t("browser.connecting")
    : status?.targetConnected ? t("browser.connected")
    : t("browser.disconnected");

  return (
    <div className="apps-app-card browser-integration-card">
      <div className="browser-opencli-mark" aria-hidden="true">⌘</div>
      <strong>{t("browser.title")}</strong>
      <small className="apps-app-status" role="status">
        {working && <LoaderCircle size={12} className="settings-spin" aria-hidden="true" />}{summary}
      </small>
      <p>{t("browser.description")}</p>
      <div className="apps-app-actions">
        <button type="button" className="settings-secondary-action" disabled={working || !connected} onClick={() => void connect()}>
          <Link2 size={12} />{t("browser.connect")}</button>
      </div>
      <small className="browser-import-note">{t("browser.bridgeHint")}</small>
      <button type="button" className="browser-extension-link" onClick={() => void openUrl(EXTENSION_URL).catch((reason) => setError(String(reason)))}>{t("browser.installExtension")}</button>
      {status?.bookmarkCount !== undefined && <small className="browser-import-note">{t("browser.libraryCount", { bookmarks: status.bookmarkCount, history: status.historyCount ?? 0 })}</small>}
      {(error || statusError) && <small className="browser-integration-error" role="alert">{error || statusError}</small>}
      {status?.libraryError && <small className="browser-integration-error" role="alert">{t("browser.libraryFailed", { error: status.libraryError })}</small>}
      <Dialog open={installPromptOpen} onOpenChange={setInstallPromptOpen}>
        <DialogContent className="browser-install-dialog">
          <DialogHeader>
            <div className="browser-install-dialog-icon" aria-hidden="true"><Puzzle size={18} /></div>
            <DialogTitle>{t("browser.extensionRequired")}</DialogTitle>
            <DialogDescription>{t("browser.extensionDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallPromptOpen(false)}>{t("browser.installLater")}</Button>
            <Button onClick={() => { setInstallPromptOpen(false); void openUrl(EXTENSION_URL).catch((reason) => setError(String(reason))); }}>{t("browser.installNow")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
