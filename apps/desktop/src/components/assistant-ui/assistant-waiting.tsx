import { useLocale } from "../../localization";
import { ShimmerLabel } from "./elements/surfaces";
import type { AssistantWaitingPhase } from "./assistant-waiting-phase";

/** A running empty message needs feedback before the first model event. */
export function AssistantWaiting({ phase, detail }: { phase: AssistantWaitingPhase; detail?: string }) {
  const { t } = useLocale();
  return <div data-slot="assistant-waiting" data-phase={phase}
    className="min-w-0 py-1 text-sm leading-normal text-muted-foreground"
    role="status" aria-live="polite">
    <ShimmerLabel className="max-w-full truncate">{detail ?? t("chat.waiting")}</ShimmerLabel>
  </div>;
}
