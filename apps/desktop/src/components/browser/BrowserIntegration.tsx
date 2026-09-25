import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Link2, LoaderCircle, Puzzle } from "lucide-react";
import { useStore } from "../../store";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

const EXTENSION_URL = "https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk";

export function BrowserIntegration() {
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const status = useStore((state) => state.browserStatus);
  const [error, setError] = useState<string>();
  const [installPromptOpen, setInstallPromptOpen] = useState(false);
  const working = status?.phase === "syncing" || status?.phase === "connecting";

  const extensionUnavailable = (message?: string) => Boolean(message && /browser bridge extension|opencli.*extension|extension.*not connected/i.test(message));

  useEffect(() => {
    if (extensionUnavailable(status?.lastError)) setInstallPromptOpen(true);
  }, [status?.lastError]);

  const connect = async () => {
    setError(undefined);
    if (!await send({ type: "browser.connect", requestId: crypto.randomUUID() })) setError("无法连接当前 Chrome");
  };

  const statusError = status?.lastError?.includes("MCP_NPX_UNAVAILABLE")
    ? "需要安装 Node.js 20.18.1 或更高版本，并确保 npx 可用" : status?.lastError;
  const summary = working ? "正在连接当前 Chrome…"
    : status?.targetConnected ? "已连接当前 Chrome"
    : "尚未连接当前 Chrome";

  return (
    <div className="apps-app-card browser-integration-card">
      <div className="browser-opencli-mark" aria-hidden="true">⌘</div>
      <strong>OpenCLI 当前浏览器</strong>
      <small className="apps-app-status" role="status">
        {working && <LoaderCircle size={12} className="settings-spin" aria-hidden="true" />}{summary}
      </small>
      <p>AI 会直接操作你当前 Chrome，复用现有登录态和页面，不复制 Cookies，也不维护另一份 Qone 浏览器。</p>
      <div className="apps-app-actions">
        <button type="button" className="settings-secondary-action" disabled={working || !connected} onClick={() => void connect()}>
          <Link2 size={12} />连接或启动 Chrome
        </button>
      </div>
      <small className="browser-import-note">需要安装 OpenCLI Browser Bridge 扩展。首次连接成功后，Qone 会在以后启动时自动恢复；Chrome 未打开时会尝试启动你的默认 Chrome 配置。</small>
      <button type="button" className="browser-extension-link" onClick={() => void openUrl(EXTENSION_URL).catch((reason) => setError(String(reason)))}>
        安装 OpenCLI 浏览器扩展
      </button>
      {status?.bookmarkCount !== undefined && <small className="browser-import-note">已收录 {status.bookmarkCount} 条书签、{status.historyCount ?? 0} 条浏览历史</small>}
      {(error || statusError) && <small className="browser-integration-error" role="alert">{error || statusError}</small>}
      {status?.libraryError && <small className="browser-integration-error" role="alert">书签或历史读取失败：{status.libraryError}</small>}
      <Dialog open={installPromptOpen} onOpenChange={setInstallPromptOpen}>
        <DialogContent className="browser-install-dialog">
          <DialogHeader>
            <div className="browser-install-dialog-icon" aria-hidden="true"><Puzzle size={18} /></div>
            <DialogTitle>需要安装 OpenCLI 浏览器扩展</DialogTitle>
            <DialogDescription>
              Qone 检测到 OpenCLI Browser Bridge 尚未安装或尚未连接。安装后，AI 才能直接操作当前 Chrome 并复用你的登录态。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallPromptOpen(false)}>稍后安装</Button>
            <Button onClick={() => { setInstallPromptOpen(false); void openUrl(EXTENSION_URL).catch((reason) => setError(String(reason))); }}>去安装扩展</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
