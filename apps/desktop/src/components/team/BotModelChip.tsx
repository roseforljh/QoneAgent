import { useStore } from "../../store";
import type { TeamBot } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { ModelLogo } from "../assistant-ui/model-logo";

/** 只展示成员单独指定的模型；跟随默认时由编辑入口查看。 */
export function BotModelChip({ bot, onClick }: { bot: Pick<TeamBot, "modelId">; onClick: () => void }) {
  const { t } = useLocale();
  const model = useStore((state) => bot.modelId
    ? state.modelConfigs.find((item) => item.id === bot.modelId && item.enabled)
    : undefined);
  if (!model) return null;
  const displayName = model.config.displayName;
  const label = typeof displayName === "string" && displayName ? displayName : model.model;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`${t("team.dialog.botModel")}：${label}`}
      title={label}
      className="team-model-chip"
    >
      <ModelLogo modelName={model.model} label={label} size={11} />
      <span className="truncate">{label}</span>
    </button>
  );
}
