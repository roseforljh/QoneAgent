import { LoaderCircle } from "lucide-react";

export type AppStatus = "loading" | "success" | "error" | "pending";

export function AppStatusIndicator({ status, label }: { status: AppStatus; label: string }) {
  return (
    <span className={`downloader-app-status-indicator is-${status}`} role="status" aria-label={label} title={label}>
      {status === "loading" ? <LoaderCircle size={14} aria-hidden="true" /> : <span aria-hidden="true" />}
    </span>
  );
}
