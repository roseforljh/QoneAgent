import { useLocale } from "../../localization";
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Link2, LoaderCircle, Puzzle } from "lucide-react";
import opencliLogo from "../../assets/app-icons/opencli.png";
import { useStore } from "../../store";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { AppStatusIndicator } from "../apps/AppStatusIndicator";

const EXTENSION_URL = "https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk";

export function BrowserIntegration() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const status = useStore((state) => state.browserStatus);
  const [error, setError] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [installPromptOpen, setInstallPromptOpen] = useState(false);
  const working = status?.phase === "syncing" || status?.phase === "connecting";

  useEffect(() => {
    if (status?.errorCode === "bridge-unavailable") {
      setDetailsOpen(true);
      setInstallPromptOpen(true);
    }
  }, [status?.errorCode, status?.lastError]);

  const connect = async () => {
    setError(undefined);
    if (!await send({ type: "browser.connect", requestId: crypto.randomUUID() })) setError(t("browser.connectFailed"));
  };

  const statusError = status?.errorCode === "npx-unavailable"
    ? t("browser.nodeRequired") : status?.lastError;
  const indicatorStatus = working ? "loading" : status?.phase === "error" || statusError ? "error" : status?.targetConnected ? "success" : "pending";
  const indicatorLabel = working ? t("browser.connecting") : indicatorStatus === "success" ? t("browser.connected") : indicatorStatus === "error" ? t("browser.connectFailed") : t("browser.disconnected");
  const summary = working ? t("browser.connecting")
    : status?.targetConnected ? t("browser.connected")
    : t("browser.disconnected");

  const openExtension = () => void openUrl(EXTENSION_URL).catch((reason) => setError(String(reason)));

  return (
    <div
      className="downloader-app-card browser-integration-card"
      role="button"
      tabIndex={0}
      aria-label={t("browser.title")}
      onClick={() => setDetailsOpen(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setDetailsOpen(true);
        }
      }}
    >
      <AppStatusIndicator status={indicatorStatus} label={indicatorLabel} />
      <div className="browser-opencli-mark" aria-hidden="true"><img src={opencliLogo} alt="" /></div>
      <strong>{t("browser.title")}</strong>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="browser-integration-dialog" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t("browser.title")}</DialogTitle>
            <DialogDescription>{t("browser.description")}</DialogDescription>
          </DialogHeader>
          <div className="browser-integration-dialog-body">
            <p>{t("browser.bridgeHint")}</p>
            <p className="apps-app-status">{working && <LoaderCircle size={12} className="settings-spin" aria-hidden="true" />}{summary}</p>
            {status?.bookmarkCount !== undefined && <p>{t("browser.libraryCount", { bookmarks: status.bookmarkCount, history: status.historyCount ?? 0 })}</p>}
            {(error || statusError) && <p className="browser-integration-error" role="alert">{error || statusError}</p>}
            {status?.libraryError && <p className="browser-integration-error" role="alert">{t("browser.libraryFailed", { error: status.libraryError })}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailsOpen(false)}>{t("common.close")}</Button>
            <Button disabled={working || !connected} onClick={() => void connect()}><Link2 size={14} />{t("browser.connect")}</Button>
            <Button variant="outline" onClick={openExtension}>{t("browser.installExtension")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={installPromptOpen} onOpenChange={setInstallPromptOpen}>
        <DialogContent className="browser-install-dialog" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <div className="browser-install-dialog-icon" aria-hidden="true"><Puzzle size={18} /></div>
            <DialogTitle>{t("browser.extensionRequired")}</DialogTitle>
            <DialogDescription>{t("browser.extensionDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallPromptOpen(false)}>{t("browser.installLater")}</Button>
            <Button onClick={() => { setInstallPromptOpen(false); openExtension(); }}>{t("browser.installNow")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
