import { useConversationStore } from "../../lib/conversation-context";
import { localizeError } from "../../lib/error-localization";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AudioLinesIcon, FilmIcon, FolderOpenIcon } from "lucide-react";
import { useMemo, type FC } from "react";
import { useStore } from "../../store";
import { useLocale } from "../../localization";

/** Generated files remain on disk; this card keeps them accessible after reopening a chat. */
export const GeneratedMediaArtifacts: FC<{ runIds: readonly string[] }> = ({ runIds }) => {
  const artifacts = useConversationStore((state) => state.artifacts);
  const { locale } = useLocale();
  const visible = useMemo(() => {
    const ids = new Set(runIds);
    return artifacts.filter((artifact) => artifact.runId && ids.has(artifact.runId) && (artifact.type === "audio" || artifact.type === "video"));
  }, [artifacts, runIds]);
  if (!visible.length) return null;
  return <div className="flex flex-col gap-2 py-2">
    {visible.map((artifact) => <div key={artifact.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-foreground/[0.025] px-3 py-2.5">
      {artifact.type === "audio" ? <AudioLinesIcon size={18} aria-hidden="true" /> : <FilmIcon size={18} aria-hidden="true" />}
      <div className="min-w-0 flex-1"><strong className="block text-sm">{artifact.type === "audio" ? (locale === "zh-CN" ? "生成的语音" : "Generated speech") : (locale === "zh-CN" ? "生成的视频" : "Generated video")}</strong><span className="block truncate text-xs text-foreground/55" title={artifact.path}>{artifact.name}</span></div>
      <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground/70 hover:bg-foreground/10 hover:text-foreground" onClick={() => void revealItemInDir(artifact.path).catch((error) => useStore.setState({ lastError: localizeError(error) }))}>
        <FolderOpenIcon size={14} aria-hidden="true" />{locale === "zh-CN" ? "定位文件" : "Show file"}
      </button>
    </div>)}
  </div>;
};
