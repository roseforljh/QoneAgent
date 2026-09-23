import { useMemo, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useLocale } from "../../localization";
import { Sources } from "./elements/sources";
import { messageSources } from "./message-sources";
import { hasTauriBridge } from "../../store";
import { openUrl } from "@tauri-apps/plugin-opener";

export function MessageSourcesView() {
  const parts = useAuiState((state) => state.message.parts);
  const complete = useAuiState((state) => state.message.status?.type !== "running");
  const sources = useMemo(() => complete ? messageSources(parts) : [], [parts, complete]);
  const [open, setOpen] = useState(false);
  const { locale } = useLocale();
  if (sources.length === 0) return null;
  const openSource = (url: string) => hasTauriBridge() ? void openUrl(url) : window.open(url, "_blank", "noopener,noreferrer");
  return <Sources sources={sources} open={open} onOpenChange={setOpen} onOpenSource={openSource} label={locale.startsWith("zh") ? "来源" : "Sources"} className="mt-3 max-w-md" />;
}
