import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  EXECUTION_STATS_RANGES, emptyStats, executionModelKey,
  type ExecutionStatsPeriod, type ExecutionStatsRange, type ModelUsageStats,
} from "@qone/protocol";
import { useStore } from "../../../store";
import { sendStatsCommand, useExecutionStatsStore } from "../../../lib/execution-stats-state";
import { useLocale } from "../../../localization";
import { SectionHeader, SettingsPageHeader, SettingsSelect } from "../settings-chrome";
import { RecordSwitch } from "./execution-controls";
import "./execution.css";

const RANGE_LABEL_KEYS = { today: "execution.rangeToday", "7d": "execution.range7d", "30d": "execution.range30d" } as const;
const ALL_MODELS = "";
const modelKey = ({ provider, model }: { provider: string; model: string }) => executionModelKey(provider, model);
const totalTokens = (row: ModelUsageStats) => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;

export function ExecutionSection() {
  const { t, locale } = useLocale();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const { state: snapshot, periods, pending, error } = useExecutionStatsStore();
  const [range, setRange] = useState<ExecutionStatsRange>("today");
  const [selectedModel, setSelectedModel] = useState<string>();
  const [reload, setReload] = useState(0);
  // Usage and errors come from the same range; switch state comes from the latest snapshot.
  const cached = periods[range];
  const models = useMemo(() => {
    const keys = new Map<string, { provider: string; model: string }>();
    for (const model of snapshot?.models ?? []) keys.set(modelKey(model), model);
    for (const view of Object.values(periods)) {
      for (const model of [...view.period.rows, ...view.incidents]) keys.set(modelKey(model), model);
    }
    return keys;
  }, [snapshot?.models, periods]);
  const model = selectedModel === ALL_MODELS || (selectedModel !== undefined && models.has(selectedModel))
    ? selectedModel : models.keys().next().value ?? ALL_MODELS;
  const all = model === ALL_MODELS;
  const run = (command: Parameters<typeof sendStatsCommand>[0]) => sendStatsCommand(command, send);
  const write = async (command: Parameters<typeof sendStatsCommand>[0]) => {
    const ok = await run(command);
    if (ok) setReload((value) => value + 1);
    return ok;
  };
  useEffect(() => {
    if (connected) void run({ type: "stats.get", range });
  }, [connected, range, reload]);

  const token = useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale]);
  const count = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  // The protocol already returns percentage points (80 means 80%), undefined means no reported data.
  const rate = (value?: number) => value === undefined ? t("execution.cacheUnknown") : `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
  const errors = cached?.incidents.reduce((sum, row) => sum + (all || modelKey(row) === model ? row.count : 0), 0) ?? 0;

  const period = cached?.period;
  const total = all ? period?.total : period?.rows.find((row) => modelKey(row) === model);
  const usage = total ?? emptyStats("", "");
  const controlsDisabled = !connected || pending > 0;
  const formatTime = (at: number) => new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" });

  return (
    <>
      <SettingsPageHeader>
        <div className="execution-header">
          <SectionHeader eyebrow={t("execution.eyebrow")} title={t("execution.title")}>{t("execution.description")}</SectionHeader>
          <div className="execution-filters">
            <SettingsSelect value={model} ariaLabel={t("execution.modelFilter")} onChange={setSelectedModel}
              options={[
                { value: ALL_MODELS, label: t("execution.allModels") },
                ...[...models].map(([value, { model, provider }]) => ({ value, label: `${model} · ${provider}` })),
              ]} />
            <SettingsSelect value={range} ariaLabel={t("execution.period")} onChange={(value) => {
              if (value === range) setReload((count) => count + 1);
              else setRange(value as ExecutionStatsRange);
            }} options={EXECUTION_STATS_RANGES.map((value) => ({ value, label: t(RANGE_LABEL_KEYS[value]) }))} />
          </div>
        </div>
      </SettingsPageHeader>
      {error && <p className="execution-error" role="alert">{error}</p>}
      {!snapshot || !period ? <div className="execution-loading"><LoaderCircle className="animate-spin" size={18} /></div> : (
        <div className="execution-page">
          <div className="execution-period">
            <span>{t("execution.period")}</span>
            <strong>
              <time dateTime={new Date(period.from).toISOString()}>{formatTime(period.from)}</time>
              {" – "}
              <time dateTime={new Date(period.to).toISOString()}>{formatTime(period.to)}</time>
            </strong>
          </div>
          <div className="execution-totals">
            <Total label={t("execution.requests")} value={count.format(usage.requests)} />
            <Total label={t("execution.totalTokens")} value={token.format(totalTokens(usage))} />
            <Total label={t("execution.cacheHit")} value={rate(usage.cacheHitRate)} />
            <Total label={t("execution.errors")} value={count.format(errors)} />
            <Total label={t("execution.inputTokens")} value={token.format(usage.inputTokens)} />
            <Total label={t("execution.outputTokens")} value={token.format(usage.outputTokens)} />
            <Total label={t("execution.cacheReadTokens")} value={token.format(usage.cacheReadTokens)} />
            <Total label={t("execution.cacheWriteTokens")} value={token.format(usage.cacheWriteTokens)} />
          </div>
          {usage.requests > 0 ? <SourceBreakdown sources={period.sources} model={model} token={token} count={count} rate={rate} />
            : <p className="execution-note">{t("execution.noUsage")}</p>}
          <section className="execution-block" aria-label={t("execution.recordsTitle")}>
            <h3>{t("execution.recordsTitle")}</h3>
            <div className="execution-switches">
              <RecordSwitch checked={snapshot.recording} disabled={controlsDisabled} label={t("execution.recordLabel")}
                onToggle={() => void write({ type: "stats.record.set", record: !snapshot.recording })} />
              <RecordSwitch checked={snapshot.memoryAccess} disabled={controlsDisabled} label={t("execution.memoryToggle")}
                onToggle={() => void write({ type: "stats.memoryAccess.set", enabled: !snapshot.memoryAccess })} />
            </div>
            <p className="execution-note">{t("execution.recordsNote")}</p>
          </section>
          <p className="execution-footnote">{t("execution.footnote")}</p>
        </div>
      )}
    </>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return <div className="execution-total"><span>{label}</span><strong>{value}</strong></div>;
}

function SourceBreakdown({ sources, model, token, count, rate }: {
  sources: ExecutionStatsPeriod["sources"]; model: string; token: Intl.NumberFormat; count: Intl.NumberFormat; rate: (value?: number) => string;
}) {
  const { t } = useLocale();
  const labels = { chat: "execution.sourceChat", memory: "execution.sourceMemory", other: "execution.sourceOther" } as const;
  const visible = sources.flatMap(({ source, total, rows }) => {
    const usage = model === ALL_MODELS ? total : rows.find((row) => modelKey(row) === model);
    return usage ? [{ source, usage }] : [];
  });
  if (!visible.length) return null;
  return <section className="execution-sources" aria-label={t("execution.sources")}>
    {visible.map(({ source, usage }) => <div key={source} className="execution-source">
      <span>{t(labels[source])}</span>
      <strong>{token.format(totalTokens(usage))}</strong>
      <small>{t("execution.requestsShort", { count: count.format(usage.requests) })} · {rate(usage.cacheHitRate)}</small>
    </div>)}
  </section>;
}

