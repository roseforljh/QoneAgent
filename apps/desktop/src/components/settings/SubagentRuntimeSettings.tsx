import type { SubagentRuntimeConfig } from "@qone/protocol";
import { useLocale } from "../../localization";
import { QoneSelect } from "../ui/Select";

export function SubagentRuntimeSettings({ value, onChange }: { value: SubagentRuntimeConfig; onChange: (next: SubagentRuntimeConfig) => void }) {
  const { t } = useLocale();
  const set = <K extends keyof SubagentRuntimeConfig>(key: K, next: SubagentRuntimeConfig[K]) => onChange({ ...value, [key]: next });
  return <section className="settings-subagent-runtime">
    <div className="settings-subagent-runtime-grid">
      <label>{t("subagent.maxConcurrent")}<input type="number" min={1} max={32} value={value.maxConcurrent} onChange={(event) => set("maxConcurrent", Math.max(1, Number(event.target.value) || 1))} /><small>{t("subagent.recommended", { value: "4" })}</small></label>
      <label>{t("subagent.timeoutMinutes")}<input type="number" min={1} max={1440} value={Math.round(value.timeoutMs / 60_000)} onChange={(event) => set("timeoutMs", Math.max(60_000, (Number(event.target.value) || 1) * 60_000))} /><small>{t("subagent.recommended", { value: "30" })}</small></label>
      <label>{t("subagent.tokenBudget")}<input type="number" min={0} max={10_000_000} value={value.tokenBudget} onChange={(event) => set("tokenBudget", Math.max(0, Number(event.target.value) || 0))} /><small>{t("subagent.zeroUnlimited")}</small></label>
      <label>{t("subagent.contextMode")}<QoneSelect value={value.contextMode} onChange={(next) => set("contextMode", next as SubagentRuntimeConfig["contextMode"])} options={[{ value: "snapshot", label: t("subagent.contextSnapshot") }, { value: "task-only", label: t("subagent.contextTaskOnly") }]} ariaLabel={t("subagent.contextMode")} /><small>{t("subagent.contextMessages")}</small></label>
      <label>{t("subagent.contextMessageCount")}<input type="number" min={0} max={100} value={value.contextMessages} onChange={(event) => set("contextMessages", Math.max(0, Number(event.target.value) || 0))} /><small>{t("subagent.recommended", { value: "20" })}</small></label>
      <label>{t("subagent.maxDepth")}<input type="number" min={1} max={8} value={value.maxDepth} onChange={(event) => set("maxDepth", Math.max(1, Number(event.target.value) || 1))} /><small>{t("subagent.recommended", { value: "3" })}</small></label>
      <label>{t("subagent.workflowMaxSteps")}<input type="number" min={1} max={128} value={value.workflowMaxSteps} onChange={(event) => set("workflowMaxSteps", Math.max(1, Number(event.target.value) || 1))} /><small>{t("subagent.recommended", { value: "32" })}</small></label>
    </div>
    <div className="settings-subagent-switches">
      <button type="button" role="switch" aria-label={t("subagent.allowNested")} aria-checked={value.allowNested} className="settings-subagent-switch-row" onClick={() => set("allowNested", !value.allowNested)}>
        <span className="settings-subagent-switch-copy"><strong>{t("subagent.allowNested")}</strong><small>{t("subagent.maxDepth")}</small></span><span className={`settings-switch ${value.allowNested ? "is-on" : ""}`}><span /></span>
      </button>
      <button type="button" role="switch" aria-label={t("subagent.allowBackground")} aria-checked={value.backgroundEnabled} className="settings-subagent-switch-row" onClick={() => set("backgroundEnabled", !value.backgroundEnabled)}>
        <span className="settings-subagent-switch-copy"><strong>{t("subagent.allowBackground")}</strong><small>{t("subagent.runtimeDescription")}</small></span><span className={`settings-switch ${value.backgroundEnabled ? "is-on" : ""}`}><span /></span>
      </button>
    </div>
  </section>;
}
